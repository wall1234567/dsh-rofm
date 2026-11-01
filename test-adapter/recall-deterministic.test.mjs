/**
 * Adapter-level deterministic recall tests (v1.4.0, contract §5.7 / §6).
 *
 * Covers what is *adapter-specific* about the deterministic path (the selector
 * itself is covered by `test/recall-index.test.mjs`):
 *   - `recall.mode='deterministic'` produces the σ top-k the engine oracle picks,
 *     twice in a row (determinism), and never touches `Math.random`;
 *   - `recall.mode='legacy'` is a byte-compatible rollback: no `lanes/round/
 *     blockIds/ledger` are passed, the v1.3.0 probability path runs and its
 *     telemetry says `mode:'legacy'`;
 *   - recall-state v2 (and malformed v3) migrates to v3 without losing the block;
 *   - pagination through the plugin-provided lanes hooks (`offset/limit/hasMore`,
 *     disjoint pages, committed lanes);
 *   - `time.mode='constrain'` windows: direct hit, ladder widening and
 *     `missType='time'`;
 *   - the plugin hooks `getRecallLanes` / `commitRecallLanes` /
 *     `nextRecallRound` / `getRecallContext` that `lib/recall-tool.js` calls.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RofmPlugin } from '../lib/plugin.js'
import { emptyLanes, querySeeds, selectSigma } from '../engine/index.js'

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const clone = (value) => JSON.parse(JSON.stringify(value))

class FakeSession {
  constructor({ contextWindow = 200000, header = { origin: 'main' }, id = 'session-deterministic' } = {}) {
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
      mode: 'deterministic',
      firstGenMax: 10,
      maxRecalledBlocks: 64,
      maxRecalledChars: 120000,
      maxWindowPercent: 10,
      persistInjected: true,
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
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-det-'))
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

function readRecallState(memoryDir) {
  return JSON.parse(readFileSync(path.join(memoryDir, 'recall-state.json'), 'utf8'))
}

function readStatsEvents(memoryDir) {
  const file = path.join(memoryDir, 'stats.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function writeFolder(memoryDir, id, options = {}) {
  const {
    alpha = 0.5,
    beta = 0,
    keywords = ['fixture'],
    text = `CONTENT-${id}`,
    createdAt = Date.now(),
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
    stats: { messages: 1, chars: text.length, tokens: 10 },
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
  const entry = { id, createdAt, alpha, beta, keywords, chars: text.length, tokens: 10, messageCount: 1, title: text.slice(0, 40), scored: true }
  if (Number.isFinite(eventStart)) {
    entry.eventStart = eventStart
    entry.eventTimeSource = 'messages'
  }
  if (Number.isFinite(eventEnd)) entry.eventEnd = eventEnd
  index.folders.push(entry)
  writeFileSync(path.join(memoryDir, 'index.json'), JSON.stringify(index))
}

function writeFolders(memoryDir, count = 20, prefix = 'mem-det', keyword = '确定性') {
  mkdirSync(memoryDir, { recursive: true })
  const base = Date.now() - 3600_000
  for (let index = 0; index < count; index += 1) {
    writeFolder(memoryDir, `${prefix}-${String(index).padStart(2, '0')}`, {
      alpha: 0.1 + (index % 5) * 0.1,
      keywords: [keyword, `标签${index}`],
      createdAt: base + index,
      text: `DETERMINISTIC-${index}`,
    })
  }
}

function recallBlock(capture, session) {
  const section = capture.sections.find((item) => item.name === 'dsh-rofm:recall')
  return section ? section.text({ agent: { session } }) : ''
}

// ---------------------------------------------------------------------------
// deterministic mode: σ top-k == oracle, deterministic replays, no Math.random
// ---------------------------------------------------------------------------

test('deterministic mode reproduces the engine σ top-k oracle', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  writeFolders(memoryDir, 20)
  const session = new FakeSession({ id: 'session-oracle' })
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const query = '确定性 继续确认'
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-oracle', query) })
  const injected = plugin.sessionState(session).additions.map((addition) => addition.id)
  assert.ok(injected.length > 0, 'deterministic recall injected memories')

  // Oracle: selectSigma on the same index/seeds with the same k (firstGenMax+1
  // lookahead) and an empty exclude set; the page is the first firstGenMax ids.
  const cfg = plugin.currentConfig()
  const engine = plugin.engineFor(session, cfg)
  const index = engine.recallIndex()
  const seeds = querySeeds(index, query, cfg).seeds
  const oracle = selectSigma(index, seeds, { k: 11, exclude: new Set(), sticky: new Set(), minAlpha: 0, timeIds: null, hops: 0 })
  const oracleIds = oracle.picked.slice(0, 10).map((item) => item.id)
  assert.deepEqual([...injected].sort(), [...oracleIds].sort(), 'adapter picks equal the σ oracle top-k')
  assert.equal(recallBlock(capture, session).includes('DETERMINISTIC-'), true, 'picked memories were rendered')
  assert.equal(recallBlock(capture, session).split('\n').filter((line) => line.startsWith('### 回忆')).length, injected.length)
}))

test('deterministic mode is replayable and never calls Math.random', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  writeFolders(memoryDir, 20)
  const runOnce = async (sessionId, deleteState) => {
    if (deleteState) rmSync(path.join(memoryDir, 'recall-state.json'), { force: true })
    const session = new FakeSession({ id: sessionId })
    const { ctx } = makeContext(session)
    const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
    plugin.start()
    plugin.onInboxInserted({ agent: { session }, message: userMessage(`u-${sessionId}`, '确定性 继续确认') })
    plugin.onInboxInserted({ agent: { session }, message: userMessage(`u-${sessionId}-2`, '确定性 再查一下') })
    return plugin.sessionState(session).additions.map((addition) => addition.id)
  }
  const first = await runOnce('session-replay-a', true)
  const second = await runOnce('session-replay-b', true)
  assert.deepEqual(second, first, 'same memory + same queries → identical picks (deterministic)')

  const originalRandom = Math.random
  Math.random = () => {
    throw new Error('Math.random must not be used by the deterministic recall path')
  }
  try {
    rmSync(path.join(memoryDir, 'recall-state.json'), { force: true })
    const session = new FakeSession({ id: 'session-no-random' })
    const { ctx } = makeContext(session)
    const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
    plugin.start()
    assert.doesNotThrow(() => {
      plugin.onInboxInserted({ agent: { session }, message: userMessage('u-no-random', '确定性 继续确认') })
    }, 'no Math.random call in the deterministic path')
    assert.ok(plugin.sessionState(session).additions.length > 0)
  } finally {
    Math.random = originalRandom
  }
}))

// ---------------------------------------------------------------------------
// legacy rollback
// ---------------------------------------------------------------------------

test('legacy mode is a byte-compatible rollback: no lanes/round passed, engine mode legacy', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFolder(memoryDir, 'mem-legacy-0001', { alpha: 0.9, keywords: ['回滚'], createdAt: Date.now() - 3600_000, text: 'LEGACY-ROLLBACK-CONTENT' })
  const session = new FakeSession({ id: 'session-legacy-rollback' })
  const { ctx } = makeContext(session)
  const overrides = makeOverrides(memoryDir, {
    recall: {
      ...makeOverrides(memoryDir).recall,
      mode: 'legacy',
      seed: 7,
      probabilityScale: 1000,
    },
  })
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const engine = plugin.engineFor(session, plugin.currentConfig())
  const calls = []
  const original = engine.recall.bind(engine)
  engine.recall = (text, stats, options) => {
    calls.push(options)
    return original(text, stats, options)
  }
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-legacy', '回滚 继续') })
  assert.equal(calls.length, 1)
  const options = calls[0]
  assert.equal('lanes' in options, false, 'legacy mode must not pass lanes')
  assert.equal('round' in options, false, 'legacy mode must not pass round')
  assert.equal('blockIds' in options, false, 'legacy mode must not pass blockIds')
  assert.equal('ledger' in options, false, 'legacy mode must not pass ledger')
  const state = plugin.sessionState(session)
  assert.ok(state.additions.some((addition) => addition.id === 'mem-legacy-0001'), 'v1.3.0 probability path (scale=1000) injects the memory')
  const recallEvents = readStatsEvents(memoryDir).filter((event) => event.type === 'recall')
  assert.equal(recallEvents.at(-1).mode, 'legacy')
  // The file is v3 (write format is uniform), but the legacy path never touched
  // the deterministic state.
  const snapshot = readRecallState(memoryDir)
  assert.equal(snapshot.version, 3)
  assert.equal(snapshot.round, 0, 'legacy mode does not advance the deterministic round')
  assert.deepEqual(snapshot.ledger, [], 'legacy mode does not build the ledger')
}))

// ---------------------------------------------------------------------------
// recall-state v2 → v3 migration + malformed v3 degradation + fingerprint reset
// ---------------------------------------------------------------------------

test('a v2 recall-state migrates to v3 without losing the restored block', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  writeFolders(memoryDir, 6) // prefixes mem-det-*
  mkdirSync(memoryDir, { recursive: true })
  const folderId = readIndexFile(memoryDir).folders[0].id
  const snapshotV2 = {
    version: 2,
    sessionId: 'session-v2-migrate',
    updatedAt: Date.now(),
    block: 'V2-RESTORED-BLOCK-TEXT',
    ids: [{ id: folderId, generation: 1 }],
    additions: [
      {
        id: folderId,
        generation: 1,
        alpha: 0.5,
        beta: 2,
        probability: 0.5,
        chars: 40,
        tokens: 10,
        createdAt: Date.now() - 3600_000,
        keywords: ['确定性'],
        title: 'V2 memory',
        messages: [{ role: 'user', content: 'V2-RESTORED-MESSAGE' }],
      },
    ],
  }
  writeFileSync(path.join(memoryDir, 'recall-state.json'), JSON.stringify(snapshotV2))
  const session = new FakeSession({ id: 'session-v2-migrate' })
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  await plugin.onPreStep({ agent: { session }, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(recallBlock(capture, session).includes('V2-RESTORED-BLOCK-TEXT'), 'v2 block restored verbatim')
  const state = plugin.sessionState(session)
  assert.equal(state.round, 0, 'v2 has no round')
  assert.deepEqual(state.ledger, [], 'v2 has no ledger (bounded repeats allowed)')
  assert.ok(state.lanes && state.lanes.frontier instanceof Map, 'v2 starts with empty lanes')
  // The next save upgrades the file to v3 and keeps the restored additions.
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-v2-next', '确定性 继续') })
  const migrated = readRecallState(memoryDir)
  assert.equal(migrated.version, 3)
  assert.ok(migrated.additions.some((addition) => addition.id === folderId), 'restored v2 addition survives the migration')
  assert.ok(Number.isFinite(migrated.round), 'round is now persisted')
  assert.ok(typeof migrated.configFingerprint === 'string' && migrated.configFingerprint.length > 0)
}))

test('malformed v3 fields degrade individually (no throw, block kept)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  writeFolders(memoryDir, 3)
  const folderId = readIndexFile(memoryDir).folders[0].id
  writeFileSync(
    path.join(memoryDir, 'recall-state.json'),
    JSON.stringify({
      version: 3,
      sessionId: 'session-bad-v3',
      updatedAt: Date.now(),
      block: 'BAD-V3-BLOCK-TEXT',
      ids: [{ id: folderId, generation: 1 }],
      additions: [
        {
          id: folderId,
          generation: 1,
          alpha: 0.5,
          beta: 1,
          probability: 0.5,
          chars: 20,
          tokens: 5,
          createdAt: Date.now() - 3600_000,
          keywords: [],
          title: 'bad v3',
          messages: [{ role: 'user', content: 'BAD-V3-MESSAGE' }],
        },
      ],
      round: 'not-a-number',
      configFingerprint: 'cfg1|outdated',
      lanes: 'garbage',
      ledger: 42,
      counters: 'nope',
    }),
  )
  const session = new FakeSession({ id: 'session-bad-v3' })
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  assert.doesNotThrow(async () => {
    await plugin.onPreStep({ agent: { session }, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(recallBlock(capture, session).includes('BAD-V3-BLOCK-TEXT'), 'block survives malformed lanes/ledger/counters')
  const state = plugin.sessionState(session)
  assert.equal(state.round, 0, 'bad round degrades to 0')
  assert.ok(Array.isArray(state.ledger), 'bad ledger degrades to an array')
  assert.ok(state.ledger.includes(folderId), 'the restored block ids are folded into the ledger')
  assert.ok(state.lanes && state.lanes.frontier instanceof Map, 'bad lanes degrade to emptyLanes()')
  assert.equal(state.counters.reInjections, 0)
}))

test('a changed configFingerprint resets the lane cursors but keeps block and ledger', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  writeFolders(memoryDir, 3)
  const folderId = readIndexFile(memoryDir).folders[0].id
  writeFileSync(
    path.join(memoryDir, 'recall-state.json'),
    JSON.stringify({
      version: 3,
      sessionId: 'session-fingerprint',
      updatedAt: Date.now(),
      block: 'FINGERPRINT-BLOCK',
      ids: [{ id: folderId, generation: 1 }],
      additions: [
        {
          id: folderId,
          generation: 1,
          alpha: 0.5,
          beta: 1,
          probability: 0.5,
          chars: 20,
          tokens: 5,
          createdAt: Date.now() - 3600_000,
          keywords: [],
          title: 'fp',
          messages: [{ role: 'user', content: 'FINGERPRINT-MESSAGE' }],
        },
      ],
      round: 7,
      configFingerprint: 'cfg1|old-config',
      lanes: {
        frontier: [{ seed: 'old', key: { alpha: 1, createdAt: 1, id: 'old' }, length: 3 }],
        exploreCursor: null,
        pendingHigh: ['pending-id'],
        pendingHighRound: [5],
        highRecycle: [],
        recycle: [],
        degraded: true,
        round: 7,
      },
      ledger: [folderId, 'other-id'],
      counters: { reInjections: 2, registerDrops: 3, recallTimeEvicted: 0, timeMisses: 1 },
    }),
  )
  const session = new FakeSession({ id: 'session-fingerprint' })
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  await plugin.onPreStep({ agent: { session }, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(recallBlock(capture, session).includes('FINGERPRINT-BLOCK'), 'block restored')
  const state = plugin.sessionState(session)
  assert.equal(state.lanes.frontier.size, 0, 'lane cursors reset on a fingerprint change')
  assert.equal(state.lanes.degraded, false)
  assert.equal(state.round, 7, 'round kept (monotonic)')
  assert.deepEqual(state.ledger.slice(0, 2), [folderId, 'other-id'], 'ledger kept')
  assert.equal(state.counters.reInjections, 2, 'counters kept')
}))

// ---------------------------------------------------------------------------
// pagination + time windows through the plugin wiring
// ---------------------------------------------------------------------------

test('pagination: offset/limit pages are disjoint and hasMore is truthful', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  writeFolders(memoryDir, 20) // all match "确定性"
  const session = new FakeSession({ id: 'session-pagination' })
  const { ctx } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const cfg = plugin.currentConfig()
  const engine = plugin.engineFor(session, cfg)
  // Deterministic pagination is a page window over the σ order: each page is an
  // independent selection with the same fresh lane state (the documented offset
  // semantics). Lane persistence itself is covered by the hooks test below.
  const recallPage = (offset, limit) => {
    const round = plugin.nextRecallRound(session)
    const result = engine.recall('确定性 继续', { sessionId: 'session-pagination' }, {
      mode: 'deterministic',
      offset,
      limit,
      lanes: emptyLanes(),
      round,
      blockIds: new Set(),
      ledger: [],
    })
    plugin.commitRecallLanes(session, cfg, result.lanes)
    return result
  }
  const page1 = recallPage(0, 5)
  assert.equal(page1.page.offset, 0)
  assert.equal(page1.additions.length, 5)
  assert.equal(page1.page.hasMore, true, 'first page reports more')
  const page2 = recallPage(5, 5)
  assert.equal(page2.page.offset, 5)
  assert.equal(page2.additions.length, 5)
  assert.equal(page2.page.hasMore, true)
  const page1Ids = new Set(page1.additions.map((addition) => addition.id))
  for (const addition of page2.additions) assert.equal(page1Ids.has(addition.id), false, 'pages are disjoint')
  const page3 = recallPage(10, 5)
  assert.equal(page3.additions.length, 5)
  assert.equal(page3.page.hasMore, true, 'page three still reports more')
  const page4 = recallPage(15, 5)
  assert.equal(page4.additions.length, 5)
  assert.equal(page4.page.hasMore, false, 'last page reports hasMore=false')
  const allIds = [page1, page2, page3, page4].flatMap((page) => page.additions.map((addition) => addition.id))
  assert.equal(new Set(allIds).size, allIds.length, 'all pages together contain no duplicates')
  // getRecallContext exposes everything the model tool needs in one call.
  const context = plugin.getRecallContext(session, cfg)
  assert.ok(context.lanes && typeof context.lanes === 'object')
  assert.ok(context.round >= 1)
  assert.ok(context.blockIds instanceof Set)
  assert.ok(Array.isArray(context.ledger))
}))

test('time.mode=constrain: direct hit, ladder widening and missType="time"', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // Event day 2026-10-20 in Asia/Shanghai (02:00Z = 10:00 +08).
  const eventStart = Date.parse('2026-10-20T02:00:00Z')
  writeFolder(memoryDir, 'mem-time-0001', {
    alpha: 0.8,
    keywords: ['时间记忆'],
    createdAt: Date.now() - 3600_000,
    text: 'TIME-WINDOW-MEMORY',
    eventStart,
    eventEnd: eventStart + 3600_000,
  })
  const session = new FakeSession({ id: 'session-time' })
  const { ctx } = makeContext(session)
  const overrides = makeOverrides(memoryDir, {
    time: {
      mode: 'constrain',
      timezone: 'Asia/Shanghai',
      minRangeDays: 3,
      maxRangeDays: 366,
      centerDayPriority: true,
      fallback: ['day3', 'month', 'year', 'all'],
      fallbackMinResults: 1,
    },
  })
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const cfg = plugin.currentConfig()
  const engine = plugin.engineFor(session, cfg)
  const timeRecall = (timeArgs) => {
    const result = engine.recall('时间记忆', { sessionId: 'session-time' }, {
      mode: 'deterministic',
      offset: 0,
      limit: 10,
      lanes: emptyLanes(),
      round: 1,
      blockIds: new Set(),
      ledger: [],
      ...timeArgs,
    })
    return result
  }
  // 1) Exact day hit (single-day query is a soft window, L0 hits).
  const hit = timeRecall({ timeFrom: '2026-10-20', granularity: 'day' })
  assert.equal(hit.additions.length, 1, 'memory in the queried day is returned')
  assert.equal(hit.timeWindow.level, 'day')
  assert.equal(hit.missType, null)
  // 2) Adjacent day misses L0 but the ladder widens to the month.
  const widened = timeRecall({ timeFrom: '2026-10-22', granularity: 'day' })
  assert.equal(widened.additions.length, 1, 'ladder widening finds the memory in the same month')
  assert.ok(widened.timeWindow.widenedTo !== null, `widenedTo is reported (${widened.timeWindow.widenedTo})`)
  // 3) A hard explicit range outside the event day: no hit, classified as a time miss.
  const miss = timeRecall({ timeFrom: '2026-10-25', timeTo: '2026-10-27' })
  assert.equal(miss.additions.length, 0)
  assert.equal(miss.missType, 'time', 'a keyword hit filtered out by the time window is a time miss')
  assert.equal(miss.timeWindow.enforced, true)
}))

// ---------------------------------------------------------------------------
// model-tool hooks (E): getRecallLanes / commitRecallLanes / nextRecallRound
// ---------------------------------------------------------------------------

test('lane hooks: nextRecallRound, getRecallLanes, commitRecallLanes persist v3', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  writeFolders(memoryDir, 3)
  const session = new FakeSession({ id: 'session-hooks' })
  const { ctx } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  const cfg = plugin.currentConfig()
  assert.equal(plugin.nextRecallRound(session), 1, 'fresh session starts at round 1')
  const lanes = plugin.getRecallLanes(session, cfg)
  assert.ok(lanes && typeof lanes === 'object', 'getRecallLanes returns a LaneState')
  assert.ok(lanes.frontier instanceof Map, 'live lane state keeps Map frontiers')
  // The model tool runs its own engine.recall, then commits the updated lanes.
  const engine = plugin.engineFor(session, cfg)
  const result = engine.recall('确定性 继续', { sessionId: 'session-hooks' }, {
    mode: 'deterministic',
    lanes,
    round: plugin.nextRecallRound(session),
    blockIds: new Set(),
    ledger: [],
  })
  assert.ok(result.lanes && typeof result.lanes === 'object')
  assert.equal(plugin.commitRecallLanes(session, cfg, result.lanes), true)
  assert.ok(plugin.sessionState(session).round >= 1, 'commit advances the session round')
  assert.equal(plugin.nextRecallRound(session), plugin.sessionState(session).round + 1)
  const snapshot = readRecallState(memoryDir)
  assert.equal(snapshot.version, 3, 'committing lanes persists recall-state v3')
  assert.ok(snapshot.lanes && typeof snapshot.lanes === 'object')
  // Committing lanes must never touch the injected block.
  assert.equal(snapshot.block, '')
}))

test('recall.persistInjected=false keeps the block in memory but writes no recall-state', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  writeFolders(memoryDir, 3)
  const session = new FakeSession({ id: 'session-no-persist' })
  const { ctx, capture } = makeContext(session)
  const overrides = makeOverrides(memoryDir, { recall: { ...makeOverrides(memoryDir).recall, persistInjected: false } })
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  plugin.onInboxInserted({ agent: { session }, message: userMessage('u-no-persist', '确定性 继续') })
  assert.ok(recallBlock(capture, session).includes('DETERMINISTIC-'), 'the block is still injected into the prompt')
  assert.equal(existsSync(path.join(memoryDir, 'recall-state.json')), false, 'persistInjected=false writes no recall-state')
}))

test('a v2 file with no valid addition falls back to the v1 ids path', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  writeFolders(memoryDir, 2)
  const folderId = readIndexFile(memoryDir).folders[0].id
  writeFileSync(
    path.join(memoryDir, 'recall-state.json'),
    JSON.stringify({
      version: 2,
      sessionId: 'session-v1-fallback',
      updatedAt: Date.now(),
      block: 'BROKEN',
      ids: [{ id: folderId, generation: 1 }],
      additions: [{ id: '../escape', alpha: 0.5, beta: 1, chars: 1, tokens: 1, createdAt: 1, messages: [] }],
    }),
  )
  const session = new FakeSession({ id: 'session-v1-fallback' })
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  await plugin.onPreStep({ agent: { session }, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const text = recallBlock(capture, session)
  assert.ok(text.includes('DETERMINISTIC-'), 'v1 ids path rebuilds the block from disk')
  assert.ok(!text.includes('BROKEN'), 'invalid snapshot block is never injected')
}))
