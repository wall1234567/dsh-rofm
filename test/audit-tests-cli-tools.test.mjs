/**
 * Audit (task-3): coverage holes in docs/SPEC.md §7 (public API surface), §8
 * (CLI flags) and §9 (report β / re-archive-pending aggregates), plus
 * `tools/show-recall.mjs`, which had NO test at all before this file.
 *
 * Black-box only: imports the documented public entry point `engine/index.js`
 * and spawns the shipped CLIs. No private helpers, no machine-specific paths,
 * no timezone/locale-dependent assertions (all assertions are on JSON or fixed
 * label text; timestamps are never compared to local-format strings).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import * as engine from '../engine/index.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI = path.join(REPO_ROOT, 'engine', 'cli.mjs')
const REPORT = path.join(REPO_ROOT, 'tools', 'recall-report.mjs')
const SHOW_RECALL = path.join(REPO_ROOT, 'tools', 'show-recall.mjs')

const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-audit-tools-'))
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

function run(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
}

// ---------------------------------------------------------------------------
// §7 Public API surface: every documented export must exist through the one
// public entry point. Refactors that drop a re-export would otherwise only be
// caught by tests that import the private module directly.
// ---------------------------------------------------------------------------

const DOCUMENTED_FUNCTIONS = [
  'loadConfig',
  'validateConfig',
  'resolveMemoryDir',
  'normalizeBeta',
  'estimateTokens',
  'estimateMessagesTokens',
  'normalizeMessages',
  'renderMessage',
  'extractKeywords',
  'tokenize',
  'computeImportance',
  'alphaForFolder',
  'erf',
  'recallProbability',
  'createRng',
  'planCompression',
  'commitCompression',
  'buildArchiveNote',
  'recall',
  'buildRecallBlock',
  'formatBeta',
  'readIndex',
  'loadIndex',
  'writeIndex',
  'listFolders',
  'readFolder',
  'ensureMemoryDir',
  'appendStats',
  'readStats',
]
const DOCUMENTED_VALUES = ['DEFAULT_CONFIG', 'BETA_MIN', 'BETA_MAX', 'DEFAULT_BETA', 'RECALL_BLOCK_PREAMBLE']

test('public API: every export documented in SPEC §7 is reachable from engine/index.js', () => {
  for (const name of DOCUMENTED_FUNCTIONS) {
    assert.equal(typeof engine[name], 'function', `engine/index.js must export function ${name} (SPEC §7)`)
  }
  for (const name of DOCUMENTED_VALUES) {
    assert.notEqual(engine[name], undefined, `engine/index.js must export ${name} (SPEC §7)`)
  }
  // Objective constants have exactly the documented values.
  assert.equal(engine.BETA_MIN, -10)
  assert.equal(engine.BETA_MAX, 10)
  assert.equal(engine.DEFAULT_BETA, 0)
  assert.equal(typeof engine.DEFAULT_CONFIG, 'object')
})

test('public API: MemoryEngine exposes the documented facade methods (SPEC §7)', () => {
  assert.equal(typeof engine.MemoryEngine, 'function')
  const required = ['load', 'planCompression', 'compress', 'recall', 'report', 'setConfig']
  const dir = path.join(tempDir(), 'memory')
  const memoryEngine = new engine.MemoryEngine({ memoryDir: dir, config: engine.loadConfig() })
  for (const method of required) {
    assert.equal(typeof memoryEngine[method], 'function', `MemoryEngine.${method}() must exist (SPEC §7)`)
  }
  // A fresh facade is usable without touching a DSH host: this is the entire
  // "engine has zero DSH imports" contract at runtime.
  memoryEngine.load()
  assert.deepEqual(memoryEngine.list(), [])
  assert.equal(memoryEngine.recall('部署 docker 端口', { contextChars: 0, windowTokens: 128000 }).additions.length, 0)
  assert.equal(typeof memoryEngine.report(), 'object')
})

// ---------------------------------------------------------------------------
// §9 report math: betaStats + workStats were only reachable through
// `--json`/text lines that no existing test asserted.
// ---------------------------------------------------------------------------

function seedReportFixture(dir) {
  const cfg = engine.loadConfig()
  // β aggregate source: recall telemetry `added[].beta` (one value per memory).
  engine.appendStats(dir, cfg, {
    type: 'recall',
    contextChars: 41000,
    addedChars: 2400,
    windowTokens: 128000,
    addedFolders: 4,
    added: [{ id: 'm1', beta: -2.5 }, { id: 'm2', beta: 7 }, { id: 'm3', beta: 0 }, { id: 'm4', beta: 3.25 }],
    latencyMs: 0.82,
  })
  // Older telemetry without β must not poison the aggregate.
  engine.appendStats(dir, cfg, { type: 'recall', addedFolders: 1, added: [{ id: 'legacy-no-beta' }] })
  // Work aggregate source: re-archive + pending folders from compress-applied.
  engine.appendStats(dir, cfg, { type: 'rearchive', removedIds: ['r1', 'r2'], removedTokens: 512 })
  engine.appendStats(dir, cfg, {
    type: 'compress-applied',
    pinnedShadowed: 2,
    pinnedRecorded: 2,
    pinnedChars: 96,
    mergedCheckpoints: 2,
    archiveSegments: 182,
    folderMetadata: [{ scored: false, images: 1 }, { scored: false, images: 0 }, { scored: true, images: 2 }],
  })
}

test('report tool: --json exposes the documented betaStats and workStats aggregates (SPEC §9)', () => {
  const dir = tempDir()
  seedReportFixture(dir)
  const runResult = run(REPORT, ['--dir', dir, '--json'])
  assert.equal(runResult.status, 0, runResult.stderr)
  const parsed = JSON.parse(runResult.stdout)

  // β≥7 / 0≤β<7 / β<0 bucketing, mean rounded to 2dp, legacy events ignored.
  assert.deepEqual(parsed.betaStats, { n: 4, mean: 1.94, aboveOrEqual7: 1, between0And7: 2, negative: 1 })
  // workStats keys are exactly the documented ones (v1.2 adds image/pinned
  // counters; v1.2 adds the checkpoint-note merge counters).
  assert.deepEqual(parsed.workStats, {
    rearchiveEvents: 1,
    rearchivedFolders: 2,
    rearchivedTokens: 512,
    pendingCreated: 2,
    archivedImages: 3,
    pinnedShadowed: 2,
    pinnedRecorded: 2,
    pinnedChars: 96,
    mergedCheckpoints: 2,
    archiveSegments: 182,
  })
})

test('report tool: text report prints the β trust line and the work lines (SPEC §9)', () => {
  const dir = tempDir()
  seedReportFixture(dir)
  const runResult = run(REPORT, ['--dir', dir])
  assert.equal(runResult.status, 0, runResult.stderr)
  assert.match(runResult.stdout, /beta \(trust\)\s+: n=4, mean=\+1\.94, β≥7: 1, 0≤β<7: 2, β<0: 1/)
  assert.match(runResult.stdout, /re-archive events\s+: 1, recalled folders removed: 2, tokens: 512/)
  assert.match(runResult.stdout, /pending folders created\s+: 2 \(awaiting memory_judge\)/)
  assert.match(runResult.stdout, /archived images\s+: 3 \(copied to images\/\)/)
  assert.match(runResult.stdout, /pinned context merged\s+: 2 recorded \/ 2 shadowed, 96 chars \(into checkpoint notes\)/)
  assert.match(runResult.stdout, /checkpoint notes merged\s+: 2 previous note\(s\), latest cumulative segments: 182/)
})

test('report tool: no β telemetry prints the documented n/a line (SPEC §9)', () => {
  const dir = tempDir()
  engine.appendStats(dir, engine.loadConfig(), { type: 'compress', removedChars: 10 })
  const runResult = run(REPORT, ['--dir', dir])
  assert.equal(runResult.status, 0, runResult.stderr)
  assert.match(runResult.stdout, /beta \(trust\)\s+: n\/a \(no recall telemetry with β yet\)/)
})

// ---------------------------------------------------------------------------
// tools/show-recall.mjs: SPEC §9 "inspection counterpart" — previously 0 tests.
// ---------------------------------------------------------------------------

/** One recallable folder, one pending (unscored) folder, one rescorePending folder. */
function buildShowRecallFixture() {
  const root = tempDir()
  const memoryDir = path.join(root, 'sessions', 'session-audit')
  const cfg = { ...engine.loadConfig(), memoryDir }
  const folder = (id, meta, text) =>
    engine.writeFolder(memoryDir, {
      id,
      meta: { createdAt: meta.createdAt, alpha: meta.alpha, beta: meta.beta, keywords: meta.keywords, title: text, ...meta },
      messages: [{ role: 'user', content: text }],
    })
  folder('mem-a', { alpha: 0.6, beta: 3, keywords: ['部署', 'docker'], scored: true, alphaSource: 'llm', betaSource: 'llm', keywordsSource: 'llm', createdAt: 1_700_000_000_000 }, 'FOLDER-A-CONTENT')
  folder('mem-b', { alpha: 0, beta: 0, keywords: [], scored: false, alphaSource: 'pending', betaSource: 'pending', keywordsSource: 'pending', createdAt: 1_700_000_100_000, pendingSince: 1_700_000_100_000 }, 'FOLDER-B-PENDING-CONTENT')
  folder('mem-c', { alpha: 0.9, beta: -2.5, keywords: ['回滚', '事故'], scored: true, rescorePending: true, alphaSource: 'llm', betaSource: 'llm', keywordsSource: 'llm', createdAt: 1_700_000_200_000 }, 'FOLDER-C-RESCORE-CONTENT')
  engine.writeIndex(memoryDir, cfg, {
    version: 1,
    nextCounter: 4,
    folders: [
      { id: 'mem-a', createdAt: 1_700_000_000_000, alpha: 0.6, beta: 3, keywords: ['部署', 'docker'], title: 'FOLDER-A-CONTENT', scored: true },
      { id: 'mem-b', createdAt: 1_700_000_100_000, alpha: 0, beta: 0, keywords: [], title: 'FOLDER-B-PENDING-CONTENT', scored: false },
      { id: 'mem-c', createdAt: 1_700_000_200_000, alpha: 0.9, beta: -2.5, keywords: ['回滚', '事故'], title: 'FOLDER-C-RESCORE-CONTENT', scored: true, rescorePending: true },
    ],
  })
  const recallState = {
    version: 2,
    updatedAt: 1_700_000_300_000,
    block: '## 记忆回忆\n\nrendered block text',
    additions: [
      { id: 'mem-a', generation: 1, alpha: 0.6, beta: 3, chars: 18, keywords: ['部署', 'docker'], messages: [{ role: 'user', content: 'FOLDER-A-CONTENT' }] },
    ],
  }
  fs.writeFileSync(path.join(memoryDir, 'recall-state.json'), JSON.stringify(recallState))
  engine.appendStats(memoryDir, cfg, {
    type: 'recall',
    contextChars: 41000,
    addedChars: 300,
    windowTokens: 128000,
    addedFolders: 1,
    byGeneration: { 1: 1 },
    latencyMs: 0.5,
    added: [{ id: 'mem-a', beta: 3 }],
  })
  return { memoryDir, recallState }
}

