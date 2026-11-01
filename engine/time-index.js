/**
 * dsh-rofm engine — in-memory time index and time query normalisation
 * (contract §5.3, plan §3.3).
 *
 * Design rules (deliberate, do not "optimise" away):
 *
 * 1. There are **no physical day/month/year folders**. The index is derived from
 *    `index.folders` on every (lazy) build and never written to disk: the folder
 *    tree stays the only source of truth (plan §3.3.1).
 * 2. There is exactly **one matching rule**: a folder covers the half-open
 *    interval `[start, end)` and a query window is the half-open interval
 *    `[from, to)`; they match when `start < to && end > from` (interval overlap).
 *    Day buckets are only a candidate filter — the exact overlap test below
 *    always decides, so buckets can never change semantics.
 * 3. Folder event interval: `[eventStart, eventEnd)` when
 *    `eventTimeSource` is `'messages' | 'judge'`, otherwise the folder falls
 *    back to its archive time `[createdAt, createdAt + 1)` (`'archive'`). Old
 *    data without event times therefore still works unchanged.
 * 4. Every calendar boundary is computed through `Intl.DateTimeFormat` for the
 *    configured IANA time zone. We never derive a day boundary with
 *    `±86_400_000` (DST days are 23/25 hours long, leap years have 366 days).
 * 5. Failure safety: malformed input never throws — the normaliser degrades to
 *    "no time constraint" and pushes a human readable warning.
 *
 * Time zones: all stored/returned values are epoch milliseconds; `''` means
 * "host local time zone" (the engine default), anything else must be an IANA
 * zone id (`Asia/Shanghai`, `UTC`, …).
 *
 * The module has no dependency outside `node:` builtins (engine/ is standalone).
 */

/** Defaults for the `time` config group (contract §4). Frozen for safety. */
export const TIME_DEFAULTS = Object.freeze({
  mode: 'index', // 'off' | 'index' | 'constrain' — only 'constrain' filters recall
  timezone: '', // '' = host local, packaged config.json uses 'Asia/Shanghai'
  minRangeDays: 3,
  maxRangeDays: 366,
  centerDayPriority: true,
  fallback: Object.freeze(['day3', 'month', 'year', 'all']),
  fallbackMinResults: 1,
  windowScanMax: 4096,
  askUserHint: true,
  judgeEventTime: false,
})

const DAY_MS = 86400000
/** Largest timestamp a JS `Date` can represent (±100,000,000 days). */
const MAX_SAFE_TIMESTAMP = 8.64e15
const MAX_CACHED_TIME_ZONES = 32
const MAX_CACHED_SECONDS = 8192
const MAX_FOLDER_SPAN_DAYS = 3660 // 10 years: corrupt event ranges must not explode the index
const MAX_SPAN_WARNINGS = 5
const ALLOWED_FALLBACK = ['day3', 'month', 'year', 'all']
/** Which widening steps make sense for each L0 level (contract §5.3). */
const WIDENING_PATH = {
  day: ['day3', 'month', 'year', 'all'],
  month: ['year', 'all'],
  year: ['all'],
  all: [],
}
const LEVEL_RANK = { day: 0, month: 1, year: 2 }
const SOURCE_ARCHIVE = 'archive'
const SOURCE_MESSAGES = 'messages'
const SOURCE_JUDGE = 'judge'
const EVENT_SOURCES = new Set([SOURCE_MESSAGES, SOURCE_JUDGE])

// ---------------------------------------------------------------------------
// calendar primitives (Intl based; '' = host local time zone)
// ---------------------------------------------------------------------------

/** tz -> Intl.DateTimeFormat (bounded: a plugin only ever uses a few zones). */
const formatterCache = new Map()
/** `${tz}\0${epochSecond}` -> civil parts (bounded, cleared on overflow). */
const civilCache = new Map()
/** tz -> validateTimezone() result. */
const timezoneCache = new Map()

const pad2 = (value) => String(value).padStart(2, '0')
const pad4 = (value) => String(value).padStart(4, '0')

/**
 * Whether `value` can be turned into a valid `Date` (finite and inside the
 * representable epoch range). Corrupt `createdAt` / event fields must degrade,
 * not throw, so every calendar helper funnels through this guard.
 */
function isSafeTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_SAFE_TIMESTAMP
}

/** Numeric (or numeric-string) timestamp inside the valid `Date` range, else NaN. */
function toTimestamp(value) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return isSafeTimestamp(numeric) ? numeric : NaN
}

/**
 * Optional index field -> safe epoch ms or NaN. Unlike {@link toTimestamp} this
 * rejects `null`/`undefined`/`''` (they mean "not present", not epoch zero).
 */
function optionalTimestamp(value) {
  if (typeof value === 'number') return isSafeTimestamp(value) ? value : NaN
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    return isSafeTimestamp(numeric) ? numeric : NaN
  }
  return NaN
}

/**
 * Resolve a civil date/time in `timeZone` into epoch ms. Uses the documented
 * two-pass offset algorithm (the same one date-fns-tz uses) instead of doing
 * arithmetic on offsets by hand; ambiguous wall times resolve to the first
 * matching instant and non-existent wall times to the nearest existing one.
 *
 * @param {{year:number,month:number,day:number,hour?:number,minute?:number,second?:number}} civil
 * @param {string} tz canonical IANA zone or '' for host local
 * @returns {number}
 */
function utcFromCivil(civil) {
  const year = civil.year
  let ms = Date.UTC(
    year,
    (civil.month || 1) - 1,
    civil.day || 1,
    civil.hour || 0,
    civil.minute || 0,
    civil.second || 0,
  )
  if (!Number.isFinite(ms)) return NaN
  // Date.UTC maps years 0..99 to 1900..1999; undo that for completeness.
  if (year >= 0 && year <= 99) {
    const date = new Date(ms)
    date.setUTCFullYear(year)
    ms = date.getTime()
  }
  return ms
}

function formatterFor(timeZone) {
  const key = timeZone || ''
  let formatter = formatterCache.get(key)
  if (formatter) return formatter
  formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  if (formatterCache.size >= MAX_CACHED_TIME_ZONES) formatterCache.clear()
  formatterCache.set(key, formatter)
  return formatter
}

/**
 * Calendar fields of `ms` in `timeZone`. The cache is keyed by whole second:
 * calendar fields never depend on the millisecond part, so this is exact.
 *
 * @param {number} ms
 * @param {string} timeZone
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}}
 */
