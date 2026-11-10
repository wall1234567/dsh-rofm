/**
 * Audit-fix regression tests for dsh-rofm 1.5.0 findings F-02-03 / F-02-07 /
 * F-03-01 (see D:/Deepseek/rofm-audit-1.5/FINAL-REPORT.md).
 *
 * The tests only drive public production APIs — engine/tag-index.js,
 * engine/relative-time.js and a real `MemoryEngine` loaded from a hermetic temp
 * memory dir — so every assertion describes behaviour an archive/recall
 * round-trip actually produces (no hand-written intermediate fields).
 *
 * F-02-03  a single-character CJK label ("家") must not be detected inside
 *          ordinary words (大家/国家/专家/人家), while 我家/我家里/家里/在家/
 *          回家 are mentions; labels of two or more characters are unchanged.
 * F-02-07  unscored/pending folders never enter the tag or time-tag index, so
 *          their labels cannot hard-filter automatic recall down to zero.
 * F-03-01  `timeTag.maxSpanDays` is a real cap: an expression whose produced
 *          window is wider than the cap yields no tag at all; the default 366
 *          keeps 「一年后」 (365 days) while `maxSpanDays: 1` drops it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { MemoryEngine, analyzeQuery, loadConfig, writeFolder } from '../engine/index.js'
import { buildTagIndex, buildTimeTagIndex, detectTagMentions } from '../engine/tag-index.js'
import { extractTimeTags, parseRelativeTimes } from '../engine/relative-time.js'

const ASIA = 'Asia/Shanghai'
const DAY = 86400000
/** 2026-11-07 (Saturday) 10:00 Asia/Shanghai — the audit's deterministic anchor. */
const NOW = Date.parse('2026-11-07T10:00:00+08:00')

// ---------------------------------------------------------------------------
// hermetic engine fixtures (fresh temp memory dir, real load path)
// ---------------------------------------------------------------------------

const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-audit-tags-time-'))
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

/**
 * Write one folder per spec and load a fresh engine over that dir. A spec may
 * carry `locations` / `persons` / `events` / `timeTags` / `scored:false`
 * (pending folder) — all through the production `writeFolder` + `load()` path.
 */
function makeEngine(specs, overrides = {}) {
  const dir = tempDir()
  for (const spec of specs) {
    const messages = Array.isArray(spec.messages)
      ? spec.messages
      : [{ role: 'user', content: spec.text ?? '内容' }]
    const pending = spec.scored === false
    const meta = {
      version: 1,
      createdAt: spec.createdAt ?? 1_700_000_000_000,
      alpha: pending ? 0 : spec.alpha ?? 0.9,
      beta: pending ? 0 : spec.beta ?? 3,
      keywords: pending ? [] : spec.keywords ?? ['部署'],
      title: (spec.keywords ?? ['部署']).join(' '),
      stats: { messages: messages.length, chars: 40, tokens: 20 },
      ...(pending ? { scored: false, alphaSource: 'pending', betaSource: 'pending', keywordsSource: 'pending' } : {}),
      ...(spec.locations === undefined ? {} : { locations: spec.locations }),
      ...(spec.persons === undefined ? {} : { persons: spec.persons }),
      ...(spec.events === undefined ? {} : { events: spec.events }),
      ...(spec.timeTags === undefined ? {} : { timeTags: spec.timeTags, timeTagSource: 'messages' }),
    }
    writeFolder(dir, { id: spec.id, meta, messages })
  }
  const cfg = loadConfig(undefined, {
    storage: { dir },
    recall: { mode: 'fair', firstGenMax: 10, ...(overrides.recall ?? {}) },
    location: { mode: 'constrain', ...(overrides.location ?? {}) },
    person: { mode: 'constrain', ...(overrides.person ?? {}) },
    event: { mode: 'constrain', ...(overrides.event ?? {}) },
    time: { mode: 'constrain', timezone: ASIA, ...(overrides.time ?? {}) },
    timeTag: { mode: 'constrain', ...(overrides.timeTag ?? {}) },
  })
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg, rng: () => 0 })
  engine.load()
  return { engine, cfg, dir }
}

const idsOf = (result) => result.additions.map((addition) => addition.id).sort()

/** Tag filter object as the plugin would build it (nothing when no mention). */
function tagFilterFor(labels) {
  return Array.isArray(labels) && labels.length ? { locations: labels } : {}
}

// ---------------------------------------------------------------------------
// F-02-03  single-character CJK tag mentions need a word boundary
// ---------------------------------------------------------------------------

function homeIndex() {
  return buildTagIndex([{ id: 'mem-home', locations: ['家'] }])
}

function homeMentions(text) {
  return detectTagMentions(homeIndex(), text).location
}

