/**
 * Passive archiving tests (plan D7).
 *
 * The archiver must recover the conversation hidden by a foreign
 * `compaction/summary` without touching the checkpoint, write one recall folder
 * in the same per-chat memory dir, dedupe by message seq through a durable
 * watermark, and never throw into the host's `session/event` listener.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { loadConfig, loadIndex, readFolder, readStats } from '../engine/index.js'
import { PassiveArchiver, extractShadowedMessages } from '../lib/passive-archive.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const tempDirs = []
function tempDir(prefix = 'dshr-passive-') {
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

function userEvent(seq, text) {
  return {
    seq,
    time: 1700000000000 + seq,
    type: 'user/message',
    data: { id: `u-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function assistantEvent(seq, text) {
  return {
    seq,
    time: 1700000000000 + seq,
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { id: `a-${seq}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] },
    },
  }
}

function systemEvent(seq, text) {
  return {
    seq,
    time: 1700000000000 + seq,
    type: 'system/message',
    data: { turn: 1, step: 1, message: { id: `s-${seq}`, role: 'system', content: [{ type: 'text', text }] } },
  }
}

function toolEvent(seq, text) {
  return {
    seq,
    time: 1700000000000 + seq,
    type: 'tool/result',
    data: { message: { id: `t-${seq}`, role: 'tool', toolCallId: `call-${seq}`, content: [{ type: 'text', text }] } },
  }
}

/** A compaction checkpoint message: user role, but never conversation. */
function checkpointEvent(seq) {
  return {
    seq,
    time: 1700000000000 + seq,
    type: 'user/message',
    data: {
      id: `c-${seq}`,
      role: 'user',
      source: { kind: 'compact-checkpoint', compactionId: 'foreign' },
      content: [{ type: 'text', text: '<compacted-summary>架构：使用 postgres</compacted-summary>' }],
    },
  }
}

function summaryEvent(seq, shadowedSeqs, extra = {}) {
  const seqs = [...shadowedSeqs]
  return {
    seq,
    time: 1700000000000 + seq,
    type: 'compaction/summary',
    data: {
      compactionId: `cmp-${seq}`,
      summary: [{ type: 'text', text: 'host compaction summary of the shadowed span' }],
      shadowedSeqs: seqs,
      shadowedRange: { start: seqs[0], end: seqs[seqs.length - 1] },
      shadowedTokenCount: 321,
      provider: 'test-provider',
      model: 'test-model',
      ...extra,
    },
  }
}

/** Minimal DSH-session stand-in: only eventAt + deriveEventMessage. */
function fakeSession(events, overrides = {}) {
  const bySeq = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (event && Number.isInteger(event.seq)) bySeq.set(event.seq, event)
  }
  return {
    id: 'session-1',
    eventAt(seq) {
      return bySeq.get(seq)
    },
    deriveEventMessage(event) {
      if (!event || typeof event !== 'object') return null
      if (event.type === 'user/message') return event.data
      if (event.type === 'assistant/message' || event.type === 'system/message' || event.type === 'tool/result') {
        return event.data?.message ?? null
      }
      return null
    },
    ...overrides,
  }
}

/** A conversation + one foreign compaction; the checkpoint is inside the span. */
function conversation() {
  const events = [
    userEvent(1, '部署 docker 服务，端口 8080 被占用，必须改成 9090。'),
    assistantEvent(2, '好的，修改 docker-compose.yml 的端口映射到 9090，并记录这个决定。'),
    systemEvent(3, 'runtime context: cwd C:\\work'),
    toolEvent(4, '容器已重启，状态 running'),
    checkpointEvent(5),
    summaryEvent(6, [1, 2, 3, 4, 5]),
  ]
  return { events, summary: events[events.length - 1] }
}

/**
 * Fake host with exactly the interface the archiver may use.
 * `memoryDirFor` lets a test scope the memory dir (e.g. by chat key).
 */
function fakeHost(options = {}) {
  const cfg = options.cfg ?? loadConfig(undefined, {})
  const dir = options.memoryDir ?? tempDir()
  const logs = []
  const host = {
    logs,
    currentConfig: () => cfg,
    scopedConfig(current, session) {
      if (options.scopedConfig) return options.scopedConfig(current, session)
      const memoryDir = options.memoryDirFor ? options.memoryDirFor(session) : dir
      return { ...current, memoryDir }
    },
    chatKeyFor: options.chatKeyFor ?? (() => 'chat-1'),
    log(level, message) {
      logs.push([level, message])
    },
  }
  if (options.scoringModeFor !== undefined) host.scoringModeFor = options.scoringModeFor
  return { host, cfg, memoryDir: dir, logs }
}

