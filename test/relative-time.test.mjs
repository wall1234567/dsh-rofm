/**
 * Relative time parser tests — fuzzy time expressions to half-open time-tag
 * windows (design §3.1, plan §1/§2).
 *
 * Coverage: Asia/Shanghai + UTC day boundaries across UTC midnight, all
 * supported Chinese syntax families, week start (Monday / Sunday / Saturday),
 * month and year windows, cross-year `X月X日` resolution, leap days, month ends,
 * `N <unit> 前/后`, period words that must not change the day window,
 * multi-expression sorting/dedupe, folder tag extraction (per-message anchors,
 * createdAt fallback, truncation), interval overlap semantics and determinism.
 *
 * Everything is deterministic: every anchor is passed explicitly and no test
 * touches the real `memory/` directory or the host clock.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detectQueryTimes,
  extractTimeTags,
  intervalsOverlap,
  parseRelativeTimes,
  readTimeTagConfig,
} from '../engine/relative-time.js'

const ASIA = 'Asia/Shanghai'
const UTC = 'UTC'
const SH_OFFSET = 8 * 3600000

/** Epoch ms of a Shanghai wall-clock time (Shanghai is a fixed +08:00 zone). */
function sh(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second) - SH_OFFSET
}

/** Epoch ms of a UTC wall-clock time. */
function utc(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

/** Raw plugin config shaped like the real one (`time.timezone` + `timeTag.*`). */
function cfg(timezone = ASIA, timeTag = {}) {
  return { time: { timezone }, timeTag: { ...timeTag } }
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms)
}

/** Assert exactly one tag was produced for `text` and return it. */
function only(text, anchor, config) {
  const tags = parseRelativeTimes(text, anchor, config)
  assert.equal(tags.length, 1, `expected one tag for ${JSON.stringify(text)}, got ${tags.length}`)
  return tags[0]
}

/** Assert the exact half-open window (and optionally the granularity). */
function expectWindow(tag, from, to, granularity) {
  assert.equal(tag.from, from, `${tag.label}: from ${iso(tag.from)} !== ${iso(from)}`)
  assert.equal(tag.to, to, `${tag.label}: to ${iso(tag.to)} !== ${iso(to)}`)
  if (granularity !== undefined) assert.equal(tag.granularity, granularity, `${tag.label}: granularity`)
}

function labels(tags) {
  return tags.map((tag) => tag.label)
}

/** 2026-11-07 is a Saturday in Asia/Shanghai; 12:00 local is safely mid-day. */
const ANCHOR = sh(2026, 11, 7, 12, 0, 0)

// ---------------------------------------------------------------------------
// config reading
// ---------------------------------------------------------------------------

test('readTimeTagConfig: contract defaults, invalid values and explicit overrides', () => {
  const defaults = { timezone: '', weekStart: 1, maxPerFolder: 8, maxSpanDays: 366 }
  assert.deepEqual(readTimeTagConfig(undefined), defaults)
  assert.deepEqual(readTimeTagConfig(null), defaults)
  assert.deepEqual(readTimeTagConfig({}), defaults)
  assert.deepEqual(readTimeTagConfig({ timeTag: {} }), defaults)

  // Out-of-range / wrong-type values fall back to the defaults.
  const invalid = readTimeTagConfig({
    time: { timezone: 'Not/AZone' },
    timeTag: { weekStart: 9, maxPerFolder: 0, maxSpanDays: -1 },
  })
  assert.deepEqual(invalid, defaults)
  assert.equal(readTimeTagConfig({ timeTag: { weekStart: 'x' } }).weekStart, 1)
  assert.equal(readTimeTagConfig({ timeTag: { weekStart: 0 } }).weekStart, 1, 'weekStart is 1-based')
  assert.equal(readTimeTagConfig({ timeTag: { weekStart: 8 } }).weekStart, 1)
  assert.equal(readTimeTagConfig({ timeTag: { maxPerFolder: null } }).maxPerFolder, 8)
  assert.equal(readTimeTagConfig({ timeTag: { maxSpanDays: {} } }).maxSpanDays, 366)
  assert.equal(readTimeTagConfig({ time: { timezone: 123 } }).timezone, '')

  // Valid overrides are honoured (timezone is normalised by validateTimezone).
  assert.deepEqual(readTimeTagConfig({
    time: { timezone: ASIA },
    timeTag: { weekStart: 7, maxPerFolder: 5, maxSpanDays: 30 },
  }), { timezone: ASIA, weekStart: 7, maxPerFolder: 5, maxSpanDays: 30 })
  assert.equal(readTimeTagConfig({ timeTag: { weekStart: 6 } }).weekStart, 6)
  assert.equal(readTimeTagConfig({ time: { timezone: '' } }).timezone, '')
  assert.equal(readTimeTagConfig({ timeTag: { timezone: UTC } }).timezone, UTC)

  // The reader also accepts its own output (already-normalised config object).
  const normalized = readTimeTagConfig({
    time: { timezone: ASIA },
    timeTag: { weekStart: 7, maxPerFolder: 4, maxSpanDays: 90 },
  })
  assert.deepEqual(normalized, { timezone: ASIA, weekStart: 7, maxPerFolder: 4, maxSpanDays: 90 })
  assert.deepEqual(readTimeTagConfig(normalized), normalized)
})

