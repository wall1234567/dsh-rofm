/**
 * dsh-rofm — memory data-era audit tool tests (v1.4.0, tools/memory-audit.mjs +
 * the shared era rules in engine/era.js).
 *
 * Two layers:
 *  1. unit: the shared era module (`sessionEraSignals` / `sessionEra` /
 *     `classifyFolderEra` / `summarizeEras`) — the one truth selfcheck,
 *     recall-report and the adapter all reuse;
 *  2. black-box: `node tools/memory-audit.mjs` spawned exactly as a user runs
 *     it, against throw-away per-session fixtures in `os.tmpdir()`.
 *
 * The real `memory/` directory is only ever READ. The `--apply` write path is
 * exercised exclusively on a temporary fixture; the real-data test asserts that
 * nothing under `memory/` changed (mtime + bytes).
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
  STRESS_MIN_FOLDERS,
  STRESS_MIN_PENDING,
  SYNTHETIC_BEFORE_PERCENT,
  SYNTHETIC_WINDOW_TOKENS,
  classifyFolderEra,
  sessionEra,
  sessionEraSignals,
  summarizeEras,
} from '../engine/era.js'
import {
  ERAS,
  LEGACY_BOUNDARY_ISO,
  LEGACY_BOUNDARY_MS,
  NORMAL_SESSION_BOUNDARY_MS,
  applyPendingEra,
  auditMemory,
  auditStore,
  classifyEra,
  findStores,
} from '../tools/memory-audit.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUDIT = path.join(REPO_ROOT, 'tools', 'memory-audit.mjs')
const REAL_MEMORY = path.join(REPO_ROOT, 'memory')
const SPAWN_TIMEOUT_MS = 120_000

const tempDirs = []
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-memory-audit-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [AUDIT, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
}

function runJson(args, options = {}) {
  const result = runCli(['--json', ...args], options)
  assert.equal(result.error, undefined, `memory-audit failed to spawn: ${result.error?.message}`)
  let json
  try {
    json = JSON.parse(result.stdout)
  } catch (error) {
    assert.fail(
      `--json stdout is not one JSON object: ${error.message}\n` +
        `--- stdout (first 1200 chars) ---\n${String(result.stdout).slice(0, 1200)}\n` +
        `--- stderr (first 1200 chars) ---\n${String(result.stderr).slice(0, 1200)}`,
    )
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Timestamps around the documented era boundaries. */
const LEGACY_TS = LEGACY_ERA_CUTOFF_MS - 1000 // 2026-10-27T19:13:59Z
const CURRENT_TS = LEGACY_ERA_CUTOFF_MS + 1000 // 2026-10-27T19:14:01Z
/** Between the v1.2.0 and v1.3.0 tags — a QQ-channel-age session (qqb-g shape). */
const CHANNEL_TS = LEGACY_ERA_CUTOFF_MS + 24 * 60 * 60 * 1000
/** After the v1.3.0 tag — a "normal session" for caliber D (b5eeee7e shape). */
const NORMAL_TS = NORMAL_SESSION_BOUNDARY_MS + 1000

let idCounter = 0
function folderEntry(overrides = {}) {
  idCounter += 1
  const stamp = String(idCounter).padStart(4, '0')
  const scored = overrides.scored !== false
  return {
    id: `mem-20261027T000000Z-${stamp}`,
    createdAt: CURRENT_TS,
    alpha: scored ? 0.6 : 0,
    beta: scored ? 2 : 0,
    scored,
    rescorePending: false,
    keywords: scored ? ['部署', 'docker', '端口'] : [],
    chars: 10,
    tokens: 5,
    messageCount: 1,
    title: `fixture-${stamp}`,
    ...overrides,
  }
}

function manyFolders(count, { createdAt = CURRENT_TS, scored = false } = {}) {
  const folders = []
  for (let index = 0; index < count; index += 1) folders.push(folderEntry({ createdAt, scored }))
  return folders
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value), 'utf8')
}

function writeIndex(storeDir, folders) {
  writeJson(path.join(storeDir, 'index.json'), {
    version: 1,
    updatedAt: LEGACY_ERA_CUTOFF_MS,
    nextCounter: folders.length + 1,
    folders,
  })
}

function writeStats(storeDir, events) {
  if (events.length === 0) return
  fs.mkdirSync(storeDir, { recursive: true })
  fs.writeFileSync(path.join(storeDir, 'stats.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
}

function compressEvent({ windowTokens, beforePercent } = {}) {
  const event = { type: 'compress', time: CURRENT_TS, removedChars: 100 }
  if (windowTokens !== undefined) event.windowTokens = windowTokens
  if (beforePercent !== undefined) event.beforePercent = beforePercent
  return event
}

function compressAppliedEvent({ windowTokens, beforePercent } = {}) {
  const event = { type: 'compress-applied', time: CURRENT_TS, folderMetadata: [] }
  if (windowTokens !== undefined) event.windowTokens = windowTokens
  if (beforePercent !== undefined) event.beforePercent = beforePercent
  return event
}

function writeStore(memoryDir, session, folders, statsEvents = []) {
  const storeDir = path.join(memoryDir, 'sessions', session)
  fs.mkdirSync(storeDir, { recursive: true })
  writeIndex(storeDir, folders)
  writeStats(storeDir, statsEvents)
  return storeDir
}

/**
 * The canonical fixture: one store of each folder era plus the QQ-channel edge
 * case (fake window but no stress volume) and an empty store.
 *
 *   session-legacy    3 folders (1 scored / 2 pending), all createdAt < v1.2.0
 *                     → sessionEra current, folder buckets all legacy
 *   session-synthetic 120 pending folders, fake window (8000 tokens / 6764%)
 *                     → sessionEra synthetic
 *   session-current   4 folders (3 scored / 1 pending), 1M window, after v1.3.0
 *                     → sessionEra current, normalSession = true
 *   session-channel   10 folders (8 scored / 2 pending), 2000-token fake window
 *                     → sessionEra current (no stress volume)
 *   session-empty     0 folders → skipped from the bucket totals
 */
function buildFixture() {
  const memoryDir = path.join(makeTempDir(), 'memory')
  writeStore(memoryDir, 'session-legacy', [
    folderEntry({ createdAt: LEGACY_TS, scored: true }),
    folderEntry({ createdAt: LEGACY_TS, scored: false }),
    folderEntry({ createdAt: LEGACY_TS, scored: false }),
  ])
  writeStore(
    memoryDir,
    'session-synthetic',
    manyFolders(120, { createdAt: CURRENT_TS, scored: false }),
    [compressEvent({ windowTokens: 8000 }), compressAppliedEvent({ windowTokens: 8000, beforePercent: 6764.15 })],
  )
  writeStore(
    memoryDir,
    'session-current',
    [
      folderEntry({ createdAt: NORMAL_TS, scored: true }),
      folderEntry({ createdAt: NORMAL_TS, scored: true }),
      folderEntry({ createdAt: NORMAL_TS, scored: true }),
      folderEntry({ createdAt: NORMAL_TS, scored: false }),
    ],
    [compressAppliedEvent({ windowTokens: 1048576, beforePercent: 68.23 })],
  )
  writeStore(
    memoryDir,
    'session-channel',
    [
      ...Array.from({ length: 8 }, () => folderEntry({ createdAt: CHANNEL_TS, scored: true })),
      ...Array.from({ length: 2 }, () => folderEntry({ createdAt: CHANNEL_TS, scored: false })),
    ],
    [compressEvent({ windowTokens: 2000 }), compressAppliedEvent({ windowTokens: 2000, beforePercent: 1375.2 })],
  )
  writeStore(memoryDir, 'session-empty', [])
  return memoryDir
}

/** Recursively snapshot every file under `root` (relative path → mtimeMs + bytes). */
function snapshotFiles(root) {
  const snapshot = new Map()
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      const stat = fs.statSync(full)
      snapshot.set(path.relative(root, full), { mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(full) })
    }
  }
  return snapshot
}

