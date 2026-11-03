/**
 * v1.4.1 compress transaction regressions (A-01 / A-02 / A-06 / A-07).
 *
 * A-01 — commit idempotency keys must be unique *inside one plan*: a single
 *        over-long tool output split into several chunks can produce chunks with
 *        identical (seqStart, seqEnd, contentHash); 1.4.0 skipped all but the
 *        first one as a "retry" and the adapter then replaced the conversation
 *        span with a note → archived text was lost.
 * A-02 — a process killed between writing the folders and writing index.json
 *        must be recovered: the journal folderIds / orphan folders are adopted
 *        into the index on the next load, so a retried archive writes nothing
 *        twice (README §1.1 "崩溃后重试不会重复归档").
 * A-06 — `loadIndex` never throws when the rebuild write fails.
 * A-07 — a valid index missing on-disk entries self-heals from the folder metas.
 *
 * Tests only write under `os.tmpdir()`; the crash test spawns a child process
 * with the real engine modules (SIGKILL during the index rename).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  commitCompression,
  indexEntryFromMeta,
  loadConfig,
  loadIndex,
  planCompression,
  readFolder,
  writeFolder,
  writeIndex,
} from '../engine/index.js'

const ROOT = path.resolve(import.meta.dirname, '..')

const tempDirs = []
function tempDir(prefix = 'dshr-tx-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

/** Product-ish config, but with the release floor disabled for readable fixture arithmetic. */
function makeCfg(patch = {}) {
  return loadConfig(undefined, {
    compress: {
      enabled: true,
      triggerPercent: 60,
      compressPercent: 20,
      releaseFloorEnabled: false,
      contextWindowTokens: 0,
      minContextTokens: 0,
      minMessagesToCompress: 1,
      minChunkChars: 50,
      targetChunkChars: 1200,
      maxFoldersPerRun: 500,
      keepRecentMessages: 0,
      allowSmallWindow: true,
    },
    ...patch,
  })
}

const LOG_LINE = '[worker] heartbeat ok status=200 elapsed=3ms\n'
/** One tool output of 18,000 chars made of identical lines (the A-01 trigger). */
const REPEATED_TOOL_OUTPUT = LOG_LINE.repeat(400)

function a01Messages() {
  return [
    { role: 'user', content: '帮我检查 300 个 worker 的部署日志，把 tail 输出给我' },
    { role: 'assistant', content: '调用工具 [tool-call: bash]' },
    { role: 'tool', content: REPEATED_TOOL_OUTPUT },
    { role: 'assistant', content: '日志看起来全部 ok，300 个 worker 心跳正常。' },
    { role: 'user', content: '现在总结一下上面的部署结论' },
  ]
}

function contentChars(messages) {
  return messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0)
}

function planFor(messages, usedPercent = 99, now = 1761217200000) {
  const cfg = makeCfg()
  return {
    cfg,
    plan: planCompression({
      messages,
      usedPercent,
      cfg,
      totalUsedTokens: 999999,
      windowTokens: 200000,
      now,
      sessionId: 'sess-tx',
      turn: 7,
    }),
  }
}

function folderIdsOnDisk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith('.'))
    .map((dirent) => dirent.name)
    .sort()
}

function journalFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith('.commit-') && name.endsWith('.json'))
}

function readIndexFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
}

// ---------------------------------------------------------------------------
// A-01 — intra-plan idempotency-key collision
// ---------------------------------------------------------------------------

test('A-01: one plan with identical repeated-line chunks commits every planned folder and preserves text', () => {
  const { cfg, plan } = planFor(a01Messages())
  assert.ok(plan.folders.length > 1, `fixture must split into several chunks, got ${plan.folders.length}`)
  const planned = plan.folders.length
  const intendedChars = contentChars(plan.remove)
  const dir = tempDir()

  const committed = commitCompression(plan, {
    memoryDir: dir,
    cfg,
    sessionId: 'sess-tx',
    turn: 7,
    idempotencyKey: true,
  })

  assert.equal(committed.folders.length, planned, `committed ${committed.folders.length} of ${planned} planned folders`)
  assert.equal(committed.skipped, 0, 'no chunk of the same plan may be skipped as a retry')
  assert.equal(folderIdsOnDisk(dir).length, planned)

  // Text preservation: the concatenated archived bodies equal the removed span.
  const archivedChars = committed.folders.reduce((sum, folder) => sum + contentChars(folder.messages), 0)
  assert.equal(archivedChars, intendedChars, `archived ${archivedChars} chars, removed span has ${intendedChars}`)
  assert.ok(archivedChars >= REPEATED_TOOL_OUTPUT.length, 'the whole repeated tool output must be archived')

  // The repeated lines really did produce identical content chunks (the trigger).
  const keys = committed.folders.map((folder) => folder.meta.idempotencyKey)
  assert.equal(new Set(keys).size, planned, 'every chunk gets a distinct idempotency key')
  const bodies = committed.folders.map((folder) => JSON.stringify(folder.messages.map((message) => message.content)))
  assert.ok(new Set(bodies).size < planned, 'fixture sanity: at least two chunks have byte-identical bodies')

  // A real retry of the same plan (new `now`) must still skip everything.
  const retry = planFor(a01Messages(), 99, 1761219000000)
  const retried = commitCompression(retry.plan, {
    memoryDir: dir,
    cfg: retry.cfg,
    sessionId: 'sess-tx',
    turn: 7,
    idempotencyKey: true,
  })
  assert.equal(retried.folders.length, 0, 'retry must not duplicate archived folders')
  assert.equal(retried.skipped, planned)
  assert.equal(folderIdsOnDisk(dir).length, planned, 'disk still holds exactly one copy per planned chunk')
})

