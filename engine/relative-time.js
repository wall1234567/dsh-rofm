/**
 * dsh-rofm engine — deterministic fuzzy time expression parser (time tags)
 * (design §3.1, plan §1/§2).
 *
 * Design rules (deliberate, do not "optimise" away):
 *
 * 1. Deterministic and pure: the anchor instant is always passed in
 *    (`anchorMs` / `nowMs` / per-message `time`). Nothing reads `Date.now()`,
 *    nothing is random and nothing depends on the host locale: the same
 *    (text, anchorMs, cfg) always yields exactly the same tags.
 * 2. Time-zone aware: every calendar boundary is derived from the Intl helpers
 *    of `engine/time-index.js` (`zonedDayStart`, `zonedMonthStart`,
 *    `zonedYearStart`, `instantForCivil`, `addZonedMonths`). A day is a *local*
 *    calendar day, never `±86_400_000`; `''` means "host local time zone" and
 *    anything else is an IANA zone id.
 * 3. Half-open intervals: every tag is `[from, to)` in epoch milliseconds.
 *    A `2026-10-31` tag covers `[2026-10-31 00:00, 2026-11-01 00:00)` in the
 *    configured zone, and two adjacent calendar windows never overlap.
 * 4. Granularity is the *width* of the interval: `'day'` = one local calendar
 *    day, `'week'` = one week (week start from `timeTag.weekStart`,
 *    1 = Monday … 7 = Sunday),
 *    `'month'` = one natural month, `'year'` = one natural year. A weekday
 *    expression (`下周二`) therefore has granularity `'day'` — it names one day.
 * 5. Failure safety: malformed / non-string input never throws — `[]` is
 *    returned, and an impossible date (`2026-02-30`) produces no tag.
 * 6. Span cap: `timeTag.maxSpanDays` really bounds the width of one produced
 *    window. An expression whose window is wider than `maxSpanDays` days is
 *    discarded and yields no tag (the cap is inclusive: a window exactly as
 *    wide as the cap is kept). With the default 366 the `一年后` year window
 *    (365 days) survives, while `maxSpanDays: 1` drops 一年后/本周/下个月/今年.
 *    The cap measures the window width, never the distance from the anchor
 *    (「999天后」 is a one-day window and stays).
 *
 * Supported Chinese syntax:
 *   今天/今日/昨天/昨日/前天/明天/明日/后天/大后天/大前天
 *   [这|本|上|下|上上|下下]周/星期/礼拜 + 一..六/日/天,
 *   裸 周X/星期X/礼拜X (anchor's week),
 *   [这|本|上|下|上上|下下]周/星期/礼拜 (whole week),
 *   [这|本|上|下|上上|下下](个)月 (whole month),
 *   今年/明年/去年 (whole year),
 *   N天/日, N周/星期, N(个)月, N(个)年前/后 (Arabic digits or Chinese numerals),
 *   X月X日/号 (X may be a Chinese numeral), X月,
 *   YYYY-MM-DD, YYYY-MM, YYYY年M月D日, YYYY年M月, YYYY年.
 *
 * Deliberately NOT supported (documented limitation, no partial guessing):
 *   - `下下周` / `上上周` as a *whole-week* word is supported, but
 *     `大前年`/`后年`/`前年` are not;
 *   - combined expressions such as `去年12月` or `上个月15号`: each part is
 *     tagged separately instead of being merged into a single interval;
 *   - English expressions, ISO datetimes and raw epoch values;
 *   - time-of-day words (`早上/上午/中午/下午/晚上/凌晨`) never change the day
 *     window: `今天下午` is still exactly the local day of `今天`.
 *
 * A yearless explicit date (`X月X日`) resolves to the nearest same-year date:
 * the anchor-year candidate is kept when it lies within ±183 days of the
 * anchor, otherwise the adjacent year is used (`12月31日` anchored in early
 * January lands in the *previous* year). A yearless `X月` follows the same
 * ±183-day rule. `2月29日` resolves to the nearest year in which the date
 * exists.
 *
 * The module depends on nothing outside `./time-index.js` (zero external deps).
 */

import {
  addZonedMonths,
  civilAt,
  instantForCivil,
  validateTimezone,
  zonedDayStart,
  zonedMonthStart,
  zonedYearStart,
} from './time-index.js'

