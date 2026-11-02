/**
 * dsh-rofm — self-check tool tests (v1.2.0 R5).
 *
 * Black-box: every test spawns `node tools/selfcheck.mjs` (the same way a user
 * runs it) against a throw-away memory/sessions fixture in `os.tmpdir()`, then
 * asserts the human/JSON output and the exit code. Nothing here imports the
 * adapter or the engine, so the tool is exercised exactly as shipped.
 *
 * ENVIRONMENT-DEPENDENT OUTPUT (explicitly handled here, do not "fix" by
 * removing the pin): the v1.3.0 compat checks add three PASS/WARN-only lines
 * only when a QQ plugin is detected (or `<memoryDir>/.compat-state.json`
 * exists). The documented expectations are therefore:
 *
 *   - neutral fixture profile (no QQ plugin) — used by `runCli` for EVERY spawn
 *     via `DSH_PROFILE_DIR=NEUTRAL_PROFILE`:
 *       9 check lines + platform + summary
 *       → `selfcheck: 8 passed, 1 warnings, 0 failed`, no `compat` line.
 *   - onebot and/or Derpyu detected (compat tests override DSH_PROFILE_DIR):
 *       + `compat`, `compat chat keys`, and (Derpyu only) `compat autopatch`
 *       → `selfcheck: 11 passed, 1 warnings, 0 failed` with all three compat
 *       checks PASS on a patched whitelist.
 *
 * The dedicated "documented environment-dependent output" test below asserts
 * both shapes side by side, including that detection only ADDS compat lines and
 * never changes the other checks. `--help` documents the same contract.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import zlib from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { encodeJournal } from '../tools/repair-session-log.mjs'

// zstd session-log fixtures need node:zlib zstd (Node 22.15+); skip on older Node.
const ZSTD_SUPPORTED =
  typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'
const testIfZstd = ZSTD_SUPPORTED ? test : test.skip

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELFCHECK = path.join(REPO_ROOT, 'tools', 'selfcheck.mjs')
const SPAWN_TIMEOUT_MS = 180_000
const FIXTURE_CREATED_AT = 1793000000000
const FIXTURE_FOLDER_ID = 'mem-20261026T131909Z-0001'

/**
 * The checks every environment reports (the order is fixed by runSelfCheck).
 * The three compat checks are appended only when QQ compatibility is relevant,
 * so they are deliberately NOT in this list.
 */
const ENVIRONMENT_INDEPENDENT_CHECKS = [
  'config',
  'engine',
  'memory store',
  'recall state',
  'pending era',
  'time index',
  'recall fairness',
  'event tags',
  'session logs',
]

const tempDirs = []
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-selfcheck-'))
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

function runCli(args, envOverrides = {}) {
  return spawnSync(process.execPath, [SELFCHECK, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Deterministic v1.3.0 compat input: a fixture profile with no QQ plugin
      // installed (tests that exercise compat override DSH_PROFILE_DIR).
      DSH_PROFILE_DIR: NEUTRAL_PROFILE,
      DSH_PROFILE: 'selfcheck-fixture',
      DSH_HOME: NEUTRAL_DSH_HOME,
      ...envOverrides,
    },
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
}

/** Run with --json and return { status, json, stdout, stderr }. */
function runJson(args, envOverrides = {}) {
  const result = runCli(['--json', ...args], envOverrides)
  assert.equal(result.error, undefined, `selfcheck failed to spawn: ${result.error?.message}`)
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

function findCheck(json, name) {
  const check = json.checks.find((entry) => entry.name === name)
  assert.ok(check, `check "${name}" missing from ${JSON.stringify(json.checks.map((entry) => entry.name))}`)
  return check
}

function issueCodes(check) {
  const issues = Array.isArray(check.data?.issues) ? check.data.issues : []
  return issues.map((issue) => issue.code)
}

// ---------------------------------------------------------------------------
// v1.3.0 compat fixtures
// ---------------------------------------------------------------------------

/**
 * Every CLI spawn is pinned to a fixture profile with no QQ plugin, so the
 * v1.3.0 compat check stays inert no matter what the machine running the tests
 * has installed; compat tests override DSH_PROFILE_DIR explicitly.
 */
const NEUTRAL_PROFILE = path.join(makeTempDir(), 'profile')
fs.mkdirSync(NEUTRAL_PROFILE, { recursive: true })
fs.writeFileSync(path.join(NEUTRAL_PROFILE, 'package.json'), JSON.stringify({ name: 'selfcheck-neutral-profile', private: true }), 'utf8')
const NEUTRAL_DSH_HOME = path.join(makeTempDir(), 'dsh-home')
fs.mkdirSync(NEUTRAL_DSH_HOME, { recursive: true })

/** One fixture profile with zero, one or both supported QQ plugins installed. */
function createQqProfile({ onebot = false, derpyu = false, toolRestrict = null } = {}) {
  const profileDir = path.join(makeTempDir(), 'profile')
  const dependencies = {}
  if (onebot) dependencies['dsh-onebot-qq'] = '^1.0.0'
  if (derpyu) dependencies['qq-agent-presets'] = '^1.0.0'
  writeJson(path.join(profileDir, 'package.json'), { name: 'selfcheck-compat-profile', private: true, dependencies })
  if (toolRestrict !== null) {
    const packageDir = path.join(profileDir, 'node_modules', 'qq-agent-presets')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'qq-tool-restrict.mjs'), toolRestrict, 'utf8')
  }
  return profileDir
}

/** A `qq-tool-restrict.mjs` body whose SAFE_EXACT set lists `tools`. */
function toolRestrictSource(tools) {
  return `const SAFE_EXACT = new Set([\n${tools.map((name) => `  '${name}',`).join('\n')}\n])\n`
}

/** `.compat-state.json` payload as lib/compat-autopatch.js writes it (D14). */
function compatStatePayload(filePath) {
  return {
    version: 1,
    patches: [
      {
        target: 'qq-agent-presets',
        filePath,
        beforeHash: 'b'.repeat(64),
        afterHash: 'a'.repeat(64),
        patchedAt: '2026-01-01T00:00:00.000Z',
        backupPath: `${filePath}.bak-rofm-20260101000000`,
      },
    ],
  }
}

/** The compat-related check names, in report order. */
const COMPAT_CHECK_NAMES = ['compat', 'compat chat keys', 'compat autopatch']

// ---------------------------------------------------------------------------
// memory-store fixtures
// ---------------------------------------------------------------------------

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value), 'utf8')
}

function folderMeta(overrides = {}) {
  return {
    version: 1,
    id: FIXTURE_FOLDER_ID,
    createdAt: FIXTURE_CREATED_AT,
    alpha: 0.6,
    alphaSource: 'model',
    beta: 1.5,
    betaSource: 'model',
    keywords: ['部署', 'docker', '端口'],
    keywordsSource: 'model',
    scored: true,
    rescorePending: false,
    title: '部署讨论',
    stats: { messages: 2, chars: 60, tokens: 30 },
    source: { sessionId: 'session-fixture', turn: 1, seqStart: 0, seqEnd: 1 },
    ...overrides,
  }
}

