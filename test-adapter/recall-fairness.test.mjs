/**
 * Adapter-level fair recall tests (v1.4.0 FAIR-DRI, contract §5.7 / §6).
 *
 * These exercise the *adapter* wiring of the deterministic selector:
 *   - the automatic recall path passes `lanes/round/blockIds/ledger`, replaces the
 *     lane state from `result.lanes` and persists recall-state.json v3;
 *   - G1: a high-α memory matched by a normal query appears in the first round;
 *   - §3.2.4: priority block trim (engine `trimBlock`) evicts low-α first, pins
 *     high-α, honours `maxWindowPercent`, fills the recycle lanes and never
 *     removes ids from the ledger (G3);
 *   - G4: an evicted memory is not re-injected before the recycle cooldown;
 *   - lane telemetry (`lanesPicked/pops/registerDrops/degraded`) and the
 *     adapter-side `recall-block` event are persisted;
 *   - determinism across a restart: 60 rounds of picks are identical with and
 *     without a plugin restart at round 20 (recall-state v3 round-trip).
 *
 * The fake host mirrors `plugin-mock.test.mjs`, but uses the fair default path and
 * a realistic 200k-token window. `recall-fairness.test.mjs` covers the lane
 * guarantees; `recall-deterministic.test.mjs` covers deterministic mode,
 * legacy rollback, v2→v3 migration, pagination and time windows.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RofmPlugin } from '../lib/plugin.js'
import { emptyLanes } from '../engine/index.js'

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const clone = (value) => JSON.parse(JSON.stringify(value))

class FakeSession {
  constructor({ contextWindow = 200000, header = { origin: 'main' }, id = 'session-fair' } = {}) {
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
      time: Date.now(),
      data: clone(data),
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

function makeMeter(session, capture) {
  return () => {
    const nodes = session.nodes.map((seq) => {
      const message = session.deriveEventMessage(session.eventAt(seq))
      const text = JSON.stringify(message?.content ?? '')
      const tokens = Math.max(0, Math.ceil(text.length / 4))
      return { seq, tokens, heuristicTokens: tokens }
    })
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

function makeContext(session) {
  const capture = { sections: [], tools: [], logs: [] }
  const toolsService = { register(definition) { capture.tools.push({ definition, disposed: false }); return () => {} } }
  const ctx = {
    logger: {
      info: (message) => capture.logs.push(['info', String(message)]),
      warn: (message) => capture.logs.push(['warn', String(message)]),
      debug: (message) => capture.logs.push(['debug', String(message)]),
    },
    tokenMeter: { measure: makeMeter(session, capture) },
    systemPrompt: { section(options) { capture.sections.push(options); return () => {} } },
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
    compress: { enabled: false },
    scoring: { includeLegacy: true },
    recall: {
      mode: 'fair',
      firstGenMax: 10,
      maxRecalledBlocks: 64,
      maxRecalledChars: 120000,
      maxWindowPercent: 10,
      persistInjected: true,
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
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-fair-'))
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

function readStatsEvents(memoryDir) {
  const file = path.join(memoryDir, 'stats.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** Write one already-scored memory folder + index entry. */
function writeFolder(memoryDir, id, options = {}) {
  const {
    alpha = 0.5,
    beta = 0,
    keywords = ['fixture'],
    text = `CONTENT-${id}`,
    createdAt = Date.now(),
    chars = undefined,
    eventStart = undefined,
    eventEnd = undefined,
  } = options
  const dir = path.join(memoryDir, id)
  mkdirSync(dir, { recursive: true })
  const messages = [{ role: 'user', content: text }]
  const meta = {
    version: 1,
    id,
    createdAt,
    alpha,
    beta,
    keywords,
    title: text.slice(0, 40),
    scored: true,
    stats: { messages: 1, chars: Number.isFinite(chars) ? chars : text.length, tokens: 10 },
  }
  if (Number.isFinite(eventStart)) {
    meta.eventStart = eventStart
    meta.eventTimeSource = 'messages'
  }
  if (Number.isFinite(eventEnd)) meta.eventEnd = eventEnd
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify({ version: 1, id, createdAt, messages }))
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
  let index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  try {
    index = JSON.parse(readFileSync(path.join(memoryDir, 'index.json'), 'utf8'))
  } catch {
    index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  }
  index.folders = (index.folders ?? []).filter((folder) => folder.id !== id)
  const entry = {
    id,
    createdAt,
    alpha,
    beta,
    keywords,
    chars: Number.isFinite(chars) ? chars : text.length,
    tokens: 10,
    messageCount: 1,
    title: text.slice(0, 40),
    scored: true,
  }
  if (Number.isFinite(eventStart)) {
    entry.eventStart = eventStart
    entry.eventTimeSource = 'messages'
  }
  if (Number.isFinite(eventEnd)) entry.eventEnd = eventEnd
  index.folders.push(entry)
  writeFileSync(path.join(memoryDir, 'index.json'), JSON.stringify(index))
}