const DAY_MS = 86400000
/** Largest timestamp a JS `Date` can represent (±100,000,000 days). */
const MAX_SAFE_TIMESTAMP = 8.64e15
const MAX_DAY_NUMBER = 100000000
const MAX_YEAR = 9999
/** Yearless dates farther than this from the anchor switch to the adjacent year. */
const NEAREST_DATE_WINDOW_DAYS = 183

/** Defaults for the `timeTag` config group (design §2). Frozen for safety. */
const TIME_TAG_DEFAULTS = Object.freeze({
  timezone: '', // '' = host local time zone
  weekStart: 1, // 1 = Monday … 7 = Sunday (config contract; 7 maps to JS weekday 0)
  maxPerFolder: 8,
  maxSpanDays: 366,
})

const GRANULARITY_DAY = 'day'
const GRANULARITY_WEEK = 'week'
const GRANULARITY_MONTH = 'month'
const GRANULARITY_YEAR = 'year'

// ---------------------------------------------------------------------------
// small value / calendar helpers (Intl-free proleptic Gregorian arithmetic;
// the zone-dependent boundaries themselves always come from time-index.js)
// ---------------------------------------------------------------------------

/** Whether `value` is a plain (non-array) object. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Whether `value` is a finite number inside the representable `Date` range. */
function isSafeTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_SAFE_TIMESTAMP
}

/** Whether `value` is an integer usable as a civil day number. */
function isSafeDayNumber(value) {
  return Number.isInteger(value) && Math.abs(value) <= MAX_DAY_NUMBER
}

/** Proleptic-Gregorian civil date -> days since 1970-01-01 (time-zone free). */
function civilDayNumber(civil) {
  const ms = Date.UTC(civil.year, (civil.month || 1) - 1, civil.day || 1)
  if (!Number.isFinite(ms)) return NaN
  // Date.UTC maps years 0..99 to 1900..1999; undo that for completeness.
  if (civil.year >= 0 && civil.year <= 99) {
    const date = new Date(ms)
    date.setUTCFullYear(civil.year)
    return Math.round(date.getTime() / DAY_MS)
  }
  return Math.round(ms / DAY_MS)
}

/** Inverse of {@link civilDayNumber}: unix day number -> civil date. */
function civilFromDayNumber(dayNumber) {
  const date = new Date(dayNumber * DAY_MS)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

/** 0 = Sunday … 6 = Saturday for a civil day number (1970-01-01 was Thursday). */
function weekdayOfDayNumber(dayNumber) {
  return (((dayNumber + 4) % 7) + 7) % 7
}

/** `year * 12 + (month - 1)` — a monotone index for month arithmetic. */
function civilPeriodIndex(civil) {
  return civil.year * 12 + (civil.month - 1)
}

/** Inverse of {@link civilPeriodIndex}. */
function civilFromPeriodIndex(period) {
  const year = Math.floor(period / 12)
  const month = (((period % 12) + 12) % 12) + 1
  return { year, month, day: 1 }
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30
  return 31
}

/** Whether `year-month-day` is a real proleptic-Gregorian date (years 1..9999). */
function isValidDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1 || year > MAX_YEAR) return false
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

/**
 * First instant of a civil day in `timeZone`. Goes through noon so that a day
 * whose 00:00 is skipped by a DST transition still maps to the right date
 * (`zonedDayStart` then walks to the first existing instant of that day).
 */
function dayStartOfCivil(civil, timeZone) {
  const noon = instantForCivil({ year: civil.year, month: civil.month, day: civil.day, hour: 12 }, timeZone)
  return Number.isFinite(noon) ? zonedDayStart(noon, timeZone) : NaN
}

/** First instant of the civil day with unix day number `dayNumber`. */
function dayStartByNumber(dayNumber, timeZone) {
  if (!isSafeDayNumber(dayNumber)) return NaN
  return dayStartOfCivil(civilFromDayNumber(dayNumber), timeZone)
}

/** First instant of a natural month in `timeZone`. */
function monthStartOf(year, month, timeZone) {
  if (!isValidDate(year, month, 1)) return NaN
  const noon = instantForCivil({ year, month, day: 15, hour: 12 }, timeZone)
  return Number.isFinite(noon) ? zonedMonthStart(noon, timeZone) : NaN
}

/** First instant of a natural year in `timeZone`. */
function yearStartOf(year, timeZone) {
  if (!Number.isInteger(year) || year < 1 || year > MAX_YEAR) return NaN
  const noon = instantForCivil({ year, month: 7, day: 1, hour: 12 }, timeZone)
  return Number.isFinite(noon) ? zonedYearStart(noon, timeZone) : NaN
}

