/**
 * Turn protection / small-window sanity / commit transaction tests for
 * `engine/compress.js` (1.4.0 P0-3, P1-4, P1-6; contract §5.5, plan §3.5).
 *
 * The adapter-facing plan shape is exercised here: every visible message carries
 * its surface `seq`, so `protectSeq` can stop the removal prefix before the
 * current turn's first message — exactly like `lib/surface.js` will pass it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { commitCompression, eventTimeRangeOf, planCompression } from '../engine/compress.js'
import { formatFolderId, loadConfig, loadIndex, memoryPaths, readFolder, readStats, writeIndex } from '../engine/index.js'

const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-turns-'))
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
      minChunkChars: 40,
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

/** Attach monotonic 1-based surface seq numbers (what the adapter passes). */
function withSeq(messages) {
  return messages.map((message, index) => ({ ...message, seq: index + 1 }))
}

/**
 * Build one full visible conversation for a turn-protection shape. The current
 * turn always starts with a user message containing `当前回合`; `currentTurnStart`
 * is its surface seq (the `protectSeq` the adapter would pass), `boundaryIndex`
 * its array index.
 */
function currentTurnConversation(shape) {
  const specs = []
  const push = (role, content, tokens = 100) => specs.push({ role, content, tokens })
  const historyTurn = (index, weight = 1) => {
    push('user', `历史问题 ${index}`)
    for (let part = 0; part < weight; part += 1) push('assistant', `历史回答 ${index}-${part} ${'内容'.repeat(30)}`)
  }
  const toolTurn = (stepCount) => {
    push('user', '当前回合：帮我部署并检查服务状态')
    for (let step = 0; step < stepCount; step += 1) {
      push('assistant', `[tool-call: bash] 第 ${step} 步`)
      push('tool', `tool result ${step}: ${'输出'.repeat(40)}`)
    }
    push('assistant', '当前回合的中间结论')
  }
  switch (shape) {
    case 'plain-history':
      for (let index = 0; index < 6; index += 1) historyTurn(index)
      toolTurn(3)
      break
    case 'tool-heavy-history':
      for (let index = 0; index < 3; index += 1) historyTurn(index)
      for (let index = 0; index < 4; index += 1) {
        push('assistant', `历史工具输出 ${index}: ${'结果'.repeat(120)}`)
        push('tool', `历史工具结果 ${index}: ${'日志'.repeat(120)}`)
      }
      toolTurn(2)
      break
    case 'single-history-message':
      push('user', '上一条极短的问题')
      push('assistant', `上一条很长的回复 ${'内容'.repeat(200)}`)
      toolTurn(3)
      break
    case 'many-tool-steps':
      for (let index = 0; index < 5; index += 1) historyTurn(index)
      toolTurn(5)
      break
    case 'turn-boundary-mid-history':
      for (let index = 0; index < 8; index += 1) historyTurn(index, index % 3 === 0 ? 2 : 1)
      toolTurn(2)
      break
    case 'injected-user-after-turn':
      // The surface carries a pinned user-role context node *after* the current
      // question (recall block / runtime context). Pure role-based boundary
      // alignment would happily slide the cut over the real question here — this
      // is exactly the P0-3 production repro, and why `protectSeq` exists.
      for (let index = 0; index < 6; index += 1) historyTurn(index)
      push('user', '当前回合：帮我部署并检查服务状态')
      push('assistant', '[tool-call: bash] 检查服务状态')
      push('tool', `tool result: ${'输出'.repeat(40)}`)
      push('assistant', '检查完成，继续下一步')
      push('user', '【运行时上下文】当前时间 2026-11-01，工作目录 /srv/app')
      push('assistant', '收到上下文，继续处理当前问题')
      break
    default:
      throw new Error(`unknown shape ${shape}`)
  }
  const messages = withSeq(specs)
  const boundaryIndex = messages.findIndex(
    (message) => message.role === 'user' && String(message.content).startsWith('当前回合'),
  )
  return { messages, boundaryIndex, currentTurnStart: messages[boundaryIndex].seq }
}

