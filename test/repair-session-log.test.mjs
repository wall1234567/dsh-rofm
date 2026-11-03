/**
 * dsh-rofm — session-log repair tool tests.
 *
 * The regression this guards: an injected synthetic `user/message` without a
 * message id makes DSH refuse to reload the whole session log, so the GUI shows
 * "历史加载失败" and blocks chat/rename.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import {
  decodeJournal,
  encodeJournal,
  locateFrames,
  repairJournalFile,
  repairJournalText,
} from '../tools/repair-session-log.mjs'

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'repair-session-log.mjs')

// node:zlib's zstd codecs landed in Node 22.15/23.8. The repair tool itself cannot
// encode/decode zstd journals on older Node, so these cases are skipped there
// (the rest of the engine suite still runs).
const ZSTD_SUPPORTED =
  typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'
const testIfZstd = ZSTD_SUPPORTED ? test : test.skip

const HEADER = JSON.stringify({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:/work' })

function userEvent(seq, id) {
  return JSON.stringify({
    type: 'user/message',
    seq,
    time: 1700000000000,
    data: {
      ...(id === undefined ? {} : { id }),
      role: 'user',
      source: { kind: 'rofm-recall', form: 'snapshot', summary: '记忆回忆' },
      content: [{ type: 'text', text: '## 记忆回忆' }],
    },
    surfaceOp: 'append',
  })
}

function journal(...lines) {
  return [HEADER, ...lines].join('\n') + '\n'
}

testIfZstd('repair: an id-less synthetic user message gains exactly one id', () => {
  const input = journal(userEvent(1, undefined), JSON.stringify({ type: 'turn/start', seq: 2, data: { turn: 1 } }))
  const result = repairJournalText(input, { idFactory: () => 'fixed-id' })
  assert.equal(result.changed, true)
  assert.deepEqual(result.repairs, [{ seq: 1, type: 'user/message', id: 'fixed-id' }])
  assert.deepEqual(result.unrepairable, [])
  const events = result.text.split('\n').filter((line) => line !== '').slice(1).map((line) => JSON.parse(line))
  assert.equal(events[0].data.id, 'fixed-id')
  assert.equal(events[0].data.role, 'user', 'the payload keeps its role')
  assert.equal(events[0].data.source.kind, 'rofm-recall', 'the payload keeps its source kind')
  assert.deepEqual(events[1], { type: 'turn/start', seq: 2, data: { turn: 1 } }, 'other events stay byte-identical')
  assert.equal(result.text.split('\n')[0], HEADER, 'the header line is preserved')
})

testIfZstd('repair: a journal that already carries ids is left untouched (idempotent)', () => {
  const input = journal(userEvent(1, 'already-there'))
  const first = repairJournalText(input, { idFactory: () => 'new-id' })
  assert.equal(first.changed, false)
  assert.deepEqual(first.repairs, [])
  assert.equal(first.text, input)

  const broken = journal(userEvent(1, undefined))
  const repaired = repairJournalText(broken, { idFactory: () => 'new-id' })
  const again = repairJournalText(repaired.text, { idFactory: () => 'other-id' })
  assert.equal(again.changed, false, 'a repaired journal reports no further repairs')
})

testIfZstd('repair: message-bearing events use data.message, user/message uses data itself', () => {
  const assistant = JSON.stringify({
    type: 'assistant/message',
    seq: 1,
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [], stream: [] } },
  })
  const result = repairJournalText(journal(assistant), { idFactory: () => 'assistant-id' })
  assert.deepEqual(result.repairs, [{ seq: 1, type: 'assistant/message', id: 'assistant-id' }])
  const message = JSON.parse(result.text.split('\n')[1]).data.message
  assert.equal(message.id, 'assistant-id')
  assert.equal(message.source.model, 'm')
})

testIfZstd('repair: a message missing role/source/content is reported, not invented', () => {
  const hollow = JSON.stringify({ type: 'user/message', seq: 7, data: { surfaceOp: 'append' } })
  const result = repairJournalText(journal(hollow), { idFactory: () => 'x' })
  assert.equal(result.changed, false)
  assert.deepEqual(result.repairs, [])
  assert.equal(result.unrepairable.length, 1)
  assert.equal(result.unrepairable[0].seq, 7)
  assert.match(result.unrepairable[0].reason, /role\/source\/content/)
})

testIfZstd('repair: an unparsable event line is reported instead of dropped', () => {
  const result = repairJournalText(journal('{not json'), { idFactory: () => 'x' })
  assert.equal(result.unrepairable.length, 1)
  assert.equal(result.unrepairable[0].type, 'unparsable-line')
  assert.ok(result.text.includes('{not json'), 'the broken line is preserved for a human')
})

testIfZstd('journal: decode/encode round-trips a multi-frame zstd container', () => {
  const events = []
  for (let seq = 0; seq < 300; seq += 1) events.push(userEvent(seq, `id-${seq}`))
  const text = journal(...events)
  const encoded = encodeJournal(text)
  assert.ok(locateFrames(encoded).length > 2, 'event batches span several frames')
  assert.equal(decodeJournal(encoded), text)
})

// ---------------------------------------------------------------------------
// v1.4.1 F-07: the write path (dry-run / backup / atomic write / CLI)
// ---------------------------------------------------------------------------

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-repair-'))
}

function backupsIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.bak-'))
}

/** One zstd session log whose 2nd event is a recall user/message without an id. */
function writeBrokenLog(dir, name = 'session.v4.jsonl.zstd') {
  const file = path.join(dir, name)
  const text = journal(userEvent(1, undefined), JSON.stringify({ type: 'turn/start', seq: 2, data: { turn: 1 } }))
  fs.writeFileSync(file, encodeJournal(text))
  return { file, text }
}