// ---------------------------------------------------------------------------
// 1. unit: the shared era module (engine/era.js)
// ---------------------------------------------------------------------------

test('era: the documented boundaries and thresholds are exact', () => {
  assert.equal(LEGACY_ERA_CUTOFF_MS, Date.parse('2026-10-27T19:14:00Z'))
  assert.equal(LEGACY_BOUNDARY_MS, LEGACY_ERA_CUTOFF_MS)
  assert.equal(LEGACY_BOUNDARY_ISO, '2026-10-27T19:14:00.000Z')
  assert.equal(SYNTHETIC_WINDOW_TOKENS, 32000)
  assert.equal(SYNTHETIC_BEFORE_PERCENT, 500)
  assert.equal(STRESS_MIN_FOLDERS, 100)
  assert.equal(STRESS_MIN_PENDING, 100)
  assert.deepEqual([...ERAS], ['legacy', 'synthetic', 'current'])
})

test('era: sessionEraSignals takes the min window / max beforePercent from window events', () => {
  const signals = sessionEraSignals([
    compressEvent({ windowTokens: 8000 }),
    compressAppliedEvent({ windowTokens: 400000, beforePercent: 60.4 }),
    compressAppliedEvent({ windowTokens: 2000, beforePercent: 22043.5 }),
    { type: 'archive', windowTokens: 16000 },
    { type: 'recall', windowTokens: 1 }, // recall telemetry is not an archive window
    null,
    42,
  ])
  assert.deepEqual(signals, {
    fakeWindow: true,
    tinyWindow: true,
    overWindow: true,
    windowTokens: 2000,
    maxBeforePercent: 22043.5,
  })
  assert.deepEqual(sessionEraSignals([]), {
    fakeWindow: false,
    tinyWindow: false,
    overWindow: false,
    windowTokens: null,
    maxBeforePercent: null,
  })
  // A real 1M window with a normal beforePercent is not a fake window.
  const real = sessionEraSignals([compressAppliedEvent({ windowTokens: 1048576, beforePercent: 68.23 })])
  assert.equal(real.fakeWindow, false)
  assert.equal(real.tinyWindow, false)
  assert.equal(real.overWindow, false)
  assert.equal(real.windowTokens, 1048576)
})

test('era: sessionEra = synthetic only when fakeWindow AND stressBacklog', () => {
  const synthetic = sessionEra({
    folders: STRESS_MIN_FOLDERS,
    pending: 0,
    signals: sessionEraSignals([compressEvent({ windowTokens: SYNTHETIC_WINDOW_TOKENS - 1 })]),
  })
  assert.equal(synthetic.era, 'synthetic')
  assert.deepEqual(Object.keys(synthetic.reasons).sort(), [
    'fakeWindow',
    'folders',
    'maxBeforePercent',
    'overWindow',
    'pending',
    'stressBacklog',
    'tinyWindow',
    'windowTokens',
  ])
  assert.equal(synthetic.reasons.fakeWindow, true)
  assert.equal(synthetic.reasons.stressBacklog, true)

  // Fake window, channel-sized volume → current (qqb-g shape).
  const channel = sessionEra({
    folders: 10,
    pending: 2,
    signals: sessionEraSignals([compressAppliedEvent({ windowTokens: 2000, beforePercent: 1375.2 })]),
  })
  assert.equal(channel.era, 'current')
  assert.equal(channel.reasons.fakeWindow, true)
  assert.equal(channel.reasons.stressBacklog, false)
  assert.equal(channel.reasons.windowTokens, 2000)
  assert.equal(channel.reasons.maxBeforePercent, 1375.2)

  // Stress volume with a real window → current (b5eeee7e shape).
  const normal = sessionEra({
    folders: 359,
    pending: 0,
    signals: sessionEraSignals([compressAppliedEvent({ windowTokens: 1048576, beforePercent: 68.23 })]),
  })
  assert.equal(normal.era, 'current')
  assert.equal(normal.reasons.fakeWindow, false)
  assert.equal(normal.reasons.stressBacklog, true)

  // pending >= 100 is enough for stressBacklog even with few folders.
  assert.equal(
    sessionEra({ folders: 20, pending: STRESS_MIN_PENDING, signals: sessionEraSignals([compressEvent({ windowTokens: 8000 })]) }).era,
    'synthetic',
  )
  // Tolerates garbage.
  assert.equal(sessionEra().era, 'current')
  assert.equal(sessionEra(null).era, 'current')
  assert.equal(sessionEra({ folders: 'x', pending: NaN }).era, 'current')
})