function tokensOf(messages) {
  return messages.reduce((sum, message) => sum + message.tokens, 0)
}

// ---------------------------------------------------------------------------
// P0-3 — the current turn is never archived (5 multi-step tool-turn shapes)
// ---------------------------------------------------------------------------

const TURN_SHAPES = [
  'plain-history',
  'tool-heavy-history',
  'single-history-message',
  'many-tool-steps',
  'turn-boundary-mid-history',
  'injected-user-after-turn',
]

for (const shape of TURN_SHAPES) {
  test(`turn protection (${shape}): the current turn's user message and tool pairs are never archived`, () => {
    const { messages, boundaryIndex, currentTurnStart } = currentTurnConversation(shape)
    const cfg = makeCfg({ compress: { compressPercent: 80, keepRecentMessages: 2, targetChunkChars: 150, minChunkChars: 40 } })
    const plan = planCompression({
      messages,
      usedPercent: 90,
      cfg,
      totalUsedTokens: tokensOf(messages),
      windowTokens: 128000,
      sessionId: 'turn-protect',
      turn: 9,
      now: 1700000000000,
      protectTurn: 9,
      protectSeq: currentTurnStart,
    })
    assert.equal(plan.shouldCompress, true, `shape ${shape}: the history before the current turn is still archivable`)
    assert.equal(plan.protectedTurn, true)
    assert.equal(plan.protectedStart, boundaryIndex)
    assert.ok(plan.remove.length > 0, `shape ${shape}: nothing was removed at all`)
    assert.ok(plan.remove.length <= boundaryIndex, `shape ${shape}: removal crossed into the current turn`)
    // Nothing at/after the protected boundary may be removed; this covers the
    // current turn's user message, every assistant tool-call and every tool result.
    for (const message of plan.remove) {
      assert.ok(message.seq < currentTurnStart, `shape ${shape}: removed message seq ${message.seq} belongs to the current turn`)
    }
    const keepSeqs = new Set(plan.keep.map((message) => message.seq))
    for (const message of messages.slice(boundaryIndex)) {
      assert.ok(keepSeqs.has(message.seq), `shape ${shape}: current-turn message seq ${message.seq} was archived`)
    }
    // The remaining history still starts at a user message and no tool result is
    // separated from its assistant tool-call inside the removed span.
    assert.equal(plan.keep[0].role, 'user', `shape ${shape}: remaining history must start at a user message`)
    for (let index = 0; index < plan.remove.length; index += 1) {
      if (plan.remove[index].role !== 'tool') continue
      assert.ok(index > 0 && plan.remove[index - 1].role === 'assistant', `shape ${shape}: a tool result lost its tool-call`)
    }
    // Folders only ever contain pre-turn messages.
    for (const folder of plan.folders) {
      for (const message of folder.messages) {
        assert.ok(message.seq < currentTurnStart, `shape ${shape}: folder contains a current-turn message (seq ${message.seq})`)
      }
    }
  })
}

test('turn protection: without protectSeq the same shape would archive the current question (the guard matters)', () => {
  const { messages } = currentTurnConversation('injected-user-after-turn')
  const cfg = makeCfg({ compress: { compressPercent: 80, keepRecentMessages: 2, targetChunkChars: 150, minChunkChars: 40 } })
  const unguarded = planCompression({
    messages,
    usedPercent: 90,
    cfg,
    totalUsedTokens: tokensOf(messages),
    windowTokens: 128000,
    sessionId: 'turn-protect',
    turn: 9,
    now: 1700000000000,
  })
  // This is exactly the P0-3 defect: the current turn's question ends up in the
  // archived prefix when a later user-role node is the only boundary the
  // heuristic can find.
  assert.equal(unguarded.shouldCompress, true)
  assert.ok(unguarded.remove.some((message) => message.role === 'user' && String(message.content).startsWith('当前回合')))
})