// ---------------------------------------------------------------------------
// A-02 — crash between folder writes and index write
// ---------------------------------------------------------------------------

/**
 * Child process: hard-crash (SIGKILL) on the commit's `index.json` rename.
 * The memory dir is pre-seeded with a valid empty index by the parent, so the
 * *first* index rename is the commit point (no rebuild beforehand).
 */
const CRASH_CHILD_SOURCE = `
import fs from 'node:fs'
const engine = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'engine', 'index.js')).href)})
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const cfg = engine.loadConfig(undefined, input.overrides)
const realRename = fs.renameSync
fs.renameSync = (from, to) => {
  if (String(to).endsWith('index.json')) process.kill(process.pid, 'SIGKILL')
  return realRename(from, to)
}
engine.commitCompression(input.plan, {
  memoryDir: input.dir,
  cfg,
  sessionId: input.sessionId,
  turn: input.turn,
  idempotencyKey: true,
})
process.stdout.write('child-finished-without-crash')
`

function runCrashChild(dir, plan, overrides) {
  const workDir = tempDir('dshr-crash-')
  const child = path.join(workDir, 'crash-child.mjs')
  fs.writeFileSync(child, CRASH_CHILD_SOURCE, 'utf8')
  const inputFile = path.join(workDir, 'input.json')
  fs.writeFileSync(
    inputFile,
    JSON.stringify({
      dir,
      overrides,
      sessionId: 'sess-crash',
      turn: 7,
      plan: {
        folders: plan.folders.map((folder) => ({
          id: folder.meta.id,
          meta: folder.meta,
          messages: folder.messages,
        })),
      },
    }),
    'utf8',
  )
  return spawnSync(process.execPath, [child, inputFile], { encoding: 'utf8', timeout: 120000 })
}

function crashMessages() {
  const messages = []
  for (let index = 0; index < 6; index += 1) {
    messages.push({ role: 'user', content: `第 ${index} 轮：部署 docker 端口 8080 与数据库迁移怎么做？` })
    messages.push({ role: 'assistant', content: `第 ${index} 轮回答：把 compose 里的 ports 改成 8080:80，并跑迁移脚本。`.repeat(10) })
  }
  messages.push({ role: 'user', content: '最后的问题：总结部署步骤' })
  return messages
}

test('A-02: crash before the index write is adopted on reload, and the retry does not duplicate', () => {
  const { cfg, plan } = planFor(crashMessages())
  const planned = plan.folders.length
  assert.ok(planned >= 2, `fixture must produce several folders, got ${planned}`)
  const dir = tempDir()
  // A valid empty index: loadIndex must not rebuild (and rewrite index.json)
  // before the commit reaches its own index write.
  writeIndex(dir, cfg, { version: 1, nextCounter: 1, folders: [] })

  const child = runCrashChild(dir, plan, {})
  // The child must have crashed before writing: defensively accept only the
  // "no output" case (`child-finished-without-crash` means the SIGKILL hook was
  // not reached, i.e. the fixture broke).
  assert.ok(!String(child.stdout || '').includes('child-finished-without-crash'), `child did not crash: ${child.stdout} ${child.stderr}`)
  assert.equal(journalFiles(dir).length, 1, 'crash leaves exactly one commit journal behind')
  assert.equal(folderIdsOnDisk(dir).length, planned, 'all folders were written before the crash')
  assert.equal(readIndexFile(dir).folders.length, 0, 'index.json was not updated by the crashed commit')

  // Restart: loadIndex adopts the orphan folders from the journal/meta files.
  const recovered = loadIndex(dir, cfg)
  assert.equal(recovered.folders.length, planned, 'recovered index lists every folder written by the crashed commit')
  assert.equal(readIndexFile(dir).folders.length, planned, 'the adopted index was persisted')
  assert.equal(journalFiles(dir).length, 0, 'the recovered journal was cleaned up')

  // Retry the same archive with a later `now`: nothing may be written twice.
  const retry = planFor(crashMessages(), 99, 1761219000000)
  const retried = commitCompression(retry.plan, {
    memoryDir: dir,
    cfg: retry.cfg,
    sessionId: 'sess-crash',
    turn: 7,
    idempotencyKey: true,
  })
  assert.equal(retried.folders.length, 0, 'retry after the crash archived nothing new')
  assert.equal(retried.skipped, planned, 'every chunk is recognised as already archived')
  assert.equal(folderIdsOnDisk(dir).length, planned, 'disk folder count did not double')
  assert.equal(retried.index.folders.length, planned)
})