/** The index entry `storage/indexEntryFromMeta` would build for one meta. */
function indexEntry(meta) {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    alpha: meta.alpha,
    beta: meta.beta,
    scored: meta.scored,
    rescorePending: meta.rescorePending === true,
    keywords: meta.keywords,
    chars: meta.stats?.chars ?? 0,
    tokens: meta.stats?.tokens ?? 0,
    messageCount: meta.stats?.messages ?? 0,
    title: meta.title,
  }
}

function recallStatePayload(meta, overrides = {}) {
  return {
    version: 2,
    sessionId: 'session-fixture',
    updatedAt: FIXTURE_CREATED_AT,
    block: '## 记忆回忆\n\nfixture block',
    ids: [{ id: meta.id, generation: 1 }],
    additions: [
      {
        id: meta.id,
        generation: 1,
        alpha: meta.alpha,
        beta: meta.beta,
        probability: meta.alpha,
        chars: 60,
        tokens: 30,
        createdAt: meta.createdAt,
        keywords: meta.keywords,
        title: meta.title,
        messages: [{ role: 'user', content: '讨论部署 docker 端口。' }],
      },
    ],
    ...overrides,
  }
}

/** A real-shaped v3 recall-state payload (what lib/plugin.js saveRecallState writes). */
function recallStateV3Payload(meta, overrides = {}) {
  return {
    version: 3,
    sessionId: 'session-fixture',
    updatedAt: FIXTURE_CREATED_AT,
    block: '## 记忆回忆\n\nfixture v3 block',
    ids: [{ id: meta.id, generation: 1 }],
    additions: [
      {
        id: meta.id,
        generation: 1,
        alpha: meta.alpha,
        beta: meta.beta,
        probability: meta.alpha,
        chars: 60,
        tokens: 30,
        createdAt: meta.createdAt,
        keywords: meta.keywords,
        title: meta.title,
        messages: [{ role: 'user', content: '讨论部署 docker 端口。' }],
      },
    ],
    // --- v3 deterministic recall state (contract §6) ---
    round: 7,
    configFingerprint: 'cfg1|abcdef',
    lanes: {
      frontier: [{ seed: '部署', key: { alpha: meta.alpha, createdAt: meta.createdAt, id: meta.id }, length: 2 }],
      exploreCursor: null,
      pendingHigh: [],
      pendingHighRound: [],
      highRecycle: [],
      recycle: [],
      degraded: false,
      round: 7,
    },
    ledger: [meta.id, 'other-id'],
    counters: { reInjections: 2, registerDrops: 0, recallTimeEvicted: 0, timeMisses: 0 },
    degraded: false,
    ...overrides,
  }
}

/** Write one recall-state.json into a store created by `createGoodStore`. */
function writeRecallState(storeDir, payload) {
  writeJson(path.join(storeDir, 'recall-state.json'), payload)
}

/** Create one healthy per-session memory store: `<root>/memory/sessions/<id>/`. */
function createGoodStore(root, { sessionId = 'session-fixture', meta = folderMeta() } = {}) {
  const memoryDir = path.join(root, 'memory')
  const storeDir = path.join(memoryDir, 'sessions', sessionId)
  writeJson(path.join(storeDir, meta.id, 'meta.json'), meta)
  writeJson(path.join(storeDir, meta.id, 'context.json'), {
    version: 1,
    id: meta.id,
    createdAt: meta.createdAt,
    messages: [
      { role: 'user', content: '讨论部署 docker 端口。' },
      { role: 'assistant', content: '端口配置为 8080。' },
    ],
  })
  writeJson(path.join(storeDir, 'index.json'), {
    version: 1,
    updatedAt: meta.createdAt,
    nextCounter: 2,
    folders: [indexEntry(meta)],
  })
  fs.writeFileSync(
    path.join(storeDir, 'stats.jsonl'),
    `${JSON.stringify({ type: 'compress', time: meta.createdAt, folderIds: [meta.id] })}\n`,
    'utf8',
  )
  writeJson(path.join(storeDir, 'recall-state.json'), recallStatePayload(meta))
  return { memoryDir, storeDir, meta }
}

/** A sessions root that holds no session logs at all. */
function createEmptySessionsDir(root) {
  const sessionsDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  return sessionsDir
}

/** Build a fresh temp fixture with one store, run `mutate(store)` on it. */
function corruptStoreFixture(mutate) {
  const root = makeTempDir()
  const store = createGoodStore(root)
  mutate(store)
  return { root, store, sessionsDir: createEmptySessionsDir(root) }
}

// ---------------------------------------------------------------------------
// v1.4.0 data-era / time-index / fairness fixtures
// ---------------------------------------------------------------------------

/** Before the v1.2.0 tag (2026-10-27T19:14:00Z) → folder era legacy. */
const LEGACY_ERA_TS = Date.parse('2026-10-25T01:40:17Z')
/** After the v1.2.0 tag → folder era follows the session era. */
const CURRENT_ERA_TS = Date.parse('2026-10-31T09:00:03Z')

/**
 * Create one healthy store with `folders` index entries (meta.json written for
 * every folder so the memory-store check stays PASS) plus optional telemetry.
 *
 * @param {object} root fixture root
 * @param {{sessionId?: string, folders: Array<{id?: string, createdAt?: number,
 *   scored?: boolean, pendingEra?: string, eventStart?: number, eventEnd?: number,
 *   eventTimeSource?: string}>, statsEvents?: object[]}} options
 */
function createMultiStore(root, { sessionId = 'session-era', folders = [], statsEvents = [] } = {}) {
  const memoryDir = path.join(root, 'memory')
  const storeDir = path.join(memoryDir, 'sessions', sessionId)
  const entries = []
  folders.forEach((folder, index) => {
    const id = folder.id ?? `mem-20261026T131909Z-${String(index + 1).padStart(4, '0')}`
    const scored = folder.scored !== false
    const meta = folderMeta({
      id,
      createdAt: folder.createdAt ?? CURRENT_ERA_TS,
      scored,
      alpha: scored ? 0.6 : 0,
      beta: scored ? 1.5 : 0,
      keywords: scored ? ['部署', 'docker', '端口'] : [],
    })
    writeJson(path.join(storeDir, id, 'meta.json'), meta)
    const entry = indexEntry(meta)
    for (const key of ['pendingEra', 'eventStart', 'eventEnd', 'eventTimeSource', 'event', 'eventSource', 'eventAt']) {
      if (folder[key] !== undefined) entry[key] = folder[key]
    }
    entries.push(entry)
  })
  writeJson(path.join(storeDir, 'index.json'), {
    version: 1,
    updatedAt: CURRENT_ERA_TS,
    nextCounter: entries.length + 1,
    folders: entries,
  })
  if (statsEvents.length > 0) {
    fs.writeFileSync(path.join(storeDir, 'stats.jsonl'), statsEvents.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
  }
  return { memoryDir, storeDir, entries }
}

// ---------------------------------------------------------------------------
// session-log fixtures
// ---------------------------------------------------------------------------

function noteText(segments, appendix = '') {
  const note = `[memory] ${segments} 段更早的对话已归档到 memory/。需要时会自动回忆。`
  if (appendix.length === 0) return note
  return (
    `${note}\n\n[memory] 本次归档区间内还有 1 条非对话上下文` +
    `（例如运行时上下文或插件注入的固定消息），已并入本说明以免丢失：\n${appendix}`
  )
}

function appendUser(seq, text) {
  return {
    type: 'user/message',
    seq,
    time: FIXTURE_CREATED_AT + seq,
    data: { id: `u-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    surfaceOp: 'append',
  }
}

function appendAssistant(seq, text) {
  return {
    type: 'assistant/message',
    seq,
    time: FIXTURE_CREATED_AT + seq,
    data: {
      turn: 1,
      step: 1,
      message: { id: `a-${seq}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] },
    },
    surfaceOp: 'append',
  }
}