function civilAt(ms, timeZone) {
  const whole = isSafeTimestamp(ms) ? Math.floor(ms / 1000) * 1000 : 0
  const key = `${timeZone || ''}\u0000${whole}`
  const cached = civilCache.get(key)
  if (cached) return cached
  const parts = formatterFor(timeZone).formatToParts(new Date(whole))
  const civil = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 }
  for (const part of parts) {
    if (part.type === 'year') civil.year = Number(part.value)
    else if (part.type === 'month') civil.month = Number(part.value)
    else if (part.type === 'day') civil.day = Number(part.value)
    else if (part.type === 'hour') civil.hour = Number(part.value) % 24
    else if (part.type === 'minute') civil.minute = Number(part.value)
    else if (part.type === 'second') civil.second = Number(part.value)
  }
  if (civilCache.size >= MAX_CACHED_SECONDS) civilCache.clear()
  civilCache.set(key, civil)
  return civil
}

/** UTC offset (ms) of `timeZone` at instant `ms`; whole-second precision. */
function offsetAt(ms, timeZone) {
  const whole = Math.floor(ms / 1000) * 1000
  return utcFromCivil(civilAt(whole, timeZone)) - whole
}

/** Civil wall time in `timeZone` -> epoch ms (two-pass offset resolution). */
function instantForCivil(civil, timeZone) {
  const wall = utcFromCivil(civil)
  if (!Number.isFinite(wall)) return NaN
  const firstOffset = offsetAt(wall, timeZone)
  const secondOffset = offsetAt(wall - firstOffset, timeZone)
  if (firstOffset === secondOffset) return wall - firstOffset
  return wall - secondOffset
}

/** Calendar day index: days since 1970-01-01 in the *local* calendar. */
function civilDayIndex(civil) {
  return Math.floor(utcFromCivil({ year: civil.year, month: civil.month, day: civil.day }) / DAY_MS)
}

