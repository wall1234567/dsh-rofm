/**
 * v1.5.4 engine tests — keyword caps (query 16 / archive 16) + the computable
 * recall block (absolute dates / weekday / event rows / relative-time
 * annotations).
 *
 * Contracts pinned here:
 *
 *   1. Keyword caps follow the final user rule **query 16 / archive 16** (v1.5.4):
 *      `RECALL_KEYWORDS_MAX` (16) covers the three main query-side extraction
 *      call sites — automatic recall telemetry (engine/recall.js), the
 *      deterministic selector (engine/recall-index.js `querySeeds`) and
 *      `analyzeQuery` (engine/query-analysis.js); the "you said" channel keeps
 *      its narrower pre-1.6 cap (8). One *archived folder* may carry 3~16
 *      keywords (v1.5.4) via the `cfg.keywords.min/max` contract (engine/compress.js and
 *      the memory_judge validation), and that archive cap must NOT widen queries.
 *   2. `buildRecallBlock(additions, cfg)` with `cfg.recall.computeDates !== true`
 *      is byte-identical to the v1.5.0 renderer. The snapshot below is a static
 *      string (captured from the shipped renderer), never derived from the code
 *      under test, so a silent format change fails the suite.
 *   3. With `recall.computeDates === true` the title carries the weekday and the
 *      v1.5.4 `归档于 X（事件时间 Y）` label (X = archive time, Y = event time
 *      from `meta.eventStart/eventEnd`, else from the messages' own `time`), the
 *      standalone `事件时间：…` row is gone, the preamble carries the
 *      time-caliber rule, and relative time phrases in a message body get the
 *      absolute date of that message's own anchor (`message.time` ->
 *      `meta.createdAt` -> `addition.createdAt`).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RECALL_BLOCK_PREAMBLE,
  RECALL_BLOCK_TIME_RULE,
  RECALL_KEYWORDS_MAX,
  analyzeQuery,
  annotateRelativeTimeText,
  buildRecallBlock,
  buildRecallIndex,
  defaultConfigPath,
  detectAssistantSaid,
  formatDateWithWeekday,
  formatDateTimeWithWeekday,
  formatTimeTagDate,
  formatWeekday,
  loadConfig,
  querySeeds,
  recall,
} from '../engine/index.js'
import { RECALL_KEYWORDS_MAX as TOKENIZE_KEYWORDS_MAX, extractKeywords } from '../engine/tokenize.js'

/** Packaged defaults: `recall.computeDates` is false in the engine defaults. */
const BASE_CFG = loadConfig(undefined, {})

/**
 * Fixed-zone config for the computable form: all expected dates below are
 * written in Asia/Shanghai time, so the assertions never depend on the host
 * time zone (the production config also uses Asia/Shanghai).
 */
const DATE_CFG = loadConfig(undefined, {
  recall: { computeDates: true },
  time: { timezone: 'Asia/Shanghai' },
})

/** Epoch ms of an ISO instant (always written with an explicit offset/Z). */
const at = (iso) => Date.parse(iso)

// ===========================================================================
// Task A — keyword caps: query 16 / archive 3~16 (v1.5.4)
// ===========================================================================

/** 30 distinct Latin technical words, each repeated twice. */
const CAP_WORDS = Object.freeze([
  'docker', 'kubernetes', 'postgresql', 'redis', 'mongodb', 'nginx', 'grafana',
  'prometheus', 'kafka', 'elasticsearch', 'terraform', 'ansible', 'jenkins',
  'gitlab', 'argocd', 'istio', 'envoy', 'vault', 'consul', 'rabbitmq',
  'typescript', 'webpack', 'rollup', 'eslint', 'prettier', 'jestrunner',
  'playwright', 'cypress', 'jasmine', 'mocha',
])

/** A query text whose extraction yields enough strong keywords to hit any cap. */
const CAP_TEXT = `${CAP_WORDS.map((word) => `${word} ${word}`).join('，')}？`

