/**
 * 1.5.0 audit-fix regression tests for the recall engine core
 * (`engine/engine.js` + `engine/recall-index.js`).
 *
 * Covers the engine-side defects of the independent 1.5.0 audit:
 *   - F-LEAD-01 / F-02-01  time-tag priority is applied to every soft-window
 *                          fallback-ladder rung (not only the requested window);
 *   - F-02-02              event `unknown` still exposes the closest existing
 *                          events (engine `candidates` + model-visible hint);
 *   - F-02-04              missType only blames the filter that dropped
 *                          candidates (eventFiltered=0 must not report 'event');
 *   - F-02-05              real `stats.timeTagFiltered` (not folded into
 *                          `tagFiltered`), browse path included;
 *   - F-02-06              `engine.timeWindowFor` returns the same hit set as
 *                          `engine.recall` for time-tagged folders;
 *   - F-04-01              per-clause guaranteed slots inject a memory of that
 *                          clause (`hits` is the real count, never `max(1, …)`);
 *   - F-04-02              `recall.assistantSaid.reserveSlots` actually reserves
 *                          quota slots (0 vs 2 observable difference);
 *   - F-04-03              `assistantSaid.enabled=false` is a hard switch
 *                          (explicit request + index build included);
 *   - F-04-04              `recall.firstGenMax=0` kill switch survives the
 *                          adaptive complex quota (explicit limit untouched);
 *   - F-04-05              legacy mode never claims the assistant channel was
 *                          searched (`assistantSaid` is the effective flag);
 *   - F-04-06 (engine side) `clauseInfo[i].ids` lists the ids really attributed
 *                          to the clause so callers can recount after a trim.
 *
 * Every test drives the real public API (`MemoryEngine.recall`,
 * `engine.timeWindowFor`, `engine.recallIndex`, `engine.recallQuota`) over a
 * hermetic temp-memory dir written with the real store writer — no test pokes a
 * hand-written intermediate engine field.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { MemoryEngine, loadConfig, writeFolder } from '../engine/index.js'
import { renderRecallResult } from '../lib/recall-tool.js'

const DAY = 86_400_000
const SH = 8 * 3_600_000
const SH_DAY = (text) => Date.parse(`${text}T00:00:00+08:00`)

const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-audit-fix-engine-'))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/** All recall-relevant groups in enforcing mode + wide round budget. */
function overrides(extra = {}) {
  return {
    recall: {
      mode: 'fair',
      firstGenMax: 10,
      fairness: { roundBudget: { maxChars: 1_000_000 } },
      ...(extra.recall ?? {}),
    },
    time: { mode: 'constrain', timezone: 'Asia/Shanghai', ...(extra.time ?? {}) },
    timeTag: { mode: 'constrain', ...(extra.timeTag ?? {}) },
    location: { mode: 'constrain', ...(extra.location ?? {}) },
    person: { mode: 'constrain', ...(extra.person ?? {}) },
    event: { mode: 'constrain', ...(extra.event ?? {}) },
  }
}

/**
 * Write one folder per spec through the real store writer, then load a fresh
 * engine over that memory dir. A spec may carry
 * `createdAt/messages/keywords/alpha/locations/persons/events/eventStart/
 * eventEnd/eventTimeSource/timeTags/assistantKeywords`.
 */