/** Build one live recall addition from a fixture folder (needs `chars`/`messages`). */
function additionOf(folder, memoryDir) {
  const meta = JSON.parse(readFileSync(path.join(memoryDir, folder.id, 'meta.json'), 'utf8'))
  const context = JSON.parse(readFileSync(path.join(memoryDir, folder.id, 'context.json'), 'utf8'))
  return {
    id: folder.id,
    generation: 1,
    alpha: Number(meta.alpha) || 0,
    beta: Number(meta.beta) || 0,
    chars: Number(meta.stats?.chars) || 0,
    tokens: Number(meta.stats?.tokens) || 0,
    meta,
    messages: context.messages,
  }
}

function recallBlock(capture, session) {
  const section = capture.sections.find((item) => item.name === 'dsh-rofm:recall')
  return section ? section.text({ agent: { session } }) : ''
}

// ---------------------------------------------------------------------------
// G1: a high-α memory matched by a normal query is visible in round 1
// ---------------------------------------------------------------------------

test('G1: high-α memory is injected in the first fair round in every trial', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const base = Date.now() - 3600_000
  writeFolder(memoryDir, 'mem-target-high', { alpha: 0.95, keywords: ['星港', '端口'], createdAt: base, text: 'TARGET-HIGH-ALPHA-CONTENT' })
  for (let index = 0; index < 40; index += 1) {
    writeFolder(memoryDir, `mem-distractor-${String(index).padStart(2, '0')}`, {
      alpha: 0.1,
      keywords: ['星港', '端口'],
      createdAt: base + 1 + index,
      text: `DISTRACTOR-${index}`,
    })
  }
  for (let trial = 0; trial < 10; trial += 1) {
    // Fresh block + lane state per trial (a "new session" on the same memory).
    rmSync(path.join(memoryDir, 'recall-state.json'), { force: true })
    const session = new FakeSession({ id: `session-high-${trial}` })
    const { ctx } = makeContext(session)
    const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
    plugin.start()
    plugin.onInboxInserted({ agent: { session }, message: userMessage(`u-trial-${trial}`, '星港 端口 继续确认一下') })
    const ids = plugin.sessionState(session).additions.map((addition) => addition.id)
    assert.ok(ids.includes('mem-target-high'), `trial ${trial}: high-α target must be injected in round 1 (got ${ids.join(',')})`)
  }
}))

// ---------------------------------------------------------------------------
// §3.2.4: priority block trim (high-α pin, low-α first, recycle lanes, ledger)
// ---------------------------------------------------------------------------