test('era: classifyFolderEra applies the legacy boundary, the existing mark, then the session era', () => {
  const syntheticSession = sessionEra({ folders: 120, pending: 120, signals: sessionEraSignals([compressEvent({ windowTokens: 8000 })]) })
  assert.equal(syntheticSession.era, 'synthetic')
  const currentSession = sessionEra({ folders: 4, pending: 1, signals: sessionEraSignals([]) })

  // createdAt < v1.2.0 wins (even inside a synthetic session).
  assert.equal(classifyFolderEra(folderEntry({ createdAt: LEGACY_TS }), syntheticSession), 'legacy')
  assert.equal(classifyFolderEra(folderEntry({ createdAt: LEGACY_TS }), currentSession), 'legacy')
  // Post-boundary folder follows the session era.
  assert.equal(classifyFolderEra(folderEntry({ createdAt: CURRENT_TS }), syntheticSession), 'synthetic')
  assert.equal(classifyFolderEra(folderEntry({ createdAt: CURRENT_TS }), currentSession), 'current')
  // An explicit pendingEra mark always wins (that is what --apply writes).
  assert.equal(classifyFolderEra({ ...folderEntry({ createdAt: CURRENT_TS }), pendingEra: 'legacy' }, currentSession), 'legacy')
  assert.equal(classifyFolderEra({ ...folderEntry({ createdAt: LEGACY_TS }), pendingEra: 'current' }, syntheticSession), 'current')
  assert.equal(classifyFolderEra({ ...folderEntry({ createdAt: LEGACY_TS }), pendingEra: 'synthetic' }, currentSession), 'synthetic')
  assert.equal(classifyFolderEra({ ...folderEntry({ createdAt: CURRENT_TS }), pendingEra: 'bogus' }, currentSession), 'current')
  // Missing/garbage folder → session era (never throws).
  assert.equal(classifyFolderEra(null, syntheticSession), 'synthetic')
  assert.equal(classifyFolderEra({}, currentSession), 'current')
})

test('era: summarizeEras aggregates folder/scored/pending per bucket and lists current pending ids', () => {
  const session = sessionEra({ folders: 4, pending: 1, signals: sessionEraSignals([]) })
  const folders = [
    folderEntry({ createdAt: LEGACY_TS, scored: false }),
    folderEntry({ createdAt: LEGACY_TS, scored: true }),
    folderEntry({ createdAt: CURRENT_TS, scored: false }),
    { ...folderEntry({ createdAt: CURRENT_TS, scored: true }), pendingEra: 'synthetic' },
    { createdAt: CURRENT_TS }, // no id → ignored by summarizeEras
  ]
  const summary = summarizeEras(folders, session)
  assert.equal(summary.total, 4)
  assert.deepEqual(summary.folders, { legacy: 2, current: 1, synthetic: 1 })
  assert.deepEqual(summary.scored, { legacy: 1, current: 0, synthetic: 1 })
  assert.deepEqual(summary.pending, { legacy: 1, current: 1, synthetic: 0 })
  assert.equal(summary.pendingPercent, 50)
  assert.equal(summary.currentPendingPercent, 100)
  assert.deepEqual(summary.pendingFolders, [folders[2].id], 'only current-era pending folders are current-real work')
  assert.deepEqual(summarizeEras([], session), {
    total: 0,
    folders: { legacy: 0, current: 0, synthetic: 0 },
    scored: { legacy: 0, current: 0, synthetic: 0 },
    pending: { legacy: 0, current: 0, synthetic: 0 },
    pendingPercent: null,
    currentPendingPercent: null,
    pendingFolders: [],
  })
})

test('memory-audit: classifyEra is a thin session-level wrapper around engine/era.js', () => {
  assert.equal(classifyEra({ folders: 120, events: [compressEvent({ windowTokens: 8000 })] }).era, 'synthetic')
  assert.equal(classifyEra({ folders: 10, pending: 2, events: [compressEvent({ windowTokens: 2000 })] }).era, 'current')
  assert.equal(classifyEra([compressEvent({ windowTokens: 2000 })]).era, 'current')
  assert.equal(classifyEra().era, 'current')
  assert.equal(classifyEra({ folders: [], events: null }).era, 'current')
  // The wrapper derives pending from the entry list when it is not given.
  const wrapper = classifyEra({ folders: [folderEntry({ scored: false }), folderEntry({ scored: true })] })
  assert.equal(wrapper.reasons.pending, 1)
})

// ---------------------------------------------------------------------------
// 2. unit: whole-memory audit on a fixture
// ---------------------------------------------------------------------------