/** Inverse of {@link civilDayIndex} (pure proleptic-Gregorian arithmetic). */
function civilFromDayIndex(index) {
  const date = new Date(index * DAY_MS)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function sameCivilDay(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day
}

function civilPeriodIndex(civil) {
  return civil.year * 12 + (civil.month - 1)
}

/**
 * First instant of the local calendar day containing `ms` (see
 * {@link zonedDayStart}).
 */
function dayStartInstant(ms, timeZone) {
  const civil = civilAt(ms, timeZone)
  const target = { year: civil.year, month: civil.month, day: civil.day, hour: 0, minute: 0, second: 0 }
  let instant = instantForCivil(target, timeZone)
  if (!Number.isFinite(instant)) return NaN
  // Some zones skip 00:00 on DST days: take the first existing instant of the day.
  if (!sameCivilDay(civilAt(instant, timeZone), target)) {
    for (let step = 1; step <= 180; step += 1) {
      const candidate = instant + step * 60000
      if (sameCivilDay(civilAt(candidate, timeZone), target)) {
        instant = candidate
        break
      }
    }
  }
  // Ambiguous midnight (clocks moved back over 00:00): keep the earliest instant.
  for (let step = 0; step < 180; step += 1) {
    if (!sameCivilDay(civilAt(instant - 60000, timeZone), target)) break
    instant -= 60000
  }
  return instant
}

/** First instant of the local calendar month containing `ms`. */
function monthStartInstant(ms, timeZone) {
  const civil = civilAt(ms, timeZone)
  const target = { year: civil.year, month: civil.month, day: 1, hour: 0, minute: 0, second: 0 }
  const period = civilPeriodIndex(civil)
  let instant = instantForCivil(target, timeZone)
  if (!Number.isFinite(instant)) return NaN
  // Walk forward when 00:00 of the 1st does not exist (DST at midnight).
  for (let step = 0; step < 180; step += 1) {
    if (civilPeriodIndex(civilAt(instant, timeZone)) >= period) break
    instant += 60000
  }
  // Walk back to the first instant that already belongs to the month.
  for (let step = 0; step < 180; step += 1) {
    if (civilPeriodIndex(civilAt(instant - 60000, timeZone)) !== period) break
    instant -= 60000
  }
  return instant
}

/** First instant of the local calendar year containing `ms`. */
function yearStartInstant(ms, timeZone) {
  const civil = civilAt(ms, timeZone)
  const target = { year: civil.year, month: 1, day: 1, hour: 0, minute: 0, second: 0 }
  const year = civil.year
  let instant = instantForCivil(target, timeZone)
  if (!Number.isFinite(instant)) return NaN
  for (let step = 0; step < 180; step += 1) {
    if (civilAt(instant, timeZone).year >= year) break
    instant += 60000
  }
  for (let step = 0; step < 180; step += 1) {
    if (civilAt(instant - 60000, timeZone).year !== year) break
    instant -= 60000
  }
  return instant
}

/** Calendar day index of the day containing `ms` in `timeZone`. */
function dayIndexOf(ms, timeZone) {
  return civilDayIndex(civilAt(ms, timeZone))
}

/** `'YYYY-MM-DD'` for a day index (inverse of {@link dayIndexOf}). */
function dayKeyOfIndex(index) {
  const civil = civilFromDayIndex(index)
  return `${pad4(civil.year)}-${pad2(civil.month)}-${pad2(civil.day)}`
}

function monthKeyOfIndex(index) {
  const year = Math.floor(index / 12)
  const month = ((index % 12) + 12) % 12 + 1
  return `${pad4(year)}-${pad2(month)}`
}

function yearKeyOfIndex(year) {
  return pad4(year)
}

/** Whole months between two civil datetimes (used for calendar month addition). */
function addMonthsToCivil(civil, months) {
  const total = civilPeriodIndex(civil) + months
  const year = Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12 + 1
  const day = Math.min(civil.day, daysInMonth(year, month))
  return { year, month, day, hour: civil.hour || 0, minute: civil.minute || 0, second: civil.second || 0 }
}

// ---------------------------------------------------------------------------
// public calendar helpers (contract §5.3)
// ---------------------------------------------------------------------------

/**
 * Validate an IANA time zone. `''`/`null`/`undefined` means "host local" and is
 * always valid. Never throws.
 *
 * @param {unknown} timezone
 * @returns {{ ok: boolean, timezone: string, warning?: string }}
 */
export function validateTimezone(timezone) {
  const key = typeof timezone === 'string' ? timezone : `\u0000${typeof timezone}`
  const cached = timezoneCache.get(key)
  if (cached) return cached
  let result
  if (timezone === undefined || timezone === null || timezone === '') {
    result = { ok: true, timezone: '' }
  } else if (typeof timezone !== 'string') {
    result = {
      ok: false,
      timezone: '',
      warning: `time.timezone: expected an IANA time zone string; got ${describeValue(timezone)}; using host local time`,
    }
  } else if (!timezone.trim()) {
    result = { ok: true, timezone: '' }
  } else {
    const trimmed = timezone.trim()
    try {
      const formatter = new Intl.DateTimeFormat('en-US', { timeZone: trimmed })
      const resolved = formatter.resolvedOptions().timeZone
      result = { ok: true, timezone: typeof resolved === 'string' && resolved ? resolved : trimmed }
    } catch {
      result = {
        ok: false,
        timezone: '',
        warning: `time.timezone: unknown IANA time zone ${JSON.stringify(trimmed)}; using host local time`,
      }
    }
  }
  if (timezoneCache.size >= MAX_CACHED_TIME_ZONES) timezoneCache.clear()
  timezoneCache.set(key, result)
  return result
}

/**
 * Start of the calendar day containing `ms` in `timeZone` (epoch ms).
 * Uses calendar arithmetic — never `ms - (ms % DAY_MS)`.
 *
 * @param {number} ms
 * @param {string} [timeZone]
 * @returns {number}
 */
export function zonedDayStart(ms, timeZone) {
  const value = toTimestamp(ms)
  if (!Number.isFinite(value)) return NaN
  return dayStartInstant(value, validateTimezone(timeZone).timezone)
}

/**
 * Start of the calendar month containing `ms` in `timeZone`.
 * @param {number} ms
 * @param {string} [timeZone]
 * @returns {number}
 */
export function zonedMonthStart(ms, timeZone) {
  const value = toTimestamp(ms)
  if (!Number.isFinite(value)) return NaN
  return monthStartInstant(value, validateTimezone(timeZone).timezone)
}

/**
 * Start of the calendar year containing `ms` in `timeZone`.
 * @param {number} ms
 * @param {string} [timeZone]
 * @returns {number}
 */
export function zonedYearStart(ms, timeZone) {
  const value = toTimestamp(ms)
  if (!Number.isFinite(value)) return NaN
  return yearStartInstant(value, validateTimezone(timeZone).timezone)
}

/**
 * `'YYYY-MM-DD'` key of the local calendar day containing `ms`; `''` when `ms`
 * is not a finite number.
 *
 * @param {number} ms
 * @param {string} [timeZone]
 * @returns {string}
 */
export function dayKey(ms, timeZone) {
  const value = toTimestamp(ms)
  if (!Number.isFinite(value)) return ''
  return dayKeyOfIndex(dayIndexOf(value, validateTimezone(timeZone).timezone))
}

/**
 * Add calendar days to `ms` keeping the local wall-clock time (normalised when
 * that wall time does not exist because of a DST transition). Never uses
 * `±86_400_000`.
 *
 * @param {number} ms
 * @param {number} days integer number of days (fraction is truncated)
 * @param {string} [timeZone]
 * @returns {number}
 */
export function addZonedDays(ms, days, timeZone) {
  const value = toTimestamp(ms)
  const amount = Number(days)
  if (!Number.isFinite(value) || !Number.isFinite(amount)) return NaN
  const step = Math.trunc(amount)
  if (step === 0) return value
  const tz = validateTimezone(timeZone).timezone
  const civil = civilAt(value, tz)
  const fakeUtc = utcFromCivil({ year: civil.year, month: civil.month, day: civil.day }) + step * DAY_MS
  const date = new Date(fakeUtc)
  if (!Number.isFinite(date.getTime())) return NaN
  const target = {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: civil.hour,
    minute: civil.minute,
    second: civil.second,
  }
  const remainder = ((value % 1000) + 1000) % 1000
  return instantForCivil(target, tz) + remainder
}

/** Add calendar months (same wall-clock preserving semantics). Internal helper. */
function addZonedMonths(ms, months, timeZone) {
  const value = toTimestamp(ms)
  const amount = Number(months)
  if (!Number.isFinite(value) || !Number.isFinite(amount)) return NaN
  const step = Math.trunc(amount)
  if (step === 0) return value
  const civil = civilAt(value, timeZone)
  const target = addMonthsToCivil(civil, step)
  const remainder = ((value % 1000) + 1000) % 1000
  return instantForCivil(target, timeZone) + remainder
}

/**
 * One-line, human readable rendering of a normalised window / ladder rung:
 * `'2026-10-31'` for a single day, `'2026-10'` for a whole month, `'2026'` for a
 * whole year, `'2026-10-30 ~ 2026-11-01'` for a multi-day span and `'全部时间'`
 * for "no constraint".
 *
 * @param {{from?:number|null,to?:number|null,level?:string}|null} window
 * @param {string} [timeZone]
 * @returns {string}
 */
export function formatWindow(window, timeZone) {
  if (!window || typeof window !== 'object') return ''
  const tz = validateTimezone(timeZone).timezone
  const from = Number(window.from)
  const to = Number(window.to)
  if (window.level === 'all' || !isSafeTimestamp(from) || !isSafeTimestamp(to)) return '全部时间'
  if (!(to > from)) return dayKey(from, tz)
  const fromKey = dayKey(from, tz)
  const toKey = dayKey(to - 1, tz)
  if (fromKey === toKey) return fromKey
  if (window.level === 'month') {
    const fromMonth = fromKey.slice(0, 7)
    const toMonth = toKey.slice(0, 7)
    return fromMonth === toMonth ? fromMonth : `${fromMonth} ~ ${toMonth}`
  }
  if (window.level === 'year') {
    const fromYear = fromKey.slice(0, 4)
    const toYear = toKey.slice(0, 4)
    return fromYear === toYear ? fromYear : `${fromYear} ~ ${toYear}`
  }
  return `${fromKey} ~ ${toKey}`
}

// ---------------------------------------------------------------------------
// granularity detection
// ---------------------------------------------------------------------------

const CALENDAR_SHAPE_RE = /^\d{4}(-\d{1,2}){0,2}$/
const NUMBER_SHAPE_RE = /^[+-]?\d+(?:\.\d+)?$/
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30
  return 31
}

function isValidCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1 || year > 9999) return false
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

/** Parse `'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY'`; `null` when invalid/unknown shape. */
function parseCalendarText(text) {
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dayMatch) {
    const year = Number(dayMatch[1])
    const month = Number(dayMatch[2])
    const day = Number(dayMatch[3])
    if (!isValidCalendarDate(year, month, day)) return null
    return { unit: 'day', year, month, day }
  }
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(text)
  if (monthMatch) {
    const year = Number(monthMatch[1])
    const month = Number(monthMatch[2])
    if (!isValidCalendarDate(year, month, 1)) return null
    return { unit: 'month', year, month, day: 1 }
  }
  const yearMatch = /^(\d{4})$/.exec(text)
  if (yearMatch) {
    const year = Number(yearMatch[1])
    if (year < 1 || year > 9999) return null
    return { unit: 'year', year, month: 1, day: 1 }
  }
  return null
}