/** `{from, to, granularity}` when the half-open interval is usable, else null. */
function makeWindow(from, to, granularity) {
  if (!isSafeTimestamp(from) || !isSafeTimestamp(to) || !(to > from)) return null
  return { from, to, granularity }
}

/** One local calendar day `[start, nextDayStart)`. */
function dayWindow(dayNumber, timeZone) {
  const from = dayStartByNumber(dayNumber, timeZone)
  const to = dayStartByNumber(dayNumber + 1, timeZone)
  return makeWindow(from, to, GRANULARITY_DAY)
}

/** One calendar week `[weekStart, weekStart + 7 days)`. */
function weekWindow(startDayNumber, timeZone) {
  const from = dayStartByNumber(startDayNumber, timeZone)
  const to = dayStartByNumber(startDayNumber + 7, timeZone)
  return makeWindow(from, to, GRANULARITY_WEEK)
}

/** One natural month. */
function monthWindow(year, month, timeZone) {
  const from = monthStartOf(year, month, timeZone)
  if (!Number.isFinite(from)) return null
  return makeWindow(from, addZonedMonths(from, 1, timeZone), GRANULARITY_MONTH)
}

/** One natural month addressed by month-period index. */
function monthWindowFromPeriod(period, timeZone) {
  const civil = civilFromPeriodIndex(period)
  if (civil.year < 1 || civil.year > MAX_YEAR) return null
  return monthWindow(civil.year, civil.month, timeZone)
}

/** One natural year. */
function yearWindow(year, timeZone) {
  const from = yearStartOf(year, timeZone)
  if (!Number.isFinite(from)) return null
  return makeWindow(from, addZonedMonths(from, 12, timeZone), GRANULARITY_YEAR)
}

// ---------------------------------------------------------------------------
// config reading (tolerate a missing / partially written cfg.timeTag group)
// ---------------------------------------------------------------------------

/** Integer from a number (range checked), else the fallback; never throws. */
function readInteger(value, fallback, min, max) {
  let numeric = value
  if (typeof numeric === 'string' && numeric.trim()) numeric = Number(numeric)
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || !Number.isInteger(numeric)) return fallback
  if (numeric < min || numeric > max) return fallback
  return numeric
}

/**
 * Read the `timeTag` config group with contract defaults as fallback. Never
 * throws and never mutates `cfg` (other modules own config validation).
 *
 * `timezone` comes from `cfg.time.timezone` (design §2; fallback
 * `cfg.timeTag.timezone` for callers that configured it there), everything else
 * from `cfg.timeTag`. Unknown / out-of-range values fall back to the defaults.
 * `weekStart` follows the config contract: `1` = Monday … `7` = Sunday.
 *
 * @param {object} [cfg] full plugin config (or undefined / a partial object)
 * @returns {{timezone: string, weekStart: number, maxPerFolder: number, maxSpanDays: number}}
 */
export function readTimeTagConfig(cfg) {
  const root = isPlainObject(cfg) ? cfg : {}
  // Accept an already-normalised object ({timezone, weekStart, …}) as well, so
  // callers can thread the result through cheaply without losing the zone.
  if (!isPlainObject(root.timeTag) && !isPlainObject(root.time) && typeof root.timezone === 'string') {
    return {
      timezone: validateTimezone(root.timezone).timezone,
      weekStart: readInteger(root.weekStart, TIME_TAG_DEFAULTS.weekStart, 1, 7),
      maxPerFolder: readInteger(root.maxPerFolder, TIME_TAG_DEFAULTS.maxPerFolder, 1, 64),
      maxSpanDays: readInteger(root.maxSpanDays, TIME_TAG_DEFAULTS.maxSpanDays, 1, 36600),
    }
  }
  const tagGroup = isPlainObject(root.timeTag) ? root.timeTag : {}
  const timeGroup = isPlainObject(root.time) ? root.time : {}
  const timezoneInput = timeGroup.timezone !== undefined ? timeGroup.timezone : tagGroup.timezone
  return {
    timezone: validateTimezone(timezoneInput).timezone,
    weekStart: readInteger(tagGroup.weekStart, TIME_TAG_DEFAULTS.weekStart, 1, 7),
    maxPerFolder: readInteger(tagGroup.maxPerFolder, TIME_TAG_DEFAULTS.maxPerFolder, 1, 64),
    maxSpanDays: readInteger(tagGroup.maxSpanDays, TIME_TAG_DEFAULTS.maxSpanDays, 1, 36600),
  }
}

