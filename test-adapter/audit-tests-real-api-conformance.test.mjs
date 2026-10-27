/**
 * Audit (task-3): real-DSH-API conformance tests for the adapter half.
 *
 * The existing `test-adapter/plugin-mock.test.mjs` FakeSession is deliberately
 * lenient. This file re-implements a *strict* session that enforces the
 * invariants of the real `@deepseek-ai/dsh-session` `Session.append()` (verified
 * against the shipped DSH 0.x source extracted from `resources/app.asar`):
 *
 *   1. event seqs are contiguous;
 *   2. surface-eligible events (`system|developer|user|assistant|tool/result`)
 *      REQUIRE a `surfaceOp`; non-surface events MUST NOT carry
 *      `surfaceOp`/`sourceEventSeqs`;
 *   3. `assistant/message` may never carry `sourceEventSeqs`;
 *   4. a replace `surfaceOp` must reference current, ordered surface nodes;
 *      `sourceEventSeqs` must be non-empty, duplicate-free, reference earlier
 *      events, and cover EVERY shadowed surface node;
 *   5. surface node 0 (the system prompt) may only be rewritten by a
 *      `system/message` over exactly that node;
 *   6. only event types in the real known-event-type catalog are accepted.
 *
 * It also checks the model-facing halves the lenient mock never exercises:
 * `memory_judge`'s `output.render`, the real `agent/pre-step` waterfall calling
 * convention, and the real `tokenMeter.measure()` shape. If the plugin passes
 * here plus the existing suite, the adapter is not relying on mock leniency.
 *
 * Black-box: imports only `lib/plugin.js` (RofmPlugin) and `engine/index.js`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { RofmPlugin } from '../lib/plugin.js'
import { loadConfig, writeFolder, writeIndex } from '../engine/index.js'

const tempDirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshr-audit-api-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// --- real DSH event vocabulary (dsh-session/lib/types: KNOWN_SESSION_EVENT_TYPES)
const SURFACE_EVENT_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const KNOWN_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'developer/message',
  'system/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'request/header',
  'request/context',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'session/title',
])

function isEventSeq(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function isReplaceOp(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.keys(value).length !== 3) return false
  return value.op === 'replace' && isEventSeq(value.startSeq) && isEventSeq(value.endSeq)
}

/**
 * Strict session mirroring the real `Session.append()` validation and surface
 * fold. Every `append` is validated exactly like the shipped implementation.
 */
class StrictSession {
  constructor({ id = 'session-audit', contextWindow = 1000, header = undefined } = {}) {
    this.id = id
    this.header = header ?? { version: 4, id, createdAt: 0, isSeeded: false }
    this.events = []
    this.nodes = []
    this.replaceGeneration = 0
    this.contentGeneration = 0
    this.windowTokens = contextWindow
    /** Prices handed to the plugin for each seq by the last tokenMeter.measure(). */
    this.lastPrices = new Map()
    this.lastTotalTokens = 0
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

  snapshotEvents(fromSeq = 0, toSeqExclusive = this.seq) {
    return this.events.slice(fromSeq, toSeqExclusive)
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
        return event.data.message
      case 'tool/result':
        return event.data.message
      default:
        return null
    }
  }

  deriveMessages() {
    return this.nodes.map((seq) => this.deriveEventMessage(this.eventAt(seq))).filter((message) => message !== null)
  }

  /** The real `tokenMeter.measure()` result shape (TokenMeasurement). */
  measure() {
    const nodes = []
    const prices = new Map()
    let total = 0
    for (const seq of this.nodes) {
      const message = this.deriveEventMessage(this.eventAt(seq))
      const text = JSON.stringify(message?.content ?? '')
      const tokens = Math.max(0, Math.ceil(text.length / 4))
      nodes.push({ seq, tokens, heuristicTokens: tokens })
      prices.set(seq, tokens)
      total += tokens
    }
    this.lastPrices = prices
    this.lastTotalTokens = total
    return { logRevision: this.seq, baseline: { kind: 'none', tokens: 0 }, surfaceDeltaTokens: total, totalTokens: total, surfaceTokens: total, nodes }
  }