test('memory-audit: auditMemory buckets by folder era and reproduces calibers A-D', () => {
  const memoryDir = buildFixture()
  const result = auditMemory(memoryDir)

  assert.equal(result.tool, 'dsh-rofm-memory-audit')
  assert.equal(result.readOnly, true)
  assert.equal(result.layout, 'per-session')
  assert.equal(result.totals.stores, 5, 'all store directories are counted')
  assert.equal(result.totals.sessions, 4, 'the empty store is skipped from the session detail')
  assert.deepEqual(
    { folders: result.totals.folders, scored: result.totals.scored, pending: result.totals.pending },
    { folders: 137, scored: 12, pending: 125 },
  )
  assert.deepEqual(
    ERAS.map((era) => [era, result.buckets[era].folders, result.buckets[era].scored, result.buckets[era].pending]),
    [
      ['legacy', 3, 1, 2],
      ['synthetic', 120, 0, 120],
      ['current', 14, 11, 3],
    ],
  )
  assert.deepEqual([result.calibers.A.pending, result.calibers.A.folders], [125, 137])
  assert.deepEqual([result.calibers.B.pending, result.calibers.B.folders], [123, 134])
  assert.deepEqual([result.calibers.C.pending, result.calibers.C.folders], [3, 14])
  assert.equal(result.calibers.C.pendingPercent, 21.43)
  assert.deepEqual([result.calibers.D.pending, result.calibers.D.folders], [1, 4])
  assert.deepEqual(result.calibers.D.sessions, ['session-current'])
  assert.equal(result.totals.currentPendingPercent, 21.43)
  assert.equal(result.currentPending.length, 3, 'current bucket pending ids are echoed')

  const bySession = new Map(result.sessions.map((session) => [session.session, session]))
  // Legacy is per-folder: the session era is current, the folders are legacy.
  const legacy = bySession.get('session-legacy')
  assert.equal(legacy.era, 'current')
  assert.equal(legacy.dominantEra, 'legacy')
  assert.deepEqual([legacy.folders, legacy.scored, legacy.pending], [3, 1, 2])
  assert.match(legacy.eraReason, /pre-1\.2\.0 遗留/)
  assert.match(legacy.eraReason, /sessionEra=current/)
  // Pressure test.
  const synthetic = bySession.get('session-synthetic')
  assert.equal(synthetic.era, 'synthetic')
  assert.equal(synthetic.dominantEra, 'synthetic')
  assert.deepEqual([synthetic.folders, synthetic.scored, synthetic.pending], [120, 0, 120])
  assert.equal(synthetic.reasons.fakeWindow, true)
  assert.equal(synthetic.reasons.tinyWindow, true)
  assert.equal(synthetic.reasons.stressBacklog, true)
  // Normal 1M-window session.
  const normal = bySession.get('session-current')
  assert.equal(normal.era, 'current')
  assert.equal(normal.dominantEra, 'current')
  assert.equal(normal.normalSession, true)
  assert.equal(normal.reasons.fakeWindow, false)
  assert.equal(normal.reasons.stressBacklog, false)
  // QQ-channel shape: fake window but no stress volume ⇒ current.
  const channel = bySession.get('session-channel')
  assert.equal(channel.era, 'current')
  assert.equal(channel.dominantEra, 'current')
  assert.equal(channel.normalSession, false)
  assert.deepEqual(channel.reasons, {
    fakeWindow: true,
    tinyWindow: true,
    overWindow: true,
    windowTokens: 2000,
    maxBeforePercent: 1375.2,
    folders: 10,
    pending: 2,
    stressBacklog: false,
  })
  // Empty store is not a session but still counted in totals.stores.
  assert.equal(bySession.has('session-empty'), false)
  assert.deepEqual(
    [...new Set(result.sessions.map((session) => session.dominantEra))],
    ['legacy', 'synthetic', 'current'],
    'sessions are ordered legacy → synthetic → current',
  )
  assert.deepEqual(result.warnings, [])
  assert.equal(result.boundaries.legacyCutoff, LEGACY_BOUNDARY_ISO)
  assert.equal(result.boundaries.stressMinFolders, STRESS_MIN_FOLDERS)
  assert.equal(result.boundaries.stressMinPending, STRESS_MIN_PENDING)
})

test('memory-audit: samples honour sampleLimit and detail mode', () => {
  const memoryDir = buildFixture()
  const result = auditMemory(memoryDir, { sampleLimit: 2 })
  assert.equal(result.sampleLimit, 2)
  assert.equal(result.samples.legacy.length, 2)
  assert.equal(result.samples.synthetic.length, 2)
  assert.equal(result.samples.current.length, 2)
  for (const sample of result.samples.legacy) {
    assert.equal(sample.era, 'legacy')
    assert.equal(sample.session, 'session-legacy')
    assert.equal(sample.createdAt < LEGACY_ERA_CUTOFF_MS, true)
  }
  assert.equal(auditMemory(memoryDir).samples, null)
})

test('memory-audit: events section counts tagged folders, distinct events and the top labels', () => {
  const memoryDir = path.join(makeTempDir(), 'memory')
  writeStore(memoryDir, 'session-events', [
    folderEntry({ createdAt: CURRENT_TS, scored: true, event: '日本旅行' }),
    folderEntry({ createdAt: CURRENT_TS, scored: true, event: '日本旅行' }),
    folderEntry({ createdAt: CURRENT_TS, scored: true, event: '登录重构项目' }),
    folderEntry({ createdAt: CURRENT_TS, scored: true }), // untagged
  ])
  const result = auditMemory(memoryDir)
  assert.deepEqual(result.events, {
    foldersWithEvent: 3,
    distinctEvents: 2,
    top: [
      { label: '日本旅行', count: 2 },
      { label: '登录重构项目', count: 1 },
    ],
  })
  assert.equal(result.readOnly, true)

  // The CLI exposes the same summary and stays read-only.
  const { status, json } = runJson(['--memory', memoryDir])
  assert.equal(status, 0)
  assert.deepEqual(json.events, result.events)
  assert.equal(json.readOnly, true)
  // --help documents the events section.
  assert.match(runCli(['--help']).stdout, /events = v1\.4\.0 事件标签统计/)
})

test('memory-audit: events section is empty (and stays readable) when nothing is tagged', () => {
  const memoryDir = buildFixture()
  const result = auditMemory(memoryDir)
  assert.deepEqual(result.events, { foldersWithEvent: 0, distinctEvents: 0, top: [] })
  const { status, json } = runJson(['--memory', memoryDir])
  assert.equal(status, 0)
  assert.deepEqual(json.events.foldersWithEvent, 0)
  assert.deepEqual(json.events.top, [])
})

test('memory-audit: auditStore reports a missing/corrupt index instead of throwing', () => {
  const emptyDir = path.join(makeTempDir(), 'no-index')
  fs.mkdirSync(emptyDir, { recursive: true })
  const missing = auditStore(emptyDir)
  assert.equal(missing.indexOk, false)
  assert.match(missing.indexError, /不存在/)

  const brokenDir = path.join(makeTempDir(), 'broken-index')
  fs.mkdirSync(brokenDir, { recursive: true })
  fs.writeFileSync(path.join(brokenDir, 'index.json'), '{ not json', 'utf8')
  const broken = auditStore(brokenDir)
  assert.equal(broken.indexOk, false)
  assert.match(broken.indexError, /不是合法 JSON/)

  const memoryDir = path.join(makeTempDir(), 'memory')
  writeStore(memoryDir, 'broken-session', [folderEntry()])
  fs.writeFileSync(path.join(memoryDir, 'sessions', 'broken-session', 'index.json'), '{ not json', 'utf8')
  const result = auditMemory(memoryDir)
  assert.equal(result.totals.folders, 0)
  assert.equal(result.totals.stores, 1)
  assert.equal(result.totals.sessions, 0)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /index\.json/)
})

