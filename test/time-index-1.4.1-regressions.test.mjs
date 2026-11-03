/**
 * v1.4.1 time-index regressions (C-01 DST-at-midnight day boundaries, C-06
 * numeric-time defence warnings).
 *
 * C-01 — a calendar day whose local 00:00 does not exist (DST jump at midnight:
 *        America/Santiago, America/Havana, America/Asuncion, Asia/Beirut) used to
 *        resolve `from` to the *previous* day 23:00 and `to` one wall-clock hour
 *        after the real boundary, so a single-day query returned the wrong day.
 *        The zoned day boundary is now "the first existing instant of that civil
 *        day", and the window end is the next real day boundary.
 * C-06 — a compact `YYYYMMDD` date or a 10-digit seconds timestamp is still
 *        parsed as epoch milliseconds (documented semantics), but now emits a
 *        targeted warning instead of only the generic "no granularity" hint.
 *
 * The expected boundary is computed by an independent `Intl` oracle in this
 * file (minute scan over the civil-date predicate), not by the module itself.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_CONFIG, loadConfig } from '../engine/config.js'
import { normalizeTimeQuery } from '../engine/time-index.js'

const formatterCache = new Map()
function dayOf(ms, timeZone) {
  let formatter = formatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatterCache.set(timeZone, formatter)
  }
  const parts = formatter.formatToParts(new Date(ms))
  const get = (type) => parts.find((part) => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Independent oracle: first existing instant of a civil day (minute scan). */
function oracleDayStart(target, timeZone) {
  const [year, month, day] = target.split('-').map(Number)
  const base = Date.UTC(year, month - 1, day)
  for (let offset = -15 * 60; offset <= 15 * 60; offset += 1) {
    const ms = base + offset * 60000
    if (dayOf(ms, timeZone) === target) return ms
  }
  throw new Error(`oracle: day ${target} not found in ${timeZone}`)
}

function cfgFor(timezone) {
  return loadConfig(undefined, { time: { timezone } })
}

const CASES = [
  ['America/Santiago', '2026-09-06'],
  ['America/Havana', '2026-03-08'],
  ['America/Asuncion', '2026-10-04'],
  ['Asia/Beirut', '2026-03-29'],
]

test('C-01: single-day windows start at the first existing instant of the civil day (DST at midnight)', () => {
  for (const [timezone, day] of CASES) {
    const cfg = cfgFor(timezone)
    const normalized = normalizeTimeQuery({ timeFrom: day }, cfg, Date.now())
    assert.equal(normalized.level, 'day', `${timezone}: level`)
    const [year, month, date] = day.split('-').map(Number)
    const nextDay = new Date(Date.UTC(year, month - 1, date + 1))
    const nextKey = `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDay.getUTCDate()).padStart(2, '0')}`
    const expectedFrom = oracleDayStart(day, timezone)
    const expectedTo = oracleDayStart(nextKey, timezone)
    assert.equal(normalized.from, expectedFrom, `${timezone} ${day}: from must be the first instant of the day`)
    assert.equal(normalized.to, expectedTo, `${timezone} ${day}: to must be the next day boundary`)
    assert.ok(normalized.to > normalized.from, `${timezone} ${day}: non-empty half-open window`)
    // The old bug made `from` fall on the *previous* civil day.
    assert.equal(dayOf(normalized.from, timezone), day, `${timezone}: from is on the requested day`)
    assert.equal(dayOf(normalized.to - 1, timezone), day, `${timezone}: window ends exactly at the day end`)
  }
})

test('C-01: epoch + granularity=day uses the same zoned day boundary', () => {
  for (const [timezone, day] of CASES) {
    const cfg = cfgFor(timezone)
    const noonUtc = oracleDayStart(day, timezone) + 6 * 3600 * 1000
    const normalized = normalizeTimeQuery({ timeFrom: noonUtc, granularity: 'day' }, cfg, Date.now())
    assert.equal(normalized.from, oracleDayStart(day, timezone), `${timezone} ${day}: epoch day start`)
    assert.ok(normalized.to > normalized.from)
  }
})

