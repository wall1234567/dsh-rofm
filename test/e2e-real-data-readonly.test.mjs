/**
 * E2E: the real installed memory store, READ ONLY (plan §5.1 "真实数据" / §5.4,
 * contract §1 and §10.8).
 *
 * The v1.4.0 acceptance numbers are only meaningful if the three read-only
 * observers agree on the *same* real data:
 *
 *   memory-audit --json   era buckets + calibers A/B/C/D
 *   selfcheck --json      "pending era" check (INFO for legacy/synthetic,
 *                         only current pending can WARN/FAIL)
 *   recall-report --json  "pending era" block (lane/time/pending era)
 *
 * This test runs all three as real child processes (so the documented CLI
 * invocation is the thing under test, not internal functions), asserts the
 * documented 2026-11-01 snapshot (legacy 593/587, synthetic 2780/2180,
 * current 369/2, all-stock 2769/3742 = 74.0 %, current 2/369 = 0.54 %,
 * session-b5eeee7e 359/359 = 0), and proves the store was not touched by
 * snapshotting every file under `memory/sessions/**` (relative path ->
 * {mtimeMs, size}) before and after the three runs.
 *
 * The store is strictly read-only: this file never writes inside `memory/`,
 * never passes `--apply`, and skips (instead of failing) on a machine that has
 * no real store, so the suite stays green on CI checkouts.
 *
 * v1.4.0 addendum (event constraint): one extra read-only assertion builds the
 * in-memory `engine.eventIndex()` on the real legacy store — old data carries no
 * event labels (design §1.1: only a new `memory_judge` writes them), so the
 * index must build safely with zero labels, and the same `(path → size:mtimeMs)`
 * snapshot must show zero changes afterwards.
 *
 * The contract numbers are the *installed snapshot* (plan §2.2): a session that
 * legitimately archived new folders changes them. That is exactly why the test
 * hard-codes them — a silent change of the era split must be reviewed, not
 * absorbed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const MEMORY_DIR = path.join(REPO, 'memory')
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions')
const NODE = process.execPath

/** Documented 2026-11-01 snapshot (plan §2.2 "正确口径", contract §11.1). */
const EXPECTED = Object.freeze({
  legacy: { folders: 593, scored: 6, pending: 587 },
  synthetic: { folders: 2780, scored: 600, pending: 2180 },
  current: { folders: 369, scored: 367, pending: 2 },
  totals: { folders: 3742, scored: 973, pending: 2769, pendingPercent: 74, currentPendingPercent: 0.54 },
  currentPending: ['mem-20261031T120813Z-0001', 'mem-20261031T120813Z-0007'],
  b5: { folders: 359, scored: 359, pending: 0 },
})