function memFolders(memoryDir) {
  try {
    return fs.readdirSync(memoryDir).filter((name) => name.startsWith('mem-'))
  } catch {
    return []
  }
}

function readWatermarkFile(memoryDir) {
  return JSON.parse(fs.readFileSync(path.join(memoryDir, '.passive-watermark.json'), 'utf8'))
}

// ---------------------------------------------------------------------------
// extractShadowedMessages
// ---------------------------------------------------------------------------

test('extract: recovers only user/assistant text and skips checkpoint/system/tool', () => {
  const { events, summary } = conversation()
  const session = fakeSession(events)
  const extracted = extractShadowedMessages(session, summary)

  assert.deepEqual(extracted.shadowedSeqs, [1, 2, 3, 4, 5])
  assert.equal(extracted.startSeq, 1)
  assert.equal(extracted.endSeq, 5)
  assert.equal(extracted.shadowedTokenCount, 321)
  assert.equal(extracted.messages.length, 2, 'system/tool/checkpoint messages are dropped')

  const [user, assistant] = extracted.messages
  assert.equal(user.role, 'user')
  assert.equal(typeof user.content, 'string')
  assert.ok(user.content.includes('docker'))
  assert.equal(user.time, 1700000000001, 'the event time is preserved')
  assert.equal(user.seq, undefined, 'messages use the normalized {role, content, time?} shape')
  assert.equal(assistant.role, 'assistant')
  assert.ok(assistant.content.includes('docker-compose.yml'))
})

test('extract: unsupported, malformed and broken input returns an empty result', () => {
  const { events, summary } = conversation()
  const session = fakeSession(events)

  const forbidden = extractShadowedMessages(session, { ...summary, type: 'turn/start' })
  assert.deepEqual(forbidden, { messages: [], shadowedSeqs: [], startSeq: null, endSeq: null, shadowedTokenCount: 0 })

  const noSeqs = extractShadowedMessages(session, {
    seq: 10,
    type: 'compaction/summary',
    data: { shadowedRange: { start: 1, end: 2 } },
  })
  assert.deepEqual(noSeqs.messages, [])
  assert.deepEqual(noSeqs.shadowedSeqs, [])

  const emptySeqs = extractShadowedMessages(session, {
    seq: 11,
    type: 'compaction/summary',
    data: { shadowedSeqs: [], shadowedRange: { start: 1, end: 2 } },
  })
  assert.deepEqual(emptySeqs.messages, [])

  for (const badSession of [null, {}, { eventAt() { throw new Error('boom') }, deriveEventMessage() { throw new Error('boom') } }]) {
    assert.doesNotThrow(() => extractShadowedMessages(badSession, summary))
    assert.deepEqual(extractShadowedMessages(badSession, summary).messages, [])
  }
  assert.deepEqual(extractShadowedMessages(session, null).messages, [])
  assert.deepEqual(extractShadowedMessages(session, { type: 'compaction/summary' }).messages, [])
})

// ---------------------------------------------------------------------------
// handle: happy path
// ---------------------------------------------------------------------------

