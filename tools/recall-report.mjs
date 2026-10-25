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
import { formatReport, summarizeStats } from '../engine/stats.js'

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
`

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
  const stats = { rearchiveEvents: 0, rearchivedFolders: 0, rearchivedTokens: 0, pendingCreated: 0 }
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'rearchive') {
      stats.rearchiveEvents += 1
      if (Array.isArray(event.removedIds)) stats.rearchivedFolders += event.removedIds.length
      if (Number.isFinite(event.removedTokens)) stats.rearchivedTokens += event.removedTokens
    } else if (event.type === 'compress-applied' && Array.isArray(event.folderMetadata)) {
      for (const entry of event.folderMetadata) {
        if (entry && entry.scored === false) stats.pendingCreated += 1
      }
    }
  }
  return stats
}

/** Two aligned lines for re-archive + pending counts. */
function formatWorkLines(stats) {
  return (
    `${'re-archive events'.padEnd(24)}: ${stats.rearchiveEvents}, recalled folders removed: ${stats.rearchivedFolders}, tokens: ${stats.rearchivedTokens}\n` +
    `${'pending folders created'.padEnd(24)}: ${stats.pendingCreated} (awaiting memory_judge)\n`
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

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        { memoryDir, statsDirs, eventCount: events.length, summary, workStats: work, betaStats: beta },
        null,
        2,
      ) + '\n',
    )
  } else {
    process.stdout.write(formatReport(summary))
    process.stdout.write(formatWorkLines(work))
    process.stdout.write(formatBetaLine(beta))
    if (events.length === 0) {
      process.stderr.write(
        `hint: no telemetry events yet in ${statsDirs.length} stats file(s) under ${memoryDir} (run the engine/simulation first)\n`,
      )
    }
  }
  return 0
}

process.exitCode = main()