test('memory-audit: single-store layout (--memory pointing at one store) works', () => {
  const storeDir = path.join(makeTempDir(), 'memory')
  writeIndex(storeDir, [folderEntry({ createdAt: NORMAL_TS, scored: true }), folderEntry({ createdAt: NORMAL_TS, scored: false })])
  const result = auditMemory(storeDir)
  assert.equal(result.layout, 'single')
  assert.equal(result.totals.stores, 1)
  assert.equal(result.totals.sessions, 1)
  assert.deepEqual(
    { folders: result.totals.folders, scored: result.totals.scored, pending: result.totals.pending },
    { folders: 2, scored: 1, pending: 1 },
  )
  assert.equal(result.sessions[0].session, 'memory')
  assert.deepEqual(findStores(storeDir).map((store) => store.layout), ['single'])
})

// ---------------------------------------------------------------------------
// 3. CLI: --json / --help / read-only / --apply
// ---------------------------------------------------------------------------

test('memory-audit CLI: --json schema + fixture snapshot shape', () => {
  const memoryDir = buildFixture()
  const { status, json } = runJson(['--memory', memoryDir])
  assert.equal(status, 0)
  assert.equal(json.tool, 'dsh-rofm-memory-audit')
  assert.equal(json.readOnly, true)
  assert.equal(json.eraRules, 'engine/era.js')
  assert.equal(json.memoryDir, path.resolve(memoryDir))
  assert.equal(json.layout, 'per-session')
  assert.equal(json.boundaries.legacyCutoff, LEGACY_BOUNDARY_ISO)
  assert.equal(json.boundaries.syntheticWindowTokens, SYNTHETIC_WINDOW_TOKENS)
  assert.equal(json.boundaries.syntheticBeforePercent, SYNTHETIC_BEFORE_PERCENT)
  assert.equal(json.boundaries.stressMinFolders, STRESS_MIN_FOLDERS)
  assert.equal(json.boundaries.stressMinPending, STRESS_MIN_PENDING)
  assert.equal(json.totals.stores, 5)
  assert.equal(json.totals.sessions, 4)
  assert.equal(json.totals.folders, 137)
  assert.equal(json.totals.pending, 125)
  assert.equal(json.calibers.C.pending, 3)
  assert.equal(json.calibers.C.folders, 14)
  assert.ok(Array.isArray(json.currentPending))
  assert.equal(json.currentPending.length, 3)
  for (const session of json.sessions) {
    assert.equal(typeof session.session, 'string')
    assert.ok(['synthetic', 'current'].includes(session.era), `session era is session-level: ${session.era}`)
    assert.ok(['legacy', 'synthetic', 'current'].includes(session.dominantEra))
    assert.equal(typeof session.reasons.fakeWindow, 'boolean')
    assert.equal(typeof session.reasons.stressBacklog, 'boolean')
    assert.deepEqual(Object.keys(session.reasons).sort(), [
      'fakeWindow',
      'folders',
      'maxBeforePercent',
      'overWindow',
      'pending',
      'stressBacklog',
      'tinyWindow',
      'windowTokens',
    ])
    assert.equal(typeof session.eraReason, 'string')
    assert.ok(session.folders > 0)
  }
})

test('memory-audit CLI: default run writes nothing (mtime+bytes unchanged)', () => {
  const memoryDir = buildFixture()
  const before = snapshotFiles(memoryDir)
  assert.equal(runCli(['--memory', memoryDir]).status, 0)
  assert.equal(runJson(['--memory', memoryDir]).status, 0)
  const after = snapshotFiles(memoryDir)
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file may be created or deleted')
  for (const [file, snapshot] of before) {
    const current = after.get(file)
    assert.equal(current.mtimeMs, snapshot.mtimeMs, `${file} mtime must not change on a read-only run`)
    assert.equal(Buffer.compare(current.bytes, snapshot.bytes), 0, `${file} bytes must not change`)
  }
})