test('keywords: query-side cap is 16; archive-side cap is 3~16 (v1.5.4)', () => {
  // Final user rule (v1.6.0): query 16 / archive 30.
  assert.equal(RECALL_KEYWORDS_MAX, 16, 'the query-side cap is the pre-1.6 value')
  assert.equal(TOKENIZE_KEYWORDS_MAX, RECALL_KEYWORDS_MAX, 'engine/index.js must re-export the same constant')
  assert.equal(BASE_CFG.keywords.min, 3)
  assert.equal(BASE_CFG.keywords.max, 16, 'one archived folder may carry up to 16 keywords (v1.5.4)')
  // Archive-side extraction honours cfg.keywords.min/max (16), not a separate cap.
  assert.equal(extractKeywords(CAP_TEXT, BASE_CFG).length, 16, 'archival extraction keeps cfg.keywords.max=16')
  // Query-side extraction honours the explicit 16 cap, never the archive cap.
  assert.equal(extractKeywords(CAP_TEXT, BASE_CFG, { max: RECALL_KEYWORDS_MAX }).length, 16)
  // v1.5.4: query cap and archive cap are both 16 (the archive cap no longer exceeds the query cap).
  assert.equal(RECALL_KEYWORDS_MAX, BASE_CFG.keywords.max, 'query cap and archive cap agree at 16')
})

test('keywords: automatic recall telemetry extracts up to 16 query keywords', () => {
  const result = recall({ userText: CAP_TEXT, cfg: BASE_CFG, index: { folders: [] } })
  assert.equal(result.additions.length, 0)
  assert.equal(result.stats.userKeywords.length, 16, JSON.stringify(result.stats.userKeywords))
})

test('keywords: the deterministic selector (querySeeds) extracts up to 16 query keywords', () => {
  const index = buildRecallIndex([{ id: 'mem-cap', alpha: 1, createdAt: 1, keywords: ['docker'] }], BASE_CFG)
  const seeds = querySeeds(index, CAP_TEXT, BASE_CFG)
  assert.equal(seeds.userKeywords.length, 16, JSON.stringify(seeds.userKeywords))
})

test('keywords: analyzeQuery extracts up to 16 query keywords', () => {
  const analysis = analyzeQuery({ text: CAP_TEXT, cfg: BASE_CFG, now: 1 })
  assert.equal(analysis.keywords.length, 16, JSON.stringify(analysis.keywords))
})

test('keywords: the "you said" channel keeps its narrower pre-1.6 cap (8)', () => {
  const result = detectAssistantSaid(`你说过 ${CAP_TEXT}`, BASE_CFG)
  assert.equal(result.hit, true)
  assert.equal(result.keywords.length, 8, JSON.stringify(result.keywords))
})

test('keywords: the packaged config.json ships the archive cap 3~16 and the query cap 16', () => {
  const shipped = loadConfig(defaultConfigPath())
  assert.deepEqual(shipped.warnings, [])
  assert.equal(shipped.keywords.min, 3)
  assert.equal(shipped.keywords.max, 16)
  assert.equal(RECALL_KEYWORDS_MAX, 16)
  // The shipped archive cap does not leak into query extraction.
  assert.equal(extractKeywords(CAP_TEXT, shipped).length, 16)
  assert.equal(extractKeywords(CAP_TEXT, shipped, { max: RECALL_KEYWORDS_MAX }).length, 16)
})

// ===========================================================================
// Task B — computeDates === false keeps the v1.5.0 block byte for byte
// ===========================================================================

/** Local-time constructor: the legacy title renders in the host local zone. */
const localDate = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute).getTime()