// ---------------------------------------------------------------------------
// number / weekday parsing (Arabic digits and Chinese numerals)
// ---------------------------------------------------------------------------

const CHINESE_DIGITS = Object.freeze({
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
})

/**
 * Parse a non-negative quantity: `'3'`, `'十一'`, `'二十三'`, `'一百零三'` …
 * Returns `null` for anything that is not a plain number (never throws).
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseCount(raw) {
  if (typeof raw !== 'string' || !raw) return null
  if (/^[0-9]+$/.test(raw)) {
    const numeric = Number(raw)
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 9999) return null
    return numeric
  }
  let total = 0
  let digit = 0
  let sawNumber = false
  for (const char of raw) {
    if (Object.prototype.hasOwnProperty.call(CHINESE_DIGITS, char)) {
      digit = CHINESE_DIGITS[char]
      sawNumber = true
      continue
    }
    if (char === '十') {
      total += (digit || 1) * 10
      digit = 0
      sawNumber = true
      continue
    }
    if (char === '百') {
      total += (digit || 1) * 100
      digit = 0
      sawNumber = true
      continue
    }
    return null
  }
  if (!sawNumber) return null
  total += digit
  if (!Number.isInteger(total) || total < 0 || total > 9999) return null
  return total
}

const WEEKDAY_INDEX = Object.freeze({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 })

/** Weekday char -> 0 (Sunday) … 6 (Saturday); -1 when unknown. */
function weekdayIndex(char) {
  if (char && Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, char)) return WEEKDAY_INDEX[char]
  return -1
}

/**
 * Length-preserving half-width normalisation for scanning: U+FF01..U+FF5E
 * (full-width ASCII) become their ASCII counterparts. Real-world Chinese text
 * occasionally contains full-width digits, and keeping the length identical
 * means match offsets still index the original string exactly.
 */
function normalizeForScan(text) {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    out += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : char
  }
  return out
}

// ---------------------------------------------------------------------------
// anchor context: everything a rule builder needs, derived once per parse
// ---------------------------------------------------------------------------

/**
 * @param {number} anchorMs
 * @param {ReturnType<typeof readTimeTagConfig>} config
 * @returns {{
 *   cfg: ReturnType<typeof readTimeTagConfig>, timezone: string,
 *   civil: {year:number,month:number,day:number,hour:number,minute:number,second:number},
 *   dayNumber: number, weekStartIndex: number, weekStartDayNumber: number,
 * }}
 */
function buildAnchorContext(anchorMs, config) {
  const timezone = config.timezone
  const civil = civilAt(anchorMs, timezone)
  const dayNumber = civilDayNumber(civil)
  const weekday = weekdayOfDayNumber(dayNumber)
  // Config contract: 1 = Monday … 7 = Sunday; internals use 0 = Sunday.
  const weekStartIndex = config.weekStart === 7 ? 0 : config.weekStart
  const offsetFromWeekStart = ((weekday - weekStartIndex) % 7 + 7) % 7
  return {
    cfg: config,
    timezone,
    civil,
    dayNumber,
    weekStartIndex,
    weekStartDayNumber: dayNumber - offsetFromWeekStart,
  }
}

// ---------------------------------------------------------------------------
// rule builders (one per supported syntax family)
// ---------------------------------------------------------------------------

const DAY_WORD_OFFSETS = Object.freeze({
  今天: 0,
  今日: 0,
  昨天: -1,
  昨日: -1,
  前天: -2,
  明天: 1,
  明日: 1,
  后天: 2,
  大后天: 3,
  大前天: -3,
})

const WEEK_PREFIX_OFFSETS = Object.freeze({
  这: 0,
  本: 0,
  上: -1,
  下: 1,
  上上: -2,
  下下: 2,
})

const MONTH_PREFIX_OFFSETS = Object.freeze({
  这: 0,
  本: 0,
  上: -1,
  下: 1,
  上上: -2,
  下下: 2,
})

const YEAR_WORD_OFFSETS = Object.freeze({
  今年: 0,
  明年: 1,
  去年: -1,
})

function buildDayWord(match, ctx) {
  const offset = DAY_WORD_OFFSETS[match[0]]
  if (!Number.isInteger(offset)) return null
  return dayWindow(ctx.dayNumber + offset, ctx.timezone)
}

