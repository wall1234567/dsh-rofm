/**
 * Adapter-level tests for the v1.4.0 scoring pipeline (contract §5.7, plan §3.4):
 *
 *   - P0-1 task-block token budget: the `记忆评分任务` system-prompt section is part
 *     of the measured context, so it is capped by
 *     `min(scoring.taskMaxTokens, windowTokens * scoring.taskBudgetPercent%)`;
 *   - P0-6 order: `scoring.order='newest'` (newest pendingSince first) instead of
 *     the v1.3.0 FIFO that hid just-archived memories behind a backlog;
 *   - P0-2 era filter: only *current* pending folders enter the task list
 *     (`scoring.includeLegacy=false`), legacy/synthetic backlog stays out;
 *   - backpressure: `pendingCount > scoring.maxPending` pauses archiving
 *     (`fallback='never'`) or degrades to heuristic scoring (`onPressure`);
 *   - heuristic fallback after `scoring.autoHeuristicAfterRounds` rounds without
 *     a model judgement, with `meta.scoreMode='heuristic'` provenance;
 *   - P1-6 small-window sanity / fake-window guard / hard-limit hard stop;
 *   - P0-2 archive provenance (scoreMode / archivedByVersion / archivedFrom /
 *     pendingSince) on both scoring paths;
 *   - P1-2 empty-recall hint, P2-1 memory_recall nudge, P2-5 judge telemetry.
 *
 * The fake host mirrors `plugin-mock.test.mjs`: a tiny Session implementation and
 * a fake token meter that (v1.4.0) counts the plugin's system-prompt sections.
 * Unlike plugin-mock, these tests use a realistic `windowTokens` (20k+) unless a
 * small window is exactly what is being tested.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RofmPlugin } from '../lib/plugin.js'
import { estimateTokens } from '../engine/index.js'

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const clone = (value) => JSON.parse(JSON.stringify(value))

/** True when `text` contains an unpaired high or low UTF-16 surrogate. */
function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

class FakeSession {
  constructor({ contextWindow = 20000, header = { origin: 'main' }, id = 'session-pressure' } = {}) {
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
      get nodes() { return session.nodes },
      get replaceGeneration() { return session.replaceGeneration },
      get contentGeneration() { return session.contentGeneration },
    }
  }

  get seq() { return this.events.length }

  eventAt(seq) { return this.events[seq] }

  requestContext() { return { provider: 'mock', model: 'mock', contextWindow: this.windowTokens } }

  deriveEventMessage(event) {
    if (!event) return null
    switch (event.type) {
      case 'user/message': return event.data
      case 'assistant/message':
      case 'system/message':
      case 'developer/message': return event.data.message
      case 'tool/result': return event.data.message
      default: return null
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
      time: Number.isFinite(options.time) ? options.time : Date.now(),
      data: clone(data),
      ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...options.sourceEventSeqs] }),
      ...(options.surfaceOp === undefined ? {} : { surfaceOp: options.surfaceOp }),
    }
    if (SURFACE_TYPES.has(type)) {
      if (options.surfaceOp === 'append') {
        this.events.push(event)
        this.nodes.push(seq)
        this.contentGeneration += 1
        return event
      }
      const { startSeq, endSeq } = options.surfaceOp
      const startIdx = this.nodes.indexOf(startSeq)
      const endIdx = this.nodes.indexOf(endSeq)
      const shadowed = this.nodes.slice(startIdx, endIdx + 1)
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

const userMessage = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistantMessage = (id, text) => ({ id, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text }] })

function appendSystem(session) {
  session.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 'sys-1', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYSTEM PROMPT TEXT' }] } },
    { surfaceOp: 'append', time: 1 },
  )
}

function appendConversation(session, turns = 12) {
  for (let index = 0; index < turns; index += 1) {
    session.append('user/message', userMessage(`u-${index}`, `第${index}轮：继续讨论部署 docker 端口配置与数据库迁移，参数编号 ${index}。`), { surfaceOp: 'append' })
    session.append(
      'assistant/message',
      { turn: 1, step: 1, message: assistantMessage(`a-${index}`, `好的，第 ${index} 轮我记录一下 docker 端口和部署参数。`), stream: [] },
      { surfaceOp: 'append' },
    )
  }
}

/**
 * Fake token meter: conversation nodes + the plugin's system-prompt sections
 * (P0-1 needs the task/recall blocks to be part of the measured context).
 * `totalTokensOverride` simulates a host-reported/fake measurement.
 */
function makeMeter(session, capture, totalTokensOverride = undefined) {
  return () => {
    const nodes = session.nodes.map((seq) => {
      const message = session.deriveEventMessage(session.eventAt(seq))
      const text = JSON.stringify(message?.content ?? '')
      const tokens = Math.max(0, Math.ceil(text.length / 4))
      return { seq, tokens, heuristicTokens: tokens }
    })
    if (Number.isFinite(totalTokensOverride)) return { totalTokens: totalTokensOverride, nodes }
    let systemTokens = 0
    for (const section of capture?.sections ?? []) {
      let text = ''
      try {
        text = section.text({ agent: { session } }) ?? ''
      } catch {
        text = ''
      }
      if (typeof text === 'string' && text.length > 0) systemTokens += Math.max(0, Math.ceil(text.length / 4))
    }
    const totalTokens = nodes.reduce((sum, node) => sum + node.tokens, 0) + systemTokens
    return { totalTokens, nodes }
  }
}