function compactionEvent(seq, type, compactionId) {
  return { type, seq, time: FIXTURE_CREATED_AT + seq, data: { compactionId, turn: 1 } }
}

function checkpointEvent(seq, text, startSeq, endSeq, compactionId) {
  return {
    type: 'user/message',
    seq,
    time: FIXTURE_CREATED_AT + seq,
    data: {
      id: `cp-${seq}`,
      role: 'user',
      source: { kind: 'compact-checkpoint', compactionId },
      content: [{ type: 'text', text }],
    },
    surfaceOp: { op: 'replace', startSeq, endSeq },
  }
}

/** One archive transaction; the final surface holds exactly one note. */
function singleArchiveEvents({ segments = 3, appendix = '' } = {}) {
  return [
    appendUser(0, '第一轮：讨论部署。'),
    appendAssistant(1, '好的，先看端口配置。'),
    compactionEvent(2, 'compaction/start', 'c1'),
    compactionEvent(3, 'compaction/summary', 'c1'),
    checkpointEvent(4, noteText(segments, appendix), 0, 1, 'c1'),
    compactionEvent(5, 'compaction/end', 'c1'),
  ]
}

/** Two archive transactions that leave two notes on the final surface. */
function twoArchiveEvents() {
  return [
    appendUser(0, '第一轮：讨论部署。'),
    appendAssistant(1, '好的。'),
    appendUser(2, '第二轮：继续讨论端口。'),
    appendAssistant(3, '端口为 8080。'),
    compactionEvent(4, 'compaction/start', 'c1'),
    compactionEvent(5, 'compaction/summary', 'c1'),
    checkpointEvent(6, noteText(3), 0, 1, 'c1'),
    compactionEvent(7, 'compaction/end', 'c1'),
    compactionEvent(8, 'compaction/start', 'c2'),
    compactionEvent(9, 'compaction/summary', 'c2'),
    checkpointEvent(10, noteText(2), 2, 3, 'c2'),
    compactionEvent(11, 'compaction/end', 'c2'),
  ]
}

/** Write one real (zstd container) session log under `<sessionsDir>/<id>/`. */
function writeSessionLog(sessionsDir, sessionId, events) {
  const sessionDir = path.join(sessionsDir, sessionId)
  fs.mkdirSync(sessionDir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: FIXTURE_CREATED_AT, cwd: 'C:/fixture' })
  const text = [header, ...events.map((event) => JSON.stringify(event))].join('\n') + '\n'
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, encodeJournal(text))
  return file
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('selfcheck: a healthy store and recall state pass and exit 0', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const { status, json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])

  assert.equal(status, 0, `expected exit 0; checks=${JSON.stringify(json.checks.map((check) => [check.name, check.status]))}`)
  assert.equal(json.exitCode, 0)
  assert.equal(json.summary.failed, 0)
  assert.equal(findCheck(json, 'memory store').status, 'PASS', findCheck(json, 'memory store').detail)
  const recallCheck = findCheck(json, 'recall state')
  assert.equal(recallCheck.status, 'PASS', recallCheck.detail)
  // The human label covers both the v2 and v3 snapshot shapes (1.4.0 writes v3).
  assert.match(recallCheck.detail, /recall-state snapshot, v2\/v3/)
  // No session logs in the fixture: the tool warns instead of failing (§R5.5).
  assert.equal(findCheck(json, 'session logs').status, 'WARN')
})

test('selfcheck: corrupt index.json fails the memory store check', () => {
  const { store, sessionsDir } = corruptStoreFixture((fixture) => {
    fs.writeFileSync(path.join(fixture.storeDir, 'index.json'), '{ this is not json', 'utf8')
  })
  const { status, json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'memory store')
  assert.equal(check.status, 'FAIL', check.detail)
  assert.ok(issueCodes(check).includes('index-invalid-json'), `issues: ${JSON.stringify(issueCodes(check))}`)
  assert.equal(status, 1)
  assert.equal(json.exitCode, 1)
})

test('selfcheck: an out-of-range meta alpha fails the memory store check', () => {
  const { store, sessionsDir } = corruptStoreFixture((fixture) => {
    const metaPath = path.join(fixture.storeDir, fixture.meta.id, 'meta.json')
    writeJson(metaPath, { ...fixture.meta, alpha: 2.5 })
  })
  const { status, json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'memory store')
  assert.equal(check.status, 'FAIL', check.detail)
  assert.ok(issueCodes(check).includes('meta-alpha-range'), `issues: ${JSON.stringify(issueCodes(check))}`)
  assert.equal(status, 1)
})

test('selfcheck: an unsafe folder id in index.json fails the memory store check', () => {
  const { store, sessionsDir } = corruptStoreFixture((fixture) => {
    writeJson(path.join(fixture.storeDir, 'index.json'), {
      version: 1,
      updatedAt: FIXTURE_CREATED_AT,
      nextCounter: 2,
      folders: [{ ...indexEntry(fixture.meta), id: '../escaped' }],
    })
  })
  const { status, json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'memory store')
  assert.equal(check.status, 'FAIL', check.detail)
  assert.ok(issueCodes(check).includes('index-entry-id-unsafe'), `issues: ${JSON.stringify(issueCodes(check))}`)
  assert.equal(status, 1)
})

test('selfcheck: a corrupt stats.jsonl line fails the memory store check', () => {
  const { store, sessionsDir } = corruptStoreFixture((fixture) => {
    fs.appendFileSync(path.join(fixture.storeDir, 'stats.jsonl'), '{broken telemetry line\n', 'utf8')
  })
  const { status, json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'memory store')
  assert.equal(check.status, 'FAIL', check.detail)
  assert.ok(issueCodes(check).includes('stats-line-invalid-json'), `issues: ${JSON.stringify(issueCodes(check))}`)
  assert.equal(status, 1)
})

test('selfcheck: an inconsistent recall-state snapshot fails the recall state check', () => {
  const { store, sessionsDir } = corruptStoreFixture((fixture) => {
    // A v2 snapshot whose ids array and additions array disagree.
    writeJson(path.join(fixture.storeDir, 'recall-state.json'), recallStatePayload(fixture.meta, { ids: [] }))
  })
  const { status, json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'recall state')
  assert.equal(check.status, 'FAIL', check.detail)
  assert.ok(issueCodes(check).includes('recall-state-ids-mismatch'), `issues: ${JSON.stringify(issueCodes(check))}`)
  assert.equal(status, 1)
  assert.equal(json.exitCode, 1)
})