/** Explicit `year-month-day` (any input shape) -> one local day window. */
function buildExplicitDay(year, month, day, ctx) {
  if (!isValidDate(year, month, day)) return null
  return dayWindow(civilDayNumber({ year, month, day }), ctx.timezone)
}

function buildIsoDay(match, ctx) {
  return buildExplicitDay(Number(match[1]), Number(match[2]), Number(match[3]), ctx)
}

function buildIsoMonth(match, ctx) {
  return monthWindow(Number(match[1]), Number(match[2]), ctx.timezone)
}

function buildChineseYearDay(match, ctx) {
  const month = parseCount(match[2])
  const day = parseCount(match[3])
  if (month === null || day === null) return null
  return buildExplicitDay(Number(match[1]), month, day, ctx)
}

function buildChineseYearMonth(match, ctx) {
  const month = parseCount(match[2])
  if (month === null) return null
  return monthWindow(Number(match[1]), month, ctx.timezone)
}

function buildChineseYear(match, ctx) {
  return yearWindow(Number(match[1]), ctx.timezone)
}

/**
 * Yearless `X月X日`: the anchor-year candidate wins when it is within
 * ±183 days of the anchor; otherwise the adjacent year is used. When the date
 * does not exist in the anchor year (`2月29日` in a non-leap year) the nearest
 * year in which it exists is chosen (ties prefer the earlier year).
 */
function buildYearlessDay(month, day, ctx) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  if (!Number.isInteger(day) || day < 1 || day > 31) return null
  const anchorYear = ctx.civil.year
  if (!isValidDate(anchorYear, month, day)) {
    for (let offset = 1; offset <= 8; offset += 1) {
      for (const sign of [-1, 1]) {
        const year = anchorYear + sign * offset
        if (year < 1 || year > MAX_YEAR || !isValidDate(year, month, day)) continue
        return dayWindow(civilDayNumber({ year, month, day }), ctx.timezone)
      }
    }
    return null
  }
  let year = anchorYear
  const distance = civilDayNumber({ year, month, day }) - ctx.dayNumber
  if (distance > NEAREST_DATE_WINDOW_DAYS) year -= 1
  else if (distance < -NEAREST_DATE_WINDOW_DAYS) year += 1
  // A shifted leap day can vanish; in that case the anchor-year date is already
  // the nearest existing occurrence, so keep it.
  if (!isValidDate(year, month, day)) year = anchorYear
  return dayWindow(civilDayNumber({ year, month, day }), ctx.timezone)
}

function buildChineseDate(match, ctx) {
  const month = parseCount(match[1])
  const day = parseCount(match[2])
  if (month === null || day === null) return null
  return buildYearlessDay(month, day, ctx)
}

/**
 * Yearless `X月`: month start closest to the anchor (same ±183-day rule as a
 * yearless date). `12月` anchored in January therefore means last December.
 */
function buildChineseMonth(match, ctx) {
  const month = parseCount(match[1])
  if (month === null || month < 1 || month > 12) return null
  const anchorYear = ctx.civil.year
  let year = anchorYear
  const distance = civilDayNumber({ year: anchorYear, month, day: 1 }) - ctx.dayNumber
  if (distance > NEAREST_DATE_WINDOW_DAYS) year -= 1
  else if (distance < -NEAREST_DATE_WINDOW_DAYS) year += 1
  return monthWindow(year, month, ctx.timezone)
}

/** Whole week: `上周`, `下下星期`, `这礼拜` … */
function buildWeekWord(match, ctx) {
  const offset = WEEK_PREFIX_OFFSETS[match[1]]
  if (!Number.isInteger(offset)) return null
  return weekWindow(ctx.weekStartDayNumber + offset * 7, ctx.timezone)
}

/** One named weekday of a prefixed week: `下周二`, `上上周五` … */
function weekdayWindow(weekOffset, dayChar, ctx) {
  const index = weekdayIndex(dayChar)
  if (index < 0) return null
  const position = ((index - ctx.weekStartIndex) % 7 + 7) % 7
  return dayWindow(ctx.weekStartDayNumber + weekOffset * 7 + position, ctx.timezone)
}

function buildPrefixedWeekday(match, ctx) {
  const offset = WEEK_PREFIX_OFFSETS[match[1]]
  if (!Number.isInteger(offset)) return null
  return weekdayWindow(offset, match[2], ctx)
}