function makeContext(session, options = {}) {
  const capture = { sections: [], tools: [], logs: [], registrations: [] }
  const toolsService = {
    register(definition) {
      const entry = { definition, disposed: false }
      capture.tools.push(entry)
      capture.registrations.push(definition)
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
    tokenMeter: { measure: makeMeter(session, capture, options.totalTokensOverride) },
    systemPrompt: {
      section(sectionOptions) {
        capture.sections.push(sectionOptions)
        return () => {}
      },
    },
    on() { return () => {} },
    effect(callback) { return callback() },
    get(name) {
      if (name === 'systemPrompt') return this.systemPrompt
      if (name === 'tokenMeter') return this.tokenMeter
      if (name === 'tools') return options.withTools === false ? undefined : toolsService
      return undefined
    },
  }
  if (options.withTools !== false) ctx.tools = toolsService
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

function makeOverrides(memoryDir, patch = {}) {
  return {
    enabled: true,
    compress: {
      enabled: true,
      triggerPercent: 1,
      compressPercent: 20,
      contextWindowTokens: 0, // use the host window
      minContextTokens: 0,
      minMessagesToCompress: 4,
      minChunkChars: 50,
      targetChunkChars: 200,
      maxFoldersPerRun: 500,
      keepRecentMessages: 2,
      applyToSubagents: true,
      applyToMainSessions: true,
      preStepEnabled: false,
      emergencyPercent: 85,
      emergencyCompressPercent: 40,
      maxExtraPasses: 0,
      hardLimitPercent: 95,
      hardLimitStop: true,
      allowSmallWindow: false,
      smallWindowTokens: 20000,
      maxFoldersPerStep: 500,
    },
    scoring: { includeLegacy: false },
    recall: {
      mode: 'legacy',
      seed: 7,
      probabilityScale: 1000,
      firstGenMax: 10,
      applyToSubagents: true,
      applyToMainSessions: true,
      triggerSourceKinds: ['user'],
      espEmptyHint: true,
    },
    importance: { min: 0.01, max: 1, warnAbove: 0.8 },
    keywords: { min: 3, max: 8 },
    storage: { dir: memoryDir, perSession: false },
    logging: { enabled: true, verbose: true },
    compat: { qqBots: 'off' },
    ...patch,
  }
}

function withTempDir(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-pressure-'))
    try {
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

function readIndexFile(memoryDir) {
  return JSON.parse(readFileSync(path.join(memoryDir, 'index.json'), 'utf8'))
}

function readMeta(memoryDir, id) {
  return JSON.parse(readFileSync(path.join(memoryDir, id, 'meta.json'), 'utf8'))
}

function readStatsEvents(memoryDir) {
  const file = path.join(memoryDir, 'stats.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** Write one memory folder + its index entry (scored or pending). */
function writeFolder(memoryDir, id, options = {}) {
  const {
    alpha = 0.5,
    beta = 0,
    keywords = ['fixture'],
    text = 'FIXTURE-MEMORY-CONTENT',
    createdAt = Date.now(),
    scored = true,
    rescorePending = false,
    messages = null,
    events = null,
  } = options
  const dir = path.join(memoryDir, id)
  mkdirSync(dir, { recursive: true })
  const body = Array.isArray(messages) && messages.length > 0 ? messages : [{ role: 'user', content: text }]
  const optionalTags = Array.isArray(events) ? { events } : {}
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify({ version: 1, id, createdAt, messages: body }))
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      version: 1,
      id,
      createdAt,
      alpha,
      beta,
      keywords,
      title: text.slice(0, 40),
      scored,
      rescorePending,
      pendingSince: scored ? undefined : createdAt,
      stats: { messages: body.length, chars: text.length, tokens: 10 },
      ...optionalTags,
    }),
  )
  let index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  try {
    index = JSON.parse(readFileSync(path.join(memoryDir, 'index.json'), 'utf8'))
  } catch {
    index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  }
  index.folders = (index.folders ?? []).filter((folder) => folder.id !== id)
  index.folders.push({
    id,
    createdAt,
    alpha,
    beta,
    keywords,
    chars: text.length,
    tokens: 10,
    messageCount: body.length,
    title: text.slice(0, 40),
    scored,
    rescorePending,
    pendingSince: scored ? undefined : createdAt,
    ...optionalTags,
  })
  writeFileSync(path.join(memoryDir, 'index.json'), JSON.stringify(index))
}

/** Pending fixture in the *current* era (createdAt = now-ish, so not legacy). */
function writePending(memoryDir, id, options = {}) {
  return writeFolder(memoryDir, id, { scored: false, alpha: 0, beta: 0, keywords: [], createdAt: Date.now() - 3600_000, ...options })
}

async function archiveConversation(memoryDir, options = {}) {
  const { id = 'session-pressure', turns = 14, windowTokens = 20000, patch = {}, totalTokensOverride = undefined } = options
  const session = new FakeSession({ id, contextWindow: windowTokens })
  appendSystem(session)
  appendConversation(session, turns)
  const { ctx, capture } = makeContext(session, { totalTokensOverride })
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir, patch))
  plugin.start()
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  return { session, plugin, ctx, capture }
}

// ---------------------------------------------------------------------------
// Task block: budget / order / era filter / item labels (P0-1, P0-6, P0-2)
// ---------------------------------------------------------------------------

