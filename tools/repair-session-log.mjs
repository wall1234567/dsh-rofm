#!/usr/bin/env node
/**
 * dsh-rofm — session-log repair tool.
 *
 * Repairs the one durable-log defect this plugin could write: a synthetic
 * `user/message` (the recall block) appended without its message `id`.
 *
 * DSH identifies every message event by `message.id`; the persistence layer
 * refuses to reload a log that carries a message without one
 * ("… lacks an identified message") and reports the whole session as corrupt,
 * which the GUI shows as "历史加载失败" with chat and rename blocked. The fix
 * itself lives in `lib/plugin.js` (the recall message now always carries an id);
 * this tool repairs logs written before that fix so the sessions open again.
 *
 *   node tools/repair-session-log.mjs [options] [<file|dir> …]
 *
 * Options:
 *   --dry-run          report only, never write
 *   --no-backup        do not keep <file>.bak-<timestamp>
 *   -h, --help         show this help
 *
 * With no path the tool scans `$DSH_HOME/sessions` (default
 * `~/.dsh/sessions`) for `*.jsonl.zstd` / `*.jsonl` logs.
 *
 * Repair rules (nothing else is touched):
 *   - `user/message` whose payload has no non-empty `data.id` → insert a uuid.
 *   - `developer/message` / `system/message` / `assistant/message` /
 *     `tool/result` whose `data.message.id` is missing → insert a uuid.
 * A message that is *also* missing role/source/content is reported as
 * unrepairable and left alone instead of being invented.
 *
 * Re-encoded logs keep DSH's own layout: one zstd frame with the header line,
 * then frames of event batches (checksum enabled), so the host appends to them
 * exactly as before.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
/** Events per zstd frame, mirroring the host's batch-sized appends. */
const EVENTS_PER_FRAME = 256
/** Message-bearing event types and where their identified message lives. */
const MESSAGE_EVENT_TYPES = new Set(['developer/message', 'system/message', 'user/message', 'assistant/message', 'tool/result'])

const USAGE = `dsh-rofm session-log repair (zero dependencies)

Usage:
  node tools/repair-session-log.mjs [options] [<file|dir> …]

Options:
  --dry-run   report only, write nothing
  --no-backup skip the <file>.bak-<timestamp> copy
  -h, --help  show this help

With no path, scans $DSH_HOME/sessions (default ~/.dsh/sessions).
It only adds the missing message id(s) that make DSH reject a log with
"历史加载失败"; every other byte of the events is preserved.`

/** Compress one JSONL chunk into a single zstd frame the host can append after. */
function encodeFrame(text) {
  try {
    return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    })
  } catch {
    return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
  }
}

/**
 * Locate every zstd frame in a concatenated-frame container without
 * decompressing its blocks (skippable frames included).
 *
 * @param {Buffer} buffer the whole `.jsonl.zstd` file
 * @returns {{type: 'zstd'|'skippable', start: number, end: number}[]}
 * @throws {Error} when the container is truncated or holds an unknown frame
 */
export function locateFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset)
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      if (offset + 8 > buffer.length) throw new Error(`truncated skippable frame at byte ${offset}`)
      const size = buffer.readUInt32LE(offset + 4)
      const end = offset + 8 + size
      if (end > buffer.length) throw new Error(`truncated skippable frame at byte ${offset}`)
      frames.push({ type: 'skippable', start: offset, end })
      offset = end
      continue
    }
    if (magic !== ZSTD_MAGIC) throw new Error(`unexpected zstd magic 0x${magic.toString(16)} at byte ${offset}`)
    const start = offset
    offset += 4
    if (offset >= buffer.length) throw new Error(`truncated zstd frame header at byte ${start}`)
    const descriptor = buffer[offset]
    offset += 1
    const contentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionaryFlag = descriptor & 3
    if (!singleSegment) offset += 1
    offset += [0, 1, 2, 4][dictionaryFlag]
    offset += [singleSegment ? 1 : 0, 2, 4, 8][contentSizeFlag]
    for (;;) {
      if (offset + 3 > buffer.length) throw new Error(`truncated zstd block header in frame at byte ${start}`)
      const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
      offset += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >>> 3
      if (type === 0) offset += size
      else if (type === 1) offset += 1
      else if (type === 2) offset += size
      else throw new Error(`reserved zstd block type in frame at byte ${start}`)
      if (last) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) throw new Error(`truncated zstd frame at byte ${start}`)
    frames.push({ type: 'zstd', start, end: offset })
  }
  return frames
}

