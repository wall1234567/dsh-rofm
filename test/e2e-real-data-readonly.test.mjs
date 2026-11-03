/**
 * E2E: the three read-only observers on the pinned fixture store (contract §1,
 * §10.8; plan §5.1 "real data", fix-plan §2.7 / audit F-04).
 *
 * v1.4.1: the test no longer reads the mutable repo `memory/` and no longer
 * hard-codes live snapshot numbers (4637/3742/2769/74%/0.54%/2/369). It runs
 * against `test/fixtures/memory-snapshot/memory`, a committed 25-folder fixture
 * with one legacy / one synthetic / one current store plus the real QQ channel
 * store (see the fixture README and manifest there), and DERIVES every expected
 * number from the fixture's own `index.json` / `meta.json` / `stats.jsonl` with
 * an independent mini-oracle (`readFixtureOracle` below). That makes the test
 * deterministic on any checkout (CI included) while still exercising the real
 * CLI invocations people and the release gate use:
 *
 *   memory-audit --json     era buckets + calibers A/B/C/D
 *   selfcheck --json        "pending era" / time index / event tag checks
 *   recall-report --json    "pending era" block
 *
 * The fixture invariants (25 folders / 4 stores / 5+5+15 era split / 2 current
 * pending / 5 images / 2 recall-state snapshots) are pinned as *fixture* facts:
 * if somebody edits the fixture, the derivation and the pinned facts disagree
 * and this test fails instead of silently changing what "real data" means.
 * The store is strictly read-only: no test writes inside the fixture tree.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const FIXTURE_ROOT = path.join(HERE, 'fixtures', 'memory-snapshot', 'memory')
const SESSIONS_DIR = path.join(FIXTURE_ROOT, 'sessions')
const NODE = process.execPath
/** The v1.2.0 tag boundary (engine/era.js): pre-1.2.0 folders are legacy. */
const LEGACY_ERA_CUTOFF_MS = Date.parse('2026-10-27T19:14:00Z')
/** era.js synthetic signals (independent re-implementation, see oracle below). */
const SYNTHETIC_WINDOW_TOKENS = 32000
const SYNTHETIC_BEFORE_PERCENT = 500
const STRESS_MIN_FOLDERS = 100
const STRESS_MIN_PENDING = 100
const WINDOW_EVENT_TYPES = new Set(['compress', 'compress-applied', 'archive'])

/**
 * Fixture invariants (stable test data, NOT a live snapshot). See
 * `test/fixtures/memory-snapshot/README.md`.
 */
const PINNED = Object.freeze({
  stores: 4,
  sessions: 4,
  buckets: {
    legacy: { folders: 5, scored: 0, pending: 5 },
    synthetic: { folders: 5, scored: 0, pending: 5 },
    current: { folders: 15, scored: 13, pending: 2 },
  },
  totals: { folders: 25, scored: 13, pending: 12 },
  currentPendingCount: 2,
  images: 5,
  recallStateFiles: 2,
})

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function listSessionDirs() {
  return readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function readStatsEvents(storeDir) {
  const file = path.join(storeDir, 'stats.jsonl')
  if (!existsSync(file)) return []
  const events = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed)
    } catch {
      /* best effort, same as engine/store.js readStats */
    }
  }
  return events
}

const emptyBucket = () => ({ folders: 0, scored: 0, pending: 0 })

/**
 * Independent oracle: re-derive every number the tools report from the fixture
 * files themselves (never from the tools and never from a live snapshot).
 */