test('F-02-03 detectTagMentions: 大家/国家/专家/人家 are not mentions of 「家」', () => {
  assert.deepEqual(homeMentions('大家好，部署进展怎么样？'), [])
  for (const text of ['国家', '专家', '大家', '人家']) {
    assert.deepEqual(homeMentions(text), [], text)
  }
  // 「家」 inside a Latin word is still not a word boundary.
  assert.deepEqual(homeMentions('abc家'), [])
})

test('F-02-03 detectTagMentions: 我家/我家里/家里/在家/回家 are mentions of 「家」', () => {
  for (const text of ['我家', '我家里', '家里', '在家', '回家']) {
    assert.deepEqual(homeMentions(text), ['家'], text)
  }
  // The documented pronoun whitelist (我家/你家/他家…) and the motion/position
  // whitelist (在家/回家/到家/去家/来家/进家/出家).
  for (const text of ['你家', '他家', '她家', '咱家', '俺家']) {
    assert.deepEqual(homeMentions(text), ['家'], text)
  }
  for (const text of ['在家', '回家', '到家', '去家', '来家', '进家', '出家']) {
    assert.deepEqual(homeMentions(text), ['家'], text)
  }
  // A non-word character before the tag is a boundary too ("，家").
  assert.deepEqual(homeMentions('，家'), ['家'])
})

test('F-02-03 detectTagMentions: an invalid occurrence is skipped, the next valid one wins', () => {
  // First 「家」 is inside 大家 (invalid); the second one follows 我 (valid).
  const later = detectTagMentions(homeIndex(), '大家好，我家在这')
  assert.deepEqual(later.location, ['家'])
  assert.deepEqual(later.hits, [{ kind: 'location', label: '家', index: 5 }])

  // First 「家」 is inside 大家 (invalid); the second one follows 回 (valid).
  const motion = detectTagMentions(homeIndex(), '大家回家')
  assert.deepEqual(motion.location, ['家'])
  assert.deepEqual(motion.hits, [{ kind: 'location', label: '家', index: 3 }])
})

test('F-02-03 detectTagMentions: two-or-more-character labels keep the old substring rule', () => {
  const index = buildTagIndex([
    { id: 'mem-home', locations: ['家', '北京'] },
    { id: 'mem-family', locations: ['小明家'] },
  ])
  // 2+ char labels are still plain substring matches, even mid-word.
  assert.deepEqual(detectTagMentions(index, '我们到北京了').location, ['北京'])
  assert.deepEqual(detectTagMentions(index, '大家的北京').location, ['北京'])
  assert.deepEqual(detectTagMentions(index, '小明家里的公司').location, ['小明家'])
  // A longer label still claims its span before the single-character 「家」.
  const overlap = detectTagMentions(index, '小明家')
  assert.deepEqual(overlap.location, ['小明家'])
  assert.equal(overlap.hits.length, 1)
})

test('F-02-03 detectTagMentions: the context rule applies to every tag kind, not just locations', () => {
  const index = buildTagIndex([{ id: 'mem-person', persons: ['明'] }])
  assert.deepEqual(detectTagMentions(index, '聪明人').person, [])
  assert.deepEqual(detectTagMentions(index, '说明').person, [])
  assert.deepEqual(detectTagMentions(index, '我明白了').person, ['明'])
})

test('F-02-03 engine: 大家好 must not hard-filter auto recall on location 「家」', () => {
  const { engine, cfg } = makeEngine([
    { id: 'mem-home', keywords: ['部署'], locations: ['家'] },
    { id: 'mem-plain', keywords: ['部署'] },
  ])
  const analysis = analyzeQuery({ text: '大家好，部署进展怎么样？', cfg, now: NOW, tagIndex: engine.tagIndex() })
  assert.deepEqual(analysis.tags.location, [], '大家 must not be analysed as a location mention')
  // The plugin forwards the analysed mentions as the hard location filter; with
  // no mention both keyword-relevant memories survive.
  const auto = engine.recall('部署', {}, tagFilterFor(analysis.tags.location))
  assert.deepEqual(idsOf(auto), ['mem-home', 'mem-plain'])
  assert.notEqual(auto.stats.matchedFolders, 0)
  // Control: an explicit location filter still works.
  assert.deepEqual(idsOf(engine.recall('部署', {}, { locations: ['家'] })), ['mem-home'])
  // 「我家」 is a real mention.
  const mine = analyzeQuery({ text: '我家部署怎么样了', cfg, now: NOW, tagIndex: engine.tagIndex() })
  assert.deepEqual(mine.tags.location, ['家'])
  assert.deepEqual(idsOf(engine.recall('部署', {}, tagFilterFor(mine.tags.location))), ['mem-home'])
})

// ---------------------------------------------------------------------------
// F-02-07  unscored/pending folders must not enter the tag indexes
// ---------------------------------------------------------------------------