// ---------------------------------------------------------------------------
// time zones / day boundaries
// ---------------------------------------------------------------------------

test('day windows are time-zone aware across UTC midnight (Asia/Shanghai vs UTC)', () => {
  // 2026-11-07T15:30Z is 2026-11-07 23:30 in Shanghai, still the same local day.
  const anchor = Date.UTC(2026, 10, 7, 15, 30)
  const shanghaiToday = only('今天', anchor, cfg(ASIA))
  expectWindow(shanghaiToday, sh(2026, 11, 7), sh(2026, 11, 8), 'day')
  assert.equal(iso(shanghaiToday.from), '2026-11-06T16:00:00.000Z')
  assert.equal(iso(shanghaiToday.to), '2026-11-07T16:00:00.000Z')
  assert.ok(shanghaiToday.from <= anchor && anchor < shanghaiToday.to, 'anchor inside its half-open day')
  assert.equal(shanghaiToday.label, '今天')
  assert.equal(shanghaiToday.expression, '今天')

  const utcToday = only('今天', anchor, cfg(UTC))
  expectWindow(utcToday, utc(2026, 11, 7), utc(2026, 11, 8), 'day')
  assert.equal(iso(utcToday.from), '2026-11-07T00:00:00.000Z')
  assert.equal(iso(utcToday.to), '2026-11-08T00:00:00.000Z')
  assert.notEqual(shanghaiToday.from, utcToday.from, 'same instant, different local day windows')

  // 2026-11-07T00:30Z is still 11-06 in UTC but 11-07 08:30 in Shanghai.
  const earlyUtc = utc(2026, 11, 7, 0, 30)
  expectWindow(only('今天', earlyUtc, cfg(UTC)), utc(2026, 11, 7), utc(2026, 11, 8), 'day')
  expectWindow(only('昨天', earlyUtc, cfg(UTC)), utc(2026, 11, 6), utc(2026, 11, 7), 'day')
  expectWindow(only('昨天', earlyUtc, cfg(ASIA)), sh(2026, 11, 6), sh(2026, 11, 7), 'day')

  // Half-open: the last millisecond of the window belongs to the next day.
  assert.equal(iso(shanghaiToday.to - 1), '2026-11-07T15:59:59.999Z')
})

test('day words: today / yesterday / the day before & after family', () => {
  const cases = [
    ['今天', 0],
    ['今日', 0],
    ['昨天', -1],
    ['昨日', -1],
    ['前天', -2],
    ['明天', 1],
    ['明日', 1],
    ['后天', 2],
    ['大后天', 3],
    ['大前天', -3],
  ]
  for (const [text, offset] of cases) {
    const tag = only(text, ANCHOR, cfg())
    expectWindow(tag, sh(2026, 11, 7 + offset), sh(2026, 11, 8 + offset), 'day')
    assert.equal(tag.label, text)
    assert.equal(tag.expression, text)
  }
})

// ---------------------------------------------------------------------------
// weeks
// ---------------------------------------------------------------------------

