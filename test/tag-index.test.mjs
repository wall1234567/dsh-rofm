/**
 * Tag index tests — location/person/event label normalization, in-memory tag
 * index, recall-time tag resolution (same-kind OR / cross-kind AND, off / index
 * / constrain), mention detection (longer labels win overlapping spans) and
 * time-tag interval resolution. Design contract §3.2 (dsh-rofm 1.5.0).
 *
 * The tests build their own minimal config objects from TAG_DEFAULTS so they do
 * not depend on the rest of engine/config.js; one integration test compares the
 * contract defaults with DEFAULT_CONFIG.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TAG_DEFAULTS,
  TAG_KINDS,
  TAG_MODES,
  TIME_GRANULARITIES,
  buildTagIndex,
  buildTimeTagIndex,
  detectTagMentions,
  normalizeTagLabel,
  normalizeTagQuery,
  resolveTagQuery,
  resolveTimeTagIds,
  tagConfig,
} from '../engine/tag-index.js'
import { DEFAULT_CONFIG } from '../engine/config.js'

// ---------------------------------------------------------------------------
// helpers / fixtures
// ---------------------------------------------------------------------------

function makeCfg(overrides = {}) {
  const cfg = {
    location: { ...TAG_DEFAULTS.location, ...(overrides.location || {}) },
    person: { ...TAG_DEFAULTS.person, ...(overrides.person || {}) },
    event: { ...TAG_DEFAULTS.event, ...(overrides.event || {}) },
    recall: { tagMentions: { enabled: true, maxTagsPerKind: 4, ...(overrides.tagMentions || {}) } },
  }
  return cfg
}

function constrainCfg(overrides = {}) {
  return makeCfg({
    location: { mode: 'constrain', ...(overrides.location || {}) },
    person: { mode: 'constrain', ...(overrides.person || {}) },
    event: { mode: 'constrain', ...(overrides.event || {}) },
    tagMentions: overrides.tagMentions,
  })
}

function folderLocations(folders, cfg) {
  return buildTagIndex(folders, cfg).byKind.location
}

const CFG = makeCfg()

/** Multi-tag fixture: duplicate labels, home aliases, legacy event mirror. */
function tagFolders() {
  return [
    { id: 'f1', createdAt: 10, locations: ['北京', ' 北京 ', '公司'], persons: ['小明'], events: ['旅行', '出差'] },
    { id: 'f2', createdAt: 5, locations: ['北京'], persons: ['小明', '张三'], events: ['旅行'] },
    { id: 'f3', createdAt: 30, locations: ['我家里'], persons: ['小红'], event: '工作' },
    { id: 'f4', createdAt: 40, locations: ['上海'], persons: ['小红'], events: [] },
  ]
}

const TAG_INDEX = buildTagIndex(tagFolders(), CFG)

function timeFolders() {
  return [
    {
      id: 't1',
      createdAt: 1,
      timeTags: [
        { from: 100, to: 200, label: '今天', granularity: 'day' },
        { from: 100, to: 200, label: '今天', granularity: 'day' }, // exact duplicate
        { from: 500, to: 400, label: '倒挂' }, // to <= from
        { from: Number.NaN, to: 10, label: '非数' },
        { from: 300, to: 400, label: 42, granularity: 'decade' }, // label -> '', granularity -> day
      ],
    },
    { id: 't2', createdAt: 2, timeTags: [{ from: 250, to: 260, label: '昨天' }] },
    { id: 't3', createdAt: 3 },
    null,
    { id: 't1', timeTags: [{ from: 1, to: 2 }] }, // duplicate folder id
  ]
}

const TIME_INDEX = buildTimeTagIndex(timeFolders(), CFG)

// ---------------------------------------------------------------------------
// 1) constants / defaults / config
// ---------------------------------------------------------------------------

test('TAG_KINDS / TAG_MODES / TAG_DEFAULTS expose the v1.5.0 contract values', () => {
  assert.deepEqual(TAG_KINDS, ['location', 'person', 'event'])
  assert.deepEqual(TAG_MODES, ['off', 'index', 'constrain'])
  assert.deepEqual(TIME_GRANULARITIES, ['day', 'week', 'month', 'year'])
  assert.deepEqual(TAG_DEFAULTS.location, { mode: 'index', maxLabelLength: 60, maxPerFolder: 8 })
  assert.deepEqual(TAG_DEFAULTS.person, { mode: 'index', maxLabelLength: 60, maxPerFolder: 8 })
  assert.deepEqual(TAG_DEFAULTS.event, { mode: 'index', maxLabelLength: 60, maxPerFolder: 4 })
  assert.ok(Object.isFrozen(TAG_KINDS))
})