/** Run one tool exactly like the documented gate does (zero deps, real CLI). */
function runTool(script, args = [], options = {}) {
  const result = spawnSync(NODE, [script, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: Number(options.timeoutMs) || 120_000,
    // A read-only tool must never need stdin; closing it avoids a hung child.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_ROFM_READONLY_E2E: '1' },
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

/**
 * Recursive (path -> {size, mtimeMs}) snapshot of a tree. Symlinks are recorded
 * as their own entries and never followed, so the walk itself cannot touch the
 * store. Returns a Map so a diff can name every changed file.
 */
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

/** First difference between two snapshots, as a readable list (empty = equal). */
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

function listSessionDirs() {
  if (!existsSync(SESSIONS_DIR)) return []
  try {
    return readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** The suite skips on machines/checkouts without the installed store. */
function storeSkipReason() {
  if (!existsSync(SESSIONS_DIR)) return 'real memory/sessions is not present in this checkout'
  const dirs = listSessionDirs()
  if (dirs.length === 0) return 'real memory/sessions has no session stores'
  let folders = 0
  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(SESSIONS_DIR, dir, 'index.json'), 'utf8'))
      folders += Array.isArray(parsed?.folders) ? parsed.folders.length : 0
    } catch {
      // A store without a readable index is reported by the dedicated test below.
    }
  }
  if (folders === 0) return 'real memory/sessions has no archived folders'
  return false
}

// ---------------------------------------------------------------------------
// Era numbers: the three observers must agree with the documented snapshot
// ---------------------------------------------------------------------------

test('memory-audit --json reports the documented era buckets on the real store', { skip: storeSkipReason() }, () => {
  const audit = parseJsonOutput('node tools/memory-audit.mjs --json', runTool('tools/memory-audit.mjs', ['--json']))

  assert.equal(audit.tool, 'dsh-rofm-memory-audit', 'the audit tool identifies itself')
  assert.equal(audit.readOnly, true, 'the audit is read-only by default')
  assert.equal(audit.eraRules, 'engine/era.js', 'era classification has one truth (contract §11.1)')
  assert.equal(audit.layout, 'per-session', 'the installed store is a per-session store')

  for (const era of ['legacy', 'synthetic', 'current']) {
    const bucket = audit.buckets?.[era]
    assert.ok(bucket, `bucket ${era} exists`)
    assert.deepEqual(
      { folders: bucket.folders, scored: bucket.scored, pending: bucket.pending },
      EXPECTED[era],
      `era ${era} matches the documented snapshot`,
    )
  }
  assert.equal(audit.totals.folders, EXPECTED.totals.folders, 'total folders')
  assert.equal(audit.totals.scored, EXPECTED.totals.scored, 'total scored folders')
  assert.equal(audit.totals.pending, EXPECTED.totals.pending, 'total pending folders')
  assert.equal(audit.totals.pendingPercent, EXPECTED.totals.pendingPercent, 'all-stock pending share = 74.0%')
  assert.equal(audit.totals.currentPendingPercent, EXPECTED.totals.currentPendingPercent, 'current-era pending share = 0.54%')

  // Calibers A/B/C/D as documented in plan §2.2.
  assert.equal(audit.calibers.A.pending, 2769, 'caliber A pending')
  assert.equal(audit.calibers.A.pendingPercent, 74, 'caliber A = 74.0%')
  assert.equal(audit.calibers.B.pending, 2182, 'caliber B excludes pre-1.2.0 legacy')
  assert.equal(audit.calibers.B.pendingPercent, 69.29, 'caliber B = 69.29%')
  assert.equal(audit.calibers.C.folders, 369, 'caliber C current-real folders')
  assert.equal(audit.calibers.C.pending, 2, 'caliber C current-real pending')
  assert.equal(audit.calibers.C.pendingPercent, 0.54, 'caliber C = 0.54%')
  assert.equal(audit.calibers.D.pending, 0, 'caliber D normal 1.3.0+ sessions have 0 pending')
  assert.equal(audit.calibers.D.folders, 359, 'caliber D covers the b5eeee7e session')

  assert.deepEqual([...audit.currentPending].sort(), [...EXPECTED.currentPending].sort(), 'the 2 current pending ids are the documented QQ-channel folders')

  // b5eeee7e: normal 1.3.0+ session, 359 folders all scored.
  const b5 = (audit.sessions ?? []).find((session) => String(session.session).includes('b5eeee7e'))
  assert.ok(b5, 'session-b5eeee7e is audited')
  assert.equal(b5.folders, EXPECTED.b5.folders, 'b5eeee7e folders')
  assert.equal(b5.scored, EXPECTED.b5.scored, 'b5eeee7e scaled')
  assert.equal(b5.pending, EXPECTED.b5.pending, 'b5eeee7e pending = 0')
  assert.equal(b5.normalSession, true, 'b5eeee7e is a normal (non-pressure) session')
  assert.equal(b5.dominantEra, 'current', 'b5eeee7e folders are current-era')
})

test('selfcheck --json agrees with memory-audit and reports 0 failed checks', { skip: storeSkipReason() }, () => {
  const selfcheck = parseJsonOutput('node tools/selfcheck.mjs --json', runTool('tools/selfcheck.mjs', ['--json']))
  assert.equal(selfcheck.exitCode, 0, 'selfcheck exits 0 on the real store')
  assert.equal(selfcheck.summary?.failed, 0, 'selfcheck reports 0 failed checks (warnings are explainable)')

  const eraCheck = (selfcheck.checks ?? []).find((check) => check.name === 'pending era')
  assert.ok(eraCheck, 'selfcheck has a "pending era" check')
  assert.equal(eraCheck.status, 'PASS', 'current-era pending is within the WARN threshold on the real store')
  const buckets = eraCheck.data?.buckets
  assert.ok(buckets, 'the pending-era check carries structured bucket data')
  assert.deepEqual(buckets.legacy, EXPECTED.legacy, 'selfcheck legacy bucket matches memory-audit')
  assert.deepEqual(buckets.synthetic, EXPECTED.synthetic, 'selfcheck synthetic bucket matches memory-audit')
  assert.deepEqual(buckets.current, EXPECTED.current, 'selfcheck current bucket matches memory-audit')
  assert.deepEqual(
    eraCheck.data?.totals,
    { folders: EXPECTED.totals.folders, scored: EXPECTED.totals.scored, pending: EXPECTED.totals.pending },
    'selfcheck totals match the documented snapshot',
  )
  assert.equal(eraCheck.data?.currentPendingPercent, 0.54, 'selfcheck current pending = 0.54%')

  const timeCheck = (selfcheck.checks ?? []).find((check) => check.name === 'time index')
  assert.ok(timeCheck, 'selfcheck validates the in-memory time index')
  assert.equal(timeCheck.status, 'PASS', 'time index is consistent with the real store')
  assert.equal(timeCheck.data?.mode, 'constrain', 'the shipped config enables time constraint')
  assert.equal(timeCheck.data?.timezoneValid, true, 'the configured timezone is resolvable')
  assert.deepEqual(timeCheck.data?.issues, [], 'no time-index issues on the real store')

  const fairness = (selfcheck.checks ?? []).find((check) => check.name === 'recall fairness')
  assert.ok(fairness, 'selfcheck reports recall fairness metrics')
  assert.equal(fairness.status, 'PASS', 'legacy-only telemetry is INFO, not WARN/FAIL')

  // v1.4.0 event-constraint addendum: selfcheck audits event tags (INFO only) and
  // must agree with the direct index.json count below (0 tagged legacy folders).
  const eventCheck = (selfcheck.checks ?? []).find((check) => check.name === 'event tags')
  assert.ok(eventCheck, 'selfcheck audits event tags (SPEC §8 check 8)')
  assert.equal(eventCheck.status, 'PASS', 'event tags are observability metadata: never WARN/FAIL')
  assert.equal(eventCheck.data?.foldersWithEvent, 0, 'no legacy folder carries an event label')
  assert.equal(eventCheck.data?.distinctEvents, 0, 'the real store has zero distinct events')
  assert.equal(eventCheck.data?.folders, EXPECTED.totals.folders, 'the event audit covers every indexed folder')
  assert.deepEqual(eventCheck.data?.eventMode, {
    engineDefault: 'index',
    packaged: 'constrain',
    effective: 'constrain',
    packagedMatchesEffective: true,
  }, 'engine default index / packaged constrain / effective constrain agree')
  assert.equal(eventCheck.data?.similarity?.metric, 'dice', 'the event similarity metric is Dice')
  assert.equal(eventCheck.data?.similarity?.threshold, 0.72, 'the event similarity threshold is 0.72')
})

test('recall-report --json agrees with both tools (74.00% all-stock / 0.54% current / 0/359 normal)', { skip: storeSkipReason() }, () => {
  const report = parseJsonOutput('node tools/recall-report.mjs --json', runTool('tools/recall-report.mjs', ['--json']))
  const eras = report.pendingEras
  assert.ok(eras, 'recall-report carries the pending-era block')
  assert.deepEqual(
    { folders: eras.buckets.legacy.folders, scored: eras.buckets.legacy.scored, pending: eras.buckets.legacy.pending },
    EXPECTED.legacy,
    'recall-report legacy bucket matches memory-audit',
  )
  assert.deepEqual(
    { folders: eras.buckets.synthetic.folders, scored: eras.buckets.synthetic.scored, pending: eras.buckets.synthetic.pending },
    EXPECTED.synthetic,
    'recall-report synthetic bucket matches memory-audit',
  )
  assert.deepEqual(
    { folders: eras.buckets.current.folders, scored: eras.buckets.current.scored, pending: eras.buckets.current.pending },
    EXPECTED.current,
    'recall-report current bucket matches memory-audit',
  )
  assert.equal(eras.totals.pendingPercent, 74, 'all-stock pending = 74.00%')
  assert.equal(eras.totals.currentPendingPercent, 0.54, 'current pendig = 0.54%')
  assert.equal(eras.calibers.C.pendingPercent, 0.54, 'caliber C agrees')
  assert.equal(eras.calibers.D.pendingPercent, 0, 'caliber D normal sessions = 0%')
  assert.equal(eras.calibers.D.folders, 359, 'caliber D = 359 folders')
  assert.deepEqual([...eras.currentPending].sort(), [...EXPECTED.currentPending].sort(), 'the same 2 current pending ids as memory-audit')
  assert.deepEqual(eras.warnings, [], 'no era warnings on the real store')
})

// ---------------------------------------------------------------------------
// Read-only guarantee: the three observers must not change a single byte
// ---------------------------------------------------------------------------

test('running memory-audit / selfcheck / recall-report never modifies real memory/sessions', { skip: storeSkipReason() }, () => {
  const before = snapshotTree(SESSIONS_DIR)
  assert.ok(before.size > 0, 'the store snapshot is non-empty')

  const audit = runTool('tools/memory-audit.mjs', ['--json'])
  assert.equal(audit.status, 0, `memory-audit exits 0 (stderr: ${audit.stderr.slice(0, 400)})`)
  const selfcheck = runTool('tools/selfcheck.mjs', ['--json'])
  assert.equal(selfcheck.status, 0, `selfcheck exits 0 (stderr: ${selfcheck.stderr.slice(0, 400)})`)
  const report = runTool('tools/recall-report.mjs', ['--json'])
  assert.equal(report.status, 0, `recall-report exits 0 (stderr: ${report.stderr.slice(0, 400)})`)

  const after = snapshotTree(SESSIONS_DIR)
  const diffs = diffSnapshots(before, after)
  assert.deepEqual(
    diffs,
    [],
    `read-only tools must not touch memory/sessions; changed: ${diffs.slice(0, 20).join(', ')}`,
  )
  assert.equal(after.size, before.size, 'the store file count is unchanged')
})

// ---------------------------------------------------------------------------
// Backward compatibility: every legacy store is still readable
// ---------------------------------------------------------------------------

test('every real index.json parses and every on-disk folder is indexed', { skip: storeSkipReason() }, () => {
  const dirs = listSessionDirs()
  let indexFolders = 0
  let diskFolders = 0
  let recallStateFiles = 0
  const problems = []

  for (const dir of dirs) {
    const storeDir = path.join(SESSIONS_DIR, dir)
    const indexFile = path.join(storeDir, 'index.json')
    if (!existsSync(indexFile)) {
      problems.push(`${dir}: missing index.json`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(indexFile, 'utf8'))
    } catch (error) {
      problems.push(`${dir}: index.json is not valid JSON (${error.message})`)
      continue
    }
    const folders = Array.isArray(parsed?.folders) ? parsed.folders : null
    if (folders === null) {
      problems.push(`${dir}: index.json has no folders array`)
      continue
    }
    indexFolders += folders.length
    const ids = new Set()
    for (const folder of folders) {
      if (typeof folder?.id !== 'string' || folder.id.length === 0) {
        problems.push(`${dir}: index entry without a string id`)
        break
      }
      if (!Number.isFinite(Number(folder.createdAt))) {
        problems.push(`${dir}: index entry ${folder.id} has no numeric createdAt`)
        break
      }
      if (ids.has(folder.id)) {
        problems.push(`${dir}: duplicate index id ${folder.id}`)
        break
      }
      ids.add(folder.id)
    }
    // Every folder directory on disk must be listed by the index (P1-4: the
    // index is written last, so a missing entry means data the plugin cannot see).
    let diskEntries = []
    try {
      diskEntries = readdirSync(storeDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch (error) {
      problems.push(`${dir}: unreadable store directory (${error.message})`)
      continue
    }
    for (const folderDir of diskEntries) {
      if (!existsSync(path.join(storeDir, folderDir, 'meta.json'))) continue
      diskFolders += 1
      if (!ids.has(folderDir)) problems.push(`${dir}: folder ${folderDir} exists on disk but is not indexed`)
    }
    // Old recall-state.json (v2 snapshot) must stay parseable (contract §6).
    const stateFile = path.join(storeDir, 'recall-state.json')
    if (existsSync(stateFile)) {
      recallStateFiles += 1
      let state
      try {
        state = JSON.parse(readFileSync(stateFile, 'utf8'))
      } catch (error) {
        problems.push(`${dir}: recall-state.json is not valid JSON (${error.message})`)
        continue
      }
      assert.ok([1, 2, 3].includes(Number(state.version)), `${dir}: recall-state version is a known v1/v2/v3 value`)
      const hasIds = Array.isArray(state.ids)
      const hasAdditions = Array.isArray(state.additions)
      const hasBlock = typeof state.block === 'string'
      assert.ok(hasIds || hasAdditions || hasBlock, `${dir}: recall-state keeps a v2-compatible shape (ids/additions/block)`)
      if (Array.isArray(state.ids)) {
        for (const entry of state.ids) assert.ok(entry && typeof entry.id === 'string', `${dir}: recall-state ids entries carry an id`)
      }
    }
  }

  assert.deepEqual(problems, [], `legacy stores must all be readable; problems: ${problems.slice(0, 10).join(' | ')}`)
  assert.equal(indexFolders, EXPECTED.totals.folders, 'the index lists the documented 3742 folders')
  assert.equal(diskFolders, EXPECTED.totals.folders, 'the disk holds the documented 3742 folder directories')
  assert.equal(recallStateFiles, 2, 'the installed store has 2 legacy recall-state.json snapshots')
})

test('the 1.3.0 recall-state.json snapshot is still restorable through the v2 read path', { skip: storeSkipReason() }, async (t) => {
  // `restoreRecallState` is the plugin's v1/v2 compatibility reader. It only
  // reads recall-state.json (no start(), no writes): construct the plugin and
  // restore the a46df597 snapshot into a fresh fake session.
  const storeDir = path.join(SESSIONS_DIR, 'session-a46df597-b1bd-43d6-86f6-760b78301b06')
  const stateFile = path.join(storeDir, 'recall-state.json')
  if (!existsSync(stateFile)) {
    t.skip('session-a46df597 has no recall-state.json in this checkout')
    return
  }
  // The plugin graph is imported lazily: this test must not turn the whole
  // suite red when an unrelated adapter module is mid-refactor.
  const { RofmPlugin } = await import('../lib/plugin.js')
  const memoryDir = MEMORY_DIR
  const cfg = {
    enabled: true,
    // `currentConfig()` normally resolves this; the reader only needs the
    // absolute root so `storage.perSession` can append `sessions/<id>/`.
    memoryDir,
    recall: { enabled: true, persistInjected: true, maxRecalledBlocks: 64, maxRecalledChars: 120000 },
    scoring: {},
    storage: { dir: memoryDir, perSession: true },
    compress: { contextWindowTokens: 0 },
    importance: {},
    keywords: {},
    compat: { qqBots: 'off' },
    logging: { enabled: false, verbose: false },
  }
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
    id: 'session-a46df597-b1bd-43d6-86f6-760b78301b06',
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
  assert.ok(state, 'a fresh session state is created')
  plugin.restoreRecallState(session, cfg)
  const restored = plugin.sessions.get(session)
  assert.ok(restored, 'the plugin keeps the restored session state')
  const restoredText = typeof restored.text === 'string' ? restored.text : ''
  const restoredIds = Array.isArray(restored.additions) ? restored.additions.map((addition) => addition.id) : []
  const fileState = JSON.parse(readFileSync(stateFile, 'utf8'))
  const idsInFile = Array.isArray(fileState.ids) ? fileState.ids.map((entry) => entry.id) : []
  if (idsInFile.length === 0) {
    // Nothing was injected in that session: a successful "no restore" is correct.
    assert.equal(restoredText.length, 0, 'an empty legacy snapshot restores nothing and must not throw')
    return
  }
  assert.ok(
    restoredText.length > 0 || restoredIds.length > 0,
    'a non-empty v2 snapshot restores injected text or ids without throwing',
  )
})

// ---------------------------------------------------------------------------
// v1.4.0 addendum — event constraint index on the real (legacy) store
// ---------------------------------------------------------------------------

test('the real legacy store has no event labels and engine.eventIndex() builds safely (read-only)', { skip: storeSkipReason() }, async () => {
  const before = snapshotTree(SESSIONS_DIR)
  assert.ok(before.size > 0, 'the store snapshot is non-empty')

  // (1) Old data must not carry event labels: no v1.4.0 scoring model ever ran
  // on it (design §1.1 — only `memory_judge` writes `meta.event`).
  const stores = []
  let folders = 0
  let foldersWithEvent = 0
  for (const dir of listSessionDirs()) {
    const indexPath = path.join(SESSIONS_DIR, dir, 'index.json')
    if (!existsSync(indexPath)) continue
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
    const entries = Array.isArray(parsed?.folders) ? parsed.folders : []
    folders += entries.length
    for (const entry of entries) {
      if (entry && typeof entry.event === 'string' && entry.event.trim().length > 0) foldersWithEvent += 1
    }
    if (entries.length > 0) stores.push({ dir, entries: entries.length })
  }
  assert.equal(folders, EXPECTED.totals.folders, 'the real store still holds the documented 3742 folders')
  assert.equal(foldersWithEvent, 0, 'legacy data carries no event labels (design §1.1: only new judging writes them)')
  stores.sort((left, right) => right.entries - left.entries)
  assert.ok(stores.length > 0, 'at least one real store has indexed folders')

  // (2) The derived event index must build from the real index.json without
  // throwing and be empty (pure in-memory derivation, contract §1.3).
  const { MemoryEngine, loadConfig } = await import('../engine/index.js')
  const cfg = loadConfig(path.join(REPO, 'config.json'))
  for (const store of stores) {
    const engine = new MemoryEngine({ memoryDir: path.join(SESSIONS_DIR, store.dir), config: cfg })
    let eventIndex
    assert.doesNotThrow(() => {
      eventIndex = engine.eventIndex()
    }, `engine.eventIndex() must build safely for ${store.dir}`)
    assert.ok(eventIndex && typeof eventIndex === 'object', `the event index object is returned for ${store.dir}`)
    assert.deepEqual(eventIndex.labels, [], `no event buckets in legacy store ${store.dir}`)
    assert.equal(eventIndex.byKey.size, 0, `no canonical event keys in legacy store ${store.dir}`)
    assert.equal(eventIndex.byId.size, 0, `no folder carries an event in legacy store ${store.dir}`)
    assert.equal(eventIndex.folderCount, store.entries, `the event index covers every indexed folder of ${store.dir}`)
    assert.ok(typeof eventIndex.signature === 'string' && eventIndex.signature.length > 0, 'the index carries a cache signature')
  }

  // (3) Building the derived index must not write a single byte.
  const after = snapshotTree(SESSIONS_DIR)
  const diffs = diffSnapshots(before, after)
  assert.deepEqual(diffs, [], `building the event index must stay read-only; changed: ${diffs.slice(0, 20).join(', ')}`)
})