test('weekday expressions use a Monday week start by default', () => {
  // Anchor 2026-11-07 is Saturday; week = Mon 11-02 .. Sun 11-08.
  const cases = [
    ['下周二', sh(2026, 11, 10)],
    ['上周五', sh(2026, 10, 30)],
    ['周三', sh(2026, 11, 4)],
    ['本周一', sh(2026, 11, 2)],
    ['本周日', sh(2026, 11, 8)],
    ['本周天', sh(2026, 11, 8)],
    ['星期日', sh(2026, 11, 8)],
    ['礼拜三', sh(2026, 11, 4)],
    ['下礼拜二', sh(2026, 11, 10)],
    ['下下周二', sh(2026, 11, 17)],
    ['上上周五', sh(2026, 10, 23)],
  ]
  for (const [text, start] of cases) {
    const tag = only(text, ANCHOR, cfg())
    // Shanghai has no DST, so one local day is exactly 24h here.
    expectWindow(tag, start, start + 86400000, 'day')
    assert.equal(tag.to - tag.from, 86400000, `${text}: Shanghai days are 24h`)
  }
})

test('whole-week windows: this / last / next / -2 / +2 weeks', () => {
  const cases = [
    ['本周', sh(2026, 11, 2), sh(2026, 11, 9)],
    ['这周', sh(2026, 11, 2), sh(2026, 11, 9)],
    ['上周', sh(2026, 10, 26), sh(2026, 11, 2)],
    ['下周', sh(2026, 11, 9), sh(2026, 11, 16)],
    ['上上周', sh(2026, 10, 19), sh(2026, 10, 26)],
    ['下下周', sh(2026, 11, 16), sh(2026, 11, 23)],
  ]
  for (const [text, from, to] of cases) {
    const tag = only(text, ANCHOR, cfg())
    expectWindow(tag, from, to, 'week')
    assert.equal(tag.label, text)
  }
})

test('weekStart controls the week grid (1 = Monday, 6 = Saturday, 7 = Sunday)', () => {
  // Anchor 2026-11-07 (Saturday). With Sunday week start the current week is
  // Sun 11-01 .. Sat 11-07.
  const sundayCfg = cfg(ASIA, { weekStart: 7 })
  expectWindow(only('本周日', ANCHOR, sundayCfg), sh(2026, 11, 1), sh(2026, 11, 2), 'day')
  expectWindow(only('本周一', ANCHOR, sundayCfg), sh(2026, 11, 2), sh(2026, 11, 3), 'day')
  expectWindow(only('下周二', ANCHOR, sundayCfg), sh(2026, 11, 10), sh(2026, 11, 11), 'day')
  expectWindow(only('上周日', ANCHOR, sundayCfg), sh(2026, 10, 25), sh(2026, 10, 26), 'day')
  expectWindow(only('本周', ANCHOR, sundayCfg), sh(2026, 11, 1), sh(2026, 11, 8), 'week')

  // Saturday week start: week runs 11-07 .. 11-13.
  const saturdayCfg = cfg(ASIA, { weekStart: 6 })
  expectWindow(only('本周一', ANCHOR, saturdayCfg), sh(2026, 11, 9), sh(2026, 11, 10), 'day')
  expectWindow(only('本周六', ANCHOR, saturdayCfg), sh(2026, 11, 7), sh(2026, 11, 8), 'day')
  expectWindow(only('下周', ANCHOR, saturdayCfg), sh(2026, 11, 14), sh(2026, 11, 21), 'week')
})

// ---------------------------------------------------------------------------
// months and years
// ---------------------------------------------------------------------------

test('month words and yearless month expressions', () => {
  const cases = [
    ['上个月', sh(2026, 10, 1), sh(2026, 11, 1)],
    ['下个月', sh(2026, 12, 1), sh(2027, 1, 1)],
    ['这个月', sh(2026, 11, 1), sh(2026, 12, 1)],
    ['本月', sh(2026, 11, 1), sh(2026, 12, 1)],
    ['下月', sh(2026, 12, 1), sh(2027, 1, 1)],
    ['上上个月', sh(2026, 9, 1), sh(2026, 10, 1)],
    ['下下个月', sh(2027, 1, 1), sh(2027, 2, 1)],
  ]
  for (const [text, from, to] of cases) {
    const tag = only(text, ANCHOR, cfg())
    expectWindow(tag, from, to, 'month')
  }

  // Yearless X月 takes the occurrence closest to the anchor (+-183 day rule).
  expectWindow(only('10月', ANCHOR, cfg()), sh(2026, 10, 1), sh(2026, 11, 1), 'month')
  expectWindow(only('12月', sh(2026, 1, 5, 12), cfg()), sh(2025, 12, 1), sh(2026, 1, 1), 'month')
  expectWindow(only('1月', ANCHOR, cfg()), sh(2027, 1, 1), sh(2027, 2, 1), 'month')
})

