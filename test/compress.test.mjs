/**
 * Compression tests — trigger threshold, earliest-percent selection, newest
 * messages kept, tool-call/result pairs never split, folder chunking, ids,
 * persistence and telemetry (docs/SPEC.md §10.4).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  buildArchiveNote,
  commitCompression,
  formatFolderId,
  loadConfig,
  loadIndex,
  memoryPaths,
  parseArchiveNote,
  planCompression,
  readFolder,
  readStats,
  renderMessage,
} from '../engine/index.js'

const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-compress-'))
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

function makeCfg(patch = {}) {
  const base = {
    compress: {
      enabled: true,
      triggerPercent: 60,
      compressPercent: 20,
      contextWindowTokens: 0,
      minContextTokens: 0,
      minMessagesToCompress: 4,
      minChunkChars: 50,
      targetChunkChars: 200,
      maxFoldersPerRun: 100,
      keepRecentMessages: 2,
    },
  }
  return loadConfig(undefined, {
    ...patch,
    compress: { ...base.compress, ...(patch.compress || {}) },
  })
}

/** Alternating user/assistant conversation with explicit token counts. */
function makeMessages(count, { tokens = 100, chars = 30 } = {}) {
  const messages = []
  for (let index = 0; index < count; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `部署 docker 端口配置 第${index}轮 ${'X'.repeat(Math.max(0, chars - 20))}`,
      tokens,
    })
  }
  return messages
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

test('compress: trigger only strictly above triggerPercent', () => {
  const cfg = makeCfg()
  const messages = makeMessages(10)
  const low = planCompression({ messages, usedPercent: 60, cfg, totalUsedTokens: 1000 })
  assert.equal(low.shouldCompress, false)
  assert.equal(low.reason, 'below-threshold')
  assert.deepEqual(low.folders, [])
  const high = planCompression({ messages, usedPercent: 60.1, cfg, totalUsedTokens: 1000 })
  assert.equal(high.shouldCompress, true)
  assert.equal(high.reason, 'ok')
  assert.deepEqual(high.keep, messages.slice(2))
  assert.deepEqual(high.remove, messages.slice(0, 2))
  assert.equal(high.folders.length, 1)
})

test('compress: disabled compression is a no-op with a warning', () => {
  const cfg = makeCfg({ compress: { enabled: false } })
  const plan = planCompression({ messages: makeMessages(10), usedPercent: 90, cfg, totalUsedTokens: 1000 })
  assert.equal(plan.shouldCompress, false)
  assert.equal(plan.reason, 'below-threshold')
  assert.ok(plan.warnings.some((warning) => /compress\.enabled/.test(warning)))
})

test('compress: earliest compressPercent of used context is removed', () => {
  const cfg = makeCfg()
  const messages = makeMessages(10) // 10 x 100 tokens
  const byMessages = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 1000 })
  assert.equal(byMessages.remove.length, 2) // 20% of 1000 tokens
  // the host-provided denominator overrides the message estimate
  const larger = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 2000 })
  assert.equal(larger.remove.length, 4) // 20% of 2000 tokens
  // falling back to sum(estimateMessagesTokens(messages))
  const fallback = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 0 })
  assert.equal(fallback.remove.length, 2)
  assert.equal(fallback.removeTokens, 200)
  assert.equal(fallback.usedTokens, 1000)
  assert.equal(fallback.totalTokens, 1000)
})

test('compress: keeps the newest keepRecentMessages messages', () => {
  const cfg = makeCfg({ compress: { compressPercent: 90 } })
  const messages = makeMessages(10)
  const plan = planCompression({ messages, usedPercent: 95, cfg, totalUsedTokens: 1000 })
  assert.equal(plan.keep.length, 2)
  assert.deepEqual(plan.keep, messages.slice(8))
  assert.equal(plan.remove.length, 8)
})

test('compress: never splits an assistant tool-call from its tool result', () => {
  const cfg = makeCfg()
  const messages = [
    { role: 'user', content: '请部署并检查状态', tokens: 100 },
    { role: 'assistant', content: '[tool-call: bash] 执行健康检查', tokens: 100 },
    { role: 'tool', content: 'HTTP/1.1 200 OK', tokens: 100 },
    { role: 'assistant', content: '服务正常，继续。', tokens: 100 },
    { role: 'user', content: '继续配置端口', tokens: 100 },
    { role: 'assistant', content: '端口 8080 已配置。', tokens: 100 },
    { role: 'user', content: '再检查一下', tokens: 100 },
    { role: 'assistant', content: '检查完毕。', tokens: 100 },
  ]
  // target = 20% of 800 = 160 tokens -> raw cut lands after the tool message
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 800 })
  assert.equal(plan.shouldCompress, true)
  assert.equal(plan.keep[0].role, 'user', 'remaining history must start at a user message')
  const removed = plan.remove
  for (let index = 0; index < removed.length; index += 1) {
    const message = removed[index]
    if (message.role === 'assistant' && String(message.content).includes('[tool-call:')) {
      assert.equal(removed[index + 1] && removed[index + 1].role, 'tool', 'tool-call must stay with its tool result')
    }
    if (message.role === 'tool') {
      assert.ok(index > 0, 'a tool result must never be the first removed message')
    }
  }
  assert.equal(plan.remove.some((message) => message.role === 'tool'), true)
})