test('priority trim evicts low-α entries first and never a high-α one while a low-α exists', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  for (let index = 0; index < 60; index += 1) {
    writeFolder(memoryDir, `mem-low-${String(index).padStart(2, '0')}`, {
      alpha: 0.1,
      keywords: ['部署'],
      createdAt: Date.now() - 60_000 - index,
      text: `LOW-${index}`,
    })
  }
  for (let index = 0; index < 10; index += 1) {
    writeFolder(memoryDir, `mem-high-${String(index).padStart(2, '0')}`, {
      alpha: 0.9,
      keywords: ['部署'],
      createdAt: Date.now() - 120_000 - index,
      text: `HIGH-${index}`,
    })
  }
  const session = new FakeSession({ id: 'session-pin' })
  const { ctx } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir, { recall: { ...makeOverrides(memoryDir).recall, maxRecalledBlocks: 66 } }))
  plugin.start()
  const engine = plugin.engineFor(session, plugin.currentConfig())
  const folders = readIndexFile(memoryDir).folders
  const state = plugin.sessionState(session)
  state.additions = folders.map((folder) => additionOf(folder, memoryDir))
  state.recalledIds = new Set(folders.map((folder) => folder.id))
  state.ledger = folders.map((folder) => folder.id)
  state.round = 3
  state.lastCandidateIds = null
  const ledgerBefore = state.ledger.slice()
  const trimmed = plugin.trimRecallBlock(session, state, plugin.currentConfig(), engine)
  assert.equal(trimmed.droppedBlocks, 4, 'exactly the over-cap entries are evicted')
  assert.equal(state.additions.length, 66)
  const keptHigh = state.additions.filter((addition) => addition.id.startsWith('mem-high-')).map((addition) => addition.id)
  const keptLow = state.additions.filter((addition) => addition.id.startsWith('mem-low-')).map((addition) => addition.id)
  assert.equal(keptHigh.length, 10, 'high-α pin: all 10 high-α memories stay in the block')
  assert.equal(keptLow.length, 56, 'only low-α memories were evicted')
  for (const evicted of trimmed.evicted) assert.equal(evicted.high, false, 'evicted entries are low-α')
  for (const evicted of trimmed.evicted) assert.equal(state.recalledIds.has(evicted.id), false, 'evicted ids leave recalledIds')
  assert.deepEqual(state.ledger, ledgerBefore, 'G3: eviction never removes ids from the ledger')
  assert.equal(state.ledger.length, 70, 'the ledger keeps every surfaced id')
  assert.ok(Array.isArray(state.lanes.recycle) && state.lanes.recycle.length === 4, 'evicted low-α entries enter the recycle lane')
  for (const entry of state.lanes.recycle) assert.equal(entry.eligibleRound, 3 + 15, 'recycle cooldown is recorded')
  assert.equal(existsSync(path.join(memoryDir, 'recall-state.json')), false, 'trim itself does not persist (the recall path does)')
}))

test('priority trim honours maxWindowPercent (window share of the block chars)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  for (let index = 0; index < 5; index += 1) {
    writeFolder(memoryDir, `mem-big-${index}`, {
      alpha: 0.2 + index * 0.05,
      keywords: ['大块'],
      createdAt: Date.now() - 10_000 - index,
      text: `BIG-${index}`,
      chars: 5000,
    })
  }
  const session = new FakeSession({ id: 'session-window-trim', contextWindow: 20000 })
  const { ctx } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const engine = plugin.engineFor(session, plugin.currentConfig())
  const state = plugin.sessionState(session)
  state.additions = readIndexFile(memoryDir).folders.map((folder) => additionOf(folder, memoryDir))
  state.recalledIds = new Set(state.additions.map((addition) => addition.id))
  state.round = 1
  const trimmed = plugin.trimRecallBlock(session, state, plugin.currentConfig(), engine)
  const keptChars = plugin.recallBlockChars(state.additions)
  // windowTokens=20000, maxWindowPercent=10 → 8000-char cap (≈4 chars/token).
  assert.ok(keptChars <= 8000, `block chars ${keptChars} stay under window*maxWindowPercent`)
  assert.ok(trimmed.droppedBlocks > 0, 'entries were evicted to satisfy the window share')
  assert.ok(state.additions.length >= 1, 'at least one entry always stays in the block')
}))