test('task block is capped by min(scoring.taskMaxTokens, window*scoring.taskBudgetPercent%)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // 40 pending folders with long summaries: far more than a 15% budget can list.
  for (let index = 0; index < 40; index += 1) {
    writePending(memoryDir, `mem-pending-${String(index).padStart(3, '0')}`, {
      createdAt: Date.now() - 60_000 - index,
      text: `PENDING-ITEM-${String(index).padStart(3, '0')} ${'甲'.repeat(280)}`,
    })
  }
  const session = new FakeSession({ id: 'session-budget', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir, { scoring: { includeLegacy: false, taskBudgetPercent: 15, taskMaxTokens: 12000 } }))
  plugin.start()
  const text = tasksText(capture, session)
  const budget = Math.min(12000, 20000 * 0.15) // 3000 tokens
  assert.ok(text.length > 0, 'pending work renders a task block')
  assert.ok(estimateTokens(text) <= budget, `task block stays within the ${budget}-token budget (got ${estimateTokens(text)})`)
  assert.ok(text.includes('因任务区块预算未列出'), 'truncation is disclosed to the model')
  const listed = (text.match(/^\d+\. id=/gm) ?? []).length
  assert.ok(listed > 0 && listed < 40, `budget truncates the list (listed=${listed})`)

  // The absolute cap binds when it is smaller than the window share.
  const { ctx: ctx2, capture: capture2 } = makeContext(session)
  const plugin2 = new RofmPlugin(ctx2, makeOverrides(memoryDir, { scoring: { taskMaxTokens: 400, taskBudgetPercent: 15 } }))
  plugin2.start()
  const text2 = tasksText(capture2, session)
  // F-05-01: the compact fallback is part of the measured block, so the strict
  // invariant also holds here (the old assertion allowed 60 tokens of slack).
  assert.ok(estimateTokens(text2) <= 400, `taskMaxTokens binds (got ${estimateTokens(text2)} tokens)`)
  assert.ok(text2.includes('任务区块预算不足'), 'a too-small budget degrades to the compact notice')
}))

test('task block with event.showExisting labels stays within the P0-1 budget (F-05-01)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // 24 DISTINCT 60-char canonical event labels (the v1.5.0 「已有事件标签」 list).
  const eventLabel = (index) => `${'事'.repeat(56)}${String(index).padStart(4, '0')}`
  for (let index = 0; index < 24; index += 1) {
    writeFolder(memoryDir, `mem-tag-${String(index).padStart(2, '0')}`, {
      events: [eventLabel(index)],
      text: `event label holder ${index}`,
      alpha: 0.6,
      createdAt: Date.now() - 7200_000 + index,
    })
  }
  // Plus a backlog so the per-item lists fill whatever the labels leave over.
  for (let index = 0; index < 30; index += 1) {
    writePending(memoryDir, `mem-budget-label-${String(index).padStart(3, '0')}`, {
      createdAt: Date.now() - 60_000 - index,
      text: `PENDING-LABEL-${String(index).padStart(3, '0')} ${'甲'.repeat(280)}`,
    })
  }
  const patch = {
    scoring: { includeLegacy: false, taskMaxTokens: 12000, taskBudgetPercent: 15 },
    event: { showExisting: true, showExistingLimit: 24 },
  }
  // 12000 window: the label list fits and must still be within the 1800 budget.
  const wideSession = new FakeSession({ id: 'session-budget-labels-wide', contextWindow: 12000 })
  appendSystem(wideSession)
  const wide = makeContext(wideSession)
  const widePlugin = new RofmPlugin(wide.ctx, makeOverrides(memoryDir, patch))
  widePlugin.start()
  const wideText = tasksText(wide.capture, wideSession)
  const wideBudget = Math.min(12000, 12000 * 0.15) // 1800 tokens
  assert.ok(wideText.includes('### 已有事件标签（同一事件请复用，不要另造近义标签）'), wideText.slice(0, 400))
  assert.ok(
    estimateTokens(wideText) <= wideBudget,
    `window=12000: the whole block including the event-label list stays <= ${wideBudget} (got ${estimateTokens(wideText)})`,
  )

  // 8000 window: the label list no longer fits; the block degrades instead of
  // overshooting the 1200-token budget by +75% (the pre-fix behaviour).
  const narrowSession = new FakeSession({ id: 'session-budget-labels-narrow', contextWindow: 8000 })
  appendSystem(narrowSession)
  const narrow = makeContext(narrowSession)
  const narrowPlugin = new RofmPlugin(narrow.ctx, makeOverrides(memoryDir, patch))
  narrowPlugin.start()
  const narrowText = tasksText(narrow.capture, narrowSession)
  assert.ok(
    estimateTokens(narrowText) <= 1200,
    `window=8000: the task block stays within the 1200-token budget (got ${estimateTokens(narrowText)})`,
  )
}))

test('task block lists only current-era pending by default (scoring.includeLegacy)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // pre-1.2.0 legacy data: createdAt far below the v1.2.0 tag.
  writePending(memoryDir, 'mem-legacy-0001', { createdAt: 1000, text: 'LEGACY-PENDING' })
  writePending(memoryDir, 'mem-legacy-0002', { createdAt: 2000, text: 'LEGACY-PENDING-2' })
  // current-era pending data.
  writePending(memoryDir, 'mem-current-0001', { createdAt: Date.now() - 3600_000, text: 'CURRENT-PENDING' })
  const session = new FakeSession({ id: 'session-era', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const text = tasksText(capture, session)
  assert.ok(text.includes('CURRENT-PENDING'), 'current pending is listed')
  assert.ok(!text.includes('LEGACY-PENDING'), 'legacy pending is not listed by default')
  assert.ok(!text.includes('mem-legacy-0001'), 'legacy folder id is not listed by default')

  const { ctx: ctx2, capture: capture2 } = makeContext(session)
  const plugin2 = new RofmPlugin(ctx2, makeOverrides(memoryDir, { scoring: { includeLegacy: true } }))
  plugin2.start()
  const text2 = tasksText(capture2, session)
  assert.ok(text2.includes('LEGACY-PENDING'), 'includeLegacy=true lists legacy pending too')
}))