test('compress: removed span is split into multiple folders on turn boundaries', () => {
  const cfg = makeCfg({ compress: { targetChunkChars: 200, minChunkChars: 50, keepRecentMessages: 2 } })
  const messages = []
  for (let index = 0; index < 10; index += 1) {
    messages.push({ role: 'user', content: `第${index}轮 部署 docker 端口配置方案 ${'Y'.repeat(40)}`, tokens: 100 })
    messages.push({ role: 'assistant', content: `好的，第${index}轮方案已确认，参数如下 ${'Z'.repeat(40)}`, tokens: 100 })
  }
  const plan = planCompression({ messages, usedPercent: 90, cfg, totalUsedTokens: 2000 })
  assert.ok(plan.folders.length > 1, `expected multiple folders, got ${plan.folders.length}`)
  assert.equal(plan.folders.reduce((sum, folder) => sum + folder.messages.length, 0), plan.remove.length)
  const ids = plan.folders.map((folder) => folder.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^mem-\d{8}T\d{6}Z-\d{4}$/)
  for (let index = 0; index < plan.folders.length; index += 1) {
    const folder = plan.folders[index]
    assert.ok(folder.meta.alpha >= 0.01 && folder.meta.alpha <= 1)
    assert.ok(Array.isArray(folder.meta.keywords))
    assert.ok(folder.meta.title.length <= 24)
    assert.equal(folder.meta.stats.messages, folder.messages.length)
    assert.equal(folder.meta.stats.chars, folder.messages.reduce((sum, message) => sum + renderMessage(message).length, 0))
    assert.ok(folder.messages.length > 0)
    if (index > 0) assert.ok(folder.meta.createdAt > plan.folders[index - 1].meta.createdAt)
    assert.ok(Number.isFinite(folder.meta.source.seqStart))
    assert.ok(folder.meta.source.seqEnd >= folder.meta.source.seqStart)
  }
  assert.equal(plan.folders.reduce((sum, folder) => sum + folder.meta.stats.chars, 0), plan.removeChars)
})

test('compress: tiny trailing chunk is merged into the previous folder', () => {
  const cfg = makeCfg({
    compress: { targetChunkChars: 650, minChunkChars: 100, keepRecentMessages: 0, minMessagesToCompress: 2, compressPercent: 90 },
  })
  // one folder's worth + a tiny tail (all user messages = one turn per message)
  const messages = [
    { role: 'user', content: `A${'a'.repeat(299)}`, tokens: 100 },
    { role: 'user', content: `B${'b'.repeat(299)}`, tokens: 100 },
    { role: 'user', content: `C${'c'.repeat(49)}`, tokens: 100 },
    { role: 'user', content: `D${'d'.repeat(49)}`, tokens: 100 },
  ]
  // remove 3 messages (~656 rendered chars): last chunk would be ~56 chars < minChunkChars
  const plan = planCompression({ messages, usedPercent: 90, cfg, totalUsedTokens: 400 })
  assert.equal(plan.remove.length, 3)
  assert.equal(plan.folders.length, 1, 'tiny tail must be merged into the previous folder')
})

test('compress: maxFoldersPerRun caps the folder count', () => {
  const cfg = makeCfg({ compress: { targetChunkChars: 50, minChunkChars: 1, maxFoldersPerRun: 3, keepRecentMessages: 0, minMessagesToCompress: 2 } })
  const messages = []
  for (let index = 0; index < 12; index += 1) messages.push({ role: 'user', content: `消息 ${index} ${'q'.repeat(80)}`, tokens: 100 })
  const plan = planCompression({ messages, usedPercent: 95, cfg, totalUsedTokens: 1200 })
  assert.ok(plan.folders.length <= 3, `got ${plan.folders.length} folders`)
  // A single oversized message may be split into several pieces (at sentence
  // boundaries); coverage is >= removed count.
  assert.ok(plan.folders.reduce((sum, folder) => sum + folder.messages.length, 0) >= plan.remove.length)
})

test('compress: reason mapping for tiny contexts and unremovable spans', () => {
  const cfg = makeCfg({ compress: { minContextTokens: 5000 } })
  const tiny = planCompression({ messages: makeMessages(10), usedPercent: 90, cfg, totalUsedTokens: 1000 })
  assert.equal(tiny.shouldCompress, false)
  assert.equal(tiny.reason, 'too-few-messages')

  const few = planCompression({ messages: makeMessages(3), usedPercent: 90, cfg: makeCfg(), totalUsedTokens: 300 })
  assert.equal(few.reason, 'nothing-to-remove')

  const keepEverything = planCompression({ messages: makeMessages(10), usedPercent: 90, cfg: makeCfg({ compress: { keepRecentMessages: 10 } }), totalUsedTokens: 1000 })
  assert.equal(keepEverything.reason, 'nothing-to-remove')

  const zeroTokens = planCompression({
    messages: makeMessages(10, { tokens: 0 }),
    usedPercent: 90,
    cfg: makeCfg(),
    totalUsedTokens: 0,
  })
  assert.equal(zeroTokens.reason, 'nothing-to-remove')
})

