/**
 * Adapter-level QQ compatibility *pipeline* tests (v1.3.0, P1b/P2/P3 wiring).
 *
 * Covers the modules integrated into `lib/plugin.js`:
 *   - the automatic Derpyu tool-whitelist patch (D6/D14),
 *   - passive archiving from a foreign `compaction/summary` (D7),
 *   - the heuristic scoring fallback for channel sessions (D8),
 *   - onebot local-image staging → archive → recall (D12).
 *
 * Everything runs against a mocked host and a temporary fake profile; no real
 * DSH install, no network, no third-party file outside the temp dir is touched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RofmPlugin } from '../lib/plugin.js'

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

class FakeSession {
  constructor({ contextWindow = 1000, header = { origin: 'main' }, id = 'session-test' } = {}) {
    this.id = id
    this.header = header
    this.events = []
    this.nodes = []
    this.replaceGeneration = 0
    this.contentGeneration = 0
    this.windowTokens = contextWindow
  }

  get surface() {
    const session = this
    return {
      get nodes() {
        return session.nodes
      },
      get replaceGeneration() {
        return session.replaceGeneration
      },
      get contentGeneration() {
        return session.contentGeneration
      },
    }
  }

  get seq() {
    return this.events.length
  }

  eventAt(seq) {
    return this.events[seq]
  }

  snapshotEvents() {
    return this.events.slice()
  }

  requestContext() {
    return { provider: 'mock', model: 'mock', contextWindow: this.windowTokens }
  }

  deriveEventMessage(event) {
    if (!event) return null
    switch (event.type) {
      case 'user/message':
        return event.data
      case 'assistant/message':
      case 'system/message':
      case 'developer/message':
      case 'tool/result':
        return event.data.message
      default:
        return null
    }
  }

  deriveMessages() {
    return this.nodes.map((seq) => this.deriveEventMessage(this.eventAt(seq))).filter((message) => message !== null)
  }

  append(type, data, options = {}) {
    const seq = this.events.length
    const event = {
      type,
      seq,
      time: Date.now(),
      data: clone(data),
      ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...options.sourceEventSeqs] }),
      ...(options.surfaceOp === undefined ? {} : { surfaceOp: options.surfaceOp }),
    }
    if (SURFACE_TYPES.has(type)) {
      assert.ok(event.surfaceOp !== undefined, `surface event ${type} needs surfaceOp`)
      if (event.surfaceOp === 'append') {
        this.events.push(event)
        this.nodes.push(seq)
        this.contentGeneration += 1
        return event
      }
      const { startSeq, endSeq } = event.surfaceOp
      const startIdx = this.nodes.indexOf(startSeq)
      const endIdx = this.nodes.indexOf(endSeq)
      assert.ok(startIdx >= 0 && endIdx >= startIdx, 'replacement range must exist')
      const shadowed = this.nodes.slice(startIdx, endIdx + 1)
      for (const shadowedSeq of shadowed) {
        assert.ok(event.sourceEventSeqs.includes(shadowedSeq), 'sourceEventSeqs must include every shadowed node')
      }
      this.events.push(event)
      this.nodes.splice(startIdx, shadowed.length, seq)
      this.replaceGeneration += 1
      this.contentGeneration += 1
      return event
    }
    this.events.push(event)
    return event
  }
}

function userMessage(id, text, sourceKind = 'user') {
  return { id, role: 'user', source: { kind: sourceKind }, content: [{ type: 'text', text }] }
}

function assistantMessage(id, text) {
  return { id, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text }] }
}

function measure(session) {
  const nodes = session.nodes.map((seq) => {
    const message = session.deriveEventMessage(session.eventAt(seq))
    const text = JSON.stringify(message?.content ?? '')
    const tokens = Math.max(0, Math.ceil(text.length / 4))
    return { seq, tokens, heuristicTokens: tokens }
  })
  return { totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0), nodes }
}

function makeContext(session) {
  const handlers = new Map()
  const effects = []
  const capture = { sections: [], tools: [], logs: [] }
  const toolsService = {
    register(definition) {
      const entry = { definition, disposed: false }
      capture.tools.push(entry)
      return () => {
        entry.disposed = true
      }
    },
  }
  const ctx = {
    logger: {
      info: (message) => capture.logs.push(['info', String(message)]),
      warn: (message) => capture.logs.push(['warn', String(message)]),
      debug: (message) => capture.logs.push(['debug', String(message)]),
    },
    tokenMeter: { measure: () => measure(session) },
    systemPrompt: {
      section(sectionOptions) {
        capture.sections.push(sectionOptions)
        return () => {}
      },
    },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
      return () => {
        const list = handlers.get(name) ?? []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    dispose() {
      while (effects.length > 0) {
        const dispose = effects.pop()
        if (typeof dispose === 'function') dispose()
      }
    },
    emit(name, ...args) {
      const results = []
      for (const handler of handlers.get(name) ?? []) results.push(handler(...args))
      return results
    },
    handlerCount() {
      let total = 0
      for (const list of handlers.values()) total += list.length
      return total
    },
    get(name) {
      if (name === 'systemPrompt') return this.systemPrompt
      if (name === 'tokenMeter') return this.tokenMeter
      if (name === 'tools') return this.tools
      return undefined
    },
  }
  ctx.tools = toolsService
  return { ctx, capture }
}

function sectionOf(capture, name) {
  return capture.sections.find((section) => section.name === name)
}

function recallText(capture, session) {
  const section = sectionOf(capture, 'dsh-rofm:recall')
  return section ? section.text({ agent: { session } }) : ''
}

function toolDefinition(capture, name) {
  return capture.tools.find((entry) => entry.definition?.name === name)?.definition
}

const BASE_OVERRIDES = {
  enabled: true,
  compress: {
    enabled: true,
    triggerPercent: 1,
    compressPercent: 20,
    contextWindowTokens: 1000,
    minContextTokens: 0,
    minMessagesToCompress: 4,
    minChunkChars: 50,
    targetChunkChars: 200,
    maxFoldersPerRun: 20,
    keepRecentMessages: 2,
    applyToSubagents: true,
    applyToMainSessions: true,
    preStepEnabled: false,
    emergencyPercent: 85,
    emergencyCompressPercent: 40,
    maxExtraPasses: 0,
    hardLimitPercent: 95,
  },
  recall: {
    seed: 7,
    probabilityScale: 1000,
    firstGenMax: 10,
    applyToSubagents: true,
    applyToMainSessions: true,
    triggerSourceKinds: ['user'],
  },
  importance: { min: 0.01, max: 1, warnAbove: 0.8 },
  keywords: { min: 3, max: 8 },
  logging: { enabled: true, verbose: true },
}

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-pipeline-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

async function withTempDirAsync(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-pipeline-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

/** Run `fn` with `DSH_PROFILE_DIR` pointing at one temporary fake profile. */
function withProfileEnv(profileDir, fn) {
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profileDir
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
}

