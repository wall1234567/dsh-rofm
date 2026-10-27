/**
 * dsh-rofm — self-check tool tests (v1.2.0 R5).
 *
 * Black-box: every test spawns `node tools/selfcheck.mjs` (the same way a user
 * runs it) against a throw-away memory/sessions fixture in `os.tmpdir()`, then
 * asserts the human/JSON output and the exit code. Nothing here imports the
 * adapter or the engine, so the tool is exercised exactly as shipped.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { encodeJournal } from '../tools/repair-session-log.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELFCHECK = path.join(REPO_ROOT, 'tools', 'selfcheck.mjs')
const SPAWN_TIMEOUT_MS = 180_000
const FIXTURE_CREATED_AT = 1793000000000
const FIXTURE_FOLDER_ID = 'mem-20261026T131909Z-0001'

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

function runCli(args) {
  return spawnSync(process.execPath, [SELFCHECK, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
}

/** Run with --json and return { status, json, stdout, stderr }. */
function runJson(args) {
  const result = runCli(['--json', ...args])
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
  assert.equal(findCheck(json, 'recall state').status, 'PASS', findCheck(json, 'recall state').detail)
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

test('selfcheck: two dsh-rofm checkpoint notes on one final surface are a WARN (legacy)', () => {
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

test('selfcheck: a note appendix with re-injected runtime context is a FAIL', () => {
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

test('selfcheck: a foreign checkpoint is counted but does not fail', () => {
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

test('selfcheck: human output uses check lines and the summary line', () => {
  const root = makeTempDir()
  const store = createGoodStore(root)
  const sessionsDir = createEmptySessionsDir(root)
  const good = runCli(['--memory-dir', store.memoryDir, '--sessions-dir', sessionsDir])
  assert.equal(good.status, 0)
  const lines = String(good.stdout).trimEnd().split(/\r?\n/)
  assert.ok(lines.length >= 2)
  for (const line of lines.slice(0, -1)) {
    assert.match(line, /^\[(PASS|WARN|FAIL)\] [^—]+— .+$/, `unexpected check line: ${line}`)
  }
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
})

test('selfcheck: --session limits the session-log check to one session id', () => {
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