test('turn protection: no legal cut point before the current turn → refuse, warn, write no folder', () => {
  const cfg = makeCfg({ compress: { compressPercent: 80, keepRecentMessages: 2, targetChunkChars: 150 } })
  // The conversation *starts* with the current turn: every visible message is
  // protected, so archiving is impossible without losing the question.
  const messages = withSeq([
    { role: 'user', content: '当前回合唯一的问题', tokens: 100 },
    { role: 'assistant', content: '[tool-call: bash] 检查状态', tokens: 100 },
    { role: 'tool', content: 'HTTP/1.1 200 OK', tokens: 100 },
    { role: 'assistant', content: '服务正常', tokens: 100 },
    { role: 'user', content: '继续', tokens: 100 },
    { role: 'assistant', content: '继续检查', tokens: 100 },
  ])
  const plan = planCompression({
    messages,
    usedPercent: 95,
    cfg,
    totalUsedTokens: tokensOf(messages),
    windowTokens: 128000,
    sessionId: 'turn-refuse',
    turn: 3,
    protectTurn: 3,
    protectSeq: messages[0].seq,
  })
  assert.equal(plan.shouldCompress, false)
  assert.equal(plan.reason, 'protected-turn')
  assert.ok(plan.warnings.some((warning) => /current turn|P0-3/.test(warning)), `expected a protection warning, got ${JSON.stringify(plan.warnings)}`)
  assert.deepEqual(plan.folders, [])
  assert.deepEqual(plan.remove, [])

  const memoryDir = tempDir()
  const committed = commitCompression(plan, { memoryDir, cfg, sessionId: 'turn-refuse' })
  assert.equal(committed.folders.length, 0)
  assert.deepEqual(fs.readdirSync(memoryDir).filter((name) => name.startsWith('mem-')), [], 'a refused plan must not write folders')
})

test('fail-safe: no legal user boundary at all → refuse instead of an arbitrary cut', () => {
  // All-assistant history: cutting anywhere would start the remaining history
  // mid-turn (or split a tool pair). v1.3.0 picked an arbitrary cut here.
  const messages = withSeq(
    Array.from({ length: 10 }, (_value, index) => ({ role: 'assistant', content: `assistant ${index} ${'x'.repeat(40)}`, tokens: 100 })),
  )
  const plan = planCompression({ messages, usedPercent: 90, cfg: makeCfg(), totalUsedTokens: 1000, windowTokens: 128000 })
  assert.equal(plan.shouldCompress, false)
  assert.equal(plan.reason, 'no-legal-cut')
  assert.ok(plan.warnings.some((warning) => /user-turn boundary|fail-safe/.test(warning)))
  assert.deepEqual(plan.folders, [])
})

// ---------------------------------------------------------------------------
// P1-6 — small-window sanity
// ---------------------------------------------------------------------------

test('small-window sanity: 8k window is refused by default, allowed with the explicit opt-in, 20k is the boundary', () => {
  const messages = withSeq(makeMessages(16))
  const strict = makeCfg() // compress.allowSmallWindow=false (shipped default)
  const base = { messages, usedPercent: 80, cfg: strict, totalUsedTokens: 1600 }

  const refused = planCompression({ ...base, windowTokens: 8000 })
  assert.equal(refused.shouldCompress, false)
  assert.equal(refused.reason, 'small-window')
  assert.equal(refused.smallWindow, true)
  assert.deepEqual(refused.folders, [])
  assert.ok(refused.warnings.some((warning) => /smallWindowTokens|small window/.test(warning)), 'the refusal must be explained')

  // Explicit option opt-in (adapter escape hatch).
  const optedIn = planCompression({ ...base, windowTokens: 8000, allowSmallWindow: true })
  assert.equal(optedIn.shouldCompress, true)
  assert.equal(optedIn.smallWindow, false)

  // Config-level opt-in works too.
  const cfgOptIn = makeCfg({ compress: { allowSmallWindow: true } })
  assert.equal(planCompression({ ...base, cfg: cfgOptIn, windowTokens: 8000 }).shouldCompress, true)

  // Boundary: exactly smallWindowTokens is not "small" (strict `<`).
  assert.equal(planCompression({ ...base, windowTokens: 20000 }).shouldCompress, true)
  assert.equal(planCompression({ ...base, windowTokens: 19999 }).reason, 'small-window')

  // No window information at all keeps the historical behaviour.
  assert.equal(planCompression(base).shouldCompress, true)
})