/** Rich fixture: tags row, keyword segment and role prefixes are all exercised. */
function snapshotAdditions() {
  return [
    {
      id: 'mem-1',
      generation: 1,
      alpha: 0.92,
      beta: 3,
      meta: {
        createdAt: localDate(2026, 4, 19, 21, 10),
        keywords: ['部署', 'docker'],
        events: ['上线'],
        locations: ['机房'],
        persons: ['小明'],
        timeTags: [{ label: '昨天', from: 1, to: 2 }],
      },
      messages: [
        { role: 'user', content: '明天上线，记得检查端口。', time: localDate(2026, 4, 19, 21, 10) },
        { role: 'assistant', content: '好的，收到。' },
      ],
    },
    {
      id: 'mem-2',
      generation: 2,
      alpha: 0.3,
      beta: -2.5,
      meta: { createdAt: localDate(2026, 4, 20, 9, 5), keywords: [] },
      messages: [{ role: 'tool', content: 'HTTP/1.1 200 OK' }],
    },
  ]
}

/**
 * Static v1.5.0 snapshot of the renderer (captured before the v1.6.0 change).
 * Do not regenerate it from `buildRecallBlock()`: that would defeat the purpose.
 */
const V150_SNAPSHOT = [
  '## 记忆回忆（按创建时间从早到晚）',
  '',
  RECALL_BLOCK_PREAMBLE,
  '',
  '### 回忆 1 · 2026-04-19 21:10 · α=0.92 · β=+3.0 · 第1代 · 关键词：部署、docker',
  '事件：上线 · 地点：机房 · 人物：小明 · 时间标签：昨天',
  'user: 明天上线，记得检查端口。',
  'assistant: 好的，收到。',
  '',
  '### 回忆 2 · 2026-04-20 09:05 · α=0.30 · β=-2.5 · 第2代',
  'tool: HTTP/1.1 200 OK',
].join('\n') + '\n'

test('computeDates=false: engine default keeps the v1.5.0 block byte-identical', () => {
  assert.equal(BASE_CFG.recall.computeDates, false, 'engine default must keep the legacy block')
  const additions = snapshotAdditions()
  const block = buildRecallBlock(additions, BASE_CFG)
  assert.equal(block, V150_SNAPSHOT)
  // No v1.6.0 additions may leak into the legacy form.
  assert.ok(!block.includes('周日'), 'legacy title has no weekday')
  assert.ok(!block.includes('事件时间：'), 'legacy block has no event-time row')
  assert.ok(!block.includes('明天(2026-'), 'legacy block annotates no relative phrases')
  // An explicit false is the same switch position.
  const explicitFalse = loadConfig(undefined, { recall: { computeDates: false } })
  assert.equal(buildRecallBlock(additions, explicitFalse), V150_SNAPSHOT)
  // Only a strict boolean true turns the computable form on.
  assert.equal(buildRecallBlock(additions, { recall: { computeDates: 1 } }), V150_SNAPSHOT)
})

test('computeDates: the packaged config.json turns the computable form on', () => {
  const shipped = loadConfig(defaultConfigPath())
  assert.deepEqual(shipped.warnings, [])
  assert.equal(shipped.recall.computeDates, true, 'the packaged product config enables absolute dates')
  assert.equal(shipped.time.timezone, 'Asia/Shanghai')
  const block = buildRecallBlock([richAddition()], shipped)
  assert.ok(block.includes('### 回忆 1 · 归档于 2026-04-19 周日 21:10（事件时间 2026-04-19 周日）'), block)
  assert.ok(block.includes('user: 明天(2026-05-28)上线'))
})

// ===========================================================================
// Task B — computeDates === true: full block snapshot
// ===========================================================================

/**
 * One rich addition in a fixed zone:
 *   - meta.createdAt = 2026-04-19 21:10 Asia/Shanghai (Sunday);
 *   - event interval on the same day (09:00–18:00) -> `事件时间 2026-04-19 周日`;
 *   - user message anchored at 2026-05-27 12:00 Asia/Shanghai -> `明天` = 05-28;
 *   - assistant message has no `time` -> `meta.createdAt` -> `本周` = 04-13~04-19.
 */