/** Bare weekday (`周三`, `星期天`): the weekday of the anchor's own week. */
function buildBareWeekday(match, ctx) {
  return weekdayWindow(0, match[1], ctx)
}

/** Whole month: `这个月`, `下个月`, `上上个月` … */
function buildMonthWord(match, ctx) {
  const offset = MONTH_PREFIX_OFFSETS[match[1]]
  if (!Number.isInteger(offset)) return null
  return monthWindowFromPeriod(civilPeriodIndex(ctx.civil) + offset, ctx.timezone)
}

/** Whole year: `今年` / `明年` / `去年`. */
function buildYearWord(match, ctx) {
  const offset = YEAR_WORD_OFFSETS[match[0]]
  if (!Number.isInteger(offset)) return null
  return yearWindow(ctx.civil.year + offset, ctx.timezone)
}

/** `N <unit> 前/后` window factory: day/week/month/year keep their natural width. */
const RELATIVE_UNIT_WINDOWS = Object.freeze({
  day: (count, sign, ctx) => dayWindow(ctx.dayNumber + sign * count, ctx.timezone),
  week: (count, sign, ctx) => weekWindow(ctx.weekStartDayNumber + sign * count * 7, ctx.timezone),
  month: (count, sign, ctx) =>
    monthWindowFromPeriod(civilPeriodIndex(ctx.civil) + sign * count, ctx.timezone),
  year: (count, sign, ctx) => yearWindow(ctx.civil.year + sign * count, ctx.timezone),
})

function buildRelative(unit) {
  const builder = RELATIVE_UNIT_WINDOWS[unit]
  return (match, ctx) => {
    const count = parseCount(match[1])
    if (count === null) return null
    const sign = match[2] === '前' ? -1 : 1
    return builder(count, sign, ctx)
  }
}

// ---------------------------------------------------------------------------
// syntax table
//
// `source` is compiled with the `g` flag for each parsed text. Rules may
// overlap (`10月31日` also matches `10月`); the scan keeps the longest
// non-overlapping match (earliest start first), so the most specific syntax
// always wins. `build(match, ctx)` returns `{from, to, granularity}` or null.
// ---------------------------------------------------------------------------

/** Arabic digits (1..3) or a run of Chinese numeral chars; `(?<!\d)` avoids partial runs. */
const COUNT_SOURCE = '(?<![0-9])([0-9]{1,3}|[零〇一二两三四五六七八九十百]+)'
/** Month/day component: 1-2 Arabic digits or up to 3 Chinese numeral chars. */
const COMPONENT_SOURCE = '([0-9]{1,2}|[一二两三四五六七八九十]{1,3})'
/** Prefixed week/month words; longest prefixes first so `上上周` wins over `上周`. */
const PREFIX_SOURCE = '(上上|下下|这|本|上|下)'

const RULES = Object.freeze([
  {
    id: 'day-word',
    source: '大后天|大前天|今天|今日|昨天|昨日|前天|明天|明日|后天',
    build: buildDayWord,
  },
  {
    id: 'iso-day',
    source: '(?<!\\d)(\\d{4})-(\\d{1,2})-(\\d{1,2})(?!\\d)',
    build: buildIsoDay,
  },
  {
    id: 'iso-month',
    source: '(?<!\\d)(\\d{4})-(\\d{1,2})(?!\\d)(?!-\\d)',
    build: buildIsoMonth,
  },
  {
    id: 'chinese-year-day',
    source: '(?<!\\d)(\\d{4})年' + COMPONENT_SOURCE + '月' + COMPONENT_SOURCE + '[日号]',
    build: buildChineseYearDay,
  },
  {
    id: 'chinese-year-month',
    source: '(?<!\\d)(\\d{4})年' + COMPONENT_SOURCE + '月',
    build: buildChineseYearMonth,
  },
  {
    id: 'chinese-year',
    source: '(?<!\\d)(\\d{4})年',
    build: buildChineseYear,
  },
  {
    id: 'chinese-date',
    source: COMPONENT_SOURCE + '月' + COMPONENT_SOURCE + '[日号]',
    build: buildChineseDate,
  },
  {
    id: 'chinese-month',
    source: COMPONENT_SOURCE + '月',
    build: buildChineseMonth,
  },
  {
    id: 'week-word',
    source: PREFIX_SOURCE + '(?:周|星期|礼拜)',
    build: buildWeekWord,
  },
  {
    id: 'weekday',
    source: PREFIX_SOURCE + '(?:周|星期|礼拜)([一二三四五六日天])',
    build: buildPrefixedWeekday,
  },
  {
    id: 'bare-weekday',
    source: '(?:周|星期|礼拜)([一二三四五六日天])',
    build: buildBareWeekday,
  },
  {
    id: 'month-word',
    source: PREFIX_SOURCE + '(?:个)?月',
    build: buildMonthWord,
  },
  {
    id: 'year-word',
    source: '今年|明年|去年',
    build: buildYearWord,
  },
  {
    id: 'relative-day',
    source: COUNT_SOURCE + '(?:天|日)(前|后)',
    build: buildRelative('day'),
  },
  {
    id: 'relative-week',
    source: COUNT_SOURCE + '(?:个)?(?:周|星期|礼拜)(前|后)',
    build: buildRelative('week'),
  },
  {
    id: 'relative-month',
    source: COUNT_SOURCE + '(?:个)?月(前|后)',
    build: buildRelative('month'),
  },
  {
    id: 'relative-year',
    source: COUNT_SOURCE + '(?:个)?年(前|后)',
    build: buildRelative('year'),
  },
])