function makeEngine(specs, extraOverrides = {}) {
  const dir = tempDir()
  for (const spec of specs) {
    const messages = Array.isArray(spec.messages)
      ? spec.messages
      : [{ role: 'user', content: spec.text ?? (spec.keywords ?? ['内容']).join(' ') }]
    const meta = {
      version: 1,
      createdAt: spec.createdAt ?? 1_700_000_000_000,
      alpha: spec.alpha ?? 0.9,
      beta: spec.beta ?? 3,
      keywords: spec.keywords ?? ['docker'],
      title: (spec.keywords ?? ['docker']).join(' '),
      stats: { messages: messages.length, chars: 50, tokens: 20 },
      ...(spec.locations === undefined ? {} : { locations: spec.locations }),
      ...(spec.persons === undefined ? {} : { persons: spec.persons }),
      ...(spec.events === undefined ? {} : { events: spec.events }),
      ...(spec.timeTags === undefined ? {} : { timeTags: spec.timeTags, timeTagSource: 'messages' }),
      ...(spec.assistantKeywords === undefined ? {} : { assistantKeywords: spec.assistantKeywords }),
      ...(spec.eventStart === undefined
        ? {}
        : {
            eventStart: spec.eventStart,
            eventEnd: spec.eventEnd ?? spec.eventStart + DAY,
            eventTimeSource: spec.eventTimeSource ?? 'judge',
          }),
    }
    writeFolder(dir, { id: spec.id, meta, messages })
  }
  const cfg = loadConfig(undefined, { storage: { dir }, ...overrides(extraOverrides) })
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg, rng: () => 0 })
  engine.load()
  return { engine, cfg, dir }
}

const idsOf = (result) => result.additions.map((addition) => addition.id).sort()

/** Last `recall` telemetry record appended to `<memoryDir>/stats.jsonl`. */
function lastRecallTelemetry(dir) {
  const text = fs.readFileSync(path.join(dir, 'stats.jsonl'), 'utf8').trim()
  const events = text
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === 'recall')
  return events.at(-1) ?? null
}

// ---------------------------------------------------------------------------
// F-LEAD-01 / F-02-01 — time-tag priority on every fallback-ladder rung
// ---------------------------------------------------------------------------

test('F-LEAD-01/F-02-01: the soft-window ladder applies the time-tag priority to every rung', () => {
  const { engine } = makeEngine(
    [
      // Archived recently, but its authoritative time tag says 2020. The
      // eventStart sits inside the widened day3/month rungs (this is exactly the
      // window that used to stop the ladder early and inject the wrong memory).
      {
        id: 'mem-ladder-tagged-2020',
        keywords: ['测试', '部署', '端口'],
        createdAt: Date.parse('2026-11-06T10:00:00+08:00'),
        eventStart: Date.parse('2026-11-05T09:00:00+08:00'),
        timeTags: [
          {
            from: Date.parse('2020-01-01T00:00:00+08:00'),
            to: Date.parse('2020-01-02T00:00:00+08:00'),
            label: '2020-01-01',
            granularity: 'day',
          },
        ],
      },
      // Untagged, outside the requested day and the month rung, inside the year.
      {
        id: 'mem-ladder-untagged-2026',
        keywords: ['测试', '部署', '端口'],
        createdAt: Date.parse('2026-02-10T10:00:00+08:00'),
        eventStart: Date.parse('2026-02-10T09:00:00+08:00'),
      },
    ],
    { recall: { mode: 'fair', firstGenMax: 10 } },
  )

  const soft = engine.recall('测试', {}, { timeFrom: '2026-11-07' })
  assert.deepEqual(idsOf(soft), ['mem-ladder-untagged-2026'], 'the tag-2020 memory must not be injected for a 2026-11 window')
  assert.equal(soft.timeWindow.widenedTo, 'year', 'the ladder must widen past the month rung instead of stopping on the eventStart hit')

  // Determinism: a second soft query on the same engine returns the same set.
  assert.deepEqual(idsOf(engine.recall('测试', {}, { timeFrom: '2026-11-07' })), ['mem-ladder-untagged-2026'])

  // Hard-window control (attempt 0 already applied the preference before the fix).
  const hard = engine.recall('测试', {}, { timeFrom: '2026-01-01', timeTo: '2026-11-07' })
  assert.deepEqual(idsOf(hard), ['mem-ladder-untagged-2026'])
  assert.equal(hard.timeWindow.widenedTo, null)
})

// ---------------------------------------------------------------------------
// F-02-02 — event `unknown` keeps the closest existing events
// ---------------------------------------------------------------------------