function richAddition() {
  return {
    id: 'mem-a',
    generation: 1,
    alpha: 0.92,
    beta: 3,
    meta: {
      createdAt: at('2026-04-19T13:10:00Z'),
      keywords: ['部署', 'docker'],
      events: ['上线'],
      locations: ['机房'],
      persons: ['小明'],
      timeTags: [{ label: '昨天' }],
      eventStart: at('2026-04-19T01:00:00Z'),
      eventEnd: at('2026-04-19T10:00:00Z'),
    },
    messages: [
      { role: 'user', content: '明天上线，记得检查端口。', time: at('2026-05-27T04:00:00Z') },
      { role: 'assistant', content: '本周要复盘。' },
    ],
  }
}

const RICH_SNAPSHOT = [
  '## 记忆回忆（按创建时间从早到晚）',
  '',
  RECALL_BLOCK_PREAMBLE,
  RECALL_BLOCK_TIME_RULE,
  '',
  '### 回忆 1 · 归档于 2026-04-19 周日 21:10（事件时间 2026-04-19 周日） · α=0.92 · β=+3.0 · 第1代 · 关键词：部署、docker',
  '事件：上线 · 地点：机房 · 人物：小明 · 时间标签：昨天',
  'user: 明天(2026-05-28)上线，记得检查端口。',
  'assistant: 本周(2026-04-13~2026-04-19)要复盘。',
].join('\n') + '\n'

/** The first entry's title line of a rendered block. */
function firstTitle(block) {
  return block.split('\n').find((line) => line.startsWith('### 回忆 1')) || ''
}

test('computeDates=true: title labels archive time and event time; per-message annotations', () => {
  const block = buildRecallBlock([richAddition()], DATE_CFG)
  assert.equal(block, RICH_SNAPSHOT)
  // The v1.5.4 title separates the two calibers explicitly.
  assert.match(
    firstTitle(block),
    /^### 回忆 1 · 归档于 2026-04-19 周日 21:10（事件时间 2026-04-19 周日） · α=/,
    'title = archive time (labelled) + event time in parentheses',
  )
  // The old standalone event-time row must not come back (it would duplicate Y).
  assert.equal(block.split('\n').filter((line) => line.startsWith('事件时间：')).length, 0)
  // The annotation is inserted after the role prefix, never inside it.
  assert.match(block, /^user: 明天\(2026-05-28\)上线/m)
  assert.match(block, /^assistant: 本周\(2026-04-13~2026-04-19\)要复盘。/m)
})

test('computeDates=true: first title shows the archive date is NOT the event date', () => {
  // A folder archived on 06-20 whose content happened on 05-27: the title must
  // make the difference explicit, so the model cannot copy 06-20 as the event day.
  const addition = {
    id: 'mem-late-archive',
    generation: 1,
    alpha: 0.6,
    beta: 0,
    meta: {
      createdAt: at('2026-06-20T04:00:00Z'),
      keywords: ['火锅'],
      eventStart: at('2026-05-27T04:00:00Z'),
      eventEnd: at('2026-05-27T05:00:00Z'),
    },
    messages: [{ role: 'user', content: '昨天吃了火锅', time: at('2026-05-27T04:00:00Z') }],
  }
  const title = firstTitle(buildRecallBlock([addition], DATE_CFG))
  assert.ok(title.includes('归档于 2026-06-20 周六 12:00'), title)
  assert.ok(title.includes('（事件时间 2026-05-27 周三）'), title)
  assert.ok(!title.includes('（事件时间 2026-06-20'), 'the archive date is never the event date')
})