function readFixtureOracle() {
  const buckets = { legacy: emptyBucket(), synthetic: emptyBucket(), current: emptyBucket() }
  const stores = []
  const folders = []
  let eventFolders = 0
  let imageFiles = 0
  let recallStateFiles = 0
  for (const dir of listSessionDirs()) {
    const storeDir = path.join(SESSIONS_DIR, dir)
    const index = readJson(path.join(storeDir, 'index.json'))
    const entries = index.folders.filter((entry) => entry && typeof entry.id === 'string')
    const pending = entries.filter((entry) => entry.scored === false).length
    // --- engine/era.js session level, re-implemented without importing it ---
    let windowTokens = null
    let maxBeforePercent = null
    let fakeWindow = false
    for (const event of readStatsEvents(storeDir)) {
      if (typeof event.type === 'string' && !WINDOW_EVENT_TYPES.has(event.type)) continue
      const tokens = Number(event.windowTokens)
      const before = Number(event.beforePercent)
      if (Number.isFinite(tokens) && tokens > 0) {
        if (windowTokens === null || tokens < windowTokens) windowTokens = tokens
        if (tokens < SYNTHETIC_WINDOW_TOKENS) fakeWindow = true
      }
      if (Number.isFinite(before)) {
        if (maxBeforePercent === null || before > maxBeforePercent) maxBeforePercent = before
        if (before > SYNTHETIC_BEFORE_PERCENT) fakeWindow = true
      }
    }
    const stressBacklog = entries.length >= STRESS_MIN_FOLDERS || pending >= STRESS_MIN_PENDING
    const sessionEra = fakeWindow && stressBacklog ? 'synthetic' : 'current'
    // --- folder level: existing pendingEra mark wins, else createdAt cutoff,
    // else the session era (exactly engine/era.js classifyFolderEra) ----------
    for (const entry of entries) {
      let era
      if (['legacy', 'synthetic', 'current'].includes(entry.pendingEra)) era = entry.pendingEra
      else if (Number.isFinite(Number(entry.createdAt)) && Number(entry.createdAt) < LEGACY_ERA_CUTOFF_MS) era = 'legacy'
      else era = sessionEra
      const scored = entry.scored !== false
      buckets[era].folders += 1
      if (scored) buckets[era].scored += 1
      else buckets[era].pending += 1
      if (typeof entry.event === 'string' && entry.event.trim().length > 0) eventFolders += 1
      folders.push({ store: dir, entry, era, scored })
    }
    // images/index.json integrity + recall-state snapshots are fixture facts too.
    const imagesDir = path.join(storeDir, 'images')
    if (existsSync(imagesDir) && existsSync(path.join(imagesDir, 'index.json'))) {
      imageFiles += readJson(path.join(imagesDir, 'index.json')).images.length
    }
    const stateFile = path.join(storeDir, 'recall-state.json')
    if (existsSync(stateFile)) recallStateFiles += 1
    if (entries.length > 0) stores.push({ dir, storeDir, entries, sessionEra, fakeWindow, stressBacklog })
  }
  const totals = {
    folders: buckets.legacy.folders + buckets.synthetic.folders + buckets.current.folders,
    scored: buckets.legacy.scored + buckets.synthetic.scored + buckets.current.scored,
    pending: buckets.legacy.pending + buckets.synthetic.pending + buckets.current.pending,
  }
  return {
    stores,
    buckets,
    totals,
    folders,
    eventFolders,
    imageFiles,
    recallStateFiles,
    currentPending: folders.filter((folder) => folder.era === 'current' && !folder.scored).map((folder) => folder.entry.id),
  }
}

const FIXTURE = readFixtureOracle()

/** The two-decimal percentage the tools report (0 folders => 0). */
function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 10000) / 100 : 0
}

/** The `{folders, scored, pending}` triple of one era bucket. */
function bucketOf(audit, era) {
  const bucket = audit?.buckets?.[era] ?? {}
  return { folders: bucket.folders, scored: bucket.scored, pending: bucket.pending }
}

/** One temp dir that the read-only observer tests may use for `--sessions-dir`. */
function makeNeutralSessions() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-e2e-'))
  const sessionsDir = path.join(dir, 'sessions')
  return { dir, sessionsDir }
}

/** A neutral DSH profile so selfcheck's compat lines never depend on the host. */
function makeNeutralProfile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-e2e-profile-'))
  const profile = path.join(dir, 'profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'neutral-e2e-profile', private: true }), 'utf8')
  return profile
}

