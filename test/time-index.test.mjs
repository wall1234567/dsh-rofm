/**
 * Time index tests — in-memory day/month/year CSR buckets, calendar boundaries
 * (Asia/Shanghai / UTC / America/New_York DST), leap years, interval-overlap
 * matching, legacy event-time fallback, normalisation edge cases, the fallback
 * ladder, a Plan A/B oracle fuzz and the performance budget
 * (contract §5.3, plan §3.3.6).
 *
 * Everything is deterministic: `now` is always passed explicitly and the fuzz
 * generators are seeded. No test touches the real `memory/` directory.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DEFAULT_CONFIG, loadConfig } from '../engine/config.js'
import { indexEntryFromMeta, loadIndex, normalizeIndex, writeFolder } from '../engine/store.js'
import {
  TIME_DEFAULTS,
  addZonedDays,
  buildTimeIndex,
  dayKey,
  detectGranularity,
  folderTimeRange,
  formatWindow,
  normalizeTimeQuery,
  queryTimeIndex,
  timeConstraintEnabled,
  timeFallbackLadder,
  validateTimezone,
  zonedDayStart,
  zonedMonthStart,
  zonedYearStart,
} from '../engine/time-index.js'

const DAY = 86400000
const ASIA = 'Asia/Shanghai'
const UTC = 'UTC'
const NY = 'America/New_York'
/** Fixed fake clock: 2026-11-05T12:00:00Z (= 2026-11-05 20:00 +08). */
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)
const SH_OFFSET = 8 * 3600000

/** Epoch ms of a Shanghai wall-clock time (Shanghai is fixed +08:00, no DST). */
function sh(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - SH_OFFSET
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms)
}

/** Config object as the packaged plugin runs it: constrain + Asia/Shanghai. */
function makeCfg(overrides = {}) {
  return loadConfig(undefined, { time: { mode: 'constrain', timezone: ASIA, ...overrides } })
}

/** Raw (unvalidated) time group for edge-case configs. */
function rawCfg(overrides = {}) {
  return { time: { ...TIME_DEFAULTS, fallback: TIME_DEFAULTS.fallback.slice(), mode: 'constrain', timezone: ASIA, ...overrides } }
}

let folderSequence = 0
function makeFolder(overrides = {}) {
  folderSequence += 1
  return {
    id: `mem-test-${String(folderSequence).padStart(4, '0')}`,
    createdAt: sh(2026, 10, 31, 12, 0, 0),
    alpha: 0.5,
    ...overrides,
  }
}

/** Exact overlap oracle used by the Plan A/B fuzz: naive full scan. */
function naiveMatchIds(folders, window) {
  const ids = new Set()
  for (const folder of folders) {
    const range = folderTimeRange(folder)
    if (range.start < window.to && range.end > window.from) ids.add(folder.id)
  }
  return ids
}

function sortedIds(set) {
  return [...set].sort()
}

function dayKeyToUtc(key) {
  const [year, month, day] = key.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

/** Calendar-day length of one half-open interval in `timezone`. */
function spanDays(range, timezone = ASIA) {
  return (dayKeyToUtc(dayKey(range.end - 1, timezone)) - dayKeyToUtc(dayKey(range.start, timezone))) / DAY + 1
}

/** Small deterministic LCG so fuzz cases are reproducible. */
function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

// ---------------------------------------------------------------------------
// validateTimezone
// ---------------------------------------------------------------------------

test('timezone: valid IANA zones and host-local empty string are accepted', () => {
  assert.deepEqual(validateTimezone(ASIA), { ok: true, timezone: 'Asia/Shanghai' })
  assert.deepEqual(validateTimezone(UTC), { ok: true, timezone: 'UTC' })
  assert.deepEqual(validateTimezone(''), { ok: true, timezone: '' })
  assert.deepEqual(validateTimezone(undefined), { ok: true, timezone: '' })
  assert.deepEqual(validateTimezone(null), { ok: true, timezone: '' })
  // IANA ids are case insensitive and canonicalised by Intl.
  assert.equal(validateTimezone('asia/shanghai').ok, true)
  assert.equal(validateTimezone('asia/shanghai').timezone, 'Asia/Shanghai')
})

test('timezone: unknown / non-string zones degrade to host local with a warning', () => {
  const unknown = validateTimezone('Nope/Zone')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.timezone, '')
  assert.match(unknown.warning, /unknown IANA time zone/)
  const notString = validateTimezone(42)
  assert.equal(notString.ok, false)
  assert.equal(notString.timezone, '')
  assert.match(notString.warning, /expected an IANA time zone/)
})

// ---------------------------------------------------------------------------
// zoned day / month / year boundaries
// ---------------------------------------------------------------------------

test('zonedDayStart: Asia/Shanghai midnights are 16:00Z (fixed UTC+8)', () => {
  assert.equal(zonedDayStart(sh(2026, 10, 31, 10, 0, 0), ASIA), sh(2026, 10, 31))
  assert.equal(zonedDayStart(sh(2026, 10, 31, 0, 0, 0), ASIA), sh(2026, 10, 31))
  assert.equal(zonedDayStart(sh(2026, 10, 31, 23, 59, 59, 999), ASIA), sh(2026, 10, 31))
  assert.equal(zonedDayStart(sh(2026, 10, 31), ASIA), Date.UTC(2026, 9, 30, 16, 0, 0))
})

test('dayKey: the Shanghai day flips exactly at 16:00Z', () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 30, 15, 59, 59, 999), ASIA), '2026-10-30')
  assert.equal(dayKey(Date.UTC(2026, 9, 30, 16, 0, 0, 0), ASIA), '2026-10-31')
  assert.equal(dayKey(Date.UTC(2026, 9, 30, 16, 0, 0, 1), ASIA), '2026-10-31')
  assert.equal(dayKey(Number.NaN, ASIA), '')
})

test('zonedDayStart: UTC midnights stay at midnight UTC', () => {
  assert.equal(zonedDayStart(Date.UTC(2026, 9, 31, 23, 59, 59, 999), UTC), Date.UTC(2026, 9, 31))
  assert.equal(dayKey(Date.UTC(2026, 9, 31, 23, 59, 59, 999), UTC), '2026-10-31')
  assert.equal(dayKey(Date.UTC(2026, 10, 1, 0, 0, 0, 0), UTC), '2026-11-01')
})

test('zonedDayStart: idempotent and stable for every instant inside one day', () => {
  const start = zonedDayStart(sh(2026, 10, 31, 12, 0, 0), ASIA)
  assert.equal(zonedDayStart(start, ASIA), start)
  assert.equal(zonedDayStart(start + 1, ASIA), start)
  assert.equal(zonedDayStart(start + DAY - 1, ASIA), start)
  assert.equal(zonedDayStart(start + DAY, ASIA), start + DAY)
})

test('zonedMonthStart / zonedYearStart: Asia/Shanghai natural boundaries', () => {
  assert.equal(zonedMonthStart(sh(2026, 10, 31, 23, 0, 0), ASIA), sh(2026, 10, 1))
  assert.equal(zonedMonthStart(sh(2026, 12, 31, 23, 0, 0), ASIA), sh(2026, 12, 1))
  assert.equal(zonedYearStart(sh(2026, 6, 1, 12, 0, 0), ASIA), sh(2026, 1, 1))
  assert.equal(zonedYearStart(sh(2026, 1, 1), ASIA), sh(2026, 1, 1))
  assert.equal(zonedYearStart(sh(2025, 12, 31, 23, 59, 59), ASIA), sh(2025, 1, 1))
})

test('DST America/New_York: spring-forward day starts at 05:00Z and is 23h long', () => {
  const start = zonedDayStart(Date.UTC(2026, 2, 8, 12, 0, 0), NY)
  assert.equal(start, Date.UTC(2026, 2, 8, 5, 0, 0)) // 2026-03-08 00:00 EST
  assert.equal(addZonedDays(start, 1, NY), Date.UTC(2026, 2, 9, 4, 0, 0)) // 23h later
  assert.equal(dayKey(Date.UTC(2026, 2, 8, 6, 59, 0), NY), '2026-03-08')
})

test('DST America/New_York: fall-back day starts at 04:00Z and is 25h long', () => {
  const start = zonedDayStart(Date.UTC(2026, 10, 1, 12, 0, 0), NY)
  assert.equal(start, Date.UTC(2026, 10, 1, 4, 0, 0)) // 2026-11-01 00:00 EDT
  assert.equal(addZonedDays(start, 1, NY), Date.UTC(2026, 10, 2, 5, 0, 0)) // 25h later
  assert.equal(dayKey(Date.UTC(2026, 10, 1, 5, 30, 0), NY), '2026-11-01')
})