test('computeDates=true: event time forms (range / one-sided / message-derived / absent)', () => {
  const base = {
    id: 'mem-e',
    generation: 1,
    alpha: 0.5,
    beta: 0,
    meta: { createdAt: at('2026-04-19T13:10:00Z'), keywords: [] },
    messages: [{ role: 'user', content: '没有时间短语' }],
  }
  const titleFor = (meta, messages = base.messages) =>
    firstTitle(buildRecallBlock([{ ...base, meta: { ...base.meta, ...meta }, messages }], DATE_CFG))
  const eventPart = (title) => {
    const match = /（事件时间 ([^）]+)）/.exec(title)
    return match ? match[1] : ''
  }

  // Different calendar days -> range with both weekdays.
  assert.equal(
    eventPart(titleFor({ eventStart: at('2026-04-19T01:00:00Z'), eventEnd: at('2026-04-20T09:00:00Z') })),
    '2026-04-19 周日 ~ 2026-04-20 周一',
  )
  // Same calendar day -> one date (the half-open eventEnd-1 stays on the same day).
  assert.equal(
    eventPart(titleFor({ eventStart: at('2026-04-19T01:00:00Z'), eventEnd: at('2026-04-19T10:00:00Z') })),
    '2026-04-19 周日',
  )
  // Only one bound -> one date (single-sided rendering).
  assert.equal(eventPart(titleFor({ eventStart: at('2026-04-19T01:00:00Z') })), '2026-04-19 周日')
  assert.equal(eventPart(titleFor({ eventEnd: at('2026-04-20T09:00:00Z') })), '2026-04-20 周一')
  // A half-open end exactly at local midnight must not print the next day.
  assert.equal(
    eventPart(titleFor({ eventStart: at('2026-04-19T01:00:00Z'), eventEnd: at('2026-04-19T16:00:00Z') })),
    '2026-04-19 周日',
  )
  // No meta event fields, but the archived messages carry their own logical
  // times (v1.5.4 `context.json message.time`) -> derive the event range.
  assert.equal(
    eventPart(
      titleFor(
        { eventStart: undefined, eventEnd: undefined },
        [
          { role: 'user', content: '第一句', time: at('2026-04-15T01:00:00Z') },
          { role: 'assistant', content: '第二句', time: at('2026-04-16T10:00:00Z') },
        ],
      ),
    ),
    '2026-04-15 周三 ~ 2026-04-16 周四',
  )
  // No event time at all -> the title is the archive time only, no empty
  // parentheses and never a fabricated event date.
  const noEvent = titleFor({})
  assert.ok(noEvent.includes('归档于 2026-04-19 周日 21:10'), noEvent)
  assert.ok(!noEvent.includes('事件时间'), 'no event time -> no parenthetical')
  // No v1.6.0 row either (the value moved into the title, not duplicated).
  assert.equal(titleFor({ eventStart: at('2026-04-19T01:00:00Z') }).split('事件时间：').length - 1, 0)
  // Unusable values are ignored instead of rendering garbage.
  assert.equal(eventPart(titleFor({ eventStart: 'nope', eventEnd: Number.NaN })), '')
  // Epoch 0 is the documented "no event time" sentinel: never render 1970.
  assert.equal(eventPart(titleFor({ eventStart: 0, eventEnd: 0 })), '')
  assert.equal(eventPart(titleFor({ eventStart: 0 })), '')
  // One real bound next to a 0 sentinel still renders that bound (one-sided).
  assert.equal(eventPart(titleFor({ eventStart: 0, eventEnd: at('2026-04-20T09:00:00Z') })), '2026-04-20 周一')
  assert.equal(eventPart(titleFor({ eventStart: at('2026-04-19T01:00:00Z'), eventEnd: 0 })), '2026-04-19 周日')
  // A zero message.time is not a real event instant either.
  assert.equal(
    eventPart(titleFor({}, [{ role: 'user', content: '无时间', time: 0 }])),
    '',
  )
  // showTags=false hides the tag row but never the title event time.
  const noTagsCfg = loadConfig(undefined, {
    recall: { computeDates: true, showTags: false },
    time: { timezone: 'Asia/Shanghai' },
  })
  const noTags = buildRecallBlock([richAddition()], noTagsCfg)
  assert.ok(!noTags.includes('事件：上线'), 'tag row is hidden by recall.showTags=false')
  assert.ok(firstTitle(noTags).includes('（事件时间 2026-04-19 周日）'), 'the title event time is independent of showTags')
})