// ---------------------------------------------------------------------------
// parsing core
// ---------------------------------------------------------------------------

/** Deterministic tag ordering: interval start, interval end, then label. */
function compareTags(left, right) {
  if (left.from !== right.from) return left.from - right.from
  if (left.to !== right.to) return left.to - right.to
  if (left.label === right.label) return 0
  return left.label < right.label ? -1 : 1
}

/**
 * Scan `text` with every rule, keep the longest non-overlapping matches, build
 * their windows and return the deduplicated, sorted tag list. The caller has
 * already validated `text` / `anchorMs` / `config`.
 */
function parseWithConfig(text, anchorMs, config) {
  const scan = normalizeForScan(text)
  const ctx = buildAnchorContext(anchorMs, config)

  /** @type {Array<{index:number,length:number,ruleIndex:number,match:RegExpExecArray}>} */
  const candidates = []
  for (let ruleIndex = 0; ruleIndex < RULES.length; ruleIndex += 1) {
    const rule = RULES[ruleIndex]
    const regex = new RegExp(rule.source, 'g')
    let match = regex.exec(scan)
    while (match !== null) {
      candidates.push({ index: match.index, length: match[0].length, ruleIndex, match })
      if (match[0].length === 0) regex.lastIndex += 1 // defensive: never loop forever
      match = regex.exec(scan)
    }
  }

  // Earliest start first; among matches starting at the same offset the longest
  // one wins (so `2026年10月31日` is never split into `2026年` + `10月`).
  candidates.sort((left, right) => {
    if (left.index !== right.index) return left.index - right.index
    if (left.length !== right.length) return right.length - left.length
    return left.ruleIndex - right.ruleIndex
  })

  const tags = []
  let coveredUntil = 0
  for (const candidate of candidates) {
    if (candidate.index < coveredUntil) continue
    coveredUntil = candidate.index + candidate.length
    const window = RULES[candidate.ruleIndex].build(candidate.match, ctx)
    if (!window) continue
    // F-03-01: `timeTag.maxSpanDays` is a real span cap — an expression wider
    // than the cap is dropped entirely (no tag), never truncated to the cap.
    if (window.to - window.from > config.maxSpanDays * DAY_MS) continue
    const label = candidate.match[0]
    tags.push({
      label,
      expression: label,
      from: window.from,
      to: window.to,
      granularity: window.granularity,
    })
  }

  tags.sort(compareTags)
  const seen = new Set()
  const unique = []
  for (const tag of tags) {
    const key = `${tag.from}|${tag.to}|${tag.label}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(tag)
  }
  return unique
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Parse every fuzzy time expression in `text` into half-open time-tag windows.
 *
 * Pure and deterministic: the same `(text, anchorMs, cfg)` always yields the
 * same array. Relative expressions (`今天`, `下周二`, `三天后`, …) are resolved
 * against `anchorMs` in the configured IANA time zone; explicit dates
 * (`2026-10-31`, `2026年10月`, …) are absolute and ignore the anchor. An
 * expression whose produced window is wider than `timeTag.maxSpanDays` days is
 * discarded (F-03-01; default 366). The result is sorted by `from`, then `to`,
 * then `label`, and duplicates (`from|to|label`) are removed.
 *
 * @param {unknown} text scanned text (non-string input returns `[]`)
 * @param {number} anchorMs anchor instant, epoch milliseconds (must be finite)
 * @param {object} [cfg] plugin config; `time.timezone` + `timeTag.*`
 * @returns {Array<{label: string, expression: string, from: number, to: number,
 *   granularity: 'day'|'week'|'month'|'year'}>}
 *   half-open `[from, to)` windows in epoch ms; `[]` when nothing matches
 */
export function parseRelativeTimes(text, anchorMs, cfg) {
  if (typeof text !== 'string' || !text) return []
  if (!isSafeTimestamp(anchorMs)) return []
  const config = readTimeTagConfig(cfg)
  return parseWithConfig(text, anchorMs, config)
}

/**
 * Derive the deterministic `timeTags` of one archived folder from its messages.
 *
 * Every message is anchored at its own `time` (finite number) or at
 * `createdAt`; only string `content` values are scanned. Tags of all messages
 * are merged, deduplicated by interval (`from|to`, first label wins), sorted by
 * `from` and truncated to `timeTag.maxPerFolder`. Every tag already honours the
 * `timeTag.maxSpanDays` span cap (via {@link parseRelativeTimes}). The result is
 * exactly the shape stored on `meta.timeTags` (`{label, from, to, granularity}`
 * — no `expression`), with `source: 'messages'`. Never throws.
 *
 * @param {unknown} messages archive messages (`{content:string, time?:number}`)
 * @param {number} createdAt folder creation instant used as fallback anchor
 * @param {object} [cfg] plugin config; `time.timezone` + `timeTag.*`
 * @returns {{
 *   tags: Array<{label: string, from: number, to: number,
 *     granularity: 'day'|'week'|'month'|'year'}>,
 *   source: 'messages',
 * }}
 */
export function extractTimeTags(messages, createdAt, cfg) {
  const config = readTimeTagConfig(cfg)
  const result = { tags: [], source: 'messages' }
  if (!Array.isArray(messages)) return result
  const fallbackAnchor = isSafeTimestamp(createdAt) ? createdAt : NaN
  const collected = []
  for (const message of messages) {
    if (!isPlainObject(message)) continue
    const content = message.content
    if (typeof content !== 'string' || !content) continue
    const anchor = isSafeTimestamp(message.time) ? message.time : fallbackAnchor
    if (!Number.isFinite(anchor)) continue
    for (const tag of parseWithConfig(content, anchor, config)) collected.push(tag)
  }
  collected.sort(compareTags)
  const seen = new Set()
  for (const tag of collected) {
    const key = `${tag.from}|${tag.to}`
    if (seen.has(key)) continue
    seen.add(key)
    result.tags.push({ label: tag.label, from: tag.from, to: tag.to, granularity: tag.granularity })
    if (result.tags.length >= config.maxPerFolder) break
  }
  return result
}

/**
 * Parse the fuzzy time expressions of an automatic-recall query. Same contract
 * as {@link parseRelativeTimes}, anchored at `nowMs`.
 *
 * @param {unknown} text query text
 * @param {number} nowMs current instant, epoch milliseconds
 * @param {object} [cfg] plugin config; `time.timezone` + `timeTag.*`
 * @returns {ReturnType<typeof parseRelativeTimes>}
 */
export function detectQueryTimes(text, nowMs, cfg) {
  return parseRelativeTimes(text, nowMs, cfg)
}

/**
 * Half-open interval overlap: `a.from < b.to && b.from < a.to`.
 *
 * Adjacent intervals (`[0,10)` / `[10,20)`) do not overlap; an empty interval
 * (`to <= from`) overlaps nothing. Malformed input (missing / non-finite
 * bounds, non-object values) returns `false` and never throws.
 *
 * @param {{from?:unknown,to?:unknown}} a
 * @param {{from?:unknown,to?:unknown}} b
 * @returns {boolean}
 */
export function intervalsOverlap(a, b) {
  const left = readInterval(a)
  const right = readInterval(b)
  if (!left || !right) return false
  return left.from < right.to && right.from < left.to
}

/** Valid half-open interval `{from,to}` (finite, non-empty) or null. */
function readInterval(value) {
  if (!isPlainObject(value)) return null
  const from = value.from
  const to = value.to
  if (!isSafeTimestamp(from) || !isSafeTimestamp(to)) return null
  if (!(to > from)) return null
  return { from, to }
}
