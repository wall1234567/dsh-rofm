/**
 * Adapter-level QQ compatibility tests (v1.3.0).
 *
 * These exercise the DSH-facing wiring in `lib/plugin.js` with a mocked host:
 * detection → trigger kinds, session id → stable chat key / memory folder,
 * onebot owner gate (α floor), per-turn `memory_recall` unlock, and the channel
 * prompt rules. The compat=off path is asserted to stay byte-identical to
 * v1.2.1 (no extra prompt text, session id used verbatim).
 *
 * The fake host deliberately has no `llm` service: archiving never calls a model.
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
      for (const handler of handlers.get(name) ?? []) handler(...args)
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

function tasksText(capture, session) {
  const section = sectionOf(capture, 'dsh-rofm:memory-tasks')
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-adapter-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

/** Async variant: keeps the temp dir until the awaited body settles. */
async function withTempDirAsync(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-adapter-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

/**
 * Run `fn` with `DSH_PROFILE_DIR` pointing at one temporary fake profile, so
 * detection (and therefore the automatic Derpyu patch) is exercised exactly like
 * in production. Restores the previous value afterwards.
 */
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

/**
 * One fake Derpyu install: a profile whose `qq-agent-presets` is a local
 * (link:) dependency plus the real `SAFE_EXACT` shape of `qq-tool-restrict.mjs`.
 * Returns the profile dir and the patched file path.
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
      'export const name = \'qq-tool-restrict\'',
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

/** One plugin whose per-session memory root is <tmp>/memory. */
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

/** Write one answered memory folder + index entry (like a previous archive). */
function writeFolderFixture(memoryDir, id, options = {}) {
  const { alpha = 0.5, beta = 0, keywords = ['部署'], text = 'FIXTURE-MEMORY', createdAt = Date.now() } = options
  const dir = path.join(memoryDir, id)
  mkdirSync(dir, { recursive: true })
  const messages = [{ role: 'user', content: text }, { role: 'assistant', content: '收到' }]
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify({ version: 1, id, createdAt, messages }))
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      version: 1,
      id,
      createdAt,
      alpha,
      beta,
      keywords,
      title: text,
      scored: true,
      alphaSource: 'llm',
      keywordsSource: 'llm',
      betaSource: 'llm',
      stats: { messages: messages.length, chars: text.length, tokens: 10 },
    }),
  )
  return { id, createdAt, alpha, beta, keywords, title: text, chars: text.length, tokens: 10, messageCount: messages.length, scored: true }
}

/** Seed a folder directly in one chat's memory dir + rewrite its index. */
function seedFolder(chatMemoryDir, id, options = {}) {
  const entry = writeFolderFixture(chatMemoryDir, id, options)
  const indexFile = path.join(chatMemoryDir, 'index.json')
  let index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8'))
  } catch {
    // first folder
  }
  index.folders = (index.folders ?? []).filter((folder) => folder.id !== id)
  index.folders.push(entry)
  writeFileSync(indexFile, JSON.stringify(index))
  return entry
}

/** Fire one inbox message through the plugin (automatic recall path). */
function inbox(plugin, session, message) {
  plugin.onInboxInserted({ agent: { session }, message })
}

// ------------------------------------------------------- session chat keys

test('compat: a rotated onebot session id maps to one stable chat memory folder', () =>
  withTempDir((root) => {
    const { plugin, session, memoryDir } = makePlugin({ qqBots: 'on' }, { root, id: 'onebot-123456' })
    assert.equal(plugin.sessionKey(session), 'onebot-123456')
    assert.equal(plugin.sessionMemoryDir(plugin.currentConfig(), session), path.join(memoryDir, 'sessions', 'onebot-123456'))

    const suffix = Date.now().toString(36)
    const rebuilt = { id: `onebot-123456-${suffix}` }
    assert.equal(plugin.sessionKey(rebuilt), 'onebot-123456')
    assert.equal(plugin.sessionMemoryDir(plugin.currentConfig(), rebuilt), plugin.sessionMemoryDir(plugin.currentConfig(), session))
  }))