  // ------------------------------------------------------------------ append
  append(type, data, options = {}) {
    // (6) only the real known vocabulary may be persisted by a plugin.
    if (!KNOWN_EVENT_TYPES.has(type)) throw new Error(`unknown session event type "${type}"`)

    const seq = this.events.length
    const isSurface = SURFACE_EVENT_TYPES.has(type)
    const rawSurfaceOp = options.surfaceOp
    const rawSources = options.sourceEventSeqs

    // (2) surface-eligible events require surfaceOp; non-surface must not carry it.
    if (isSurface && rawSurfaceOp === undefined) throw new Error(`surface event "${type}" requires a surfaceOp marker`)
    if (!isSurface && rawSurfaceOp !== undefined) throw new Error(`session event "${type}" is not surface-eligible and cannot carry surfaceOp`)
    if (!isSurface && rawSources !== undefined) throw new Error(`session event "${type}" is not surface-eligible and cannot carry sourceEventSeqs`)
    // (3) assistant messages embed their stream and never cite sources.
    if (type === 'assistant/message' && rawSources !== undefined) throw new Error('assistant/message cannot carry sourceEventSeqs')

    let replaceRange
    if (isSurface) {
      if (rawSurfaceOp !== 'append' && !isReplaceOp(rawSurfaceOp)) throw new Error(`surface event "${type}" carries an invalid replace surfaceOp`)
    }

    // Per-event payload shape checks that the real validator enforces.
    if (type === 'user/message' && data?.role !== 'user') throw new Error('user/message data must be a user message')
    if (type === 'assistant/message' && data?.message?.role !== 'assistant') throw new Error('assistant/message needs an assistant message')
    if (type === 'system/message' && data?.message?.role !== 'system') throw new Error('system/message needs a system message')
    if (type === 'developer/message' && data?.message?.role !== 'developer') throw new Error('developer/message needs a developer message')
    if (type === 'tool/result' && data?.message?.role !== 'tool') throw new Error('tool/result needs a tool message')

    if (rawSurfaceOp !== 'append' && rawSurfaceOp !== undefined) {
      if (rawSurfaceOp.startSeq >= seq || rawSurfaceOp.endSeq >= seq) throw new Error('surface replace must reference earlier events')
      const startIdx = this.nodes.indexOf(rawSurfaceOp.startSeq)
      const endIdx = this.nodes.indexOf(rawSurfaceOp.endSeq)
      if (startIdx < 0) throw new Error(`surface replace start ${rawSurfaceOp.startSeq} not on surface`)
      if (endIdx < 0) throw new Error(`surface replace end ${rawSurfaceOp.endSeq} not on surface`)
      if (startIdx > endIdx) throw new Error('surface replace start after end')
      const shadowed = this.nodes.slice(startIdx, endIdx + 1)
      // (4) sourceEventSeqs: non-empty, unique, earlier, cover every shadowed node.
      if (!Array.isArray(rawSources) || rawSources.length === 0) throw new Error('surface replace requires non-empty sourceEventSeqs')
      const sources = new Set()
      for (const source of rawSources) {
        if (!isEventSeq(source)) throw new Error('sourceEventSeqs must be non-negative integers')
        if (source >= seq) throw new Error('sourceEventSeqs must reference earlier events')
        if (sources.has(source)) throw new Error('sourceEventSeqs must not contain duplicates')
        sources.add(source)
      }
      for (const shadowedSeq of shadowed) {
        if (!sources.has(shadowedSeq)) throw new Error(`surface replace: sourceEventSeqs must include shadowed node ${shadowedSeq}`)
      }
      // (5) node 0 (system prompt) protection.
      if (startIdx === 0 && this.events[this.nodes[0]]?.type === 'system/message') {
        if (type !== 'system/message' || shadowed.length !== 1) {
          throw new Error('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node')
        }
      }
      replaceRange = { startIdx, endIdx, shadowed }
    }

    const event = {
      type,
      seq,
      time: seq,
      data,
      ...(rawSources === undefined ? {} : { sourceEventSeqs: [...rawSources] }),
      ...(rawSurfaceOp === undefined ? {} : { surfaceOp: rawSurfaceOp }),
    }
    this.events.push(event)
    if (isSurface) {
      if (rawSurfaceOp === 'append') {
        this.nodes.push(seq)
      } else {
        this.nodes.splice(replaceRange.startIdx, replaceRange.endIdx - replaceRange.startIdx + 1, seq)
        this.replaceGeneration += 1
      }
      this.contentGeneration += 1
    }
    return event
  }
}