test('year words and explicit years', () => {
  expectWindow(only('今年', ANCHOR, cfg()), sh(2026, 1, 1), sh(2027, 1, 1), 'year')
  expectWindow(only('明年', ANCHOR, cfg()), sh(2027, 1, 1), sh(2028, 1, 1), 'year')
  expectWindow(only('去年', ANCHOR, cfg()), sh(2025, 1, 1), sh(2026, 1, 1), 'year')
  expectWindow(only('2026年', ANCHOR, cfg()), sh(2026, 1, 1), sh(2027, 1, 1), 'year')
  // Explicit years are absolute and ignore the anchor.
  expectWindow(only('1999年', ANCHOR, cfg()), sh(1999, 1, 1), sh(2000, 1, 1), 'year')
})

// ---------------------------------------------------------------------------
// explicit dates
// ---------------------------------------------------------------------------

test('explicit ISO / Chinese dates resolve absolutely', () => {
  const dayOct31 = [sh(2026, 10, 31), sh(2026, 11, 1)]
  expectWindow(only('2026-10-31', ANCHOR, cfg()), dayOct31[0], dayOct31[1], 'day')
  expectWindow(only('2026年10月31日', ANCHOR, cfg()), dayOct31[0], dayOct31[1], 'day')
  expectWindow(only('2026年10月31号', ANCHOR, cfg()), dayOct31[0], dayOct31[1], 'day')
  expectWindow(only('10月31日', ANCHOR, cfg()), dayOct31[0], dayOct31[1], 'day')
  expectWindow(only('10月31号', ANCHOR, cfg()), dayOct31[0], dayOct31[1], 'day')
  expectWindow(only('十月三十一日', ANCHOR, cfg()), dayOct31[0], dayOct31[1], 'day')

  // A far-away anchor must not move an explicitly dated window.
  const far = sh(2020, 3, 1, 8)
  expectWindow(only('2026-10-31', far, cfg()), dayOct31[0], dayOct31[1], 'day')
  expectWindow(only('2026年10月', far, cfg()), sh(2026, 10, 1), sh(2026, 11, 1), 'month')

  // ISO month.
  expectWindow(only('2026-10', ANCHOR, cfg()), sh(2026, 10, 1), sh(2026, 11, 1), 'month')

  // Most-specific match wins: a full date is one tag, never `10月` + `31日`.
  const explicit = only('2026年10月31日', ANCHOR, cfg())
  assert.equal(explicit.label, '2026年10月31日')
  assert.equal(explicit.expression, '2026年10月31日')
  assert.equal(parseRelativeTimes('10月31日', ANCHOR, cfg()).length, 1)
  assert.equal(parseRelativeTimes('下周二', ANCHOR, cfg()).length, 1)
  assert.equal(parseRelativeTimes('大前天', ANCHOR, cfg()).length, 1)
})

test('yearless dates pick the nearest occurrence (cross-year, leap day, month end)', () => {
  // `12月31日` anchored in early January must land in the previous year.
  expectWindow(
    only('12月31日', sh(2026, 1, 5, 12), cfg()),
    sh(2025, 12, 31),
    sh(2026, 1, 1),
    'day',
  )
  // `1月2日` anchored in late December must land in the next year.
  expectWindow(
    only('1月2日', sh(2026, 12, 30, 12), cfg()),
    sh(2027, 1, 2),
    sh(2027, 1, 3),
    'day',
  )
  // Leap day: used as-is inside a leap year, nearest existing year otherwise.
  expectWindow(
    only('2月29日', sh(2024, 3, 1, 12), cfg()),
    sh(2024, 2, 29),
    sh(2024, 3, 1),
    'day',
  )
  expectWindow(
    only('2月29日', sh(2026, 3, 1, 12), cfg()),
    sh(2024, 2, 29),
    sh(2024, 3, 1),
    'day',
  )
  // Month end: 1月31日 is a valid date even though the anchor is in February.
  expectWindow(
    only('1月31日', sh(2026, 2, 1, 12), cfg()),
    sh(2026, 1, 31),
    sh(2026, 2, 1),
    'day',
  )
})

test('impossible explicit dates produce no tag and never throw', () => {
  for (const text of ['2026-02-30', '2026-13-01', '2026-00-10', '2026年2月30日', '2026年13月1日']) {
    assert.deepEqual(parseRelativeTimes(text, ANCHOR, cfg()), [], text)
  }
})