test('compress: buildArchiveNote is the generic [memory] note', () => {
  const cfg = makeCfg()
  const messages = makeMessages(10)
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 1000 })
  const note = buildArchiveNote(plan)
  assert.match(note, /^\[memory\] /)
  assert.match(note, /段更早的对话已归档到 memory\//)
  assert.match(note, /关键词：/)
  assert.equal(buildArchiveNote({ folders: [] }), '')
})

test('compress: heuristic archive is immediately scored (β=0/betaSource=default, scored=true)', () => {
  const cfg = makeCfg()
  const memoryDir = tempDir()
  const plan = planCompression({ messages: makeMessages(12), usedPercent: 90, cfg, totalUsedTokens: 1200, now: 1700000000123 })
  assert.ok(plan.folders.length > 0)
  for (const folder of plan.folders) {
    assert.equal(folder.meta.beta, 0)
    assert.equal(folder.meta.betaSource, 'default')
    assert.ok(Object.is(folder.meta.beta, 0), 'β must never be -0')
    // the engine heuristic path needs no model judging: folders are recallable at once
    assert.equal(folder.meta.scored, true)
  }
  const result = commitCompression(plan, { memoryDir, cfg })
  assert.equal(result.folders.length, plan.folders.length)
  for (const folder of result.folders) {
    const disk = readFolder(memoryDir, folder.id)
    assert.equal(disk.meta.beta, 0)
    assert.equal(disk.meta.betaSource, 'default')
    assert.equal(disk.meta.scored, true)
  }
  // the index entry carries the same defaulted β and the scored flag
  const index = loadIndex(memoryDir, cfg)
  assert.equal(index.folders.length, result.folders.length)
  for (const entry of index.folders) {
    assert.equal(entry.beta, 0)
    assert.equal(entry.scored, true)
    assert.equal(entry.rescorePending, false)
  }
})

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

test('compress: commit writes folders + index + telemetry, keeps ordering', () => {
  const cfg = makeCfg({ compress: { targetChunkChars: 200, keepRecentMessages: 2 } })
  const memoryDir = tempDir()
  const messages = makeMessages(16, { chars: 60 })
  const plan = planCompression({ messages, usedPercent: 90, cfg, totalUsedTokens: 1600, sessionId: 'sess-1', now: 1700000000123, turn: 7 })
  assert.equal(plan.shouldCompress, true)

  const result = commitCompression(plan, { memoryDir, cfg, sessionId: 'sess-1' })
  assert.equal(result.folders.length, plan.folders.length)
  assert.equal(result.removed.length, plan.remove.length)
  assert.deepEqual(result.keep, plan.keep)

  const index = loadIndex(memoryDir, cfg)
  assert.equal(index.folders.length, plan.folders.length)
  for (const folder of result.folders) {
    const dir = path.join(memoryDir, folder.id)
    assert.ok(fs.existsSync(path.join(dir, 'meta.json')))
    assert.ok(fs.existsSync(path.join(dir, 'context.json')))
    assert.ok(index.folders.some((entry) => entry.id === folder.id))
    const read = readFolder(memoryDir, folder.id)
    assert.equal(read.meta.id, folder.id)
    assert.equal(read.meta.source.sessionId, 'sess-1')
    assert.equal(read.meta.source.turn, 7)
    assert.deepEqual(read.messages, folder.messages)
  }
  // created folders keep chronological order
  const createdAts = result.folders.map((folder) => folder.meta.createdAt)
  assert.deepEqual(createdAts, createdAts.slice().sort((a, b) => a - b))

  const events = readStats(memoryDir, cfg)
  const compressEvents = events.filter((event) => event.type === 'compress')
  assert.equal(compressEvents.length, 1)
  assert.equal(compressEvents[0].folderIds.length, result.folders.length)
  assert.equal(compressEvents[0].removedChars, plan.removeChars)
  assert.equal(compressEvents[0].keptMessages, plan.keep.length)
  assert.equal(compressEvents[0].sessionId, 'sess-1')
})

test('compress: commit is idempotent-safe for the same plan', () => {
  const cfg = makeCfg()
  const memoryDir = tempDir()
  const messages = makeMessages(12)
  const plan = planCompression({ messages, usedPercent: 90, cfg, totalUsedTokens: 1200, sessionId: 'idem', now: 1700000000999 })
  const first = commitCompression(plan, { memoryDir, cfg, sessionId: 'idem' })
  assert.ok(first.folders.length > 0)
  const statsAfterFirst = readStats(memoryDir, cfg).length
  const indexAfterFirst = loadIndex(memoryDir, cfg).folders.length

  const second = commitCompression(plan, { memoryDir, cfg, sessionId: 'idem' })
  assert.equal(second.folders.length, 0)
  assert.ok(second.skipped >= 1)
  assert.equal(loadIndex(memoryDir, cfg).folders.length, indexAfterFirst)
  assert.equal(readStats(memoryDir, cfg).length, statsAfterFirst)
})

test('compress: commit copies the optional source object into meta.source', () => {
  const cfg = makeCfg()
  const memoryDir = tempDir()
  const messages = makeMessages(10)
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 1000, sessionId: 'plan-session', turn: 3 })
  const result = commitCompression(plan, {
    memoryDir,
    cfg,
    sessionId: 'commit-session',
    turn: 4,
    source: { sessionId: 'adapter-session', channel: 'web', turn: 5 },
  })
  assert.ok(result.folders.length > 0)
  const meta = result.folders[0].meta
  assert.equal(meta.source.sessionId, 'adapter-session')
  assert.equal(meta.source.channel, 'web')
  assert.equal(meta.source.turn, 5)
  assert.ok(Number.isFinite(meta.source.seqStart))
})