test('memory-audit CLI: --apply only adds pendingEra to index.json (meta/scored/createdAt untouched)', () => {
  const memoryDir = buildFixture()
  // Real meta.json files make "meta unchanged" provable, and let us check the
  // classic half-scored legacy mix (82fa546a shape: 1 scored / 2 pending).
  for (const session of ['session-legacy', 'session-current']) {
    const storeDir = path.join(memoryDir, 'sessions', session)
    const index = JSON.parse(fs.readFileSync(path.join(storeDir, 'index.json'), 'utf8'))
    for (const folder of index.folders) {
      writeJson(path.join(storeDir, folder.id, 'meta.json'), {
        version: 1,
        id: folder.id,
        createdAt: folder.createdAt,
        alpha: folder.alpha,
        beta: folder.beta,
        scored: folder.scored,
        keywords: folder.keywords,
        title: folder.title,
      })
      assert.equal(folder.pendingEra, undefined, `fixture must start unmarked (${session}/${folder.id})`)
    }
  }
  const indexPath = path.join(memoryDir, 'sessions', 'session-legacy', 'index.json')
  const indexBefore = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  const metaPath = path.join(memoryDir, 'sessions', 'session-legacy', indexBefore.folders[0].id, 'meta.json')
  const metaBefore = fs.readFileSync(metaPath, 'utf8')
  const before = snapshotFiles(memoryDir)

  const { status, json } = runJson(['--memory', memoryDir, '--apply'])
  assert.equal(status, 0, JSON.stringify(json.apply))
  assert.equal(json.readOnly, false)
  assert.equal(json.apply.requested, true)
  assert.deepEqual(json.apply.errors, [])
  assert.equal(json.apply.entriesMarked, 137, 'every fixture folder gets a pendingEra mark')
  assert.equal(json.apply.filesWritten, 4, 'the empty store has nothing to write')

  // index.json keeps every other field and only gains pendingEra on the entries.
  const indexAfter = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  assert.equal(indexAfter.updatedAt, indexBefore.updatedAt)
  assert.equal(indexAfter.nextCounter, indexBefore.nextCounter)
  assert.equal(indexAfter.version, indexBefore.version)
  const stripped = {
    ...indexAfter,
    folders: indexAfter.folders.map((folder) => {
      const copy = { ...folder }
      delete copy.pendingEra
      return copy
    }),
  }
  assert.deepEqual(stripped, indexBefore, 'only pendingEra may be added to index entries')
  assert.deepEqual(
    indexAfter.folders.map((folder) => folder.pendingEra),
    ['legacy', 'legacy', 'legacy'],
    'folder era wins: pre-1.2.0 folders are legacy even though the session era is current',
  )
  const syntheticIndex = JSON.parse(fs.readFileSync(path.join(memoryDir, 'sessions', 'session-synthetic', 'index.json'), 'utf8'))
  assert.equal(syntheticIndex.folders.every((folder) => folder.pendingEra === 'synthetic'), true)
  const channelIndex = JSON.parse(fs.readFileSync(path.join(memoryDir, 'sessions', 'session-channel', 'index.json'), 'utf8'))
  assert.equal(channelIndex.folders.filter((folder) => folder.pendingEra === 'current').length, 10)
  const currentIndex = JSON.parse(fs.readFileSync(path.join(memoryDir, 'sessions', 'session-current', 'index.json'), 'utf8'))
  assert.equal(currentIndex.folders.every((folder) => folder.pendingEra === 'current'), true)

  // No meta.json content or mtime change, and only index.json files were written.
  assert.equal(fs.readFileSync(metaPath, 'utf8'), metaBefore)
  const after = snapshotFiles(memoryDir)
  for (const [file, snapshot] of before) {
    if (path.basename(file) === 'index.json') continue
    const current = after.get(file)
    assert.equal(current.mtimeMs, snapshot.mtimeMs, `${file} must not be written by --apply`)
    assert.equal(Buffer.compare(current.bytes, snapshot.bytes), 0, `${file} bytes must not change`)
  }

  // A second --apply is a no-op (idempotent), per tool and per store.
  const second = runJson(['--memory', memoryDir, '--apply'])
  assert.equal(second.status, 0)
  assert.equal(second.json.apply.entriesMarked, 0)
  assert.equal(second.json.apply.filesWritten, 0)
  const again = applyPendingEra(path.join(memoryDir, 'sessions', 'session-current'))
  assert.equal(again.ok, true)
  assert.equal(again.changed, 0)
})

test('memory-audit: a stale pendingEra mark is trusted by the audit and corrected by --apply', () => {
  const memoryDir = buildFixture()
  assert.equal(runJson(['--memory', memoryDir, '--apply']).status, 0)

  // Poison one current folder with a wrong mark: engine/era.js trusts marks, so
  // the audit must surface the inconsistency instead of silently recomputing.
  const storeDir = path.join(memoryDir, 'sessions', 'session-current')
  const poisonedPath = path.join(storeDir, 'index.json')
  const poisoned = JSON.parse(fs.readFileSync(poisonedPath, 'utf8'))
  const victimId = poisoned.folders[0].id
  poisoned.folders[0].pendingEra = 'synthetic'
  writeJson(poisonedPath, poisoned)

  const audit = auditMemory(memoryDir)
  const session = audit.sessions.find((entry) => entry.session === 'session-current')
  assert.equal(session.inconsistentMarks, 1)
  assert.equal(session.buckets.synthetic.folders, 1, 'the mark wins for the bucket (engine/era.js contract)')
  assert.equal(audit.warnings.length, 1)
  assert.match(audit.warnings[0], /pendingEra 标记与当前判定不一致/)

  const applied = runJson(['--memory', memoryDir, '--apply'])
  assert.equal(applied.status, 0)
  assert.equal(applied.json.apply.entriesMarked, 1, 'exactly the stale mark was corrected')
  const healed = auditMemory(memoryDir)
  assert.deepEqual(healed.warnings, [])
  assert.deepEqual(
    healed.sessions.find((entry) => entry.session === 'session-current').buckets.current,
    { folders: 4, scored: 3, pending: 1 },
  )
  assert.equal(JSON.parse(fs.readFileSync(poisonedPath, 'utf8')).folders[0].pendingEra, 'current')
  assert.equal(victimId, JSON.parse(fs.readFileSync(poisonedPath, 'utf8')).folders[0].id)
})

test('memory-audit: --apply on a temp copy of real sessions writes only index.json (source untouched)', (t) => {
  const sessionsRoot = path.join(REAL_MEMORY, 'sessions')
  if (!fs.existsSync(sessionsRoot)) {
    t.skip('no real memory/ in this checkout')
    return
  }
  const wanted = ['qqb-g-1134030529', 'session-82fa546a-c9b1-420b-908c-3f5694ffe814']
  const names = wanted.filter((name) => fs.existsSync(path.join(sessionsRoot, name, 'index.json')))
  if (names.length === 0) {
    t.skip('the documented real sessions are not present')
    return
  }
  // Copy (never move/write) the real sessions into a throw-away memory root.
  const tempMemory = path.join(makeTempDir(), 'memory')
  for (const name of names) {
    fs.cpSync(path.join(sessionsRoot, name), path.join(tempMemory, 'sessions', name), { recursive: true })
  }
  const sourceMtimes = new Map(
    names.map((name) => [name, fs.statSync(path.join(sessionsRoot, name, 'index.json')).mtimeMs]),
  )
  const before = snapshotFiles(tempMemory)
  const { status, json } = runJson(['--memory', tempMemory, '--apply'])
  assert.equal(status, 0, JSON.stringify(json.apply))
  assert.deepEqual(json.apply.errors, [])
  assert.equal(json.apply.entriesMarked, 110, '10 qqb folders + 100 legacy folders')

  // Only the copied index.json files changed; meta/context/telemetry untouched.
  const after = snapshotFiles(tempMemory)
  for (const [file, snapshot] of before) {
    if (path.basename(file) === 'index.json') continue
    const current = after.get(file)
    assert.equal(current.mtimeMs, snapshot.mtimeMs, `${file} must not be written by --apply`)
    assert.equal(Buffer.compare(current.bytes, snapshot.bytes), 0, `${file} bytes must not change`)
  }
  assert.equal(after.get(path.join('sessions', names[0], 'index.json')).mtimeMs !== undefined, true)

  // The marks follow the real folder data: qqb-g is current, 82fa546a is legacy.
  const qqbIndex = JSON.parse(fs.readFileSync(path.join(tempMemory, 'sessions', 'qqb-g-1134030529', 'index.json'), 'utf8'))
  assert.equal(qqbIndex.folders.every((folder) => folder.pendingEra === 'current'), true)
  let legacyIndex = null
  for (const name of names) {
    if (!name.startsWith('session-82fa546a')) continue
    legacyIndex = JSON.parse(fs.readFileSync(path.join(tempMemory, 'sessions', name, 'index.json'), 'utf8'))
    assert.equal(legacyIndex.folders.every((folder) => folder.pendingEra === 'legacy'), true)
    assert.equal(legacyIndex.folders.filter((folder) => folder.scored === false).length, 94)
  }
  if (legacyIndex === null) t.skip('82fa546a not present')

  // The REAL source files were never touched by the copy+apply round trip.
  for (const [name, mtimeMs] of sourceMtimes) {
    assert.equal(fs.statSync(path.join(sessionsRoot, name, 'index.json')).mtimeMs, mtimeMs, `${name} source index must not change`)
  }
})