test('task block keeps synthetic (fake-window pressure test) pending out of the list', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // A pressure-test session: fake 8k window in its telemetry plus stress-level volume.
  for (let index = 0; index < 120; index += 1) {
    writePending(memoryDir, `mem-synthetic-${String(index).padStart(3, '0')}`, { createdAt: Date.now() - 7200_000 - index })
  }
  writeFileSync(
    path.join(memoryDir, 'stats.jsonl'),
    JSON.stringify({ type: 'compress-applied', time: Date.now() - 7200_000, windowTokens: 8000, beforePercent: 1200 }) + '\n',
  )
  const session = new FakeSession({ id: 'session-synthetic', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const text = tasksText(capture, session)
  assert.ok(!text.includes('mem-synthetic-'), 'synthetic pending never enters the task block')
  assert.ok(!text.includes('评分口径：'), 'no rubric is rendered for synthetic-only backlog')
}))

test('pending task order follows scoring.order (newest default fixes P0-6)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const base = Date.now() - 3600_000
  writePending(memoryDir, 'mem-old-0001', { createdAt: base - 2000, text: 'OLDEST-CONTENT' })
  writePending(memoryDir, 'mem-mid-0002', { createdAt: base - 1000, text: 'MIDDLE-CONTENT' })
  writePending(memoryDir, 'mem-new-0003', { createdAt: base, text: 'NEWEST-CONTENT' })
  const session = new FakeSession({ id: 'session-order', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir, { scoring: { order: 'newest' } }))
  plugin.start()
  const text = tasksText(capture, session)
  assert.ok(text.indexOf('mem-new-0003') < text.indexOf('mem-old-0001'), 'newest pending is listed first')

  const { ctx: ctx2, capture: capture2 } = makeContext(session)
  const plugin2 = new RofmPlugin(ctx2, makeOverrides(memoryDir, { scoring: { order: 'oldest' } }))
  plugin2.start()
  const text2 = tasksText(capture2, session)
  assert.ok(text2.indexOf('mem-old-0001') < text2.indexOf('mem-new-0003'), 'oldest order is available as rollback')

  const { ctx: ctx3, capture: capture3 } = makeContext(session)
  const plugin3 = new RofmPlugin(ctx3, makeOverrides(memoryDir, { scoring: { order: 'mixed' } }))
  plugin3.start()
  const text3 = tasksText(capture3, session)
  assert.ok(text3.indexOf('mem-new-0003') < text3.indexOf('mem-mid-0002'), 'mixed starts with the newest')
  assert.ok(text3.indexOf('mem-old-0001') < text3.indexOf('mem-mid-0002'), 'mixed alternates from both ends')
}))

test('pending task items show content type and waiting age', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const now = Date.now()
  writePending(memoryDir, 'mem-tool-0001', {
    createdAt: now - 7200_000,
    text: 'TOOL-OUTPUT-FOLDER',
    messages: [
      { role: 'tool', content: 'docker ps 输出：端口 8080' },
      { role: 'tool', content: 'docker logs 输出：迁移完成' },
    ],
  })
  writePending(memoryDir, 'mem-decision-0001', {
    createdAt: now - 600_000,
    text: '我们决定以后统一使用 8080 端口',
    messages: [{ role: 'user', content: '我们决定以后统一使用 8080 端口，不要再改了' }],
  })
  writePending(memoryDir, 'mem-user-0001', {
    createdAt: now - 30_000,
    text: '今天天气不错，聊点别的',
    messages: [{ role: 'user', content: '今天天气不错，聊点别的' }, { role: 'assistant', content: '好的' }],
  })
  const session = new FakeSession({ id: 'session-labels', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const text = tasksText(capture, session)
  assert.match(text, /id=mem-tool-0001 · 类型=tool · 已等待 2 小时/, text)
  assert.match(text, /id=mem-decision-0001 · 类型=decision · 已等待 10 分钟/, text)
  assert.match(text, /id=mem-user-0001 · 类型=user · 已等待 刚刚/, text)
}))

test('pending task body shows the QQ tool-result conversation, not raw JSON (v1.4.3/v1.5.4)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // The Derpyu bridge answers qq_get_unread_messages with serializeModelData(...):
  // a JSON string whose first 160 chars used to be nothing but field names.
  const toolJson = JSON.stringify({
    ok: true,
    key: 'private:765280787',
    unreadCount: 1,
    messages: [{ seq: 5, messageId: '765280787', sender: '私聊', userId: '765280787', text: '我决定以后所有项目都用 python' }],
    readThroughSeq: 5,
  })
  writePending(memoryDir, 'mem-qq-json-0001', {
    text: toolJson,
    createdAt: Date.now() - 3600_000,
    messages: [
      { role: 'tool', content: toolJson },
      { role: 'assistant', content: '好的，记下了。' },
    ],
  })
  const session = new FakeSession({ id: 'session-qq-json', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const text = tasksText(capture, session)
  const head = text.split('\n').find((entry) => entry.includes('id=mem-qq-json-0001'))
  assert.ok(head, `pending item is listed: ${text.slice(0, 400)}`)
  // The JSON tool result carries real conversation, so its dialogue is rendered
  // in the full-text body (v1.5.4: no 160-char summary anymore).
  assert.ok(head.includes('类型=decision'), head)
  assert.ok(text.includes('原文：'), text.slice(0, 500))
  assert.ok(text.includes('私聊：我决定以后所有项目都用 python'), 'the conversation inside the JSON is rendered')
  assert.ok(text.includes('assistant: 好的，记下了。'), 'the rest of the conversation follows')
  assert.equal(text.includes('"messageId"'), false, 'JSON field names must not reach the model')
}))