test('C-01: the DST-at-midnight window actually selects that day (false positive/negative check)', () => {
  // A folder at the previous day's last wall-clock hour must not be in the window,
  // and a folder at the requested day's last hour must be in it.
  for (const [timezone, day] of CASES) {
    const cfg = cfgFor(timezone)
    const normalized = normalizeTimeQuery({ timeFrom: day }, cfg, Date.now())
    const prevTail = oracleDayStart(day, timezone) - 30 * 60 * 1000
    const dayTail = normalized.to - 30 * 60 * 1000
    assert.equal(dayOf(prevTail, timezone) === day, false, `${timezone}: fixture sanity (previous tail)`)
    assert.equal(dayOf(dayTail, timezone), day, `${timezone}: fixture sanity (day tail)`)
    assert.ok(prevTail < normalized.from, `${timezone}: previous day 23:30 is outside the window`)
    assert.ok(dayTail >= normalized.from && dayTail < normalized.to, `${timezone}: day 23:30 is inside the window`)
  }
})

test('C-01: a whole skipped civil day degrades to a non-empty window after the gap', () => {
  // Pacific/Apia skipped 2011-12-30 entirely (UTC-10 → UTC+14).
  const cfg = loadConfig(undefined, { time: { timezone: 'Pacific/Apia' } })
  const normalized = normalizeTimeQuery({ timeFrom: '2011-12-30' }, cfg, Date.UTC(2012, 0, 1))
  assert.ok(Number.isFinite(normalized.from) && Number.isFinite(normalized.to), 'finite window')
  assert.ok(normalized.to > normalized.from, 'the window must never be zero-width')
})

// ---------------------------------------------------------------------------
// C-06 — numeric-input defence warnings
// ---------------------------------------------------------------------------

test('C-06: YYYYMMDD and seconds timestamps get targeted warnings (semantics unchanged)', () => {
  const cfg = loadConfig(undefined, {})
  const compactDate = normalizeTimeQuery({ timeFrom: '20261102' }, cfg, Date.UTC(2026, 10, 2))
  assert.ok(
    compactDate.warnings.some((warning) => /looks like YYYYMMDD/.test(warning)),
    JSON.stringify(compactDate.warnings),
  )
  // Documented semantics stay: numeric input is epoch milliseconds (1970-ish here).
  assert.ok(compactDate.from < Date.UTC(2000, 0, 1), 'still parsed as epoch ms, not as 2026-11-02')

  const seconds = normalizeTimeQuery({ timeFrom: '1793446567' }, cfg, Date.UTC(2026, 10, 2))
  assert.ok(seconds.warnings.some((warning) => /seconds timestamp/.test(warning)), JSON.stringify(seconds.warnings))
  assert.ok(seconds.from < Date.UTC(2000, 0, 1))

  // Real epoch milliseconds (13 digits) and calendar text stay warning-free.
  const ms = normalizeTimeQuery({ timeFrom: Date.UTC(2026, 9, 31, 4) }, cfg, Date.UTC(2026, 10, 2))
  assert.ok(!ms.warnings.some((warning) => /looks like/.test(warning)), JSON.stringify(ms.warnings))
  const text = normalizeTimeQuery({ timeFrom: '2026-10-31' }, cfg, Date.UTC(2026, 10, 2))
  assert.deepEqual(text.warnings, [])
})

test('C-06: DEFAULT_CONFIG timezone is host local and the hints never throw on garbage', () => {
  assert.equal(typeof DEFAULT_CONFIG.time.timezone, 'string')
  for (const value of [null, undefined, {}, [], Number.NaN, Infinity, 'garbage', 0]) {
    assert.doesNotThrow(() => normalizeTimeQuery({ timeFrom: value }, loadConfig(undefined, {}), Date.UTC(2026, 10, 2)))
  }
})