// ---------------------------------------------------------------------------
// relative quantities
// ---------------------------------------------------------------------------

test('N days / weeks 前 or 后', () => {
  expectWindow(only('三天后', ANCHOR, cfg()), sh(2026, 11, 10), sh(2026, 11, 11), 'day')
  expectWindow(only('3天后', ANCHOR, cfg()), sh(2026, 11, 10), sh(2026, 11, 11), 'day')
  expectWindow(only('十一天前', ANCHOR, cfg()), sh(2026, 10, 27), sh(2026, 10, 28), 'day')
  expectWindow(only('二十三天后', ANCHOR, cfg()), sh(2026, 11, 30), sh(2026, 12, 1), 'day')
  expectWindow(only('两天前', ANCHOR, cfg()), sh(2026, 11, 5), sh(2026, 11, 6), 'day')

  // N weeks is a whole calendar week N weeks away (Monday-aligned by default).
  expectWindow(only('三周后', ANCHOR, cfg()), sh(2026, 11, 23), sh(2026, 11, 30), 'week')
  expectWindow(only('两周前', ANCHOR, cfg()), sh(2026, 10, 19), sh(2026, 10, 26), 'week')
  expectWindow(only('3星期后', ANCHOR, cfg()), sh(2026, 11, 23), sh(2026, 11, 30), 'week')
  // The relative week respects weekStart.
  expectWindow(only('一周后', ANCHOR, cfg(ASIA, { weekStart: 7 })), sh(2026, 11, 8), sh(2026, 11, 15), 'week')
})

test('N months / N years 前 or 后 keep their calendar width', () => {
  expectWindow(only('三个月前', ANCHOR, cfg()), sh(2026, 8, 1), sh(2026, 9, 1), 'month')
  expectWindow(only('三个月后', ANCHOR, cfg()), sh(2027, 2, 1), sh(2027, 3, 1), 'month')
  expectWindow(only('一个月后', ANCHOR, cfg()), sh(2026, 12, 1), sh(2027, 1, 1), 'month')
  expectWindow(only('3个月后', ANCHOR, cfg()), sh(2027, 2, 1), sh(2027, 3, 1), 'month')

  expectWindow(only('三年前', ANCHOR, cfg()), sh(2023, 1, 1), sh(2024, 1, 1), 'year')
  expectWindow(only('3年前', ANCHOR, cfg()), sh(2023, 1, 1), sh(2024, 1, 1), 'year')
  expectWindow(only('一年后', ANCHOR, cfg()), sh(2027, 1, 1), sh(2028, 1, 1), 'year')
  expectWindow(only('十年前', ANCHOR, cfg()), sh(2016, 1, 1), sh(2017, 1, 1), 'year')
})

test('time-of-day words never change the day window', () => {
  expectWindow(only('今天下午', ANCHOR, cfg()), sh(2026, 11, 7), sh(2026, 11, 8), 'day')
  expectWindow(only('明天上午', ANCHOR, cfg()), sh(2026, 11, 8), sh(2026, 11, 9), 'day')
  expectWindow(only('昨天晚上', ANCHOR, cfg()), sh(2026, 11, 6), sh(2026, 11, 7), 'day')
  const late = only('下周二晚上', ANCHOR, cfg())
  expectWindow(late, sh(2026, 11, 10), sh(2026, 11, 11), 'day')
  assert.equal(late.label, '下周二')
})

// ---------------------------------------------------------------------------
// multi-expression behaviour
// ---------------------------------------------------------------------------

test('multiple expressions are sorted by interval start and deduplicated', () => {
  const tags = parseRelativeTimes('明天和昨天还有今天', ANCHOR, cfg())
  assert.deepEqual(labels(tags), ['昨天', '今天', '明天'])
  for (let index = 1; index < tags.length; index += 1) {
    assert.ok(tags[index - 1].from <= tags[index].from, 'sorted by from')
    assert.ok(tags[index - 1].to > tags[index - 1].from, 'every tag is a non-empty half-open window')
  }

  // Exact duplicates (same label and interval) collapse to one tag.
  assert.equal(parseRelativeTimes('今天，今天', ANCHOR, cfg()).length, 1)
  assert.equal(parseRelativeTimes('今天和今天', ANCHOR, cfg()).length, 1)

  // Different labels for the same interval are kept (dedupe key is from|to|label).
  const synonyms = parseRelativeTimes('今天和今日', ANCHOR, cfg())
  assert.equal(synonyms.length, 2)
  assert.equal(synonyms[0].from, synonyms[1].from)
  assert.equal(synonyms[0].to, synonyms[1].to)
  expectWindow(synonyms[0], sh(2026, 11, 7), sh(2026, 11, 8), 'day')

  // Overlapping syntax keeps only the most specific expression.
  assert.deepEqual(labels(parseRelativeTimes('上周五和下周见', ANCHOR, cfg())), ['上周五', '下周'])
})