// --- real `agent` shape: Agent has `.session` (dsh-agent.js uses agent.session.requestHeader()) ---
function agentFor(session) {
  return { id: session.id, session }
}

function userMessage(id, text, sourceKind = 'user') {
  return { id, role: 'user', source: { kind: sourceKind }, content: [{ type: 'text', text }] }
}
function assistantMessage(id, text) {
  return { id, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text }] }
}
function systemMessage(id, text) {
  return { id, role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] }
}

function pluginContext(session) {
  const handlers = new Map()
  const capture = { sections: [], tools: [], logs: [] }
  const ctx = {
    logger: {
      info: (message) => capture.logs.push(['info', String(message)]),
      warn: (message) => capture.logs.push(['warn', String(message)]),
      debug: (message) => capture.logs.push(['debug', String(message)]),
    },
    tokenMeter: { measure: () => session.measure() },
    systemPrompt: {
      section(section) {
        capture.sections.push(section)
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
      return callback()
    },
    get(name) {
      if (name === 'systemPrompt') return this.systemPrompt
      if (name === 'tokenMeter') return this.tokenMeter
      if (name === 'tools') return this.tools
      return undefined
    },
    tools: {
      register(definition) {
        capture.tools.push(definition)
        return () => {}
      },
    },
    /** Real Waterfall dispatch convention: listener(payload, next). */
    async waterfall(name, payload, next) {
      let call = next
      for (const handler of [...(handlers.get(name) ?? [])].reverse()) {
        const downstream = call
        call = () => handler(payload, downstream)
      }
      return call()
    },
    emit(name, payload) {
      for (const handler of handlers.get(name) ?? []) handler(payload)
    },
    handlerNames() {
      return [...handlers.keys()]
    },
  }
  return { ctx, capture }
}

function overridesFor(memoryDir, patch = {}) {
  return {
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
    recall: { seed: 7, probabilityScale: 1000, firstGenMax: 10, applyToSubagents: true, applyToMainSessions: true, triggerSourceKinds: ['user'] },
    importance: { min: 0.01, max: 1, warnAbove: 0.8 },
    keywords: { min: 3, max: 8 },
    storage: { dir: memoryDir, perSession: false },
    logging: { enabled: true, verbose: true },
    ...patch,
  }
}

/** One standard archivable conversation with a pinned system prompt at node 0. */
function buildConversation(session, turns = 14) {
  session.append('system/message', { turn: 1, step: 1, message: systemMessage('sys-1', 'SYSTEM PROMPT: you are a helpful assistant.') }, { surfaceOp: 'append' })
  for (let index = 0; index < turns; index += 1) {
    session.append('turn/start', { turn: index + 1 })
    session.append('user/message', userMessage(`u-${index}`, `第${index}轮：继续讨论部署 docker 端口配置与数据库迁移，参数编号 ${index}。`), { surfaceOp: 'append' })
    session.append(
      'assistant/message',
      { turn: index + 1, step: 1, message: assistantMessage(`a-${index}`, `好的，第 ${index} 轮我记录一下 docker 端口和部署参数。`), stream: [] },
      { surfaceOp: 'append' },
    )
    session.append('turn/end', { turn: index + 1, reason: { kind: 'completed' } })
  }
}

function archive(session, memoryDir) {
  const { ctx, capture } = pluginContext(session)
  const plugin = new RofmPlugin(ctx, overridesFor(memoryDir))
  plugin.start()
  return { plugin, ctx, capture }
}

// ---------------------------------------------------------------------------
// 1. The archive path must emit a session log the real Session would accept,
//    with the exact shadow-price protocol the real token meter relies on.
// ---------------------------------------------------------------------------
test('conformance: archive emits only real-Session-legal events and a legal compaction bracket', async () => {
  await (async () => {
    const memoryDir = path.join(tempDir(), 'memory')
    const session = new StrictSession({ contextWindow: 1000 })
    buildConversation(session, 14)
    const { plugin } = archive(session, memoryDir)

    const before = session.nodes.length
    await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')

    const compactionStarts = session.events.filter((event) => event.type === 'compaction/start')
    assert.ok(compactionStarts.length >= 1, 'the archive must use the host compaction bracket')
    // There is exactly one removable span by config; assert its protocol.
    const start = compactionStarts[0]
    const summary = session.events.find((event) => event.type === 'compaction/summary')
    const end = session.events.find((event) => event.type === 'compaction/end')
    assert.ok(summary && end, 'compaction/start must be followed by summary and end')
    const checkpoint = session.events.find((event) => event.type === 'user/message' && event.surfaceOp !== 'append' && event.data?.source?.kind === 'compact-checkpoint')
    assert.ok(checkpoint, 'the removed span must be replaced by a compact-checkpoint user message')

    // Protocol order: start < summary < replacement < end.
    assert.ok(start.seq < summary.seq && summary.seq < checkpoint.seq && checkpoint.seq < end.seq)
    // The real compaction bracket carries the same compactionId on every event.
    assert.equal(typeof start.data.compactionId, 'string')
    assert.equal(summary.data.compactionId, start.data.compactionId)
    assert.equal(end.data.compactionId, start.data.compactionId)
    assert.equal(checkpoint.data.source.compactionId, start.data.compactionId)
    // The summary is a model-visible content-block list, and it is the note.
    assert.ok(Array.isArray(summary.data.summary) && summary.data.summary[0]?.type === 'text')
    assert.match(summary.data.summary[0].text, /^\[memory\] /)
    // The real token meter arms a shadow claim on compaction/summary and consumes
    // it on the IMMEDIATELY following event: any event in between is a contract
    // violation that makes the real meter throw.
    assert.equal(summary.seq + 1, checkpoint.seq, 'compaction/summary must be immediately adjacent to its surface replace')
    assert.equal(checkpoint.surfaceOp.op, 'replace')
    assert.equal(summary.data.shadowedRange.start, checkpoint.surfaceOp.startSeq)
    assert.equal(summary.data.shadowedRange.end, checkpoint.surfaceOp.endSeq)
    assert.deepEqual([...summary.data.shadowedSeqs].sort((a, b) => a - b), [...summary.data.shadowedSeqs])
    // Shadowed count must be the fixed-estimator price of exactly those nodes.
    let expected = 0
    for (const seq of summary.data.shadowedSeqs) {
      const message = session.deriveEventMessage(session.eventAt(seq))
      expected += Math.max(0, Math.ceil(JSON.stringify(message?.content ?? '').length / 4))
    }
    assert.equal(summary.data.shadowedTokenCount, expected, 'shadowedTokenCount must match the heuristic price of the shadowed range')
    // The system prompt at node 0 stays pinned.
    assert.equal(session.eventAt(session.nodes[0]).type, 'system/message')
    assert.ok(session.nodes.length < before, 'the surface really shrank')

    // Whole log revalidates against the real surface rules (append already did,
    // this re-walks the logged events to catch post-hoc mutation).
    const replay = new StrictSession({ contextWindow: 1000 })
    for (const event of session.events) {
      replay.append(event.type, event.data, {
        ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
        ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
      })
    }
    assert.deepEqual(replay.nodes, session.nodes)
  })()
})

// ---------------------------------------------------------------------------
// 2. memory_judge must be a complete real ToolDefinition (output.render is the
//    only path the real host uses to turn the value into content blocks).
// ---------------------------------------------------------------------------
test('conformance: memory_judge is a complete real ToolDefinition and output.render works', async () => {
  const memoryDir = path.join(tempDir(), 'memory')
  const session = new StrictSession({ contextWindow: 1000 })
  buildConversation(session, 14)
  const { plugin, capture } = archive(session, memoryDir)
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  assert.equal(capture.tools.length, 3, 'memory_judge + memory_recall + memory_image definitions are registered')
  const definition = capture.tools.find((entry) => entry.name === 'memory_judge')
  assert.ok(definition, 'memory_judge is registered')

  // ToolDefinition required members (real @deepseek-ai tools contract).
  for (const key of ['name', 'description', 'parameters', 'output', 'execute']) {
    assert.notEqual(definition[key], undefined, `ToolDefinition.${key} is required by the real tools service`)
  }
  assert.equal(definition.name, 'memory_judge')
  assert.equal(definition.parameters.type, 'object')
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(definition.output.schema.type, 'object')
  assert.equal(typeof definition.timeoutMs, 'number')
  assert.equal(definition.isConcurrencySafe(), false)

  // Judge the pending folders exactly like the host would (execute returns value).
  const { readdirSync } = await import('node:fs')
  const { readFileSync } = await import('node:fs')
  const index = JSON.parse(readFileSync(path.join(memoryDir, 'index.json'), 'utf8'))
  const pendingIds = index.folders.filter((entry) => entry.scored === false).map((entry) => entry.id)
  assert.ok(pendingIds.length >= 1)
  const args = {
    updates: pendingIds.map((id) => ({ id, alpha: 0.5, beta: 2, keywords: ['部署', 'docker', '端口'] })),
  }
  const value = await definition.execute(args, { agent: agentFor(session) })
  assert.equal(value.updated.length, pendingIds.length)

  // The real host ONLY renders through output.render; a broken renderer would
  // hand the model an empty/undefined tool result while the mock suite passes.
  const rendered = definition.output.render(args, value)
  assert.ok(Array.isArray(rendered) && rendered.length > 0, 'output.render must return content blocks')
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, new RegExp(`已更新 ${pendingIds.length} 条`))
  // Degenerate value never throws (renderer is called with exactly the stored value).
  const emptyRender = definition.output.render({ updates: [] }, { updated: [], kept: [], rejected: [] })
  assert.match(emptyRender[0].text, /^已更新 0 条/)
  assert.ok(readdirSync(memoryDir).includes('index.json'))
})

