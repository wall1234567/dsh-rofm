#!/usr/bin/env node
/**
 * Read-only time view — list the archived memory folders of a time window.
 *
 * Usage:
 *   node tools/time-view.mjs --memory <dir> --from 2026-10-31
 *   node tools/time-view.mjs --memory <dir> --from 2026-10-31 --to 2026-11-01
 *   node tools/time-view.mjs --memory memory/sessions/session-<id> --from 2026-10 --json
 *
 * `--memory` accepts either a per-session memory directory (one containing
 * `index.json`) or the plugin memory root (one containing `sessions/<id>/`);
 * every session with an index is scanned.
 *
 * Matching rule (docs/SPEC.md §6.8): a folder covers the half-open folder-event
 * interval `[start, end)` (`[eventStart, eventEnd)` when the folder carries
 * event times, otherwise its archive time `[createdAt, createdAt+1)`) and the
 * requested window is `[from, to)`; the folder is listed when the two intervals
 * overlap. Day/month/year boundaries use the IANA time zone from `--timezone`
 * (default: the plugin `config.json` value, else host local time).
 *
 * The index is derived in memory from `index.json` on every run: nothing is
 * written, moved or created — this tool is strictly read-only. It is not part of
 * the plugin runtime and has no dependency outside `node:` builtins plus the
 * repository's `engine/` modules.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildTimeIndex,
  defaultConfigPath,
  formatWindow,
  loadConfig,
  normalizeTimeQuery,
  queryTimeIndex,
  readIndex,
} from '../engine/index.js'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `Usage:
  node tools/time-view.mjs --memory <dir> --from <time> [--to <time>] [options]

  --memory <dir>      memory directory to read (a session directory containing
                      index.json, or the plugin memory/ root with sessions/*/)
  --from <time>       window start: 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY' | epoch ms
  --to <time>         window end (same forms; omit for the --from unit window)
  --granularity <g>   'day' | 'month' | 'year' (disambiguates epoch input)
  --timezone <tz>     IANA time zone for calendar boundaries (default: the
                      plugin config.json value, else host local time)
  --limit <n>         maximum folders to print (default 200)
  --json              machine-readable output
  -h, --help          show this help

The window is matched against folder event intervals with the half-open
overlap rule start < window.to && end > window.from. Folders without event
times fall back to their archive time (createdAt). Read-only: this tool never
writes to the memory directory.
`

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    help: false,
    json: false,
    memory: '',
    from: undefined,
    to: undefined,
    granularity: undefined,
    timezone: undefined,
    limit: 200,
  }
  const valueFlags = new Set(['--memory', '--from', '--to', '--granularity', '--timezone', '--limit'])
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    const flag = raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : raw
    const inline = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : undefined
    if (flag === '-h' || flag === '--help') {
      options.help = true
      continue
    }
    if (flag === '--json') {
      options.json = true
      continue
    }
    let value = inline
    if (valueFlags.has(flag) && value === undefined) {
      value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`option ${flag} requires a value`)
      index += 1
    }
    switch (flag) {
      case '--memory':
        options.memory = value
        break
      case '--from':
        options.from = value
        break
      case '--to':
        options.to = value
        break
      case '--granularity':
        options.granularity = value
        break
      case '--timezone':
        options.timezone = value
        break
      case '--limit': {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`--limit expects a positive integer, got ${JSON.stringify(value)}`)
        options.limit = parsed
        break
      }
      default:
        throw new UsageError(`unknown option: ${raw}`)
    }
  }
  return options
}

/** All (label, directory) pairs that own an `index.json` under `memoryDir`. */
function resolveCollections(memoryDir) {
  const collections = []
  if (!fs.existsSync(memoryDir)) throw new UsageError(`--memory directory does not exist: ${memoryDir}`)
  if (fs.existsSync(path.join(memoryDir, 'index.json'))) {
    collections.push({ label: '', dir: memoryDir })
    return collections
  }
  const sessionsDir = path.join(memoryDir, 'sessions')
  if (fs.existsSync(sessionsDir)) {
    let dirents = []
    try {
      dirents = fs.readdirSync(sessionsDir, { withFileTypes: true })
    } catch {
      dirents = []
    }
    for (const dirent of dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
      const dir = path.join(sessionsDir, dirent.name)
      if (fs.existsSync(path.join(dir, 'index.json'))) collections.push({ label: dirent.name, dir })
    }
    if (collections.length > 0) return collections
  }
  throw new UsageError(`--memory directory has neither index.json nor sessions/*/index.json: ${memoryDir}`)
}

function loadBaseConfig() {
  for (const candidate of [defaultConfigPath(), path.join(PLUGIN_DIR, 'config.json')]) {
    try {
      if (candidate && fs.existsSync(candidate)) return loadConfig(candidate)
    } catch {
      /* fall through to built-in defaults */
    }
  }
  return loadConfig()
}