test('compress: same-millisecond unrelated plans do not lose data', () => {
  const cfg = makeCfg()
  const memoryDir = tempDir()
  const now = 1700000000500
  const planA = planCompression({ messages: makeMessages(10), usedPercent: 80, cfg, totalUsedTokens: 1000, now })
  const planB = planCompression({ messages: makeMessages(12, { chars: 50 }), usedPercent: 80, cfg, totalUsedTokens: 1200, now })
  const a = commitCompression(planA, { memoryDir, cfg })
  const b = commitCompression(planB, { memoryDir, cfg })
  assert.ok(a.folders.length > 0)
  assert.ok(b.folders.length > 0)
  const index = loadIndex(memoryDir, cfg)
  assert.equal(index.folders.length, a.folders.length + b.folders.length)
  assert.equal(new Set(index.folders.map((folder) => folder.id)).size, index.folders.length)
})

test('compress: turn-boundary alignment cannot overshoot the target without a cap', () => {  // A long tool-heavy turn after u2: reaching the 20% target lands inside that
  // turn; the *next* user boundary (u3) would remove far more than the target.
  const messages = [
    { role: 'user', content: 'u1', tokens: 100 },
    { role: 'assistant', content: 'a1', tokens: 100 },
    { role: 'assistant', content: 'a2', tokens: 100 },
    { role: 'user', content: 'u2', tokens: 100 },
    ...Array.from({ length: 20 }, (_, index) => ({ role: 'assistant', content: `b${index}`, tokens: 100 })),
    { role: 'user', content: 'u3', tokens: 100 },
    ...Array.from({ length: 10 }, (_, index) => ({ role: 'assistant', content: `c${index}`, tokens: 100 })),
    { role: 'user', content: 'u4', tokens: 100 },
  ]
  const cfg = makeCfg({ compress: { compressPercent: 20, maxBoundaryOvershoot: 1.25 } })
  const plan = planCompression({ messages, usedPercent: 70, cfg, totalUsedTokens: 5000, windowTokens: 10000 })
  assert.equal(plan.shouldCompress, true)
  // target = 20% * 5000 = 1000 tokens; forward boundary would remove ~2400 tokens.
  assert.ok(plan.removeTokens <= 1000 * 1.25, `removal overshot the cap: ${plan.removeTokens}`)
  assert.ok(plan.warnings.some((warning) => warning.includes('kept the shorter')), 'overshoot fallback recorded')
  assert.equal(plan.keep[0].role, 'user', 'remaining history still starts at a user message')
})

test('compress: one oversized user turn is split into multiple folders', () => {
  const big = 'x'.repeat(100)
  const messages = [{ role: 'user', content: big, tokens: 100 }]
  for (let index = 0; index < 20; index += 1) messages.push({ role: 'assistant', content: big, tokens: 100 })
  messages.push({ role: 'user', content: 'u2', tokens: 100 })
  for (let index = 0; index < 5; index += 1) messages.push({ role: 'assistant', content: big, tokens: 100 })
  const cfg = makeCfg({ compress: { compressPercent: 80, targetChunkChars: 250, minChunkChars: 50, maxFoldersPerRun: 100 } })
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 2600, windowTokens: 5000 })
  assert.equal(plan.shouldCompress, true)
  assert.ok(plan.folders.length >= 2, `single huge turn produced ${plan.folders.length} folder(s)`)
  const maxChars = Math.max(...plan.folders.map((folder) => folder.meta.stats.chars))
  assert.ok(maxChars <= 350, `one folder still too large: ${maxChars} chars`)
})

test('compress: a single message larger than targetChunkChars is split for the LLM scorer', () => {
  // Sentence-punctuated huge text: the message still crosses several folders, and
  // the splitter may only cut after a sentence terminator (sentence integrity).
  const huge = `BEGIN-${'这是一句需要被完整保留的内容。'.repeat(120)}-END`
  const messages = [
    { role: 'user', content: huge, tokens: 500 },
    { role: 'assistant', content: 'noted', tokens: 10 },
    { role: 'user', content: 'u2', tokens: 10 },
    { role: 'assistant', content: 'ok', tokens: 10 },
    { role: 'user', content: 'u3', tokens: 10 },
    { role: 'assistant', content: 'ok', tokens: 10 },
  ]
  const cfg = makeCfg({ compress: { compressPercent: 90, targetChunkChars: 250, minChunkChars: 50, maxFoldersPerRun: 100, keepRecentMessages: 2 } })
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 3000, windowTokens: 5000 })
  assert.equal(plan.shouldCompress, true)
  assert.ok(plan.folders.length >= 2, `huge message produced ${plan.folders.length} folder(s)`)
  const maxChars = Math.max(...plan.folders.map((folder) => folder.meta.stats.chars))
  assert.ok(maxChars <= 350, `folder too large for complete-content scoring: ${maxChars} chars`)
  const allText = plan.folders.flatMap((folder) => folder.messages.map((message) => String(message.content))).join('')
  assert.ok(allText.includes('BEGIN-') && allText.includes('-END'), 'huge message content is preserved across folders')
  // Cutting is only allowed at sentence ends, so the pieces must rebuild the
  // removed span exactly (huge message, then the following removed messages).
  assert.equal(allText, `${huge}notedu2ok`, 'the sentence-punctuated huge message is preserved exactly across folders')
})