test('tagConfig: per-kind defaults; unknown kind uses the location defaults', () => {
  assert.deepEqual(tagConfig(undefined, 'location'), { mode: 'index', maxLabelLength: 60, maxPerFolder: 8 })
  assert.deepEqual(tagConfig(undefined, 'person'), { mode: 'index', maxLabelLength: 60, maxPerFolder: 8 })
  assert.deepEqual(tagConfig(undefined, 'event'), { mode: 'index', maxLabelLength: 60, maxPerFolder: 4 })
  // unknown kind -> location group/defaults
  assert.deepEqual(tagConfig(undefined, 'nope'), tagConfig(undefined, 'location'))
  assert.deepEqual(tagConfig({ location: { mode: 'constrain', maxPerFolder: 3 } }, 'mystery'), {
    mode: 'constrain',
    maxLabelLength: 60,
    maxPerFolder: 3,
  })
  // cfg itself invalid -> defaults, never throws
  for (const bad of [null, 'x', 42, [], { location: 'nope' }]) {
    assert.equal(tagConfig(bad, 'location').mode, 'index')
  }
})

test('tagConfig: custom values, clamping and invalid fallback', () => {
  const custom = tagConfig(
    { location: { mode: 'constrain', maxLabelLength: 999, maxPerFolder: 999 }, event: { mode: 'off', maxPerFolder: 0 } },
    'location',
  )
  assert.equal(custom.mode, 'constrain')
  assert.equal(custom.maxLabelLength, 200) // clamped to 1..200
  assert.equal(custom.maxPerFolder, 64) // clamped to 1..64 for location
  const event = tagConfig({ event: { mode: 'off', maxPerFolder: 0 } }, 'event')
  assert.equal(event.mode, 'off')
  assert.equal(event.maxPerFolder, 1) // 0 is out of range -> clamped to 1
  const invalid = tagConfig({
    location: { mode: 'nope', maxLabelLength: 'x', maxPerFolder: 'y' },
    person: { mode: 'constrain', maxPerFolder: 999 },
  })
  assert.deepEqual(invalid, { mode: 'index', maxLabelLength: 60, maxPerFolder: 8 })
  assert.equal(tagConfig({ person: { mode: 'constrain', maxPerFolder: 999 } }, 'person').maxPerFolder, 64)
  assert.equal(tagConfig({ event: { maxPerFolder: 999 } }, 'event').maxPerFolder, 32) // event clamps to 1..32
})

test('tagConfig agrees with engine/config.js DEFAULT_CONFIG (contract defaults)', () => {
  for (const kind of TAG_KINDS) {
    assert.deepEqual(tagConfig(DEFAULT_CONFIG, kind), TAG_DEFAULTS[kind], `${kind} contract defaults`)
  }
  assert.equal(DEFAULT_CONFIG.recall.tagMentions.maxTagsPerKind, 4)
})

// ---------------------------------------------------------------------------
// 2) normalizeTagLabel
// ---------------------------------------------------------------------------

test('normalizeTagLabel: trim / NFKC / whitespace folding / Latin lowercase / zero-width', () => {
  assert.equal(normalizeTagLabel('  北京  ', 'location', CFG), '北京')
  assert.equal(normalizeTagLabel('北京　上海', 'location', CFG), '北京 上海') // full-width space -> single space
  assert.equal(normalizeTagLabel('北京\t上海', 'location', CFG), '北京 上海')
  assert.equal(normalizeTagLabel('  New   York ', 'person', CFG), 'new york')
  assert.equal(normalizeTagLabel('ＪＡＰＡＮ', 'event', CFG), 'japan') // NFKC + lowercase
  assert.equal(normalizeTagLabel('小明\u200b家', 'location', CFG), '小明家') // zero-width removed
  assert.equal(normalizeTagLabel(42, 'person', CFG), '42')
  assert.equal(normalizeTagLabel(0, 'person', CFG), '0')
})

