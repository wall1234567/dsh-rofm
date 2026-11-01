/**
 * Adapter-level tests for v1.4.0 current-turn protection (P0-3, plan §3.5) and
 * the pass-0 re-archive protections (P1-1 / P1-3):
 *
 *   - `lib/surface.js protectTurnOf()` finds the current turn's user message and
 *     every surface node after it (tool pairs included);
 *   - the adapter passes `protectTurn`/`protectSeq` (plus `pendingCount`,
 *     `allowSmallWindow`, `maxFolders`, `eventTimes`, and per-message `seq`) to
 *     `engine.planCompression`;
 *   - a multi-step tool turn never has its current question archived;
 *   - an engine refusal (`shouldCompress=false` / `reason='protected-turn'`) is
 *     accepted — the adapter never falls back to an arbitrary cut;
 *   - defense in depth: even if the plan covers the current turn, the adapter
 *     refuses the archive and writes nothing;
 *   - pass-0 re-archiving keeps additions injected by the current turn and
 *     `rescorePending` folders are not recalled again immediately;
 *   - event-time collection: `buildSurfaceEntries` forwards `event.time` and the
 *     engine records `meta.eventStart/eventEnd/eventTimeSource='messages'`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RofmPlugin } from '../lib/plugin.js'
import { protectTurnOf } from '../lib/surface.js'

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const clone = (value) => JSON.parse(JSON.stringify(value))

class FakeSession {
  constructor({ contextWindow = 20000, header = { origin: 'main' }, id = 'session-turn-protect' } = {}) {
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
const toolCallMessage = (id, callId, name, args) => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider: 'mock', model: 'mock' },
  content: [
    { type: 'text', text: '调用工具' },
    { type: 'tool-call', id: callId, name, arguments: args },
  ],
})
const toolResultMessage = (id, callId, text) => ({
  id,
  role: 'tool',
  source: { kind: 'tool', callId },
  toolCallId: callId,
  content: [{ type: 'text', text }],
})

function appendSystem(session) {
  session.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 'sys-1', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYSTEM PROMPT TEXT' }] } },
    { surfaceOp: 'append', time: 1 },
  )
}

function appendConversation(session, turns = 12, baseTime = 1_700_000_000_000) {
  for (let index = 0; index < turns; index += 1) {
    session.append('user/message', userMessage(`u-${index}`, `第${index}轮：继续讨论部署 docker 端口配置与数据库迁移，参数编号 ${index}。`), {
      surfaceOp: 'append',
      time: baseTime + index * 60_000,
    })
    session.append(
      'assistant/message',
      { turn: 1, step: 1, message: assistantMessage(`a-${index}`, `好的，第 ${index} 轮我记录一下 docker 端口和部署参数。`), stream: [] },
      { surfaceOp: 'append', time: baseTime + index * 60_000 + 30_000 },
    )
  }
}

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
    return { totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) + systemTokens, nodes }
  }
}

function makeContext(session, options = {}) {
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
      if (name === 'tools') return toolsService
      return undefined
    },
  }
  ctx.tools = toolsService
  return { ctx, capture }
}

function makeOverrides(memoryDir, patch = {}) {
  return {
    enabled: true,
    compress: {
      enabled: true,
      triggerPercent: 1,
      compressPercent: 20,
      contextWindowTokens: 0,
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
    scoring: { includeLegacy: true },
    recall: {
      mode: 'legacy',
      seed: 7,
      probabilityScale: 1000,
      firstGenMax: 10,
      applyToSubagents: true,
      applyToMainSessions: true,
      triggerSourceKinds: ['user'],
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
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-turn-'))
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

function writeFolderFixture(memoryDir, id, options = {}) {
  const { alpha = 0.5, beta = 0, keywords = ['fixture'], text = 'FIXTURE-MEMORY-CONTENT', createdAt = Date.now(), scored = true } = options
  const dir = path.join(memoryDir, id)
  mkdirSync(dir, { recursive: true })
  const messages = [{ role: 'user', content: text }]
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
      scored,
      stats: { messages: 1, chars: text.length, tokens: 10 },
    }),
  )
  let index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  try {
    index = JSON.parse(readFileSync(path.join(memoryDir, 'index.json'), 'utf8'))
  } catch {
    index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  }
  index.folders = (index.folders ?? []).filter((folder) => folder.id !== id)
  index.folders.push({ id, createdAt, alpha, beta, keywords, chars: text.length, tokens: 10, messageCount: 1, title: text, scored })
  writeFileSync(path.join(memoryDir, 'index.json'), JSON.stringify(index))
}

async function judgeAllPending(memoryDir, capture, session) {
  const judge = capture.tools.find((entry) => entry.definition?.name === 'memory_judge')?.definition
  assert.ok(judge, 'memory_judge is registered')
  const updates = readIndexFile(memoryDir)
    .folders.filter((folder) => folder.scored === false)
    .map((folder) => ({ id: folder.id, alpha: 0.5, beta: 3, keywords: ['部署', 'docker', '端口'] }))
  if (updates.length === 0) return
  await judge.execute({ updates }, { agent: { session } })
}

/** Append a complete multi-step current turn (user question + tool pair). */
function appendCurrentTurn(session, options = {}) {
  const { userText = 'CURRENT-QUESTION-MARKER 当前这轮的问题：继续部署 docker 端口', toolOutput = 'TOOL-OUTPUT-MARKER 查询结果：端口 8080 正常' } = options
  session.append('user/message', userMessage('u-current', userText), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    { turn: 99, step: 1, message: toolCallMessage('a-current', 'call-current', 'bash', '{"command":"docker ps"}'), stream: [] },
    { surfaceOp: 'append' },
  )
  session.append('tool/result', { turn: 99, step: 1, message: toolResultMessage('t-current', 'call-current', toolOutput) }, { surfaceOp: 'append' })
}