test('DST America/New_York: addZonedDays preserves wall-clock time across both transitions', () => {
  // 2026-03-07 12:00 EST -> 2026-03-08 12:00 EDT (23 wall-clock hours elapsed).
  const spring = addZonedDays(Date.UTC(2026, 2, 7, 17, 0, 0), 1, NY)
  assert.equal(spring, Date.UTC(2026, 2, 8, 16, 0, 0))
  assert.equal(spring - Date.UTC(2026, 2, 7, 17, 0, 0), 23 * 3600000)
  // 2026-10-31 12:00 EDT -> 2026-11-01 12:00 EST (25 wall-clock hours elapsed).
  const fall = addZonedDays(Date.UTC(2026, 9, 31, 16, 0, 0), 1, NY)
  assert.equal(fall, Date.UTC(2026, 10, 1, 17, 0, 0))
  assert.equal(fall - Date.UTC(2026, 9, 31, 16, 0, 0), 25 * 3600000)
})

test('DST America/New_York: month starts pick the correct offset on both sides', () => {
  assert.equal(zonedMonthStart(Date.UTC(2026, 2, 20, 12, 0, 0), NY), Date.UTC(2026, 2, 1, 5, 0, 0)) // EST
  assert.equal(zonedMonthStart(Date.UTC(2026, 10, 20, 12, 0, 0), NY), Date.UTC(2026, 10, 1, 4, 0, 0)) // EDT
  assert.equal(zonedYearStart(Date.UTC(2026, 6, 1, 12, 0, 0), NY), Date.UTC(2026, 0, 1, 5, 0, 0))
})

test('leap year: February 29 2028 exists and addZonedDays crosses it', () => {
  assert.equal(addZonedDays(sh(2028, 2, 28, 12, 0, 0), 1, ASIA), sh(2028, 2, 29, 12, 0, 0))
  assert.equal(addZonedDays(sh(2028, 2, 28, 12, 0, 0), 2, ASIA), sh(2028, 3, 1, 12, 0, 0))
  assert.equal(dayKey(sh(2028, 2, 29, 12, 0, 0), ASIA), '2028-02-29')
  assert.equal(dayKey(sh(2028, 3, 1, 12, 0, 0), ASIA), '2028-03-01')
})

test('leap year: February 2028 spans 29 calendar days, February 2026 only 28', () => {
  const feb2028 = zonedMonthStart(sh(2028, 2, 15), ASIA)
  const mar2028 = zonedMonthStart(sh(2028, 3, 15), ASIA)
  assert.equal((mar2028 - feb2028) / DAY, 29)
  const feb2026 = zonedMonthStart(sh(2026, 2, 15), ASIA)
  const mar2026 = zonedMonthStart(sh(2026, 3, 15), ASIA)
  assert.equal((mar2026 - feb2026) / DAY, 28)
  assert.equal(detectGranularity('2028-02-29'), 'day')
  assert.equal(detectGranularity('2026-02-29'), 'invalid')
})

test('addZonedDays: zero, negative, truncated and invalid arguments are safe', () => {
  const base = sh(2026, 3, 1, 12, 0, 0)
  assert.equal(addZonedDays(base, 0, ASIA), base)
  assert.equal(addZonedDays(base, -1, ASIA), sh(2026, 2, 28, 12, 0, 0))
  assert.equal(addZonedDays(base, -1, ASIA), sh(2026, 2, 28, 12, 0, 0))
  assert.equal(addZonedDays(sh(2026, 10, 31, 12, 0, 0), 1.9, ASIA), sh(2026, 11, 1, 12, 0, 0))
  assert.ok(Number.isNaN(addZonedDays(Number.NaN, 1, ASIA)))
  assert.ok(Number.isNaN(addZonedDays(123, Number.NaN, ASIA)))
  assert.ok(Number.isNaN(addZonedDays(Number.POSITIVE_INFINITY, 1, ASIA)))
  // Month / year roll-over in both directions.
  assert.equal(addZonedDays(sh(2026, 12, 31, 23, 0, 0), 1, ASIA), sh(2027, 1, 1, 23, 0, 0))
  assert.equal(addZonedDays(sh(2026, 1, 1, 8, 0, 0), -1, ASIA), sh(2025, 12, 31, 8, 0, 0))
})

test('host-local timezone (empty string) follows the process local calendar', () => {
  const probe = Date.UTC(2026, 4, 15, 4, 30, 0)
  const start = zonedDayStart(probe, '')
  assert.equal(new Date(start).getHours(), 0)
  assert.equal(new Date(start).getMinutes(), 0)
  assert.ok(start <= probe)
  assert.ok(probe - start < DAY)
  const probeDate = new Date(probe)
  const expectedKey = `${String(probeDate.getFullYear()).padStart(4, '0')}-${String(probeDate.getMonth() + 1).padStart(2, '0')}-${String(probeDate.getDate()).padStart(2, '0')}`
  assert.equal(dayKey(probe, ''), expectedKey)
})

// ---------------------------------------------------------------------------
// detectGranularity
// ---------------------------------------------------------------------------

test('detectGranularity: calendar day / month / year strings', () => {
  assert.equal(detectGranularity('2026-10-31'), 'day')
  assert.equal(detectGranularity(' 2026-10-31 '), 'day')
  assert.equal(detectGranularity('0001-01-01'), 'day')
  assert.equal(detectGranularity('2026-10'), 'month')
  assert.equal(detectGranularity('2026-01'), 'month')
  assert.equal(detectGranularity('2026'), 'year')
  assert.equal(detectGranularity('1970'), 'year')
})

test('detectGranularity: epoch numbers, Date objects, numeric strings and ISO datetimes', () => {
  assert.equal(detectGranularity(1793446567405), 'epoch')
  assert.equal(detectGranularity(0), 'epoch')
  assert.equal(detectGranularity(-1000), 'epoch')
  assert.equal(detectGranularity(new Date(NOW)), 'epoch')
  assert.equal(detectGranularity('1793446567405'), 'epoch')
  assert.equal(detectGranularity('2026-10-31T12:00:00Z'), 'epoch')
  assert.equal(detectGranularity('2026-10-31 12:00'), 'epoch')
})

test('detectGranularity: invalid and impossible inputs are rejected', () => {
  for (const value of [null, undefined, '', '   ', Number.NaN, Number.POSITIVE_INFINITY, {}, [], true, 'garbage', '2026-13', '2026-00', '2026-10-32', '2026-1', '2026/10/31', '2026-02-30', '2027-02-29', '0000']) {
    assert.equal(detectGranularity(value), 'invalid', `expected invalid for ${JSON.stringify(value)}`)
  }
  assert.equal(detectGranularity(new Date('not-a-date')), 'invalid')
  assert.equal(detectGranularity('2026-13-01T00:00:00Z'), 'invalid')
})

// ---------------------------------------------------------------------------
// folderTimeRange / event-time fallback
// ---------------------------------------------------------------------------

test('folderTimeRange: folders without event time fall back to [createdAt, createdAt+1)', () => {
  assert.deepEqual(folderTimeRange({ createdAt: 1000 }), { start: 1000, end: 1001, source: 'archive' })
  // An eventStart without eventTimeSource is not trusted: archive time wins.
  assert.deepEqual(folderTimeRange({ createdAt: 1000, eventStart: 5, eventEnd: 9 }), { start: 1000, end: 1001, source: 'archive' })
  // Explicit 'archive' source also wins over stray event fields.
  assert.deepEqual(
    folderTimeRange({ createdAt: 1000, eventStart: 5, eventEnd: 9, eventTimeSource: 'archive' }),
    { start: 1000, end: 1001, source: 'archive' },
  )
})

test('folderTimeRange: messages / judge event sources use [eventStart, eventEnd)', () => {
  assert.deepEqual(
    folderTimeRange({ createdAt: 1000, eventStart: 200, eventEnd: 400, eventTimeSource: 'messages' }),
    { start: 200, end: 400, source: 'messages' },
  )
  assert.deepEqual(
    folderTimeRange({ createdAt: 1000, eventStart: 200, eventEnd: 400, eventTimeSource: 'judge' }),
    { start: 200, end: 400, source: 'judge' },
  )
})