test('compat: a rebuilt Derpyu session (fresh 32-hex suffix) keeps the same chat memory folder', () =>
  withTempDir((root) => {
    const first = { id: `qqb-g-987654-${'a'.repeat(32)}` }
    const second = { id: `qqb-g-987654-${'b'.repeat(32)}` }
    const { plugin, memoryDir } = makePlugin({ qqBots: 'on' }, { root, id: first.id })
    assert.equal(plugin.sessionKey(first), 'qqb-g-987654')
    assert.equal(plugin.sessionKey(second), 'qqb-g-987654')
    assert.equal(plugin.sessionMemoryDir(plugin.currentConfig(), first), path.join(memoryDir, 'sessions', 'qqb-g-987654'))
  }))

test('compat=off: plain sessions and channel-looking ids keep their id verbatim (v1.2.1 path)', () =>
  withTempDir((root) => {
    const { plugin, session, memoryDir } = makePlugin({ qqBots: 'off' }, { root, id: 'onebot-123456' })
    // Session-id *parsing* is unconditional (it only names a folder); with compat
    // off the plugin must still behave like v1.2.1 for real sessions.
    assert.equal(plugin.sessionKey(session), 'onebot-123456')
    const plain = { id: 'session-test' }
    assert.equal(plugin.sessionKey(plain), 'session-test')
    assert.equal(plugin.sessionMemoryDir(plugin.currentConfig(), plain), path.join(memoryDir, 'sessions', 'session-test'))
  }))

// -------------------------------------------------------------- triggers

test('compat on: onebot plugin messages trigger automatic recall; compat off they do not', () =>
  withTempDir((root) => {
    for (const qqBots of ['on', 'off']) {
      const { plugin, capture, session, memoryDir } = makePlugin({ qqBots }, { root: path.join(root, qqBots), id: 'onebot-100' })
      plugin.recallTool.resetAttempts(session)
      const chatDir = plugin.sessionMemoryDir(plugin.currentConfig(), session)
      mkdirSync(chatDir, { recursive: true })
      seedFolder(chatDir, 'mem-20260101T000000Z-0001', { alpha: 0.9, keywords: ['部署'], text: 'ONE-BOT-MEMORY-CONTENT' })
      const engine = plugin.engineFor(session, plugin.currentConfig())
      assert.ok(engine)
      inbox(plugin, session, userMessage('m1', '部署参数是什么', 'plugin:dsh-onebot'))
      const text = recallText(capture, session)
      if (qqBots === 'on') assert.ok(text.includes('ONE-BOT-MEMORY-CONTENT'), 'onebot message must recall with compat on')
      else assert.equal(text, '', 'compat=off must not recall the onebot source kind')
      assert.ok(memoryDir.length > 0)
    }
  }))

// -------------------------------------------------------------- owner gate