test('F-02-02: an unknown event still reports the closest existing events and the model-visible hint', () => {
  const { engine } = makeEngine(
    [{ id: 'mem-evt', keywords: ['docker'], events: ['日本旅行计划'] }],
    { event: { mode: 'constrain', similarity: { metric: 'dice', threshold: 0.72, maxCandidates: 5 } } },
  )

  const plan = engine.eventQueryFor('日本出差')
  assert.equal(plan.status, 'unknown')
  assert.ok(Array.isArray(plan.candidates) && plan.candidates.length > 0, `unknown must carry candidates: ${JSON.stringify(plan.candidates)}`)
  assert.equal(plan.candidates[0].label, '日本旅行计划')
  assert.ok(Number(plan.candidates[0].score) > 0)

  const result = engine.recall('docker', {}, { event: '日本出差' })
  assert.equal(result.eventInfo.status, 'unknown')
  assert.ok(Array.isArray(result.eventInfo.candidates) && result.eventInfo.candidates.length > 0)
  assert.deepEqual(idsOf(result), [])

  // The model-visible miss hint is produced by the real renderer from the real
  // engine eventInfo (no hand-built candidates array).
  const rendered = renderRecallResult(
    { keywords: 'docker', event: '日本出差' },
    {
      found: 0,
      matchedFolders: 0,
      attempted: 1,
      added: [],
      entries: [],
      offset: 0,
      limit: 3,
      hasMore: false,
      mode: 'fair',
      missType: result.missType,
      eventInfo: result.eventInfo,
      warnings: [],
      askUserHint: true,
    },
  )
  const text = rendered.map((block) => block.text).join('\n')
  assert.ok(text.includes('最接近的已有事件'), text)
  assert.ok(text.includes('日本旅行计划'), text)
})

// ---------------------------------------------------------------------------
// F-02-04 — missType attribution: only the filter that dropped candidates wins
// ---------------------------------------------------------------------------

test('F-02-04: eventFiltered=0 + tagFiltered>0 reports the tag miss, not an event miss', () => {
  const { engine } = makeEngine(
    [
      { id: 'mem-a', keywords: ['docker'], events: ['北京旅行'], locations: ['北京'] },
      { id: 'mem-b', keywords: ['docker'], events: ['北京旅行'], locations: ['上海'] },
    ],
    { event: { mode: 'constrain' } },
  )
  const result = engine.recall('docker', {}, { event: '北京旅行', locations: ['火星'] })
  assert.deepEqual(idsOf(result), [])
  assert.equal(result.stats.eventFiltered, 0, 'the event constraint kept both candidates')
  assert.ok(result.stats.tagFiltered >= 2, JSON.stringify(result.stats))
  assert.equal(result.missType, 'tag', 'the unknown location removed the candidates -> tag miss')
})

test('F-02-04: a filter that really dropped every candidate still owns the miss', () => {
  const { engine } = makeEngine([
    { id: 'mem-a', keywords: ['docker'], events: ['北京旅行'] },
    { id: 'mem-b', keywords: ['docker'], events: ['北京旅行'] },
  ])
  const eventMiss = engine.recall('docker', {}, { event: '上海旅行' })
  assert.deepEqual(idsOf(eventMiss), [])
  assert.ok(eventMiss.stats.eventFiltered >= 2, JSON.stringify(eventMiss.stats))
  assert.equal(eventMiss.missType, 'event')

  // Time-tag constraint removed every keyword candidate -> time-tag miss.
  const { engine: ttEngine } = makeEngine([
    { id: 'mem-y', keywords: ['docker'], createdAt: Date.parse('2020-01-01T00:00:00+08:00') },
    { id: 'mem-old', keywords: ['docker'], createdAt: Date.parse('2020-02-01T00:00:00+08:00') },
  ])
  const window = {
    from: SH_DAY('2026-11-06'),
    to: SH_DAY('2026-11-07'),
    label: '昨天',
    granularity: 'day',
  }
  const timeTagMiss = ttEngine.recall('docker', {}, { timeTagWindows: [window] })
  assert.deepEqual(idsOf(timeTagMiss), [])
  assert.ok(timeTagMiss.stats.timeTagFiltered >= 2, JSON.stringify(timeTagMiss.stats))
  assert.equal(timeTagMiss.missType, 'time-tag')
})

// ---------------------------------------------------------------------------
// F-02-05 — real timeTagFiltered + browse stats carry tagFiltered
// ---------------------------------------------------------------------------

