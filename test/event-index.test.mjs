/**
 * Event constraint tests — label normalization, Dice similarity, in-memory
 * event index, recall-time / scoring-time resolution (design contract §2).
 *
 * Threshold/metric are the contract defaults: `metric='dice'`, `threshold=0.72`,
 * `maxCandidates=5`, `maxLabelLength=60`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EVENT_DEFAULTS,
  EVENT_METRICS,
  EVENT_MODES,
  assignEventLabel,
  buildEventIndex,
  eventConfig,
  eventIdsFor,
  eventKeyOf,
  eventSimilarity,
  normalizeEventLabel,
  resolveEventQuery,
} from '../engine/event-index.js'
import { DEFAULT_CONFIG } from '../engine/config.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeCfg(event = {}) {
  return { event: { ...EVENT_DEFAULTS, ...event, similarity: { ...EVENT_DEFAULTS.similarity, ...(event.similarity || {}) } } }
}

function constrainCfg(extra = {}) {
  return makeCfg({ mode: 'constrain', ...extra })
}

function folder(id, event, createdAt) {
  const entry = { id, createdAt: createdAt === undefined ? 1 : createdAt }
  if (event !== undefined) entry.event = event
  return entry
}

const folders = () => [
  folder('m1', '日本旅行', 10),
  folder('m2', '日本旅行', 5),
  folder('m3', '登录重构项目', 20),
  folder('m4', '旅行经历', 50),
  folder('m5', '空', 30),
  folder('m6', undefined, 40),
  folder('m7', ' 日本旅行 ', 60),
]

// ---------------------------------------------------------------------------
// 1) defaults / config
// ---------------------------------------------------------------------------

test('EVENT_DEFAULTS equals engine/config.js DEFAULT_CONFIG.event (contract defaults)', () => {
  assert.deepEqual(EVENT_DEFAULTS, DEFAULT_CONFIG.event)
  assert.deepEqual(EVENT_DEFAULTS.similarity, { metric: 'dice', threshold: 0.72, maxCandidates: 5 })
  assert.equal(EVENT_DEFAULTS.mode, 'index')
  assert.equal(EVENT_DEFAULTS.maxLabelLength, 60)
  assert.deepEqual(EVENT_MODES, ['off', 'index', 'constrain'])
  assert.deepEqual(EVENT_METRICS, ['dice', 'avg', 'min'])
})

test('eventConfig: defaults, enum fallback and clamping never throw', () => {
  assert.deepEqual(eventConfig(undefined), {
    mode: 'index',
    maxLabelLength: 60,
    metric: 'dice',
    threshold: 0.72,
    maxCandidates: 5,
    askUserHint: true,
  })
  const custom = eventConfig({
    event: { mode: 'constrain', maxLabelLength: 999, similarity: { metric: 'min', threshold: -1, maxCandidates: 99 }, askUserHint: false },
  })
  assert.equal(custom.mode, 'constrain')
  assert.equal(custom.maxLabelLength, 200) // clamped to 1..200
  assert.equal(custom.metric, 'min')
  assert.equal(custom.threshold, 0) // clamped to 0..1
  assert.equal(custom.maxCandidates, 10) // clamped to 1..10
  assert.equal(custom.askUserHint, false)
  // invalid values fall back to the defaults
  const garbage = eventConfig({ event: { mode: 'nope', maxLabelLength: 'x', similarity: { metric: 'cosine', threshold: 'y', maxCandidates: 0 } } })
  assert.equal(garbage.mode, 'index')
  assert.equal(garbage.maxLabelLength, 60)
  assert.equal(garbage.metric, 'dice')
  assert.equal(garbage.threshold, 0.72)
  assert.equal(garbage.maxCandidates, 1) // 0 is out of range -> clamped to 1
  assert.equal(eventConfig('nope').mode, 'index')
})

// ---------------------------------------------------------------------------
// 2) normalizeEventLabel
// ---------------------------------------------------------------------------

test('normalizeEventLabel: trim / NFKC / whitespace folding / Latin lowercase', () => {
  assert.equal(normalizeEventLabel('  日本旅行  '), '日本旅行')
  assert.equal(normalizeEventLabel('日本　旅行'), '日本 旅行') // full-width space -> single space
  assert.equal(normalizeEventLabel('日本\t旅行'), '日本 旅行')
  assert.equal(normalizeEventLabel('Japan   Trip'), 'japan trip')
  assert.equal(normalizeEventLabel('ＪＡＰＡＮ'), 'japan') // NFKC full-width + lowercase
  assert.equal(normalizeEventLabel('  hello   world '), 'hello world')
  assert.equal(normalizeEventLabel('日本\u200b旅行'), '日本旅行') // zero-width removed
  assert.equal(normalizeEventLabel(42), '42')
  assert.equal(normalizeEventLabel('v2 登录重构'), 'v2 登录重构')
})

test('normalizeEventLabel: wrapping quotes / brackets are stripped from both ends', () => {
  assert.equal(normalizeEventLabel('「日本旅行」'), '日本旅行')
  assert.equal(normalizeEventLabel('《日本旅行》'), '日本旅行')
  assert.equal(normalizeEventLabel('“日本旅行”'), '日本旅行')
  assert.equal(normalizeEventLabel('(日本旅行)'), '日本旅行')
  assert.equal(normalizeEventLabel('【日本旅行】'), '日本旅行')
  assert.equal(normalizeEventLabel('  「 日本旅行 」  '), '日本旅行')
  // only the wrapping ends are stripped, inner brackets stay (NFKC turns the
  // full-width parentheses into ASCII ones first)
  assert.equal(normalizeEventLabel('日本旅行（计划）'), '日本旅行(计划)')
})

test("normalizeEventLabel: placeholders normalize to '' (no event)", () => {
  for (const raw of ['', '   ', '空', '无', '不约束', '无事件', 'none', 'NULL', 'n/a', 'N/A', 'na', '-', '（）', '---', '。', '🎉']) {
    assert.equal(normalizeEventLabel(raw), '', `expected "" for ${JSON.stringify(raw)}`)
  }
  // non-string garbage is "no event", never throws
  for (const raw of [null, undefined, {}, [], true, () => {}, Symbol('x'), Infinity]) {
    assert.equal(normalizeEventLabel(raw), '')
  }
})

test('normalizeEventLabel: maxLabelLength truncation counts code points', () => {
  const long = '一'.repeat(100)
  assert.equal([...normalizeEventLabel(long)].length, 60)
  const short = normalizeEventLabel(long, makeCfg({ maxLabelLength: 5 }))
  assert.equal(short, '一一一一一')
  assert.equal(normalizeEventLabel('  abcdef  ', makeCfg({ maxLabelLength: 3 })), 'abc')
  // truncation never leaves a wrapping quote or trailing space
  assert.equal(normalizeEventLabel('「abcdefgh」', makeCfg({ maxLabelLength: 4 })), 'abcd')
  // maxLabelLength=1 still keeps a usable label
  assert.equal(normalizeEventLabel('日本旅行', makeCfg({ maxLabelLength: 1 })), '日')
})

test('eventKeyOf: normalization is the key; case/space variants collapse', () => {
  assert.equal(eventKeyOf(' Japan   Trip '), 'japan trip')
  assert.equal(eventKeyOf('JAPAN TRIP'), eventKeyOf('japan trip'))
  assert.equal(eventKeyOf('日本旅行'), eventKeyOf('「日本旅行」'))
  assert.equal(eventKeyOf('空'), '')
  assert.equal(eventKeyOf(undefined), '')
})

// ---------------------------------------------------------------------------
// 3) eventSimilarity (Dice)
// ---------------------------------------------------------------------------

test('eventSimilarity: Dice hits the contract examples', () => {
  // 日本旅行 (7 tokens) vs 日本旅行计划 (11 tokens): 2*7/(7+11) = 0.778
  const extended = eventSimilarity('日本旅行', '日本旅行计划')
  assert.equal(extended.metric, 'dice')
  assert.ok(Math.abs(extended.score - 2 * 7 / 18) < 1e-12)
  assert.ok(extended.score >= EVENT_DEFAULTS.similarity.threshold)
  assert.equal(extended.containA, 1)
  assert.ok(Math.abs(extended.containB - 7 / 11) < 1e-12)

  // a different destination shares only 日/本/日本 -> 0.429
  const otherTrip = eventSimilarity('日本旅行', '日本美食')
  assert.ok(Math.abs(otherTrip.score - 6 / 14) < 1e-12)
  assert.ok(otherTrip.score < EVENT_DEFAULTS.similarity.threshold)

  // a generic short label must not swallow a specific one
  const generic = eventSimilarity('项目', '登录重构项目')
  assert.ok(generic.score < EVENT_DEFAULTS.similarity.threshold)
  assert.equal(generic.containA, 1)

  // unrelated labels / empty labels score 0
  assert.equal(eventSimilarity('日本旅行', '登录重构').score, 0)
  assert.equal(eventSimilarity('', '日本旅行').score, 0)
  assert.equal(eventSimilarity('空', '空').score, 0)
})

test('eventSimilarity: identical labels score 1; symmetry holds', () => {
  const same = eventSimilarity('日本旅行', '「日本旅行」')
  assert.deepEqual({ score: same.score, containA: same.containA, containB: same.containB }, { score: 1, containA: 1, containB: 1 })
  for (const [a, b] of [
    ['日本旅行', '日本旅行计划'],
    ['日本旅行', '日本美食'],
    ['登录重构', '登录重构项目'],
    ['docker', 'docker部署'],
    ['Japan Trip', 'japan trip 2026'],
  ]) {
    const forward = eventSimilarity(a, b)
    const backward = eventSimilarity(b, a)
    assert.equal(forward.score, backward.score, `${a}/${b}`)
    assert.equal(forward.containA, backward.containB)
    assert.equal(forward.containB, backward.containA)
  }
})

test('eventSimilarity: Latin tokens require length >= 2 and CJK bigrams bridge variants', () => {
  // "docker" vs "Docker 部署" shares only the Latin word + no CJK overlap
  const latin = eventSimilarity('docker', 'Docker 部署')
  assert.ok(latin.score > 0 && latin.score < 0.72)
  // short Latin tokens (length 1) are not tokens: "a" never counts
  assert.equal(eventSimilarity('a', 'a b').score, 0)
  // CJK variant with one extra char still crosses the threshold via bigrams
  const variant = eventSimilarity('日本旅行', '日本旅行记')
  assert.ok(variant.score >= 0.72, `score=${variant.score}`)
})

test('eventSimilarity: metric option dice (default) / avg / min', () => {
  const dice = eventSimilarity('日本旅行', '日本旅行计划')
  const avg = eventSimilarity('日本旅行', '日本旅行计划', { event: { similarity: { metric: 'avg' } } })
  const min = eventSimilarity('日本旅行', '日本旅行计划', { event: { similarity: { metric: 'min' } } })
  assert.equal(dice.metric, 'dice')
  assert.ok(Math.abs(dice.score - 0.7777777777777778) < 1e-12)
  assert.equal(avg.metric, 'avg')
  assert.ok(Math.abs(avg.score - (1 + 7 / 11) / 2) < 1e-12)
  assert.ok(Math.abs(min.score - 7 / 11) < 1e-12)
  assert.ok(min.score < 0.72 && dice.score >= 0.72)
  // unknown metric falls back to dice
  assert.equal(eventSimilarity('日本旅行', '日本旅行计划', { event: { similarity: { metric: 'cosine' } } }).metric, 'dice')
})

// ---------------------------------------------------------------------------
// 4) buildEventIndex
// ---------------------------------------------------------------------------

test('buildEventIndex: buckets, counts, firstAt, byKey/byId, ordering', () => {
  const index = buildEventIndex(folders(), makeCfg())
  assert.equal(index.folderCount, 7)
  assert.deepEqual(index.labels.map((item) => item.label), ['日本旅行', '旅行经历', '登录重构项目'])
  assert.deepEqual(index.labels[0], { label: '日本旅行', key: '日本旅行', count: 3, firstAt: 5 })
  assert.equal(index.byKey.get('日本旅行').count, 3)
  assert.deepEqual(index.byKey.get('日本旅行').ids, ['m1', 'm2', 'm7'])
  assert.deepEqual(index.byId.get('m3'), { label: '登录重构项目', key: '登录重构项目' })
  // placeholders / missing labels are not part of the index
  assert.equal(index.byId.has('m5'), false)
  assert.equal(index.byId.has('m6'), false)
  // folderCount counts every valid folder (including no-event ones)
  assert.equal(typeof index.builtAt, 'number')
  assert.match(index.signature, /^event1\|n=7\|/)
})

test('buildEventIndex: label ordering is count desc then label asc', () => {
  const index = buildEventIndex([
    folder('a', '乙事件'),
    folder('b', '甲事件'),
    folder('c', '乙事件'),
    folder('d', '丙事件'),
  ], makeCfg())
  assert.deepEqual(index.labels.map((item) => item.label), ['乙事件', '丙事件', '甲事件'])
  assert.deepEqual(index.labels.map((item) => item.count), [2, 1, 1])
})

test('buildEventIndex: skips invalid/duplicate ids, garbage input never throws', () => {
  const index = buildEventIndex([
    { id: 'a', event: '事件A' },
    { id: 'a', event: '事件B' }, // duplicate id: first surviving copy wins
    { id: 42, event: '事件C' },
    null,
    { event: '事件D' },
    { id: 'b', event: '事件A' },
  ], makeCfg())
  assert.deepEqual(index.byId.get('a'), { label: '事件a', key: '事件a' }) // Latin is lowercase-folded
  assert.equal(index.labels.length, 1)
  assert.deepEqual(index.byKey.get('事件a').ids, ['a', 'b'])
  for (const input of [null, undefined, 'nope', 42, {}, []]) {
    const empty = buildEventIndex(input, makeCfg())
    assert.deepEqual(empty.labels, [])
    assert.equal(empty.folderCount, 0)
    assert.ok(empty.byKey instanceof Map)
  }
})

test('buildEventIndex: signature is deterministic and changes with content/config', () => {
  const a = buildEventIndex(folders(), makeCfg())
  const b = buildEventIndex(folders(), makeCfg())
  assert.equal(a.signature, b.signature)
  assert.notEqual(buildEventIndex(folders().slice(0, 2), makeCfg()).signature, a.signature)
  assert.notEqual(buildEventIndex(folders(), makeCfg({ maxLabelLength: 10 })).signature, a.signature)
  assert.notEqual(buildEventIndex(folders(), makeCfg({ similarity: { metric: 'min' } })).signature, a.signature)
})

// ---------------------------------------------------------------------------
// 5) resolveEventQuery (recall time)
// ---------------------------------------------------------------------------

test("resolveEventQuery: empty state for omitted/placeholder submissions", () => {
  const index = buildEventIndex(folders(), makeCfg())
  for (const submitted of [undefined, null, '', '   ', '空', '无事件', '不约束', 'none', 'N/A', '-']) {
    const result = resolveEventQuery(index, submitted, constrainCfg())
    assert.equal(result.status, 'empty', `submitted ${JSON.stringify(submitted)}`)
    assert.equal(result.ids, null)
    assert.equal(result.label, null)
    assert.deepEqual(result.candidates, [])
    assert.deepEqual(result.warnings, [])
  }
})

test('resolveEventQuery: exact returns all ids of the canonical event', () => {
  const index = buildEventIndex(folders(), makeCfg())
  const result = resolveEventQuery(index, ' 日本旅行 ', constrainCfg())
  assert.equal(result.status, 'exact')
  assert.equal(result.label, '日本旅行')
  assert.equal(result.key, '日本旅行')
  assert.deepEqual([...result.ids].sort(), ['m1', 'm2', 'm7'])
  assert.deepEqual(result.candidates, [])
  assert.equal(result.requested, ' 日本旅行 ')
  // ids is a copy: mutating it does not corrupt the index
  result.ids.add('hacked')
  assert.equal(eventIdsFor(index, '日本旅行').has('hacked'), false)
})

test('resolveEventQuery: similar lists >=threshold candidates and does NOT merge', () => {
  const index = buildEventIndex(folders(), makeCfg())
  const before = index.labels.length
  const result = resolveEventQuery(index, '日本旅行计划2026', constrainCfg())
  assert.equal(result.status, 'similar')
  assert.equal(result.ids, null)
  assert.equal(result.label, '日本旅行计划2026')
  assert.ok(result.candidates.length >= 1)
  const labels = result.candidates.map((item) => item.label)
  assert.ok(labels.includes('日本旅行'))
  for (const candidate of result.candidates) {
    assert.ok(candidate.score >= 0.72, `${candidate.label} ${candidate.score}`)
    assert.ok(candidate.count >= 1)
  }
  // never auto-merged, candidates stay inside the old index
  assert.equal(index.labels.length, before)
})

test('resolveEventQuery: similar candidates are sorted and capped by maxCandidates', () => {
  const index = buildEventIndex([
    folder('a', '日本旅行'),
    folder('b', '日本旅行计划'),
    folder('c', '日本旅行计划2026'),
    folder('d', '日本旅行安排'),
  ], makeCfg())
  const result = resolveEventQuery(index, '日本旅行计划2027', constrainCfg())
  assert.equal(result.status, 'similar')
  const scores = result.candidates.map((item) => item.score)
  assert.deepEqual(scores, scores.slice().sort((left, right) => right - left))
  const capped = resolveEventQuery(index, '日本旅行计划2027', constrainCfg({ similarity: { maxCandidates: 1 } }))
  assert.equal(capped.candidates.length, 1)
  assert.equal(capped.candidates[0].label, result.candidates[0].label)
})

test('resolveEventQuery: unknown => empty id Set + closest below-threshold candidates', () => {
  const index = buildEventIndex(folders(), makeCfg())
  const result = resolveEventQuery(index, '美国旅行', constrainCfg())
  assert.equal(result.status, 'unknown')
  assert.equal(result.label, '美国旅行')
  assert.ok(result.ids instanceof Set)
  assert.equal(result.ids.size, 0)
  // below-threshold but positive candidates are still offered to the tool
  assert.ok(result.candidates.length >= 1)
  assert.ok(result.candidates.some((item) => item.label === '日本旅行'))
  for (const candidate of result.candidates) {
    assert.ok(candidate.score > 0 && candidate.score < 0.72)
  }
  assert.ok(result.warnings.some((warning) => warning.includes('美国旅行')))
  // askUserHint=false removes the "ask the user" part
  assert.equal(resolveEventQuery(index, '美国旅行', constrainCfg({ askUserHint: false })).warnings.some((warning) => warning.includes('asking the user')), false)
})

test('resolveEventQuery: disabled state follows event.mode (empty checked first)', () => {
  const index = buildEventIndex(folders(), makeCfg())
  // mode 'index' / 'off' => disabled, never enforced
  for (const mode of ['index', 'off']) {
    const result = resolveEventQuery(index, '日本旅行', makeCfg({ mode }))
    assert.equal(result.status, 'disabled')
    assert.equal(result.ids, null)
    assert.equal(result.label, mode === 'index' ? '日本旅行' : null)
    if (mode === 'off') assert.ok(result.warnings.some((warning) => warning.includes('off')))
  }
  assert.deepEqual(resolveEventQuery(index, '日本旅行', makeCfg({ mode: 'index' })).warnings, [])
  // explicitly empty submission stays empty even in a non-constrain mode
  assert.equal(resolveEventQuery(index, '空', makeCfg({ mode: 'off' })).status, 'empty')
})

test('resolveEventQuery: null/missing index degrades safely', () => {
  for (const index of [null, undefined, {}, { labels: [] }]) {
    const empty = resolveEventQuery(index, '', constrainCfg())
    assert.equal(empty.status, 'empty')
    const unknown = resolveEventQuery(index, '日本旅行', constrainCfg())
    assert.equal(unknown.status, 'unknown')
    assert.equal(unknown.ids.size, 0)
    assert.deepEqual(unknown.candidates, [])
  }
})

// ---------------------------------------------------------------------------
// 6) assignEventLabel (scoring time)
// ---------------------------------------------------------------------------

test('assignEventLabel: exact label keeps the canonical spelling, no merge', () => {
  const index = buildEventIndex(folders(), makeCfg())
  assert.deepEqual(assignEventLabel(index, '  日本旅行 '), { label: '日本旅行', merged: null, warnings: [] })
  assert.deepEqual(assignEventLabel(index, '空'), { label: '', merged: null, warnings: [] })
  // a new, sufficiently different label becomes its own canonical label
  assert.deepEqual(assignEventLabel(index, '美国旅行'), { label: '美国旅行', merged: null, warnings: [] })
})

test('assignEventLabel: similar label is silently merged into the existing canonical', () => {
  const index = buildEventIndex(folders(), makeCfg())
  const result = assignEventLabel(index, '日本旅行计划')
  assert.equal(result.label, '日本旅行')
  assert.ok(result.merged)
  assert.equal(result.merged.from, '日本旅行计划')
  assert.equal(result.merged.to, '日本旅行')
  assert.ok(Math.abs(result.merged.score - 0.7777777777777778) < 1e-12)
  assert.equal(result.warnings.length, 1)
  // `event-merged:` is the stable prefix the adapter/tool layer (E) parses
  assert.ok(result.warnings[0].startsWith('event-merged: '), result.warnings[0])
  assert.ok(result.warnings[0].includes('日本旅行计划'))
  assert.ok(result.warnings[0].includes('日本旅行'))
  assert.ok(result.warnings[0].includes('0.78'))
})

test('assignEventLabel: threshold/metric config decides the merge; no index => no merge', () => {
  const index = buildEventIndex(folders(), makeCfg())
  // raising the threshold above 0.778 disables the merge
  const strict = assignEventLabel(index, '日本旅行计划', makeCfg({ similarity: { threshold: 0.9 } }))
  assert.equal(strict.merged, null)
  assert.equal(strict.label, '日本旅行计划')
  // a lower threshold merges a case dice would not merge
  const loose = assignEventLabel(index, '日本美食', makeCfg({ similarity: { threshold: 0.4 } }))
  assert.equal(loose.label, '日本旅行')
  assert.ok(loose.merged)
  // null index: normalization only
  assert.deepEqual(assignEventLabel(null, 'Japan Trip'), { label: 'japan trip', merged: null, warnings: [] })
})

test('assignEventLabel: repeated labelling converges to the same canonical label', () => {
  const base = buildEventIndex(folders(), makeCfg())
  const variants = ['日本旅行计划', '日本旅行计划2026', '日本旅行安排']
  for (const variant of variants) {
    const assigned = assignEventLabel(base, variant)
    assert.equal(assigned.label, '日本旅行', `variant ${variant}`)
  }
})

// ---------------------------------------------------------------------------
// 7) eventIdsFor / determinism
// ---------------------------------------------------------------------------

test('eventIdsFor: known label => Set of ids, empty/unknown => null', () => {
  const index = buildEventIndex(folders(), makeCfg())
  const ids = eventIdsFor(index, '日本旅行')
  assert.ok(ids instanceof Set)
  assert.deepEqual([...ids].sort(), ['m1', 'm2', 'm7'])
  assert.equal(eventIdsFor(index, '空'), null)
  assert.equal(eventIdsFor(index, '不存在的事件'), null)
  assert.equal(eventIdsFor(null, '日本旅行'), null)
  // copy semantics
  ids.add('x')
  assert.equal(eventIdsFor(index, '日本旅行').has('x'), false)
})

test('event-index: repeated calls are deterministic (same labels/ids/candidates)', () => {
  const builds = [buildEventIndex(folders(), makeCfg()), buildEventIndex(folders(), makeCfg())]
  for (const index of builds) {
    assert.deepEqual(index.labels, builds[0].labels)
    assert.equal(index.signature, builds[0].signature)
    assert.deepEqual([...resolveEventQuery(index, '日本旅行计划2026', constrainCfg()).candidates], [...resolveEventQuery(builds[0], '日本旅行计划2026', constrainCfg()).candidates])
  }
  // normalization + similarity are pure
  assert.equal(eventSimilarity('日本旅行', '日本旅行计划').score, eventSimilarity('日本旅行', '日本旅行计划').score)
  assert.equal(normalizeEventLabel('日本旅行'), normalizeEventLabel('日本旅行'))
})