test('computeDates=true: the time-caliber rule is part of the computable preamble only', () => {
  // Legacy (v1.5.0) block: preamble unchanged, no 归档于 label, no rule.
  const legacy = buildRecallBlock([richAddition()], BASE_CFG)
  assert.ok(legacy.includes(RECALL_BLOCK_PREAMBLE))
  assert.ok(!legacy.includes(RECALL_BLOCK_TIME_RULE), 'computeDates=false stays byte-identical to v1.5.0')
  assert.ok(!legacy.includes('归档于'), 'the legacy title keeps the bare date')
  // Computable block: rule right after the pinned preamble, before the entries.
  const block = buildRecallBlock([richAddition()], DATE_CFG)
  assert.ok(block.includes(`${RECALL_BLOCK_PREAMBLE}\n${RECALL_BLOCK_TIME_RULE}`))
  for (const needle of ['归档于 X', '事件时间', '一律以「事件时间」为准', '禁止把归档时间当作事件时间引用']) {
    assert.ok(RECALL_BLOCK_TIME_RULE.includes(needle), `time rule must mention ${needle}`)
  }
})

test('computeDates=true: one title per memory, tag rows follow it, no event-time rows', () => {
  const additions = [richAddition(), { ...richAddition(), id: 'mem-b', meta: { ...richAddition().meta, eventStart: undefined, eventEnd: undefined } }]
  const block = buildRecallBlock(additions, DATE_CFG)
  const lines = block.split('\n')
  const firstTitleIndex = lines.findIndex((line) => line.startsWith('### 回忆 1'))
  const firstTag = lines.findIndex((line, index) => index > firstTitleIndex && line.startsWith('事件：'))
  assert.ok(firstTag > firstTitleIndex, 'tag row follows the title')
  assert.ok(lines[firstTag + 1].startsWith('user: '), 'the message body follows the tag row (no event row in between)')
  assert.equal(lines.filter((line) => line.startsWith('事件时间：')).length, 0, 'v1.5.4 moved the event time into the title')
  // The second folder (no meta event fields) still has its own title, whose
  // event time comes from its messages (both share richAddition()'s messages).
  assert.ok(lines.some((line) => line.startsWith('### 回忆 2 · 归档于 ')), block)
  assert.ok(lines.filter((line) => line.startsWith('### 回忆 ')).length === 2)
})

// ===========================================================================
// Task B — relative-time annotation contract
// ===========================================================================

test('annotation: each granularity renders the documented absolute format', () => {
  // 2026-05-27 12:00 Asia/Shanghai (Wednesday).
  const anchor = at('2026-05-27T04:00:00Z')
  const annotate = (text) => annotateRelativeTimeText(text, anchor, DATE_CFG)
  assert.equal(annotate('前天吃了火锅'), '前天(2026-05-25)吃了火锅', 'day -> YYYY-MM-DD')
  assert.equal(annotate('昨天也下雨'), '昨天(2026-05-26)也下雨', 'day')
  assert.equal(annotate('下周三开会'), '下周三(2026-06-03)开会', 'weekday expression is one day')
  assert.equal(annotate('本周要复盘'), '本周(2026-05-25~2026-05-31)要复盘', 'week -> first~last day')
  assert.equal(annotate('下个月发版'), '下个月(2026-06)发版', 'month -> YYYY-MM')
  assert.equal(annotate('明年再说'), '明年(2027)再说', 'year -> YYYY')
  assert.equal(annotate('10月31日出发'), '10月31日(2026-10-31)出发', 'yearless date gets the resolved year')
})

test('annotation: each label is annotated only on its first occurrence per message', () => {
  const anchor = at('2026-05-27T04:00:00Z')
  assert.equal(
    annotateRelativeTimeText('昨天和昨天都下雨', anchor, DATE_CFG),
    '昨天(2026-05-26)和昨天都下雨',
  )
})

test('annotation: an existing (YYYY…) annotation is never duplicated', () => {
  const anchor = at('2026-05-27T04:00:00Z')
  for (const text of [
    '前天(2026-05-25)吃火锅',
    '前天（2026-05-25）吃火锅',
    '前天 (2026-05-25) 吃火锅',
    '后天(2026-05-29)再说',
  ]) {
    assert.equal(annotateRelativeTimeText(text, anchor, DATE_CFG), text)
  }
})

