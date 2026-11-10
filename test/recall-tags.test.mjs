/**
 * v1.5.0 recall-engine tests: tag / time-tag / assistant-said / multi-clause
 * (docs/SPEC.md §6.10–§6.12, DESIGN-1.5.0 §4).
 *
 * Every test builds a hermetic `MemoryEngine` on a fresh temp memory dir (the
 * same `writeFolder` + load pattern as test/recall.test.mjs) — the real `memory/`
 * store is never read or written. Covered here:
 *   - `locations` / `persons` hard filters (same kind OR, cross kind AND);
 *   - `events` multi-label OR (including the legacy `event` + `events` merge);
 *   - tag filters ANDed with keywords and with the v1.4.0 event filter;
 *   - fuzzy `timeText` -> time-tag filtering, and time tags beating `eventStart`;
 *   - the assistant-utterance channel (`assistantKeywords`) only when requested;
 *   - multi-clause recall (`clauses` + `quota` + `clauseInfo`);
 *   - `request.quota=20` actually releasing more entries;
 *   - `missType='tag' | 'time-tag'` classification.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { MemoryEngine, detectQueryTimes, loadConfig, writeFolder } from '../engine/index.js'

const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-recall-tags-'))
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

/** Tag / time-tag / event / time groups all enforcing, fair recall, wide budget. */
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
 * Write one folder per spec, then load a fresh engine over that dir.
 * A spec may carry `locations` / `persons` / `events` / `timeTags` /
 * `assistantKeywords` / `eventStart` (all optional meta fields).
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
      ...(spec.eventStart === undefined ? {} : { eventStart: spec.eventStart, eventEnd: spec.eventStart + 1 }),
    }
    writeFolder(dir, { id: spec.id, meta, messages })
  }
  const cfg = loadConfig(undefined, { storage: { dir }, ...overrides(extraOverrides) })
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg, rng: () => 0 })
  engine.load()
  return { engine, cfg, dir }
}

const idsOf = (result) => result.additions.map((addition) => addition.id).sort()
const OUTSIDE = Date.UTC(2020, 0, 1) // far away from any fuzzy-time fixture window

// ---------------------------------------------------------------------------
// locations / persons hard filters
// ---------------------------------------------------------------------------

test('locations: same-kind values are ORed, kinds are ANDed, and tagInfo reports the filter', () => {
  const { engine } = makeEngine([
    { id: 'mem-a', locations: ['北京'], persons: ['小明'] },
    { id: 'mem-b', locations: ['上海'], persons: ['小明'] },
    { id: 'mem-c', locations: ['北京', '上海'], persons: ['小红'] },
    { id: 'mem-d', locations: ['广州'], persons: ['小明'] },
  ])

  const beijing = engine.recall('docker', {}, { locations: ['北京'] })
  assert.deepEqual(idsOf(beijing), ['mem-a', 'mem-c'], 'a folder tagged with either 北京 or 上海 matches 北京')
  assert.equal(beijing.missType, null)
  assert.deepEqual(beijing.tagInfo.requested.location, ['北京'])
  assert.deepEqual(beijing.tagInfo.matched.location, [{ label: '北京', count: 2 }])
  assert.equal(beijing.tagInfo.enforced, true)
  assert.equal(beijing.tagInfo.status, 'exact')

  const xiaoming = engine.recall('docker', {}, { persons: ['小明'] })
  assert.deepEqual(idsOf(xiaoming), ['mem-a', 'mem-b', 'mem-d'])

  const everyone = engine.recall('docker', {}, { persons: ['小明', '小红'] })
  assert.deepEqual(idsOf(everyone), ['mem-a', 'mem-b', 'mem-c', 'mem-d'], 'same-kind OR across two persons')

  const both = engine.recall('docker', {}, { locations: ['北京'], persons: ['小红'] })
  assert.deepEqual(idsOf(both), ['mem-c'], 'cross-kind filters are ANDed')

  const anded = engine.recall('docker', {}, { locations: ['北京'], persons: ['小明'] })
  assert.deepEqual(idsOf(anded), ['mem-a'], '北京 AND 小明 only matches the folder carrying both')
})

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

test('events: multiple labels are ORed; the legacy event + events pair is merged', () => {
  const { engine } = makeEngine([
    { id: 'mem-a', events: ['日本旅行'] },
    { id: 'mem-b', events: ['大阪旅行'] },
    { id: 'mem-c', events: ['日本旅行', '大阪旅行'] },
  ])

  const one = engine.recall('docker', {}, { events: ['日本旅行'] })
  assert.deepEqual(idsOf(one), ['mem-a', 'mem-c'])
  assert.equal(one.eventInfo.status, 'exact')
  assert.equal(one.eventInfo.label, '日本旅行')

  const both = engine.recall('docker', {}, { events: ['日本旅行', '大阪旅行'] })
  assert.deepEqual(idsOf(both), ['mem-a', 'mem-b', 'mem-c'], 'multi-event query is an OR-set')

  // The adapter forwards both the v1.4.0 `event` string and the v1.5.0 `events`
  // array; the engine merges them into one OR-set.
  const merged = engine.recall('docker', {}, { event: '大阪旅行', events: ['日本旅行'] })
  assert.deepEqual(idsOf(merged), ['mem-a', 'mem-b', 'mem-c'])

  const noMatch = engine.recall('docker', {}, { events: ['火星旅行'] })
  assert.deepEqual(noMatch.additions, [])
  assert.equal(noMatch.missType, 'event')
})