test('folderTimeRange: degenerate input is repaired and never throws', () => {
  // end <= start becomes a one-millisecond interval.
  assert.deepEqual(
    folderTimeRange({ createdAt: 1000, eventStart: 500, eventEnd: 500, eventTimeSource: 'messages' }),
    { start: 500, end: 501, source: 'messages' },
  )
  assert.deepEqual(
    folderTimeRange({ createdAt: 1000, eventStart: 500, eventTimeSource: 'messages' }),
    { start: 500, end: 501, source: 'messages' },
  )
  // Broken eventStart falls back to archive.
  assert.deepEqual(
    folderTimeRange({ createdAt: 1000, eventStart: Number.NaN, eventEnd: 2000, eventTimeSource: 'messages' }),
    { start: 1000, end: 1001, source: 'archive' },
  )
  for (const entry of [undefined, null, 42, 'x', {}, { createdAt: Number.NaN }, { eventTimeSource: 'messages' }]) {
    const range = folderTimeRange(entry)
    assert.ok(Number.isFinite(range.start))
    assert.ok(range.end > range.start)
    assert.equal(range.source, 'archive')
  }
})

test('failure safety: absurd timestamps degrade instead of throwing', () => {
  const cfg = makeCfg()
  // A JS Date cannot represent these; every helper must degrade, never throw.
  const absurd = [1e20, -1e20, Number.MAX_VALUE]
  for (const value of absurd) {
    assert.equal(dayKey(value, ASIA), '')
    assert.ok(Number.isNaN(zonedDayStart(value, ASIA)))
    assert.ok(Number.isNaN(zonedMonthStart(value, ASIA)))
    assert.ok(Number.isNaN(zonedYearStart(value, ASIA)))
    assert.ok(Number.isNaN(addZonedDays(value, 1, ASIA)))
    assert.equal(formatWindow({ from: value, to: value + 1, level: 'day' }, ASIA), '全部时间')
  }
  assert.ok(Number.isNaN(addZonedDays(0, 1e9, ASIA)))
  // Corrupt folder timestamps fall back to the epoch archive range.
  const corrupt = folderTimeRange({ id: 'mem-x', createdAt: 1e20, eventStart: 1e20, eventEnd: 1e20, eventTimeSource: 'messages' })
  assert.deepEqual(corrupt, { start: 0, end: 1, source: 'archive' })
  const index = buildTimeIndex([{ id: 'mem-corrupt', createdAt: 1e20 }], cfg)
  assert.equal(index.folderCount, 1)
  assert.deepEqual(index.byId.get('mem-corrupt'), { start: 0, end: 1, source: 'archive' })
  // A raw (un-normalised) window outside the Date range matches nothing.
  assert.equal(queryTimeIndex(index, { from: 1e20, to: 1e20 + 1, level: 'day' }, cfg).count, 0)
  // Normalisation degrades the absurd endpoint to "no constraint".
  const normalized = normalizeTimeQuery({ timeFrom: 1e20 }, cfg, NOW)
  assert.equal(normalized.level, 'all')
  assert.equal(normalized.from, null)
  assert.ok(normalized.warnings.some((warning) => /timeFrom/.test(warning)))
})

// ---------------------------------------------------------------------------
// buildTimeIndex (CSR buckets)
// ---------------------------------------------------------------------------

test('buildTimeIndex: CSR day buckets, ids, byId and sorted keys', () => {
  const cfg = makeCfg()
  const folders = [
    makeFolder({ createdAt: sh(2026, 10, 31, 10, 0, 0) }),
    makeFolder({ createdAt: sh(2026, 10, 31, 18, 0, 0) }),
    makeFolder({ createdAt: sh(2026, 11, 2, 10, 0, 0) }),
    makeFolder({
      createdAt: sh(2026, 10, 31, 23, 0, 0),
      eventStart: sh(2026, 10, 31, 23, 0, 0),
      eventEnd: sh(2026, 11, 1, 10, 0, 0),
      eventTimeSource: 'messages',
    }),
  ]
  const index = buildTimeIndex(folders, cfg)
  assert.equal(index.folderCount, 4)
  assert.equal(index.timezone, ASIA)
  assert.deepEqual(index.ids, folders.map((folder) => folder.id))
  assert.ok(Number.isFinite(index.builtAt))
  assert.deepEqual(index.dayKeys, ['2026-10-31', '2026-11-01', '2026-11-02'])
  const oct31 = index.buckets.get('2026-10-31')
  const nov01 = index.buckets.get('2026-11-01')
  const nov02 = index.buckets.get('2026-11-02')
  assert.ok(oct31 instanceof Int32Array)
  assert.deepEqual([...oct31].sort(), [0, 1, 3])
  assert.deepEqual([...nov01].sort(), [3])
  assert.deepEqual([...nov02].sort(), [2])
  assert.deepEqual(index.byId.get(folders[3].id), {
    start: sh(2026, 10, 31, 23, 0, 0),
    end: sh(2026, 11, 1, 10, 0, 0),
    source: 'messages',
  })
  // CSR layout: offsets are monotonic and subarrays share the values buffer.
  assert.equal(index.csr.day.offsets.length, index.dayKeys.length + 1)
  for (let bucket = 0; bucket < index.dayKeys.length; bucket += 1) {
    assert.equal(index.buckets.get(index.dayKeys[bucket]).length, index.csr.day.offsets[bucket + 1] - index.csr.day.offsets[bucket])
  }
})

test('buildTimeIndex: a cross-day folder enters every day, month and year bucket', () => {
  const cfg = makeCfg()
  const crossMonth = makeFolder({
    id: 'mem-cross-month',
    createdAt: sh(2026, 12, 31, 23, 0, 0),
    eventStart: sh(2026, 12, 31, 23, 0, 0),
    eventEnd: sh(2027, 1, 1, 1, 0, 0),
    eventTimeSource: 'messages',
  })
  const index = buildTimeIndex([crossMonth], cfg)
  assert.deepEqual(index.dayKeys, ['2026-12-31', '2027-01-01'])
  assert.deepEqual(index.monthKeys, ['2026-12', '2027-01'])
  assert.deepEqual(index.yearKeys, ['2026', '2027'])
  assert.equal(index.buckets.get('2026-12-31').length, 1)
  assert.equal(index.buckets.get('2027-01-01').length, 1)
  assert.equal(index.monthBuckets.get('2026-12').length, 1)
  assert.equal(index.monthBuckets.get('2027-01').length, 1)
  assert.equal(index.yearBuckets.get('2026').length, 1)
  assert.equal(index.yearBuckets.get('2027').length, 1)
})

test('buildTimeIndex: bucket membership count equals the sum of folder day spans', () => {
  const cfg = makeCfg()
  const folders = [
    makeFolder({ createdAt: sh(2026, 10, 1, 9, 0, 0) }),
    makeFolder({ createdAt: sh(2026, 10, 15, 9, 0, 0) }),
    makeFolder({
      createdAt: sh(2026, 10, 20, 22, 0, 0),
      eventStart: sh(2026, 10, 20, 22, 0, 0),
      eventEnd: sh(2026, 10, 23, 2, 0, 0),
      eventTimeSource: 'messages',
    }),
    makeFolder({ createdAt: sh(2026, 9, 30, 23, 59, 59, 999) }),
  ]
  const index = buildTimeIndex(folders, cfg)
  let expected = 0
  for (const folder of folders) expected += spanDays(folderTimeRange(folder))
  let actual = 0
  for (const bucket of index.buckets.values()) actual += bucket.length
  assert.equal(actual, expected)
  // Every folder in a day bucket really covers that day (CSR <-> interval agreement).
  for (const [key, bucket] of index.buckets) {
    for (const position of bucket) {
      const range = index.ranges[position]
      assert.ok(dayKey(range.start, ASIA) <= key, `${key} before range start`)
      assert.ok(dayKey(range.end - 1, ASIA) >= key, `${key} after range end`)
    }
  }
})