test('handle: archives the shadowed conversation into the scoped memory dir (heuristic)', () => {
  const { events, summary } = conversation()
  const session = fakeSession(events)
  const { host, memoryDir, cfg } = fakeHost()

  const result = new PassiveArchiver(host).handle(session, summary)
  assert.equal(result.archived, 2, 'archived counts messages, not folders')
  assert.equal(result.folderIds.length, 1, 'one compaction event = at most one folder')
  assert.equal(result.skipped, undefined)

  const folderId = result.folderIds[0]
  const folder = readFolder(memoryDir, folderId)
  const { meta, messages } = folder

  // Scoring (heuristic fallback: no scoringModeFor hook).
  assert.equal(meta.scored, true)
  assert.equal(meta.alphaSource, 'heuristic')
  assert.equal(meta.keywordsSource, 'heuristic')
  assert.equal(meta.betaSource, 'default')
  assert.equal(meta.scoreMode, 'heuristic')
  assert.equal(meta.beta, 0)
  assert.ok(meta.alpha >= cfg.importance.min && meta.alpha <= cfg.importance.max)
  assert.ok(Array.isArray(meta.keywords) && meta.keywords.length >= cfg.keywords.min)
  assert.ok(meta.signals && typeof meta.signals === 'object')

  // Required D7 meta fields.
  assert.ok(Number.isFinite(meta.createdAt))
  assert.equal(meta.stats.messages, 2)
  assert.ok(meta.stats.chars > 0 && meta.stats.tokens > 0)
  assert.ok(typeof meta.title === 'string' && meta.title.length > 0)
  assert.ok([...meta.title].length <= 120, 'title is capped at 120 chars')
  assert.equal(meta.source.kind, 'passive-archive')
  assert.equal(meta.source.compactionSeq, 6)
  assert.equal(meta.source.seqStart, 1)
  assert.equal(meta.source.seqEnd, 5)

  // Stored conversation: only the two real messages, content as strings.
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(typeof messages[0].content, 'string')
  assert.ok(messages[0].content.includes('docker'))

  // Index stays consistent and the folder is immediately recallable.
  const index = loadIndex(memoryDir, cfg)
  assert.equal(index.folders.length, 1)
  assert.equal(index.folders[0].id, folderId)
  assert.equal(index.folders[0].scored, true)
  assert.equal(index.folders[0].messageCount, 2)

  // Telemetry.
  const stats = readStats(memoryDir, cfg)
  const archiveEvent = stats.find((event) => event.type === 'passive-archive')
  assert.ok(archiveEvent, 'a passive-archive telemetry event is written')
  assert.equal(archiveEvent.archivedMessages, 2)
  assert.equal(archiveEvent.compactionSeq, 6)
  assert.equal(archiveEvent.shadowedSeqCount, 5)
  assert.deepEqual(archiveEvent.folderIds, [folderId])
  assert.equal(archiveEvent.scoreMode, 'heuristic')
  assert.equal(archiveEvent.watermarkWritten, true)

  // Watermark: exactly the archived message seqs.
  const watermark = readWatermarkFile(memoryDir)
  assert.equal(watermark.version, 1)
  assert.deepEqual(watermark.archivedSeqs, [1, 2])
  assert.deepEqual(watermark.folderIds, [folderId])
  assert.ok(Number.isFinite(watermark.updatedAt))
  const leftovers = fs.readdirSync(memoryDir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'the watermark is written atomically (tmp + rename)')
})

test('handle: replaying the same event is a no-op, even from a fresh archiver instance', () => {
  const { events, summary } = conversation()
  const session = fakeSession(events)
  const { host, memoryDir, cfg } = fakeHost()
  const first = new PassiveArchiver(host).handle(session, summary)
  assert.equal(first.archived, 2)

  // A new instance simulates a plugin/host restart: only the on-disk watermark
  // can prevent the duplicate.
  const again = new PassiveArchiver(host).handle(session, summary)
  assert.equal(again.archived, 0)
  assert.deepEqual(again.folderIds, [])
  assert.equal(again.skipped, 'already-archived')

  assert.equal(loadIndex(memoryDir, cfg).folders.length, 1, 'no duplicate folder')
  assert.equal(memFolders(memoryDir).length, 1)
})

test('handle: a partially overlapping event archives only the new messages', () => {
  const events = [
    userEvent(1, '第一个话题：部署 docker 到 8080'),
    assistantEvent(2, '收到，记录 8080 部署方案。'),
    summaryEvent(3, [1, 2]),
    userEvent(4, '第二个话题：postgres 索引优化'),
    assistantEvent(5, '建议在 email 上建立 btree 索引。'),
    summaryEvent(6, [1, 2, 4, 5]),
  ]
  const session = fakeSession(events)
  const { host, memoryDir, cfg } = fakeHost()
  const archiver = new PassiveArchiver(host)

  const first = archiver.handle(session, events[2])
  assert.equal(first.archived, 2)
  const second = archiver.handle(session, events[5])
  assert.equal(second.archived, 2, 'only seqs 4 and 5 are new')
  assert.equal(second.folderIds.length, 1)

  const folder = readFolder(memoryDir, second.folderIds[0])
  assert.equal(folder.messages.length, 2)
  assert.ok(folder.messages[0].content.includes('postgres'))
  assert.deepEqual(readWatermarkFile(memoryDir).archivedSeqs, [1, 2, 4, 5])
  assert.equal(loadIndex(memoryDir, cfg).folders.length, 2)
})

// ---------------------------------------------------------------------------
// handle: scoring mode
// ---------------------------------------------------------------------------