test('normalizeTagLabel: wrapping quotes / brackets are stripped from both ends', () => {
  assert.equal(normalizeTagLabel('「小明家」', 'location', CFG), '小明家')
  assert.equal(normalizeTagLabel('《北京》', 'location', CFG), '北京')
  assert.equal(normalizeTagLabel('“小明”', 'person', CFG), '小明')
  assert.equal(normalizeTagLabel('(北京)', 'location', CFG), '北京')
  assert.equal(normalizeTagLabel('【项目】', 'event', CFG), '项目')
  assert.equal(normalizeTagLabel('  「 小明 」  ', 'person', CFG), '小明')
  // inner brackets stay, only the wrapping ends are stripped
  assert.equal(normalizeTagLabel('北京（公司）', 'location', CFG), '北京(公司)')
})

test("normalizeTagLabel: placeholders and non-word garbage normalize to ''", () => {
  for (const kind of TAG_KINDS) {
    for (const raw of ['', '   ', '空', '无', '不约束', '无事件', 'none', 'NULL', 'n/a', 'N/A', 'na', '-', '（）', '---', '。', '🎉']) {
      assert.equal(normalizeTagLabel(raw, kind, CFG), '', `${kind}: ${JSON.stringify(raw)}`)
    }
  }
  // non-string/number garbage is "no tag", never throws
  for (const raw of [null, undefined, {}, [], true, () => {}, Symbol('x'), Infinity, Number.NaN]) {
    assert.equal(normalizeTagLabel(raw, 'location', CFG), '')
  }
})

test('normalizeTagLabel: truncation counts code points and never leaves a dangling wrapper', () => {
  assert.equal([...normalizeTagLabel('一'.repeat(100), 'person', CFG)].length, 60)
  assert.equal(normalizeTagLabel('一'.repeat(100), 'person', makeCfg({ person: { maxLabelLength: 5 } })), '一一一一一')
  assert.equal(normalizeTagLabel('  abcdef  ', 'event', makeCfg({ event: { maxLabelLength: 3 } })), 'abc')
  assert.equal(normalizeTagLabel('「abcdefgh」', 'event', makeCfg({ event: { maxLabelLength: 4 } })), 'abcd')
  assert.equal(normalizeTagLabel('北京', 'location', makeCfg({ location: { maxLabelLength: 1 } })), '北')
})

test('normalizeTagLabel: location home aliases collapse to 家', () => {
  for (const raw of ['我家', '我家里', '家里', '在家', '回家', '家', '  我家  ', '「回家」']) {
    assert.equal(normalizeTagLabel(raw, 'location', CFG), '家', JSON.stringify(raw))
  }
})

test('normalizeTagLabel: location X的家 becomes X家; other kinds keep it verbatim', () => {
  assert.equal(normalizeTagLabel('小明的家', 'location', CFG), '小明家')
  assert.equal(normalizeTagLabel('朋友的家', 'location', CFG), '朋友家')
  assert.equal(normalizeTagLabel('我的家', 'location', CFG), '家') // 我的家 -> 我家 -> 家
  assert.equal(normalizeTagLabel('小明的家', 'location', CFG), '小明家')
  // already canonical "XX家" and unrelated places stay untouched
  assert.equal(normalizeTagLabel('小明家', 'location', CFG), '小明家')
  assert.equal(normalizeTagLabel('公司', 'location', CFG), '公司')
  // persons / events never get the home special case
  assert.equal(normalizeTagLabel('小明的家', 'person', CFG), '小明的家')
  assert.equal(normalizeTagLabel('回家', 'person', CFG), '回家')
  assert.equal(normalizeTagLabel('小明的家', 'event', CFG), '小明的家')
})

// ---------------------------------------------------------------------------
// 3) buildTagIndex
// ---------------------------------------------------------------------------