/** Epoch ms of a number / Date / numeric string / ISO datetime; `NaN` otherwise. */
function epochValueOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : NaN
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (NUMBER_SHAPE_RE.test(text)) return Number(text)
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  return NaN
}

/**
 * Detect the granularity of a time input (contract §5.3).
 *
 * `'2026-10-31'` → `'day'`; `'2026-10'` → `'month'`; `'2026'` → `'year'`;
 * numbers, `Date` objects, numeric strings and ISO datetimes → `'epoch'`;
 * anything unparsable (including impossible dates like `'2026-02-30'`) →
 * `'invalid'`.
 *
 * @param {unknown} value
 * @returns {'day'|'month'|'year'|'epoch'|'invalid'}
 */
export function detectGranularity(value) {
  if (value === null || value === undefined) return 'invalid'
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? 'epoch' : 'invalid'
  if (typeof value === 'number') return Number.isFinite(value) ? 'epoch' : 'invalid'
  if (typeof value !== 'string') return 'invalid'
  const text = value.trim()
  if (!text) return 'invalid'
  const parsed = parseCalendarText(text)
  if (parsed) return parsed.unit
  // A calendar-shaped but impossible value ('2026-13', '2026-02-30') is invalid,
  // it must not silently fall through to the numeric/epoch branch.
  if (CALENDAR_SHAPE_RE.test(text)) return 'invalid'
  if (NUMBER_SHAPE_RE.test(text)) return 'epoch'
  if (ISO_DATETIME_RE.test(text)) {
    return Number.isFinite(Date.parse(text)) ? 'epoch' : 'invalid'
  }
  return 'invalid'
}

// ---------------------------------------------------------------------------
// config reading (tolerate a missing / partially written cfg.time group)
// ---------------------------------------------------------------------------

function clampInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function describeValue(value) {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/**
 * Read the `time` config group with contract defaults as fallback. Never throws
 * and never mutates `cfg` (other modules own config validation).
 */
function readTimeConfig(cfg) {
  const raw = cfg && typeof cfg === 'object' && cfg.time && typeof cfg.time === 'object' ? cfg.time : {}
  const warnings = []
  const mode = raw.mode === 'off' || raw.mode === 'index' || raw.mode === 'constrain'
    ? raw.mode
    : TIME_DEFAULTS.mode
  const timezoneResult = validateTimezone(raw.timezone === undefined ? TIME_DEFAULTS.timezone : raw.timezone)
  if (timezoneResult.warning) warnings.push(timezoneResult.warning)
  const minRangeDays = clampInteger(raw.minRangeDays, TIME_DEFAULTS.minRangeDays, 1, 3660)
  let maxRangeDays = clampInteger(raw.maxRangeDays, TIME_DEFAULTS.maxRangeDays, 1, 36600)
  if (maxRangeDays < minRangeDays) maxRangeDays = minRangeDays
  let fallback = TIME_DEFAULTS.fallback.slice()
  if (raw.fallback !== undefined) {
    if (Array.isArray(raw.fallback)) {
      const filtered = []
      for (const item of raw.fallback) {
        if (typeof item === 'string' && ALLOWED_FALLBACK.includes(item) && !filtered.includes(item)) filtered.push(item)
      }
      fallback = filtered
    } else {
      warnings.push(`time.fallback: expected an array of ${ALLOWED_FALLBACK.join('/')}; using default`)
    }
  }
  return {
    mode,
    timezone: timezoneResult.timezone,
    minRangeDays,
    maxRangeDays,
    centerDayPriority: raw.centerDayPriority !== false,
    fallback,
    fallbackMinResults: clampInteger(raw.fallbackMinResults, TIME_DEFAULTS.fallbackMinResults, 1, 1000),
    windowScanMax: clampInteger(raw.windowScanMax, TIME_DEFAULTS.windowScanMax, 1, 1000000),
    askUserHint: raw.askUserHint !== false,
    judgeEventTime: raw.judgeEventTime === true,
    warnings,
  }
}

/**
 * Whether the time feature may constrain recall (`time.mode === 'constrain'`).
 *
 * `'off'` disables the feature; `'index'` builds the index but recall must stay
 * unchanged (plan §3.3.1/§3.3.5). The engine wiring uses this helper so that a
 * bare `queryTimeIndex()` call can never silently change recall behaviour.
 *
 * @param {object} [cfg]
 * @returns {boolean}
 */
export function timeConstraintEnabled(cfg) {
  return readTimeConfig(cfg).mode === 'constrain'
}

// ---------------------------------------------------------------------------
// folder time ranges
// ---------------------------------------------------------------------------

/**
 * Half-open event interval `[start, end)` of one index folder entry.
 *
 * Uses `[eventStart, eventEnd)` when `eventTimeSource` is `'messages'` or
 * `'judge'`, otherwise falls back to the archive time `[createdAt, createdAt+1)`
 * with source `'archive'` (old folders never carried event times). Never
 * throws; a missing range always yields a non-empty half-open interval.
 *
 * @param {{createdAt?:number,eventStart?:number,eventEnd?:number,eventTimeSource?:string}} entry
 * @returns {{start:number,end:number,source:'messages'|'judge'|'archive'}}
 */
export function folderTimeRange(entry) {
  const source = entry && typeof entry === 'object' ? entry : {}
  const eventStart = optionalTimestamp(source.eventStart)
  const eventEnd = optionalTimestamp(source.eventEnd)
  const eventSource = source.eventTimeSource
  if (EVENT_SOURCES.has(eventSource) && Number.isFinite(eventStart)) {
    const start = eventStart
    const end = Number.isFinite(eventEnd) && eventEnd > start ? eventEnd : start + 1
    return { start, end, source: eventSource }
  }
  const createdAt = optionalTimestamp(source.createdAt)
  const start = Number.isFinite(createdAt) ? createdAt : 0
  return { start, end: start + 1, source: SOURCE_ARCHIVE }
}

// ---------------------------------------------------------------------------
// build the in-memory index (CSR day/month/year buckets)
// ---------------------------------------------------------------------------

/**
 * Build the per-bucket CSR arrays for `folderCount` folders.
 *
 * @param {number[]} sortedKeys sorted unique bucket keys (integers)
 * @param {Map<number, number>} keyPosition key -> bucket position
 * @param {Int32Array} startKeys start bucket key per folder
 * @param {Int32Array} membershipCounts bucket count per folder
 * @returns {{ offsets: Int32Array, values: Int32Array }}
 */
function buildCsr(sortedKeys, keyPosition, startKeys, membershipCounts) {
  const bucketCount = sortedKeys.length
  const folderCount = startKeys.length
  const counts = new Int32Array(bucketCount)
  for (let folder = 0; folder < folderCount; folder += 1) {
    const position = keyPosition.get(startKeys[folder])
    const count = membershipCounts[folder]
    for (let offset = 0; offset < count; offset += 1) counts[position + offset] += 1
  }
  const offsets = new Int32Array(bucketCount + 1)
  for (let bucket = 0; bucket < bucketCount; bucket += 1) offsets[bucket + 1] = offsets[bucket] + counts[bucket]
  const values = new Int32Array(offsets[bucketCount])
  if (values.length > 0) {
    const cursor = new Int32Array(bucketCount)
    for (let bucket = 0; bucket < bucketCount; bucket += 1) cursor[bucket] = offsets[bucket]
    for (let folder = 0; folder < folderCount; folder += 1) {
      const position = keyPosition.get(startKeys[folder])
      const count = membershipCounts[folder]
      for (let offset = 0; offset < count; offset += 1) {
        values[cursor[position + offset]] = folder
        cursor[position + offset] += 1
      }
    }
  }
  return { offsets, values }
}

/** `Int32Array` CSR slices -> `Map<key, Int32Array>` (one entry per bucket). */
function csrToBucketMap(keys, csr) {
  const buckets = new Map()
  for (let bucket = 0; bucket < keys.length; bucket += 1) {
    buckets.set(keys[bucket], csr.values.subarray(csr.offsets[bucket], csr.offsets[bucket + 1]))
  }
  return buckets
}

/**
 * Derive the in-memory time index from `index.folders` (contract §5.3).
 *
 * The index is a *derived, disposable* view: it is never persisted, so it can
 * never disagree with the folder tree. Buckets are CSR arrays:
 * `buckets: Map<dayKey, Int32Array of folder positions>`; a folder that spans
 * several calendar days is present in each of those day buckets (same for the
 * month/year buckets). `folderCount`/`byId` always reflect the *exact* interval
 * used for matching, `builtAt` is diagnostic only.
 *
 * @param {Array<object>} folders `index.folders` entries
 * @param {object} [cfg]
 * @returns {{
 *   timezone: string, folderCount: number, builtAt: number,
 *   byId: Map<string, {start:number,end:number,source:string}>,
 *   buckets: Map<string, Int32Array>, monthBuckets: Map<string, Int32Array>,
 *   yearBuckets: Map<string, Int32Array>,
 *   dayKeys: string[], monthKeys: string[], yearKeys: string[],
 *   ids: string[], ranges: Array<{start:number,end:number,source:string}>,
 *   csr: {day: object, month: object, year: object},
 *   warnings: string[],
 * }}
 */
export function buildTimeIndex(folders, cfg) {
  const timeConfig = readTimeConfig(cfg)
  const timezone = timeConfig.timezone
  const warnings = timeConfig.warnings.slice()
  const list = Array.isArray(folders) ? folders : []

  const ids = []
  const ranges = []
  const byId = new Map()
  const seenIds = new Set()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.id !== 'string' || !entry.id) continue
    if (seenIds.has(entry.id)) continue
    seenIds.add(entry.id)
    ids.push(entry.id)
    ranges.push(folderTimeRange(entry))
  }
  const folderCount = ids.length

  const startDays = new Int32Array(folderCount)
  const dayCounts = new Int32Array(folderCount)
  const startMonths = new Int32Array(folderCount)
  const monthCounts = new Int32Array(folderCount)
  const startYears = new Int32Array(folderCount)
  const yearCounts = new Int32Array(folderCount)
  const daySet = new Set()
  const monthSet = new Set()
  const yearSet = new Set()
  let spanWarnings = 0

  for (let folder = 0; folder < folderCount; folder += 1) {
    const range = ranges[folder]
    const startCivil = civilAt(range.start, timezone)
    const startSecond = Math.floor(range.start / 1000)
    const endSecond = Math.floor((range.end - 1) / 1000)
    const endCivil = endSecond === startSecond ? startCivil : civilAt(range.end - 1, timezone)
    let firstDay = civilDayIndex(startCivil)
    let lastDay = civilDayIndex(endCivil)
    if (lastDay - firstDay + 1 > MAX_FOLDER_SPAN_DAYS) {
      lastDay = firstDay + MAX_FOLDER_SPAN_DAYS - 1
      if (spanWarnings < MAX_SPAN_WARNINGS) {
        spanWarnings += 1
        warnings.push(`time: folder ${ids[folder]} covers more than ${MAX_FOLDER_SPAN_DAYS} days; bucket span truncated`)
      }
    }
    startDays[folder] = firstDay
    dayCounts[folder] = lastDay - firstDay + 1
    for (let day = firstDay; day <= lastDay; day += 1) daySet.add(day)

    const firstMonth = civilPeriodIndex(startCivil)
    const lastCivil = civilFromDayIndex(lastDay)
    const lastMonth = civilPeriodIndex(lastCivil)
    startMonths[folder] = firstMonth
    monthCounts[folder] = Math.max(1, lastMonth - firstMonth + 1)
    for (let month = firstMonth; month <= firstMonth + monthCounts[folder] - 1; month += 1) monthSet.add(month)

    const firstYear = startCivil.year
    const lastYear = lastCivil.year
    startYears[folder] = firstYear
    yearCounts[folder] = Math.max(1, lastYear - firstYear + 1)
    for (let year = firstYear; year <= firstYear + yearCounts[folder] - 1; year += 1) yearSet.add(year)
  }

  const sortedDays = Array.from(daySet).sort((left, right) => left - right)
  const sortedMonths = Array.from(monthSet).sort((left, right) => left - right)
  const sortedYears = Array.from(yearSet).sort((left, right) => left - right)
  const dayKeys = sortedDays.map((index) => dayKeyOfIndex(index))
  const monthKeys = sortedMonths.map((index) => monthKeyOfIndex(index))
  const yearKeys = sortedYears.map((index) => yearKeyOfIndex(index))

  const dayPosition = new Map()
  for (let position = 0; position < sortedDays.length; position += 1) dayPosition.set(sortedDays[position], position)
  const monthPosition = new Map()
  for (let position = 0; position < sortedMonths.length; position += 1) monthPosition.set(sortedMonths[position], position)
  const yearPosition = new Map()
  for (let position = 0; position < sortedYears.length; position += 1) yearPosition.set(sortedYears[position], position)

  const dayCsr = buildCsr(sortedDays, dayPosition, startDays, dayCounts)
  const monthCsr = buildCsr(sortedMonths, monthPosition, startMonths, monthCounts)
  const yearCsr = buildCsr(sortedYears, yearPosition, startYears, yearCounts)

  for (let folder = 0; folder < folderCount; folder += 1) byId.set(ids[folder], ranges[folder])

  return {
    timezone,
    folderCount,
    builtAt: Date.now(),
    byId,
    buckets: csrToBucketMap(dayKeys, dayCsr),
    monthBuckets: csrToBucketMap(monthKeys, monthCsr),
    yearBuckets: csrToBucketMap(yearKeys, yearCsr),
    dayKeys,
    monthKeys,
    yearKeys,
    ids,
    ranges,
    csr: { day: dayCsr, month: monthCsr, year: yearCsr },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// query the index
// ---------------------------------------------------------------------------

/** Unconstrained result: `ids: null` means "no time filter, whole library". */
function unconstrainedResult(folderCount) {
  return { ids: null, count: Number.isInteger(folderCount) ? folderCount : 0 }
}

/**
 * Matching folder ids of one normalised time window (contract §5.3).
 *
 * Returns `{ ids: null, count }` — "no constraint, whole library" — when there
 * is no index, no window, an `'all'` window, or when the time feature is not
 * allowed to constrain recall (`time.mode !== 'constrain'`: `'off'`/`'index'`
 * must leave recall behaviour untouched). Otherwise `ids` is a `Set<string>` of
 * folder ids whose exact half-open interval overlaps the window
 * (`start < to && end > from`).
 *
 * @param {ReturnType<typeof buildTimeIndex>|null} timeIndex
 * @param {{from?:number|null,to?:number|null,level?:string}|null} window
 * @param {object} [cfg]
 * @returns {{ ids: Set<string>|null, count: number }}
 */
export function queryTimeIndex(timeIndex, window, cfg) {
  const index = timeIndex && typeof timeIndex === 'object' ? timeIndex : null
  const folderCount = index && Number.isInteger(index.folderCount) ? index.folderCount : 0
  if (!index || !(index.byId instanceof Map) || !Array.isArray(index.ranges) || !Array.isArray(index.ids)) {
    return unconstrainedResult(folderCount)
  }
  const timeConfig = readTimeConfig(cfg)
  if (timeConfig.mode !== 'constrain') return unconstrainedResult(folderCount)
  if (!window || typeof window !== 'object') return unconstrainedResult(folderCount)
  if (window.level === 'all') return unconstrainedResult(folderCount)
  let from = Number(window.from)
  let to = Number(window.to)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return unconstrainedResult(folderCount)
  if (from > to) {
    const swap = from
    from = to
    to = swap
  }
  const ids = new Set()
  if (folderCount === 0) return { ids, count: 0 }
  // A timestamp outside the representable `Date` range cannot overlap any
  // folder (every stored range is safe): return an empty set, never throw.
  if (!isSafeTimestamp(from) || !isSafeTimestamp(to)) return { ids, count: 0 }
  const tz = typeof index.timezone === 'string' ? index.timezone : ''
  const ranges = index.ranges
  const folderIds = index.ids

  let scanFromDay
  let scanToDay
  try {
    scanFromDay = dayIndexOf(from, tz)
    scanToDay = to > from ? dayIndexOf(to - 1, tz) : scanFromDay
  } catch {
    // Unreachable in practice (a bad time zone is sanitised on build); degrade
    // to a plain full scan instead of throwing at the caller.
    scanFromDay = 0
    scanToDay = -1
  }

  const daySpan = scanToDay - scanFromDay + 1
  if (daySpan > timeConfig.windowScanMax) {
    for (let folder = 0; folder < folderCount; folder += 1) {
      const range = ranges[folder]
      if (range.start < to && range.end > from) ids.add(folderIds[folder])
    }
    return { ids, count: ids.size }
  }

  // Day buckets are a superset of the exact matches; the overlap test below is
  // the only thing that decides. The ±1 day padding is defensive: it must never
  // matter for a consistent index (buckets and window share `index.timezone`),
  // but it costs two Map lookups and removes any off-by-one-tz risk.
  const buckets = index.buckets instanceof Map ? index.buckets : null
  if (!buckets) return unconstrainedResult(folderCount)
  for (let day = scanFromDay - 1; day <= scanToDay + 1; day += 1) {
    const bucket = buckets.get(dayKeyOfIndex(day))
    if (!bucket) continue
    for (let position = 0; position < bucket.length; position += 1) {
      const folder = bucket[position]
      const range = ranges[folder]
      if (range.start < to && range.end > from) ids.add(folderIds[folder])
    }
  }
  return { ids, count: ids.size }
}

// ---------------------------------------------------------------------------
// fallback ladder
// ---------------------------------------------------------------------------

function buildLadderRung(name, normalized, from, to, timezone) {
  if (name === 'all') return { from: null, to: null, level: 'all', widenedTo: 'all' }
  if (name === 'day3') {
    const center = Number.isFinite(Number(normalized.center)) ? Number(normalized.center) : from
    const centerDay = dayStartInstant(center, timezone)
    return {
      from: addZonedDays(centerDay, -1, timezone),
      to: addZonedDays(centerDay, 2, timezone),
      level: 'day',
      widenedTo: 'day3',
    }
  }
  if (name === 'month') {
    const monthFrom = monthStartInstant(from, timezone)
    const endInstant = to > from ? to - 1 : from
    return {
      from: monthFrom,
      to: addZonedMonths(monthStartInstant(endInstant, timezone), 1, timezone),
      level: 'month',
      widenedTo: 'month',
    }
  }
  if (name === 'year') {
    const yearFrom = yearStartInstant(from, timezone)
    const endInstant = to > from ? to - 1 : from
    return {
      from: yearFrom,
      to: addZonedMonths(yearStartInstant(endInstant, timezone), 12, timezone),
      level: 'year',
      widenedTo: 'year',
    }
  }
  return null
}

/**
 * Fallback ladder for one normalised window (contract §5.3).
 *
 * The caller first tries the normalised window (L0) itself, then every rung in
 * order until enough results are found. Each rung is a strict superset of the
 * window (a widening that would shrink the window is never emitted) and carries
 * its `widenedTo` marker for telemetry/tool output:
 *
 *   day   -> ['day3', 'month', 'year', 'all']
 *   month -> ['year', 'all']
 *   year  -> ['all']
 *
 * `cfg.time.fallback` controls which/all of the allowed rungs exist and their
 * order; when the time feature is not constraining (`mode 'off' | 'index'`) or
 * the window carries no constraint, the ladder is just the original window.
 *
 * @param {ReturnType<typeof normalizeTimeQuery>|null} normalized
 * @param {object} [cfg]
 * @returns {Array<{from:number|null,to:number|null,level:string,widenedTo:string|null}>}
 */
export function timeFallbackLadder(normalized, cfg) {
  const timeConfig = readTimeConfig(cfg)
  const timezone = timeConfig.timezone
  const source = normalized && typeof normalized === 'object' ? normalized : null
  const from = source && typeof source.from === 'number' ? source.from : Number.NaN
  const to = source && typeof source.to === 'number' ? source.to : Number.NaN
  const sourceLevel = source && typeof source.level === 'string' && source.level ? source.level : 'all'
  // A partial / malformed window carries no usable constraint: degrade to
  // "no constraint" instead of emitting a half-open rung.
  const usable = Number.isFinite(from) && Number.isFinite(to) && sourceLevel !== 'all'
  const originalLevel = usable ? sourceLevel : 'all'
  const original = {
    from: usable ? from : null,
    to: usable ? to : null,
    level: originalLevel,
    widenedTo: null,
  }
  if (timeConfig.mode !== 'constrain') return [original]
  if (!usable) return [original]
  const level = originalLevel === 'month' || originalLevel === 'year' ? originalLevel : 'day'
  const applicable = WIDENING_PATH[level] || WIDENING_PATH.day
  const rungs = []
  for (const name of timeConfig.fallback) {
    if (!applicable.includes(name)) continue
    const rung = buildLadderRung(name, source, from, to, timezone)
    if (!rung) continue
    if (name !== 'all') {
      if (!(rung.from <= from && rung.to >= to)) continue // never widen by shrinking
      if (!(rung.from < from || rung.to > to)) continue // skip no-op rungs (L0 already covers it)
    }
    if (rungs.some((previous) => previous.from === rung.from && previous.to === rung.to && previous.level === rung.level)) continue
    rungs.push(rung)
  }
  return rungs
}

// ---------------------------------------------------------------------------
// normalisation (pure, failure safe)
// ---------------------------------------------------------------------------

function hasTimeValue(value) {
  return value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())
}