function shortTitle(title, limit = 80) {
  const text = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function printUsage(stream = process.stdout) {
  stream.write(USAGE)
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    printUsage()
    return 0
  }
  if (!options.memory) throw new UsageError('--memory <dir> is required')
  if (options.from === undefined && options.to === undefined) {
    throw new UsageError('at least one of --from / --to is required')
  }
  const memoryDir = path.resolve(options.memory)
  const collections = resolveCollections(memoryDir)
  const baseConfig = loadBaseConfig()
  const timezone = options.timezone !== undefined ? options.timezone : baseConfig.time.timezone
  const cfg = {
    ...baseConfig,
    time: { ...baseConfig.time, mode: 'constrain', timezone },
  }
  const now = Date.now()
  const normalized = normalizeTimeQuery(
    { timeFrom: options.from, timeTo: options.to, granularity: options.granularity },
    cfg,
    now,
  )
  const warnings = [...normalized.warnings]
  if (normalized.from === null || normalized.to === null) {
    throw new UsageError(`cannot parse the requested time window: ${warnings.join('; ') || 'no usable time input'}`)
  }

  // Collect the folders of every scanned memory directory whose exact event
  // interval overlaps the window. One time index per directory keeps folder
  // ids session-local (ids are only unique per session).
  const rows = []
  const sources = { archive: 0, messages: 0, judge: 0 }
  for (const collection of collections) {
    const index = readIndex(collection.dir, cfg)
    const folders = index && Array.isArray(index.folders) ? index.folders : []
    if (folders.length === 0) continue
    const timeIndex = buildTimeIndex(folders, cfg)
    for (const warning of timeIndex.warnings) if (!warnings.includes(warning)) warnings.push(warning)
    const query = queryTimeIndex(timeIndex, normalized, cfg)
    const hits = query.ids
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    for (let position = 0; position < timeIndex.folderCount; position += 1) {
      const id = timeIndex.ids[position]
      if (hits !== null && !hits.has(id)) continue
      const range = timeIndex.ranges[position]
      const folder = byId.get(id) || {}
      const eventStart = Number.isFinite(folder.eventStart) ? folder.eventStart : null
      const eventEnd = Number.isFinite(folder.eventEnd) ? folder.eventEnd : null
      sources[range.source] = (sources[range.source] || 0) + 1
      rows.push({
        session: collection.label || null,
        id,
        createdAt: Number.isFinite(folder.createdAt) ? folder.createdAt : null,
        start: range.start,
        end: range.end,
        eventStart,
        eventEnd,
        eventTimeSource: typeof folder.eventTimeSource === 'string' ? folder.eventTimeSource : null,
        source: range.source,
        alpha: Number.isFinite(folder.alpha) ? folder.alpha : null,
        title: shortTitle(folder.title),
      })
    }
  }
  rows.sort((left, right) => left.start - right.start || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const hits = rows.length
  const shown = rows.slice(0, options.limit)
  const windowLabel = formatWindow(normalized, timezone)
  const timezoneLabel = timezone ? timezone : 'host local'

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      memoryDir,
      timezone,
      now,
      window: {
        from: normalized.from,
        to: normalized.to,
        level: normalized.level,
        granularity: normalized.granularity,
        widenedTo: null,
        display: windowLabel,
      },
      requested: normalized.requested,
      sessions: collections.map((collection) => collection.label || path.basename(collection.dir)),
      hits,
      shown: shown.length,
      limit: options.limit,
      truncated: hits - shown.length,
      sources,
      warnings,
      folders: shown,
    }, null, 2)}\n`)
    return 0
  }

  console.log(`time view: ${memoryDir}`)
  console.log(`timezone : ${timezoneLabel}`)
  console.log(`window   : ${windowLabel}  [level=${normalized.level}${normalized.granularity !== normalized.level ? ` granularity=${normalized.granularity}` : ''}]`)
  const collectionLabels = collections.map((collection) => collection.label || path.basename(collection.dir))
  const sessionsText = collectionLabels.length <= 3
    ? collectionLabels.join(', ')
    : `${collectionLabels.length} memory directories (${collectionLabels.slice(0, 2).join(', ')}, …)`
  console.log(`sessions : ${sessionsText}`)
  console.log(`hits     : ${hits} folder(s)  (archive=${sources.archive || 0} messages=${sources.messages || 0} judge=${sources.judge || 0})`)
  if (shown.length < hits) console.log(`showing  : first ${shown.length} of ${hits} (use --limit to see more)`)
  const showSession = collections.length > 1 || Boolean(collections[0] && collections[0].label)
  console.log('')
  for (const row of shown) {
    const eventText = row.eventStart !== null
      ? `${new Date(row.eventStart).toISOString()} → ${new Date(row.eventEnd).toISOString()}`
      : '-'
    const alphaText = row.alpha !== null ? row.alpha.toFixed(2) : 'n/a'
    const sessionText = showSession && row.session ? `[${row.session}] ` : ''
    console.log(`${sessionText}${row.id}  α=${alphaText}  source=${row.source}`)
    console.log(`  event : ${eventText}`)
    console.log(`  range : ${new Date(row.start).toISOString()} → ${new Date(row.end).toISOString()}`)
    if (row.title) console.log(`  title : ${row.title}`)
  }
  if (hits === 0) console.log('(no folder overlaps this window)')
  if (warnings.length > 0) {
    console.log('\nwarnings:')
    for (const warning of warnings) console.log(`  - ${warning}`)
  }
  return 0
}

try {
  const code = main(process.argv.slice(2))
  if (code !== 0) process.exitCode = code
} catch (error) {
  // Repository CLI convention: bad/missing arguments print usage to stderr and
  // exit non-zero (1); `--help` alone stays on stdout with exit 0.
  if (error instanceof UsageError) {
    process.stderr.write(`time-view: ${error.message}\n\n`)
    printUsage(process.stderr)
    process.exitCode = 1
  } else {
    process.stderr.write(`time-view: ${error && error.message ? error.message : error}\n`)
    process.exitCode = 1
  }
}