test('G4: an evicted memory is not re-injected before the recycle cooldown', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // The alpha memory has the lower α, so the priority trim evicts it (not the
  // newer beta one) once the block cap is exceeded.
  writeFolder(memoryDir, 'mem-alpha-0001', { alpha: 0.4, keywords: ['alpha'], createdAt: Date.now() - 6000, text: 'ALPHA-CONTENT' })
  writeFolder(memoryDir, 'mem-beta-0002', { alpha: 0.6, keywords: ['beta'], createdAt: Date.now() - 5000, text: 'BETA-CONTENT' })
  const session = new FakeSession({ id: 'session-recycle' })
  const { ctx } = makeContext(session)
  // maxRecalledBlocks=1 forces every new injection to evict the lowest-α entry.
  const overrides = makeOverrides(memoryDir, { recall: { ...makeOverrides(memoryDir).recall, maxRecalledBlocks: 1 } })
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const state = plugin.sessionState(session)
  const engine = plugin.engineFor(session, plugin.currentConfig())
  /** Engine picks per round (before the adapter's block trim). */
  const picksByRound = new Map()
  const originalRecall = engine.recall.bind(engine)
  engine.recall = (text, stats, options) => {
    const result = originalRecall(text, stats, options)
    picksByRound.set(Number(state.round) + 1, (result.additions ?? []).map((addition) => addition.id))
    return result
  }

  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-rec-1', 'alpha 是什么？') })
  assert.ok(picksByRound.get(1)?.includes('mem-alpha-0001'), 'round 1 injects the alpha memory')
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-rec-2', 'beta 是什么？') })
  assert.ok(picksByRound.get(2)?.includes('mem-beta-0002'), 'round 2 injects the beta memory')
  assert.ok(!state.additions.some((addition) => addition.id === 'mem-alpha-0001'), 'the lower-α alpha memory was trimmed out of the block')
  const recycleEntry = (state.lanes.recycle ?? []).find((entry) => entry.id === 'mem-alpha-0001')
  assert.ok(recycleEntry, 'the evicted alpha memory entered the recycle lane')
  assert.equal(recycleEntry.eligibleRound, 2 + 15, 'cooldown recorded on the lane entry')

  let round = Number(state.round)
  while (round < recycleEntry.eligibleRound - 1) {
    round += 1
    plugin.onInboxInserted({ agent: { session }, message: userMessage(`u-cool-${round}`, 'alpha 再查一下？') })
    assert.ok(
      !picksByRound.get(round)?.includes('mem-alpha-0001'),
      `round ${round}: alpha must not be re-injected before the cooldown`,
    )
  }
  // The next round reaches eligibleRound: the recycle lane injects it again.
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-reinject', 'alpha 可以回来了吗？') })
  assert.ok(
    picksByRound.get(round + 1)?.includes('mem-alpha-0001'),
    `round ${round + 1}: alpha is re-injected after the cooldown`,
  )
}))

// ---------------------------------------------------------------------------
// telemetry + recall-state v3 shape
// ---------------------------------------------------------------------------

test('fair recall writes lane telemetry and the adapter recall-block event', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const base = Date.now() - 3600_000
  for (let index = 0; index < 120; index += 1) {
    writeFolder(memoryDir, `mem-gw-${String(index).padStart(3, '0')}`, {
      alpha: 0.7 + (index % 5) * 0.05,
      keywords: ['网关', '接口'],
      createdAt: base + index,
      text: `GATEWAY-${index}`,
    })
  }
  for (let index = 0; index < 20; index += 1) {
    writeFolder(memoryDir, `mem-gw-low-${String(index).padStart(2, '0')}`, {
      alpha: 0.05,
      keywords: ['网关', '接口'],
      createdAt: base + 1000 + index,
      text: `GATEWAY-LOW-${index}`,
    })
  }
  const session = new FakeSession({ id: 'session-lanes' })
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-gw-1', '网关 接口 现在什么情况？') })
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-gw-2', '网关 接口 再确认一下') })
  const events = readStatsEvents(memoryDir)
  const recalls = events.filter((event) => event.type === 'recall')
  assert.equal(recalls.length, 2, 'the engine writes one recall event per round')
  for (const event of recalls) {
    assert.equal(event.mode, 'fair', 'mode is recorded')
    assert.equal(typeof event.candidates, 'number')
    assert.ok(event.lanesPicked && typeof event.lanesPicked === 'object', 'lanesPicked is recorded')
    assert.equal(typeof event.pops, 'number')
    assert.equal(typeof event.registerDrops, 'number')
    assert.equal(typeof event.reInjections, 'number')
    assert.equal(typeof event.degraded, 'boolean')
    assert.equal(typeof event.timeFiltered, 'number')
    assert.ok(Array.isArray(event.added) && event.added.length > 0)
    const laneOfAdded = event.added.map((item) => item.lane).filter(Boolean)
    assert.ok(laneOfAdded.length > 0, 'each added memory carries its lane')
  }
  const blockEvents = events.filter((event) => event.type === 'recall-block')
  assert.equal(blockEvents.length, 2, 'the adapter writes a recall-block event per injection')
  const block = blockEvents.at(-1)
  assert.ok(Number.isFinite(block.blockBefore) && Number.isFinite(block.blockAfter), 'blockBefore/blockAfter recorded')
  assert.ok(Number.isFinite(block.blockCharsAfter))
  assert.ok(Number.isFinite(block.pinnedHigh))
  assert.ok(Number.isFinite(block.evicted))
  assert.equal(block.mode, 'fair')
  assert.ok(block.round >= 1, 'the adapter recall-block event records the round')
  assert.ok(block.lanesPicked && typeof block.lanesPicked === 'object')
  // The recall log carries the lane distribution for host-side debugging.
  assert.ok(capture.logs.some(([, message]) => message.includes('lanes={')), JSON.stringify(capture.logs.slice(-3)))
  assert.ok(capture.logs.some(([, message]) => message.includes('block ')), 'block sizes are logged')
}))