test('show-recall --json: lists folders with scored/rescorePending/pending + sources and excludes pending from the injectable block (SPEC §9)', () => {
  const { memoryDir, recallState } = buildShowRecallFixture()
  const runResult = run(SHOW_RECALL, ['--dir', memoryDir, '--json'])
  assert.equal(runResult.status, 0, runResult.stderr)
  const parsed = JSON.parse(runResult.stdout)

  assert.equal(parsed.summary.folders, 3)
  assert.equal(parsed.summary.scored, 2)
  assert.equal(parsed.summary.pending, 1)
  assert.equal(parsed.summary.rescorePending, 1)
  assert.equal(parsed.summary.recallable, 2)

  const byId = new Map(parsed.folders.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('mem-a').scored, true)
  assert.equal(byId.get('mem-a').pending, false)
  assert.equal(byId.get('mem-a').sources.alpha, 'llm')
  assert.equal(byId.get('mem-b').scored, false, 'explicit scored:false must read as pending')
  assert.equal(byId.get('mem-b').pending, true)
  assert.equal(byId.get('mem-c').rescorePending, true)
  assert.equal(byId.get('mem-c').beta, -2.5)

  // Only scored folders are injectable: the pending folder's content must not
  // appear in `wouldInject`, and the α/β header of scored folders must.
  assert.match(parsed.wouldInject, /FOLDER-A-CONTENT/)
  assert.match(parsed.wouldInject, /FOLDER-C-RESCORE-CONTENT/)
  assert.doesNotMatch(parsed.wouldInject, /FOLDER-B-PENDING-CONTENT/)
  assert.match(parsed.wouldInject, /β=\+3\.0/)
  assert.match(parsed.wouldInject, /β=-2\.5/)

  assert.deepEqual(parsed.recallState, recallState, 'the v2 recall-state snapshot is echoed untouched')
  assert.equal(parsed.recalls.length, 1)
  assert.equal(parsed.sessionId, 'session-audit')
})