test('annotation: absolute phrases with a full year are already computable and stay untouched', () => {
  const anchor = at('2026-05-27T04:00:00Z')
  for (const text of ['2026-10-31 出发', '2026年10月发版', '2026年10月31日见']) {
    assert.equal(annotateRelativeTimeText(text, anchor, DATE_CFG), text)
  }
})

test('annotation: compound expressions are annotated part by part (parser contract)', () => {
  // engine/relative-time.js deliberately emits `去年12月` as two tags instead of
  // merging it into one interval; the annotations mirror that contract.
  const anchor = at('2026-05-27T04:00:00Z')
  assert.equal(
    annotateRelativeTimeText('去年12月我们见过', anchor, DATE_CFG),
    '去年(2025)12月(2025-12)我们见过',
  )
})

test('annotation: unsafe / missing anchors and non-string input render unchanged', () => {
  assert.equal(annotateRelativeTimeText('前天吃了火锅', Number.NaN, DATE_CFG), '前天吃了火锅')
  assert.equal(annotateRelativeTimeText('前天吃了火锅', undefined, DATE_CFG), '前天吃了火锅')
  assert.equal(annotateRelativeTimeText('前天吃了火锅', null, DATE_CFG), '前天吃了火锅')
  assert.equal(annotateRelativeTimeText('前天吃了火锅', '', DATE_CFG), '前天吃了火锅')
  // Finite but outside the representable Date range: parseRelativeTimes yields
  // no windows, so the text must stay exactly as archived.
  assert.equal(annotateRelativeTimeText('前天吃了火锅', 1e20, DATE_CFG), '前天吃了火锅')
  assert.equal(annotateRelativeTimeText(undefined, 1700000000000, DATE_CFG), '')
  assert.equal(annotateRelativeTimeText(42, 1700000000000, DATE_CFG), '')
  // Unparsable message text is untouched.
  assert.equal(annotateRelativeTimeText('普通的一句话', 1700000000000, DATE_CFG), '普通的一句话')
})

test('annotation: the anchor priority is message.time -> meta.createdAt -> addition.createdAt', () => {
  const blockFor = (addition) => buildRecallBlock([addition], DATE_CFG)
  const base = () => ({
    id: 'mem-anchor',
    generation: 1,
    alpha: 0.5,
    beta: 0,
    meta: {},
    messages: [{ role: 'user', content: '前天做了什么' }],
  })

  // 1) message.time wins over meta.createdAt.
  const withMessageTime = base()
  withMessageTime.meta.createdAt = at('2026-04-01T00:00:00Z')
  withMessageTime.messages = [{ role: 'user', content: '前天做了什么', time: at('2026-05-27T04:00:00Z') }]
  assert.ok(blockFor(withMessageTime).includes('前天(2026-05-25)'), 'message.time is the first anchor')

  // 2) message.time missing -> meta.createdAt (2026-05-27 12:00 Asia/Shanghai).
  const withMeta = base()
  withMeta.meta.createdAt = at('2026-05-27T04:00:00Z')
  assert.ok(blockFor(withMeta).includes('前天(2026-05-25)'), 'meta.createdAt is the second anchor')

  // 3) both missing -> addition.createdAt.
  const withAddition = base()
  withAddition.createdAt = at('2026-05-27T04:00:00Z')
  withAddition.meta = { keywords: [] }
  assert.ok(blockFor(withAddition).includes('前天(2026-05-25)'), 'addition.createdAt is the last anchor')

  // 4) no usable anchor -> the text stays exactly as archived.
  const noAnchor = base()
  noAnchor.meta = { keywords: [] }
  const block = blockFor(noAnchor)
  assert.ok(block.includes('user: 前天做了什么'), 'no anchor -> no annotation')
  assert.ok(!block.includes('前天('), 'no anchor -> no annotation at all')
  assert.ok(block.includes('未知时间'), 'unknown archive time keeps the documented title fallback')

  // 5) a finite-but-unsafe message.time is not silently replaced by meta.createdAt:
  //    the parser refuses the unsafe anchor and the text stays unchanged.
  const unsafe = base()
  unsafe.meta.createdAt = at('2026-05-27T04:00:00Z')
  unsafe.messages = [{ role: 'user', content: '前天做了什么', time: 1e20 }]
  assert.ok(!blockFor(unsafe).includes('前天('), 'unsafe anchors render unchanged instead of falling through')
})