// ---------------------------------------------------------------------------
// v1.4.0 recall-state v3 snapshots (contract §6)
// ---------------------------------------------------------------------------

test('selfcheck: a real v3 recall-state snapshot passes with zero issues', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  writeRecallState(store.storeDir, recallStateV3Payload(store.meta))
  const { status, json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'recall state')
  assert.equal(check.status, 'PASS', check.detail)
  assert.equal(check.data.issueTotal, 0)
  assert.deepEqual(check.data.issues, [])
  assert.equal(check.data.states.length, 1)
  assert.equal(check.data.states[0].version, 3)
  assert.match(check.detail, /recall-state snapshot, v2\/v3/)
  assert.equal(status, 0)
  assert.equal(json.exitCode, 0)
})

test('selfcheck: malformed v3 optional fields degrade (PASS, no issue) instead of FAIL', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  // Same shape lib/plugin.js has to tolerate: lanes/ledger/counters garbage,
  // round not a number. They are optional v3 extras → ignored by selfcheck.
  writeRecallState(
    store.storeDir,
    recallStateV3Payload(store.meta, {
      round: 'not-a-number',
      configFingerprint: 42,
      lanes: 'garbage',
      ledger: 42,
      counters: 'nope',
    }),
  )
  const { status, json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'recall state')
  assert.equal(check.status, 'PASS', check.detail)
  assert.equal(check.data.issueTotal, 0, 'optional v3 extras are not validated by selfcheck')
  assert.deepEqual(check.data.issues, [])
  assert.equal(status, 0, 'a degraded optional field must not fail the self-check')
  assert.equal(json.summary.failed, 0)
})

test('selfcheck: v3 snapshots still validate the shared core fields', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  // v3 keeps v2's block/ids/additions: a core mismatch is still a FAIL.
  writeRecallState(store.storeDir, recallStateV3Payload(store.meta, { ids: [] }))
  const { status, json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'recall state')
  assert.equal(check.status, 'FAIL', check.detail)
  assert.ok(issueCodes(check).includes('recall-state-ids-mismatch'), `issues: ${JSON.stringify(issueCodes(check))}`)
  assert.equal(status, 1)
})

test('selfcheck: v1 / missing / completely broken recall-state snapshots keep their existing severities', () => {
  const sessionsDir = createEmptySessionsDir(makeTempDir())
  // v1 → legacy WARN (upgraded on the next injection), exit 0.
  const v1Root = makeTempDir()
  const v1Store = createGoodStore(v1Root)
  writeRecallState(v1Store.storeDir, { version: 1 })
  const v1 = runJson(['--memory-dir', v1Store.memoryDir, '--sessions-dir', sessionsDir])
  const v1Check = findCheck(v1.json, 'recall state')
  assert.equal(v1Check.status, 'WARN', v1Check.detail)
  assert.ok(issueCodes(v1Check).includes('recall-state-v1'))
  assert.equal(v1.status, 0)

  // Completely broken shape (JSON scalar) → FAIL.
  const shapeRoot = makeTempDir()
  const shapeStore = createGoodStore(shapeRoot)
  writeRecallState(shapeStore.storeDir, 'not-a-snapshot')
  const shape = runJson(['--memory-dir', shapeStore.memoryDir, '--sessions-dir', sessionsDir])
  const shapeCheck = findCheck(shape.json, 'recall state')
  assert.equal(shapeCheck.status, 'FAIL', shapeCheck.detail)
  assert.ok(issueCodes(shapeCheck).includes('recall-state-shape'))
  assert.equal(shape.status, 1)

  // Unparsable JSON → FAIL.
  const jsonRoot = makeTempDir()
  const jsonStore = createGoodStore(jsonRoot)
  fs.writeFileSync(path.join(jsonStore.storeDir, 'recall-state.json'), '{ broken json', 'utf8')
  const broken = runJson(['--memory-dir', jsonStore.memoryDir, '--sessions-dir', sessionsDir])
  const brokenCheck = findCheck(broken.json, 'recall state')
  assert.equal(brokenCheck.status, 'FAIL', brokenCheck.detail)
  assert.ok(issueCodes(brokenCheck).includes('recall-state-invalid-json'))
  assert.equal(broken.status, 1)

  // Unsupported version (e.g. 4) → FAIL with the v2/v3 wording.
  const versionRoot = makeTempDir()
  const versionStore = createGoodStore(versionRoot)
  writeRecallState(versionStore.storeDir, recallStateV3Payload(versionStore.meta, { version: 4 }))
  const unsupported = runJson(['--memory-dir', versionStore.memoryDir, '--sessions-dir', sessionsDir])
  const versionCheck = findCheck(unsupported.json, 'recall state')
  assert.equal(versionCheck.status, 'FAIL', versionCheck.detail)
  assert.match(versionCheck.detail, /expected 2 or 3/)
  assert.equal(unsupported.status, 1)
})

testIfZstd('selfcheck: two dsh-rofm checkpoint notes on one final surface are a WARN (legacy)', () => {
  const root = makeTempDir()
  const sessionsDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  writeSessionLog(sessionsDir, 'session-two-notes', twoArchiveEvents())
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])

  const check = findCheck(json, 'session logs')
  assert.equal(check.status, 'WARN', check.detail)
  assert.ok(issueCodes(check).includes('session-log-multiple-notes'), `issues: ${JSON.stringify(issueCodes(check))}`)
  assert.equal(check.data.notes, 2, 'both notes are counted')
  assert.equal(status, 0, 'legacy residue must not fail the self-check')
  assert.ok(json.checks.every((entry) => entry.status !== 'FAIL'))
})

testIfZstd('selfcheck: a note appendix with re-injected runtime context is a FAIL', () => {
  const root = makeTempDir()
  const sessionsDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  writeSessionLog(
    sessionsDir,
    'session-bad-appendix',
    singleArchiveEvents({
      appendix:
        'user: Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n' +
        'user: Time sampled while preparing turn 1, step 1: 2026-10-26T22:50:29+08:00[Asia/Shanghai]',
    }),
  )
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'session logs')
  assert.equal(check.status, 'FAIL', check.detail)
  const codes = issueCodes(check)
  assert.ok(codes.includes('session-log-appendix-excluded'), `issues: ${JSON.stringify(codes)}`)
  assert.equal(status, 1)
})

testIfZstd('selfcheck: a foreign checkpoint is counted but does not fail', () => {
  const root = makeTempDir()
  const sessionsDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  writeSessionLog(sessionsDir, 'session-foreign', [
    appendUser(0, '第一轮。'),
    appendAssistant(1, '好的。'),
    checkpointEvent(2, '[context] this span was summarized by a different compressor.', 0, 1, 'foreign-1'),
  ])
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'session logs')
  assert.equal(check.status, 'PASS', check.detail)
  assert.equal(check.data.notes, 0)
  assert.equal(check.data.foreignCheckpoints, 1)
  assert.equal(status, 0)
})