test('compress: meta.source seqStart/seqEnd stay on the real source message for split fragments', () => {
  // Sentence-punctuated huge text: it is split into several fragments (cut points
  // are sentence ends), which is what the seqStart/seqEnd assertions need.
  const huge = `BEGIN-${'需要拆分到多个回忆文件夹的完整句子。'.repeat(100)}-END`
  const messages = [
    { role: 'user', content: huge, tokens: 1250 },
    { role: 'user', content: '下一个问题', tokens: 5 },
    { role: 'assistant', content: '嗯', tokens: 5 },
    { role: 'user', content: '保留1', tokens: 5 },
    { role: 'assistant', content: '保留2', tokens: 5 },
  ]
  const cfg = makeCfg({ compress: { compressPercent: 20, targetChunkChars: 600, minChunkChars: 200, maxFoldersPerRun: 100, keepRecentMessages: 2 } })
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 5000, windowTokens: 6000 })
  assert.equal(plan.shouldCompress, true)
  assert.equal(plan.remove.length, 1, 'only the huge message is removed')
  assert.ok(plan.folders.length >= 2, 'the huge message was split into several folders')
  for (const folder of plan.folders) {
    const source = folder.meta.source
    assert.equal(source.seqStart, 0, 'every fragment comes from source message 0')
    assert.equal(source.seqEnd, 0, 'a fragment is not a source message index of its own')
  }
  // The merged tail chunk (last fragment < minChunkChars) must still point at the
  // real source index, not start + messageCount - 1.
  const tail = plan.folders[plan.folders.length - 1]
  assert.ok(tail.messages.map((message) => String(message.content)).join('').includes('-END'))
  assert.equal(tail.meta.source.seqEnd, 0)
})

test('commit: storage.maxFolders refuses the whole archive instead of writing a partial span', () => {
  const dir = tempDir()
  const cfg = makeCfg({
    compress: { compressPercent: 80, targetChunkChars: 50, minChunkChars: 20, maxFoldersPerRun: 100 },
    storage: { maxFolders: 1 },
  })
  const messages = makeMessages(12, { tokens: 100 })
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 1200, windowTokens: 2000 })
  assert.equal(plan.shouldCompress, true)
  assert.ok(plan.folders.length > 1, `plan wants ${plan.folders.length} folders`)
  const committed = commitCompression(plan, { memoryDir: dir, cfg })
  assert.equal(committed.refused, true, 'cap refusal is signalled explicitly')
  assert.equal(committed.reason, 'storage.maxFolders')
  assert.equal(committed.folders.length, 0)
  assert.ok(committed.warnings.some((warning) => /maxFolders/.test(warning)))
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith('mem-')).length, 0, 'no folder was written')
  assert.equal(loadIndex(dir, cfg).folders.length, 0)
})

// ---------------------------------------------------------------------------
// sentence integrity when splitting an oversized message into folders
// (the user request: never cut inside a sentence; a folder may grow instead)
// ---------------------------------------------------------------------------

test('compress: oversized Chinese message is split only at sentence ends, text preserved exactly', () => {
  const sentences = Array.from({ length: 120 }, (_, index) => `第${index}句：部署 docker 端口配置已经确认完毕。`)
  const original = sentences.join('')
  const messages = [
    { role: 'user', content: original, tokens: 1000 },
    { role: 'user', content: '继续处理下一项', tokens: 5 },
    { role: 'user', content: '保留 1', tokens: 5 },
    { role: 'user', content: '保留 2', tokens: 5 },
  ]
  const cfg = makeCfg({
    compress: { compressPercent: 20, targetChunkChars: 200, minChunkChars: 50, maxFoldersPerRun: 100, keepRecentMessages: 2 },
  })
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 5000, windowTokens: 6000 })
  assert.equal(plan.shouldCompress, true)
  assert.equal(plan.remove.length, 1, 'only the oversized message is removed')
  assert.ok(plan.folders.length >= 2, `expected several folders, got ${plan.folders.length}`)
  const fragments = plan.folders.flatMap((folder) => folder.messages.map((message) => String(message.content)))
  assert.equal(fragments.join(''), original, 'chunks concatenated must equal the original text exactly')
  // Every fragment (but the last, which needs no trailing boundary) ends right
  // after a sentence terminator: no fragment may stop mid-sentence.
  for (let index = 0; index < fragments.length - 1; index += 1) {
    assert.match(fragments[index], /[。！？；…\n]$/, `fragment ${index} does not end at a sentence boundary`)
  }
  // Stronger: every fragment is a concatenation of complete known sentences.
  const sentenceSet = new Set(sentences)
  for (const fragment of fragments) {
    const pieces = fragment.match(/[^。]*。/g) || []
    assert.equal(pieces.join(''), fragment, 'a fragment must end at a sentence boundary')
    for (const piece of pieces) assert.ok(sentenceSet.has(piece), `fragment contains a partial sentence: ${piece.slice(0, 24)}`)
  }
})