async function withProfileEnvAsync(profileDir, fn) {
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profileDir
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
}

function makePlugin(compat, options = {}) {
  const session = options.session ?? new FakeSession({ id: options.id ?? 'session-test' })
  const { ctx, capture } = makeContext(session)
  const memoryDir = path.join(options.root, 'memory')
  const plugin = new RofmPlugin(ctx, {
    ...BASE_OVERRIDES,
    storage: { dir: memoryDir, perSession: options.perSession ?? true },
    compat,
  })
  plugin.start()
  return { plugin, ctx, capture, session, memoryDir }
}

/** Standard 14-message conversation, appended to the surface. */
function appendPlainConversation(session, turns = 14) {
  for (let index = 0; index < turns; index += 1) {
    session.append('user/message', userMessage(`u-${index}`, `第${index}轮：继续讨论部署 docker 端口配置与数据库迁移，参数编号 ${index}。`), { surfaceOp: 'append' })
    session.append(
      'assistant/message',
      { turn: 1, step: 1, message: assistantMessage(`a-${index}`, `好的，第 ${index} 轮我记录一下 docker 端口和部署参数。`), stream: [] },
      { surfaceOp: 'append' },
    )
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * One fake Derpyu install: a profile whose `qq-agent-presets` is a local
 * (link:) dependency plus the real `SAFE_EXACT` shape of `qq-tool-restrict.mjs`.
 */
function makeDerpyuProfile(root) {
  const profileDir = path.join(root, 'profile')
  const packageDir = path.join(root, 'derpyu', 'plugins', 'qq-agent-presets')
  mkdirSync(packageDir, { recursive: true })
  const file = path.join(packageDir, 'qq-tool-restrict.mjs')
  writeFileSync(
    file,
    [
      '// fake qq-tool-restrict (same SAFE_EXACT shape as Derpyu upstream)',
      "export const name = 'qq-tool-restrict'",
      'const SAFE_EXACT = new Set([',
      "  'ask_user_question',",
      "  'todo_write',",
      '])',
      'export function apply() {}',
      '',
    ].join('\n'),
  )
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-fake',
        dependencies: { 'qq-agent-presets': `link:${packageDir.replace(/\\/g, '/')}` },
        dsh: { profile: { bundles: ['qq-agent-presets'] } },
      },
      null,
      2,
    ),
  )
  return { profileDir, packageDir, file }
}