test('pending task full body never leaves a lone surrogate (v1.4.4/v1.5.4)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // `user: ` plus 153 ASCII puts the emoji's high surrogate on unit 159; the
  // pre-fix `flat.slice(0, 160)` kept a lone D83E there, the host serialized it
  // as an invalid-surrogate JSON escape, and the Messages API rejected every
  // request before the model could score the folder (permanent stall).
  const emoji = '\u{1F916}' // 🤖 = high surrogate D83E + low surrogate DD16
  writePending(memoryDir, 'mem-surrogate-0001', {
    createdAt: Date.now() - 3600_000,
    text: 'SURROGATE-BOUNDARY',
    messages: [{ role: 'user', content: 'A'.repeat(153) + emoji }],
  })
  const session = new FakeSession({ id: 'session-surrogate', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const text = tasksText(capture, session)
  assert.ok(text.includes('原文：'), text.slice(0, 300))
  assert.ok(text.includes('AAAA'), text.slice(0, 400))
  assert.ok(text.includes(emoji), 'the full body keeps the emoji intact')
  assert.equal(hasLoneSurrogate(text), false, 'system-prompt text must be well-formed UTF-16')
  // The exact defect: JSON.stringify of an unpaired surrogate emits this escape
  // and the DeepSeek Messages API rejects the request with 400.
  assert.equal(JSON.stringify(text).includes(`${String.fromCharCode(92)}ud83e`), false)
}))

test('pending task body is the full conversation, not the old 160-char summary (v1.5.4)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // The tail marker sits far beyond the old 160-char preview window, so finding
  // it in the task section proves the full body is rendered.
  const longText = `FULL-BEGIN-${'乙'.repeat(260)}-FULL-END-MARKER`
  writePending(memoryDir, 'mem-full-body-0001', {
    createdAt: Date.now() - 3600_000,
    text: longText,
    messages: [
      { role: 'user', content: longText },
      { role: 'assistant', content: '收到，我记下了。' },
    ],
  })
  const session = new FakeSession({ id: 'session-full-body', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const text = tasksText(capture, session)
  assert.ok(text.includes('原文：'), text.slice(0, 300))
  assert.ok(text.includes('FULL-END-MARKER'), 'full conversation body, not the 160-char summary')
  assert.ok(text.includes('user: FULL-BEGIN-'), 'role prefixes are kept')
  assert.ok(text.includes('assistant: 收到，我记下了。'), 'the whole conversation is rendered')
  assert.ok(text.length > longText.length, 'the task section really contains the full body')
}))

test('pending task body drops non-conversation messages (v1.5.4)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writePending(memoryDir, 'mem-filtered-0001', {
    createdAt: Date.now() - 3600_000,
    text: 'FIXTURE',
    messages: [
      { role: 'user', content: '我喜欢深色主题，以后都用深色。' },
      { role: 'tool', content: 'RAW-TOOL-OUTPUT-MUST-NOT-REACH-THE-JUDGE' },
      { role: 'assistant', content: '记下了，以后都用深色主题。' },
    ],
  })
  const session = new FakeSession({ id: 'session-filtered', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const text = tasksText(capture, session)
  assert.ok(text.includes('user: 我喜欢深色主题，以后都用深色。'), text.slice(0, 400))
  assert.ok(text.includes('assistant: 记下了，以后都用深色主题。'))
  assert.equal(text.includes('RAW-TOOL-OUTPUT-MUST-NOT-REACH-THE-JUDGE'), false, 'pure tool output is not real conversation')
}))

test('pending task body flags a folder with no real conversation (v1.5.4)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // A truncated JSON tool payload cannot be parsed into conversation: the folder
  // keeps the legacy "tool" label and now says explicitly that there is no real
  // dialogue to score (v1.5.4 drops non-conversation messages from the body).
  const truncated = '{"id":"task-2","revision":1,"subject":"阶段A-1: engine/recall-index.js'
  writePending(memoryDir, 'mem-tool-truncated-0001', {
    text: truncated,
    createdAt: Date.now() - 3600_000,
    messages: [{ role: 'tool', content: truncated }],
  })
  const session = new FakeSession({ id: 'session-tool-truncated', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const text = tasksText(capture, session)
  const head = text.split('\n').find((entry) => entry.includes('id=mem-tool-truncated-0001'))
  assert.ok(head, text.slice(0, 400))
  assert.ok(head.includes('类型=tool'), head)
  assert.ok(text.includes('（无真实对话内容：纯工具输出 / 协议消息，按过程日志评分）'), text.slice(0, 500))
}))

test('re-review body renders QQ tool-result JSON readably (v1.4.3)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const waitJson = JSON.stringify({
    ok: true,
    key: 'private:765280787',
    newMessages: [{ seq: 7, messageId: '765280789', sender: '私聊', userId: '765280787', text: '你上次说的那家甜品店叫啥来着' }],
    readThroughSeq: 7,
  })
  writeFolder(memoryDir, 'mem-qq-review-0001', {
    createdAt: Date.now() - 3600_000,
    text: waitJson,
    messages: [{ role: 'tool', content: waitJson }],
    rescorePending: true,
    keywords: ['甜品'],
  })
  const session = new FakeSession({ id: 'session-qq-review', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const text = tasksText(capture, session)
  assert.ok(text.includes('### 待复核的已召回记忆'), text.slice(0, 300))
  assert.ok(text.includes('原文：'))
  assert.ok(text.includes('私聊：你上次说的那家甜品店叫啥来着'), 'the re-review body is the conversation')
  assert.equal(text.includes('"readThroughSeq"'), false, 'JSON field names must not reach the model')
}))

test('re-review entries are truncated to the task-block budget instead of growing unbounded', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFolder(memoryDir, 'mem-rescore-0001', {
    createdAt: Date.now() - 3600_000,
    text: `LONG-BODY-BEGIN-${'甲'.repeat(4000)}-LONG-BODY-END`,
    messages: [{ role: 'user', content: `LONG-BODY-BEGIN-${'甲'.repeat(4000)}-LONG-BODY-END` }],
    rescorePending: true,
  })
  const session = new FakeSession({ id: 'session-rescore-budget', contextWindow: 5000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const text = tasksText(capture, session)
  const budget = Math.min(12000, 5000 * 0.15) // 750 tokens (v1.5.5 rubric grew a little)
  assert.ok(text.includes('待复核的已召回记忆'), 'the re-review section is still rendered')
  assert.ok(text.includes('受任务区块预算限制，原文已截断'), 'the full body is truncated to fit the budget')
  // F-05-01: the rendered block is re-checked against the strict P0-1 budget
  // (the v1.5.0 audit fix removed the old 1.35x allowance for estimate rounding).
  assert.ok(estimateTokens(text) <= budget, `task block stays bounded (got ${estimateTokens(text)} tokens for a ${budget}-token budget)`)
}))