test('handle: model scoring mode writes a pending folder for memory_judge', () => {
  const { events, summary } = conversation()
  const session = fakeSession(events)
  const { host, memoryDir } = fakeHost({ scoringModeFor: () => 'model' })

  const result = new PassiveArchiver(host).handle(session, summary)
  assert.equal(result.archived, 2)
  const folder = readFolder(memoryDir, result.folderIds[0])
  assert.equal(folder.meta.scored, false)
  assert.equal(folder.meta.alpha, 0)
  assert.equal(folder.meta.beta, 0)
  assert.deepEqual(folder.meta.keywords, [])
  assert.equal(folder.meta.alphaSource, 'pending')
  assert.equal(folder.meta.keywordsSource, 'pending')
  assert.equal(folder.meta.betaSource, 'pending')
  assert.equal(folder.meta.scoreMode, 'model')
  assert.ok(Number.isFinite(folder.meta.pendingSince))
  assert.equal(loadIndex(memoryDir, loadConfig(undefined, {})).folders[0].scored, false)
})

test('handle: a heuristic or throwing scoringModeFor falls back to heuristic scoring', () => {
  const { events, summary } = conversation()
  for (const scoringModeFor of [() => 'heuristic', () => 'unknown', () => { throw new Error('broken hook') }]) {
    const { host, memoryDir } = fakeHost({ scoringModeFor })
    const result = new PassiveArchiver(host).handle(fakeSession(events), summary)
    assert.equal(result.archived, 2)
    const folder = readFolder(memoryDir, result.folderIds[0])
    assert.equal(folder.meta.scored, true)
    assert.equal(folder.meta.alphaSource, 'heuristic')
    assert.equal(folder.meta.scoreMode, 'heuristic')
  }
})

test('handle: rofm\'s own archive-note summary is not archived a second time', () => {
  const { events } = conversation()
  const session = fakeSession(events)
  const note =
    '[memory] 2 段更早的对话已归档到 memory/（关键词：docker、端口）。需要时会自动回忆。'
  const ownSummary = summaryEvent(7, [1, 2], { summary: [{ type: 'text', text: note }] })
  const { host, memoryDir } = fakeHost()

  const result = new PassiveArchiver(host).handle(session, ownSummary)
  assert.equal(result.archived, 0)
  assert.equal(result.skipped, 'rofm-archive-note')
  assert.deepEqual(memFolders(memoryDir), [])
  assert.equal(fs.existsSync(path.join(memoryDir, '.passive-watermark.json')), false)
})

// ---------------------------------------------------------------------------
// handle: watermark / limits / resilience
// ---------------------------------------------------------------------------

test('handle: a corrupt watermark file degrades to empty and is repaired', () => {
  const { events, summary } = conversation()
  const session = fakeSession(events)
  const { host, memoryDir } = fakeHost()
  fs.writeFileSync(path.join(memoryDir, '.passive-watermark.json'), '{not json', 'utf8')

  const result = new PassiveArchiver(host).handle(session, summary)
  assert.equal(result.archived, 2, 'corrupt watermark must not block archiving')
  const watermark = readWatermarkFile(memoryDir)
  assert.deepEqual(watermark.archivedSeqs, [1, 2], 'the repaired watermark is valid JSON')

  // A valid-but-messy watermark is normalized rather than trusted blindly.
  fs.writeFileSync(
    path.join(memoryDir, '.passive-watermark.json'),
    JSON.stringify({ archivedSeqs: ['x', -1, 1, 1], folderIds: [null, 'mem-1'], updatedAt: 'soon' }),
    'utf8',
  )
  // The messy entry `1` survives normalization, so only message 2 is new.
  const { events: events2 } = conversation()
  const session2 = fakeSession(events2)
  const second = new PassiveArchiver(host).handle(session2, events2[events2.length - 1])
  assert.equal(second.archived, 1)
  assert.deepEqual(readWatermarkFile(memoryDir).archivedSeqs, [1, 2], 'invalid entries are dropped, valid seqs kept')
})

test('handle: storage.maxFolders is refused, not partially written', () => {
  const { events, summary } = conversation()
  const session = fakeSession(events)
  const cfg = loadConfig(undefined, { storage: { maxFolders: 1 } })
  const { host, memoryDir } = fakeHost({ cfg })
  const archiver = new PassiveArchiver(host)

  const first = archiver.handle(session, summary)
  assert.equal(first.archived, 2)
  assert.equal(loadIndex(memoryDir, cfg).folders.length, 1)

  const moreEvents = [
    userEvent(7, '第二个话题：缓存'),
    assistantEvent(8, '使用 redis 做缓存。'),
    summaryEvent(9, [7, 8]),
  ]
  const second = archiver.handle(fakeSession(events.concat(moreEvents)), moreEvents[2])
  assert.equal(second.archived, 0)
  assert.deepEqual(second.folderIds, [])
  assert.equal(second.reason, 'storage.maxFolders')
  assert.equal(second.skipped, 'storage.maxFolders')
  assert.equal(loadIndex(memoryDir, cfg).folders.length, 1, 'the cap is never exceeded')
  assert.deepEqual(readWatermarkFile(memoryDir).archivedSeqs, [1, 2], 'a refused folder does not advance the watermark')
})