test('F-02-07 buildTagIndex: scored === false folders are skipped entirely', () => {
  const index = buildTagIndex([
    { id: 'mem-scored', scored: true, locations: ['北京'] },
    { id: 'mem-legacy', locations: ['北京'] }, // no `scored` field = recallable
    { id: 'mem-pending', scored: false, locations: ['北京', '上海'], persons: ['小明'], events: ['旅行'] },
    { id: 'mem-pending-only', scored: false, locations: ['广州'] },
  ])
  assert.equal(index.folderCount, 2, 'only recallable folders count')
  assert.deepEqual([...index.byKind.location.keys()], ['北京'])
  assert.deepEqual([...index.byKind.location.get('北京').ids].sort(), ['mem-legacy', 'mem-scored'])
  assert.equal(index.byKind.location.get('北京').count, 2)
  assert.equal(index.byKind.person.size, 0)
  assert.equal(index.byKind.event.size, 0)
  assert.deepEqual([...index.byId.keys()].sort(), ['mem-legacy', 'mem-scored'])

  const pendingOnly = buildTagIndex([
    { id: 'mem-pending', scored: false, locations: ['北京'], persons: ['小明'] },
  ])
  assert.equal(pendingOnly.folderCount, 0)
  assert.equal(pendingOnly.byKind.location.size, 0)
  assert.equal(pendingOnly.byKind.person.size, 0)
  assert.equal(pendingOnly.byId.size, 0)
})

test('F-02-07 buildTagIndex signature: pending-folder content cannot change the index signature', () => {
  const scored = { id: 'mem-scored', locations: ['北京'] }
  const before = buildTagIndex([scored, { id: 'mem-pending', scored: false, locations: ['北京'] }])
  const after = buildTagIndex([scored, { id: 'mem-pending', scored: false, locations: ['广州'], persons: ['小明'] }])
  assert.equal(before.signature, after.signature)
  assert.equal(before.folderCount, after.folderCount)
  // A recallable folder must change the signature (cache invalidation contract).
  const extra = buildTagIndex([scored, { id: 'mem-second', locations: ['上海'] }])
  assert.notEqual(before.signature, extra.signature)
})

test('F-02-07 buildTimeTagIndex: scored === false folders are skipped entirely', () => {
  const tag = (from, to, label) => ({ from, to, label, granularity: 'day' })
  const index = buildTimeTagIndex([
    { id: 'mem-scored', scored: true, timeTags: [tag(100, 200, '今天')] },
    { id: 'mem-legacy', timeTags: [tag(300, 400, '昨天')] },
    { id: 'mem-pending', scored: false, timeTags: [tag(500, 600, '明天')] },
    { id: 'mem-pending-only', scored: false, timeTags: [tag(700, 800, '后天')] },
  ])
  assert.equal(index.folderCount, 2)
  assert.deepEqual([...index.taggedIds].sort(), ['mem-legacy', 'mem-scored'])
  assert.equal(index.byId.has('mem-pending'), false)
  assert.equal(index.byId.has('mem-pending-only'), false)

  const before = buildTimeTagIndex([
    { id: 'mem-a', timeTags: [tag(1, 2, '今天')] },
    { id: 'mem-pending', scored: false, timeTags: [tag(3, 4, '昨天')] },
  ])
  const after = buildTimeTagIndex([
    { id: 'mem-a', timeTags: [tag(1, 2, '今天')] },
    { id: 'mem-pending', scored: false, timeTags: [tag(9, 10, '明天')] },
  ])
  assert.equal(before.signature, after.signature)
})

test('F-02-07 engine: a pending folder with locations:["北京"] must not clear auto recall', () => {
  const { engine, cfg } = makeEngine([
    { id: 'mem-scored', keywords: ['部署', '进展'] },
    { id: 'mem-pending', scored: false, locations: ['北京'] },
  ])
  const tagIndex = engine.tagIndex()
  assert.equal(tagIndex.folderCount, 1, 'the pending folder does not participate in the tag index')
  assert.equal(tagIndex.byKind.location.has('北京'), false)
  assert.equal(tagIndex.byId.has('mem-pending'), false)

  // Auto recall analyses the query against the engine tag index and only then
  // passes the detected tags as a hard filter (lib/plugin.js).
  const analysis = analyzeQuery({ text: '北京部署进展怎么样？', cfg, now: NOW, tagIndex })
  assert.deepEqual(analysis.tags.location, [], 'a pending-only tag must not become a mention')
  const auto = engine.recall('部署', {}, tagFilterFor(analysis.tags.location))
  assert.deepEqual(idsOf(auto), ['mem-scored'], 'the recallable memory survives')
  assert.notEqual(auto.stats.matchedFolders, 0)

  // Control: the old behaviour — a location filter that only the pending folder
  // carries — drops every recallable memory, which is exactly the reported bug.
  assert.deepEqual(idsOf(engine.recall('部署', {}, { locations: ['北京'] })), [])
})