test('buildTagIndex: buckets carry canonical label / key / ids / count / firstAt', () => {
  assert.equal(TAG_INDEX.folderCount, 4)
  assert.equal(TAG_INDEX.byKind.location.size, 4) // 北京, 公司, 家, 上海
  assert.deepEqual(TAG_INDEX.byKind.location.get('北京'), { label: '北京', key: '北京', ids: ['f1', 'f2'], count: 2, firstAt: 5 })
  assert.deepEqual(TAG_INDEX.byKind.location.get('公司'), { label: '公司', key: '公司', ids: ['f1'], count: 1, firstAt: 10 })
  // f3 stored 我家里, the index canonicalizes it to 家
  assert.deepEqual(TAG_INDEX.byKind.location.get('家'), { label: '家', key: '家', ids: ['f3'], count: 1, firstAt: 30 })
  assert.equal(TAG_INDEX.byKind.location.get('我家里'), undefined)
  assert.equal(TAG_INDEX.byKind.person.size, 3) // 小明, 张三, 小红
  assert.equal(TAG_INDEX.byKind.event.size, 3) // 旅行, 出差, 工作 (f4 has none)
})

test('buildTagIndex: byId mirrors canonical labels per folder; untagged folders absent', () => {
  assert.deepEqual(TAG_INDEX.byId.get('f1'), { location: ['北京', '公司'], person: ['小明'], event: ['旅行', '出差'] })
  assert.deepEqual(TAG_INDEX.byId.get('f2'), { location: ['北京'], person: ['小明', '张三'], event: ['旅行'] })
  assert.deepEqual(TAG_INDEX.byId.get('f3'), { location: ['家'], person: ['小红'], event: ['工作'] })
  assert.deepEqual(TAG_INDEX.byId.get('f4'), { location: ['上海'], person: ['小红'], event: [] })
  assert.equal(TAG_INDEX.byId.has('missing'), false)
})

test('buildTagIndex: events array wins over the legacy event mirror; duplicates collapse', () => {
  const index = buildTagIndex(
    [
      { id: 'c1', events: ['新事件', ' 新事件 ', '第二事件'], event: '旧镜像' },
      { id: 'c2', event: ' 旧事件 ' },
      { id: 'c3', events: [] },
      { id: 'c4', events: 'not-an-array', event: '旧事件2' },
    ],
    CFG,
  )
  assert.equal(index.folderCount, 4)
  // events array is authoritative on c1: the mirror is ignored, duplicates collapse
  assert.deepEqual(index.byId.get('c1'), { location: [], person: [], event: ['新事件', '第二事件'] })
  assert.equal(index.byKind.event.get('新事件').count, 1)
  assert.equal(index.byKind.event.has('旧镜像'), false)
  // legacy single event still works
  assert.deepEqual(index.byId.get('c2'), { location: [], person: [], event: ['旧事件'] })
  assert.deepEqual(index.byId.get('c4'), { location: [], person: [], event: ['旧事件2'] })
  assert.equal(index.byId.has('c3'), false)
})

test('buildTagIndex: dirty folders are skipped / normalized safely', () => {
  const index = buildTagIndex(
    [
      null,
      42,
      'x',
      [],
      {},
      { id: '', locations: ['北京'] },
      { id: 'd1', locations: ['北京', ' 北京 '], persons: ['小明'] },
      { id: 'd1', locations: ['上海'] }, // duplicate id keeps the first copy
      { id: 'd2', locations: '北京' }, // non-array -> no tag
      { id: 'd3', locations: ['', '空', '---', '🎉', 7, null] },
      { id: 'd4', events: [null, {}, '空', '真事件'] },
      { id: 'd5', locations: ['北京'] },
    ],
    CFG,
  )
  assert.equal(index.folderCount, 5) // d1, d2, d3, d4, d5 (invalid/duplicate/untagged-id entries skipped)
  assert.deepEqual(index.byId.get('d1'), { location: ['北京'], person: ['小明'], event: [] })
  assert.equal(index.byId.has('d2'), false)
  assert.deepEqual(index.byId.get('d3'), { location: ['7'], person: [], event: [] })
  assert.deepEqual(index.byId.get('d4'), { location: [], person: [], event: ['真事件'] })
  assert.deepEqual([...index.byKind.location.keys()].sort(), ['7', '北京'])
  assert.deepEqual(index.byKind.location.get('北京').ids, ['d1', 'd5'])
  assert.equal(index.byKind.location.get('上海'), undefined) // duplicate d1 copy ignored
})