// ------------------------------------------------------- automatic patch

test('compat: activation injects the Derpyu tool whitelist patch (idempotent across restarts)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-patch-'))
  try {
    const { profileDir, file } = makeDerpyuProfile(root)
    withProfileEnv(profileDir, () => {
      const first = makePlugin({ qqBots: 'auto' }, { root: path.join(root, 'run1'), id: 'qqb-g-1' })
      assert.equal(first.plugin.autopatchApplied, true, 'patch must be applied on activation')
      assert.equal(first.plugin.autopatchStatus.status, 'patched')
      const patched = readFileSync(file, 'utf8')
      for (const name of ['memory_judge', 'memory_recall', 'memory_image']) {
        assert.ok(patched.includes(`'${name}'`), `patched file must whitelist ${name}`)
      }
      // The rest of the third-party file is untouched.
      assert.ok(patched.includes("'ask_user_question',"))
      assert.ok(patched.includes('export function apply() {}'))
      // Backup + state are recorded.
      const dir = path.dirname(file)
      assert.ok(readdirSync(dir).some((name) => name.includes('.bak-rofm-')), 'a backup must be written')
      const statePath = path.join(path.join(root, 'run1', 'memory'), '.compat-state.json')
      assert.ok(existsSync(statePath), 'patch state must be recorded')
      const state = readJson(statePath)
      assert.ok(Array.isArray(state.patches) && state.patches.length === 1)

      // Second activation: already patched, no new backup, file unchanged.
      const backupsBefore = readdirSync(dir).filter((name) => name.includes('.bak-rofm-')).length
      const second = makePlugin({ qqBots: 'auto' }, { root: path.join(root, 'run2'), id: 'qqb-g-2' })
      assert.equal(second.plugin.autopatchApplied, true)
      assert.equal(readFileSync(file, 'utf8'), patched, 'second activation must not rewrite the file')
      assert.equal(readdirSync(dir).filter((name) => name.includes('.bak-rofm-')).length, backupsBefore)
    })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('compat: autoPatchDerpyu=false never touches the third-party file and degrades to heuristic', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-patch-off-'))
  try {
    const { profileDir, file } = makeDerpyuProfile(root)
    const before = readFileSync(file, 'utf8')
    withProfileEnv(profileDir, () => {
      const { plugin } = makePlugin({ qqBots: 'auto', autoPatchDerpyu: false }, { root: path.join(root, 'run'), id: 'qqb-g-3' })
      assert.equal(plugin.autopatchApplied, false)
      assert.equal(plugin.autopatchStatus.status, 'disabled')
      assert.equal(readFileSync(file, 'utf8'), before, 'the third-party file must stay byte-identical')
      assert.equal(plugin.scoringModeFor({ id: `qqb-g-3-${'d'.repeat(32)}` }, plugin.currentConfig()), 'heuristic')
    })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ---------------------------------------------------- channel scoring mode

test('compat: Derpyu without the patch archives with heuristic scoring (one WARN), onebot keeps pending', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-scoring-'))
  try {
    const { profileDir } = makeDerpyuProfile(root)
    await withProfileEnvAsync(profileDir, async () => {
      // Derpyu session, patch disabled -> heuristic folders (immediately recallable).
      const derpyu = makePlugin({ qqBots: 'auto', autoPatchDerpyu: false }, { root: path.join(root, 'derpyu'), id: `qqb-g-77-${'e'.repeat(32)}` })
      appendPlainConversation(derpyu.session, 14)
      await derpyu.plugin.compressWithEscalation(derpyu.session, 1, derpyu.plugin.currentConfig(), 'test')
      const derpyuDir = derpyu.plugin.sessionMemoryDir(derpyu.plugin.currentConfig(), derpyu.session)
      const derpyuIndex = readJson(path.join(derpyuDir, 'index.json'))
      assert.ok(derpyuIndex.folders.length > 0, 'the Derpyu span must be archived')
      for (const folder of derpyuIndex.folders) {
        assert.equal(folder.scored, true, 'heuristic path archives already-scored folders')
      }
      const meta = readJson(path.join(derpyuDir, derpyuIndex.folders[0].id, 'meta.json'))
      assert.equal(meta.alphaSource, 'heuristic')
      assert.equal(meta.scoreMode, 'heuristic')
      assert.ok(Number(meta.alpha) > 0 && Array.isArray(meta.keywords) && meta.keywords.length > 0)
      const warnings = derpyu.capture.logs.filter(([level, line]) => level === 'warn' && line.includes('heuristic scoring'))
      assert.equal(warnings.length, 1, 'the heuristic degradation warning is emitted exactly once')

      // onebot session: model scoring stays the default (pending folders).
      const onebot = makePlugin({ qqBots: 'on' }, { root: path.join(root, 'onebot'), id: 'onebot-900' })
      appendPlainConversation(onebot.session, 14)
      await onebot.plugin.compressWithEscalation(onebot.session, 1, onebot.plugin.currentConfig(), 'test')
      const onebotDir = onebot.plugin.sessionMemoryDir(onebot.plugin.currentConfig(), onebot.session)
      const onebotIndex = readJson(path.join(onebotDir, 'index.json'))
      assert.ok(onebotIndex.folders.length > 0)
      for (const folder of onebotIndex.folders) {
        assert.equal(folder.scored, false, 'onebot keeps model scoring: folders land pending')
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ------------------------------------------------------ passive archiving

test('compat: a foreign compaction/summary is recovered into the chat memory (D7)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-passive-'))
  try {
    const { profileDir } = makeDerpyuProfile(root)
    withProfileEnv(profileDir, () => {
      const { plugin, ctx, capture, session } = makePlugin(
        { qqBots: 'auto', autoPatchDerpyu: false },
        { root, id: `qqb-p-321-${'f'.repeat(32)}` },
      )
      // Four conversation nodes, then a compaction/summary that shadowed them.
      appendPlainConversation(session, 2)
      const event = {
        type: 'compaction/summary',
        seq: session.events.length,
        time: Date.now(),
        data: { compactionId: 'cmp-1', shadowedSeqs: [0, 1, 2, 3], shadowedRange: { start: 0, end: 3 }, shadowedTokenCount: 400 },
      }
      ctx.emit('session/event', session, event)

      const chatDir = path.join(root, 'memory', 'sessions', 'qqb-p-321')
      const index = readJson(path.join(chatDir, 'index.json'))
      assert.ok(index && index.folders.length === 1, 'one passive folder must be written')
      const folder = index.folders[0]
      assert.equal(folder.scored, true, 'Derpyu without the patch archives passively with heuristic scoring')
      const meta = readJson(path.join(chatDir, folder.id, 'meta.json'))
      assert.equal(meta.source.kind, 'passive-archive')
      // `compactionSeq` is the sequence number of the triggering event.
      assert.equal(meta.source.compactionSeq, 4)
      const context = readJson(path.join(chatDir, folder.id, 'context.json'))
      assert.ok(context.messages.length >= 2)
      assert.ok(context.messages.every((message) => ['user', 'assistant'].includes(message.role)))
      // Watermark persisted; a repeated event must not archive again.
      assert.ok(existsSync(path.join(chatDir, '.passive-watermark.json')))
      ctx.emit('session/event', session, event)
      assert.equal(readJson(path.join(chatDir, 'index.json')).folders.length, 1, 'watermark must deduplicate the second event')
      assert.equal(capture.logs.filter(([level, line]) => level === 'warn' && line.includes('passive archive failed')).length, 0)
      assert.ok(plugin)
    })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('compat=off: session/event is not registered and passive archiving stays inert', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-passive-off-'))
  try {
    const { ctx } = makePlugin({ qqBots: 'off' }, { root, id: 'onebot-1' })
    // Only the three v1.2.1 listeners exist.
    assert.equal(ctx.handlerCount(), 3)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ------------------------------------------------------- image staging (D12)

test('compat: onebot local image paths are staged, archived and recalled as file paths', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-media-'))
  try {
    const mediaRoot = path.join(root, 'media-root')
    mkdirSync(mediaRoot, { recursive: true })
    const imagePath = path.join(mediaRoot, 'pic.png')
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]))
    const stageRoot = path.join(root, 'memory')
    const { plugin, capture, session } = makePlugin(
      { qqBots: 'on', mediaRoots: [mediaRoot], maxImageBytes: 1024 * 1024 },
      { root, id: 'onebot-777' },
    )
    const imageMessage = userMessage('m-img', `[图片:${imagePath}] 看一下这张图`, 'plugin:dsh-onebot')
    session.append('user/message', imageMessage, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: assistantMessage('a-img', '收到，图我看了'), stream: [] }, { surfaceOp: 'append' })
    plugin.onInboxInserted({ agent: { session }, message: imageMessage })

    // Staged under <memory>/.staging/<chatKey>-<messageId>/.
    const stagingDir = path.join(stageRoot, '.staging', 'onebot-777-m-img')
    assert.ok(existsSync(stagingDir), 'the image must be staged at inbox time')
    assert.ok(readdirSync(stagingDir).some((name) => name.endsWith('.png')))
    const stagingIndex = readJson(path.join(stagingDir, 'index.json'))
    assert.equal(stagingIndex.files[0].source, imagePath)

    // Grow the conversation and archive it.
    appendPlainConversation(session, 12)
    await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
    const chatDir = plugin.sessionMemoryDir(plugin.currentConfig(), session)
    const index = readJson(path.join(chatDir, 'index.json'))
    assert.ok(index.folders.length > 0)
    const imageIndex = readJson(path.join(chatDir, 'images', 'index.json'))
    assert.equal(imageIndex.images.length, 1, 'the archived image must be indexed')
    const archivedName = imageIndex.images[0].name
    assert.ok(existsSync(path.join(chatDir, 'images', archivedName)), 'the image bytes must be persisted')
    assert.ok(!existsSync(stagingDir), 'the staging copy must be consumed after the archive')

    // The archived text carries an image placeholder instead of the local path.
    let placeholderText = ''
    for (const folder of index.folders) {
      const context = readJson(path.join(chatDir, folder.id, 'context.json'))
      for (const message of context.messages) {
        if (typeof message.content === 'string') placeholderText += message.content
      }
    }
    assert.ok(placeholderText.includes('[图片：（'), 'the local path must become an image placeholder')
    assert.ok(!placeholderText.includes(imagePath), 'the original local path must not stay in the archived text')

    // Score the pending folders, then a matching message recalls the image path.
    const definition = toolDefinition(capture, 'memory_judge')
    const updates = index.folders
      .filter((folder) => folder.scored === false)
      .map((folder) => ({ id: folder.id, alpha: 0.9, beta: 3, keywords: ['图片测试', '截图', '测试图片'] }))
    const judged = await definition.execute({ updates }, { agent: { session } })
    assert.ok(judged.updated.length > 0, `the pending folders must be scored (rejected=${JSON.stringify(judged.rejected)})`)
    plugin.onInboxInserted({ agent: { session }, message: userMessage('m-recall', '图片测试的截图呢', 'plugin:dsh-onebot') })
    const recalled = recallText(capture, session)
    assert.ok(recalled.includes('文件：'), 'the recalled block must render the archived image as a file path')
    assert.ok(recalled.includes(path.join(chatDir, 'images')), 'the rendered path must point into the session image folder')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('compat: image staging rejects paths outside compat.mediaRoots', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-media-deny-'))
  try {
    const mediaRoot = path.join(root, 'allowed')
    const outside = path.join(root, 'outside')
    mkdirSync(mediaRoot, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const imagePath = path.join(outside, 'secret.png')
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const { plugin, session } = makePlugin({ qqBots: 'on', mediaRoots: [mediaRoot] }, { root: path.join(root, 'run'), id: 'onebot-888' })
    const message = userMessage('m-deny', `[图片:${imagePath}]`, 'plugin:dsh-onebot')
    session.append('user/message', message, { surfaceOp: 'append' })
    plugin.onInboxInserted({ agent: { session }, message })
    const stagingRoot = path.join(root, 'run', 'memory', '.staging')
    assert.ok(!existsSync(stagingRoot) || readdirSync(stagingRoot).length === 0, 'an out-of-root path must never be staged')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