testIfZstd('repair: repairJournalFile --dry-run reports but never writes (F-07)', () => {
  const dir = tempDir()
  try {
    const { file } = writeBrokenLog(dir)
    const before = fs.readFileSync(file)
    const report = repairJournalFile(file, { dryRun: true, idFactory: () => 'dry-id' })
    assert.equal(report.changed, true, 'the damage is still reported')
    assert.equal(report.written, false, '--dry-run must not write')
    assert.deepEqual(report.repairs.map((repair) => repair.id), ['dry-id'])
    assert.equal(fs.readFileSync(file).equals(before), true, 'the log bytes are untouched')
    assert.deepEqual(backupsIn(dir), [], '--dry-run must not create a backup')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

testIfZstd('repair: a real repair keeps a backup, writes atomically and is idempotent (F-07)', () => {
  const dir = tempDir()
  try {
    const { file, text } = writeBrokenLog(dir)
    const original = fs.readFileSync(file)
    const report = repairJournalFile(file, { idFactory: () => 'fixed-id' })
    assert.equal(report.written, true)
    assert.equal(report.changed, true)
    assert.ok(report.backupPath && fs.existsSync(report.backupPath), 'a backup is kept by default')
    assert.equal(fs.readFileSync(report.backupPath).equals(original), true, 'the backup is the original bytes')
    // Only the damaged event changed: every other line stays byte-identical.
    const beforeLines = decodeJournal(original).split('\n')
    const afterLines = decodeJournal(fs.readFileSync(file)).split('\n')
    assert.equal(afterLines.length, beforeLines.length)
    for (let index = 0; index < beforeLines.length; index += 1) {
      if (index === 1) continue
      assert.equal(afterLines[index], beforeLines[index], `line ${index} must stay byte-identical`)
    }
    assert.equal(JSON.parse(afterLines[1]).data.id, 'fixed-id')
    assert.equal(JSON.parse(afterLines[1]).type, 'user/message')
    // Idempotent: a repaired journal reports nothing and creates no second backup.
    const second = repairJournalFile(file, { idFactory: () => 'other-id' })
    assert.equal(second.changed, false)
    assert.equal(second.written, false)
    assert.equal(backupsIn(dir).length, 1, 'no duplicate backup on the idempotent second run')
    // The re-encoded container stays a valid multi-frame journal.
    assert.ok(locateFrames(fs.readFileSync(file)).length >= 1)
    assert.equal(decodeJournal(fs.readFileSync(file)).length > 0, true)
    void text
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

testIfZstd('repair: --no-backup skips the backup file (F-07)', () => {
  const dir = tempDir()
  try {
    const { file } = writeBrokenLog(dir)
    const report = repairJournalFile(file, { backup: false, idFactory: () => 'fixed-id' })
    assert.equal(report.written, true)
    assert.equal(report.backupPath, null)
    assert.deepEqual(backupsIn(dir), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('repair: CLI --dry-run writes nothing; a real run repairs with a backup and is idempotent (F-07)', () => {
  const dir = tempDir()
  try {
    // Plain `.jsonl` works on every supported Node (no zstd needed for this case).
    const file = path.join(dir, 'session.v4.jsonl')
    const broken = journal(userEvent(1, undefined))
    fs.writeFileSync(file, broken, 'utf8')
    const dry = spawnSync(process.execPath, [TOOL, '--dry-run', file], { encoding: 'utf8' })
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /would repair/)
    assert.equal(fs.readFileSync(file, 'utf8'), broken, '--dry-run must not rewrite the log')
    assert.deepEqual(backupsIn(dir), [])

    const real = spawnSync(process.execPath, [TOOL, file], { encoding: 'utf8' })
    assert.equal(real.status, 0, real.stderr)
    assert.match(real.stdout, /repaired/)
    assert.equal(backupsIn(dir).length, 1, 'the CLI keeps a backup')
    const repaired = fs.readFileSync(file, 'utf8')
    assert.notEqual(repaired, broken)
    assert.equal(typeof JSON.parse(repaired.split('\n')[1]).data.id, 'string')

    const again = spawnSync(process.execPath, [TOOL, file], { encoding: 'utf8' })
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /nothing to repair/)
    assert.equal(backupsIn(dir).length, 1, 'no new backup when nothing changed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('repair: CLI reports an unrepairable message and exits 1 (F-07)', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'session.v4.jsonl')
    fs.writeFileSync(file, journal(JSON.stringify({ type: 'user/message', seq: 7, data: { surfaceOp: 'append' } })), 'utf8')
    const result = spawnSync(process.execPath, [TOOL, file], { encoding: 'utf8' })
    assert.equal(result.status, 1, 'an unrepairable log must not look repaired')
    assert.match(result.stderr, /needs a manual fix/)
    assert.match(result.stdout, /1 problem\(s\)/)
    assert.deepEqual(backupsIn(dir), [], 'nothing is written when nothing can be repaired')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