test('P0-1: the task block alone can never reach the compress trigger', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  for (let index = 0; index < 60; index += 1) {
    writePending(memoryDir, `mem-feedback-${String(index).padStart(3, '0')}`, {
      createdAt: Date.now() - 60_000 - index,
      text: `FEEDBACK-${index} ${'甲'.repeat(200)}`,
    })
  }
  const session = new FakeSession({ id: 'session-feedback', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const overrides = makeOverrides(memoryDir, { compress: { ...makeOverrides(memoryDir).compress, triggerPercent: 60 } })
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const tasksTokens = estimateTokens(tasksText(capture, session))
  // The task block is a system-prompt section: its own budget (15% of the window)
  // is far below the 60% trigger, so a backlog alone can never drive the next
  // archive (the P0-1 self-amplifying loop).
  assert.ok(tasksTokens <= 20000 * 0.15, `task block <= window*15% (got ${tasksTokens})`)
  const measured = ctx.tokenMeter.measure(session).totalTokens
  assert.ok(measured < 20000 * 0.6, `sections + tiny conversation stay below the trigger (got ${measured})`)
}))

// ---------------------------------------------------------------------------
// Backpressure / heuristic fallback (P0-2)
// ---------------------------------------------------------------------------

test('scoring.fallback="never" pauses archiving while the backlog exceeds maxPending', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  for (let index = 0; index < 6; index += 1) writePending(memoryDir, `mem-backlog-${index}`, { createdAt: Date.now() - 3600_000 - index })
  const { session, plugin, capture } = await archiveConversation(memoryDir, {
    patch: { scoring: { fallback: 'never', maxPending: 5 } },
  })
  assert.equal(session.events.filter((event) => event.type.startsWith('compaction/')).length, 0, 'no archive while backpressured')
  assert.ok(existsSync(path.join(memoryDir, 'index.json')), 'existing index untouched')
  assert.equal(readIndexFile(memoryDir).folders.length, 6, 'no new folder was written')
  const paused = capture.logs.filter(([level, message]) => level === 'warn' && message.includes('compression paused'))
  assert.equal(paused.length, 1, 'the pause is announced once, not per step')
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  assert.equal(capture.logs.filter(([level, message]) => level === 'warn' && message.includes('compression paused')).length, 1, 'still one WARN')
}))

test('scoring.fallback="onPressure" degrades an archive to heuristic scoring when the backlog is over maxPending', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  for (let index = 0; index < 4; index += 1) writePending(memoryDir, `mem-pressure-${index}`, { createdAt: Date.now() - 3600_000 - index })
  const { session } = await archiveConversation(memoryDir, { patch: { scoring: { fallback: 'onPressure', maxPending: 3 } } })
  const index = readIndexFile(memoryDir)
  const created = index.folders.filter((folder) => folder.id.startsWith('mem-2026'))
  assert.ok(created.length >= 1, 'the archive still ran (degraded, not paused)')
  for (const folder of created) {
    const meta = readMeta(memoryDir, folder.id)
    assert.equal(meta.scored, true, 'heuristic folders are immediately recallable')
    assert.equal(meta.scoreMode, 'heuristic', 'meta.scoreMode records the degradation')
    assert.match(meta.archivedByVersion, /^\d+\.\d+\.\d+/, 'archivedByVersion recorded')
    assert.equal(meta.archivedFrom, 'adapter', 'archivedFrom recorded')
    assert.equal(meta.pendingSince, meta.createdAt, 'pendingSince = createdAt provenance')
  }
  const applied = readStatsEvents(memoryDir).filter((event) => event.type === 'compress-applied').at(-1)
  assert.equal(applied.scoreMode, 'heuristic')
  assert.ok(applied.pendingAtArchive >= 4, 'compress telemetry records pendingAtArchive')
  assert.equal(applied.pendingAtArchive, applied.pendingCount)
  assert.ok(session.events.some((event) => event.type === 'compaction/end'), 'conversation was archived')
}))

test('scoring.fallback="onPressure" degrades after autoHeuristicAfterRounds rounds with pending work', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writePending(memoryDir, 'mem-unjudged-0001', { createdAt: Date.now() - 4 * 3600_000 })
  const { session, plugin } = await archiveConversation(memoryDir, { patch: { scoring: { fallback: 'onPressure', maxPending: 200 } } })
  const before = new Set(readIndexFile(memoryDir).folders.map((folder) => folder.id))
  // The first archive already counted one round with pending work; simulate three
  // more turns in which the model never judged the pending folders.
  for (let turn = 2; turn <= 4; turn += 1) plugin.trackPendingRounds(session, turn, 1)
  assert.equal(plugin.sessionState(session).pendingRounds, 4, 'pending rounds tracked once per turn')
  appendConversation(session, 6)
  await plugin.compressWithEscalation(session, 5, plugin.currentConfig(), 'test')
  const created = readIndexFile(memoryDir).folders.filter((folder) => !before.has(folder.id))
  assert.ok(created.length >= 1, 'the pressured archive wrote new folders')
  for (const folder of created) {
    assert.equal(readMeta(memoryDir, folder.id).scoreMode, 'heuristic', 'fallback after the round threshold is auditable')
  }
}))