/**
 * Decode a whole `.jsonl.zstd` container into its JSONL text.
 *
 * @param {Buffer} buffer raw file bytes
 * @returns {string} decoded JSONL (header line first)
 */
export function decodeJournal(buffer) {
  const parts = []
  for (const frame of locateFrames(buffer)) {
    if (frame.type !== 'zstd') continue
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
    } catch (error) {
      throw new Error(`corrupt zstd frame at byte ${frame.start}: ${error.message}`, { cause: error })
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Encode JSONL text back into DSH's container layout (header frame, then
 * event-batch frames).
 *
 * @param {string} text JSONL text ending with a newline
 * @returns {Buffer} the `.jsonl.zstd` bytes
 */
export function encodeJournal(text) {
  const lines = text.split('\n')
  const trailing = lines.at(-1) === ''
  if (trailing) lines.pop()
  if (lines.length === 0) return Buffer.alloc(0)
  const frames = [encodeFrame(lines[0] + '\n')]
  for (let index = 1; index < lines.length; index += EVENTS_PER_FRAME) {
    frames.push(encodeFrame(lines.slice(index, index + EVENTS_PER_FRAME).join('\n') + '\n'))
  }
  return Buffer.concat(frames)
}

/** Whether one message object is identified (non-empty string id). */
function hasId(message) {
  return typeof message?.id === 'string' && message.id.length > 0
}

/** Whether a message object carries the fields DSH needs besides its id. */
function hasMessageShape(message, expectedRole) {
  return (
    message !== null &&
    typeof message === 'object' &&
    message.role === expectedRole &&
    typeof message.source === 'object' &&
    message.source !== null &&
    typeof message.source.kind === 'string' &&
    message.source.kind.length > 0 &&
    Array.isArray(message.content)
  )
}

const EXPECTED_ROLE = {
  'developer/message': 'developer',
  'system/message': 'system',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/**
 * Add the missing message id(s) to one JSONL journal text.
 *
 * Pure: the caller decides whether to write the result. Idempotent — a repaired
 * journal reports zero repairs when passed in again.
 *
 * @param {string} text JSONL text (header line first, one event per line)
 * @param {{ idFactory?: () => string }} [options] injectable id source (tests)
 * @returns {{ text: string, repairs: {seq: number|null, type: string, id: string}[], unrepairable: {seq: number|null, type: string, reason: string}[], changed: boolean }}
 */
export function repairJournalText(text, options = {}) {
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : randomUUID
  const lines = text.split('\n')
  const repairs = []
  const unrepairable = []
  const repaired = lines.map((line, index) => {
    if (index === 0 || line.trim() === '') return line
    let event
    try {
      event = JSON.parse(line)
    } catch {
      unrepairable.push({ seq: null, type: 'unparsable-line', reason: `line ${index + 1} is not JSON` })
      return line
    }
    const type = event?.type
    if (!MESSAGE_EVENT_TYPES.has(type)) return line
    const isUserEvent = type === 'user/message'
    const message = isUserEvent ? event.data : event.data?.message
    if (hasId(message)) return line
    if (!hasMessageShape(message, EXPECTED_ROLE[type])) {
      unrepairable.push({
        seq: typeof event.seq === 'number' ? event.seq : null,
        type,
        reason: 'message is missing role/source/content, so an id alone cannot make it valid',
      })
      return line
    }
    const id = idFactory()
    if (isUserEvent) event.data.id = id
    else message.id = id
    repairs.push({ seq: typeof event.seq === 'number' ? event.seq : null, type, id })
    return JSON.stringify(event)
  })
  return {
    text: repaired.join('\n'),
    repairs,
    unrepairable,
    changed: repairs.length > 0,
  }
}

/** Repair one log file on disk (or report what would change with dryRun). */
export function repairJournalFile(file, options = {}) {
  const { dryRun = false, backup = true, idFactory } = options
  const raw = fs.readFileSync(file)
  const compressed = file.endsWith('.zstd')
  const text = compressed ? decodeJournal(raw) : raw.toString('utf8')
  const result = repairJournalText(text, { idFactory })
  const report = {
    file,
    compressed,
    repairs: result.repairs,
    unrepairable: result.unrepairable,
    changed: result.changed,
    written: false,
    backupPath: null,
  }
  if (!result.changed || dryRun) return report
  const encoded = compressed ? encodeJournal(result.text) : Buffer.from(result.text, 'utf8')
  if (backup) {
    const backupPath = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(file, backupPath)
    report.backupPath = backupPath
  }
  // Rename into place so a reader never observes a half-written log.
  const temp = `${file}.repair-${process.pid}.tmp`
  fs.writeFileSync(temp, encoded)
  try {
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    fs.writeFileSync(file, encoded)
    report.renameFallback = error.message
  }
  report.written = true
  return report
}

/** Collect session logs under one directory tree. */
export function findSessionLogs(root) {
  const found = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
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
      if (/\.jsonl(\.zstd)?$/.test(entry.name)) found.push(full)
    }
  }
  return found.sort()
}