function nodeHasText(session, marker) {
  for (const seq of session.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq))
    const text = JSON.stringify(message?.content ?? '')
    if (text.includes(marker)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// protectTurnOf helper
// ---------------------------------------------------------------------------

test('protectTurnOf finds the current turn user message and every node after it', withTempDir(async () => {
  const session = new FakeSession({ id: 'session-protect-helper' })
  appendSystem(session)
  appendConversation(session, 2)
  appendCurrentTurn(session)
  const current = protectTurnOf(session, 3)
  const expectedUserSeq = session.nodes.find((seq) => session.deriveEventMessage(session.eventAt(seq))?.id === 'u-current')
  assert.equal(current.turn, 3)
  assert.equal(current.startSeq, expectedUserSeq, 'boundary is the current-turn user message')
  assert.ok(current.seqs.has(expectedUserSeq), 'the user message is protected')
  const toolSeq = session.nodes.find((seq) => session.deriveEventMessage(session.eventAt(seq))?.id === 't-current')
  assert.ok(current.seqs.has(toolSeq), 'the same-turn tool result is protected')

  // Host-synthesized user context after the question is not a turn boundary.
  session.append(
    'user/message',
    { id: 'rt-after', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context' }] },
    { surfaceOp: 'append' },
  )
  const stillCurrent = protectTurnOf(session, 3)
  assert.equal(stillCurrent.startSeq, expectedUserSeq, 'runtime-context is not a turn boundary')

  // No real user message at all -> nothing to protect.
  const empty = new FakeSession({ id: 'session-protect-empty' })
  appendSystem(empty)
  const none = protectTurnOf(empty, 1)
  assert.equal(none.startSeq, null)
  assert.equal(none.seqs.size, 0)

  // QQ onebot messages are real user input but carry a foreign source kind.
  const channel = new FakeSession({ id: 'qqb-g-1-2' })
  appendSystem(channel)
  channel.append(
    'user/message',
    { id: 'onebot-user', role: 'user', source: { kind: 'plugin:dsh-onebot' }, content: [{ type: 'text', text: 'onebot question' }] },
    { surfaceOp: 'append' },
  )
  assert.equal(protectTurnOf(channel, 1).startSeq, null, 'foreign user kind ignored by default')
  assert.equal(protectTurnOf(channel, 1, { conversationSourceKinds: ['plugin:dsh-onebot'] }).startSeq, 1, 'extra kinds are honoured')
}))

// ---------------------------------------------------------------------------
// Pass-through to engine.planCompression
// ---------------------------------------------------------------------------

test('adapter passes protectTurn/protectSeq/pendingCount/allowSmallWindow/maxFolders/eventTimes to the engine', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const session = new FakeSession({ id: 'session-protect-pass' })
  appendSystem(session)
  appendConversation(session, 14)
  appendCurrentTurn(session)
  const { ctx } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const engine = plugin.engineFor(session, plugin.currentConfig())
  const original = engine.planCompression.bind(engine)
  const calls = []
  engine.planCompression = (messages, usedPercent, options) => {
    calls.push({ messages, options })
    return original(messages, usedPercent, options)
  }
  await plugin.compressWithEscalation(session, 15, plugin.currentConfig(), 'test')
  assert.equal(calls.length >= 1, true, 'planCompression was called')
  const call = calls[0]
  const expectedUserSeq = session.nodes.find((seq) => session.deriveEventMessage(session.eventAt(seq))?.id === 'u-current')
  assert.equal(call.options.protectTurn, 15, 'protectTurn is the current turn number')
  assert.equal(call.options.protectSeq, expectedUserSeq, 'protectSeq is the current-turn user message seq')
  assert.ok(Number.isFinite(call.options.pendingCount), 'pendingCount is forwarded for backpressure telemetry')
  assert.equal(call.options.allowSmallWindow, false, 'allowSmallWindow follows compress.allowSmallWindow')
  assert.ok(Number.isFinite(call.options.maxFolders) && call.options.maxFolders > 0, 'maxFolders is forwarded')
  assert.equal(call.messages.length, call.options.eventTimes.length, 'eventTimes is parallel to messages')
  for (const message of call.messages) assert.ok(Number.isFinite(message.seq), 'every message carries its surface seq')
  for (const time of call.options.eventTimes) assert.ok(Number.isFinite(time), 'event times are forwarded (buildSurfaceEntries passes event.time)')
  const protectedIndex = call.messages.findIndex((message) => message.seq >= expectedUserSeq)
  assert.ok(protectedIndex >= 0, 'the protected boundary exists in the planned messages')

  // The engine recorded the event window on the archived folders (v1.4.0 §3.3.2).
  const folders = readIndexFile(memoryDir).folders
  assert.ok(folders.length >= 1, 'the archive landed')
  const metaWithTime = folders.map((folder) => readMeta(memoryDir, folder.id)).find((meta) => Number.isFinite(meta.eventStart))
  assert.ok(metaWithTime, 'meta.eventStart was recorded from event times')
  assert.equal(metaWithTime.eventTimeSource, 'messages')
  assert.ok(metaWithTime.eventEnd > metaWithTime.eventStart)
}))