test('buildTagIndex: signature is stable for identical input and changes with content', () => {
  const first = buildTagIndex(tagFolders(), CFG)
  const second = buildTagIndex(tagFolders(), CFG)
  assert.equal(first.signature, second.signature)
  assert.match(first.signature, /^tag1\|/)
  const changed = buildTagIndex([...tagFolders(), { id: 'f5', locations: ['广州'] }], CFG)
  assert.notEqual(changed.signature, first.signature)
  // config that changes the effective index is part of the signature
  const constrained = buildTagIndex(tagFolders(), constrainCfg())
  assert.notEqual(constrained.signature, first.signature)
})

// ---------------------------------------------------------------------------
// 4) normalizeTagQuery
// ---------------------------------------------------------------------------

test('normalizeTagQuery: string forms split on 、，,;；/ and whitespace', () => {
  assert.deepEqual(normalizeTagQuery({ location: '北京、上海' }), { location: ['北京', '上海'], person: [], event: [] })
  assert.deepEqual(normalizeTagQuery({ location: '北京, 上海; 广州/深圳' }).location, ['北京', '上海', '广州', '深圳'])
  assert.deepEqual(normalizeTagQuery({ location: '北京 上海' }).location, ['北京', '上海'])
  assert.deepEqual(normalizeTagQuery({ location: ' 北京 ， 上海 ' }).location, ['北京', '上海'])
})

test('normalizeTagQuery: arrays, dedupe, placeholders, empty and non-object input', () => {
  assert.deepEqual(normalizeTagQuery({ person: ['小明', ' 小明 ', '小明', '空', ''] }).person, ['小明'])
  assert.deepEqual(normalizeTagQuery({ event: ['旅行', '出差'] }).event, ['旅行', '出差'])
  // array items are individual labels (inner spaces survive)
  assert.deepEqual(normalizeTagQuery({ location: ['New York'] }).location, ['new york'])
  // a plain string form is split on whitespace
  assert.deepEqual(normalizeTagQuery({ location: 'New York' }).location, ['new', 'york'])
  // location home normalization applies to queries too
  assert.deepEqual(normalizeTagQuery({ location: ['家里', '我家'] }).location, ['家'])
  assert.deepEqual(normalizeTagQuery(null), { location: [], person: [], event: [] })
  assert.deepEqual(normalizeTagQuery(undefined), { location: [], person: [], event: [] })
  assert.deepEqual(normalizeTagQuery('北京'), { location: [], person: [], event: [] })
  assert.deepEqual(normalizeTagQuery({ location: 42 }).location, ['42'])
})

// ---------------------------------------------------------------------------
// 5) resolveTagQuery
// ---------------------------------------------------------------------------

test('resolveTagQuery: empty query -> empty status, ids null', () => {
  for (const query of [undefined, null, {}, { location: '' }, { location: ['空', '无'] }]) {
    const result = resolveTagQuery(TAG_INDEX, query, constrainCfg())
    assert.equal(result.status, 'empty', JSON.stringify(query))
    assert.equal(result.ids, null)
    assert.deepEqual(result.unknown, [])
  }
})

test('resolveTagQuery: same-kind labels OR, different kinds AND (constrain mode)', () => {
  const cfg = constrainCfg()
  const or = resolveTagQuery(TAG_INDEX, { location: '北京、上海' }, cfg)
  assert.equal(or.status, 'exact')
  assert.deepEqual([...or.ids].sort(), ['f1', 'f2', 'f4'])
  assert.deepEqual(or.matched.location, [
    { label: '北京', count: 2 },
    { label: '上海', count: 1 },
  ])

  const and = resolveTagQuery(TAG_INDEX, { location: ['北京'], person: ['小明'] }, cfg)
  assert.equal(and.status, 'exact')
  assert.deepEqual([...and.ids].sort(), ['f1', 'f2'])
  assert.deepEqual(and.matched.person, [{ label: '小明', count: 2 }])

  const disjoint = resolveTagQuery(TAG_INDEX, { location: ['北京'], person: ['小红'] }, cfg)
  assert.equal(disjoint.status, 'exact')
  assert.equal(disjoint.ids.size, 0)

  const events = resolveTagQuery(TAG_INDEX, { event: ['旅行', '工作'] }, cfg)
  assert.equal(events.status, 'exact')
  assert.deepEqual([...events.ids].sort(), ['f1', 'f2', 'f3'])
})