test('memory-audit CLI: --help exits 0 and documents the shared era rules and flags', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  const stdout = String(result.stdout)
  assert.match(stdout, /用法/)
  for (const token of ['--memory', '--json', '--verbose', '--limit', '--apply', '--help']) {
    assert.ok(stdout.includes(token), `help mentions ${token}`)
  }
  assert.ok(stdout.includes(LEGACY_BOUNDARY_ISO), 'help documents the legacy boundary')
  assert.ok(stdout.includes('engine/era.js'), 'help points at the shared era module')
  assert.ok(stdout.includes(String(SYNTHETIC_WINDOW_TOKENS)))
  assert.ok(stdout.includes(String(SYNTHETIC_BEFORE_PERCENT)))
  assert.ok(stdout.includes(String(STRESS_MIN_FOLDERS)))
  assert.ok(stdout.includes(String(STRESS_MIN_PENDING)))
  // Lead decision: --json keeps `era` and `dominantEra` separate (legacy is a
  // per-folder property) and keeps `inconsistentMarks`; the help must say so.
  assert.ok(stdout.includes('dominantEra'), 'help documents the folder-bucket era field')
  assert.ok(stdout.includes('inconsistentMarks'), 'help documents stale pendingEra mark reporting')
  assert.match(stdout, /不合并/)
  assert.match(stdout, /只读/)
})

test('memory-audit CLI: human output is a table with calibers and session notes', () => {
  const memoryDir = buildFixture()
  const result = runCli(['--memory', memoryDir])
  assert.equal(result.status, 0, result.stderr)
  const stdout = String(result.stdout)
  assert.match(stdout, /=== dsh-rofm 记忆时代审计/)
  assert.match(stdout, /read-only\s+:\s+是/)
  assert.match(stdout, /legacy\s+3\s+1\s+2/)
  assert.match(stdout, /synthetic\s+120\s+0\s+120/)
  assert.match(stdout, /current\s+14\s+11\s+3/)
  assert.match(stdout, /A: 125\/137/)
  assert.match(stdout, /C: 3\/14/)
  assert.match(stdout, /session-synthetic/)
  assert.match(stdout, /fakeWindow=true, stressBacklog=false/, 'channel session note explains why it is current')

  const verbose = runCli(['--memory', memoryDir, '--verbose', '--limit', '2'])
  assert.equal(verbose.status, 0, verbose.stderr)
  const verboseOut = String(verbose.stdout)
  assert.match(verboseOut, /明细（--verbose，每类最多 2 条）/)
  assert.match(verboseOut, /mem-2026/)
  assert.match(verboseOut, /current pending ids:/)
})

test('memory-audit CLI: missing memory dir and invalid options are handled', () => {
  const missing = path.join(makeTempDir(), 'does-not-exist')
  const { status, json } = runJson(['--memory', missing])
  assert.equal(status, 0, 'a missing memory dir is reported, not a crash')
  assert.equal(json.totals.folders, 0)
  assert.equal(json.totals.stores, 0)
  assert.equal(json.warnings.length, 1)
  assert.match(json.warnings[0], /不存在/)

  const unknown = runCli(['--bogus'])
  assert.equal(unknown.status, 1)
  assert.match(String(unknown.stderr), /unknown option/)

  const badLimit = runCli(['--limit', 'abc'])
  assert.equal(badLimit.status, 1)
  assert.match(String(badLimit.stderr), /--limit/)

  const negativeLimit = runCli(['--limit=-1'])
  assert.equal(negativeLimit.status, 1)
})

test('memory-audit CLI: --json --verbose carries limited samples', () => {
  const memoryDir = buildFixture()
  const { status, json } = runJson(['--memory', memoryDir, '--verbose', '--limit', '3'])
  assert.equal(status, 0)
  assert.equal(json.sampleLimit, 3)
  assert.equal(json.samples.legacy.length, 3)
  assert.equal(json.samples.synthetic.length, 3)
  assert.equal(json.samples.current.length, 3)
  for (const sample of json.samples.synthetic) {
    assert.match(sample.id, /^mem-/)
    assert.equal(sample.era, 'synthetic')
  }
})

// ---------------------------------------------------------------------------
// 4. real data: read-only regression against the documented 2026-11-01 snapshot
// ---------------------------------------------------------------------------

function realMemoryStores() {
  try {
    return findStores(REAL_MEMORY)
  } catch {
    return []
  }
}