test('small-window sanity: a conflicting compress.contextWindowTokens is refused as well', () => {
  const messages = withSeq(makeMessages(16))
  const cfg = makeCfg({ compress: { contextWindowTokens: 400000 } })
  const conflict = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 1600, windowTokens: 8000 })
  assert.equal(conflict.shouldCompress, false)
  assert.equal(conflict.reason, 'window-conflict')
  assert.equal(conflict.windowConflict, true)
  assert.ok(conflict.warnings.some((warning) => /contextWindowTokens/.test(warning)))
  // The documented escape hatch covers the conflict too (operator explicitly
  // accepts archiving with an inconsistent window configuration).
  assert.equal(
    planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 1600, windowTokens: 8000, allowSmallWindow: true }).shouldCompress,
    true,
  )
})

// ---------------------------------------------------------------------------
// P1-6 — hard-limit stop is a distinguishable refusal
// ---------------------------------------------------------------------------

test('hard-limit stop: refused with its own reason/warning, disabled by compress.hardLimitStop=false', () => {
  const messages = withSeq(makeMessages(16))
  const cfg = makeCfg()
  const base = { messages, usedPercent: 92, cfg, totalUsedTokens: 1600, windowTokens: 128000, hardLimitReached: true }

  const stopped = planCompression(base)
  assert.equal(stopped.shouldCompress, false)
  assert.equal(stopped.reason, 'hard-limit')
  assert.equal(stopped.hardLimit, true)
  assert.deepEqual(stopped.folders, [])
  assert.ok(stopped.warnings.some((warning) => /hardLimitStop|hard limit/.test(warning)))

  // Turning the knob off restores the normal archive attempt.
  const cfgNoStop = makeCfg({ compress: { hardLimitStop: false } })
  const notStopped = planCompression({ ...base, cfg: cfgNoStop })
  assert.equal(notStopped.shouldCompress, true)
  assert.equal(notStopped.hardLimit, false)

  // A normal below-threshold skip is a different reason and carries no hard-limit warning.
  const below = planCompression({ messages, usedPercent: 10, cfg, totalUsedTokens: 1600, windowTokens: 128000 })
  assert.equal(below.shouldCompress, false)
  assert.equal(below.reason, 'below-threshold')
  assert.ok(!below.warnings.some((warning) => /hard limit/.test(warning)))
})

// ---------------------------------------------------------------------------
// P1-4 — commit transaction: rollback, index last, journal cleanup
// ---------------------------------------------------------------------------

function plannedFoldersForRollback({ sessionId, turn }) {
  const folder = (index) => {
    const id = `mem-20261101T0000${index}0Z-000${index}`
    return {
      id,
      meta: {
        version: 1,
        id,
        createdAt: 1700000001000 + index,
        alpha: 0.5,
        beta: 0,
        keywords: ['部署'],
        title: `第${index}段`,
        stats: { messages: 1, chars: 10, tokens: 5 },
        source: { sessionId, turn, seqStart: index, seqEnd: index },
      },
      messages: [{ role: 'user', content: `归档片段 ${index}` }],
    }
  }
  return { folders: [folder(1), folder(2), folder(3)], remove: [], keep: [], warnings: [] }
}

