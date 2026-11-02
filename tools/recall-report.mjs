#!/usr/bin/env node
/**
 * dsh-rofm — test-phase report tool (docs/SPEC.md §9).
 *
 * Reads telemetry and prints how much context was added back by the recall
 * feature, in characters and as a percentage of the current context. It also
 * aggregates the β (trust) scores recorded on recall telemetry (`added[].beta`)
 * into a mean + distribution line; β never affects the recall probability.
 * With the current-model scoring architecture it additionally reports
 * re-archive events (recalled folders removed from the injected block and
 * marked `rescorePending`) and how many newly archived folders landed pending
 * (`scored:false`, awaiting `memory_judge`).
 *
 * With the default per-session storage layout the telemetry lives in
 * `memory/sessions/<session-id>/stats.jsonl`, so by default this tool aggregates
 * every session directory (plus the legacy global `memory/stats.jsonl`).
 *
 * v1.4.0 additions (contract §7, plan §2.2):
 *   - lane distribution from recall telemetry (`lanesPicked`, registerDrops,
 *     degraded, reInjections, mode);
 *   - time-filter effectiveness (`timeFiltered`, `timeWindow`, `widenedTo`,
 *     `missType`, `hasMore`);
 *   - pending data-era statistics (legacy / synthetic / current) reusing
 *     `tools/memory-audit.mjs`, whose classification delegates to the shared
 *     `engine/era.js` truth. The era fields are reported side by side
 *     (`era` = session level, `dominantEra` = folder bucket) and never merged:
 *     `legacy` is a per-folder property, so a pre-1.2.0 session has
 *     sessionEra=current + dominantEra=legacy.
 * Old (≤1.3.0) telemetry has none of the v1.4.0 fields: those lines print
 * `n/a` instead of failing, and the pending-era block still works because it
 * reads the index, not telemetry.
 *
 *   node tools/recall-report.mjs [--dir memory] [--config config.json]
 *                                [--last N] [--json] [--help]
 *
 * The report math lives in engine/stats.js (`summarizeStats`), so this file is a
 * thin, zero-dependency printer; it never imports DeepSeek Harness.
 */

import fs from 'node:fs'
import path from 'node:path'
import { defaultConfigPath, loadConfig, resolveMemoryDir } from '../engine/config.js'
import { memoryPaths, readStats } from '../engine/store.js'
import { formatReport, roundNumber, summarizeStats } from '../engine/stats.js'
import { invokedAsMain } from './main-module.mjs'
import { auditMemory } from './memory-audit.mjs'

/** The documented v1.4.0 recall lanes, in FAIR-DRI selection order (§5.1). */
export const RECALL_LANES = Object.freeze(['rareHigh', 'queryBoost', 'register', 'hi', 'lowProbe', 'rotation', 'recycle'])