// Ungated on purpose: this fixture needs no zstd session log, so it must also
// run on the Node 20 CI row (the machine-readable shape is cross-platform data).
test('selfcheck: --json returns the documented machine-readable shape', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const { status, json, stdout } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])

  assert.equal(json.tool, 'dsh-rofm-selfcheck')
  assert.equal(typeof json.version, 'string')
  assert.equal(typeof json.generatedAt, 'string')
  assert.ok(Number.isFinite(Date.parse(json.generatedAt)), 'generatedAt is an ISO timestamp')
  assert.equal(typeof json.repoRoot, 'string')
  assert.equal(typeof json.memoryDir, 'string')
  assert.equal(typeof json.sessionsDir, 'string')
  assert.equal(json.memoryDir, store.memoryDir)
  assert.equal(json.sessionsDir, sessionsDir)
  assert.deepEqual(json.platform, {
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
  })
  assert.ok(Array.isArray(json.checks))
  assert.ok(json.checks.length >= 5, 'config, engine, memory store, recall state, session logs')
  for (const check of json.checks) {
    assert.equal(typeof check.name, 'string')
    assert.ok(['PASS', 'WARN', 'FAIL'].includes(check.status), `unexpected status ${check.status}`)
    assert.equal(typeof check.detail, 'string')
    assert.ok(check.detail.length > 0)
    assert.ok(!check.detail.includes('\n'), 'details are one line')
  }
  const { passed, warnings, failed } = json.summary
  assert.equal(passed + warnings + failed, json.checks.length)
  assert.equal(failed, json.checks.filter((check) => check.status === 'FAIL').length)
  assert.equal(json.exitCode, failed > 0 ? 1 : 0)
  assert.equal(status, json.exitCode)
  assert.ok(stdout.trimStart().startsWith('{'), '--json prints JSON only, no human lines')
})

// Ungated like the shape test above: a memory-store + empty-sessions fixture
// needs no zstd codec, so Node 20 runs this too.
test('selfcheck: human output uses check lines, one platform line and the summary line', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const good = runCli(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  assert.equal(good.status, 0)
  const lines = String(good.stdout).trimEnd().split(/\r?\n/)
  assert.ok(lines.length >= 3, 'check lines + platform line + summary line')
  // Last two lines are the platform line and the summary; everything before is
  // one PASS/WARN/FAIL check line.
  for (const line of lines.slice(0, -2)) {
    assert.match(line, /^\[(PASS|WARN|FAIL)\] [^—]+— .+$/, `unexpected check line: ${line}`)
  }
  assert.match(lines.at(-2), /^platform: \S+ \S+, node \d+\.\d+\.\d+$/)
  // The human platform line and the JSON object must agree.
  assert.equal(lines.at(-2), `platform: ${process.platform} ${process.arch}, node ${process.versions.node}`)
  assert.match(lines.at(-1), /^selfcheck: \d+ passed, \d+ warnings, \d+ failed$/)

  const corrupt = corruptStoreFixture((fixture) => {
    fs.writeFileSync(path.join(fixture.storeDir, 'index.json'), 'not json', 'utf8')
  })
  const bad = runCli(['--memory-dir', corrupt.store.memoryDir, '--sessions-dir', corrupt.sessionsDir])
  assert.equal(bad.status, 1)
  assert.match(String(bad.stdout), /^\[FAIL\] memory store — /m)
  assert.match(String(bad.stdout), /^selfcheck: \d+ passed, \d+ warnings, [1-9]\d* failed$/m)
})

test('selfcheck: --help exits 0 and documents the options', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  const stdout = String(result.stdout)
  assert.match(stdout, /Usage:/)
  for (const option of ['--json', '--memory-dir', '--sessions-dir', '--session', '--max-sessions', '--with-tests']) {
    assert.ok(stdout.includes(option), `help mentions ${option}`)
  }
  // v1.4.0 checks + the era policy must be documented in the help output.
  for (const name of ['pending era', 'time index', 'recall fairness']) {
    assert.ok(stdout.includes(name), `help mentions the ${name} check`)
  }
  assert.match(stdout, /legacy folders \(createdAt < 2026-10-27T19:14:00Z/)
  assert.match(stdout, /INFO/)
})

testIfZstd('selfcheck: --session limits the session-log check to one session id', () => {
  const root = makeTempDir()
  const sessionsDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  writeSessionLog(sessionsDir, 'session-clean', singleArchiveEvents())
  writeSessionLog(sessionsDir, 'session-bad', singleArchiveEvents({ appendix: 'Time sampled while preparing turn 1, step 1: 2026-10-26T22:50:29+08:00' }))
  const { status, json } = runJson([
    '--memory-dir',
    path.join(root, 'memory'),
    '--sessions-dir',
    sessionsDir,
    '--session',
    'session-clean',
  ])
  const check = findCheck(json, 'session logs')
  assert.equal(check.status, 'PASS', check.detail)
  assert.equal(check.data.scanned, 1)
  assert.equal(check.data.notes, 1)
  assert.equal(status, 0, 'the bad session was not selected')
})

// ---------------------------------------------------------------------------
// v1.4.0 checks: pending era buckets / time index / recall fairness
// ---------------------------------------------------------------------------

test('selfcheck: legacy+synthetic pending are INFO and a small current pending is PASS', () => {
  const root = makeTempDir()
  const sessionsDir = createEmptySessionsDir(root)
  const memoryDir = path.join(root, 'memory')
  // 40 pre-1.2.0 pending folders → legacy bucket (INFO, never actionable).
  createMultiStore(root, {
    sessionId: 'session-era-legacy',
    folders: Array.from({ length: 40 }, () => ({ createdAt: LEGACY_ERA_TS, scored: false })),
  })
  // 100 pending folders (stress volume) + fake window (8000 tokens / 6764%)
  // → synthetic bucket.
  createMultiStore(root, {
    sessionId: 'session-era-synthetic',
    folders: Array.from({ length: 100 }, () => ({ createdAt: CURRENT_ERA_TS, scored: false })),
    statsEvents: [
      { type: 'compress', time: CURRENT_ERA_TS, windowTokens: 8000, folderIds: [] },
      { type: 'compress-applied', time: CURRENT_ERA_TS, windowTokens: 8000, beforePercent: 6764.15, folderMetadata: [] },
    ],
  })
  // 50 current folders with 1 pending = 2% → PASS/INFO.
  createMultiStore(root, {
    sessionId: 'session-era-current',
    folders: Array.from({ length: 50 }, (_, index) => ({ createdAt: CURRENT_ERA_TS, scored: index !== 0 })),
  })
  const { status, json } = runJson(['--memory-dir', memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'pending era')
  assert.equal(check.status, 'PASS', check.detail)
  assert.match(check.detail, /INFO: legacy pending 40 \+ synthetic pending 100/)
  assert.match(check.detail, /current pending 1\/50 = 2\.00%/)
  assert.match(check.detail, /within threshold/)
  assert.deepEqual(check.data.buckets.legacy, { folders: 40, scored: 0, pending: 40 })
  assert.deepEqual(check.data.buckets.synthetic, { folders: 100, scored: 0, pending: 100 })
  assert.deepEqual(check.data.buckets.current, { folders: 50, scored: 49, pending: 1 })
  assert.equal(check.data.currentPendingPercent, 2)
  assert.deepEqual(check.data.thresholds, {
    warnPercent: 5,
    warnMinPending: 20,
    failPercent: 20,
    minCurrentFolders: 20,
  })
  assert.equal(status, 0, 'legacy/synthetic pending must never fail the self-check')
})

test('selfcheck: current pending above 5% with >20 pending is a WARN (exit 0)', () => {
  const root = makeTempDir()
  const sessionsDir = createEmptySessionsDir(root)
  // 21 pending out of 300 current folders = 7% → WARN, not FAIL.
  createMultiStore(root, {
    sessionId: 'session-era-warn',
    folders: Array.from({ length: 300 }, (_, index) => ({ createdAt: CURRENT_ERA_TS, scored: index >= 21 })),
  })
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'pending era')
  assert.equal(check.status, 'WARN', check.detail)
  assert.equal(check.data.currentPendingPercent, 7)
  assert.match(check.detail, /above the WARN line/)
  assert.equal(status, 0, 'a WARN must not fail the self-check')
  assert.equal(json.summary.failed, 0)
})