test('commit transaction: a failure on the 2nd folder rolls back every folder, keeps the index byte-identical and drops the journal', () => {
  const cfg = makeCfg({ compress: { targetChunkChars: 200 } })
  const memoryDir = tempDir()
  // Seed one real commit so index.json exists and its exact bytes can be compared.
  const seedPlan = planCompression({ messages: withSeq(makeMessages(12)), usedPercent: 90, cfg, totalUsedTokens: 1200, now: 1700000000123 })
  const seeded = commitCompression(seedPlan, { memoryDir, cfg, sessionId: 'seed' })
  assert.ok(seeded.folders.length > 0)
  const { indexPath } = memoryPaths(memoryDir, cfg)
  const indexBefore = fs.readFileSync(indexPath, 'utf8')
  const foldersBefore = loadIndex(memoryDir, cfg).folders.length
  const imageCalls = []

  const plan = plannedFoldersForRollback({ sessionId: 'rollback', turn: 3 })
  // Inject a failure into the 2nd folder write: BigInt is not JSON serializable,
  // so writeFolder() throws after creating the directory and writing context.json.
  plan.folders[1].meta.badValue = 10n
  let thrown = null
  assert.throws(
    () => commitCompression(plan, { memoryDir, cfg, sessionId: 'rollback', turn: 3, removeImages: (info) => imageCalls.push(info) }),
    (error) => {
      thrown = error
      return error instanceof Error
    },
  )
  assert.equal(thrown.rolledBack, true, 'the failure is marked as rolled back')
  assert.ok(Array.isArray(thrown.writtenFolderIds) && thrown.writtenFolderIds.length === 2, `rolled back ${thrown.writtenFolderIds}`)

  // 1) no orphan memory folder directory (neither the first written folder nor
  //    the partially written one survives).
  const seededIds = new Set(seeded.folders.map((folder) => folder.id))
  const leftovers = fs.readdirSync(memoryDir).filter((name) => name.startsWith('mem-') && !seededIds.has(name))
  assert.deepEqual(leftovers, [], `orphan folders after rollback: ${JSON.stringify(leftovers)}`)
  for (const id of thrown.writtenFolderIds) assert.equal(fs.existsSync(path.join(memoryDir, id)), false)

  // 2) index.json is untouched (byte-identical; the index is written last).
  assert.equal(fs.readFileSync(indexPath, 'utf8'), indexBefore, 'index.json must not be rewritten by a failed commit')
  assert.equal(loadIndex(memoryDir, cfg).folders.length, foldersBefore)

  // 3) the commit journal was cleaned up.
  assert.deepEqual(fs.readdirSync(memoryDir).filter((name) => name.startsWith('.commit-')), [])

  // 4) the image rollback callback was invoked once with the rolled back ids.
  assert.equal(imageCalls.length, 1)
  assert.deepEqual(imageCalls[0].folderIds, thrown.writtenFolderIds)
  assert.equal(imageCalls[0].sessionId, 'rollback')
  assert.equal(imageCalls[0].turn, 3)
})

test('commit transaction: the journal is removed after a successful commit', () => {
  const cfg = makeCfg()
  const memoryDir = tempDir()
  const plan = planCompression({ messages: withSeq(makeMessages(12)), usedPercent: 90, cfg, totalUsedTokens: 1200, now: 1700000000456 })
  const committed = commitCompression(plan, { memoryDir, cfg, sessionId: 'journal-ok' })
  assert.ok(committed.folders.length > 0)
  assert.deepEqual(fs.readdirSync(memoryDir).filter((name) => name.startsWith('.commit-')), [])
  assert.equal(committed.rollback, undefined) // success path never sets rollback
  assert.equal(committed.folders.length, committed.index.folders.length)
})

// ---------------------------------------------------------------------------
// P1-4 — content-hash idempotency key
// ---------------------------------------------------------------------------