function main(argv) {
  const args = argv.slice(2)
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE)
    return 0
  }
  const dryRun = args.includes('--dry-run')
  const backup = !args.includes('--no-backup')
  const targets = args.filter((arg) => !arg.startsWith('--'))
  const roots = targets.length > 0
    ? targets
    : [path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions')]
  const files = []
  for (const target of roots) {
    const resolved = path.resolve(target)
    if (!fs.existsSync(resolved)) {
      console.error(`dsh-rofm repair: no such path: ${resolved}`)
      continue
    }
    if (fs.statSync(resolved).isDirectory()) files.push(...findSessionLogs(resolved))
    else files.push(resolved)
  }
  if (files.length === 0) {
    console.error('dsh-rofm repair: no `*.jsonl.zstd` / `*.jsonl` session logs found')
    return 1
  }
  let changed = 0
  let pending = 0
  let problems = 0
  for (const file of files) {
    let report
    try {
      report = repairJournalFile(file, { dryRun, backup })
    } catch (error) {
      console.error(`✖ ${file}: ${error.message}`)
      problems += 1
      continue
    }
    if (report.repairs.length === 0 && report.unrepairable.length === 0) continue
    const action = report.written ? 'repaired' : dryRun ? 'would repair' : 'unchanged'
    for (const repair of report.repairs) {
      console.log(`${action} ${file}: seq ${repair.seq} ${repair.type} lost its message id → ${repair.id}`)
    }
    for (const problem of report.unrepairable) {
      console.error(`✖ ${file}: seq ${problem.seq} ${problem.type} needs a manual fix — ${problem.reason}`)
      problems += 1
    }
    if (report.backupPath !== null) console.log(`  backup: ${report.backupPath}`)
    if (report.renameFallback !== undefined) console.log(`  (in-place write: ${report.renameFallback})`)
    if (report.written) changed += 1
    else if (report.repairs.length > 0) pending += 1
  }
  if (changed === 0 && pending === 0 && problems === 0) {
    console.log(`dsh-rofm repair: ${files.length} log(s) checked, nothing to repair`)
    return 0
  }
  const pendingText = pending > 0 ? `, ${pending} would be repaired (dry run)` : ''
  console.log(`dsh-rofm repair: ${files.length} log(s) checked, ${changed} written${pendingText}, ${problems} problem(s)`)
  return problems > 0 ? 1 : 0
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href.replace(/\\/g, '/')) {
  process.exitCode = main(process.argv)
}