// ---------------------------------------------------------------------------
// 3. agent/pre-step is a real waterfall: the decision must preserve the
//    downstream {kind:'enter', messages} object. Recall is injected as a durable
//    surface history message (earliest position), so no request-series flag is
//    produced.
// ---------------------------------------------------------------------------
test('conformance: pre-step waterfall preserves the decision and requests a new series for recall injection', async () => {
  const memoryDir = path.join(tempDir(), 'memory')
  const session = new StrictSession({ contextWindow: 1000 })
  const { ctx } = pluginContext(session)
  const cfg = overridesFor(memoryDir)
  const { writeFolder: wf, writeIndex: wi } = { writeFolder, writeIndex }
  wf(memoryDir, {
    id: 'mem-scored',
    meta: { createdAt: 1_700_000_000_000, alpha: 0.6, beta: 1.5, keywords: ['部署', 'docker', '端口'], title: 'T' },
    messages: [{ role: 'user', content: '部署 docker 端口配置' }],
  })
  wi(memoryDir, { ...loadConfig(), memoryDir }, { version: 1, folders: [{ id: 'mem-scored', createdAt: 1_700_000_000_000, alpha: 0.6, beta: 1.5, keywords: ['部署', 'docker', '端口'], title: 'T' }] })

  const plugin = new RofmPlugin(ctx, cfg)
  plugin.start()
  assert.ok(ctx.handlerNames().includes('agent/inbox/inserted'))
  assert.ok(ctx.handlerNames().includes('agent/pre-step'))

  // A real user inbox message triggers recall (source.kind === 'user').
  ctx.emit('agent/inbox/inserted', { agent: agentFor(session), message: userMessage('u-real', '部署 docker 端口 8080 怎么配置？') })

  const downstreamMessages = [userMessage('u-real', '部署 docker 端口 8080 怎么配置？')]
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent: agentFor(session), messages: downstreamMessages, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: downstreamMessages }),
  )
  // Real PreStepDecision: {kind:'enter', messages: UserMessage[]}
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages, downstreamMessages, 'downstream messages must be preserved')
  // The recall block is a system-prompt section again (v1.1 layout): after a new
  // injection the host must rewrite the head system node instead of appending an
  // in-history system update, so the decision declares a new request series.
  assert.equal(decision.startsRequestSeries, true, 'recall injection must force a new request series')

  // The flag is consumed once: the next step of the same turn must not repeat it.
  const second = await ctx.waterfall(
    'agent/pre-step',
    { agent: agentFor(session), messages: downstreamMessages, turn: 1, step: 2, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: downstreamMessages }),
  )
  assert.equal(second.kind, 'enter')
  assert.equal(second.startsRequestSeries, undefined)

  // A downstream reject is returned untouched (waterfall contract).
  const reject = await ctx.waterfall(
    'agent/pre-step',
    { agent: agentFor(session), messages: [], turn: 1, step: 3, signal: new AbortController().signal },
    async () => ({ kind: 'reject' }),
  )
  assert.deepEqual(reject, { kind: 'reject' })
})