test('fair recall persists recall-state v3 with lanes/round/ledger/counters', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const base = Date.now() - 3600_000
  for (let index = 0; index < 12; index += 1) {
    writeFolder(memoryDir, `mem-state-${String(index).padStart(2, '0')}`, { alpha: 0.4 + index * 0.04, keywords: ['状态'], createdAt: base + index, text: `STATE-${index}` })
  }
  const session = new FakeSession({ id: 'session-state-v3' })
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-state-1', '状态 继续') })
  const snapshot = JSON.parse(readFileSync(path.join(memoryDir, 'recall-state.json'), 'utf8'))
  assert.equal(snapshot.version, 3)
  assert.equal(snapshot.sessionId, 'session-state-v3')
  assert.ok(snapshot.round >= 1, 'round advanced')
  assert.equal(typeof snapshot.configFingerprint, 'string')
  assert.ok(snapshot.configFingerprint.length > 0, 'configFingerprint persisted')
  assert.ok(snapshot.lanes && typeof snapshot.lanes === 'object', 'lanes persisted')
  assert.ok(Array.isArray(snapshot.lanes.frontier), 'lanes.frontier serialized as an array')
  assert.ok(Array.isArray(snapshot.lanes.pendingHigh) && Array.isArray(snapshot.lanes.recycle), 'lane queues serialized')
  assert.ok(Array.isArray(snapshot.ledger), 'ledger is an array')
  for (const id of snapshot.ids.map((entry) => entry.id)) assert.ok(snapshot.ledger.includes(id), `ledger contains surfaced ${id}`)
  assert.ok(snapshot.counters && typeof snapshot.counters === 'object', 'counters persisted')
  assert.equal(typeof snapshot.counters.reInjections, 'number')
  assert.equal(typeof snapshot.counters.registerDrops, 'number')
  assert.equal(typeof snapshot.counters.timeMisses, 'number')
  assert.equal(snapshot.block, recallBlock(capture, session), 'block text equals the injected section')
  assert.equal(typeof snapshot.degraded, 'boolean')
}))

// ---------------------------------------------------------------------------
// restart determinism: 60 rounds with and without a plugin restart at round 20
// ---------------------------------------------------------------------------

test('60 rounds of picks are identical across a plugin restart (recall-state v3 round-trip)', withTempDir(async (dir) => {
  const buildMemory = (memoryDir) => {
    mkdirSync(memoryDir, { recursive: true })
    const base = Date.now() - 86_400_000
    for (let group = 0; group < 4; group += 1) {
      for (let index = 0; index < 10; index += 1) {
        writeFolder(memoryDir, `mem-g${group}-${String(index).padStart(2, '0')}`, {
          alpha: 0.05 + group * 0.08 + index * 0.01,
          keywords: [`关键词${group}`, `标签${group}`],
          createdAt: base + group * 1000 + index,
          text: `MEMORY-G${group}-${index}-CONTENT`,
        })
      }
    }
  }
  const dirA = path.join(dir, 'memory-a')
  const dirB = path.join(dir, 'memory-b')
  buildMemory(dirA)
  buildMemory(dirB)

  const queryOf = (round) => `关键词${round % 4} 第 ${round} 轮继续确认`
  const runTimeline = async (memoryDir, { restartAt = null } = {}) => {
    const picks = []
    let session = new FakeSession({ id: 'session-60-rounds' })
    let { ctx } = makeContext(session)
    let plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
    plugin.start()
    let engine = plugin.engineFor(session, plugin.currentConfig())
    const wrap = (engineRef) => {
      const original = engineRef.recall.bind(engineRef)
      engineRef.recall = (text, stats, options) => {
        const result = original(text, stats, options)
        picks.push((result.additions ?? []).map((addition) => addition.id))
        return result
      }
    }
    wrap(engine)
    for (let round = 1; round <= 60; round += 1) {
      if (restartAt !== null && round === restartAt) {
        // DSH restart: brand-new session object, new plugin instance; the block,
        // lanes, round and ledger must be restored from recall-state.json v3.
        session = new FakeSession({ id: 'session-60-rounds' })
        const next = makeContext(session)
        ctx = next.ctx
        plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
        plugin.start()
        engine = plugin.engineFor(session, plugin.currentConfig())
        wrap(engine)
      }
      plugin.onInboxInserted({ agent: { session }, message: userMessage(`msg-${round}`, queryOf(round)) })
    }
    return { picks, plugin, session }
  }

  const timelineA = await runTimeline(dirA)
  const timelineB = await runTimeline(dirB, { restartAt: 21 })
  assert.equal(timelineA.picks.length, 60)
  assert.equal(timelineB.picks.length, 60)
  for (let round = 0; round < 60; round += 1) {
    assert.deepEqual(
      timelineB.picks[round],
      timelineA.picks[round],
      `round ${round + 1}: picks must be identical with/without a restart (${JSON.stringify(timelineA.picks[round])} vs ${JSON.stringify(timelineB.picks[round])})`,
    )
  }
  assert.ok(timelineB.plugin.sessionState(timelineB.session).round > 20, 'round continued across the restart')
  assert.ok(timelineB.plugin.sessionState(timelineB.session).ledger.length > 0, 'ledger restored across the restart')
  const restoredLanes = timelineB.plugin.sessionState(timelineB.session).lanes
  assert.ok(restoredLanes && typeof restoredLanes === 'object', 'lane state restored across the restart')
}))