test('show-recall text mode: reports pending/review warnings and folder flags (SPEC §9)', () => {
  const { memoryDir } = buildShowRecallFixture()
  const runResult = run(SHOW_RECALL, ['--dir', memoryDir])
  assert.equal(runResult.status, 0, runResult.stderr)
  assert.match(runResult.stdout, /回忆文件夹: 3 个（已评分 2 \/ 待评分 1 \/ 待复核 1）/)
  assert.match(runResult.stdout, /mem-b/)
  assert.match(runResult.stdout, /有 1 个待评分文件夹/)
  assert.match(runResult.stdout, /有 1 个待复核文件夹/)
  assert.match(runResult.stdout, /会被注入模型上下文的回忆块/)
})

test('show-recall: a missing session memory directory exits 1 with a diagnostic (SPEC §9)', () => {
  const missing = path.join(tempDir(), 'nope')
  const runResult = run(SHOW_RECALL, ['--dir', missing, '--json'])
  assert.equal(runResult.status, 1)
  assert.match(runResult.stderr, /找不到会话记忆目录/)
})

test('show-recall: listing mode is JSON and survives the default layout', () => {
  const runResult = run(SHOW_RECALL, ['--json'])
  assert.equal(runResult.status, 0, runResult.stderr)
  const parsed = JSON.parse(runResult.stdout)
  assert.equal(typeof parsed.memoryRoot, 'string')
  assert.ok(Array.isArray(parsed.sessions))
  assert.equal(typeof parsed.legacyFolders, 'number')
})