test('F-02-05: time-tag exclusions are counted in stats.timeTagFiltered, not tagFiltered', () => {
  const window = {
    from: SH_DAY('2026-11-06'),
    to: SH_DAY('2026-11-07'),
    label: '昨天',
    granularity: 'day',
  }
  const { engine, dir } = makeEngine([
    { id: 'mem-tagged', keywords: ['部署'], createdAt: Date.parse('2026-11-06T10:00:00+08:00'), timeTags: [{ ...window }] },
    { id: 'mem-untagged', keywords: ['部署'], createdAt: Date.parse('2020-06-01T00:00:00+08:00') },
  ])
  const result = engine.recall('部署', {}, { timeTagWindows: [window] })
  assert.equal(result.stats.timeTagFiltered, 1, JSON.stringify(result.stats))
  assert.equal(result.stats.tagFiltered, 0, 'the time-tag drop must not be folded into tagFiltered')
  assert.deepEqual(idsOf(result), ['mem-tagged'])

  const telemetry = lastRecallTelemetry(dir)
  assert.equal(telemetry.timeTagFiltered, 1, JSON.stringify(telemetry))
  assert.equal(telemetry.tagFiltered, 0)
})

test('F-02-05: a pure browse reports tagFiltered in its stats and telemetry', () => {
  const { engine, dir } = makeEngine([
    {
      id: 'mem-tag',
      keywords: ['docker'],
      locations: ['北京'],
      eventStart: Date.parse('2026-11-06T12:00:00+08:00'),
    },
    {
      id: 'mem-other',
      keywords: ['docker'],
      eventStart: Date.parse('2026-11-06T13:00:00+08:00'),
    },
  ])
  const result = engine.recall('', {}, { timeFrom: '2026-11-06', timeTo: '2026-11-08', locations: ['北京'] })
  assert.equal(result.browse, true)
  assert.deepEqual(idsOf(result), ['mem-tag'])
  assert.equal(result.stats.tagFiltered, 1, JSON.stringify(result.stats))
  assert.equal(result.stats.timeTagFiltered, 0, JSON.stringify(result.stats))
  const telemetry = lastRecallTelemetry(dir)
  assert.equal(telemetry.tagFiltered, 1, JSON.stringify(telemetry))
  assert.equal(telemetry.timeTagFiltered, 0, JSON.stringify(telemetry))
})

// ---------------------------------------------------------------------------
// F-02-06 — timeWindowFor returns the same hit set as recall
// ---------------------------------------------------------------------------

test('F-02-06: timeWindowFor matches recall for a time-tagged folder', () => {
  const { engine } = makeEngine([
    {
      id: 'mem-tag-hit',
      keywords: ['部署'],
      createdAt: Date.parse('2020-05-01T00:00:00+08:00'),
      eventStart: Date.parse('2020-05-01T00:00:00+08:00'),
      eventEnd: Date.parse('2020-05-02T00:00:00+08:00'),
      timeTags: [
        {
          from: Date.parse('2026-11-06T00:00:00+08:00'),
          to: Date.parse('2026-11-07T00:00:00+08:00'),
          label: '昨天',
          granularity: 'day',
        },
      ],
    },
  ])
  const input = { timeFrom: '2026-11-06', timeTo: '2026-11-08' }
  const window = engine.timeWindowFor(input)
  assert.ok(window.ids instanceof Set)
  assert.equal(window.hits, 1, `timeWindowFor hits=${window.hits}`)
  assert.ok(window.ids.has('mem-tag-hit'), 'the time tag makes the folder part of the window although eventStart is 2020')

  const recalled = engine.recall('部署', {}, input)
  assert.deepEqual(idsOf(recalled), ['mem-tag-hit'])
})

// ---------------------------------------------------------------------------
// F-04-01 / F-04-06 — per-clause guaranteed slot: right memory, real hits, ids
// ---------------------------------------------------------------------------