test('buildTimeIndex: duplicate ids keep the first entry, malformed entries are skipped', () => {
  const cfg = makeCfg()
  const first = makeFolder({ id: 'mem-dup', createdAt: sh(2026, 10, 1, 9, 0, 0) })
  const second = makeFolder({ id: 'mem-dup', createdAt: sh(2026, 10, 20, 9, 0, 0) })
  const valid = makeFolder({ id: 'mem-valid', createdAt: sh(2026, 11, 2, 9, 0, 0) })
  const index = buildTimeIndex([first, second, valid, null, 42, {}, { id: '' }, { id: 5 }, 'x'], cfg)
  assert.equal(index.folderCount, 2)
  assert.deepEqual(index.ids, ['mem-dup', 'mem-valid'])
  assert.deepEqual(index.byId.get('mem-dup'), folderTimeRange(first))
  // Non-array input is an empty index, not a throw.
  const empty = buildTimeIndex(undefined, cfg)
  assert.equal(empty.folderCount, 0)
  assert.deepEqual(empty.dayKeys, [])
  assert.equal(empty.byId.size, 0)
})

test('buildTimeIndex: legacy entries without event fields keep archivedAt ranges', () => {
  const cfg = makeCfg()
  const legacy = Array.from({ length: 5 }, (unused, position) =>
    makeFolder({ createdAt: sh(2026, 10, 28 + position, 12, 0, 0) }))
  const index = buildTimeIndex(legacy, cfg)
  for (const folder of legacy) {
    const range = index.byId.get(folder.id)
    assert.equal(range.source, 'archive')
    assert.equal(range.end - range.start, 1)
  }
  assert.equal(index.folderCount, 5)
})