// ---------------------------------------------------------------------------
// trim goes through the engine (not the createdAt FIFO) — and legacy keeps FIFO
// ---------------------------------------------------------------------------

test('block trim uses engine priority order, not the createdAt FIFO', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFolder(memoryDir, 'mem-old-high', { alpha: 0.9, keywords: ['trim'], createdAt: 1000, text: 'OLD-HIGH' })
  writeFolder(memoryDir, 'mem-mid-mid', { alpha: 0.3, keywords: ['trim'], createdAt: 2000, text: 'MID-MID' })
  writeFolder(memoryDir, 'mem-new-low', { alpha: 0.05, keywords: ['trim'], createdAt: 3000, text: 'NEW-LOW' })
  const session = new FakeSession({ id: 'session-trim-order' })
  const { ctx } = makeContext(session)
  const overrides = makeOverrides(memoryDir, { recall: { ...makeOverrides(memoryDir).recall, maxRecalledBlocks: 2 } })
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const engine = plugin.engineFor(session, plugin.currentConfig())
  const state = plugin.sessionState(session)
  const folders = readIndexFile(memoryDir).folders
  state.additions = folders.map((folder) => additionOf(folder, memoryDir))
  state.recalledIds = new Set(state.additions.map((addition) => addition.id))
  state.round = 1
  plugin.trimRecallBlock(session, state, plugin.currentConfig(), engine)
  const kept = state.additions.map((addition) => addition.id)
  assert.ok(kept.includes('mem-old-high'), 'high-α pin: the oldest high-α memory is NOT evicted by FIFO')
  assert.ok(kept.includes('mem-mid-mid'))
  assert.ok(!kept.includes('mem-new-low'), 'the new low-α memory is evicted first')

  // Legacy rollback keeps the v1.3.0 createdAt/FIFO trim.
  const legacyOverrides = makeOverrides(memoryDir, {
    recall: { ...makeOverrides(memoryDir).recall, mode: 'legacy', maxRecalledBlocks: 2 },
  })
  const legacySession = new FakeSession({ id: 'session-trim-legacy' })
  const { ctx: legacyCtx } = makeContext(legacySession)
  const legacyPlugin = new RofmPlugin(legacyCtx, legacyOverrides)
  legacyPlugin.start()
  const legacyState = legacyPlugin.sessionState(legacySession)
  legacyState.additions = folders.map((folder) => additionOf(folder, memoryDir))
  legacyState.recalledIds = new Set(legacyState.additions.map((addition) => addition.id))
  legacyPlugin.trimRecallBlock(legacySession, legacyState, legacyPlugin.currentConfig(), undefined)
  const legacyKept = legacyState.additions.map((addition) => addition.id)
  assert.ok(!legacyKept.includes('mem-old-high'), 'legacy mode drops the oldest entry (v1.3.0 FIFO)')
  assert.deepEqual(legacyKept.sort(), ['mem-mid-mid', 'mem-new-low'])
  assert.deepEqual(legacyPlugin.sessionState(legacySession).lanes, emptyLanes(), 'legacy trimming does not touch the lanes')
}))