function guaranteeFolders(prefix = 'mem') {
  const folders = []
  for (let index = 0; index < 40; index += 1) {
    folders.push({
      id: `${prefix}-ga-${String(index).padStart(2, '0')}`,
      keywords: ['部署', 'docker', '端口'],
      alpha: 0.9,
      createdAt: Date.parse('2026-10-28T00:00:00+08:00') + index * 1000,
      text: `部署 docker 端口参数 ${index}`,
    })
  }
  for (let index = 0; index < 10; index += 1) {
    folders.push({
      id: `${prefix}-gb-${String(index).padStart(2, '0')}`,
      keywords: ['迁移'],
      alpha: 0.9,
      createdAt: Date.parse('2026-11-02T00:00:00+08:00') + index * 1000,
      text: `数据库迁移最终方案 ${index}`,
    })
  }
  return folders
}

const GUARANTEE_CLAUSES = ['部署 docker 端口的参数到底是多少', '数据库迁移最终方案是什么']
const GUARANTEE_TEXT = GUARANTEE_CLAUSES.join('？') + '？'

test('F-04-01: a clause outside the global ranking gets a clause-relevant guaranteed slot', () => {
  const { engine } = makeEngine(guaranteeFolders())
  const result = engine.recall(GUARANTEE_TEXT, {}, { clauses: GUARANTEE_CLAUSES, quota: 20 })
  assert.equal(result.additions.length, 20)

  const bAdds = result.additions.filter((addition) => addition.id.startsWith('mem-gb-'))
  assert.ok(bAdds.length >= 1, 'the 迁移 clause has 10 candidates but none was injected')

  const clause = result.clauseInfo[1]
  assert.ok(Array.isArray(clause.ids), 'clauseInfo[i].ids must be provided for post-trim recounting (F-04-06)')
  assert.equal(clause.hits, clause.ids.length, 'hits must be the real attributed count')
  assert.ok(clause.hits >= 1)
  assert.ok(clause.ids.every((id) => id.startsWith('mem-gb-')), `clause 2 ids must belong to clause 2: ${JSON.stringify(clause.ids)}`)
  assert.ok(clause.quota >= 1)
  assert.equal(clause.status, 'hit')
  // The main selection covers clause 1, so its ids/hits are real too.
  assert.ok(result.clauseInfo[0].hits >= 1)
  assert.equal(result.clauseInfo[0].hits, result.clauseInfo[0].ids.length)
})

test('F-04-01: hits are never fabricated — a clause whose candidates are all blocked reports 0', () => {
  const { engine } = makeEngine(guaranteeFolders())
  const blocked = new Set(guaranteeFolders().filter((folder) => folder.id.startsWith('mem-gb-')).map((folder) => folder.id))
  const result = engine.recall(GUARANTEE_TEXT, {}, { clauses: GUARANTEE_CLAUSES, quota: 20, blockIds: blocked })
  const clause = result.clauseInfo[1]
  assert.equal(clause.hits, 0, `hits must be the real count, got ${clause.hits} (Math.max(1, …) padding is the F-04-01 bug)`)
  assert.deepEqual(clause.ids, [])
  assert.equal(clause.status, 'miss')
  assert.equal(result.additions.filter((addition) => addition.id.startsWith('mem-gb-')).length, 0)
})

test("F-04-01 contrast: deterministic mode keeps the documented 1 guaranteed slot with real hits", () => {
  const { engine } = makeEngine(guaranteeFolders('mem-det'), { recall: { mode: 'deterministic' } })
  const clauses = ['部署 docker 端口的参数到底是多少', '数据库迁移最终方案是什么']
  const result = engine.recall(clauses.join('？') + '？', {}, { clauses, quota: 20 })
  const bAdds = result.additions.filter((addition) => addition.id.startsWith('mem-det-gb-'))
  assert.equal(bAdds.length, 1)
  assert.equal(result.clauseInfo[1].hits, 1)
  assert.deepEqual(result.clauseInfo[1].ids, [bAdds[0].id])
})

// ---------------------------------------------------------------------------
// F-04-02 — reserveSlots really reserves quota slots for the assistant channel
// ---------------------------------------------------------------------------