test('memory-audit: real memory/ is only read and reproduces the documented data-era split', (t) => {
  const stores = realMemoryStores()
  if (stores.length === 0) {
    t.skip('no real memory/ in this checkout')
    return
  }
  const before = snapshotFiles(REAL_MEMORY)

  const { status, json } = runJson(['--memory', REAL_MEMORY])
  assert.equal(status, 0, 'the guard gate `node tools/memory-audit.mjs --json` must exit 0')
  assert.equal(json.readOnly, true)

  // Nothing under memory/ may change — not even an mtime.
  const after = snapshotFiles(REAL_MEMORY)
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'the real memory dir must not gain/lose files')
  for (const [file, snapshot] of before) {
    const current = after.get(file)
    assert.equal(current.mtimeMs, snapshot.mtimeMs, `${file} mtime must not change`)
    assert.equal(Buffer.compare(current.bytes, snapshot.bytes), 0, `${file} bytes must not change`)
  }
  assert.equal(json.warnings.length, 0, JSON.stringify(json.warnings))

  // Structural invariants hold on any dataset.
  const bucketFolders = ERAS.reduce((sum, era) => sum + json.buckets[era].folders, 0)
  const bucketPending = ERAS.reduce((sum, era) => sum + json.buckets[era].pending, 0)
  assert.equal(bucketFolders, json.totals.folders)
  assert.equal(bucketPending, json.totals.pending)
  assert.equal(json.calibers.A.folders, json.totals.folders)
  assert.equal(json.calibers.B.folders, json.totals.folders - json.buckets.legacy.folders)
  assert.equal(json.calibers.C.folders, json.buckets.current.folders)
  // v1.4.0 event tag summary is always present and internally consistent.
  assert.ok(Number.isInteger(json.events.foldersWithEvent))
  assert.ok(Number.isInteger(json.events.distinctEvents))
  assert.ok(Array.isArray(json.events.top))
  assert.ok(json.events.foldersWithEvent <= json.totals.folders)
  assert.ok(json.events.top.length <= 5)
  assert.equal(json.events.top.reduce((sum, event) => sum + event.count, 0) <= json.events.foldersWithEvent, true)
  for (const session of json.sessions) {
    assert.ok(['synthetic', 'current'].includes(session.era), 'session era is session-level from engine/era.js')
    if (session.dominantEra !== 'legacy') continue
    assert.equal(session.createdAt.max < LEGACY_ERA_CUTOFF_MS, true, `${session.session} must be entirely pre-v1.2.0`)
  }

  // On the documented 2026-11-01 snapshot the tool must reproduce plan §2.2/§9.2
  // exactly; if this checkout's real data evolved, only the structural checks
  // above apply (the tool is right, the snapshot moved).
  const documentedSnapshot = json.totals.folders === 3742 && json.totals.scored === 973 && json.totals.pending === 2769
  if (documentedSnapshot) {
    assert.equal(json.totals.stores, 21)
    assert.equal(json.totals.sessions, 6, 'the 15 empty onebot-* leftovers stay out of the buckets')
    assert.deepEqual(
      {
        legacy: { folders: json.buckets.legacy.folders, scored: json.buckets.legacy.scored, pending: json.buckets.legacy.pending },
        synthetic: {
          folders: json.buckets.synthetic.folders,
          scored: json.buckets.synthetic.scored,
          pending: json.buckets.synthetic.pending,
        },
        current: { folders: json.buckets.current.folders, scored: json.buckets.current.scored, pending: json.buckets.current.pending },
      },
      {
        legacy: { folders: 593, scored: 6, pending: 587 },
        synthetic: { folders: 2780, scored: 600, pending: 2180 },
        current: { folders: 369, scored: 367, pending: 2 },
      },
    )
    assert.equal(json.totals.pendingPercent, 74)
    assert.equal(json.totals.currentPendingPercent, 0.54)
    assert.equal(json.calibers.A.pending, 2769)
    assert.equal(json.calibers.A.pendingPercent, 74)
    assert.equal(json.calibers.B.pending, 2182)
    assert.equal(json.calibers.B.folders, 3149)
    assert.equal(json.calibers.C.pending, 2)
    assert.equal(json.calibers.C.folders, 369)
    assert.equal(json.calibers.C.pendingPercent, 0.54)
    assert.equal(json.calibers.D.pending, 0)
    assert.equal(json.calibers.D.folders, 359)
    assert.equal(json.currentPending.length, 2, 'the current-real pending ids are qqb-g\'s two folders')

    const bySession = new Map(json.sessions.map((session) => [session.session, session]))
    const find = (prefix) => bySession.get([...bySession.keys()].find((name) => name.startsWith(prefix)))
    // The three pre-1.2.0 sessions are legacy per folder (session era is current).
    for (const [prefix, expected] of [
      ['session-82fa546a', [100, 6, 94]],
      ['session-5998f1f6', [100, 0, 100]],
      ['session-f908562e', [393, 0, 393]],
    ]) {
      const entry = find(prefix)
      assert.equal(entry.dominantEra, 'legacy', `${prefix} folders must be legacy`)
      assert.deepEqual([entry.folders, entry.scored, entry.pending], expected)
      assert.equal(entry.era, 'current', 'the session itself has no fake window')
    }
    // a46df597 is the pressure test: synthetic (fake window + stress volume).
    const a46 = find('session-a46df597')
    assert.equal(a46.era, 'synthetic')
    assert.equal(a46.dominantEra, 'synthetic')
    assert.deepEqual([a46.folders, a46.scored, a46.pending], [2780, 600, 2180])
    assert.equal(a46.reasons.fakeWindow, true)
    assert.equal(a46.reasons.stressBacklog, true)
    // qqb-g keeps the 2000-token fake window but is current: 10 folders / 2 pending.
    const qqb = find('qqb-g-1134030529')
    assert.equal(qqb.era, 'current')
    assert.equal(qqb.dominantEra, 'current')
    assert.deepEqual([qqb.folders, qqb.scored, qqb.pending], [10, 8, 2])
    assert.deepEqual(qqb.reasons, {
      fakeWindow: true,
      tinyWindow: true,
      overWindow: true,
      windowTokens: 2000,
      maxBeforePercent: 1375.2,
      folders: 10,
      pending: 2,
      stressBacklog: false,
    })
    // b5eeee7e is the normal 1.3.0+ session: 359/359 scored, 0 pending.
    const b5 = find('session-b5eeee7e')
    assert.equal(b5.era, 'current')
    assert.equal(b5.dominantEra, 'current')
    assert.deepEqual([b5.folders, b5.scored, b5.pending], [359, 359, 0])
    assert.equal(b5.reasons.fakeWindow, false)
    assert.equal(b5.reasons.stressBacklog, true)
    assert.equal(b5.normalSession, true)
  }
})