test('resolveTagQuery: location query canonicalizes 家里 -> 家 and echoes the normalized request', () => {
  const result = resolveTagQuery(TAG_INDEX, { location: ['家里', ' 我的家 '] }, constrainCfg())
  assert.equal(result.status, 'exact')
  assert.deepEqual(result.requested.location, ['家'])
  assert.deepEqual(result.matched.location, [{ label: '家', count: 1 }])
  assert.deepEqual([...result.ids], ['f3'])
})

test('resolveTagQuery: unknown / partial statuses and unknown list', () => {
  const cfg = constrainCfg()
  const unknown = resolveTagQuery(TAG_INDEX, { location: ['广州'] }, cfg)
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.ids.size, 0)
  assert.deepEqual(unknown.unknown, [{ kind: 'location', label: '广州' }])
  assert.deepEqual(unknown.matched.location, [])
  assert.ok(unknown.warnings.length >= 1)

  // an enforcing kind that is entirely unknown empties the intersection
  const mixedUnknown = resolveTagQuery(TAG_INDEX, { location: ['广州'], person: ['小明'] }, cfg)
  assert.equal(mixedUnknown.status, 'unknown')
  assert.equal(mixedUnknown.ids.size, 0)
  assert.deepEqual(mixedUnknown.matched.person, [{ label: '小明', count: 2 }])

  const partial = resolveTagQuery(TAG_INDEX, { location: ['北京', '广州'] }, cfg)
  assert.equal(partial.status, 'partial')
  assert.deepEqual([...partial.ids].sort(), ['f1', 'f2'])
  assert.deepEqual(partial.unknown, [{ kind: 'location', label: '广州' }])
  assert.ok(partial.warnings.length >= 1)
})

test('resolveTagQuery: off mode ignores the kind with a warning', () => {
  const result = resolveTagQuery(TAG_INDEX, { location: ['北京'] }, makeCfg({ location: { mode: 'off' } }))
  assert.equal(result.status, 'disabled')
  assert.equal(result.ids, null)
  assert.deepEqual(result.matched.location, [])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /off/)
  // off kind does not contribute, the enforcing kind still constrains
  const mixed = resolveTagQuery(
    TAG_INDEX,
    { location: ['北京'], person: ['小明'] },
    makeCfg({ location: { mode: 'off' }, person: { mode: 'constrain' } }),
  )
  assert.equal(mixed.status, 'exact')
  assert.deepEqual([...mixed.ids].sort(), ['f1', 'f2'])
  assert.equal(mixed.warnings.length, 1)
})

test('resolveTagQuery: index mode reports matches but never constrains (ids null)', () => {
  const known = resolveTagQuery(TAG_INDEX, { location: ['北京'] }, CFG) // default mode index
  assert.equal(known.ids, null)
  assert.equal(known.status, 'exact')
  assert.deepEqual(known.matched.location, [{ label: '北京', count: 2 }])
  assert.deepEqual(known.warnings, [])

  const unknown = resolveTagQuery(TAG_INDEX, { location: ['广州'] }, CFG)
  assert.equal(unknown.ids, null)
  assert.equal(unknown.status, 'disabled')
  assert.deepEqual(unknown.unknown, [{ kind: 'location', label: '广州' }])

  // index kind is recorded but only the constrain kind feeds the intersection
  const mixed = resolveTagQuery(TAG_INDEX, { location: ['北京'], person: ['小红'] }, makeCfg({ person: { mode: 'constrain' } }))
  assert.equal(mixed.status, 'exact')
  assert.deepEqual([...mixed.ids].sort(), ['f3', 'f4']) // person constraint only
  assert.deepEqual(mixed.matched.location, [{ label: '北京', count: 2 }])
})

// ---------------------------------------------------------------------------
// 6) detectTagMentions
// ---------------------------------------------------------------------------

function mentionIndex(folders) {
  return buildTagIndex(folders, CFG)
}