// ---------------------------------------------------------------------------
// A-06 / A-07 — loadIndex robustness
// ---------------------------------------------------------------------------

test('A-06: loadIndex does not throw when the rebuild write fails (read-only store)', () => {
  const cfg = makeCfg()
  const dir = tempDir()
  writeFolder(dir, {
    id: 'mem-20261102T000000Z-0001',
    meta: { createdAt: 1, alpha: 0.5, keywords: ['kw'], title: 'a', stats: { messages: 1, chars: 10, tokens: 3 } },
    messages: [{ role: 'user', content: 'hello' }],
  })
  // Corrupt index forces a rebuild; the rebuild's write then fails.
  fs.writeFileSync(path.join(dir, 'index.json'), '{"version":1,"folders":[', 'utf8')
  const realRename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('index.json')) {
      const error = new Error('EACCES: permission denied')
      error.code = 'EACCES'
      throw error
    }
    return realRename(from, to)
  }
  try {
    const index = loadIndex(dir, cfg)
    assert.equal(index.folders.length, 1, 'the in-memory rebuild is still returned')
    assert.equal(index.stale, true, 'the fallback is flagged as not persisted')
  } finally {
    fs.renameSync = realRename
  }
})

test('A-07: a valid index missing on-disk entries self-heals from the folder metas', () => {
  const cfg = makeCfg()
  const dir = tempDir()
  const ids = []
  for (let at = 1; at <= 3; at += 1) {
    const id = `mem-20261102T000000Z-000${at}`
    ids.push(id)
    writeFolder(dir, {
      id,
      meta: { createdAt: at, alpha: 0.5, keywords: ['kw'], title: `f${at}`, stats: { messages: 1, chars: 10, tokens: 3 } },
      messages: [{ role: 'user', content: `hello ${at}` }],
    })
  }
  // A syntactically valid index that lists only two of the three folders.
  writeIndex(dir, cfg, {
    version: 1,
    nextCounter: 3,
    folders: ids.slice(0, 2).map((id, at) => ({
      id,
      createdAt: at + 1,
      alpha: 0.5,
      keywords: ['kw'],
      title: `f${at + 1}`,
      stats: { messages: 1, chars: 10, tokens: 3 },
      chars: 10,
      tokens: 3,
      messageCount: 1,
    })),
  })
  assert.equal(readIndexFile(dir).folders.length, 2, 'fixture: index is valid but incomplete')
  const healed = loadIndex(dir, cfg)
  assert.equal(healed.folders.length, 3, 'the missing folder is adopted from disk')
  assert.deepEqual(healed.folders.map((folder) => folder.id).sort(), ids)
  assert.equal(readIndexFile(dir).folders.length, 3, 'the healed index is persisted')
  // Reading a folder survived the round-trip (no data loss).
  assert.equal(readFolder(dir, ids[2]).messages[0].content, 'hello 3')
})

test('A-07: self-healed index entries keep every optional meta field (indexEntryFromMeta contract)', () => {
  const cfg = makeCfg()
  const dir = tempDir()
  const optional = {
    pendingEra: 'synthetic',
    pendingSince: 1234,
    scoreMode: 'heuristic',
    archivedFrom: 'passive',
    archivedByVersion: '1.4.0',
    idempotencyKey: 'sess-1|7|0|3|deadbeef',
    event: '日本旅行',
    eventSource: 'llm',
    eventAt: 5678,
    eventStart: 1000,
    eventEnd: 2000,
    rescorePending: true,
  }
  const ids = []
  for (let at = 1; at <= 2; at += 1) {
    const id = `mem-20261102T000000Z-000${at}`
    ids.push(id)
    writeFolder(dir, {
      id,
      meta: {
        createdAt: at,
        alpha: 0.5,
        keywords: ['kw'],
        title: `f${at}`,
        stats: { messages: 1, chars: 10, tokens: 3 },
        ...(at === 2 ? optional : {}),
        images: [{ name: 'img-1.png', mediaType: 'image/png', width: 1, height: 1, bytes: 10 }],
      },
      messages: [{ role: 'user', content: `hello ${at}` }],
    })
  }
  // Valid index that lists only the first folder; the second must be adopted.
  writeIndex(dir, cfg, {
    version: 1,
    nextCounter: 3,
    folders: [indexEntryFromMeta(readFolder(dir, ids[0]).meta)],
  })
  const healed = loadIndex(dir, cfg)
  assert.equal(healed.folders.length, 2)
  const adopted = healed.folders.find((folder) => folder.id === ids[1])
  assert.ok(adopted, 'the missing folder is adopted')
  for (const [key, expected] of Object.entries(optional)) {
    assert.deepEqual(adopted[key], expected, `adopted index entry must keep ${key}`)
  }
  // The reverse-direction optional fields that are *not* part of the index entry
  // shape stay on disk (meta.json is the single truth) and are not lost.
  assert.deepEqual(readFolder(dir, ids[1]).meta.images, [
    { name: 'img-1.png', mediaType: 'image/png', width: 1, height: 1, bytes: 10 },
  ])
})