test('commit idempotency: the same (sessionId,turn,seqStart,seqEnd,contentHash) never duplicates folders, even with a new `now`', () => {
  const cfg = makeCfg()
  const memoryDir = tempDir()
  const messages = withSeq(makeMessages(16))
  const base = { messages, usedPercent: 90, cfg, totalUsedTokens: 1600, sessionId: 'idem-session', turn: 4 }
  const planA = planCompression({ ...base, now: 1700000000000 })
  assert.ok(planA.folders.length > 0)
  const first = commitCompression(planA, { memoryDir, cfg, sessionId: 'idem-session', turn: 4, idempotencyKey: true })
  assert.equal(first.folders.length, planA.folders.length)
  const indexAfterFirst = loadIndex(memoryDir, cfg).folders.length
  assert.equal(indexAfterFirst, planA.folders.length)

  // Retry with a different `now`: folder ids/createdAt change, content does not.
  const planB = planCompression({ ...base, now: 1700000009999 })
  assert.notEqual(planB.folders[0].id, planA.folders[0].id, 'the retry really produced different folder ids')
  const second = commitCompression(planB, { memoryDir, cfg, sessionId: 'idem-session', turn: 4, idempotencyKey: true })
  assert.equal(second.folders.length, 0, 'the retry must not write duplicate folders')
  assert.equal(second.skipped, planB.folders.length)
  assert.equal(loadIndex(memoryDir, cfg).folders.length, indexAfterFirst)

  // On disk every folder still carries a unique idempotency key and there are no duplicates.
  const metas = fs
    .readdirSync(memoryDir)
    .filter((name) => name.startsWith('mem-'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(memoryDir, name, 'meta.json'), 'utf8')))
  assert.equal(metas.length, indexAfterFirst)
  const keys = metas.map((meta) => meta.idempotencyKey).filter(Boolean)
  assert.equal(keys.length, metas.length)
  assert.equal(new Set(keys).size, keys.length)
})

// ---------------------------------------------------------------------------
// eventTimeRangeOf — pure helper (plan §3.3.2)
// ---------------------------------------------------------------------------

test('eventTimeRangeOf: half-open min/max range, null without times', () => {
  assert.equal(eventTimeRangeOf([]), null)
  assert.equal(eventTimeRangeOf([{ role: 'user', content: 'no time' }]), null)
  assert.equal(eventTimeRangeOf([{ time: null }, { time: 'nope' }, { time: undefined }]), null)
  // Unordered input: min/max only.
  assert.deepEqual(eventTimeRangeOf([{ time: 100 }, { time: 50 }, { time: 75 }]), { start: 50, end: 101, source: 'messages' })
  // Epoch 0 is a real time (never treated as "missing").
  assert.deepEqual(eventTimeRangeOf([{ time: 0 }]), { start: 0, end: 1, source: 'messages' })
  // Cross-day span: 23:59 -> next day 00:01 (UTC+8), half-open end = max + 1.
  const dayOne = Date.UTC(2026, 9, 31, 15, 59) // 2026-10-31 23:59 +08:00
  const dayTwo = Date.UTC(2026, 10, 1, 0, 1) // 2026-11-01 00:01 +08:00
  assert.deepEqual(eventTimeRangeOf([{ time: dayTwo }, { time: dayOne }, { time: dayOne + 60_000 }]), {
    start: dayOne,
    end: dayTwo + 1,
    source: 'messages',
  })
})