function crowdFolders() {
  const folders = []
  for (let index = 0; index < 40; index += 1) {
    folders.push({
      id: `mem-crowd-a-${String(index).padStart(2, '0')}`,
      keywords: ['部署'],
      alpha: 0.9,
      createdAt: Date.parse('2026-10-28T00:00:00+08:00') + index * 1000,
      text: `[CROWD-A-${index}] 部署参数`,
    })
  }
  for (let index = 0; index < 20; index += 1) {
    folders.push({
      id: `mem-crowd-asst-${String(index).padStart(2, '0')}`,
      keywords: ['记录'],
      alpha: 0.1,
      createdAt: Date.parse('2026-11-04T00:00:00+08:00') + index * 1000,
      text: `[CROWD-ASSISTANT-${index}] 助手说过咖啡豆的事`,
      assistantKeywords: ['咖啡'],
    })
  }
  return folders
}

test('F-04-02: reserveSlots=2 injects an assistant memory a crowded round would drop; 0 vs 2 differ', () => {
  const run = (reserveSlots) => {
    const { engine } = makeEngine(crowdFolders(), {
      recall: { mode: 'fair', firstGenMax: 20, assistantSaid: { enabled: true, reserveSlots } },
    })
    return engine.recall('你说过咖啡的事吗？部署参数怎么配？', {}, { assistantSaid: true, quota: 20 })
  }

  const two = run(2)
  const zero = run(0)
  const asstIn = (result) => result.additions.filter((addition) => addition.id.startsWith('mem-crowd-asst-')).length

  assert.ok(asstIn(two) >= 1, 'the reserved assistant slots must survive the crowded ordinary ranking')
  assert.ok(Number(two.stats.assistantPicks) >= 1, JSON.stringify(two.stats))
  // reserveSlots=0 never runs the reserved pass (the channel can still surface a
  // few assistant memories through the normal low-α rotation lane — that is the
  // pre-existing fair behaviour, not the reservation).
  assert.equal(zero.stats.assistantPicks, 0)
  assert.notDeepEqual(idsOf(two), idsOf(zero), 'reserveSlots=0 and reserveSlots=2 must not produce identical rounds')
})

// ---------------------------------------------------------------------------
// F-04-03 — assistantSaid.enabled=false is a hard switch (request + index)
// ---------------------------------------------------------------------------

test('F-04-03: assistantSaid.enabled=false disables the explicit request and the index build', () => {
  const specs = [
    {
      id: 'mem-asst',
      keywords: ['部署'],
      assistantKeywords: ['咖啡', '少喝咖啡'],
    },
  ]
  const off = makeEngine(specs, {
    recall: { mode: 'fair', firstGenMax: 10, assistantSaid: { enabled: false, reserveSlots: 2 } },
  })
  const index = off.engine.recallIndex()
  assert.equal(index.assistantKeywordCount, 0, 'DESIGN §4.1: no assistant postings when the channel is disabled')
  assert.deepEqual([...index.postings.keys()].filter((key) => key.includes('asst:')), [])
  assert.equal(index.assistantAutomaton.patterns.length, 0)

  const result = off.engine.recall('咖啡', {}, { assistantSaid: true })
  assert.deepEqual(idsOf(result), [], 'the explicit assistantSaid:true request must not bypass the switch')
  assert.equal(result.assistantSaid, false)

  // Control: with the channel enabled the same query finds the memory.
  const on = makeEngine(specs, { recall: { mode: 'fair', firstGenMax: 10, assistantSaid: { enabled: true, reserveSlots: 2 } } })
  const found = on.engine.recall('咖啡', {}, { assistantSaid: true })
  assert.deepEqual(idsOf(found), ['mem-asst'])
  assert.equal(found.assistantSaid, true)
  assert.ok(on.engine.recallIndex().assistantKeywordCount >= 1)
})

// ---------------------------------------------------------------------------
// F-04-04 — firstGenMax=0 kill switch survives the adaptive complex quota
// ---------------------------------------------------------------------------