test('scoring.fallback="always" always archives with heuristic scoring and one WARN', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const { session, capture } = await archiveConversation(memoryDir, { patch: { scoring: { fallback: 'always' } } })
  const created = readIndexFile(memoryDir).folders.filter((folder) => folder.id.startsWith('mem-2026'))
  assert.ok(created.length >= 1)
  for (const folder of created) assert.equal(readMeta(memoryDir, folder.id).scoreMode, 'heuristic')
  assert.equal(capture.logs.filter(([level, message]) => level === 'warn' && message.includes('heuristic scoring')).length, 1, 'one WARN per plugin')
  assert.ok(session.events.some((event) => event.type === 'compaction/end'))
}))

test('normal model-scored archive records the full provenance set (P0-2)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const { capture } = await archiveConversation(memoryDir)
  const folders = readIndexFile(memoryDir).folders
  assert.ok(folders.length >= 1)
  for (const folder of folders) {
    const meta = readMeta(memoryDir, folder.id)
    assert.equal(meta.scored, false, 'model-scored archives stay pending')
    assert.equal(meta.scoreMode, 'model', 'meta.scoreMode records the intended scoring path')
    assert.equal(meta.archivedFrom, 'adapter')
    assert.match(meta.archivedByVersion, /^\d+\.\d+\.\d+/)
    assert.equal(meta.pendingSince, meta.createdAt, 'pendingSince = createdAt')
  }
  const applied = readStatsEvents(memoryDir).filter((event) => event.type === 'compress-applied').at(-1)
  assert.equal(applied.scoreMode, 'model')
  assert.ok(Number.isFinite(applied.pendingAtArchive) && Number.isFinite(applied.pendingCount))
  assert.equal(applied.smallWindow, false)
  assert.equal(applied.protectedTurn, true, 'turn protection is reported')
  assert.equal(applied.foldersPlanned, applied.foldersCommitted)
  assert.equal(applied.rollback, false)
  assert.equal(applied.importanceSource, 'pending')
  assert.ok(capture.logs.some(([level, message]) => level === 'info' && message.includes('memory folders')))
}))

// ---------------------------------------------------------------------------
// Small-window sanity / fake window / hard-limit hard stop (P1-6)
// ---------------------------------------------------------------------------

test('small windows refuse automatic archiving by default and allowSmallWindow opts in', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const session = new FakeSession({ id: 'session-small', contextWindow: 8000 })
  appendSystem(session)
  appendConversation(session, 14)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  assert.equal(session.events.filter((event) => event.type.startsWith('compaction/')).length, 0, 'small window: no archive')
  const warns = capture.logs.filter(([level, message]) => level === 'warn' && message.includes('small context window'))
  assert.equal(warns.length, 1, 'small-window refusal is announced once')
  assert.match(warns[0][1], /allowSmallWindow=true/)
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  assert.equal(capture.logs.filter(([level, message]) => level === 'warn' && message.includes('small context window')).length, 1, 'no second WARN')

  const memoryDir2 = path.join(dir, 'memory-allow')
  const session2 = new FakeSession({ id: 'session-small-allow', contextWindow: 8000 })
  appendSystem(session2)
  appendConversation(session2, 14)
  const { ctx: ctx2 } = makeContext(session2)
  const plugin2 = new RofmPlugin(ctx2, makeOverrides(memoryDir2, { compress: { ...makeOverrides(memoryDir2).compress, allowSmallWindow: true } }))
  plugin2.start()
  await plugin2.compressWithEscalation(session2, 1, plugin2.currentConfig(), 'test')
  assert.ok(session2.events.some((event) => event.type === 'compaction/end'), 'allowSmallWindow=true permits the archive')
}))

test('a contextWindowTokens that disagrees with the host window by 4x counts as a conflict', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const session = new FakeSession({ id: 'session-conflict', contextWindow: 1_000_000 })
  appendSystem(session)
  appendConversation(session, 14)
  const { ctx, capture } = makeContext(session)
  const overrides = makeOverrides(memoryDir)
  overrides.compress.contextWindowTokens = 8000 // 8k vs a 1M host window
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  assert.equal(session.events.filter((event) => event.type.startsWith('compaction/')).length, 0, 'conflicting window: no archive')
  assert.ok(
    capture.logs.some(([level, message]) => level === 'warn' && message.includes('small context window') && message.includes('disagrees')),
    JSON.stringify(capture.logs.slice(-4)),
  )
}))

test('a measurement above 500% of the window (fake meter) is refused unless allowSmallWindow', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const session = new FakeSession({ id: 'session-fake', contextWindow: 40000 })
  appendSystem(session)
  appendConversation(session, 14)
  const { ctx, capture } = makeContext(session, { totalTokensOverride: 40000 * 7 })
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  assert.equal(session.events.filter((event) => event.type.startsWith('compaction/')).length, 0, 'fake window: no archive')
  assert.ok(
    capture.logs.some(([level, message]) => level === 'warn' && message.includes('fake/synthetic window')),
    JSON.stringify(capture.logs.slice(-4)),
  )
}))

test('hardLimitPercent becomes a hard stop after consecutive failed compressions', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const session = new FakeSession({ id: 'session-hardlimit', contextWindow: 20000 })
  appendSystem(session)
  appendConversation(session, 14)
  const { ctx, capture } = makeContext(session, { totalTokensOverride: 50000 }) // 250% of the window
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  assert.ok(session.events.some((event) => event.type === 'compaction/end'), 'the first compression applied')
  assert.equal(plugin.sessionState(session).hardLimitHits, 1, 'first episode still above the hard limit')

  appendConversation(session, 10)
  await plugin.compressWithEscalation(session, 2, plugin.currentConfig(), 'test')
  assert.equal(plugin.sessionState(session).hardLimitStopped, true, 'second consecutive episode stops archiving')
  assert.equal(capture.logs.filter(([level, message]) => level === 'warn' && message.includes('automatic archiving stopped')).length, 1, 'stop is announced once')

  const eventsBefore = session.events.filter((event) => event.type.startsWith('compaction/')).length
  appendConversation(session, 10)
  await plugin.compressWithEscalation(session, 3, plugin.currentConfig(), 'test')
  assert.equal(
    session.events.filter((event) => event.type.startsWith('compaction/')).length,
    eventsBefore,
    'a hard-stopped session does not retry on every step',
  )
}))