test('detectTagMentions: longer labels win the shared span (小明家 vs 小明)', () => {
  const home = mentionIndex([{ id: 'x', locations: ['小明家'], persons: ['小明'] }])
  const inHome = detectTagMentions(home, '小明家的公司', CFG)
  assert.deepEqual(inHome.location, ['小明家'])
  assert.deepEqual(inHome.person, [])
  assert.deepEqual(inHome.hits, [{ kind: 'location', label: '小明家', index: 0 }])

  const alone = detectTagMentions(home, '小明来了', CFG)
  assert.deepEqual(alone.person, ['小明'])
  assert.deepEqual(alone.location, [])

  // two labels where one is a prefix of the other: the same span is counted once
  const variants = mentionIndex([{ id: 'y', locations: ['小明家', '小明'] }])
  const deduped = detectTagMentions(variants, '小明家', CFG)
  assert.deepEqual(deduped.location, ['小明家'])
  assert.equal(deduped.hits.length, 1)
})

test('detectTagMentions: multiple kinds, position order and hit indexes', () => {
  const index = mentionIndex([{ id: 'm', locations: ['北京'], persons: ['小明'], events: ['日本旅行'] }])
  const result = detectTagMentions(index, '北京的小明参加日本旅行', CFG)
  assert.deepEqual(result.location, ['北京'])
  assert.deepEqual(result.person, ['小明'])
  assert.deepEqual(result.event, ['日本旅行'])
  assert.deepEqual(result.hits.map((hit) => hit.kind), ['location', 'person', 'event'])
  assert.deepEqual(result.hits.map((hit) => hit.index), [0, 3, 7])
})

test('detectTagMentions: per-kind cap (default 4, cfg override) and lowercased matching', () => {
  const capped = mentionIndex([{ id: 'c', locations: ['北京', '上海', '广州', '深圳'] }])
  const all = detectTagMentions(capped, '北京上海广州深圳', CFG)
  assert.equal(all.location.length, 4)
  const two = detectTagMentions(capped, '北京上海广州深圳', makeCfg({ tagMentions: { maxTagsPerKind: 2 } }))
  assert.equal(two.location.length, 2)
  assert.equal(two.hits.length, 2)
  assert.ok(two.location.every((label) => ['北京', '上海', '广州', '深圳'].includes(label)))

  const english = mentionIndex([{ id: 'e', persons: ['Alice'] }])
  const upper = detectTagMentions(english, 'ALICE 说', CFG)
  assert.deepEqual(upper.person, ['alice'])
  assert.deepEqual(upper.hits, [{ kind: 'person', label: 'alice', index: 0 }])
})

test('detectTagMentions: empty text / empty index / missing index -> all empty', () => {
  const empty = { location: [], person: [], event: [], hits: [] }
  assert.deepEqual(detectTagMentions(TAG_INDEX, '', CFG), empty)
  assert.deepEqual(detectTagMentions(TAG_INDEX, '   ', CFG), empty)
  assert.deepEqual(detectTagMentions(TAG_INDEX, null, CFG), empty)
  assert.deepEqual(detectTagMentions(null, '北京', CFG), empty)
  assert.deepEqual(detectTagMentions(buildTagIndex([], CFG), '北京', CFG), empty)
  // no known tag occurs in the text
  assert.deepEqual(detectTagMentions(TAG_INDEX, '今天天气不错', CFG), empty)
})

// ---------------------------------------------------------------------------
// 7) buildTimeTagIndex / resolveTimeTagIds
// ---------------------------------------------------------------------------

test('buildTimeTagIndex: valid tags only, granularity fallback, dedupe, taggedIds', () => {
  assert.equal(TIME_INDEX.folderCount, 3) // t1, t2, t3 (null/duplicate id skipped)
  assert.deepEqual([...TIME_INDEX.taggedIds].sort(), ['t1', 't2'])
  assert.equal(TIME_INDEX.byId.has('t3'), false) // no timeTags -> untagged
  assert.deepEqual(TIME_INDEX.byId.get('t2'), [{ from: 250, to: 260, label: '昨天', granularity: 'day' }])
  const t1 = TIME_INDEX.byId.get('t1')
  assert.equal(t1.length, 2) // duplicate + invalid removed
  assert.deepEqual(t1[0], { from: 100, to: 200, label: '今天', granularity: 'day' })
  assert.deepEqual(t1[1], { from: 300, to: 400, label: '', granularity: 'day' }) // label 42 -> '', decade -> day
  assert.match(TIME_INDEX.signature, /^timeTag1\|/)
  assert.equal(buildTimeTagIndex(timeFolders(), CFG).signature, TIME_INDEX.signature)
})