/** Run one tool exactly like the documented gate does (zero deps, real CLI). */
function runTool(script, args = [], options = {}) {
  const result = spawnSync(NODE, [script, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: Number(options.timeoutMs) || 120_000,
    // A read-only tool must never need stdin; closing it avoids a hung child.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_ROFM_READONLY_E2E: '1', ...(options.env || {}) },
  })
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  }
}

function parseJsonOutput(label, result) {
  assert.equal(result.error, undefined, `${label} must execute (spawn error: ${result.error?.message})`)
  assert.equal(result.status, 0, `${label} must exit 0 (stderr: ${result.stderr.slice(0, 800)})`)
  const text = result.stdout.trim()
  assert.ok(text.length > 0, `${label} must print JSON on stdout`)
  try {
    return JSON.parse(text)
  } catch (error) {
    assert.fail(`${label} stdout is not JSON: ${error.message}; first 400 chars: ${text.slice(0, 400)}`)
  }
}

/** Recursive (path -> {size, mtimeMs}) snapshot; symlinks are not followed. */
function snapshotTree(root) {
  const snapshot = new Map()
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      snapshot.set(prefix || '.', { error: String(error && error.code) })
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
      let stat
      try {
        stat = statSync(full)
      } catch (error) {
        snapshot.set(rel, { error: String(error && error.code) })
        continue
      }
      if (entry.isDirectory()) {
        snapshot.set(`${rel}/`, { directory: true, mtimeMs: stat.mtimeMs })
        walk(full, rel)
      } else {
        snapshot.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
  }
  if (existsSync(root)) walk(root, '')
  return snapshot
}

function diffSnapshots(before, after) {
  const diffs = []
  for (const [rel, value] of before) {
    const next = after.get(rel)
    if (next === undefined) {
      diffs.push(`-${rel}`)
      continue
    }
    if (JSON.stringify(value) !== JSON.stringify(next)) diffs.push(`~${rel}`)
  }
  for (const rel of after.keys()) if (!before.has(rel)) diffs.push(`+${rel}`)
  return diffs
}

function imagesInFixture() {
  const images = []
  for (const store of FIXTURE.stores) {
    const imagesDir = path.join(store.storeDir, 'images')
    const indexFile = path.join(imagesDir, 'index.json')
    if (!existsSync(indexFile)) continue
    const index = readJson(indexFile)
    for (const image of index.images || []) {
      images.push({ store: store.dir, name: image.name, bytes: image.bytes, imagesDir })
    }
  }
  return images
}

/**
 * Copy the committed fixture to a temp dir for the two tests that build an
 * in-memory engine / construct the plugin. Those code paths may persist derived
 * state (the engine can rewrite/normalise index.json on load, and a restore may
 * touch the store), so they run on a throw-away copy while the committed
 * fixture stays byte-identical.
 */
function copyFixtureToTemp() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-e2e-copy-'))
  const memoryRoot = path.join(tmp, 'memory')
  cpSync(FIXTURE_ROOT, memoryRoot, { recursive: true })
  const stores = listSessionDirsAt(memoryRoot).map((dir) => {
    const storeDir = path.join(memoryRoot, 'sessions', dir)
    const entries = readJson(path.join(storeDir, 'index.json')).folders ?? []
    return { dir, storeDir, entries }
  })
  return { tmp, memoryRoot, stores }
}