test('F-04-04: recallQuota returns 0 for firstGenMax=0 even for a complex question', () => {
  const { engine } = makeEngine(
    Array.from({ length: 30 }, (_, index) => ({
      id: `mem-q-${String(index).padStart(2, '0')}`,
      keywords: ['部署', 'docker', '端口', '参数'],
    })),
    {
      recall: {
        mode: 'fair',
        firstGenMax: 0,
        adaptiveQuota: { enabled: true, complexQuota: 20, complexMinClauses: 2, complexMinChars: 160, complexMinKeywords: 8 },
      },
    },
  )
  assert.equal(engine.recallQuota({ complex: true, clauses: ['a', 'b'], chars: 200, keywords: [] }), 0)
  assert.equal(engine.recallQuota({ complex: false }), 0)

  const complexText = '部署 docker 端口用哪个参数？数据库迁移的端口参数编号是多少？'
  const quota = engine.recallQuota({ complex: true })
  const killed = engine.recall(complexText, {}, { quota })
  assert.equal(killed.additions.length, 0, 'firstGenMax=0 is documented as "recall disabled"')

  // The explicit `memory_recall limit` path is a different knob and stays intact.
  const explicit = engine.recall('部署 docker 端口 参数', {}, { limit: 2 })
  assert.equal(explicit.additions.length, 2)
})

// ---------------------------------------------------------------------------
// F-04-01 — model-visible block: the clause line matches the real injected set
// ---------------------------------------------------------------------------

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const clone = (value) => JSON.parse(JSON.stringify(value))

class FakeSession {
  constructor({ contextWindow = 20000, id = 'session-audit-fix-engine' } = {}) {
    this.id = id
    this.header = { origin: 'main' }
    this.windowTokens = contextWindow
    this.events = []
    this.nodes = []
    this.replaceGeneration = 0
    this.contentGeneration = 0
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
    const event = { type, seq, time: Date.now(), data: clone(data) }
    if (SURFACE_TYPES.has(type)) {
      assert.ok(options.surfaceOp === 'append', 'audit-fix fixtures only append surface nodes')
      this.events.push(event)
      this.nodes.push(seq)
      this.contentGeneration += 1
      return event
    }
    this.events.push(event)
    return event
  }
}