test('selfcheck: current pending above 20% is a FAIL (exit 1)', () => {
  const root = makeTempDir()
  const sessionsDir = createEmptySessionsDir(root)
  createMultiStore(root, {
    sessionId: 'session-era-fail',
    folders: Array.from({ length: 50 }, () => ({ createdAt: CURRENT_ERA_TS, scored: false })),
  })
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'pending era')
  assert.equal(check.status, 'FAIL', check.detail)
  assert.equal(check.data.currentPendingPercent, 100)
  assert.match(check.detail, /above the FAIL line/)
  assert.equal(status, 1)
  assert.equal(json.exitCode, 1)
})

test('selfcheck: index pendingEra marks win over createdAt and stale marks are counted', () => {
  const root = makeTempDir()
  const sessionsDir = createEmptySessionsDir(root)
  // 30 current pending folders marked legacy: summarizeEras trusts the mark, so
  // they leave the actionable current bucket; the mark-free classification shows
  // all 30 are stale (createdAt says current).
  createMultiStore(root, {
    sessionId: 'session-era-marked',
    folders: Array.from({ length: 30 }, () => ({ createdAt: CURRENT_ERA_TS, scored: false, pendingEra: 'legacy' })),
  })
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'pending era')
  assert.equal(check.status, 'PASS', check.detail)
  assert.equal(check.data.markedFolders, 30)
  assert.equal(check.data.inconsistentMarks, 30)
  assert.deepEqual(check.data.buckets.legacy, { folders: 30, scored: 0, pending: 30 })
  assert.deepEqual(check.data.buckets.current, { folders: 0, scored: 0, pending: 0 })
  assert.match(check.detail, /pendingEra marks 30 \(stale 30\)/)
  assert.match(check.detail, /current sample too small/)
  assert.equal(status, 0)
})

test('selfcheck: time index CSR agrees with naive folder event intervals', () => {
  const root = makeTempDir()
  const sessionsDir = createEmptySessionsDir(root)
  const day = 24 * 60 * 60 * 1000
  createMultiStore(root, {
    sessionId: 'session-time',
    folders: [
      // Event-time folder spanning two days (messages source).
      { createdAt: CURRENT_ERA_TS, scored: true, eventStart: CURRENT_ERA_TS, eventEnd: CURRENT_ERA_TS + 2 * day, eventTimeSource: 'messages' },
      // Old folder without event time → archive fallback [createdAt, createdAt+1).
      { createdAt: CURRENT_ERA_TS + 5 * day, scored: true },
      // Judge-sourced event range.
      {
        createdAt: CURRENT_ERA_TS + 9 * day,
        scored: true,
        eventStart: CURRENT_ERA_TS + 9 * day,
        eventEnd: CURRENT_ERA_TS + 9 * day + 3600000,
        eventTimeSource: 'judge',
      },
    ],
  })
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'time index')
  assert.equal(check.status, 'PASS', check.detail)
  assert.equal(check.data.stores, 1)
  assert.equal(check.data.folders, 3)
  assert.equal(check.data.sampled, 3)
  assert.deepEqual(check.data.issues, [])
  assert.match(check.detail, /constrain filtering agrees with naive intervals/)
  assert.match(check.detail, /off\/index never filter/)
  assert.equal(status, 0)
})

test('selfcheck: recall fairness reports v1.4.0 lane/time telemetry and guarantees', () => {
  const root = makeTempDir()
  const sessionsDir = createEmptySessionsDir(root)
  createMultiStore(root, {
    sessionId: 'session-fair',
    folders: [{ createdAt: CURRENT_ERA_TS, scored: true }],
    statsEvents: [
      {
        type: 'recall',
        time: CURRENT_ERA_TS,
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
        missType: null,
      },
      {
        type: 'recall',
        time: CURRENT_ERA_TS + 1,
        mode: 'fair',
        candidates: 3,
        lanesPicked: { rareHigh: 1, queryBoost: 0, register: 0, hi: 2, lowProbe: 0, rotation: 0, recycle: 0 },
        pops: 4,
        registerDrops: 0,
        reInjections: 0,
        degraded: false,
        timeFiltered: 2,
        timeWindow: { from: CURRENT_ERA_TS, to: CURRENT_ERA_TS + 1, level: 'day', widenedTo: null },
        offset: 0,
        limit: 10,
        hasMore: false,
        missType: null,
      },
    ],
  })
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'recall fairness')
  assert.equal(check.status, 'PASS', check.detail)
  assert.equal(check.data.recallEvents, 2)
  assert.equal(check.data.v14Events, 2)
  assert.equal(check.data.lanes.hi, 7)
  assert.equal(check.data.lanes.rareHigh, 3)
  assert.equal(check.data.lanes.rotation, 1)
  assert.equal(check.data.reInjections, 1)
  assert.equal(check.data.timeFilteredEvents, 1)
  assert.equal(check.data.timeWindowEvents, 1)
  assert.equal(check.data.hasMoreEvents, 1)
  assert.equal(check.data.guarantees.meanPicks, 6.5)
  assert.equal(check.data.guarantees.highAlphaLaneShare, 84.62)
  assert.match(check.detail, /lanes rareHigh=3\/queryBoost=1/)
  assert.equal(status, 0)
})