test('handle: a rebuilt session with the same chat key shares the memory dir and watermark', () => {
  const { events, summary } = conversation()
  const base = tempDir()
  const cfg = loadConfig(undefined, {})
  const { host } = fakeHost({
    cfg,
    memoryDirFor: (session) => path.join(base, session.chatKey),
    chatKeyFor: (session) => session.chatKey,
  })
  const sessionA = { ...fakeSession(events), id: 'session-old', chatKey: 'qqb-g-42' }
  const sessionB = { ...fakeSession(events), id: 'session-rebuilt', chatKey: 'qqb-g-42' }
  const archiver = new PassiveArchiver(host)

  assert.equal(archiver.handle(sessionA, summary).archived, 2)
  const sharedDir = path.join(base, 'qqb-g-42')
  assert.ok(fs.existsSync(path.join(sharedDir, '.passive-watermark.json')))

  const rebuilt = archiver.handle(sessionB, summary)
  assert.equal(rebuilt.archived, 0, 'the rebuilt session reuses the same watermark')
  assert.equal(rebuilt.skipped, 'already-archived')
  assert.equal(loadIndex(sharedDir, cfg).folders.length, 1)

  const sessionC = { ...fakeSession(events), id: 'session-other', chatKey: 'qqb-g-43' }
  assert.equal(archiver.handle(sessionC, summary).archived, 2, 'another chat keeps its own memory dir')
  assert.equal(loadIndex(path.join(base, 'qqb-g-43'), cfg).folders.length, 1)
})

test('handle: unsupported events and broken sessions/hosts never throw', () => {
  const { events, summary } = conversation()
  const session = fakeSession(events)
  const { host } = fakeHost()
  const archiver = new PassiveArchiver(host)

  for (const event of [null, undefined, {}, { type: 'turn/start', data: {} }]) {
    const result = archiver.handle(session, event)
    assert.equal(result.archived, 0)
    assert.deepEqual(result.folderIds, [])
    assert.equal(result.skipped, 'unsupported-event')
  }

  for (const brokenSession of [null, {}, { eventAt: () => { throw new Error('boom') } }]) {
    const result = archiver.handle(brokenSession, summary)
    assert.equal(result.archived, 0)
    assert.equal(result.skipped, 'no-shadowed-conversation')
  }

  // An event with no recoverable shadowed seqs is a quiet no-op.
  for (const event of [
    { seq: 20, type: 'compaction/summary', data: {} },
    { seq: 21, type: 'compaction/summary', data: { shadowedSeqs: [] } },
    { seq: 22, type: 'compaction/summary', data: { shadowedSeqs: [999] } },
  ]) {
    const result = archiver.handle(session, event)
    assert.equal(result.archived, 0)
    assert.equal(result.skipped, 'no-shadowed-conversation')
  }

  // A host missing the required hooks degrades instead of throwing.
  const noHost = new PassiveArchiver(undefined)
  assert.equal(noHost.handle(session, summary).skipped, 'no-config')
  const throwingHost = new PassiveArchiver({
    currentConfig() {
      throw new Error('config store exploded')
    },
    scopedConfig() {
      throw new Error('scoped config exploded')
    },
    chatKeyFor() {
      throw new Error('chat key exploded')
    },
    log() {
      throw new Error('logger exploded')
    },
  })
  assert.doesNotThrow(() => throwingHost.handle(session, summary))
  assert.equal(throwingHost.handle(session, summary).archived, 0)
})

test('handle: telemetry failure does not break archiving', () => {
  const { events, summary } = conversation()
  const session = fakeSession(events)
  const { host, memoryDir, cfg } = fakeHost()
  // Make the stats file unwritable (a directory): appendStats must stay best effort.
  fs.mkdirSync(path.join(memoryDir, 'stats.jsonl'), { recursive: true })

  const result = new PassiveArchiver(host).handle(session, summary)
  assert.equal(result.archived, 2)
  assert.equal(result.folderIds.length, 1)
  assert.equal(loadIndex(memoryDir, cfg).folders.length, 1)
  assert.deepEqual(readWatermarkFile(memoryDir).archivedSeqs, [1, 2])
})
