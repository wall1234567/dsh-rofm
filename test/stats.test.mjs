/**
 * Stats/report tests — report aggregation math, the report format and the
 * tools/recall-report.mjs CLI (docs/SPEC.md §9, §10.6).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import {
  LEGACY_ERA_CUTOFF_MS,
  appendStats,
  formatReport,
  loadConfig,
  memoryPaths,
  readStats,
  summarizeStats,
} from '../engine/index.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPORT_TOOL = path.join(REPO_ROOT, 'tools', 'recall-report.mjs')

const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-stats-'))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

const SAMPLE_EVENTS = [
  {
    type: 'recall',
    contextChars: 1000,
    addedChars: 50,
    addedTokens: 10,
    windowTokens: 1000,
    attempts: 3,
    addedFolders: 1,
    byGeneration: { 1: 1 },
    latencyMs: 0.5,
    addedPercentOfContext: 5,
    addedPercentOfWindow: 1,
  },
  {
    type: 'recall',
    contextChars: 2000,
    addedChars: 200,
    addedTokens: 20,
    windowTokens: 2000,
    attempts: 5,
    addedFolders: 2,
    byGeneration: { 1: 1, 2: 1 },
    latencyMs: 1.5,
    addedPercentOfContext: 10,
    addedPercentOfWindow: 1,
  },
  { type: 'compress', removedChars: 9900, removedTokens: 3300, folderIds: ['mem-a'] },
]

test('stats: summarizeStats aggregates events', () => {
  const summary = summarizeStats(SAMPLE_EVENTS)
  assert.equal(summary.recallEvents, 2)
  assert.equal(summary.contextCharsSum, 3000)
  assert.equal(summary.charsAdded, 250)
  assert.equal(summary.addedTokens, 30)
  assert.equal(summary.windowTokensSum, 3000)
  assert.equal(summary.attempts, 8)
  assert.equal(summary.foldersAdded, 3)
  assert.deepEqual(summary.byGeneration, { 1: 2, 2: 1 })
  assert.equal(summary.compressionEvents, 1)
  assert.equal(summary.charsMovedToMemory, 9900)
  assert.equal(summary.avgRecallLatencyMs, 1)
  assert.equal(summary.contextAddedPercent, 7.5) // average of 5% and 10%
  assert.equal(summary.windowTokensAddedPercent, 1)
})

test('stats: summarizeStats tolerates empty/garbage input', () => {
  const empty = summarizeStats([])
  assert.equal(empty.recallEvents, 0)
  assert.equal(empty.charsAdded, 0)
  assert.equal(empty.contextAddedPercent, null)
  assert.equal(empty.windowTokensAddedPercent, null)
  assert.equal(empty.avgRecallLatencyMs, 0)
  assert.deepEqual(empty.byGeneration, {})
  assert.doesNotThrow(() => summarizeStats(null))
  assert.equal(summarizeStats([null, 42, 'x', { type: 'recall' }]).recallEvents, 1)
})

test('stats: percentages fall back to aggregate ratios', () => {
  const summary = summarizeStats([
    { type: 'recall', contextChars: 1000, addedChars: 100, addedTokens: 20, windowTokens: 2000, latencyMs: 2 },
    { type: 'recall', contextChars: 1000, addedChars: 100, addedTokens: 20, windowTokens: 2000, latencyMs: 4 },
  ])
  assert.equal(summary.contextAddedPercent, 10)
  assert.equal(summary.windowTokensAddedPercent, 1)
  assert.equal(summary.avgRecallLatencyMs, 3)
})

test('stats: formatReport prints the documented report', () => {
  const text = formatReport(summarizeStats(SAMPLE_EVENTS))
  const lines = text.trimEnd().split('\n')
  assert.equal(lines[0], '=== memory recall report ===')
  assert.match(text, /recall events          : 2/)
  assert.match(text, /context chars \(sum\)    : 3000/)
  assert.match(text, /chars added back       : 250/)
  assert.match(text, /context added back     : 7\.50 %/)
  assert.match(text, /\(of current context, average per event\)/)
  assert.match(text, /window tokens added    : 1\.00 %/)
  assert.match(text, /folders added          : 3 \(gen1=2, gen2=1\)/)
  assert.match(text, /compression events     : 1, chars moved to memory: 9900/)
  assert.match(text, /avg recall latency     : 1\.00 ms/)
  assert.ok(text.endsWith('\n'))
})

test('stats: empty report formats with zeros and n/a', () => {
  const text = formatReport(summarizeStats([]))
  assert.match(text, /recall events          : 0/)
  assert.match(text, /context chars \(sum\)    : 0/)
  assert.match(text, /chars added back       : 0/)
  assert.match(text, /context added back     : n\/a %/)
  assert.match(text, /folders added          : 0/)
  assert.match(text, /avg recall latency     : 0\.00 ms/)
})

test('stats: readStats reads what appendStats writes', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  appendStats(dir, cfg, { type: 'recall', addedChars: 12, contextChars: 100 })
  appendStats(dir, cfg, { type: 'compress', removedChars: 34 })
  const events = readStats(dir, cfg)
  assert.equal(events.length, 2)
  assert.equal(summarizeStats(events).charsAdded, 12)
  assert.equal(summarizeStats(events).charsMovedToMemory, 34)
  assert.ok(Number.isFinite(events[0].time))
})

// ---------------------------------------------------------------------------
// tools/recall-report.mjs
// ---------------------------------------------------------------------------

function runReportTool(args) {
  return spawnSync(process.execPath, [REPORT_TOOL, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
}

test('report tool: --help works and exits 0', () => {
  const help = runReportTool(['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /Usage/)
  assert.match(help.stdout, /recall-report\.mjs/)
})

test('report tool: prints the text report from a memory dir', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  appendStats(dir, cfg, {
    type: 'recall',
    contextChars: 41000,
    addedChars: 2400,
    addedTokens: 810,
    windowTokens: 128000,
    addedFolders: 2,
    byGeneration: { 1: 1, 2: 1 },
    latencyMs: 0.82,
    addedPercentOfContext: 5.85,
    addedPercentOfWindow: 0.63,
  })
  appendStats(dir, cfg, { type: 'compress', removedChars: 9900 })
  const run = runReportTool(['--dir', dir])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /=== memory recall report ===/)
  assert.match(run.stdout, /recall events          : 1/)
  assert.match(run.stdout, /chars added back       : 2400/)
  assert.match(run.stdout, /context added back     : 5\.85 %/)
  assert.match(run.stdout, /folders added          : 2 \(gen1=1, gen2=1\)/)
  assert.match(run.stdout, /compression events     : 1, chars moved to memory: 9900/)
})

test('report tool: --json and --last', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  for (let index = 0; index < 3; index += 1) {
    appendStats(dir, cfg, { type: 'recall', contextChars: 1000, addedChars: 10 * (index + 1), latencyMs: 1, attempts: 1 })
  }
  const jsonRun = runReportTool(['--dir', dir, '--json', '--last', '2'])
  assert.equal(jsonRun.status, 0, jsonRun.stderr)
  const parsed = JSON.parse(jsonRun.stdout)
  assert.equal(parsed.eventCount, 2)
  assert.equal(parsed.summary.recallEvents, 2)
  assert.equal(parsed.summary.charsAdded, 50) // events 2 and 3 (20 + 30)
  assert.ok(parsed.memoryDir.endsWith(path.basename(dir)))

  const invalid = runReportTool(['--dir', dir, '--last', '0'])
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /--last/)

  const empty = runReportTool(['--dir', path.join(dir, 'missing-subdir')])
  assert.equal(empty.status, 0, empty.stderr)
  assert.match(empty.stdout, /recall events          : 0/)
})

test('report tool: default per-session layout aggregates every memory/sessions/<id>/stats.jsonl', () => {
  const cfg = loadConfig()
  const root = path.join(tempDir(), 'plugin')
  const memoryDir = path.join(root, 'memory')
  appendStats(path.join(memoryDir, 'sessions', 'session-a'), cfg, { type: 'recall', contextChars: 1000, addedChars: 10, latencyMs: 1 })
  appendStats(path.join(memoryDir, 'sessions', 'session-b'), cfg, { type: 'recall', contextChars: 1000, addedChars: 20, latencyMs: 1 })
  appendStats(memoryDir, cfg, { type: 'recall', contextChars: 1000, addedChars: 5, latencyMs: 1 }) // legacy global stats
  const configPath = path.join(root, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ storage: { dir: memoryDir } }))
  const run = runReportTool(['--config', configPath, '--json'])
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.eventCount, 3, 'per-session stats files plus the legacy global file are aggregated')
  assert.equal(parsed.summary.recallEvents, 3)
  assert.equal(parsed.summary.charsAdded, 35)
  assert.ok(parsed.statsDirs.length >= 2)
  assert.ok(parsed.memoryDir.endsWith(path.join('plugin', 'memory')))
})

// ---------------------------------------------------------------------------
// v1.4.0 report lines: lane distribution / time filter / pending era
// ---------------------------------------------------------------------------

test('report tool: v1.4.0 lane and time-filter lines aggregate recall telemetry', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  appendStats(dir, cfg, {
    type: 'recall',
    contextChars: 1000,
    addedChars: 10,
    latencyMs: 1,
    mode: 'fair',
    candidates: 12,
    lanesPicked: { rareHigh: 2, queryBoost: 1, register: 0, hi: 5, lowProbe: 1, rotation: 1, recycle: 0 },
    pops: 20,
    registerDrops: 0,
    reInjections: 1,
    degraded: false,
    timeFiltered: 0,
    timeWindow: null,
    offset: 0,
    limit: 10,
    hasMore: true,
  })
  appendStats(dir, cfg, {
    type: 'recall',
    contextChars: 1000,
    addedChars: 10,
    latencyMs: 1,
    mode: 'fair',
    lanesPicked: { rareHigh: 1, queryBoost: 0, register: 0, hi: 2, lowProbe: 0, rotation: 0, recycle: 0 },
    registerDrops: 2,
    degraded: true,
    timeFiltered: 3,
    timeWindow: { from: 1, to: 2, level: 'day', widenedTo: 'day3' },
    missType: 'time',
    hasMore: false,
  })

  const jsonRun = runReportTool(['--dir', dir, '--json'])
  assert.equal(jsonRun.status, 0, jsonRun.stderr)
  const parsed = JSON.parse(jsonRun.stdout)
  assert.equal(parsed.laneStats.events, 2)
  assert.equal(parsed.laneStats.lanes.hi, 7)
  assert.equal(parsed.laneStats.lanes.rareHigh, 3)
  assert.equal(parsed.laneStats.picks, 13)
  assert.equal(parsed.laneStats.meanPicks, 6.5)
  assert.equal(parsed.laneStats.highAlphaLaneShare, 84.62)
  assert.equal(parsed.laneStats.registerDropEvents, 1)
  assert.equal(parsed.laneStats.registerDrops, 2)
  assert.equal(parsed.laneStats.degradedEvents, 1)
  assert.equal(parsed.laneStats.reInjections, 1)
  assert.deepEqual(parsed.laneStats.modes, { fair: 2 })
  assert.equal(parsed.timeStats.events, 2)
  assert.equal(parsed.timeStats.timeFilteredEvents, 1)
  assert.equal(parsed.timeStats.timeFilteredTotal, 3)
  assert.equal(parsed.timeStats.timeWindowEvents, 1)
  assert.deepEqual(parsed.timeStats.widenedTo, { day3: 1 })
  assert.deepEqual(parsed.timeStats.missTypes, { time: 1 })
  assert.equal(parsed.timeStats.hasMoreEvents, 1)

  const text = runReportTool(['--dir', dir])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /lanes \(v1\.4\.0\)\s+: 2 event\(s\), picks=13 \(mean 6\.5\), rareHigh=3/)
  assert.match(text.stdout, /registerDrops>0 1 \(total 2\), degraded 1, reInjections 1, modes fair=2/)
  assert.match(
    text.stdout,
    /time filter\s+: 2 event\(s\), timeFiltered>0 1 \(total 3\), timeWindow 1, widenedTo day3=1, missType time=1, hasMore 1/,
  )
})

test('report tool: old telemetry prints n/a on the v1.4.0 lane/time lines', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  appendStats(dir, cfg, { type: 'recall', contextChars: 1000, addedChars: 10, latencyMs: 1 })
  const run = runReportTool(['--dir', dir])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /lanes \(v1\.4\.0\)\s+: n\/a \(no v1\.4\.0 recall telemetry yet\)/)
  assert.match(run.stdout, /time filter\s+: n\/a \(no v1\.4\.0 recall telemetry yet\)/)
})

test('report tool: pending era block reads index.json via the shared engine/era.js rules', () => {
  const dir = tempDir()
  const legacyTs = LEGACY_ERA_CUTOFF_MS - 1000
  const currentTs = LEGACY_ERA_CUTOFF_MS + 1000
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      updatedAt: currentTs,
      nextCounter: 4,
      folders: [
        { id: 'mem-20261025T014017Z-0001', createdAt: legacyTs, alpha: 0, beta: 0, scored: false, rescorePending: false, keywords: [], chars: 1, tokens: 1, messageCount: 1, title: 'legacy' },
        { id: 'mem-20261026T131909Z-0001', createdAt: currentTs, alpha: 0, beta: 0, scored: false, rescorePending: false, keywords: [], chars: 1, tokens: 1, messageCount: 1, title: 'pending' },
        { id: 'mem-20261026T131909Z-0002', createdAt: currentTs, alpha: 0.6, beta: 1, scored: true, rescorePending: false, keywords: ['a', 'b', 'c'], chars: 1, tokens: 1, messageCount: 1, title: 'scored' },
      ],
    }),
    'utf8',
  )
  appendStats(dir, loadConfig(), { type: 'compress', removedChars: 10 })

  const jsonRun = runReportTool(['--dir', dir, '--json'])
  assert.equal(jsonRun.status, 0, jsonRun.stderr)
  const parsed = JSON.parse(jsonRun.stdout)
  assert.equal(parsed.pendingEras.totals.folders, 3)
  assert.equal(parsed.pendingEras.totals.pending, 2)
  assert.equal(parsed.pendingEras.totals.pendingPercent, 66.67)
  assert.equal(parsed.pendingEras.buckets.legacy.folders, 1)
  assert.equal(parsed.pendingEras.buckets.current.folders, 2)
  assert.equal(parsed.pendingEras.buckets.current.pending, 1)
  assert.equal(parsed.pendingEras.totals.currentPendingPercent, 50)
  assert.equal(parsed.pendingEras.calibers.C.pending, 1)
  assert.equal(parsed.pendingEras.calibers.C.pendingPercent, 50)
  assert.equal(parsed.pendingEras.currentPending.length, 1)

  const text = runReportTool(['--dir', dir])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /pending era\s+: legacy 1 folders \/ 1 pending; synthetic 0 folders \/ 0 pending; current 2 folders \/ 1 pending = 50\.00%/)
  assert.match(text.stdout, /all-stock 2\/3 = 66\.67%; C current-real 1\/2 = 50\.00%/)
  assert.match(text.stdout, /legacy is per-folder/)
})