test('compat: a non-owner group member only recalls memories with α >= memberMinAlpha', () =>
  withTempDir((root) => {
    const { plugin, capture, session } = makePlugin(
      { qqBots: 'on', ownerIds: ['10001'], memberMinAlpha: 0.5 },
      { root, id: 'onebot-777' },
    )
    const chatDir = plugin.sessionMemoryDir(plugin.currentConfig(), session)
    mkdirSync(chatDir, { recursive: true })
    seedFolder(chatDir, 'mem-20260101T000000Z-0001', { alpha: 0.2, keywords: ['部署'], text: 'LOW-ALPHA-MEMORY' })
    seedFolder(chatDir, 'mem-20260101T000000Z-0002', { alpha: 0.9, keywords: ['部署'], text: 'HIGH-ALPHA-MEMORY' })

    // Non-owner group member: gated.
    inbox(plugin, session, userMessage('g1', '[09:30 小明(20002)] 部署参数是多少', 'plugin:dsh-onebot'))
    const gated = recallText(capture, session)
    assert.ok(gated.includes('HIGH-ALPHA-MEMORY'), 'α>=0.5 memory must be recalled')
    assert.ok(!gated.includes('LOW-ALPHA-MEMORY'), 'α<0.5 memory must be filtered for a non-owner')

    // Owner: ungated (same engine, fresh session state via a new message id).
    const ownerSession = new FakeSession({ id: 'onebot-778' })
    const ownerRun = makePlugin({ qqBots: 'on', ownerIds: ['10001'], memberMinAlpha: 0.5 }, { root: path.join(root, 'owner'), session: ownerSession })
    const ownerDir = ownerRun.plugin.sessionMemoryDir(ownerRun.plugin.currentConfig(), ownerSession)
    mkdirSync(ownerDir, { recursive: true })
    seedFolder(ownerDir, 'mem-20260101T000000Z-0001', { alpha: 0.2, keywords: ['部署'], text: 'LOW-ALPHA-MEMORY' })
    seedFolder(ownerDir, 'mem-20260101T000000Z-0002', { alpha: 0.9, keywords: ['部署'], text: 'HIGH-ALPHA-MEMORY' })
    inbox(ownerRun.plugin, ownerSession, userMessage('o1', '[09:31 主人(10001)] 部署参数是多少', 'plugin:dsh-onebot'))
    const ownerText = recallText(ownerRun.capture, ownerSession)
    assert.ok(ownerText.includes('HIGH-ALPHA-MEMORY'))
    assert.ok(ownerText.includes('LOW-ALPHA-MEMORY'), 'the owner must not be α-gated')

    // A private message (no sender marker) is treated as the user: ungated.
    const privateSession = new FakeSession({ id: 'onebot-779' })
    const privateRun = makePlugin({ qqBots: 'on', ownerIds: ['10001'], memberMinAlpha: 0.5 }, { root: path.join(root, 'private'), session: privateSession })
    const privateDir = privateRun.plugin.sessionMemoryDir(privateRun.plugin.currentConfig(), privateSession)
    mkdirSync(privateDir, { recursive: true })
    seedFolder(privateDir, 'mem-20260101T000000Z-0001', { alpha: 0.2, keywords: ['部署'], text: 'LOW-ALPHA-MEMORY' })
    inbox(privateRun.plugin, privateSession, userMessage('p1', '部署参数是多少', 'plugin:dsh-onebot'))
    assert.ok(recallText(privateRun.capture, privateSession).includes('LOW-ALPHA-MEMORY'))
  }))

test('compat: memberMinAlpha=0 disables the owner gate', () =>
  withTempDir((root) => {
    const { plugin, capture, session } = makePlugin(
      { qqBots: 'on', ownerIds: [], memberMinAlpha: 0 },
      { root, id: 'onebot-880' },
    )
    const chatDir = plugin.sessionMemoryDir(plugin.currentConfig(), session)
    mkdirSync(chatDir, { recursive: true })
    seedFolder(chatDir, 'mem-20260101T000000Z-0001', { alpha: 0.2, keywords: ['部署'], text: 'LOW-ALPHA-MEMORY' })
    inbox(plugin, session, userMessage('g1', '[09:30 小明(20002)] 部署参数是多少', 'plugin:dsh-onebot'))
    assert.ok(recallText(capture, session).includes('LOW-ALPHA-MEMORY'))
  }))

// ------------------------------------------------------- per-turn unlock