test('detectQueryTimes behaves exactly like parseRelativeTimes', () => {
  const text = '上周五和三天后，还有2026年10月31日'
  assert.deepEqual(detectQueryTimes(text, ANCHOR, cfg()), parseRelativeTimes(text, ANCHOR, cfg()))
  assert.deepEqual(detectQueryTimes('没有时间词的普通问题', ANCHOR, cfg()), [])
  assert.deepEqual(detectQueryTimes('今天', Number.NaN, cfg()), [])
})

test('no match / invalid input returns an empty array and never throws', () => {
  for (const text of ['随便聊聊最近怎么样', 'hello world', '', '12345', '下午三点', '月份季节']) {
    assert.deepEqual(parseRelativeTimes(text, ANCHOR, cfg()), [], text)
  }
  assert.deepEqual(parseRelativeTimes(null, ANCHOR, cfg()), [])
  assert.deepEqual(parseRelativeTimes(42, ANCHOR, cfg()), [])
  assert.deepEqual(parseRelativeTimes([], ANCHOR, cfg()), [])
  assert.deepEqual(parseRelativeTimes('今天', Number.NaN, cfg()), [])
  assert.deepEqual(parseRelativeTimes('今天', Number.POSITIVE_INFINITY, cfg()), [])
  assert.deepEqual(parseRelativeTimes('今天', undefined, cfg()), [])
  assert.deepEqual(parseRelativeTimes('今天', '1700000000000', cfg()), [])
  assert.deepEqual(parseRelativeTimes(undefined, undefined, undefined), [])

  // A partial / broken config must not throw either.
  assert.equal(parseRelativeTimes('今天', ANCHOR, { time: { timezone: 'Bad/Zone' }, timeTag: 'nope' }).length, 1)
  assert.equal(parseRelativeTimes('今天', ANCHOR, {}).length, 1)
  assert.equal(parseRelativeTimes('今天', ANCHOR, null).length, 1)
  assert.doesNotThrow(() => parseRelativeTimes('今天', ANCHOR, { timeTag: { weekStart: 42 } }))
})

test('determinism: identical input yields deeply equal output', () => {
  const text = '上周五下午和三天后，以及2026年10月31日、三个月前、今年'
  const first = parseRelativeTimes(text, ANCHOR, cfg())
  const second = parseRelativeTimes(text, ANCHOR, cfg())
  assert.deepEqual(first, second)
  assert.ok(first.length >= 4, 'the mixed sentence produced several tags')
  assert.deepEqual(detectQueryTimes(text, ANCHOR, cfg()), first)

  const anchor = sh(2026, 11, 6, 10)
  const messages = [
    { content: '今天下午讨论', time: anchor },
    { content: '明天上午复盘', time: anchor },
  ]
  assert.deepEqual(
    extractTimeTags(messages, anchor, cfg()),
    extractTimeTags(messages, anchor, cfg()),
  )
})

// ---------------------------------------------------------------------------
// folder time tags
// ---------------------------------------------------------------------------