function readRequestedGranularity(value, warnings) {
  if (!hasTimeValue(value)) return null
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === 'day' || text === 'month' || text === 'year') return text
  warnings.push(`timeQuery.granularity: expected 'day' | 'month' | 'year'; got ${describeValue(value)}; ignored`)
  return null
}

function finerLevel(left, right) {
  return (LEVEL_RANK[left] ?? 0) <= (LEVEL_RANK[right] ?? 0) ? left : right
}

/** Resolve one endpoint value into its calendar window in `timeZone`. */
function resolveQueryEndpoint(value, requestedUnit, timezone) {
  const kind = detectGranularity(value)
  if (kind === 'invalid') return null
  if (kind === 'epoch') {
    const instant = epochValueOf(value)
    if (!isSafeTimestamp(instant)) return null
    const unit = requestedUnit || 'day'
    let start
    let end
    if (unit === 'month') {
      start = monthStartInstant(instant, timezone)
      end = addZonedMonths(start, 1, timezone)
    } else if (unit === 'year') {
      start = yearStartInstant(instant, timezone)
      end = addZonedMonths(start, 12, timezone)
    } else {
      start = dayStartInstant(instant, timezone)
      end = addZonedDays(start, 1, timezone)
    }
    return { kind, unit, start, end }
  }
  const parsed = parseCalendarText(String(value).trim())
  if (!parsed) return null
  if (parsed.unit === 'month') {
    const start = instantForCivil({ year: parsed.year, month: parsed.month, day: 1 }, timezone)
    return { kind, unit: 'month', start, end: addZonedMonths(start, 1, timezone) }
  }
  if (parsed.unit === 'year') {
    const start = instantForCivil({ year: parsed.year, month: 1, day: 1 }, timezone)
    return { kind, unit: 'year', start, end: addZonedMonths(start, 12, timezone) }
  }
  const start = instantForCivil({ year: parsed.year, month: parsed.month, day: parsed.day }, timezone)
  return { kind, unit: 'day', start, end: addZonedDays(start, 1, timezone) }
}