test('compat: a new turn re-enables memory_recall after the 6-miss lock (D11)', async () =>
  withTempDirAsync(async (root) => {
    const { plugin, ctx, capture, session } = makePlugin({ qqBots: 'on' }, { root, id: 'qqb-g-5' })
    const recallTool = toolDefinition(capture, 'memory_recall')
    assert.ok(recallTool, 'memory_recall must be registered')
    assert.equal(ctx.handlerCount() > 0, true)

    // Turn 1 starts.
    await plugin.onPreStep({ agent: { session }, turn: 1 }, async () => ({ kind: 'continue' }))
    for (let index = 0; index < 6; index += 1) {
      await recallTool.execute({ keywords: `nothing-${index}` }, { agent: { session } })
    }
    await assert.rejects(() => recallTool.execute({ keywords: 'nothing-x' }, { agent: { session } }))

    // Turn 2: the pre-step reset must unlock the tool again.
    await plugin.onPreStep({ agent: { session }, turn: 2 }, async () => ({ kind: 'continue' }))
    const value = await recallTool.execute({ keywords: 'nothing-again' }, { agent: { session } })
    assert.equal(value.found, 0)
    assert.equal(value.misses, 1, 'the miss counter restarts at a new turn')
  }))

// ------------------------------------------------------- prompt sections

test('compat: channel sessions get the QQ channel rules; plain/off sessions do not', () =>
  withTempDir((root) => {
    const cases = [
      { compat: { qqBots: 'on' }, id: 'onebot-1', expected: true, label: 'onebot channel' },
      { compat: { qqBots: 'on' }, id: `qqb-p-2-${'c'.repeat(32)}`, expected: true, label: 'derpyu channel' },
      { compat: { qqBots: 'on' }, id: 'session-plain', expected: false, label: 'plain session' },
      { compat: { qqBots: 'off' }, id: 'onebot-3', expected: false, label: 'compat off' },
    ]
    for (const item of cases) {
      const { plugin, capture, session } = makePlugin(item.compat, { root: path.join(root, item.label.replace(/\s+/g, '-')), id: item.id })
      const text = tasksText(capture, session)
      if (item.expected) {
        // The rules must be present even before this session archived anything.
        assert.ok(text.includes('QQ 通道会话规则'), `${item.label}: channel rules missing`)
        assert.ok(text.includes('严禁提及本插件的内部机制'), `${item.label}: forbidden-word rule missing`)
        assert.ok(text.includes('memory_recall 检索历史'), `${item.label}: recall guidance missing`)
        for (const word of ['评分', '归档', 'memory_judge', 'memory_recall']) {
          assert.ok(text.includes(word), `${item.label}: forbidden word list must include ${word}`)
        }
      } else {
        assert.equal(text, '', `${item.label}: no channel rules expected`)
      }
      assert.ok(plugin)
    }
  }))

