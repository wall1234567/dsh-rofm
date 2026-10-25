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