test('selfcheck: degraded recall telemetry is a WARN, never a FAIL', () => {
  const root = makeTempDir()
  const sessionsDir = createEmptySessionsDir(root)
  createMultiStore(root, {
    sessionId: 'session-degraded',
    folders: [{ createdAt: CURRENT_ERA_TS, scored: true }],
    statsEvents: [
      {
        type: 'recall',
        time: CURRENT_ERA_TS,
        mode: 'fair',
        lanesPicked: { rareHigh: 0, queryBoost: 0, register: 0, hi: 2, lowProbe: 0, rotation: 0, recycle: 1 },
        registerDrops: 2,
        degraded: true,
        timeFiltered: 0,
      },
    ],
  })
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'recall fairness')
  assert.equal(check.status, 'WARN', check.detail)
  assert.equal(check.data.registerDropEvents, 1)
  assert.equal(check.data.registerDrops, 2)
  assert.equal(check.data.degradedEvents, 1)
  assert.match(check.detail, /guarantee degradation observed/)
  assert.equal(status, 0)
  assert.equal(json.summary.failed, 0)
})

test('selfcheck: no v1.4.0 recall telemetry is INFO (real data before the upgrade)', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const { json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'recall fairness')
  assert.equal(check.status, 'PASS', check.detail)
  assert.match(check.detail, /INFO: no v1\.4\.0 recall telemetry yet/)
  assert.equal(check.data.v14Events, 0)
})

// ---------------------------------------------------------------------------
// v1.4.0 event tag audit (INFO-only)
// ---------------------------------------------------------------------------

test('selfcheck: event tags reports INFO and never warns when nothing is tagged', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const { status, json } = runJson(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'event tags')
  assert.equal(check.status, 'PASS', check.detail)
  assert.match(check.detail, /INFO: no event-tagged memories yet \(0\/1 folder\(s\)/)
  assert.equal(check.data.foldersWithEvent, 0)
  assert.equal(check.data.distinctEvents, 0)
  assert.deepEqual(check.data.top, [])
  // event.mode consistency hint: engine default index vs packaged config
  // constrain (the packaged product enables the constraint).
  assert.equal(check.data.eventMode.engineDefault, 'index')
  assert.equal(check.data.eventMode.packaged, 'constrain')
  assert.equal(check.data.eventMode.effective, 'constrain')
  assert.equal(check.data.eventMode.packagedMatchesEffective, true)
  // It is a non-compat check placed right after `recall fairness`.
  const names = json.checks.map((entry) => entry.name)
  assert.equal(names.indexOf('event tags'), names.indexOf('recall fairness') + 1)
  assert.equal(status, 0)
})

test('selfcheck: event tags counts tagged folders, distinct events and the top events', () => {
  const root = makeTempDir()
  const sessionsDir = createEmptySessionsDir(root)
  createMultiStore(root, {
    sessionId: 'session-events',
    folders: [
      { createdAt: CURRENT_ERA_TS, scored: true, event: '日本旅行' },
      { createdAt: CURRENT_ERA_TS, scored: true, event: '日本旅行' },
      { createdAt: CURRENT_ERA_TS, scored: true, event: '登录重构项目' },
      { createdAt: CURRENT_ERA_TS, scored: true }, // untagged
    ],
  })
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'event tags')
  assert.equal(check.status, 'PASS', check.detail)
  assert.equal(check.data.folders, 4)
  assert.equal(check.data.foldersWithEvent, 3)
  assert.equal(check.data.distinctEvents, 2)
  assert.deepEqual(check.data.top, [
    { label: '日本旅行', count: 2 },
    { label: '登录重构项目', count: 1 },
  ])
  assert.match(check.detail, /3\/4 folder\(s\) event-tagged; 2 distinct event\(s\); top: 日本旅行=2, 登录重构项目=1/)
  assert.match(check.detail, /suspected unmerged pairs: 0/)
  assert.equal(status, 0)
})

test('selfcheck: event tags audits suspected unmerged labels but stays INFO (no WARN/FAIL)', () => {
  const root = makeTempDir()
  const sessionsDir = createEmptySessionsDir(root)
  // "日本旅行" and "日本旅行计划" are bidirectionally similar (dice 0.875 >= 0.72)
  // but have different canonical keys: the scoring path would have merged them,
  // so this pair is exactly the "same event, different label" audit finding.
  createMultiStore(root, {
    sessionId: 'session-unmerged',
    folders: [
      { createdAt: CURRENT_ERA_TS, scored: true, event: '日本旅行' },
      { createdAt: CURRENT_ERA_TS, scored: true, event: '日本旅行计划' },
    ],
  })
  const { status, json } = runJson(['--memory-dir', path.join(root, 'memory'), '--sessions-dir', sessionsDir])
  const check = findCheck(json, 'event tags')
  assert.equal(check.status, 'PASS', 'the unmerged-pair audit must never WARN or FAIL')
  assert.equal(check.data.suspiciousPairTotal, 1)
  assert.equal(check.data.suspiciousPairs.length, 1)
  assert.equal(check.data.suspiciousPairs[0].score >= 0.72, true)
  assert.match(check.detail, /suspected unmerged pairs: 1/)
  assert.match(check.detail, /日本旅行/)
  assert.equal(status, 0)
  assert.equal(json.summary.failed, 0)
})

// ---------------------------------------------------------------------------
// v1.3.0 compat checks
// ---------------------------------------------------------------------------

test('selfcheck: no compat line without a QQ plugin and without compat state (v1.2.1 parity)', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const args = ['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir]

  const human = runCli(args)
  assert.equal(human.status, 0)
  const output = String(human.stdout)
  const lines = output.trimEnd().split(/\r?\n/)
  assert.equal(lines.length, 11, `expected 9 check lines + platform line + summary, got:\n${output}`)
  assert.ok(!output.includes('compat'), `no compat line expected, got:\n${output}`)
  assert.match(lines.at(-2), /^platform: \S+ \S+, node \d+\.\d+\.\d+$/)
  // config/engine/memory/recall/era/time/fairness/event-tags pass, the empty
  // fixture has no session logs (WARN).
  assert.equal(lines.at(-1), 'selfcheck: 8 passed, 1 warnings, 0 failed')

  const { json } = runJson(args)
  assert.deepEqual(
    json.checks.map((check) => check.name),
    ENVIRONMENT_INDEPENDENT_CHECKS,
  )
  assert.deepEqual(json.summary, { passed: 8, warnings: 1, failed: 0 })
  assert.equal(json.exitCode, 0)
})

/**
 * The documented environment-dependent contract in one place: the same fixture
 * on a neutral host vs a QQ-plugin host. Detection may only APPEND compat lines
 * and bump the passed count; every environment-independent check must keep the
 * exact same status, and the exit code must stay 0.
 *
 * (G's docs describe both shapes: neutral → 8 passed/1 warning/0 failed,
 *  QQ plugin detected → 11 passed/1 warning/0 failed.)
 */