test('annotation: every message uses its own anchor, in the configured time zone', () => {
  const addition = {
    id: 'mem-multi',
    generation: 1,
    alpha: 0.5,
    beta: 0,
    meta: { createdAt: at('2026-01-01T00:00:00Z'), keywords: [] },
    messages: [
      { role: 'user', content: '前天去了北京', time: at('2026-05-27T04:00:00Z') },
      { role: 'assistant', content: '前天你说要去上海', time: at('2026-06-10T04:00:00Z') },
    ],
  }
  const block = buildRecallBlock([addition], DATE_CFG)
  assert.ok(block.includes('user: 前天(2026-05-25)去了北京'))
  assert.ok(block.includes('assistant: 前天(2026-06-08)你说要去上海'))
})

// ===========================================================================
// Task B — exported render helpers (signatures used by other layers/tests)
// ===========================================================================

test('helpers: formatWeekday / formatDateWithWeekday / formatDateTimeWithWeekday', () => {
  const sunday = at('2026-04-19T13:10:00Z') // 2026-04-19 21:10 Asia/Shanghai (Sunday)
  assert.equal(formatWeekday(sunday, 'Asia/Shanghai'), '周日')
  assert.equal(formatDateWithWeekday(sunday, 'Asia/Shanghai'), '2026-04-19 周日')
  assert.equal(formatDateTimeWithWeekday(sunday, 'Asia/Shanghai'), '2026-04-19 周日 21:10')
  // Monday and a cross-day instant (UTC 20:00 is already the next day locally).
  assert.equal(formatWeekday(at('2026-05-27T04:00:00Z'), 'Asia/Shanghai'), '周三')
  assert.equal(formatDateWithWeekday(at('2026-04-19T20:00:00Z'), 'Asia/Shanghai'), '2026-04-20 周一')
  // Unusable values never throw and never invent a weekday.
  for (const value of [Number.NaN, undefined, null, '', 'nope', 1e20]) {
    assert.equal(formatWeekday(value, 'Asia/Shanghai'), '')
    assert.equal(formatDateWithWeekday(value, 'Asia/Shanghai'), '')
  }
  assert.equal(formatDateTimeWithWeekday(Number.NaN, 'Asia/Shanghai'), '未知时间')
})

test('helpers: formatTimeTagDate implements the granularity contract', () => {
  const day = { from: at('2026-05-25T00:00:00+08:00'), to: at('2026-05-26T00:00:00+08:00'), granularity: 'day' }
  const week = { from: at('2026-05-25T00:00:00+08:00'), to: at('2026-06-01T00:00:00+08:00'), granularity: 'week' }
  const month = { from: at('2026-06-01T00:00:00+08:00'), to: at('2026-07-01T00:00:00+08:00'), granularity: 'month' }
  const year = { from: at('2027-01-01T00:00:00+08:00'), to: at('2028-01-01T00:00:00+08:00'), granularity: 'year' }
  assert.equal(formatTimeTagDate(day, 'Asia/Shanghai'), '2026-05-25')
  assert.equal(formatTimeTagDate(week, 'Asia/Shanghai'), '2026-05-25~2026-05-31')
  assert.equal(formatTimeTagDate(month, 'Asia/Shanghai'), '2026-06')
  assert.equal(formatTimeTagDate(year, 'Asia/Shanghai'), '2027')
  // Malformed tags degrade to '' instead of throwing.
  assert.equal(formatTimeTagDate(null, 'Asia/Shanghai'), '')
  assert.equal(formatTimeTagDate({ from: Number.NaN, granularity: 'day' }, 'Asia/Shanghai'), '')
})