test('tag filters are ANDed with keywords and with the event filter', () => {
  const { engine } = makeEngine([
    { id: 'mem-a', keywords: ['docker'], locations: ['北京'], events: ['日本旅行'] },
    { id: 'mem-b', keywords: ['docker'], locations: ['北京'], events: ['大阪旅行'] },
    { id: 'mem-c', keywords: ['docker'], locations: ['上海'], events: ['日本旅行'] },
    { id: 'mem-d', keywords: ['部署'], locations: ['北京'], events: ['日本旅行'] },
  ])

  const locationAndKeyword = engine.recall('docker', {}, { locations: ['北京'] })
  assert.deepEqual(idsOf(locationAndKeyword), ['mem-a', 'mem-b'], 'keyword AND location')
  assert.ok(locationAndKeyword.stats.tagFiltered >= 1, 'the tag filter is counted in the telemetry')

  const locationAndEvent = engine.recall('docker', {}, { locations: ['北京'], events: ['日本旅行'] })
  assert.deepEqual(idsOf(locationAndEvent), ['mem-a'], 'location AND event AND keyword')

  const browse = engine.recall('', {}, { locations: ['北京'] })
  assert.equal(browse.browse, true, 'a tag-only query is a browse (lookup, not a recall decision)')
  assert.deepEqual(idsOf(browse), ['mem-a', 'mem-b', 'mem-d'])
  assert.equal(browse.missType, null)
})

// ---------------------------------------------------------------------------
// timeText / time tags
// ---------------------------------------------------------------------------

/** The 下周二 window, resolved exactly like the engine resolves it. */
function nextTuesdayWindow(cfg) {
  const windows = detectQueryTimes('下周二', Date.now(), cfg)
  assert.equal(windows.length, 1, 'the relative-time parser must resolve 下周二')
  return windows
}

test('timeText: a fuzzy expression filters on time tags, and a time tag beats eventStart', () => {
  const probeCfg = loadConfig(undefined, overrides())
  const windows = nextTuesdayWindow(probeCfg)
  const { engine } = makeEngine([
    // Tag hits the fuzzy window while eventStart is far outside it: the tag wins.
    { id: 'mem-a', keywords: ['docker'], timeTags: windows, eventStart: OUTSIDE },
    // No time tags and eventStart outside the window: the interval semantics exclude it.
    { id: 'mem-b', keywords: ['docker'], eventStart: OUTSIDE },
  ])

  const result = engine.recall('docker', {}, { timeText: '下周二' })
  assert.deepEqual(idsOf(result), ['mem-a'], 'only the time-tagged folder matches')
  assert.equal(result.missType, null)
  assert.equal(result.timeTagInfo.status, 'exact')
  assert.deepEqual(result.timeTagInfo.labels, ['下周二'])
  assert.equal(result.timeTagInfo.enforced, true)
  assert.equal(result.timeTagInfo.windows.length, 1)
  assert.equal(result.timeTagInfo.windows[0].label, '下周二')
})

test('timeText: no candidate in the fuzzy window is missType=time-tag', () => {
  const probeCfg = loadConfig(undefined, overrides())
  const windows = nextTuesdayWindow(probeCfg)
  // Same window fixture as above, but the only folder is the untagged one.
  const { engine } = makeEngine([{ id: 'mem-b', keywords: ['docker'], eventStart: OUTSIDE }])
  const result = engine.recall('docker', {}, { timeText: '下周二' })
  assert.deepEqual(result.additions, [])
  assert.equal(result.missType, 'time-tag', 'the fuzzy-time filter — not the keywords — excluded the candidate')
  assert.deepEqual(result.timeTagInfo.labels, ['下周二'])
  assert.equal(windows.length, 1)
})

// ---------------------------------------------------------------------------
// assistant-said channel
// ---------------------------------------------------------------------------

test('assistantSaid: assistant utterances are recallable only when the channel is requested', () => {
  const { engine } = makeEngine([
    // The user-facing keywords do not contain 咖啡; only the assistant said it.
    { id: 'mem-a', keywords: ['部署', '端口'], assistantKeywords: ['咖啡', '少喝咖啡'] },
  ])

  const off = engine.recall('咖啡', {}, {})
  assert.deepEqual(off.additions, [], 'the default path never scans assistant utterances')
  assert.equal(off.missType, 'keyword')

  const on = engine.recall('咖啡', {}, { assistantSaid: true })
  assert.deepEqual(idsOf(on), ['mem-a'], 'assistantKeywords is searched when assistantSaid=true')
  assert.equal(on.assistantSaid, true)
  assert.equal(on.missType, null)

  // The ordinary keyword path is untouched by the extra channel.
  const normal = engine.recall('部署', {}, {})
  assert.deepEqual(idsOf(normal), ['mem-a'])
})