// ---------------------------------------------------------------------------
// §8 CLI flags: `recall --seed` determinism was documented but untested.
// ---------------------------------------------------------------------------

test('cli: recall --seed makes recall deterministic across processes (SPEC §8)', () => {
  const dir = tempDir()
  const memoryDir = path.join(dir, 'memory')
  const cfg = { ...engine.loadConfig(), memoryDir }
  const written = []
  for (let index = 0; index < 3; index += 1) {
    written.push(
      engine.writeFolder(memoryDir, {
        id: `mem-${index}`,
        meta: { createdAt: 1_700_000_000_000 + index * 1000, alpha: 0.5, beta: 0, keywords: ['部署', 'docker', '端口'], title: `T${index}` },
        messages: [{ role: 'user', content: `第 ${index} 轮部署 docker 端口` }],
      }),
    )
  }
  engine.writeIndex(memoryDir, cfg, { version: 1, folders: written.map((entry) => ({ ...entry.meta, id: entry.id })) })
  const args = ['recall', '--text', '部署 docker 端口 8080', '--dir', memoryDir, '--context', 'token=41000', 'window=128000', '--seed', '42']
  const first = run(CLI, args)
  const second = run(CLI, args)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  const firstJson = JSON.parse(first.stdout)
  const secondJson = JSON.parse(second.stdout)
  assert.deepEqual(
    firstJson.additions.map((addition) => addition.id),
    secondJson.additions.map((addition) => addition.id),
    'same seed must select the same folders',
  )
})