// ---------------------------------------------------------------------------
// 4. Hostile session ids must never escape the per-session memory directory.
// ---------------------------------------------------------------------------
test('conformance: session ids cannot escape the per-session memory directory', () => {
  const base = path.join(tempDir(), 'memory')
  const session = new StrictSession({ contextWindow: 1000 })
  const { ctx } = pluginContext(session)
  const plugin = new RofmPlugin(ctx, overridesFor(base, { storage: { dir: base, perSession: true } }))
  const cfg = plugin.currentConfig()
  const hostileIds = ['../../evil', '..', '../..', 'a/b', 'a\\\\b', '.hidden', '_leading', 'C:\\\\Windows\\\\System32', '会话-一', '', '   ', 'x'.repeat(300)]
  for (const id of hostileIds) {
    const dir = plugin.sessionMemoryDir(cfg, { id })
    const relative = path.relative(base, dir)
    assert.ok(!relative.startsWith('..'), `session id ${JSON.stringify(id)} escaped the memory root: ${dir}`)
    assert.ok(!path.isAbsolute(relative), 'the session dir must stay relative to the memory root')
    assert.equal(relative.split(path.sep)[0], 'sessions', `session id ${JSON.stringify(id)} must land under sessions/`)
  }
  // Sanitised ids remain distinct filesystem segments (no separators created).
  const weird = plugin.sessionMemoryDir(cfg, { id: '../../evil' })
  assert.equal(path.basename(weird).includes('/'), false)
  assert.equal(path.basename(weird).includes('\\'), false)
})