test('F-02-07 engine: a pending folder with timeTags must not enter the time-tag index', () => {
  const yesterday = { from: NOW - DAY, to: NOW, label: '昨天', granularity: 'day' }
  const future = { from: NOW, to: NOW + DAY, label: '今天', granularity: 'day' }
  const { engine } = makeEngine([
    { id: 'mem-scored', timeTags: [yesterday] },
    { id: 'mem-pending', scored: false, timeTags: [future] },
  ])
  const timeIndex = engine.timeTagIndex()
  assert.equal(timeIndex.folderCount, 1)
  assert.deepEqual([...timeIndex.taggedIds], ['mem-scored'])
  assert.equal(timeIndex.byId.has('mem-pending'), false)
})

// ---------------------------------------------------------------------------
// F-03-01  timeTag.maxSpanDays is a real span cap
// ---------------------------------------------------------------------------

/** Config shaped like the plugin's (`time.timezone` + `timeTag.*`). */
function timeCfg(maxSpanDays) {
  return maxSpanDays === undefined
    ? { time: { timezone: ASIA } }
    : { time: { timezone: ASIA }, timeTag: { maxSpanDays } }
}

const spanOf = (tag) => tag.to - tag.from

test('F-03-01 parseRelativeTimes: default maxSpanDays 366 keeps 「一年后」 (365 days)', () => {
  const tags = parseRelativeTimes('一年后', NOW, timeCfg())
  assert.equal(tags.length, 1)
  assert.equal(tags[0].label, '一年后')
  assert.equal(tags[0].granularity, 'year')
  assert.equal(spanOf(tags[0]), 365 * DAY)
  // Explicit 366 keeps it; the cap is inclusive (span === cap is allowed).
  assert.deepEqual(parseRelativeTimes('一年后', NOW, timeCfg(366)), tags)
  assert.deepEqual(parseRelativeTimes('一年后', NOW, timeCfg(365)), tags)
})

test('F-03-01 parseRelativeTimes: maxSpanDays=1 drops 一年后/本周/下个月/今年', () => {
  for (const text of ['一年后', '本周', '下个月', '今年']) {
    assert.deepEqual(parseRelativeTimes(text, NOW, timeCfg(1)), [], text)
  }
  // A one-day window is still allowed at maxSpanDays=1.
  const today = parseRelativeTimes('今天', NOW, timeCfg(1))
  assert.equal(today.length, 1)
  assert.equal(spanOf(today[0]), DAY)
})

test('F-03-01 span cap measures the produced window, not the distance from the anchor', () => {
  // A week window is 7 days wide: 7 keeps it, 6 drops it.
  const week = parseRelativeTimes('本周', NOW, timeCfg(7))
  assert.equal(week.length, 1)
  assert.equal(spanOf(week[0]), 7 * DAY)
  assert.deepEqual(parseRelativeTimes('本周', NOW, timeCfg(6)), [])
  // 「999天后」 is a one-day window 999 days away — width, not distance.
  const far = parseRelativeTimes('999天后', NOW, timeCfg(1))
  assert.equal(far.length, 1)
  assert.equal(spanOf(far[0]), DAY)
})

test('F-03-01 a dropped expression does not disturb the other expressions in the text', () => {
  const tags = parseRelativeTimes('今天和一年后都要复盘', NOW, timeCfg(1))
  assert.deepEqual(tags.map((tag) => tag.label), ['今天'])
  // Default cap keeps both.
  assert.deepEqual(parseRelativeTimes('今天和一年后都要复盘', NOW, timeCfg()).map((tag) => tag.label), ['今天', '一年后'])
})

test('F-03-01 extractTimeTags (archive path) honours the span cap', () => {
  const messages = [{ content: '一年后复盘', time: NOW }]
  assert.equal(extractTimeTags(messages, NOW, timeCfg()).tags.length, 1)
  assert.deepEqual(extractTimeTags(messages, NOW, timeCfg(1)).tags, [])
  const mixed = [{ content: '今天和一年后都要复盘', time: NOW }]
  assert.deepEqual(extractTimeTags(mixed, NOW, timeCfg(1)).tags.map((tag) => tag.label), ['今天'])
})

test('F-03-01 determinism: the cap is pure and does not mutate the config', () => {
  const cfg = timeCfg(30)
  const snapshot = JSON.stringify(cfg)
  const first = parseRelativeTimes('一年后和本周', NOW, cfg)
  const second = parseRelativeTimes('一年后和本周', NOW, cfg)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(cfg), snapshot)
  assert.deepEqual(first.map((tag) => tag.label), ['本周'])
})