test('buildTimeIndex: index round-trip through store keeps event fields (no loss)', () => {
  const cfg = makeCfg()
  const meta = {
    version: 1,
    id: 'mem-20261031T120000Z-0001',
    createdAt: sh(2026, 10, 31, 20, 0, 0),
    alpha: 0.5,
    beta: 2,
    keywords: ['时间', '测试'],
    stats: { messages: 2, chars: 10, tokens: 5 },
    title: '时间测试',
    eventStart: sh(2026, 10, 31, 18, 0, 0),
    eventEnd: sh(2026, 10, 31, 21, 0, 0),
    eventTimeSource: 'messages',
  }
  // indexEntryFromMeta must carry the optional event fields explicitly.
  const entry = indexEntryFromMeta(meta)
  assert.equal(entry.eventStart, meta.eventStart)
  assert.equal(entry.eventEnd, meta.eventEnd)
  assert.equal(entry.eventTimeSource, 'messages')
  // normalizeIndex(raw) -> write -> read path keeps them as well.
  const normalized = normalizeIndex({ version: 1, folders: [entry] })
  assert.equal(normalized.folders[0].eventStart, meta.eventStart)
  const index = buildTimeIndex(normalized.folders, cfg)
  assert.deepEqual(index.byId.get(meta.id), { start: meta.eventStart, end: meta.eventEnd, source: 'messages' })

  // Full disk round-trip via store.writeFolder/loadIndex (temp dir only).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-time-index-'))
  try {
    writeFolder(dir, { id: meta.id, meta, messages: [{ role: 'user', content: 'hi' }] })
    const loaded = loadIndex(dir, cfg)
    assert.equal(loaded.folders.length, 1)
    const loadedEntry = loaded.folders[0]
    assert.equal(loadedEntry.eventStart, meta.eventStart)
    assert.equal(loadedEntry.eventEnd, meta.eventEnd)
    assert.equal(loadedEntry.eventTimeSource, 'messages')
    const loadedIndex = buildTimeIndex(loaded.folders, cfg)
    assert.deepEqual(loadedIndex.byId.get(meta.id), { start: meta.eventStart, end: meta.eventEnd, source: 'messages' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildTimeIndex: a corrupt huge event span is truncated instead of exploding', () => {
  const cfg = makeCfg()
  const huge = makeFolder({
    id: 'mem-huge',
    createdAt: 0,
    eventStart: 0,
    eventEnd: 10000 * DAY,
    eventTimeSource: 'messages',
  })
  const index = buildTimeIndex([huge], cfg)
  assert.ok(index.dayKeys.length <= 3661)
  assert.equal(index.dayKeys.length, 3660)
  assert.ok(index.warnings.some((warning) => /truncated/.test(warning)))
})

// ---------------------------------------------------------------------------
// queryTimeIndex
// ---------------------------------------------------------------------------

test('queryTimeIndex: single-day window matches only exact overlaps', () => {
  const cfg = makeCfg()
  const before = makeFolder({ createdAt: Date.UTC(2026, 9, 31, 0, 0, 0) }) // Oct 31 08:00 CST
  const lastMs = makeFolder({ createdAt: sh(2026, 10, 31, 23, 59, 59, 999) })
  const nextDay = makeFolder({ createdAt: sh(2026, 11, 1, 0, 0, 0) })
  const index = buildTimeIndex([before, lastMs, nextDay], cfg)
  const window = normalizeTimeQuery({ timeFrom: '2026-10-31' }, cfg, NOW)
  const result = queryTimeIndex(index, window, cfg)
  assert.ok(result.ids instanceof Set)
  assert.deepEqual(sortedIds(result.ids), [before.id, lastMs.id])
  assert.equal(result.count, 2)
})

test('queryTimeIndex: interval-overlap boundaries are half-open', () => {
  const cfg = makeCfg()
  const tenToEleven = makeFolder({
    createdAt: sh(2026, 10, 31, 12, 0, 0),
    eventStart: sh(2026, 10, 31, 10, 0, 0),
    eventEnd: sh(2026, 10, 31, 11, 0, 0),
    eventTimeSource: 'messages',
  })
  const index = buildTimeIndex([tenToEleven], cfg)
  const probe = (from, to) => queryTimeIndex(index, { from, to, level: 'day' }, cfg).count
  assert.equal(probe(sh(2026, 10, 31, 11, 0, 0), sh(2026, 10, 31, 12, 0, 0)), 0) // fEnd == qFrom
  assert.equal(probe(sh(2026, 10, 31, 9, 0, 0), sh(2026, 10, 31, 10, 0, 0)), 0) // fStart == qTo
  assert.equal(probe(sh(2026, 10, 31, 10, 0, 0), sh(2026, 10, 31, 11, 0, 0)), 1) // exact window
  assert.equal(probe(sh(2026, 10, 31, 10, 30, 0), sh(2026, 10, 31, 10, 45, 0)), 1) // inside
  assert.equal(probe(sh(2026, 10, 31, 9, 30, 0), sh(2026, 10, 31, 10, 30, 0)), 1) // leading overlap
  assert.equal(probe(sh(2026, 10, 31, 10, 30, 0), sh(2026, 10, 31, 11, 30, 0)), 1) // trailing overlap
  assert.equal(probe(sh(2026, 10, 31, 9, 0, 0), sh(2026, 10, 31, 10, 0, 0, 1)), 1) // 1ms overlap
})

test('queryTimeIndex: a cross-day folder is hit from both of its days', () => {
  const cfg = makeCfg()
  const cross = makeFolder({
    createdAt: sh(2026, 10, 31, 23, 30, 0),
    eventStart: sh(2026, 10, 31, 23, 30, 0),
    eventEnd: sh(2026, 11, 1, 0, 30, 0),
    eventTimeSource: 'messages',
  })
  const index = buildTimeIndex([cross], cfg)
  const oct31 = normalizeTimeQuery({ timeFrom: '2026-10-31' }, cfg, NOW)
  const nov01 = normalizeTimeQuery({ timeFrom: '2026-11-01' }, cfg, NOW)
  const nov02 = normalizeTimeQuery({ timeFrom: '2026-11-02' }, cfg, NOW)
  assert.deepEqual(sortedIds(queryTimeIndex(index, oct31, cfg).ids), [cross.id])
  assert.deepEqual(sortedIds(queryTimeIndex(index, nov01, cfg).ids), [cross.id])
  assert.equal(queryTimeIndex(index, nov02, cfg).count, 0)
})

test('queryTimeIndex: month / year windows respect natural boundaries at millisecond edges', () => {
  const cfg = makeCfg()
  const sepLast = makeFolder({ id: 'mem-sep-last', createdAt: sh(2026, 9, 30, 23, 59, 59, 999) })
  const octFirst = makeFolder({ id: 'mem-oct-first', createdAt: sh(2026, 10, 1, 0, 0, 0) })
  const octLast = makeFolder({ id: 'mem-oct-last', createdAt: sh(2026, 10, 31, 23, 59, 59, 999) })
  const novFirst = makeFolder({ id: 'mem-nov-first', createdAt: sh(2026, 11, 1, 0, 0, 0) })
  const year2025 = makeFolder({ id: 'mem-2025', createdAt: sh(2025, 12, 31, 23, 0, 0) })
  const index = buildTimeIndex([sepLast, octFirst, octLast, novFirst, year2025], cfg)

  const october = normalizeTimeQuery({ timeFrom: '2026-10' }, cfg, NOW)
  assert.deepEqual(sortedIds(queryTimeIndex(index, october, cfg).ids), [octFirst.id, octLast.id])
  const november = normalizeTimeQuery({ timeFrom: '2026-11' }, cfg, NOW)
  assert.deepEqual(sortedIds(queryTimeIndex(index, november, cfg).ids), [novFirst.id])
  const year2026 = normalizeTimeQuery({ timeFrom: '2026' }, cfg, NOW)
  // `mem-sep-last` is archived on 2026-09-30 23:59:59.999 +08, i.e. inside 2026.
  assert.deepEqual(sortedIds(queryTimeIndex(index, year2026, cfg).ids), [sepLast.id, octFirst.id, octLast.id, novFirst.id].sort())
})

test('queryTimeIndex: all / null / missing index mean "no constraint"', () => {
  const cfg = makeCfg()
  const folders = [makeFolder(), makeFolder(), makeFolder()]
  const index = buildTimeIndex(folders, cfg)
  assert.deepEqual(queryTimeIndex(index, { from: null, to: null, level: 'all' }, cfg), { ids: null, count: 3 })
  assert.deepEqual(queryTimeIndex(index, null, cfg), { ids: null, count: 3 })
  assert.deepEqual(queryTimeIndex(index, { from: Number.NaN, to: 5 }, cfg), { ids: null, count: 3 })
  assert.deepEqual(queryTimeIndex(null, { from: 0, to: 1 }, cfg), { ids: null, count: 0 })
  const empty = buildTimeIndex([], cfg)
  const result = queryTimeIndex(empty, { from: 0, to: 1, level: 'day' }, cfg)
  assert.ok(result.ids instanceof Set)
  assert.equal(result.count, 0)
})

test('queryTimeIndex: time.mode off/index leaves recall unconstrained, constrain filters', () => {
  const folders = [makeFolder({ createdAt: sh(2026, 10, 31, 10, 0, 0) })]
  const window = normalizeTimeQuery({ timeFrom: '2026-10-31' }, makeCfg(), NOW)
  const off = queryTimeIndex(buildTimeIndex(folders, makeCfg()), window, loadConfig(undefined, { time: { mode: 'off' } }))
  assert.equal(off.ids, null)
  assert.equal(off.count, 1)
  // Engine default ('index') builds the index but must not constrain recall.
  const defaultCfg = loadConfig()
  assert.equal(defaultCfg.time.mode, 'index')
  assert.equal(timeConstraintEnabled(defaultCfg), false)
  assert.equal(queryTimeIndex(buildTimeIndex(folders, defaultCfg), window, defaultCfg).ids, null)
  // Packaged product config ('constrain') filters.
  const constrain = makeCfg()
  assert.equal(timeConstraintEnabled(constrain), true)
  assert.deepEqual(sortedIds(queryTimeIndex(buildTimeIndex(folders, constrain), window, constrain).ids), [folders[0].id])
})

test('queryTimeIndex: windowScanMax forces the full-scan path with identical results', () => {
  const folders = []
  const rng = seeded(0xabc001)
  const base = Date.UTC(2026, 0, 1)
  for (let i = 0; i < 60; i += 1) {
    folders.push(makeFolder({ createdAt: base + Math.floor(rng() * 120 * DAY) }))
  }
  const window = normalizeTimeQuery({ timeFrom: '2026-01-15', timeTo: '2026-03-01' }, makeCfg(), NOW)
  const bucketCfg = makeCfg({ windowScanMax: 4096 })
  const scanCfg = makeCfg({ windowScanMax: 2 })
  const bucketIndex = buildTimeIndex(folders, bucketCfg)
  const scanIndex = buildTimeIndex(folders, scanCfg)
  const bucketResult = queryTimeIndex(bucketIndex, window, bucketCfg)
  const scanResult = queryTimeIndex(scanIndex, window, scanCfg)
  assert.deepEqual(sortedIds(bucketResult.ids), sortedIds(scanResult.ids))
  assert.equal(bucketResult.count, scanResult.count)
  assert.ok(bucketResult.count > 0)
})

test('queryTimeIndex: a reversed window is handled defensively', () => {
  const cfg = makeCfg()
  const folder = makeFolder({
    createdAt: sh(2026, 10, 31, 12, 0, 0),
    eventStart: sh(2026, 10, 31, 10, 0, 0),
    eventEnd: sh(2026, 10, 31, 11, 0, 0),
    eventTimeSource: 'messages',
  })
  const index = buildTimeIndex([folder], cfg)
  const forward = queryTimeIndex(index, { from: sh(2026, 10, 31, 10, 30, 0), to: sh(2026, 10, 31, 10, 45, 0) }, cfg)
  const reversed = queryTimeIndex(index, { from: sh(2026, 10, 31, 10, 45, 0), to: sh(2026, 10, 31, 10, 30, 0) }, cfg)
  assert.deepEqual(sortedIds(reversed.ids), sortedIds(forward.ids))
  assert.equal(reversed.count, forward.count)
})

// ---------------------------------------------------------------------------
// normalizeTimeQuery
// ---------------------------------------------------------------------------

test('normalizeTimeQuery: a single day is exactly that calendar day (L0)', () => {
  const cfg = makeCfg()
  const normalized = normalizeTimeQuery({ timeFrom: '2026-10-31' }, cfg, NOW)
  assert.equal(normalized.from, sh(2026, 10, 31))
  assert.equal(normalized.to, sh(2026, 11, 1))
  assert.equal(normalized.level, 'day')
  assert.equal(normalized.granularity, 'day')
  assert.equal(normalized.center, sh(2026, 10, 31))
  assert.deepEqual(normalized.requested, { from: sh(2026, 10, 31), to: sh(2026, 11, 1) })
  assert.deepEqual(normalized.warnings, [])
})

test('normalizeTimeQuery: a single month / year is its natural window', () => {
  const cfg = makeCfg()
  const month = normalizeTimeQuery({ timeFrom: '2026-10' }, cfg, NOW)
  assert.equal(month.from, sh(2026, 10, 1))
  assert.equal(month.to, sh(2026, 11, 1))
  assert.equal(month.level, 'month')
  assert.equal(month.center, sh(2026, 10, 1))
  const year = normalizeTimeQuery({ timeFrom: '2026' }, cfg, NOW)
  assert.equal(year.from, sh(2026, 1, 1))
  assert.equal(year.to, sh(2027, 1, 1))
  assert.equal(year.level, 'year')
})

test('normalizeTimeQuery: epoch input uses granularity; without one it falls back to minRangeDays', () => {
  const cfg = makeCfg()
  const epoch = sh(2026, 10, 31, 12, 0, 0)
  const month = normalizeTimeQuery({ timeFrom: epoch, granularity: 'month' }, cfg, NOW)
  assert.equal(month.from, sh(2026, 10, 1))
  assert.equal(month.to, sh(2026, 11, 1))
  assert.equal(month.level, 'month')
  const day = normalizeTimeQuery({ timeFrom: epoch, granularity: 'day' }, cfg, NOW)
  assert.equal(day.from, sh(2026, 10, 31))
  assert.equal(day.to, sh(2026, 11, 1))
  const fallback = normalizeTimeQuery({ timeFrom: epoch }, cfg, NOW)
  assert.equal(fallback.from, sh(2026, 10, 31))
  assert.equal(fallback.to, sh(2026, 11, 3))
  assert.equal(fallback.level, 'day')
  assert.ok(fallback.warnings.some((warning) => /without granularity/.test(warning)))
})

test('normalizeTimeQuery: a single endpoint is that endpoint unit window', () => {
  const cfg = makeCfg()
  const toOnly = normalizeTimeQuery({ timeTo: '2026-10' }, cfg, NOW)
  assert.equal(toOnly.from, sh(2026, 10, 1))
  assert.equal(toOnly.to, sh(2026, 11, 1))
  assert.equal(toOnly.level, 'month')
  const yearFrom = normalizeTimeQuery({ timeFrom: '2026' }, cfg, NOW)
  assert.equal(yearFrom.from, sh(2026, 1, 1))
  assert.equal(yearFrom.level, 'year')
})

test('normalizeTimeQuery: from > to is swapped with a warning', () => {
  const cfg = makeCfg()
  const normalized = normalizeTimeQuery({ timeFrom: '2026-10-31', timeTo: '2026-10-30' }, cfg, NOW)
  assert.equal(normalized.from, sh(2026, 10, 30))
  // Two one-day endpoints give a 2-day range, then minRangeDays=3 widens it.
  assert.equal(normalized.to, sh(2026, 11, 2))
  assert.ok(normalized.warnings.some((warning) => /swapped/.test(warning)))
  assert.ok(normalized.warnings.some((warning) => /minRangeDays=3/.test(warning)))
})

test('normalizeTimeQuery: explicit ranges shorter than minRangeDays widen around the centre', () => {
  const cfg = makeCfg()
  const sameDay = normalizeTimeQuery({ timeFrom: '2026-10-31', timeTo: '2026-10-31' }, cfg, NOW)
  assert.equal(sameDay.from, sh(2026, 10, 30))
  assert.equal(sameDay.to, sh(2026, 11, 2))
  assert.equal((sameDay.to - sameDay.from) / DAY, 3)
  assert.ok(sameDay.warnings.some((warning) => /minRangeDays=3/.test(warning)))
  const twoDays = normalizeTimeQuery({ timeFrom: '2026-10-31', timeTo: '2026-11-01' }, cfg, NOW)
  assert.equal(twoDays.from, sh(2026, 10, 31))
  assert.equal(twoDays.to, sh(2026, 11, 3))
  assert.equal((twoDays.to - twoDays.from) / DAY, 3)
})

test('normalizeTimeQuery: explicit ranges longer than maxRangeDays are truncated', () => {
  const cfg = makeCfg({ maxRangeDays: 10 })
  const normalized = normalizeTimeQuery({ timeFrom: '2026-01-01', timeTo: '2026-12-31' }, cfg, NOW)
  assert.equal(normalized.from, sh(2026, 1, 1))
  assert.equal(normalized.to, sh(2026, 1, 11))
  assert.equal((normalized.to - normalized.from) / DAY, 10)
  assert.ok(normalized.warnings.some((warning) => /maxRangeDays=10/.test(warning)))
})

test('normalizeTimeQuery: future windows are clamped to now', () => {
  const cfg = makeCfg()
  const futureDay = normalizeTimeQuery({ timeFrom: '2026-12-01' }, cfg, NOW)
  assert.equal(futureDay.from, NOW)
  assert.equal(futureDay.to, NOW)
  assert.ok(futureDay.warnings.some((warning) => /future time clamped/.test(warning)))
  // A future-only explicit range collapses to "query now".
  const futureRange = normalizeTimeQuery({ timeFrom: '2026-12-01', timeTo: '2026-12-31' }, cfg, NOW)
  assert.equal(futureRange.from, NOW)
  assert.equal(futureRange.to, NOW)
  // A range that starts in the past is clamped at the future end only.
  const openEnded = normalizeTimeQuery({ timeFrom: '2026-11-01', timeTo: '2026-12-31' }, cfg, NOW)
  assert.equal(openEnded.from, sh(2026, 11, 1))
  assert.equal(openEnded.to, NOW)
  // Wholly past windows are untouched.
  const past = normalizeTimeQuery({ timeFrom: '2026-10-31' }, cfg, NOW)
  assert.deepEqual(past.warnings, [])
  assert.equal(past.to, sh(2026, 11, 1))
  // A natural month containing "now" keeps its full natural window.
  const currentMonth = normalizeTimeQuery({ timeFrom: '2026-11' }, cfg, NOW)
  assert.equal(currentMonth.from, sh(2026, 11, 1))
  assert.equal(currentMonth.to, sh(2026, 12, 1))
  assert.deepEqual(currentMonth.warnings, [])
})

test('normalizeTimeQuery: invalid / empty / malformed input degrades safely (never throws)', () => {
  const cfg = makeCfg()
  const expectUnconstrained = (input) => {
    const normalized = normalizeTimeQuery(input, cfg, NOW)
    assert.equal(normalized.level, 'all')
    assert.equal(normalized.from, null)
    assert.equal(normalized.to, null)
    assert.equal(normalized.center, null)
    assert.equal(normalized.granularity, 'invalid')
    assert.deepEqual(normalized.requested, { from: null, to: null })
    assert.ok(normalized.warnings.length > 0)
    return normalized
  }
  expectUnconstrained(undefined)
  expectUnconstrained(null)
  expectUnconstrained(42)
  expectUnconstrained([])
  expectUnconstrained({})
  expectUnconstrained({ timeFrom: '' })
  expectUnconstrained({ timeFrom: '   ' })
  expectUnconstrained({ timeFrom: 'garbage' })
  expectUnconstrained({ timeFrom: Number.NaN })
  expectUnconstrained({ timeFrom: {} })
  expectUnconstrained({ timeFrom: 'garbage', timeTo: 'nonsense' })
  // One broken endpoint does not kill the usable one.
  const oneValid = normalizeTimeQuery({ timeFrom: 'garbage', timeTo: '2026-10' }, cfg, NOW)
  assert.equal(oneValid.from, sh(2026, 10, 1))
  assert.equal(oneValid.to, sh(2026, 11, 1))
  assert.ok(oneValid.warnings.some((warning) => /timeFrom/.test(warning)))
})

test('normalizeTimeQuery: malformed granularity is ignored, conflicting granularity warns', () => {
  const cfg = makeCfg()
  const bad = normalizeTimeQuery({ timeFrom: '2026-10-31', granularity: 'decade' }, cfg, NOW)
  assert.equal(bad.from, sh(2026, 10, 31))
  assert.ok(bad.warnings.some((warning) => /expected 'day' \| 'month' \| 'year'/.test(warning)))
  const conflict = normalizeTimeQuery({ timeFrom: '2026-10', granularity: 'day' }, cfg, NOW)
  assert.equal(conflict.level, 'month')
  assert.equal(conflict.from, sh(2026, 10, 1))
  assert.ok(conflict.warnings.some((warning) => /requested 'day' ignored/.test(warning)))
})

test('normalizeTimeQuery: leap-day and DST windows resolve to calendar days', () => {
  const cfg = makeCfg()
  const leap = normalizeTimeQuery({ timeFrom: '2024-02-29' }, cfg, NOW)
  assert.equal(leap.from, sh(2024, 2, 29))
  assert.equal(leap.to, sh(2024, 3, 1))
  assert.equal(leap.level, 'day')
  const nyCfg = makeCfg({ timezone: NY })
  const spring = normalizeTimeQuery({ timeFrom: '2026-03-08' }, nyCfg, NOW)
  assert.equal(spring.from, Date.UTC(2026, 2, 8, 5, 0, 0))
  assert.equal(spring.to, Date.UTC(2026, 2, 9, 4, 0, 0))
  assert.equal(spring.to - spring.from, 23 * 3600000)
  const fall = normalizeTimeQuery({ timeFrom: '2026-11-01' }, nyCfg, NOW)
  assert.equal(fall.from, Date.UTC(2026, 10, 1, 4, 0, 0))
  assert.equal(fall.to, Date.UTC(2026, 10, 2, 5, 0, 0))
  assert.equal(fall.to - fall.from, 25 * 3600000)
})

test('normalizeTimeQuery: minRangeDays is configurable', () => {
  const five = normalizeTimeQuery(
    { timeFrom: '2026-10-31', timeTo: '2026-11-01' },
    makeCfg({ minRangeDays: 5 }),
    NOW,
  )
  assert.equal(five.from, sh(2026, 10, 30))
  assert.equal(five.to, sh(2026, 11, 4))
  assert.equal((five.to - five.from) / DAY, 5)
  const one = normalizeTimeQuery(
    { timeFrom: '2026-10-31', timeTo: '2026-11-01' },
    makeCfg({ minRangeDays: 1 }),
    NOW,
  )
  assert.equal((one.to - one.from) / DAY, 2)
  // Single-day L0 is never widened by minRangeDays.
  const singleDay = normalizeTimeQuery({ timeFrom: '2026-10-31' }, makeCfg({ minRangeDays: 5 }), NOW)
  assert.equal((singleDay.to - singleDay.from) / DAY, 1)
})

test('normalizeTimeQuery: invalid config timezone degrades to host local with a warning', () => {
  const normalized = normalizeTimeQuery({ timeFrom: '2026-10-31' }, rawCfg({ timezone: 'Nope/Zone' }), NOW)
  assert.ok(normalized.warnings.some((warning) => /unknown IANA time zone/.test(warning)))
  assert.ok(Number.isFinite(normalized.from))
  assert.ok(normalized.to > normalized.from)
  const index = buildTimeIndex([makeFolder({ createdAt: sh(2026, 10, 31, 12, 0, 0) })], rawCfg({ timezone: 'Nope/Zone' }))
  assert.equal(index.timezone, '')
  assert.ok(index.warnings.some((warning) => /unknown IANA time zone/.test(warning)))
})

test('normalizeTimeQuery: repeats deterministically with an explicit fake clock', () => {
  const cfg = makeCfg()
  const input = { timeFrom: '2026-10-31', timeTo: '2026-11-02' }
  const first = normalizeTimeQuery(input, cfg, NOW)
  const second = normalizeTimeQuery(input, cfg, NOW)
  assert.deepEqual(first, second)
  assert.deepEqual(first.warnings, second.warnings)
})

// ---------------------------------------------------------------------------
// timeFallbackLadder
// ---------------------------------------------------------------------------

test('timeFallbackLadder: a single day widens day3 -> month -> year -> all', () => {
  const cfg = makeCfg()
  const normalized = normalizeTimeQuery({ timeFrom: '2026-10-31' }, cfg, NOW)
  const ladder = timeFallbackLadder(normalized, cfg)
  assert.deepEqual(ladder.map((rung) => rung.widenedTo), ['day3', 'month', 'year', 'all'])
  assert.deepEqual(ladder[0], { from: sh(2026, 10, 30), to: sh(2026, 11, 2), level: 'day', widenedTo: 'day3' })
  assert.deepEqual(ladder[1], { from: sh(2026, 10, 1), to: sh(2026, 11, 1), level: 'month', widenedTo: 'month' })
  assert.deepEqual(ladder[2], { from: sh(2026, 1, 1), to: sh(2027, 1, 1), level: 'year', widenedTo: 'year' })
  assert.deepEqual(ladder[3], { from: null, to: null, level: 'all', widenedTo: 'all' })
  for (const rung of ladder.slice(0, 3)) {
    assert.ok(rung.from <= normalized.from && rung.to >= normalized.to, `rung ${rung.widenedTo} must contain L0`)
  }
})

test('timeFallbackLadder: month level widens to year/all, year level only to all', () => {
  const cfg = makeCfg()
  const monthLadder = timeFallbackLadder(normalizeTimeQuery({ timeFrom: '2026-10' }, cfg, NOW), cfg)
  assert.deepEqual(monthLadder.map((rung) => rung.widenedTo), ['year', 'all'])
  assert.equal(monthLadder[0].from, sh(2026, 1, 1))
  assert.equal(monthLadder[0].to, sh(2027, 1, 1))
  const yearLadder = timeFallbackLadder(normalizeTimeQuery({ timeFrom: '2026' }, cfg, NOW), cfg)
  assert.deepEqual(yearLadder.map((rung) => rung.widenedTo), ['all'])
})

test('timeFallbackLadder: cfg.time.fallback controls which rungs exist and their order', () => {
  const normalized = normalizeTimeQuery({ timeFrom: '2026-10-31' }, makeCfg(), NOW)
  const custom = timeFallbackLadder(normalized, rawCfg({ fallback: ['month', 'all'] }))
  assert.deepEqual(custom.map((rung) => rung.widenedTo), ['month', 'all'])
  const reversed = timeFallbackLadder(normalized, rawCfg({ fallback: ['all', 'day3'] }))
  assert.deepEqual(reversed.map((rung) => rung.widenedTo), ['all', 'day3'])
  const onlyDay3 = timeFallbackLadder(normalized, rawCfg({ fallback: ['day3'] }))
  assert.deepEqual(onlyDay3.map((rung) => rung.widenedTo), ['day3'])
  assert.deepEqual(timeFallbackLadder(normalized, rawCfg({ fallback: [] })), [])
  // Unknown values are filtered out instead of breaking the ladder.
  const filtered = timeFallbackLadder(normalized, rawCfg({ fallback: ['day3', 'bogus', 'all', 'day3'] }))
  assert.deepEqual(filtered.map((rung) => rung.widenedTo), ['day3', 'all'])
})

test('timeFallbackLadder: mode off/index returns only the original window', () => {
  const normalized = normalizeTimeQuery({ timeFrom: '2026-10-31' }, makeCfg(), NOW)
  const off = timeFallbackLadder(normalized, loadConfig(undefined, { time: { mode: 'off' } }))
  assert.deepEqual(off, [{ from: normalized.from, to: normalized.to, level: 'day', widenedTo: null }])
  const indexMode = timeFallbackLadder(normalized, loadConfig())
  assert.deepEqual(indexMode, [{ from: normalized.from, to: normalized.to, level: 'day', widenedTo: null }])
})

test('timeFallbackLadder: wide windows are never narrowed by a rung', () => {
  const cfg = makeCfg()
  const normalized = normalizeTimeQuery({ timeFrom: '2026-10-01', timeTo: '2026-10-20' }, cfg, NOW)
  assert.equal(normalized.level, 'day')
  const ladder = timeFallbackLadder(normalized, cfg)
  // day3 is narrower than the requested 20 day range, so it must be skipped.
  assert.ok(!ladder.some((rung) => rung.widenedTo === 'day3'))
  assert.deepEqual(ladder.map((rung) => rung.widenedTo), ['month', 'year', 'all'])
  for (const rung of ladder) {
    if (rung.level === 'all') continue
    assert.ok(rung.from <= normalized.from && rung.to >= normalized.to)
  }
})

test('timeFallbackLadder: degenerate input degrades to "no constraint" without throwing', () => {
  const cfg = makeCfg()
  const invalid = { from: null, to: null, level: 'all', granularity: 'invalid', center: null, requested: { from: null, to: null }, warnings: [] }
  assert.deepEqual(timeFallbackLadder(invalid, cfg), [{ from: null, to: null, level: 'all', widenedTo: null }])
  assert.deepEqual(timeFallbackLadder(null, cfg), [{ from: null, to: null, level: 'all', widenedTo: null }])
  // A half-open / malformed window cannot be used as a constraint either.
  assert.deepEqual(timeFallbackLadder({ from: Number.NaN, to: 3, level: 'day' }, cfg), [{ from: null, to: null, level: 'all', widenedTo: null }])
  assert.deepEqual(timeFallbackLadder({ from: 1, to: null, level: 'day' }, cfg), [{ from: null, to: null, level: 'all', widenedTo: null }])
})

test('timeFallbackLadder: rungs are valid queryTimeIndex windows that always contain L0', () => {
  const cfg = makeCfg()
  const folders = []
  for (let day = 1; day <= 31; day += 1) folders.push(makeFolder({ createdAt: sh(2026, 10, day, 12, 0, 0) }))
  folders.push(makeFolder({ createdAt: sh(2026, 11, 1, 12, 0, 0) }))
  folders.push(makeFolder({ createdAt: sh(2026, 9, 29, 12, 0, 0) }))
  folders.push(makeFolder({ createdAt: sh(2025, 6, 1, 12, 0, 0) }))
  const index = buildTimeIndex(folders, cfg)
  const normalized = normalizeTimeQuery({ timeFrom: '2026-10-31' }, cfg, NOW)
  const l0 = queryTimeIndex(index, normalized, cfg)
  assert.ok(l0.count > 0)
  for (const rung of timeFallbackLadder(normalized, cfg)) {
    const result = queryTimeIndex(index, rung, cfg)
    if (rung.level === 'all') {
      assert.equal(result.ids, null)
      assert.equal(result.count, index.folderCount)
    } else {
      assert.ok(result.count >= l0.count, `rung ${rung.widenedTo} must not lose L0 matches`)
    }
  }
})

// ---------------------------------------------------------------------------
// Plan A/B oracle fuzz: CSR bucket query vs naive interval scan
// ---------------------------------------------------------------------------

function makeFuzzFolders() {
  const rng = seeded(0x20261101)
  const base = Date.UTC(2024, 0, 1)
  const span = 1400 * DAY
  const folders = []
  for (let i = 0; i < 500; i += 1) {
    const createdAt = base + Math.floor(rng() * span)
    if (i % 3 === 0) {
      const duration = Math.max(1, Math.floor(rng() * 3 * DAY))
      folders.push({
        id: `mem-fuzz-${String(i).padStart(4, '0')}`,
        createdAt,
        eventStart: createdAt,
        eventEnd: createdAt + duration,
        eventTimeSource: i % 6 === 0 ? 'judge' : 'messages',
      })
    } else {
      folders.push({ id: `mem-fuzz-${String(i).padStart(4, '0')}`, createdAt })
    }
  }
  return folders
}

function makeFuzzWindows() {
  const rng = seeded(0x20261102)
  const base = Date.UTC(2024, 0, 1)
  const span = 1400 * DAY
  const windows = []
  for (let i = 0; i < 20; i += 1) {
    const from = base + Math.floor(rng() * span)
    const width = 1 + Math.floor(rng() * 90 * DAY)
    windows.push({ from, to: from + width, level: i % 5 === 0 ? 'month' : 'day' })
  }
  return windows
}

function assertOracleAgreement(timezone) {
  const cfg = makeCfg({ timezone })
  const folders = makeFuzzFolders()
  const index = buildTimeIndex(folders, cfg)
  const windows = makeFuzzWindows()
  for (const window of windows) {
    const planA = queryTimeIndex(index, window, cfg)
    const planB = naiveMatchIds(folders, window)
    assert.deepEqual(sortedIds(planA.ids), sortedIds(planB), `window ${iso(window.from)}..${iso(window.to)} in ${timezone}`)
    assert.equal(planA.count, planB.size)
  }
  // Ladder rungs use the same exact-overlap oracle.
  for (const dateText of ['2026-10-31', '2026-03-08', '2026-11-01', '2025-06-15']) {
    const normalized = normalizeTimeQuery({ timeFrom: dateText }, cfg, NOW)
    for (const rung of timeFallbackLadder(normalized, cfg)) {
      const planA = queryTimeIndex(index, rung, cfg)
      if (rung.level === 'all') {
        assert.equal(planA.ids, null)
        assert.equal(planA.count, folders.length)
        continue
      }
      const planB = naiveMatchIds(folders, rung)
      assert.deepEqual(sortedIds(planA.ids), sortedIds(planB), `ladder rung ${rung.widenedTo} for ${dateText} in ${timezone}`)
    }
  }
  return { folders, windows }
}

test('oracle fuzz: bucket query equals naive interval scan (Asia/Shanghai)', () => {
  const { folders, windows } = assertOracleAgreement(ASIA)
  assert.equal(folders.length, 500)
  assert.equal(windows.length, 20)
})

test('oracle fuzz: bucket query equals naive interval scan (UTC and DST America/New_York)', () => {
  assertOracleAgreement(UTC)
  assertOracleAgreement(NY)
})

// ---------------------------------------------------------------------------
// pure time browsing / integration
// ---------------------------------------------------------------------------

test('time-only browse: a window yields folder ids without any keyword input', () => {
  const cfg = makeCfg()
  const folders = [
    makeFolder({ id: 'mem-browse-a', createdAt: sh(2026, 10, 31, 9, 0, 0), keywords: [] }),
    makeFolder({ id: 'mem-browse-b', createdAt: sh(2026, 10, 31, 21, 0, 0), keywords: [] }),
    makeFolder({ id: 'mem-browse-c', createdAt: sh(2026, 11, 1, 9, 0, 0), keywords: [] }),
  ]
  const index = buildTimeIndex(folders, cfg)
  const day = normalizeTimeQuery({ timeFrom: '2026-10-31' }, cfg, NOW) // no keywords, time only
  const hits = queryTimeIndex(index, day, cfg)
  assert.deepEqual(sortedIds(hits.ids), ['mem-browse-a', 'mem-browse-b'])
  // A browse list can be ordered by eventStart using the indexed ranges.
  const ordered = [...hits.ids].sort((left, right) => index.byId.get(left).start - index.byId.get(right).start)
  assert.deepEqual(ordered, ['mem-browse-a', 'mem-browse-b'])
  // Widening to day3 picks up the next day for a browser.
  const day3 = timeFallbackLadder(day, cfg).find((rung) => rung.widenedTo === 'day3')
  assert.deepEqual(sortedIds(queryTimeIndex(index, day3, cfg).ids), ['mem-browse-a', 'mem-browse-b', 'mem-browse-c'])
})

test('integration: real-shaped legacy folders (no event time) are fully queryable', () => {
  // Mirrors the shape of the 3742 folders in memory/sessions: only createdAt,
  // alpha/beta/keywords/stats/title and no event* field at all.
  const cfg = makeCfg()
  const metas = [
    {
      version: 1,
      id: 'mem-20261031T113607Z-0001',
      createdAt: Date.UTC(2026, 9, 31, 11, 36, 7, 405),
      alpha: 0.85,
      beta: 6,
      scored: true,
      keywords: ['甜食', '口味偏好'],
      stats: { messages: 1, chars: 90, tokens: 29 },
      title: '【当前时间】2026/10/31 19:13:5',
    },
    {
      version: 1,
      id: 'mem-20261031T120808Z-0002',
      createdAt: Date.UTC(2026, 9, 31, 12, 8, 8, 564),
      alpha: 0.1,
      beta: 0,
      scored: true,
      keywords: ['tool-call', '过程日志'],
      stats: { messages: 3, chars: 359, tokens: 426 },
      title: '【当前时间】2026/10/31 19:41:0',
    },
  ]
  const index = buildTimeIndex(metas.map((meta) => indexEntryFromMeta(meta)), cfg)
  for (const entry of index.ranges) assert.equal(entry.source, 'archive')
  const october = normalizeTimeQuery({ timeFrom: '2026-10' }, cfg, NOW)
  assert.equal(queryTimeIndex(index, october, cfg).count, 2)
  const nov = normalizeTimeQuery({ timeFrom: '2026-11' }, cfg, NOW)
  assert.equal(queryTimeIndex(index, nov, cfg).count, 0)
})

// ---------------------------------------------------------------------------
// config integration + performance budget
// ---------------------------------------------------------------------------

test('config: engine DEFAULT_CONFIG.time matches TIME_DEFAULTS exactly', () => {
  assert.deepEqual(DEFAULT_CONFIG.time, { ...TIME_DEFAULTS, fallback: [...TIME_DEFAULTS.fallback] })
  // The packaged product values live in config.json (owner G) — the engine
  // default is 'index' (no behaviour change) per plan §3.3.5/Q2.
  const loaded = loadConfig()
  assert.equal(loaded.time.mode, 'index')
  assert.equal(loaded.time.timezone, '')
  assert.deepEqual(loaded.time.fallback, ['day3', 'month', 'year', 'all'])
})

test('performance: 10k folder build and 3-day query stay inside the relaxed budget', () => {
  const cfg = makeCfg()
  const rng = seeded(0x20261103)
  const base = Date.UTC(2024, 0, 1)
  const folders = []
  for (let i = 0; i < 10000; i += 1) {
    folders.push({ id: `mem-perf-${String(i).padStart(5, '0')}`, createdAt: base + Math.floor(rng() * 730 * DAY) })
  }
  const buildStarted = performance.now()
  const index = buildTimeIndex(folders, cfg)
  const buildMs = performance.now() - buildStarted
  assert.equal(index.folderCount, 10000)
  assert.ok(index.dayKeys.length > 700, `expected >700 day buckets, got ${index.dayKeys.length}`)

  const anchor = normalizeTimeQuery({ timeFrom: '2025-06-15' }, cfg, NOW)
  const runs = 20
  const queryStarted = performance.now()
  let checksum = 0
  for (let i = 0; i < runs; i += 1) {
    const window = { from: anchor.from + i * DAY, to: anchor.to + i * DAY, level: 'day' }
    checksum += queryTimeIndex(index, window, cfg).count
  }
  const queryMs = (performance.now() - queryStarted) / runs
  assert.ok(checksum >= 0)
  // Contract targets: <=20ms build / <=5ms query for N=10000; relaxed 10x for CI.
  console.log(`time-index perf: build 10k = ${buildMs.toFixed(1)}ms (budget 200ms), 3-day query avg = ${queryMs.toFixed(3)}ms (budget 50ms)`)
  assert.ok(buildMs < 200, `buildTimeIndex took ${buildMs.toFixed(1)}ms > 200ms`)
  assert.ok(queryMs < 50, `queryTimeIndex took ${queryMs.toFixed(3)}ms > 50ms`)
})