// ---------------------------------------------------------------------------
// P0-3: current turn is never archived
// ---------------------------------------------------------------------------

test('a multi-step tool turn keeps the current question when compression runs mid-turn', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const session = new FakeSession({ id: 'session-mid-turn' })
  appendSystem(session)
  appendConversation(session, 20)
  appendCurrentTurn(session)
  const { ctx } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const questionSeq = session.nodes.find((seq) => session.deriveEventMessage(session.eventAt(seq))?.id === 'u-current')
  // Two pre-step compressions of the same turn (step 1 and step 2 of a tool loop).
  await plugin.compressWithEscalation(session, 21, plugin.currentConfig(), 'test')
  await plugin.compressWithEscalation(session, 21, plugin.currentConfig(), 'test')
  assert.ok(session.nodes.includes(questionSeq), 'the current question is still on the surface after mid-turn archiving')
  assert.ok(nodeHasText(session, 'CURRENT-QUESTION-MARKER'), 'the current question was never archived')
  assert.ok(nodeHasText(session, 'TOOL-OUTPUT-MARKER'), 'the same-turn tool result was never archived')
  const archived = readIndexFile(memoryDir).folders
  assert.ok(archived.length >= 1, 'earlier conversation was still archived')
  for (const folder of archived) {
    const context = JSON.parse(readFileSync(path.join(memoryDir, folder.id, 'context.json'), 'utf8'))
    const text = JSON.stringify(context.messages)
    assert.ok(!text.includes('CURRENT-QUESTION-MARKER'), 'no folder contains the current question')
    assert.ok(!text.includes('TOOL-OUTPUT-MARKER'), 'no folder contains the current tool result')
  }
  const applied = readStatsEvents(memoryDir).filter((event) => event.type === 'compress-applied')
  assert.ok(applied.length >= 1)
  assert.equal(applied[0].protectedTurn, true, 'telemetry records turn protection')
}))