const USAGE = `dsh-rofm report tool (zero dependencies)

Usage:
  node tools/recall-report.mjs [options]

Options:
  --dir <path>       exact memory directory to read (default: resolved from
                     config.storage.dir, aggregating memory/sessions/<id>/)
  --config <path>    config.json to load (default: ./config.json when present)
  --last <N>         only the last N telemetry events (by time)
  --json             machine-readable JSON instead of the text report
  -h, --help         show this help

The report shows: recall events, context chars, chars added back, context added
back %, window tokens added %, folders added by generation, compression events,
chars moved to memory and average recall latency. It also prints re-archive
statistics (recalled folders removed from the injected block and marked
rescorePending; no new folders) and how many newly archived folders landed
pending (awaiting the current model's memory_judge call). When recall telemetry
carries β it prints β (trust) statistics: how many recalled memories were
scored, their mean β and the β≥7 / 0≤β<7 / β<0 distribution (β is metadata for
the reading model and never affects the recall probability).

v1.4.0 lines (printed after the β line): \`lanes (v1.4.0)\` (lanesPicked
distribution, registerDrops/degraded/reInjections, recall modes), \`time filter\`
(timeFiltered, timeWindow/widenedTo, missType, hasMore), \`event filter\` (the
event-constraint telemetry: eventStatus distribution, eventFiltered total and the
most frequent eventLabel) and \`pending era\` (legacy / synthetic / current
folders+pending; current is the actionable number, e.g. 2/369 = 0.54%). Old
≤1.3.0 telemetry prints n/a on the lane/time/event lines; the pending-era block
reads index.json so it always works. --json adds the keys laneStats, timeStats,
eventStats and pendingEras.`

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      if (arg === '-h') {
        flags.help = true
        continue
      }
      throw new Error(`unknown argument: ${arg}`)
    }
    const equals = arg.indexOf('=')
    if (equals >= 0) {
      flags[arg.slice(2, equals)] = arg.slice(equals + 1)
      continue
    }
    const key = arg.slice(2)
    if (key === 'help') {
      flags.help = true
      continue
    }
    if (key === 'json') {
      flags.json = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value`)
    flags[key] = value
    index += 1
  }
  return flags
}

/**
 * Telemetry directories to read.
 *
 * `--dir` means exactly that directory (so a single session dir can be reported).
 * By default the per-session layout is aggregated: `memory/sessions/<id>/` each
 * hold their own stats file, and the legacy global `memory/stats.jsonl` (0.1.x)
 * is included when present.
 */
function statsDirsFor(memoryDir, cfg) {
  const dirs = []
  if (fs.existsSync(memoryPaths(memoryDir, cfg).statsPath)) dirs.push(memoryDir)
  let entries = []
  try {
    entries = fs.readdirSync(path.join(memoryDir, 'sessions'), { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(memoryDir, 'sessions', entry.name)
    if (fs.existsSync(memoryPaths(dir, cfg).statsPath)) dirs.push(dir)
  }
  return dirs
}

function readOrderedStats(dirs, cfg) {
  const ordered = []
  let index = 0
  for (const dir of dirs) {
    for (const event of readStats(dir, cfg)) {
      ordered.push({ event, index })
      index += 1
    }
  }
  ordered.sort((a, b) => (Number(a.event.time) || 0) - (Number(b.event.time) || 0) || a.index - b.index)
  return ordered.map((entry) => entry.event)
}

/**
 * β (trust) aggregate from recall telemetry (`added[].beta`).
 *
 * β is model-judged per archived folder and is metadata for the reading
 * model — it never participates in the recall probability — so the aggregate
 * lives in this tool instead of `engine/stats.js`. Events without a numeric β
 * (older telemetry) are ignored; no β data at all prints `n/a`.
 */
function betaStats(events) {
  const values = []
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'recall' || !Array.isArray(event.added)) continue
    for (const entry of event.added) {
      // Only a real numeric β counts: JSON null would coerce to 0 through
      // Number(null), wrongly turning "no β data" into "β = 0".
      const beta = entry && typeof entry.beta === 'number' ? entry.beta : NaN
      if (Number.isFinite(beta)) values.push(beta)
    }
  }
  if (values.length === 0) return { n: 0, mean: null, aboveOrEqual7: 0, between0And7: 0, negative: 0 }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    n: values.length,
    mean: Number(mean.toFixed(2)),
    aboveOrEqual7: values.filter((value) => value >= 7).length,
    between0And7: values.filter((value) => value >= 0 && value < 7).length,
    negative: values.filter((value) => value < 0).length,
  }
}

/** One aligned line for the text report (fixed label width, like §9). */
function formatBetaLine(stats) {
  const label = 'beta (trust)'.padEnd(23) + ': '
  if (!stats || stats.n === 0) return `${label}n/a (no recall telemetry with β yet)\n`
  const mean = Number.isFinite(stats.mean) ? `${stats.mean > 0 ? '+' : ''}${stats.mean.toFixed(2)}` : 'n/a'
  return (
    `${label}n=${stats.n}, mean=${mean}, β≥7: ${stats.aboveOrEqual7}, ` +
    `0≤β<7: ${stats.between0And7}, β<0: ${stats.negative}\n`
  )
}

/**
 * Re-archive + pending-work aggregate (current-model scoring architecture).
 *
 * `rearchive` events record the oldest recalled folders that were removed from
 * the injected block and marked `_rescorePending_` (no new folders are written
 * for them). `compress-applied` events record newly archived conversational
 * folders, which land pending (`scored:false`) until the current model submits
 * `memory_judge`; there is no telemetry event for the judge call itself, so
 * only the creation count is reported here.
 */
function workStats(events) {
  const stats = {
    rearchiveEvents: 0,
    rearchivedFolders: 0,
    rearchivedTokens: 0,
    pendingCreated: 0,
    // v1.2: archived images (`compress-applied.folderMetadata[].images`) and the
    // pinned host-context nodes merged into the checkpoint note instead of being
    // silently shadowed (`pinnedShadowed` / `pinnedChars`). v1.2 adds the
    // checkpoint-note merge counters (`mergedCheckpoints`, cumulative
    // `archiveSegments`) and `pinnedRecorded` (only one-shot notices are copied
    // into the note; re-injected host context is dropped).
    archivedImages: 0,
    pinnedShadowed: 0,
    pinnedRecorded: 0,
    pinnedChars: 0,
    mergedCheckpoints: 0,
    archiveSegments: 0,
  }
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'rearchive') {
      stats.rearchiveEvents += 1
      if (Array.isArray(event.removedIds)) stats.rearchivedFolders += event.removedIds.length
      if (Number.isFinite(event.removedTokens)) stats.rearchivedTokens += event.removedTokens
    } else if (event.type === 'compress-applied') {
      if (Number.isFinite(event.pinnedShadowed)) stats.pinnedShadowed += event.pinnedShadowed
      if (Number.isFinite(event.pinnedRecorded)) stats.pinnedRecorded += event.pinnedRecorded
      if (Number.isFinite(event.pinnedChars)) stats.pinnedChars += event.pinnedChars
      if (Number.isFinite(event.mergedCheckpoints)) stats.mergedCheckpoints += event.mergedCheckpoints
      // Cumulative per archive, so the latest event carries the current total.
      if (Number.isFinite(event.archiveSegments)) stats.archiveSegments = Math.max(stats.archiveSegments, event.archiveSegments)
      if (!Array.isArray(event.folderMetadata)) continue
      for (const entry of event.folderMetadata) {
        if (entry && entry.scored === false) stats.pendingCreated += 1
        if (entry && Number.isFinite(entry.images)) stats.archivedImages += entry.images
      }
    }
  }
  return stats
}

/** Aligned lines for re-archive + pending + v1.2/v1.2 image/pinned/note counters. */
function formatWorkLines(stats) {
  return (
    `${'re-archive events'.padEnd(24)}: ${stats.rearchiveEvents}, recalled folders removed: ${stats.rearchivedFolders}, tokens: ${stats.rearchivedTokens}\n` +
    `${'pending folders created'.padEnd(24)}: ${stats.pendingCreated} (awaiting memory_judge)\n` +
    `${'archived images'.padEnd(24)}: ${stats.archivedImages} (copied to images/)\n` +
    `${'pinned context merged'.padEnd(24)}: ${stats.pinnedRecorded} recorded / ${stats.pinnedShadowed} shadowed, ${stats.pinnedChars} chars (into checkpoint notes)\n` +
    `${'checkpoint notes merged'.padEnd(24)}: ${stats.mergedCheckpoints} previous note(s), latest cumulative segments: ${stats.archiveSegments}\n`
  )
}

// ---------------------------------------------------------------------------
// v1.4.0: lane distribution / time filter / pending era (contract §7, plan §2.2)
// ---------------------------------------------------------------------------

/** `key=count` text of one counter object (sorted keys); 'none' when empty. */
function counterText(counter) {
  const keys = Object.keys(counter || {}).sort()
  return keys.length === 0 ? 'none' : keys.map((key) => `${key}=${counter[key]}`).join(', ')
}

/** Lanes that count as high-α injections for the guarantee share. */
const HIGH_ALPHA_LANES = new Set(['rareHigh', 'queryBoost', 'register', 'hi'])

/**
 * Lane distribution from v1.4.0 recall telemetry (`lanesPicked`, contract §7).
 *
 * Telemetry written by ≤1.3.0 carries no lane object: those events are skipped
 * and the line prints `n/a` instead of failing (the upgrade must not break the
 * report). `registerDrops`/`degraded` are guarantee-degradation counters and are
 * surfaced because they signal lane/ledger pressure.
 *
 * @param {object[]} events telemetry events (already time-ordered/filtered)
 */
export function laneStats(events) {
  const stats = {
    events: 0,
    lanes: Object.fromEntries(RECALL_LANES.map((lane) => [lane, 0])),
    picks: 0,
    meanPicks: null,
    highAlphaLaneShare: null,
    registerDropEvents: 0,
    registerDrops: 0,
    degradedEvents: 0,
    reInjections: 0,
    modes: {},
  }
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || event.type !== 'recall') continue
    if (!event.lanesPicked || typeof event.lanesPicked !== 'object') continue
    stats.events += 1
    for (const lane of RECALL_LANES) {
      const value = event.lanesPicked[lane]
      if (Number.isFinite(value) && value > 0) stats.lanes[lane] += value
    }
    if (Number.isFinite(event.registerDrops) && event.registerDrops > 0) {
      stats.registerDropEvents += 1
      stats.registerDrops += event.registerDrops
    }
    if (event.degraded === true) stats.degradedEvents += 1
    if (Number.isFinite(event.reInjections) && event.reInjections > 0) stats.reInjections += event.reInjections
    if (typeof event.mode === 'string' && event.mode) stats.modes[event.mode] = (stats.modes[event.mode] || 0) + 1
  }
  if (stats.events > 0) {
    stats.picks = RECALL_LANES.reduce((sum, lane) => sum + stats.lanes[lane], 0)
    stats.meanPicks = stats.picks > 0 ? roundNumber(stats.picks / stats.events) : null
    if (stats.picks > 0) {
      const highPicks = RECALL_LANES.filter((lane) => HIGH_ALPHA_LANES.has(lane)).reduce((sum, lane) => sum + stats.lanes[lane], 0)
      stats.highAlphaLaneShare = roundNumber((highPicks / stats.picks) * 100)
    }
  }
  return stats
}

/**
 * Time-filter effectiveness from v1.4.0 recall telemetry (contract §7):
 * how many events applied a time window, how many candidates it removed
 * (`timeFiltered`), which fallback rung was used (`widenedTo`), and how often a
 * miss was typed as `time` vs `keyword`.
 *
 * @param {object[]} events telemetry events
 */
export function timeStats(events) {
  const stats = {
    events: 0,
    timeFilteredEvents: 0,
    timeFilteredTotal: 0,
    timeWindowEvents: 0,
    widenedTo: {},
    missTypes: {},
    hasMoreEvents: 0,
  }
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || event.type !== 'recall') continue
    const hasFields =
      event.timeFiltered !== undefined || event.timeWindow !== undefined || typeof event.missType === 'string'
    if (!hasFields) continue
    stats.events += 1
    if (Number.isFinite(event.timeFiltered)) {
      stats.timeFilteredTotal += event.timeFiltered
      if (event.timeFiltered > 0) stats.timeFilteredEvents += 1
    }
    if (event.timeWindow && typeof event.timeWindow === 'object') {
      stats.timeWindowEvents += 1
      const widened = event.timeWindow.widenedTo
      if (typeof widened === 'string' && widened) stats.widenedTo[widened] = (stats.widenedTo[widened] || 0) + 1
    }
    if (typeof event.missType === 'string' && event.missType) {
      stats.missTypes[event.missType] = (stats.missTypes[event.missType] || 0) + 1
    }
    if (event.hasMore === true) stats.hasMoreEvents += 1
  }
  return stats
}

/**
 * Event-constraint telemetry from v1.4.0 recall events (contract §7 / §6.9):
 * the `eventStatus` distribution (`absent`/`empty`/`exact`/`similar`/`unknown`/
 * `disabled`), how many candidates the event constraint removed
 * (`eventFiltered`), and the most frequent `eventLabel` (the canonical event the
 * recall was scoped to). Telemetry from ≤1.3.0 has none of these fields → the
 * line prints n/a.
 *
 * @param {object[]} events telemetry events (already time-ordered/filtered)
 */
export function eventStats(events) {
  const stats = {
    events: 0,
    statuses: {},
    filteredEvents: 0,
    filteredTotal: 0,
    labels: {},
    topLabel: null,
  }
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || event.type !== 'recall') continue
    const hasFields =
      event.eventStatus !== undefined || event.eventFiltered !== undefined || event.eventLabel !== undefined
    if (!hasFields) continue
    stats.events += 1
    if (typeof event.eventStatus === 'string' && event.eventStatus) {
      stats.statuses[event.eventStatus] = (stats.statuses[event.eventStatus] || 0) + 1
    }
    if (Number.isFinite(event.eventFiltered)) {
      stats.filteredTotal += event.eventFiltered
      if (event.eventFiltered > 0) stats.filteredEvents += 1
    }
    if (typeof event.eventLabel === 'string' && event.eventLabel) {
      stats.labels[event.eventLabel] = (stats.labels[event.eventLabel] || 0) + 1
    }
  }
  let topLabel = null
  for (const [label, count] of Object.entries(stats.labels)) {
    if (topLabel === null || count > topLabel.count || (count === topLabel.count && label < topLabel.label)) {
      topLabel = { label, count }
    }
  }
  stats.topLabel = topLabel
  return stats
}

/**
 * Pending data-era statistics for the memory dir, reusing `tools/memory-audit.mjs`
 * (whose classification delegates to the shared `engine/era.js`). Both era views
 * stay separate: the audit session entry carries `era` (session level) and
 * `dominantEra` (folder bucket) — `legacy` is a per-folder property.
 *
 * @param {string} memoryDir
 */
export function pendingEraStats(memoryDir) {
  const audit = auditMemory(memoryDir)
  return {
    memoryDir: audit.memoryDir,
    layout: audit.layout,
    stores: audit.totals.stores,
    sessions: audit.totals.sessions,
    totals: audit.totals,
    buckets: audit.buckets,
    calibers: { A: audit.calibers.A, B: audit.calibers.B, C: audit.calibers.C, D: audit.calibers.D },
    currentPending: audit.currentPending,
    warnings: audit.warnings,
  }
}

/** Aligned lane line (v1.4.0). */
export function formatLaneLine(stats) {
  const label = 'lanes (v1.4.0)'.padEnd(23) + ': '
  if (!stats || stats.events === 0) return `${label}n/a (no v1.4.0 recall telemetry yet)\n`
  const lanes = RECALL_LANES.map((lane) => `${lane}=${stats.lanes[lane]}`).join('/')
  return (
    `${label}${stats.events} event(s), picks=${stats.picks} (mean ${stats.meanPicks ?? 'n/a'}), ${lanes}; ` +
    `highAlphaLaneShare=${stats.highAlphaLaneShare ?? 'n/a'}%, registerDrops>0 ${stats.registerDropEvents} (total ${stats.registerDrops}), ` +
    `degraded ${stats.degradedEvents}, reInjections ${stats.reInjections}, modes ${counterText(stats.modes)}\n`
  )
}

/** Aligned time-filter line (v1.4.0). */
export function formatTimeLine(stats) {
  const label = 'time filter'.padEnd(23) + ': '
  if (!stats || stats.events === 0) return `${label}n/a (no v1.4.0 recall telemetry yet)\n`
  return (
    `${label}${stats.events} event(s), timeFiltered>0 ${stats.timeFilteredEvents} (total ${stats.timeFilteredTotal}), ` +
    `timeWindow ${stats.timeWindowEvents}, widenedTo ${counterText(stats.widenedTo)}, ` +
    `missType ${counterText(stats.missTypes)}, hasMore ${stats.hasMoreEvents}\n`
  )
}

/** Aligned event-filter line (v1.4.0 event constraint). */
export function formatEventLine(stats) {
  const label = 'event filter'.padEnd(23) + ': '
  if (!stats || stats.events === 0) return `${label}n/a (no v1.4.0 event telemetry yet)\n`
  const top = stats.topLabel ? `${stats.topLabel.label}=${stats.topLabel.count}` : 'none'
  return (
    `${label}${stats.events} event(s), eventStatus ${counterText(stats.statuses)}, ` +
    `eventFiltered>0 ${stats.filteredEvents} (total ${stats.filteredTotal}), top eventLabel ${top}\n`
  )
}

/** Aligned pending-era lines (from the shared engine/era.js buckets). */
export function formatPendingEraLines(pending) {
  const label = 'pending era'.padEnd(23) + ': '
  if (!pending || !pending.totals || pending.totals.folders === 0) {
    return `${label}n/a (no archived folders under the memory dir)\n`
  }
  const b = pending.buckets
  const pct = (value) => (Number.isFinite(value) ? `${value.toFixed(2)}%` : 'n/a')
  return (
    `${label}legacy ${b.legacy.folders} folders / ${b.legacy.pending} pending; ` +
    `synthetic ${b.synthetic.folders} folders / ${b.synthetic.pending} pending; ` +
    `current ${b.current.folders} folders / ${b.current.pending} pending = ${pct(pending.totals.currentPendingPercent)}\n` +
    `${''.padEnd(23)}  all-stock ${pending.totals.pending}/${pending.totals.folders} = ${pct(pending.totals.pendingPercent)}; ` +
    `C current-real ${pending.calibers.C.pending}/${pending.calibers.C.folders} = ${pct(pending.calibers.C.pendingPercent)}; ` +
    `D normal 1.3.0+ ${pending.calibers.D.pending}/${pending.calibers.D.folders} = ${pct(pending.calibers.D.pendingPercent)} ` +
    `(legacy is per-folder; current-real pending = ${Array.isArray(pending.currentPending) ? pending.currentPending.length : 0} id(s))\n`
  )
}

function main() {
  let flags
  try {
    flags = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${USAGE}`)
    return 1
  }
  if (flags.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const cwd = process.cwd()
  let configPath = typeof flags.config === 'string' ? path.resolve(cwd, flags.config) : null
  if (!configPath) {
    const shared = defaultConfigPath()
    if (fs.existsSync(shared)) configPath = shared
  }
  const cfg = loadConfig(configPath)
  const explicitDir = typeof flags.dir === 'string'
  const memoryDir = explicitDir ? path.resolve(cwd, flags.dir) : resolveMemoryDir(cfg)
  const statsDirs = explicitDir
    ? (fs.existsSync(memoryPaths(memoryDir, cfg).statsPath) ? [memoryDir] : [])
    : statsDirsFor(memoryDir, cfg)

  let last = 0
  if (flags.last !== undefined) {
    last = Number(flags.last)
    if (!Number.isInteger(last) || last <= 0) {
      process.stderr.write('error: --last must be a positive integer\n')
      return 1
    }
  }

  let events = readOrderedStats(statsDirs, cfg)
  if (last > 0) events = events.slice(-last)
  const summary = summarizeStats(events)
  const beta = betaStats(events)
  const work = workStats(events)
  const lanes = laneStats(events)
  const timeFilter = timeStats(events)
  const eventFilter = eventStats(events)
  const pendingEras = pendingEraStats(memoryDir)

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          memoryDir,
          statsDirs,
          eventCount: events.length,
          summary,
          workStats: work,
          betaStats: beta,
          laneStats: lanes,
          timeStats: timeFilter,
          eventStats: eventFilter,
          pendingEras,
        },
        null,
        2,
      ) + '\n',
    )
  } else {
    process.stdout.write(formatReport(summary))
    process.stdout.write(formatWorkLines(work))
    process.stdout.write(formatBetaLine(beta))
    process.stdout.write(formatLaneLine(lanes))
    process.stdout.write(formatTimeLine(timeFilter))
    process.stdout.write(formatEventLine(eventFilter))
    process.stdout.write(formatPendingEraLines(pendingEras))
    if (events.length === 0) {
      process.stderr.write(
        `hint: no telemetry events yet in ${statsDirs.length} stats file(s) under ${memoryDir} (run the engine/simulation first)\n`,
      )
    }
  }
  return 0
}

const invokedDirectly = invokedAsMain(import.meta.url)

if (invokedDirectly) {
  process.exitCode = main()
}