const userMessage = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** Minimal fake DSH context: prompt sections + tools + a static token meter. */
function makeContext() {
  const capture = { sections: [], tools: [], logs: [] }
  const toolsService = {
    register(definition) {
      capture.tools.push({ definition, disposed: false })
      return () => {}
    },
  }
  const ctx = {
    logger: {
      info: (message) => capture.logs.push(['info', String(message)]),
      warn: (message) => capture.logs.push(['warn', String(message)]),
      debug: (message) => capture.logs.push(['debug', String(message)]),
    },
    tokenMeter: { measure: () => ({ totalTokens: 0, nodes: [] }) },
    systemPrompt: {
      section(options) {
        capture.sections.push(options)
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    effect(callback) {
      return callback()
    },
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

const recallSectionText = (capture, session) =>
  capture.sections.find((section) => section.name === 'dsh-rofm:recall')?.text({ agent: { session } }) ?? ''

/** Write one real folder + index entry (context.json + meta.json + index.json). */
function writeFolderFixture(memoryDir, id, options = {}) {
  const {
    alpha = 0.5,
    beta = 0,
    keywords = ['fixture'],
    text = 'FIXTURE-MEMORY-CONTENT',
    createdAt = Date.now(),
  } = options
  const folderDir = path.join(memoryDir, id)
  fs.mkdirSync(folderDir, { recursive: true })
  const messages = [{ role: 'user', content: text }]
  fs.writeFileSync(path.join(folderDir, 'context.json'), JSON.stringify({ version: 1, id, createdAt, messages }))
  fs.writeFileSync(
    path.join(folderDir, 'meta.json'),
    JSON.stringify({
      version: 1,
      id,
      createdAt,
      alpha,
      beta,
      keywords,
      title: text.slice(0, 40),
      scored: true,
      alphaSource: 'heuristic',
      betaSource: 'default',
      keywordsSource: 'heuristic',
      stats: { messages: messages.length, chars: text.length, tokens: 10 },
    }),
  )
  const indexPath = path.join(memoryDir, 'index.json')
  const index = fs.existsSync(indexPath)
    ? JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    : { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  index.folders = (index.folders ?? []).filter((folder) => folder.id !== id)
  index.folders.push({
    id,
    createdAt,
    alpha,
    beta,
    keywords,
    chars: text.length,
    tokens: 10,
    messageCount: 1,
    title: text.slice(0, 40),
    scored: true,
  })
  fs.writeFileSync(indexPath, JSON.stringify(index))
}

test('F-04-01 model-visible block: [MEM-B-] ≥ 1 and 「已找到 N 条」 equals clauseInfo[1].hits', async () => {
  const { RofmPlugin } = await import('../lib/plugin.js')
  const dir = tempDir()
  const memoryDir = path.join(dir, 'memory')
  fs.mkdirSync(memoryDir, { recursive: true })
  for (let index = 0; index < 40; index += 1) {
    writeFolderFixture(memoryDir, `mem-ga-${String(index).padStart(2, '0')}`, {
      alpha: 0.9,
      keywords: ['部署', 'docker', '端口'],
      createdAt: Date.parse('2026-10-28T00:00:00+08:00') + index * 1000,
      text: `[MEM-A-${index}] 部署 docker 端口参数 ${index}`,
    })
  }
  for (let index = 0; index < 10; index += 1) {
    writeFolderFixture(memoryDir, `mem-gb-${String(index).padStart(2, '0')}`, {
      alpha: 0.9,
      keywords: ['迁移'],
      createdAt: Date.parse('2026-11-02T00:00:00+08:00') + index * 1000,
      text: `[MEM-B-${index}] 数据库迁移最终方案 ${index}`,
    })
  }

  const session = new FakeSession({ contextWindow: 128000 })
  const { ctx, capture } = makeContext()
  const plugin = new RofmPlugin(ctx, {
    enabled: true,
    storage: { dir: memoryDir, perSession: false },
    compress: { contextWindowTokens: 0, allowSmallWindow: true, preStepEnabled: false },
  })
  plugin.start()
  const message = userMessage('u-clause-audit', '部署 docker 端口的参数到底是多少？数据库迁移最终方案是什么？')
  session.append('user/message', message, { surfaceOp: 'append' })
  plugin.onInboxInserted({ agent: { session }, message })

  const block = recallSectionText(capture, session)
  const info = plugin.currentQueryInfo(session)
  assert.ok(info && Array.isArray(info.clauseInfo) && info.clauseInfo.length === 2, JSON.stringify(info?.clauseInfo))

  // 1) the block really carries a clause-2 memory.
  assert.ok((block.match(/\[MEM-B-/g) ?? []).length >= 1, block)
  // 2) the clause ids all belong to clause 2 / 3) hits is their real count.
  const clause = info.clauseInfo[1]
  assert.ok(clause.ids.every((id) => id.startsWith('mem-gb-')), JSON.stringify(clause))
  assert.equal(clause.hits, clause.ids.length)
  assert.ok(clause.hits >= 1)
  // 4) the model-visible 「已找到 N 条」 agrees with the real hit count.
  const clauseLine = block.split('\n').find((line) => line.startsWith('- 子问题 2'))
  assert.ok(clauseLine, block)
  const claimed = Number((clauseLine.match(/已找到 (\d+) 条相关记忆/) ?? [])[1])
  assert.equal(claimed, clause.hits, clauseLine)
})

// ---------------------------------------------------------------------------
// F-04-05 — legacy mode never claims the assistant channel was searched
// ---------------------------------------------------------------------------

test('F-04-05: legacy mode reports assistantSaid=false for an explicit assistant request', () => {
  const { engine } = makeEngine(
    [{ id: 'mem-asst', keywords: ['部署'], assistantKeywords: ['咖啡'] }],
    { recall: { mode: 'legacy', firstGenMax: 10, assistantSaid: { enabled: true, reserveSlots: 2 } } },
  )
  const result = engine.recall('咖啡', {}, { assistantSaid: true })
  assert.equal(result.mode, 'legacy')
  assert.deepEqual(idsOf(result), [], 'the legacy selector never scans the assistant channel')
  assert.equal(result.assistantSaid, false, 'legacy must not claim the assistant channel was searched')
})