test('no legal cut point -> the engine refusal is accepted (no fallback to an arbitrary cut)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const session = new FakeSession({ id: 'session-no-cut' })
  appendSystem(session)
  // Only the current turn exists: the visible conversation starts at its user message.
  appendCurrentTurn(session)
  const { ctx, capture } = makeContext(session, { totalTokensOverride: 50000 })
  const overrides = makeOverrides(memoryDir)
  overrides.compress.minMessagesToCompress = 2
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const before = session.events.length
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  assert.equal(session.events.length, before, 'no session event was appended (no archive, no checkpoint)')
  const folderCount = existsSync(path.join(memoryDir, 'index.json')) ? readIndexFile(memoryDir).folders.length : 0
  assert.equal(folderCount, 0, 'no folder was written')
  assert.ok(
    capture.logs.some(([, message]) => message.includes('protected-turn') || message.includes('no-legal-cut')),
    `the refusal reason is logged, got: ${JSON.stringify(capture.logs.slice(-5))}`,
  )
}))

test('defense in depth: an engine plan covering the current turn is refused by the adapter', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const session = new FakeSession({ id: 'session-defense' })
  appendSystem(session)
  appendConversation(session, 3)
  appendCurrentTurn(session)
  // Force the measured context above the trigger, then hand the engine a bogus
  // plan that would archive the current turn (simulates a protection regression).
  const { ctx, capture } = makeContext(session, { totalTokensOverride: 50000 })
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const engine = plugin.engineFor(session, plugin.currentConfig())
  // Simulate an engine/regression that ignores protectSeq and plans to remove a
  // prefix that reaches into the current turn.
  engine.planCompression = (messages, usedPercent) => ({
    shouldCompress: true,
    reason: 'stubbed-regression',
    usedPercent,
    totalTokens: 1000,
    usedTokens: 1000,
    targetTokens: 500,
    remove: messages.slice(0, messages.length - 1),
    keep: messages.slice(messages.length - 1),
    folders: [],
    warnings: [],
    removeChars: 100,
    removeTokens: 100,
    windowTokens: 20000,
  })
  const before = session.events.length
  await plugin.compressWithEscalation(session, 4, plugin.currentConfig(), 'test')
  assert.equal(session.events.length, before, 'nothing was archived')
  const folderCount = existsSync(path.join(memoryDir, 'index.json')) ? readIndexFile(memoryDir).folders.length : 0
  assert.equal(folderCount, 0, 'nothing was written')
  assert.ok(
    capture.logs.some(([level, message]) => level === 'warn' && message.includes('would archive the current turn')),
    `adapter refusal is logged, got: ${JSON.stringify(capture.logs.slice(-5))}`,
  )
}))

// ---------------------------------------------------------------------------
// P1-1 / P1-3: pass-0 re-archive protection and rescorePending recall exclusion
// ---------------------------------------------------------------------------