/** Number of local calendar days the half-open window `[from, to)` covers. */
function coveredCalendarDays(from, to, timezone) {
  if (!(to > from)) return 1
  const first = dayIndexOf(from, timezone)
  const last = dayIndexOf(to - 1, timezone)
  return Math.max(1, last - first + 1)
}

/** Clamp a window that reaches into the future: end at `now` ("query now"). */
function applyFutureClamp(window, nowMs, warnings) {
  if (!Number.isFinite(nowMs)) return
  if (!(window.to > nowMs)) return
  warnings.push('timeQuery: future time clamped to now')
  window.from = Math.min(window.from, nowMs)
  window.to = nowMs
  if (window.from > window.to) window.from = window.to
}

/**
 * A single calendar unit (day/month/year) that starts in the future is
 * degenerate: degrade it to "query now" (an instant window). Units that contain
 * `now` are kept whole — clamping `'2026'` to `[Jan 1, now]` would change the
 * window without changing a single match, and would emit a warning on the most
 * common "current month/year" query.
 */
function clampSingleUnitFuture(window, nowMs, warnings) {
  if (!Number.isFinite(nowMs)) return
  if (!(window.from > nowMs)) return
  warnings.push('timeQuery: future time clamped to now')
  window.from = nowMs
  window.to = nowMs
}

function resolveNow(input, now) {
  if (isSafeTimestamp(now)) return now
  if (typeof now === 'string' && now.trim()) {
    const parsed = Date.parse(now.trim())
    if (isSafeTimestamp(parsed)) return parsed
  }
  if (input && typeof input === 'object') {
    if (isSafeTimestamp(input.now)) return input.now
    if (typeof input.now === 'string' && input.now.trim()) {
      const parsed = Date.parse(input.now.trim())
      if (isSafeTimestamp(parsed)) return parsed
    }
  }
  return Date.now()
}