test('selfcheck: documented environment-dependent output (neutral 8/1/0 vs QQ 11/1/0)', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const args = ['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir]

  // 1) Neutral environment (the pin every other test uses): no compat lines.
  const neutral = runJson(args)
  assert.deepEqual(neutral.json.checks.map((check) => check.name), ENVIRONMENT_INDEPENDENT_CHECKS)
  assert.deepEqual(neutral.json.summary, { passed: 8, warnings: 1, failed: 0 })
  assert.equal(neutral.status, 0)

  // 2) QQ environment (both plugins detected + patched whitelist + valid state):
  //    exactly the three compat checks are appended and all pass.
  const profileDir = createQqProfile({
    onebot: true,
    derpyu: true,
    toolRestrict: toolRestrictSource(['ask_user_question', 'todo_write', 'memory_judge', 'memory_recall', 'memory_image']),
  })
  const targetFile = path.join(profileDir, 'node_modules', 'qq-agent-presets', 'qq-tool-restrict.mjs')
  writeJson(path.join(store.memoryDir, '.compat-state.json'), compatStatePayload(targetFile))
  const detected = runJson(args, { DSH_PROFILE_DIR: profileDir })
  assert.equal(detected.status, 0)
  assert.deepEqual(detected.json.checks.map((check) => check.name), [
    ...ENVIRONMENT_INDEPENDENT_CHECKS,
    'compat',
    'compat chat keys',
    'compat autopatch',
  ])
  assert.deepEqual(detected.json.summary, { passed: 11, warnings: 1, failed: 0 })

  // The environment only adds lines: the non-compat checks are byte-identical,
  // and the INFO-only `event tags` line exists in BOTH environments with the
  // same status (it is not a compat line).
  const statuses = (checks) => checks.filter((check) => !check.name.startsWith('compat')).map((check) => `${check.name}=${check.status}`)
  assert.deepEqual(statuses(detected.json.checks), statuses(neutral.json.checks))
  assert.equal(findCheck(neutral.json, 'event tags').status, 'PASS', findCheck(neutral.json, 'event tags').detail)
  assert.equal(findCheck(detected.json, 'event tags').status, findCheck(neutral.json, 'event tags').status)
  for (const name of ['compat', 'compat chat keys', 'compat autopatch']) {
    assert.equal(findCheck(detected.json, name).status, 'PASS', `${name} must PASS on a patched setup`)
  }

  // Human output of the detected environment: 12 check lines + platform + summary.
  const human = String(runCli(args, { DSH_PROFILE_DIR: profileDir }).stdout)
  assert.equal(human.trimEnd().split(/\r?\n/).length, 14)
  assert.equal(human.trimEnd().split(/\r?\n/).at(-1), 'selfcheck: 11 passed, 1 warnings, 0 failed')
})

test('selfcheck: a detected onebot plugin adds the compat and chat-key PASS lines', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const profileDir = createQqProfile({ onebot: true })
  const args = ['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir]

  const { status, json } = runJson(args, { DSH_PROFILE_DIR: profileDir })
  assert.equal(status, 0)
  const compat = findCheck(json, 'compat')
  assert.equal(compat.status, 'PASS', compat.detail)
  assert.equal(compat.detail, 'qqBots=auto; detected: dsh-onebot-qq')
  assert.deepEqual(compat.data.detected, ['dsh-onebot-qq'])
  assert.equal(compat.data.detection.enabled, true)

  const keys = findCheck(json, 'compat chat keys')
  assert.equal(keys.status, 'PASS', keys.detail)
  assert.match(keys.detail, /onebot-123456-lq3z8x9a → onebot-123456/)
  assert.equal(keys.data.mismatches.length, 0)
  assert.equal(keys.data.samples.length, 6)

  // No Derpyu plugin: no autopatch line, so exactly the two compat lines appear.
  assert.deepEqual(
    json.checks.filter((check) => check.name.startsWith('compat')).map((check) => check.name),
    ['compat', 'compat chat keys'],
  )
  assert.equal(json.summary.failed, 0)
  assert.equal(json.summary.passed, 10)

  const human = String(runCli(args, { DSH_PROFILE_DIR: profileDir }).stdout)
  assert.match(human, /^\[PASS\] compat — qqBots=auto; detected: dsh-onebot-qq$/m)
  assert.match(human, /^\[PASS\] compat chat keys — /m)
})

test('selfcheck: a detected Derpyu with a patched whitelist and valid state passes', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const profileDir = createQqProfile({
    derpyu: true,
    toolRestrict: toolRestrictSource(['ask_user_question', 'todo_write', 'memory_judge', 'memory_recall', 'memory_image']),
  })
  const targetFile = path.join(profileDir, 'node_modules', 'qq-agent-presets', 'qq-tool-restrict.mjs')
  writeJson(path.join(store.memoryDir, '.compat-state.json'), compatStatePayload(targetFile))
  const args = ['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir]

  const { status, json } = runJson(args, { DSH_PROFILE_DIR: profileDir })
  assert.equal(status, 0)
  const compat = findCheck(json, 'compat')
  assert.equal(compat.status, 'PASS', compat.detail)
  assert.match(compat.detail, /detected: derpyu-qq-bridge/)
  const autopatch = findCheck(json, 'compat autopatch')
  assert.equal(autopatch.status, 'PASS', autopatch.detail)
  assert.match(autopatch.detail, /memory_judge\/memory_recall\/memory_image present/)
  assert.equal(autopatch.data.stateRecords, 1)
  assert.equal(autopatch.data.patched, true)
  // All three compat checks are present and counted, and none is a FAIL.
  assert.deepEqual(
    json.checks.filter((check) => check.name.startsWith('compat')).map((check) => check.name),
    COMPAT_CHECK_NAMES,
  )
  assert.equal(json.summary.failed, 0)
  assert.equal(json.summary.passed, 11)
})

test('selfcheck: a detected Derpyu with an unpatched/broken whitelist warns but never fails', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const profileDir = createQqProfile({ derpyu: true, toolRestrict: toolRestrictSource(['ask_user_question', 'todo_write']) })
  // A corrupt state file must still only produce WARN, never FAIL.
  fs.writeFileSync(path.join(store.memoryDir, '.compat-state.json'), '{ broken json', 'utf8')
  const args = ['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir]

  const { status, json } = runJson(args, { DSH_PROFILE_DIR: profileDir })
  assert.equal(status, 0, 'compat problems must never fail the self-check')
  assert.equal(findCheck(json, 'compat').status, 'PASS')
  const autopatch = findCheck(json, 'compat autopatch')
  assert.equal(autopatch.status, 'WARN', autopatch.detail)
  assert.match(autopatch.detail, /not readable\/valid JSON/)
  assert.match(autopatch.detail, /memory_judge/)
  assert.equal(json.summary.failed, 0)
  assert.ok(json.checks.every((check) => check.status !== 'FAIL'))
})

test('selfcheck: a stale .compat-state.json alone surfaces WARN compat lines without a plugin', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  writeJson(path.join(store.memoryDir, '.compat-state.json'), compatStatePayload('C:/gone/qq-tool-restrict.mjs'))
  const args = ['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir]

  // Neutral fixture profile: no QQ plugin detected, only the state file remains.
  const { status, json } = runJson(args)
  assert.equal(status, 0)
  const compat = findCheck(json, 'compat')
  assert.equal(compat.status, 'WARN', compat.detail)
  assert.match(compat.detail, /detected: none/)
  assert.match(compat.detail, /stale state/)
  const autopatch = findCheck(json, 'compat autopatch')
  assert.equal(autopatch.status, 'WARN', autopatch.detail)
  assert.match(autopatch.detail, /stale compat state/)
  assert.equal(json.summary.failed, 0)
})