test('pass-0 re-archiving keeps the additions injected by the current turn, older ones stay removable', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  const session = new FakeSession({ id: 'session-pass0' })
  appendSystem(session)
  appendConversation(session, 14)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  await judgeAllPending(memoryDir, capture, session)
  const keyword = readIndexFile(memoryDir).folders[0].keywords[0]

  // Recall happens between turn 5 and turn 6: the additions belong to turn 6.
  plugin.resetRecallAttemptsForTurn(session, 5)
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-pass0', `${keyword} 继续确认`) })
  const state = plugin.sessionState(session)
  assert.ok(state.additions.length > 0, 'a recall block was injected')
  for (const addition of state.additions) assert.equal(addition.injectedTurn, 6, 'additions carry the injected turn')
  const injectedIds = state.additions.map((addition) => addition.id)

  const engine = plugin.engineFor(session, plugin.currentConfig())
  const deferred = plugin.rearchiveRecalledBlock(session, plugin.currentConfig(), engine, {
    totalTokens: 12000,
    usedPercent: 60,
    targetTokens: 8000,
    turn: 6,
    protectTurn: 6,
  })
  assert.equal(deferred.removedIds.length, 0, 'nothing is removed during the turn that injected it')
  assert.equal(state.additions.length, injectedIds.length, 'the injected block is intact')
  assert.ok(capture.logs.some(([, message]) => message.includes('re-archive deferred')), 'the protection is logged')
  assert.equal(readStatsEvents(memoryDir).filter((event) => event.type === 'rearchive').length, 0, 'no re-archive telemetry was written')

  // From the next turn on the same additions are removable again.
  const removed = plugin.rearchiveRecalledBlock(session, plugin.currentConfig(), engine, {
    totalTokens: 12000,
    usedPercent: 60,
    targetTokens: 8000,
    turn: 7,
    protectTurn: 7,
  })
  assert.ok(removed.removedIds.length > 0, 'older additions were re-archived')
  assert.equal(state.additions.length, injectedIds.length - removed.removedIds.length)
  for (const id of removed.removedIds) {
    assert.equal(readMeta(memoryDir, id).rescorePending, true, 'the folder is marked for re-review')
    const index = readIndexFile(memoryDir).folders.find((folder) => folder.id === id)
    assert.equal(index?.rescorePending, true, 'index entry is synced')
  }
}))

test('rescorePending folders are not immediately recalled again (P1-3 feedback loop)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFolderFixture(memoryDir, 'mem-rescored-0001', { createdAt: Date.now() - 3600_000, alpha: 0.9, keywords: ['部署', 'docker'], text: 'RESCORED-MEMORY' })
  writeFolderFixture(memoryDir, 'mem-fresh-0002', { createdAt: Date.now() - 1800_000, alpha: 0.9, keywords: ['部署', 'docker'], text: 'FRESH-MEMORY' })
  const session = new FakeSession({ id: 'session-rescore-exclude' })
  appendSystem(session)
  const { ctx } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  // Mark one folder as "just re-archived" (would otherwise match the query).
  const metaPath = path.join(memoryDir, 'mem-rescored-0001', 'meta.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  meta.rescorePending = true
  writeFileSync(metaPath, JSON.stringify(meta))
  const index = readIndexFile(memoryDir)
  index.folders.find((folder) => folder.id === 'mem-rescored-0001').rescorePending = true
  writeFileSync(path.join(memoryDir, 'index.json'), JSON.stringify(index))
  const engine = plugin.engineFor(session, plugin.currentConfig())
  if (typeof engine.reload === 'function') engine.reload()

  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-exclude', '部署 docker 现在什么情况？') })
  const state = plugin.sessionState(session)
  assert.ok(state.additions.length > 0, 'some memory was recalled')
  assert.ok(
    state.additions.every((addition) => addition.id !== 'mem-rescored-0001'),
    'the rescorePending folder is excluded from recall until it is re-judged',
  )
  assert.ok(state.additions.some((addition) => addition.id === 'mem-fresh-0002'), 'normal folders are still recalled')
}))