/** Session store directory names under one fixture memory root. */
function listSessionDirsAt(memoryRoot) {
  return readdirSync(path.join(memoryRoot, 'sessions'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

// ---------------------------------------------------------------------------
// 1. fixture integrity (pinned facts + derivation agreement)
// ---------------------------------------------------------------------------

test('fixture: the pinned memory-snapshot is complete and agrees with its derivation', () => {
  assert.equal(existsSync(SESSIONS_DIR), true, 'test/fixtures/memory-snapshot/memory/sessions must exist')
  assert.equal(FIXTURE.stores.length, PINNED.stores, 'fixture store count')
  assert.equal(FIXTURE.totals.folders, PINNED.totals.folders, 'fixture folder total')
  assert.deepEqual(FIXTURE.buckets, PINNED.buckets, 'fixture era buckets (legacy / synthetic / current)')
  assert.deepEqual(FIXTURE.totals, PINNED.totals, 'fixture scored/pending totals')
  assert.equal(FIXTURE.currentPending.length, PINNED.currentPendingCount, 'fixture current pending folders')
  assert.equal(FIXTURE.imageFiles, PINNED.images, 'fixture archived images')
  assert.equal(FIXTURE.recallStateFiles, PINNED.recallStateFiles, 'fixture recall-state snapshots')

  // The fixture must exercise all three eras and both scored/pending folders.
  for (const era of ['legacy', 'synthetic', 'current']) {
    assert.ok(FIXTURE.buckets[era].folders > 0, `fixture has ${era} folders`)
  }
  assert.ok(FIXTURE.buckets.current.pending > 0, 'fixture has current-era pending folders')
  assert.ok(FIXTURE.buckets.current.scored > 0, 'fixture has current-era scored folders')

  // Every store: index ↔ disk reconciliation, valid meta, context present.
  for (const store of FIXTURE.stores) {
    const ids = new Set(store.entries.map((entry) => entry.id))
    const diskDirs = readdirSync(store.storeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'images')
      .map((entry) => entry.name)
    for (const id of ids) {
      assert.equal(existsSync(path.join(store.storeDir, id, 'meta.json')), true, `${store.dir}/${id}: meta.json exists`)
      assert.equal(existsSync(path.join(store.storeDir, id, 'context.json')), true, `${store.dir}/${id}: context.json exists`)
    }
    for (const dir of diskDirs) {
      assert.ok(ids.has(dir), `${store.dir}/${dir} exists on disk but is not indexed`)
    }
  }

  // The synthetic store must carry the fake-window evidence even though its
  // folder count is below era.js's stress threshold (that is what the pinned
  // `pendingEra: "synthetic"` marks are for; see the fixture README).
  const syntheticStore = FIXTURE.stores.find((store) => store.dir.includes('synthetic'))
  assert.ok(syntheticStore, 'fixture has a synthetic store')
  assert.equal(syntheticStore.fakeWindow, true, 'the synthetic store keeps a fake-window stats event')
  assert.equal(syntheticStore.sessionEra, 'current', '5 folders are below the stress threshold, so session era is current')

  // The legacy store is legacy purely by createdAt (no mark needed).
  const legacyStore = FIXTURE.stores.find((store) => store.dir.includes('legacy'))
  assert.ok(legacyStore, 'fixture has a legacy store')
  assert.equal(legacyStore.entries.every((entry) => Number(entry.createdAt) < LEGACY_ERA_CUTOFF_MS), true)

  // Image bytes referenced by images/index.json exist and match their sizes.
  for (const image of imagesInFixture()) {
    const file = path.join(image.imagesDir, image.name)
    assert.equal(existsSync(file), true, `${image.store}: image ${image.name} exists`)
    if (Number.isFinite(image.bytes)) assert.equal(statSync(file).size, image.bytes, `${image.store}: ${image.name} size matches images/index.json`)
  }
})

// ---------------------------------------------------------------------------
// 2. memory-audit --json
// ---------------------------------------------------------------------------

test('memory-audit --json matches the fixture oracle', () => {
  const audit = parseJsonOutput(
    'node tools/memory-audit.mjs --json',
    runTool('tools/memory-audit.mjs', ['--json', '--memory', FIXTURE_ROOT]),
  )
  assert.equal(audit.tool, 'dsh-rofm-memory-audit', 'the audit tool identifies itself')
  assert.equal(audit.readOnly, true, 'the audit is read-only by default')
  assert.equal(audit.eraRules, 'engine/era.js', 'era classification has one truth (contract §11.1)')
  assert.equal(audit.layout, 'per-session', 'the fixture is a per-session store')
  // The synthetic store expresses its era through the engine-supported
  // `pendingEra` mark (5 folders are below era.js's stress threshold), so the
  // audit correctly reports those marks as "not matching a fresh classification"
  // — that is a known, explained fixture property, not a data problem.
  assert.equal(audit.warnings.length, 1, JSON.stringify(audit.warnings))
  assert.match(audit.warnings[0], /pendingEra 标记与当前判定不一致/)
  assert.match(audit.warnings[0], /session-synthetic-a46df597/)

  for (const era of ['legacy', 'synthetic', 'current']) {
    assert.deepEqual(bucketOf(audit, era), FIXTURE.buckets[era], `memory-audit ${era} bucket matches the fixture`)
  }
  assert.deepEqual(
    { folders: audit.totals.folders, scored: audit.totals.scored, pending: audit.totals.pending },
    FIXTURE.totals,
    'memory-audit totals are the bucket sum',
  )
  assert.equal(audit.totals.stores, FIXTURE.stores.length, 'memory-audit store count')
  assert.equal(audit.totals.sessions, FIXTURE.stores.length, 'all fixture stores are non-empty')
  assert.equal(audit.totals.pendingPercent, pct(FIXTURE.totals.pending, FIXTURE.totals.folders), 'all-stock pending share formula')
  assert.equal(
    audit.totals.currentPendingPercent,
    pct(FIXTURE.buckets.current.pending, FIXTURE.buckets.current.folders),
    'current-era pending share formula',
  )

  // Calibers A/B/C/D are derivations of the same numbers, not constants.
  assert.equal(audit.calibers.A.pending, FIXTURE.totals.pending)
  assert.equal(audit.calibers.A.pendingPercent, audit.totals.pendingPercent)
  assert.equal(audit.calibers.B.pending, FIXTURE.totals.pending - FIXTURE.buckets.legacy.pending)
  assert.equal(audit.calibers.B.pendingPercent, pct(audit.calibers.B.pending, audit.calibers.B.folders))
  assert.deepEqual(
    { folders: audit.calibers.C.folders, pending: audit.calibers.C.pending },
    { folders: FIXTURE.buckets.current.folders, pending: FIXTURE.buckets.current.pending },
  )
  assert.equal(audit.calibers.C.pendingPercent, pct(audit.calibers.C.pending, audit.calibers.C.folders))
  assert.ok(audit.calibers.D.folders >= 0)

  assert.deepEqual([...audit.currentPending].sort(), [...FIXTURE.currentPending].sort(), 'the current pending ids are the QQ store pending folders')

  // Session-level facts follow the same oracle (b5eeee7e-style current store).
  for (const store of FIXTURE.stores) {
    const session = (audit.sessions ?? []).find((entry) => String(entry.session) === store.dir || String(entry.dir).endsWith(store.dir))
    assert.ok(session, `${store.dir} is audited`)
    assert.equal(session.folders, store.entries.length, `${store.dir}: folder count`)
    assert.equal(session.scored + session.pending, session.folders, `${store.dir}: scored + pending = folders`)
  }
})

// ---------------------------------------------------------------------------
// 3. selfcheck --json
// ---------------------------------------------------------------------------

test('selfcheck --json agrees with the fixture oracle and reports 0 failed checks', () => {
  const { dir: tmp, sessionsDir } = makeNeutralSessions()
  try {
    const profile = makeNeutralProfile()
    const selfcheck = parseJsonOutput(
      'node tools/selfcheck.mjs --json',
      runTool('tools/selfcheck.mjs', ['--json', '--memory-dir', FIXTURE_ROOT, '--sessions-dir', sessionsDir], {
        env: { DSH_PROFILE_DIR: profile },
      }),
    )
    assert.equal(selfcheck.exitCode, 0, 'selfcheck exits 0 on the fixture')
    assert.equal(selfcheck.summary?.failed, 0, 'selfcheck reports 0 failed checks')

    const eraCheck = (selfcheck.checks ?? []).find((check) => check.name === 'pending era')
    assert.ok(eraCheck, 'selfcheck has a "pending era" check')
    assert.equal(eraCheck.data?.currentPendingPercent, auditCurrentPendingPercent(), 'selfcheck current pending share formula')
    for (const era of ['legacy', 'synthetic', 'current']) {
      assert.deepEqual(eraCheck.data?.buckets?.[era], FIXTURE.buckets[era], `selfcheck ${era} bucket matches the fixture`)
    }
    assert.deepEqual(
      eraCheck.data?.totals,
      { folders: FIXTURE.totals.folders, scored: FIXTURE.totals.scored, pending: FIXTURE.totals.pending },
      'selfcheck totals match the fixture',
    )
    // 2/15 = 13.33% current pending: the 15-folder bucket is below the 20-folder
    // judgement floor, so the thresholds are not applied and the v1.4.1 T-14
    // behaviour reports the 2 unjudged pending folders as a WARN (never FAIL).
    assert.equal(eraCheck.status, 'WARN', eraCheck.detail)
    assert.match(eraCheck.detail, /2 pending folder\(s\) not judged at this sample size/)

    const memoryStore = (selfcheck.checks ?? []).find((check) => check.name === 'memory store')
    assert.equal(memoryStore.status, 'PASS', memoryStore.detail)

    const timeCheck = (selfcheck.checks ?? []).find((check) => check.name === 'time index')
    assert.equal(timeCheck.status, 'PASS', timeCheck.detail)
    assert.deepEqual(timeCheck.data?.issues, [], 'no time-index issues on the fixture')

    const eventCheck = (selfcheck.checks ?? []).find((check) => check.name === 'event tags')
    assert.equal(eventCheck.status, 'PASS', 'event tags are INFO only')
    assert.equal(eventCheck.data?.foldersWithEvent, FIXTURE.eventFolders, 'event tag count matches the fixture')
    assert.equal(eventCheck.data?.folders, FIXTURE.totals.folders, 'the event audit covers every indexed folder')

    // Empty sessions fixture: the session-log check is a WARN, never a FAIL.
    const sessionLogs = (selfcheck.checks ?? []).find((check) => check.name === 'session logs')
    assert.notEqual(sessionLogs.status, 'FAIL', 'an empty sessions fixture must not fail the session-log check')
    assert.equal(tmp !== '', true)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

/** Derived current-pending percentage shared by the observer tests. */
function auditCurrentPendingPercent() {
  return pct(FIXTURE.buckets.current.pending, FIXTURE.buckets.current.folders)
}

// ---------------------------------------------------------------------------
// 4. recall-report --json
// ---------------------------------------------------------------------------

test('recall-report --json agrees with the fixture oracle', () => {
  const report = parseJsonOutput(
    'node tools/recall-report.mjs --json',
    runTool('tools/recall-report.mjs', ['--json', '--dir', FIXTURE_ROOT]),
  )
  const eras = report.pendingEras
  assert.ok(eras, 'recall-report carries the pending-era block')
  for (const era of ['legacy', 'synthetic', 'current']) {
    assert.deepEqual(bucketOf(eras, era), FIXTURE.buckets[era], `recall-report ${era} bucket matches the fixture`)
  }
  assert.equal(eras.totals.pendingPercent, pct(FIXTURE.totals.pending, FIXTURE.totals.folders), 'all-stock pending formula')
  assert.equal(eras.totals.currentPendingPercent, auditCurrentPendingPercent(), 'current pending formula')
  assert.equal(eras.calibers.C.pendingPercent, auditCurrentPendingPercent(), 'caliber C agrees')
  assert.deepEqual([...eras.currentPending].sort(), [...FIXTURE.currentPending].sort(), 'the same current pending ids')
  // Same single, explained fixture warning as memory-audit (synthetic marks).
  assert.equal(eras.warnings.length, 1, JSON.stringify(eras.warnings))
  assert.match(eras.warnings[0], /pendingEra 标记与当前判定不一致/)
})

// ---------------------------------------------------------------------------
// 5. The three observers must agree with each other (triangulation)
// ---------------------------------------------------------------------------

test('the three read-only observers agree on every fixture era number', () => {
  const { dir: tmp, sessionsDir } = makeNeutralSessions()
  try {
    const profile = makeNeutralProfile()
    const audit = parseJsonOutput('memory-audit', runTool('tools/memory-audit.mjs', ['--json', '--memory', FIXTURE_ROOT]))
    const selfcheck = parseJsonOutput(
      'selfcheck',
      runTool('tools/selfcheck.mjs', ['--json', '--memory-dir', FIXTURE_ROOT, '--sessions-dir', sessionsDir], {
        env: { DSH_PROFILE_DIR: profile },
      }),
    )
    const report = parseJsonOutput('recall-report', runTool('tools/recall-report.mjs', ['--json', '--dir', FIXTURE_ROOT]))
    const eraCheck = (selfcheck.checks ?? []).find((check) => check.name === 'pending era')
    for (const era of ['legacy', 'synthetic', 'current']) {
      const auditBucket = bucketOf(audit, era)
      assert.deepEqual(bucketOf({ buckets: eraCheck.data.buckets }, era), auditBucket, `selfcheck vs memory-audit (${era})`)
      assert.deepEqual(bucketOf(report.pendingEras, era), auditBucket, `recall-report vs memory-audit (${era})`)
    }
    assert.deepEqual(
      [audit.totals.folders, audit.totals.scored, audit.totals.pending],
      [report.pendingEras.totals.folders, report.pendingEras.totals.scored, report.pendingEras.totals.pending],
      'totals agree between memory-audit and recall-report',
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. Read-only guarantee
// ---------------------------------------------------------------------------

test('running the three observers never modifies the fixture store', () => {
  const before = snapshotTree(FIXTURE_ROOT)
  assert.ok(before.size > 0, 'the fixture snapshot is non-empty')
  const { dir: tmp, sessionsDir } = makeNeutralSessions()
  try {
    const profile = makeNeutralProfile()
    const audit = runTool('tools/memory-audit.mjs', ['--json', '--memory', FIXTURE_ROOT])
    assert.equal(audit.status, 0, `memory-audit exits 0 (stderr: ${audit.stderr.slice(0, 400)})`)
    const selfcheck = runTool('tools/selfcheck.mjs', ['--json', '--memory-dir', FIXTURE_ROOT, '--sessions-dir', sessionsDir], {
      env: { DSH_PROFILE_DIR: profile },
    })
    assert.equal(selfcheck.status, 0, `selfcheck exits 0 (stderr: ${selfcheck.stderr.slice(0, 400)})`)
    const report = runTool('tools/recall-report.mjs', ['--json', '--dir', FIXTURE_ROOT])
    assert.equal(report.status, 0, `recall-report exits 0 (stderr: ${report.stderr.slice(0, 400)})`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  const after = snapshotTree(FIXTURE_ROOT)
  const diffs = diffSnapshots(before, after)
  assert.deepEqual(diffs, [], `read-only tools must not touch the fixture; changed: ${diffs.slice(0, 20).join(', ')}`)
  assert.equal(after.size, before.size, 'the fixture file count is unchanged')
})

// ---------------------------------------------------------------------------
// 7. Legacy recall-state v2 snapshots still restore through the plugin reader
// ---------------------------------------------------------------------------

test('the fixture recall-state v2 snapshots restore through the plugin read path', async () => {
  // `restoreRecallState` is the plugin's v1/v2 compatibility reader. It rebuilds
  // the injected block without starting the plugin. It runs on a temp copy of
  // the fixture because the plugin is allowed to persist derived engine state;
  // the committed fixture must stay byte-identical (asserted by the read-only
  // test and by the fixture-integrity test).
  const { RofmPlugin } = await import('../lib/plugin.js')
  const copy = copyFixtureToTemp()
  try {
    const storesWithState = copy.stores.filter((store) => existsSync(path.join(store.storeDir, 'recall-state.json')))
    assert.equal(storesWithState.length, PINNED.recallStateFiles, 'fixture has the expected recall-state snapshots')
    for (const store of storesWithState) {
      const cfg = {
        enabled: true,
        memoryDir: store.storeDir,
        recall: { enabled: true, persistInjected: true, maxRecalledBlocks: 64, maxRecalledChars: 120000 },
        scoring: {},
        storage: { dir: store.storeDir, perSession: false },
        compress: { contextWindowTokens: 0 },
        importance: {},
        keywords: {},
        compat: { qqBots: 'off' },
        logging: { enabled: false, verbose: false },
      }
      const fileState = readJson(path.join(store.storeDir, 'recall-state.json'))
      const plugin = new RofmPlugin(
        {
          logger: { info() {}, warn() {}, debug() {} },
          get() {
            return undefined
          },
          on() {
            return () => {}
          },
          effect(callback) {
            return callback()
          },
        },
        {},
      )
      const session = {
        id: store.dir,
        header: { origin: 'main' },
        surface: { nodes: [] },
        deriveMessages() {
          return []
        },
        eventAt() {
          return undefined
        },
        requestContext() {
          return { contextWindow: 1000000 }
        },
      }
      const state = plugin.sessionState(session)
      assert.ok(state, `${store.dir}: a fresh session state is created`)
      plugin.restoreRecallState(session, cfg)
      const restored = plugin.sessions.get(session)
      assert.ok(restored, `${store.dir}: the plugin keeps the restored session state`)
      const restoredText = typeof restored.text === 'string' ? restored.text : ''
      const restoredIds = Array.isArray(restored.additions) ? restored.additions.map((addition) => addition.id) : []
      const idsInFile = Array.isArray(fileState.ids) ? fileState.ids.map((entry) => entry.id) : []
      if (idsInFile.length === 0) {
        assert.equal(restoredText.length, 0, `${store.dir}: an empty legacy snapshot restores nothing and must not throw`)
      } else {
        assert.ok(restoredText.length > 0 || restoredIds.length > 0, `${store.dir}: a non-empty v2 snapshot restores text or ids`)
      }
    }
  } finally {
    rmSync(copy.tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 8. Event index builds safely on every fixture store (read-only derivation)
// ---------------------------------------------------------------------------

test('engine.eventIndex() builds safely for every fixture store', async () => {
  // The engine may normalise/persist its index on load, so this runs on a temp
  // copy; the committed fixture must stay untouched (asserted below).
  const before = snapshotTree(FIXTURE_ROOT)
  const copy = copyFixtureToTemp()
  try {
    const { MemoryEngine, loadConfig } = await import('../engine/index.js')
    const cfg = loadConfig(path.join(REPO, 'config.json'))
    for (const store of copy.stores) {
      const engine = new MemoryEngine({ memoryDir: store.storeDir, config: cfg })
      let eventIndex
      assert.doesNotThrow(() => {
        eventIndex = engine.eventIndex()
      }, `engine.eventIndex() must build safely for ${store.dir}`)
      assert.equal(eventIndex.folderCount, store.entries.length, `${store.dir}: the event index covers every folder`)
      const tagged = store.entries.filter((entry) => typeof entry.event === 'string' && entry.event.trim().length > 0).length
      assert.equal(eventIndex.byId.size, tagged, `${store.dir}: tagged folders in the event index`)
      if (tagged === 0) {
        assert.deepEqual(eventIndex.labels, [], `${store.dir}: no event buckets without labels`)
      } else {
        const bucketTotal = eventIndex.labels.reduce((sum, label) => sum + Number(label.count ?? 0), 0)
        assert.equal(bucketTotal, tagged, `${store.dir}: the event buckets sum to the tagged folder count`)
      }
      assert.ok(typeof eventIndex.signature === 'string' && eventIndex.signature.length > 0, 'the index carries a cache signature')
    }
  } finally {
    rmSync(copy.tmp, { recursive: true, force: true })
  }
  const after = snapshotTree(FIXTURE_ROOT)
  assert.deepEqual(diffSnapshots(before, after), [], 'the committed fixture must stay untouched')
})