test('event time: folder meta carries eventStart/eventEnd/eventTimeSource, and no event fields without times', () => {
  const cfg = makeCfg()
  const memoryDir = tempDir()
  const start = 1700000000000
  const messages = withSeq(makeMessages(16)).map((message, index) => ({ ...message, time: start + index * 60_000 }))
  const plan = planCompression({ messages, usedPercent: 90, cfg, totalUsedTokens: 1600, now: 1700000500000 })
  assert.ok(plan.folders.length > 0)
  for (const folder of plan.folders) {
    assert.ok(Number.isFinite(folder.meta.eventStart), 'eventStart is written')
    assert.ok(folder.meta.eventEnd > folder.meta.eventStart, 'eventEnd is the half-open end')
    assert.equal(folder.meta.eventTimeSource, 'messages')
    const source = folder.meta.source
    const times = messages.slice(source.seqStart, source.seqEnd + 1).map((message) => message.time)
    assert.equal(folder.meta.eventStart, Math.min(...times))
    assert.equal(folder.meta.eventEnd, Math.max(...times) + 1)
  }
  assert.deepEqual(plan.eventTimeSourceCounts, { messages: plan.folders.length })
  const removedTimes = messages.slice(0, plan.remove.length).map((message) => message.time)
  assert.deepEqual(plan.eventTime, { start: Math.min(...removedTimes), end: Math.max(...removedTimes) + 1, source: 'messages' })

  const committed = commitCompression(plan, { memoryDir, cfg })
  const index = loadIndex(memoryDir, cfg)
  for (const folder of committed.folders) {
    const meta = readFolder(memoryDir, folder.id).meta
    assert.equal(meta.eventStart, folder.meta.eventStart)
    assert.equal(meta.eventEnd, folder.meta.eventEnd)
    assert.equal(meta.eventTimeSource, 'messages')
    const entry = index.folders.find((item) => item.id === folder.id)
    assert.equal(entry.eventStart, meta.eventStart, 'the index entry copies eventStart')
    assert.equal(entry.eventEnd, meta.eventEnd)
    assert.equal(entry.eventTimeSource, 'messages')
  }
  const compressEvent = readStats(memoryDir, cfg).filter((event) => event.type === 'compress').at(-1)
  assert.deepEqual(compressEvent.eventTimeSourceCounts, { messages: plan.folders.length })
  assert.equal(compressEvent.foldersPlanned, plan.folders.length)
  assert.equal(compressEvent.foldersCommitted, committed.folders.length)
  assert.equal(compressEvent.rollback, false)

  // Without message times the folder shape is exactly the historical one.
  const plainPlan = planCompression({ messages: withSeq(makeMessages(16)), usedPercent: 90, cfg, totalUsedTokens: 1600 })
  assert.ok(plainPlan.folders.length > 0)
  for (const folder of plainPlan.folders) {
    assert.equal('eventStart' in folder.meta, false)
    assert.equal('eventEnd' in folder.meta, false)
    assert.equal('eventTimeSource' in folder.meta, false)
  }
  assert.deepEqual(plainPlan.eventTimeSourceCounts, {})
  assert.equal(plainPlan.eventTime, null)
})

test('event time: the adapter parallel `eventTimes` array (no message.time) maps to the source chunk indexes', () => {
  const cfg = makeCfg()
  const messages = withSeq(makeMessages(16))
  const base = 1700000000000
  // Every 4th message has no event time attached.
  const eventTimes = messages.map((_message, index) => (index % 4 === 3 ? null : base + index * 60_000))
  const plan = planCompression({ messages, usedPercent: 90, cfg, totalUsedTokens: 1600, windowTokens: 128000, eventTimes })
  assert.ok(plan.folders.length > 0)
  for (const folder of plan.folders) {
    const source = folder.meta.source
    const expected = eventTimes.slice(source.seqStart, source.seqEnd + 1).filter((time) => Number.isFinite(time))
    assert.equal(folder.meta.eventStart, Math.min(...expected))
    assert.equal(folder.meta.eventEnd, Math.max(...expected) + 1)
    assert.equal(folder.meta.eventTimeSource, 'messages')
  }
  const removedTimes = eventTimes.slice(0, plan.remove.length).filter((time) => Number.isFinite(time))
  assert.deepEqual(plan.eventTime, { start: Math.min(...removedTimes), end: Math.max(...removedTimes) + 1, source: 'messages' })
})