test('compress: one long sentence longer than targetChunkChars stays whole, folder may exceed it', () => {
  // No terminator at all: the whole message is one sentence. It must never be
  // cut to satisfy targetChunkChars — the folder grows instead.
  const original = `BEGIN-${'x'.repeat(2500)}-END`
  const messages = [
    { role: 'user', content: original, tokens: 1250 },
    { role: 'user', content: '下一个问题', tokens: 5 },
    { role: 'assistant', content: '嗯', tokens: 5 },
    { role: 'user', content: '保留1', tokens: 5 },
    { role: 'assistant', content: '保留2', tokens: 5 },
  ]
  const cfg = makeCfg({
    compress: { compressPercent: 20, targetChunkChars: 250, minChunkChars: 50, maxFoldersPerRun: 100, keepRecentMessages: 2 },
  })
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 5000, windowTokens: 6000 })
  assert.equal(plan.shouldCompress, true)
  assert.equal(plan.remove.length, 1, 'only the oversized message is removed')
  assert.equal(plan.folders.length, 1, 'a single sentence must never be split to satisfy targetChunkChars')
  const folder = plan.folders[0]
  assert.equal(folder.messages.length, 1, 'the long sentence is one whole fragment')
  assert.equal(String(folder.messages[0].content), original, 'the long sentence is preserved whole')
  assert.ok(folder.meta.stats.chars > 250, `folder text must be allowed to exceed targetChunkChars: ${folder.meta.stats.chars} chars`)
})

test('compress: sentence-split folders still plan/commit end-to-end (count, exact text, ordering)', () => {
  const memoryDir = tempDir()
  const sentences = Array.from({ length: 80 }, (_, index) => `第${index}句：这一轮要把完整句子放进回忆文件夹。`)
  const original = sentences.join('')
  const messages = [
    { role: 'user', content: original, tokens: 1250 },
    { role: 'user', content: '下一个问题', tokens: 5 },
    { role: 'assistant', content: '嗯', tokens: 5 },
    { role: 'user', content: '保留1', tokens: 5 },
    { role: 'assistant', content: '保留2', tokens: 5 },
  ]
  const cfg = makeCfg({
    compress: { compressPercent: 20, targetChunkChars: 240, minChunkChars: 80, maxFoldersPerRun: 100, keepRecentMessages: 2 },
  })
  const plan = planCompression({
    messages,
    usedPercent: 80,
    cfg,
    totalUsedTokens: 5000,
    windowTokens: 6000,
    sessionId: 'sentence-split',
    now: 1700000000123,
  })
  assert.equal(plan.shouldCompress, true)
  assert.equal(plan.remove.length, 1)
  assert.ok(plan.folders.length >= 2 && plan.folders.length <= 100, `unexpected folder count ${plan.folders.length}`)

  const result = commitCompression(plan, { memoryDir, cfg, sessionId: 'sentence-split' })
  assert.equal(result.folders.length, plan.folders.length, 'plan and commit agree on the folder count')
  assert.equal(loadIndex(memoryDir, cfg).folders.length, plan.folders.length)
  const onDiskText = result.folders.flatMap((folder) =>
    readFolder(memoryDir, folder.id).messages.map((message) => String(message.content)),
  )
  assert.equal(onDiskText.join(''), original, 'committed folders preserve the original text exactly')
  const createdAts = result.folders.map((folder) => folder.meta.createdAt)
  assert.deepEqual(createdAts, createdAts.slice().sort((a, b) => a - b), 'createdAt keeps chronological order')
  const compressEvents = readStats(memoryDir, cfg).filter((event) => event.type === 'compress')
  assert.equal(compressEvents.length, 1)
  assert.equal(compressEvents[0].folderIds.length, result.folders.length)
  assert.equal(compressEvents[0].removedChars, plan.removeChars)
})

test('compress: sentence splitting never cuts a UTF-16 surrogate pair', () => {
  const emoji = '\u{1F600}' // one code point, two UTF-16 code units
  const sentences = Array.from({ length: 60 }, (_, index) => `${emoji}第${index}句内容${emoji}。`)
  // A final unpunctuated emoji run is one long sentence kept whole; it ends with a
  // complete pair (a low surrogate at the very end is legitimate).
  const original = `${sentences.join('')}${emoji.repeat(300)}`
  const messages = [
    { role: 'user', content: original, tokens: 1250 },
    { role: 'user', content: '下一个问题', tokens: 5 },
    { role: 'assistant', content: '嗯', tokens: 5 },
    { role: 'user', content: '保留1', tokens: 5 },
    { role: 'assistant', content: '保留2', tokens: 5 },
  ]
  const cfg = makeCfg({
    compress: { compressPercent: 20, targetChunkChars: 120, minChunkChars: 1, maxFoldersPerRun: 100, keepRecentMessages: 2 },
  })
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 5000, windowTokens: 6000 })
  assert.equal(plan.shouldCompress, true)
  assert.equal(plan.remove.length, 1)
  const fragments = plan.folders.flatMap((folder) => folder.messages.map((message) => String(message.content)))
  assert.equal(fragments.join(''), original, 'fragments preserve the original text exactly')
  assert.ok(fragments.length > 1, 'the message really was split')
  for (const fragment of fragments) {
    const first = fragment.charCodeAt(0)
    const last = fragment.charCodeAt(fragment.length - 1)
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), `fragment starts with a lone low surrogate: ${JSON.stringify(fragment.slice(0, 2))}`)
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `fragment ends with a lone high surrogate: ${JSON.stringify(fragment.slice(-2))}`)
  }
})