// ---------------------------------------------------------------------------
// multi-clause recall
// ---------------------------------------------------------------------------

test('multi-clause recall: every clause with candidates is covered and clauseInfo is reported', () => {
  const { engine } = makeEngine([
    { id: 'mem-a1', keywords: ['端口配置', 'docker'], alpha: 0.9 },
    { id: 'mem-a2', keywords: ['端口配置', 'nginx'], alpha: 0.8 },
    { id: 'mem-b1', keywords: ['部署时间', '发布'], alpha: 0.85 },
    { id: 'mem-c1', keywords: ['其他', '无关'], alpha: 0.7 },
  ])

  const result = engine.recall('端口配置怎么样？部署时间呢', {}, {
    clauses: ['端口配置', '部署时间'],
    quota: 6,
  })

  assert.ok(result.additions.length > 0)
  assert.ok(result.additions.length <= 6, `the quota bounds the whole page (${result.additions.length})`)
  assert.equal(result.page.limit, 6)
  const added = idsOf(result)
  assert.ok(added.some((id) => id.startsWith('mem-a')), 'clause 1 got a slot')
  assert.ok(added.includes('mem-b1'), 'clause 2 got a slot')

  assert.ok(Array.isArray(result.clauseInfo))
  assert.equal(result.clauseInfo.length, 2)
  assert.deepEqual(
    result.clauseInfo.map((clause) => clause.index),
    [0, 1],
  )
  assert.deepEqual(
    result.clauseInfo.map((clause) => clause.text),
    ['端口配置', '部署时间'],
  )
  for (const clause of result.clauseInfo) {
    assert.ok(Number.isFinite(clause.hits) && clause.hits >= 1, `clause coverage hits (${JSON.stringify(clause)})`)
    assert.equal(typeof clause.status, 'string')
  }
})

test('multi-clause recall: the quota still hard-bounds a tiny page', () => {
  const { engine } = makeEngine([
    { id: 'mem-a1', keywords: ['端口配置', 'docker'] },
    { id: 'mem-b1', keywords: ['部署时间', '发布'] },
  ])
  const result = engine.recall('端口配置？部署时间', {}, { clauses: ['端口配置', '部署时间'], quota: 1 })
  assert.ok(result.additions.length <= 1, `quota=1 must not return more than one entry (${result.additions.length})`)
  assert.equal(result.page.limit, 1)
  assert.equal(result.clauseInfo.length, 2, 'the clause report still covers both sub-questions')
})

// ---------------------------------------------------------------------------
// adaptive quota
// ---------------------------------------------------------------------------

test('request.quota=20 releases a full 20-entry page (adaptive quota path)', () => {
  const specs = []
  for (let index = 0; index < 25; index += 1) {
    specs.push({ id: `mem-${String(index).padStart(4, '0')}`, keywords: ['docker', '部署'], alpha: 0.9 - index * 0.01 })
  }
  const { engine } = makeEngine(specs)

  const adaptive = engine.recall('docker 部署', {}, { quota: 20 })
  assert.equal(adaptive.additions.length, 20, 'the complex-question quota admits 20 entries')
  assert.equal(adaptive.page.limit, 20)
  assert.equal(adaptive.page.hasMore, true, '25 candidates, 20 returned -> more pages')

  const baseline = engine.recall('docker 部署', {}, {})
  assert.equal(baseline.additions.length, 10, 'without the adaptive quota firstGenMax=10 still applies')
})

// ---------------------------------------------------------------------------
// miss classification
// ---------------------------------------------------------------------------

test("missType='tag' when keyword candidates exist but the tag filter excludes them", () => {
  const { engine } = makeEngine([
    { id: 'mem-a', keywords: ['部署'], locations: ['北京'] },
    { id: 'mem-b', keywords: ['docker'], locations: ['上海'] },
  ])

  // 北京 exists (exact tag) but no 北京 folder matches the keyword.
  const filtered = engine.recall('docker', {}, { locations: ['北京'] })
  assert.deepEqual(filtered.additions, [])
  assert.equal(filtered.missType, 'tag')
  assert.equal(filtered.tagInfo.status, 'exact')
  assert.ok(filtered.stats.tagFiltered >= 1, JSON.stringify(filtered.stats))

  // An unknown label is also a tag miss and lists the unknown label.
  const unknown = engine.recall('docker', {}, { locations: ['杭州'] })
  assert.deepEqual(unknown.additions, [])
  assert.equal(unknown.missType, 'tag')
  assert.equal(unknown.tagInfo.status, 'unknown')
  assert.deepEqual(unknown.tagInfo.unknown, [{ kind: 'location', label: '杭州' }])
})