test('extractTimeTags: per-message anchors, createdAt fallback, sorting and dedupe', () => {
  const createdAt = sh(2026, 11, 7, 12)
  const messages = [
    { content: '明天上午开会', time: sh(2026, 11, 7, 9) },
    { content: '昨天加班到很晚' }, // no time -> createdAt anchor (2026-11-07)
    { content: '今天下午喝茶', time: sh(2026, 11, 7, 15) },
    { content: '前天复盘', time: sh(2026, 11, 6, 8) },
    { content: 42, time: sh(2026, 11, 7, 10) }, // non-string content is skipped
    { content: null },
    '今天', // not a message object
  ]
  const result = extractTimeTags(messages, createdAt, cfg())
  assert.equal(result.source, 'messages')
  assert.deepEqual(result.tags, [
    { label: '前天', from: sh(2026, 11, 4), to: sh(2026, 11, 5), granularity: 'day' },
    { label: '昨天', from: sh(2026, 11, 6), to: sh(2026, 11, 7), granularity: 'day' },
    { label: '今天', from: sh(2026, 11, 7), to: sh(2026, 11, 8), granularity: 'day' },
    { label: '明天', from: sh(2026, 11, 8), to: sh(2026, 11, 9), granularity: 'day' },
  ])
  // Stored tags carry no `expression` field.
  for (const tag of result.tags) assert.deepEqual(Object.keys(tag).sort(), ['from', 'granularity', 'label', 'to'])

  // The same interval found through different labels is merged; the first label wins.
  const synonyms = extractTimeTags(
    [{ content: '今天', time: createdAt }, { content: '今日', time: createdAt }],
    createdAt,
    cfg(),
  )
  assert.equal(synonyms.tags.length, 1)
  assert.equal(synonyms.tags[0].label, '今天')

  // A numeric-string message.time is not a finite number -> createdAt fallback.
  const fallback = extractTimeTags([{ content: '昨天', time: '123' }], createdAt, cfg())
  assert.equal(fallback.tags.length, 1)
  expectWindow(fallback.tags[0], sh(2026, 11, 6), sh(2026, 11, 7), 'day')

  // Unusable createdAt and no per-message time -> no tags.
  assert.deepEqual(extractTimeTags([{ content: '今天' }], Number.NaN, cfg()), { tags: [], source: 'messages' })
  assert.deepEqual(extractTimeTags([{ content: '今天' }], '2026-11-07', cfg()), { tags: [], source: 'messages' })
})

test('extractTimeTags: truncation to maxPerFolder and non-array input', () => {
  const createdAt = sh(2026, 11, 7, 12)
  const messages = [
    { content: '昨天', time: sh(2026, 11, 6, 9) },
    { content: '今天', time: sh(2026, 11, 7, 9) },
    { content: '明天', time: sh(2026, 11, 8, 9) },
  ]
  const truncated = extractTimeTags(messages, createdAt, cfg(ASIA, { maxPerFolder: 2 }))
  assert.equal(truncated.tags.length, 2)
  assert.deepEqual(labels(truncated.tags), ['昨天', '今天'])
  assert.equal(extractTimeTags(messages, createdAt, cfg(ASIA, { maxPerFolder: 1 })).tags.length, 1)
  assert.equal(extractTimeTags(messages, createdAt, cfg()).tags.length, 3)

  for (const bad of [null, undefined, {}, 'messages', 42]) {
    assert.deepEqual(extractTimeTags(bad, createdAt, cfg()), { tags: [], source: 'messages' })
  }
  assert.deepEqual(extractTimeTags([], createdAt, cfg()), { tags: [], source: 'messages' })
})

// ---------------------------------------------------------------------------
// interval overlap
// ---------------------------------------------------------------------------

test('intervalsOverlap: half-open semantics and invalid input', () => {
  const base = { from: 0, to: 10 }
  assert.equal(intervalsOverlap(base, { from: 10, to: 20 }), false, 'adjacent intervals do not overlap')
  assert.equal(intervalsOverlap({ from: 10, to: 20 }, base), false)
  assert.equal(intervalsOverlap(base, { from: 9, to: 20 }), true)
  assert.equal(intervalsOverlap(base, { from: -5, to: 5 }), true)
  assert.equal(intervalsOverlap(base, { from: 0, to: 10 }), true)
  assert.equal(intervalsOverlap(base, { from: 2, to: 8 }), true, 'containment overlaps')
  assert.equal(intervalsOverlap({ from: 2, to: 8 }, base), true)
  assert.equal(intervalsOverlap({ from: 5, to: 5 }, base), false, 'empty intervals overlap nothing')
  assert.equal(intervalsOverlap(null, base), false)
  assert.equal(intervalsOverlap(base, undefined), false)
  assert.equal(intervalsOverlap(base, {}), false)
  assert.equal(intervalsOverlap(base, { from: 0, to: Number.POSITIVE_INFINITY }), false)
  assert.equal(intervalsOverlap({ from: 10, to: 0 }, base), false)
  assert.equal(intervalsOverlap('x', base), false)
  assert.equal(intervalsOverlap(42, 43), false)
})