test('compat: the owner-α≥0.5 scoring rule only appears for channel sessions', () =>
  withTempDir((root) => {
    const { plugin, capture, session, memoryDir, ctx } = makePlugin({ qqBots: 'on' }, { root, id: 'onebot-42' })
    // Create one pending folder so the full rubric (not the short nudge) renders.
    const chatDir = plugin.sessionMemoryDir(plugin.currentConfig(), session)
    mkdirSync(chatDir, { recursive: true })
    const pendingId = 'mem-20260101T000000Z-0009'
    const folder = path.join(chatDir, pendingId)
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, 'context.json'), JSON.stringify({ version: 1, id: pendingId, createdAt: Date.now(), messages: [{ role: 'user', content: '待评分内容' }] }))
    writeFileSync(
      path.join(folder, 'meta.json'),
      JSON.stringify({
        version: 1,
        id: pendingId,
        createdAt: Date.now(),
        alpha: 0,
        beta: 0,
        keywords: [],
        title: '待评分内容',
        scored: false,
        alphaSource: 'pending',
        keywordsSource: 'pending',
        betaSource: 'pending',
        stats: { messages: 1, chars: 5, tokens: 3 },
      }),
    )
    writeFileSync(
      path.join(chatDir, 'index.json'),
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        nextCounter: 1,
        folders: [{ id: pendingId, createdAt: Date.now(), alpha: 0, beta: 0, keywords: [], chars: 5, tokens: 3, messageCount: 1, title: '待评分内容', scored: false }],
      }),
    )
    const channelText = tasksText(capture, session)
    assert.ok(channelText.includes('评分口径：'), 'pending work must render the rubric')
    assert.ok(channelText.includes('涉及主人的身份、偏好、决定、承诺'), 'channel rubric must carry the owner rule')

    // Same setup on a plain session: rubric without the owner rule.
    const plain = makePlugin({ qqBots: 'on' }, { root: path.join(root, 'plain'), id: 'session-plain' })
    const plainChatDir = plain.plugin.sessionMemoryDir(plain.plugin.currentConfig(), plain.session)
    mkdirSync(plainChatDir, { recursive: true })
    const plainFolder = path.join(plainChatDir, pendingId)
    mkdirSync(plainFolder, { recursive: true })
    writeFileSync(path.join(plainFolder, 'context.json'), JSON.stringify({ version: 1, id: pendingId, createdAt: Date.now(), messages: [{ role: 'user', content: '待评分内容' }] }))
    writeFileSync(
      path.join(plainFolder, 'meta.json'),
      JSON.stringify({ version: 1, id: pendingId, createdAt: Date.now(), alpha: 0, beta: 0, keywords: [], title: 'x', scored: false, stats: { messages: 1, chars: 5, tokens: 3 } }),
    )
    writeFileSync(
      path.join(plainChatDir, 'index.json'),
      JSON.stringify({ version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [{ id: pendingId, createdAt: Date.now(), alpha: 0, beta: 0, keywords: [], chars: 5, tokens: 3, messageCount: 1, title: 'x', scored: false }] }),
    )
    const plainText = tasksText(plain.capture, plain.session)
    assert.ok(plainText.includes('评分口径：'))
    assert.ok(!plainText.includes('涉及主人的身份、偏好、决定、承诺'), 'plain sessions must not gain the owner rule')
    assert.ok(!plainText.includes('QQ 通道会话规则'))
    assert.ok(memoryDir.length > 0 && ctx.handlerCount() > 0)
  }))

test('compat: memory_recall inherits the non-owner α gate of the current turn', async () =>
  withTempDirAsync(async (root) => {
    const { plugin, capture, session } = makePlugin(
      { qqBots: 'on', ownerIds: ['10001'], memberMinAlpha: 0.5 },
      { root, id: 'onebot-555' },
    )
    const chatDir = plugin.sessionMemoryDir(plugin.currentConfig(), session)
    mkdirSync(chatDir, { recursive: true })
    seedFolder(chatDir, 'mem-20260101T000000Z-0001', { alpha: 0.2, keywords: ['部署'], text: 'LOW-ALPHA-MEMORY' })
    seedFolder(chatDir, 'mem-20260101T000000Z-0002', { alpha: 0.9, keywords: ['部署'], text: 'HIGH-ALPHA-MEMORY' })
    const recallTool = toolDefinition(capture, 'memory_recall')
    assert.ok(recallTool)

    // Non-owner group message: no keyword match (so automatic recall adds
    // nothing), but the turn's gate is now α>=0.5.
    inbox(plugin, session, userMessage('g1', '[09:30 小明(20002)] 早上好', 'plugin:dsh-onebot'))
    const gated = await recallTool.execute({ keywords: '部署', limit: 8 }, { agent: { session } })
    assert.deepEqual(gated.added, ['mem-20260101T000000Z-0002'], 'only the α>=0.5 memory may be recalled for a non-owner')

    // Owner speaks next: the gate is lifted for that turn.
    inbox(plugin, session, userMessage('o1', '[09:31 主人(10001)] 早上好', 'plugin:dsh-onebot'))
    const ungated = await recallTool.execute({ keywords: '部署', limit: 8 }, { agent: { session } })
    assert.equal(ungated.added.length, 2, 'the owner is never α-gated')
  }))