test('compress: oversized latin message is split only after latin sentence ends', () => {
  const original = `BEGIN. ${'This is a complete sentence. '.repeat(80)}The value is 3.14 and stable. END.`
  const messages = [
    { role: 'user', content: original, tokens: 1250 },
    { role: 'user', content: 'next question', tokens: 5 },
    { role: 'assistant', content: 'ok', tokens: 5 },
    { role: 'user', content: 'keep 1', tokens: 5 },
    { role: 'assistant', content: 'keep 2', tokens: 5 },
  ]
  const cfg = makeCfg({
    compress: { compressPercent: 20, targetChunkChars: 200, minChunkChars: 20, maxFoldersPerRun: 100, keepRecentMessages: 2 },
  })
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 5000, windowTokens: 6000 })
  assert.equal(plan.shouldCompress, true)
  assert.ok(plan.folders.length >= 2, `expected several folders, got ${plan.folders.length}`)
  const fragments = plan.folders.flatMap((folder) => folder.messages.map((message) => String(message.content)))
  assert.equal(fragments.join(''), original, 'chunks concatenated must equal the original text exactly')
  for (let index = 0; index < fragments.length - 1; index += 1) {
    assert.match(fragments[index], /[.!?;]$/, `latin fragment ${index} does not end at a sentence boundary`)
  }
  // "3.14" is not a sentence end: the decimal must never be split.
  assert.ok(fragments.some((fragment) => fragment.includes('3.14')), 'the decimal 3.14 was kept inside one fragment')
  for (const fragment of fragments) assert.ok(!/\d\.$/.test(fragment), `fragment was cut inside a decimal: ${fragment.slice(-8)}`)
})

// ---------------------------------------------------------------------------
// v1.2 R2 — folder titles: first user message, mid-turn inheritance,
// duplicate numbering (titles never participate in the recall probability)
// ---------------------------------------------------------------------------

test('compress: a chunk starting mid-turn inherits the nearest preceding user message title', () => {
  // The removed span is one user turn: a short user message followed by a long
  // assistant reply that must be split into several chunks. Only the first chunk
  // owns a user message; the later chunks start at an assistant fragment and must
  // inherit the user title (they used to degrade to `助手回复。助手回复。…`).
  const messages = [
    { role: 'user', content: '用户第一轮：部署 docker', tokens: 100 },
    { role: 'assistant', content: '助手回复。'.repeat(100), tokens: 1000 },
    { role: 'user', content: '保留提问', tokens: 10 },
    { role: 'assistant', content: '保留回复', tokens: 10 },
  ]
  const cfg = makeCfg({
    compress: { compressPercent: 20, targetChunkChars: 100, minChunkChars: 1, keepRecentMessages: 2, minMessagesToCompress: 2 },
  })
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 5000, windowTokens: 6000 })
  assert.equal(plan.remove.length, 2)
  assert.ok(plan.folders.length >= 2, `expected several folders, got ${plan.folders.length}`)
  assert.ok(
    plan.folders.some((folder) => folder.messages[0].role !== 'user'),
    'at least one chunk must start mid-turn for this test to mean anything',
  )
  // Every chunk inherits the turn's user message; the assistant fragments that
  // open the later chunks never leak into a title.
  for (const folder of plan.folders) {
    assert.ok(!folder.meta.title.includes('助手回复'), `assistant text leaked into the title: ${folder.meta.title}`)
    assert.match(folder.meta.title, /^用户第一轮：部署 docker（\d+）$/)
  }
  // All inherited titles are identical, so R2 dedupe numbers every occurrence.
  assert.deepEqual(
    plan.folders.map((folder) => folder.meta.title),
    plan.folders.map((_folder, index) => `用户第一轮：部署 docker（${index + 1}）`),
  )
})

test('compress: duplicate titles get the folder index suffix, unique titles stay unchanged', () => {
  // One user message per chunk (rendered `user: <text>` is exactly the chunk
  // target), so each folder's title comes from its own first user message.
  const cfg = makeCfg({
    compress: { compressPercent: 80, targetChunkChars: 10, minChunkChars: 1, keepRecentMessages: 0, minMessagesToCompress: 2 },
  })
  const messages = [
    { role: 'user', content: '重复标题', tokens: 100 },
    { role: 'user', content: '重复标题', tokens: 100 },
    { role: 'user', content: '唯一标题', tokens: 100 },
    { role: 'user', content: '重复标题', tokens: 100 },
    { role: 'user', content: '保留消息', tokens: 100 },
  ]
  const plan = planCompression({ messages, usedPercent: 95, cfg, totalUsedTokens: 500 })
  assert.equal(plan.folders.length, 4)
  assert.deepEqual(
    plan.folders.map((folder) => folder.meta.title),
    ['重复标题（1）', '重复标题（2）', '唯一标题', '重复标题（4）'],
  )
  // The suffix is the 1-based folder index in full-width parentheses.
  for (let index = 0; index < plan.folders.length; index += 1) {
    const title = plan.folders[index].meta.title
    if (title === '唯一标题') continue
    assert.equal(title, `重复标题（${index + 1}）`)
  }
})