test('hardLimitStop=false keeps the v1.3.0 diagnostics (WARN once, no stop)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const session = new FakeSession({ id: 'session-hardlimit-warn', contextWindow: 20000 })
  appendSystem(session)
  appendConversation(session, 14)
  const { ctx, capture } = makeContext(session, { totalTokensOverride: 50000 })
  const overrides = makeOverrides(memoryDir)
  overrides.compress.hardLimitStop = false
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  assert.equal(plugin.sessionState(session).hardLimitStopped, false, 'no hard stop when disabled')
  assert.ok(capture.logs.some(([level, message]) => level === 'warn' && message.includes('context still high after compression')))
}))

// ---------------------------------------------------------------------------
// Prompt hints + judge telemetry (P1-2, P2-1, P2-5)
// ---------------------------------------------------------------------------

test('empty automatic recall leaves one low-noise hint, opt-out via recall.espEmptyHint', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFolder(memoryDir, 'mem-unmatched-0001', { createdAt: Date.now() - 3600_000, alpha: 0.9, keywords: ['星港'], text: 'STARPORT-MEMORY' })
  const session = new FakeSession({ id: 'session-empty-recall', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-miss', '完全无关的问题：今天晚饭吃什么') })
  const hint = recallText(capture, session)
  assert.ok(hint.includes('未自动回忆到相关记忆'), hint)
  assert.ok(hint.includes('memory_recall'), 'the hint tells the model how to search by hand')
  assert.ok(hint.split('\n').length <= 2, 'the hint is a single low-noise line')
  assert.equal(recalledEntryCount(recallText(capture, session)), 0, 'no memory was injected')

  const { ctx: ctx2, capture: capture2 } = makeContext(session)
  const plugin2 = new RofmPlugin(ctx2, makeOverrides(memoryDir, { recall: { ...makeOverrides(memoryDir).recall, espEmptyHint: false } }))
  plugin2.start()
  plugin2.onInboxInserted({ agent: { session }, message: userMessage('u-miss-2', '完全无关的问题：今天晚饭吃什么') })
  assert.equal(recallText(capture2, session), '', 'espEmptyHint=false keeps the old silent behaviour')
}))

test('plain sessions get the memory_recall nudge when a recall block exists (P2-1)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFolder(memoryDir, 'mem-nudge-0001', { createdAt: Date.now() - 3600_000, alpha: 0.9, keywords: ['部署'], text: 'DEPLOY-MEMORY' })
  const session = new FakeSession({ id: 'session-nudge', contextWindow: 20000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-nudge-2', '部署 继续') })
  assert.ok(recallText(capture, session).includes('记忆回忆'), 'recall injected first')
  const text = tasksText(capture, session)
  assert.ok(text.includes('上下文不足时'), 'the nudge mentions insufficient context')
  assert.ok(text.includes('memory_recall'), 'the nudge names the tool')
}))

test('recordJudgeEvent writes numeric-only judge telemetry (P2-5)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const session = new FakeSession({ id: 'session-judge-telemetry', contextWindow: 20000 })
  appendSystem(session)
  const { ctx } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const ok = plugin.recordJudgeEvent(session, {
    batchSize: 3,
    updated: 2,
    kept: 1,
    rejected: 0,
    elapsedMs: 1234,
    uniformAlphaRate: 0.5,
    keywordRepeatRate: 0.25,
    reasonMissingRate: 0.1,
    // must never be written to stats.jsonl:
    content: 'SECRET-MEMORY-TEXT',
    keywords: ['secret'],
  })
  assert.equal(ok, true, 'the event was written')
  const judgeEvents = readStatsEvents(memoryDir).filter((event) => event.type === 'judge')
  assert.equal(judgeEvents.length, 1)
  const event = judgeEvents[0]
  assert.equal(event.sessionId, 'session-judge-telemetry')
  assert.equal(event.batchSize, 3)
  assert.equal(event.updated, 2)
  assert.equal(event.kept, 1)
  assert.equal(event.rejected, 0)
  assert.equal(event.elapsedMs, 1234)
  assert.equal(event.uniformAlphaRate, 0.5)
  assert.equal(event.keywordRepeatRate, 0.25)
  assert.equal(event.reasonMissingRate, 0.1)
  assert.ok(Number.isFinite(event.time))
  assert.equal(event.content, undefined, 'memory text is never persisted')
  assert.equal(event.keywords, undefined, 'keyword originals are never persisted')
  assert.ok(!JSON.stringify(event).includes('SECRET-MEMORY-TEXT'))

  // Opt-out switch and defensive defaults.
  const { ctx: ctx2 } = makeContext(session)
  const plugin2 = new RofmPlugin(ctx2, makeOverrides(memoryDir, { scoring: { judgeTelemetry: false } }))
  plugin2.start()
  assert.equal(plugin2.recordJudgeEvent(session, { batchSize: 1 }), false, 'scoring.judgeTelemetry=false disables the event')
  assert.equal(plugin2.recordJudgeEvent(undefined, { batchSize: 1 }), false, 'no session -> no event and no throw')
}))

/** Number of recalled memory entries in an injected block (### 回忆 N). */
function recalledEntryCount(text) {
  return (text.match(/^### 回忆/gm) ?? []).length
}