/**
 * Normalise a model supplied time query into one half-open window (contract
 * §5.3, plan §3.3.3). Pure function: `now` is explicit, nothing is random and
 * nothing throws.
 *
 * Accepted inputs: a single day (`'2026-10-31'`), month (`'2026-10'`), year
 * (`'2026'`), epoch ms / `Date` / numeric string / ISO datetime (optionally
 * disambiguated by `granularity`), or an explicit `timeFrom` + `timeTo` range
 * (both endpoints expanded by their own granularity).
 *
 * Rules:
 *  - a single self-describing endpoint is its own L0 window
 *    (day → that calendar day, month → natural month, year → natural year);
 *  - a single epoch endpoint without `granularity` falls back to a
 *    `minRangeDays`-day window (it carries no usable granularity);
 *  - `timeFrom > timeTo` is swapped;
 *  - an explicit range shorter than `minRangeDays` is widened around its centre
 *    (single day queries are *not* widened: L0 stays the centre day and the
 *    fallback ladder does the widening);
 *  - an explicit range longer than `maxRangeDays` is truncated;
 *  - anything reaching into the future is clamped to `now`;
 *  - unusable input degrades to `{ from: null, to: null, level: 'all' }` —
 *    "no constraint" — with `warnings`.
 *
 * @param {{timeFrom?:unknown,timeTo?:unknown,granularity?:unknown,now?:number|string}|null} input
 * @param {object} [cfg]
 * @param {number|string} [now] explicit "current time" (fake clock in tests)
 * @returns {{
 *   from: number|null, to: number|null, level: 'day'|'month'|'year'|'all',
 *   granularity: string, center: number|null,
 *   requested: { from: number|null, to: number|null }, warnings: string[],
 * }}
 */
export function normalizeTimeQuery(input, cfg, now) {
  const timeConfig = readTimeConfig(cfg)
  const warnings = timeConfig.warnings.slice()
  const timezone = timeConfig.timezone
  const nowMs = resolveNow(input, now)
  const result = {
    from: null,
    to: null,
    level: 'all',
    granularity: 'invalid',
    center: null,
    requested: { from: null, to: null },
    warnings,
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    warnings.push('timeQuery: input is not an object; time constraint disabled')
    return result
  }
  const requestedUnit = readRequestedGranularity(input.granularity, warnings)
  const hasFrom = hasTimeValue(input.timeFrom)
  const hasTo = hasTimeValue(input.timeTo)
  if (!hasFrom && !hasTo) {
    warnings.push('timeQuery: no timeFrom/timeTo supplied; time constraint disabled')
    return result
  }
  const fromEndpoint = hasFrom ? resolveQueryEndpoint(input.timeFrom, requestedUnit, timezone) : null
  const toEndpoint = hasTo ? resolveQueryEndpoint(input.timeTo, requestedUnit, timezone) : null
  if (hasFrom && !fromEndpoint) warnings.push(`timeQuery.timeFrom: cannot parse ${describeValue(input.timeFrom)}; ignored`)
  if (hasTo && !toEndpoint) warnings.push(`timeQuery.timeTo: cannot parse ${describeValue(input.timeTo)}; ignored`)
  if (!fromEndpoint && !toEndpoint) {
    warnings.push('timeQuery: no usable time input; time constraint disabled')
    return result
  }
  if (requestedUnit) {
    const mismatched = new Set()
    for (const endpoint of [fromEndpoint, toEndpoint]) {
      if (endpoint && endpoint.kind !== 'epoch' && endpoint.kind !== requestedUnit) mismatched.add(endpoint.kind)
    }
    for (const kind of mismatched) {
      warnings.push(`timeQuery.granularity: requested '${requestedUnit}' ignored for explicit '${kind}' input`)
    }
  }

  // --- single endpoint: that calendar unit is the L0 window -----------------
  if (!fromEndpoint || !toEndpoint) {
    const endpoint = fromEndpoint || toEndpoint
    let level = endpoint.unit
    let from = endpoint.start
    let to = endpoint.end
    if (endpoint.kind === 'epoch' && !requestedUnit) {
      // An epoch without granularity carries no usable window width: fall back
      // to the configured minimum range (days) starting at that local day.
      from = dayStartInstant(endpoint.start, timezone)
      to = addZonedDays(from, timeConfig.minRangeDays, timezone)
      level = 'day'
      warnings.push(`timeQuery: epoch input without granularity; using a ${timeConfig.minRangeDays}-day window`)
    }
    result.from = from
    result.to = to
    result.level = level
    result.granularity = level
    result.requested = { from, to }
    if (endpoint.kind === 'epoch' && !requestedUnit) {
      // The fallback window above behaves like an explicit range.
      applyFutureClamp(result, nowMs, warnings)
    } else {
      clampSingleUnitFuture(result, nowMs, warnings)
    }
    result.center = result.from
    return result
  }

  // --- explicit range -------------------------------------------------------
  let startEndpoint = fromEndpoint
  let endEndpoint = toEndpoint
  if (startEndpoint.start > endEndpoint.start) {
    const swap = startEndpoint
    startEndpoint = endEndpoint
    endEndpoint = swap
    warnings.push('timeQuery: timeFrom is after timeTo; endpoints swapped')
  }
  let from = startEndpoint.start
  let to = endEndpoint.end
  const level = finerLevel(startEndpoint.unit, endEndpoint.unit)
  result.level = level
  result.granularity = level
  result.requested = { from, to }

  if (level === 'day') {
    const covered = coveredCalendarDays(from, to, timezone)
    if (covered < timeConfig.minRangeDays) {
      const centerMs = Math.round(from + (to - from) / 2)
      const centerDay = dayStartInstant(centerMs, timezone)
      const half = Math.floor((timeConfig.minRangeDays - 1) / 2)
      let widenedFrom = addZonedDays(centerDay, -half, timezone)
      let widenedTo = addZonedDays(centerDay, timeConfig.minRangeDays - half, timezone)
      if (widenedFrom > from || widenedTo < to) {
        // Safety net: a widening must never drop part of the requested range.
        widenedFrom = Math.min(widenedFrom, from)
        widenedTo = Math.max(widenedTo, to)
        warnings.push('timeQuery: widened window extended to cover the requested bounds')
      }
      warnings.push(`timeQuery: range covers ${covered} day(s) < minRangeDays=${timeConfig.minRangeDays}; widened to at least ${timeConfig.minRangeDays} days`)
      from = widenedFrom
      to = widenedTo
    }
  }

  const covered = coveredCalendarDays(from, to, timezone)
  if (covered > timeConfig.maxRangeDays) {
    const firstDay = dayStartInstant(from, timezone)
    to = addZonedDays(firstDay, timeConfig.maxRangeDays, timezone)
    warnings.push(`timeQuery: range covers ${covered} day(s) > maxRangeDays=${timeConfig.maxRangeDays}; truncated to ${timeConfig.maxRangeDays} days`)
  }

  result.from = from
  result.to = to
  applyFutureClamp(result, nowMs, warnings)
  result.center = Number.isFinite(result.from) && Number.isFinite(result.to)
    ? Math.round((result.from + result.to) / 2)
    : result.from
  return result
}