test('compress: a chunk without any user text falls back to 第N段对话', () => {
  // Removal starts mid-turn (only assistant messages) and the archived span holds
  // no user message at all: neither the chunk nor the preceding span can title it.
  const cfg = makeCfg()
  const messages = [
    { role: 'assistant', content: '', tokens: 100 },
    { role: 'assistant', content: '', tokens: 100 },
    { role: 'user', content: '保留提问', tokens: 100 },
    { role: 'assistant', content: '保留回复', tokens: 100 },
  ]
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 400 })
  assert.equal(plan.remove.length, 2)
  assert.equal(plan.folders.length, 1)
  assert.equal(plan.folders[0].meta.title, '第1段对话')
})

// ---------------------------------------------------------------------------
// v1.2 R3 — checkpoint note API: cumulative N + parse round-trip
// ---------------------------------------------------------------------------

test('compress: buildArchiveNote totalSegments overrides N, default stays byte-identical', () => {
  const plan = {
    folders: [{ meta: { keywords: ['部署', 'docker'] } }, { meta: { keywords: ['端口'] } }],
  }
  const base = '[memory] 2 段更早的对话已归档到 memory/（关键词：部署、docker、端口）。需要时会自动回忆。'
  assert.equal(buildArchiveNote(plan), base)
  assert.equal(buildArchiveNote(plan, {}), base)
  assert.equal(buildArchiveNote(plan, { totalSegments: 9 }), base.replace('2 段更早', '9 段更早'))
  // Only a positive finite integer is accepted; anything else keeps the historical N.
  for (const invalid of [undefined, null, 0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '9']) {
    assert.equal(buildArchiveNote(plan, { totalSegments: invalid }), base, `totalSegments=${String(invalid)} must be ignored`)
  }
  assert.equal(buildArchiveNote({ folders: [] }, { totalSegments: 3 }), '')
  // No keywords -> the plain form also honours totalSegments.
  const plain = buildArchiveNote({ folders: [{ meta: { keywords: [] } }] }, { totalSegments: 12 })
  assert.equal(plain, '[memory] 12 段更早的对话已归档到 memory/。需要时会自动回忆。')
})

test('compress: parseArchiveNote round-trips buildArchiveNote (keyword, plain, cumulative, appendix)', () => {
  const keywordPlan = {
    folders: [{ meta: { keywords: ['部署', 'docker'] } }, { meta: { keywords: ['docker', '端口'] } }],
  }
  const keywordNote = buildArchiveNote(keywordPlan)
  assert.deepEqual(parseArchiveNote(keywordNote), { segments: 2, keywords: ['部署', 'docker', '端口'] })
  // Cumulative N from a merged-checkpoint run round-trips too.
  assert.deepEqual(parseArchiveNote(buildArchiveNote(keywordPlan, { totalSegments: 12 })), {
    segments: 12,
    keywords: ['部署', 'docker', '端口'],
  })
  // Plain form (no keywords at all).
  const plainNote = buildArchiveNote({ folders: [{ meta: { keywords: [] } }, { meta: {} }] })
  assert.deepEqual(parseArchiveNote(plainNote), { segments: 2, keywords: [] })
  // The note is a prefix: the pinned-context appendix follows after `\n\n`.
  const appendix =
    '\n\n[memory] 本次归档区间内还有 1 条非对话上下文（例如运行时上下文或插件注入的固定消息），已并入本说明以免丢失：\n运行时上下文'
  assert.deepEqual(parseArchiveNote(`${keywordNote}${appendix}`), { segments: 2, keywords: ['部署', 'docker', '端口'] })
  assert.deepEqual(parseArchiveNote(`${plainNote}${appendix}`), { segments: 2, keywords: [] })
  // A note produced by a real plan parses back to the same segment count.
  const cfg = makeCfg()
  const plan = planCompression({ messages: makeMessages(10), usedPercent: 80, cfg, totalUsedTokens: 1000 })
  const parsed = parseArchiveNote(buildArchiveNote(plan))
  assert.equal(parsed.segments, plan.folders.length)
  const expectedKeywords = plan.folders
    .flatMap((folder) => folder.meta.keywords)
    .filter((keyword, index, list) => list.indexOf(keyword) === index)
    .slice(0, 5)
  assert.deepEqual(parsed.keywords, expectedKeywords)
})

test('compress: parseArchiveNote returns null for foreign checkpoints and non-notes', () => {
  for (const text of [
    '',
    '压缩摘要：前情提要',
    '[memory] 已归档 3 段对话到 memory/',
    '[memory] 3 段对话已归档到 memory/。需要时会自动回忆。',
    '[memory] 3 段更早的对话已归档到 memory/（关键词：部署）。改了措辞。',
    '前言\n[memory] 3 段更早的对话已归档到 memory/。需要时会自动回忆。',
    '[memory] 0 段更早的对话已归档到 memory/。需要时会自动回忆。',
    '[memory] 3 段更早的对话已归档到 memory/（关键词：）。需要时会自动回忆。',
  ]) {
    assert.equal(parseArchiveNote(text), null, `expected null for ${JSON.stringify(text)}`)
  }
  for (const value of [null, undefined, 123, {}, ['[memory] 1 段更早的对话已归档到 memory/。需要时会自动回忆。']]) {
    assert.equal(parseArchiveNote(value), null)
  }
})