// ---------------------------------------------------------------------------
// Self-check: the strict session must have TEETH. If it silently accepted the
// lenient patterns the existing FakeSession allows, the conformance tests above
// would prove nothing.
// ---------------------------------------------------------------------------
test('self-check: the strict session rejects every pattern the lenient mock allows', () => {
  const appendSurface = (session, data) => session.append('user/message', data, { surfaceOp: 'append' })
  const message = userMessage('u-1', 'hello')

  // 1. Surface event without a surfaceOp marker.
  assert.throws(() => new StrictSession().append('user/message', message), /requires a surfaceOp/)
  // 2. Non-surface event carrying surface metadata.
  assert.throws(() => new StrictSession().append('turn/start', { turn: 1 }, { surfaceOp: 'append' }), /not surface-eligible/)
  // 3. assistant/message may not cite source events.
  {
    const session = new StrictSession()
    assert.throws(
      () =>
        session.append(
          'assistant/message',
          { turn: 1, step: 1, message: assistantMessage('a-1', 'x'), stream: [] },
          { surfaceOp: 'append', sourceEventSeqs: [0] },
        ),
      /cannot carry sourceEventSeqs/,
    )
  }
  // 4. Replace whose sourceEventSeqs miss a shadowed node.
  {
    const session = new StrictSession()
    appendSurface(session, message)
    appendSurface(session, userMessage('u-2', 'second'))
    assert.throws(
      () => session.append('user/message', userMessage('u-3', 'cut'), { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, sourceEventSeqs: [0] }),
      /must include shadowed node 1/,
    )
  }
  // 5. Replace of the node-0 system prompt by a non-system message.
  {
    const session = new StrictSession()
    session.append('system/message', { turn: 1, step: 1, message: systemMessage('sys', 'prompt') }, { surfaceOp: 'append' })
    assert.throws(
      () => session.append('user/message', userMessage('u-x', 'hijack'), { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] }),
      /node 0 holds the system prompt/,
    )
  }
  // 6. Unknown event vocabulary.
  assert.throws(() => new StrictSession().append('my-plugin/event', {}), /unknown session event type/)
  // 7. Empty sourceEventSeqs.
  {
    const session = new StrictSession()
    appendSurface(session, message)
    assert.throws(
      () => session.append('user/message', userMessage('u-empty', 'x'), { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [] }),
      /non-empty sourceEventSeqs/,
    )
  }
})