test('resolveTimeTagIds: half-open overlap, adjacent intervals do not match', () => {
  const cfg = CFG
  const same = resolveTimeTagIds(TIME_INDEX, [{ from: 100, to: 200 }], cfg) // exactly t1's tag
  assert.deepEqual([...same.ids], ['t1'])
  assert.equal(same.matched, 1)

  const adjacent = resolveTimeTagIds(TIME_INDEX, [{ from: 200, to: 250 }], cfg)
  assert.equal(adjacent.ids.size, 0) // [100,200) and [200,250) do not overlap
  assert.equal(adjacent.matched, 0)

  const before = resolveTimeTagIds(TIME_INDEX, [{ from: 50, to: 100 }], cfg)
  assert.equal(before.ids.size, 0)

  const spanning = resolveTimeTagIds(TIME_INDEX, [{ from: 150, to: 260 }], cfg)
  assert.deepEqual([...spanning.ids].sort(), ['t1', 't2'])
  assert.equal(spanning.matched, 2)

  const t2only = resolveTimeTagIds(TIME_INDEX, [{ from: 200, to: 300 }], cfg)
  assert.deepEqual([...t2only.ids], ['t2'])
})

test('resolveTimeTagIds: multiple windows, no window / no index, invalid windows', () => {
  const multi = resolveTimeTagIds(TIME_INDEX, [{ from: 0, to: 50 }, { from: 250, to: 255 }], CFG)
  assert.deepEqual([...multi.ids], ['t2'])

  const none = resolveTimeTagIds(TIME_INDEX, [], CFG)
  assert.equal(none.ids.size, 0)
  assert.equal(none.matched, 0)
  assert.deepEqual(none.warnings, [])

  const noWindows = resolveTimeTagIds(TIME_INDEX, undefined, CFG)
  assert.equal(noWindows.ids.size, 0)
  assert.equal(noWindows.matched, 0)

  const noIndex = resolveTimeTagIds(null, [{ from: 0, to: 1000 }], CFG)
  assert.equal(noIndex.ids.size, 0)
  assert.equal(noIndex.matched, 0)
  assert.deepEqual(noIndex.warnings, [])

  const invalid = resolveTimeTagIds(TIME_INDEX, [{ from: 10 }, null, { from: 5, to: 5 }, 'x'], CFG)
  assert.equal(invalid.ids.size, 0)
  assert.equal(invalid.matched, 0)
  assert.ok(invalid.warnings.length >= 1)
})

// ---------------------------------------------------------------------------
// 8) determinism
// ---------------------------------------------------------------------------

test('deterministic: identical input yields deepEqual indexes, signatures and resolutions', () => {
  const first = buildTagIndex(tagFolders(), CFG)
  const second = buildTagIndex(tagFolders(), CFG)
  assert.equal(first.signature, second.signature)
  assert.deepEqual([...first.byKind.location.entries()], [...second.byKind.location.entries()])
  assert.deepEqual([...first.byKind.event.entries()], [...second.byKind.event.entries()])
  assert.deepEqual([...first.byId.entries()], [...second.byId.entries()])

  const firstTime = buildTimeTagIndex(timeFolders(), CFG)
  const secondTime = buildTimeTagIndex(timeFolders(), CFG)
  assert.equal(firstTime.signature, secondTime.signature)
  assert.deepEqual([...firstTime.byId.entries()], [...secondTime.byId.entries()])

  const query = { location: ['北京', '广州'], person: ['小明'] }
  const firstResolve = resolveTagQuery(TAG_INDEX, query, constrainCfg())
  const secondResolve = resolveTagQuery(buildTagIndex(tagFolders(), CFG), query, constrainCfg())
  assert.deepEqual(firstResolve, secondResolve)

  const text = '小明家的公司在北京'
  assert.deepEqual(detectTagMentions(TAG_INDEX, text, CFG), detectTagMentions(buildTagIndex(tagFolders(), CFG), text, CFG))
  assert.deepEqual(
    resolveTimeTagIds(TIME_INDEX, [{ from: 150, to: 260 }], CFG),
    resolveTimeTagIds(buildTimeTagIndex(timeFolders(), CFG), [{ from: 150, to: 260 }], CFG),
  )
})