// ---------------------------------------------------------------------------
// P2/D2 — idempotency keys must come from the index, not a per-commit scan of
// every folder's meta.json (the adapter always sends idempotencyKey: true).
// ---------------------------------------------------------------------------

test('commit idempotency is index-based: a 1000-folder index with no meta files stays fast and dedupes', () => {
  const cfg = makeCfg()
  const memoryDir = tempDir()
  // Fixture: an index with 1000 folders that carry idempotencyKey entries but NO
  // meta.json on disk at all. The pre-D2 implementation scanned memory/<id>/meta.json
  // on every commit, which both cost O(folders) disk reads and could not see any
  // key in this fixture; the index-based implementation reads the already-loaded
  // index once and must recover every key from it.
  const seedFolders = []
  for (let index = 0; index < 1000; index += 1) {
    seedFolders.push({
      id: formatFolderId(1700000000000, index + 1),
      createdAt: 1700000000000 + index,
      alpha: 0.5,
      beta: 0,
      keywords: ['部署'],
      chars: 100,
      tokens: 40,
      messageCount: 2,
      title: `seed ${index}`,
      scored: true,
      idempotencyKey: `seed|0|${index}|${index}|${`h${index}`.padEnd(16, 'h')}`,
    })
  }
  writeIndex(memoryDir, cfg, { version: 1, folders: seedFolders, nextCounter: 1001 })
  const { indexPath } = memoryPaths(memoryDir, cfg)
  assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).folders.length, 1000)
  assert.deepEqual(
    fs.readdirSync(memoryDir).filter((name) => name.startsWith('mem-')),
    [],
    'the fixture intentionally has no folder directories: only index.json exists',
  )

  const messages = withSeq(makeMessages(16))
  const base = { messages, usedPercent: 90, cfg, totalUsedTokens: 1600, sessionId: 'perf-idem', turn: 6 }
  const planA = planCompression({ ...base, now: 1700000005000 })
  assert.ok(planA.folders.length > 0)
  const onCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
  const budgetMs = onCi ? 1500 : 300
  const startedAt = performance.now()
  const first = commitCompression(planA, { memoryDir, cfg, sessionId: 'perf-idem', turn: 6, idempotencyKey: true })
  const elapsed = performance.now() - startedAt
  assert.equal(first.folders.length, planA.folders.length)
  assert.ok(elapsed < budgetMs, `idempotent commit over a 1000-folder index took ${elapsed.toFixed(2)}ms (budget ${budgetMs}ms)`)

  // New index entries must expose the idempotency key (it is copied by
  // store.indexEntryFromMeta), otherwise the next commit could not dedupe.
  const indexAfterFirst = loadIndex(memoryDir, cfg)
  assert.equal(indexAfterFirst.folders.length, 1000 + planA.folders.length)
  for (const folder of first.folders) {
    const entry = indexAfterFirst.folders.find((item) => item.id === folder.id)
    assert.ok(entry, `committed folder ${folder.id} is listed in the index`)
    assert.equal(typeof entry.idempotencyKey, 'string')
    assert.ok(entry.idempotencyKey.length > 0)
    assert.equal(readFolder(memoryDir, folder.id).meta.idempotencyKey, entry.idempotencyKey)
  }

  // Retry with a new `now` (different createdAt/folder ids) is deduped from the
  // index alone — no meta scan and no duplicate folders.
  const planB = planCompression({ ...base, now: 1700000009999 })
  assert.notEqual(planB.folders[0].id, planA.folders[0].id)
  const second = commitCompression(planB, { memoryDir, cfg, sessionId: 'perf-idem', turn: 6, idempotencyKey: true })
  assert.equal(second.folders.length, 0, 'the retry must not write duplicate folders')
  assert.equal(second.skipped, planB.folders.length)
  assert.equal(loadIndex(memoryDir, cfg).folders.length, 1000 + planA.folders.length)
})
