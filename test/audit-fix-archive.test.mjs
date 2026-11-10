/**
 * Audit-fix regressions for the two archive paths (dsh-rofm 1.5.0 audit):
 *
 *   F-LEAD-02  assistant-utterance keywords were position fragments
 *              ("我建/建议/议你") because the archive reused the generic
 *              `extractKeywords`. The "你说过…" channel therefore never matched
 *              real archived text. Fixed in engine/compress.js
 *              `extractAssistantKeywords` (shared with lib/passive-archive.js).
 *   F-03-02    `timeTag.mode='off'` ("no collection") still collected and wrote
 *              `timeTags`/`timeTagSource` on BOTH archive paths.
 *   F-03-03    a message without `time` was anchored at the chunk/event range
 *              start instead of the folder `createdAt` (DESIGN-1.5.0 §1) on
 *              BOTH archive paths.
 *
 * Method: no test hand-writes an intermediate field. Every assertion goes
 * through a production path — the real plugin adapter
 * (`compressWithEscalation` → meta.json/index.json), the real
 * `PassiveArchiver.handle`, or the real `memory_recall` ToolDefinition — and
 * then reads what was actually persisted / returned.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { RofmPlugin } from '../lib/plugin.js'
import { PassiveArchiver } from '../lib/passive-archive.js'
import { extractAssistantKeywords } from '../engine/compress.js'
import { loadConfig } from '../engine/index.js'

const NOW = Date.parse('2026-11-07T10:00:00+08:00')
const DAY = 86_400_000
const OLD = Date.parse('2026-10-01T10:00:00+08:00')
const ASIA = 'Asia/Shanghai'

// ---------------------------------------------------------------------------
// minimal DSH session / plugin context (mirrors test-adapter/plugin-mock.test.mjs;
// copied here instead of imported because that file lives in another owner's
// scope and is a node:test file)
// ---------------------------------------------------------------------------
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const clone = (value) => JSON.parse(JSON.stringify(value))

class FakeSession {
  constructor({ contextWindow = 1000, id = 'session-audit-fix' } = {}) {
    this.id = id
    this.header = { origin: 'main' }
    this.events = []
    this.nodes = []
    this.replaceGeneration = 0
    this.contentGeneration = 0
    this.windowTokens = contextWindow
  }

  get surface() {
    const session = this
    return {
      get nodes() {
        return session.nodes
      },
      get replaceGeneration() {
        return session.replaceGeneration
      },
      get contentGeneration() {
        return session.contentGeneration
      },
    }
  }

  get seq() {
    return this.events.length
  }

  eventAt(seq) {
    return this.events[seq]
  }

  snapshotEvents() {
    return this.events.slice()
  }

  requestContext() {
    return { provider: 'mock', model: 'mock', contextWindow: this.windowTokens }
  }

  deriveEventMessage(event) {
    if (!event) return null
    switch (event.type) {
      case 'user/message':
        return event.data
      case 'assistant/message':
      case 'system/message':
      case 'developer/message':
        return event.data.message
      case 'tool/result':
        return event.data.message
      default:
        return null
    }
  }

  deriveMessages() {
    return this.nodes.map((seq) => this.deriveEventMessage(this.eventAt(seq))).filter((message) => message !== null)
  }

  append(type, data, options = {}) {
    const seq = this.events.length
    const event = {
      type,
      seq,
      time: Number.isFinite(options.time) ? options.time : Date.now(),
      data: clone(data),
      ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...options.sourceEventSeqs] }),
      ...(options.surfaceOp === undefined ? {} : { surfaceOp: options.surfaceOp }),
    }
    if (SURFACE_TYPES.has(type)) {
      assert.ok(event.surfaceOp !== undefined, `surface event ${type} needs surfaceOp`)
      if (event.surfaceOp === 'append') {
        this.events.push(event)
        this.nodes.push(seq)
        this.contentGeneration += 1
        return event
      }
      const { startSeq, endSeq } = event.surfaceOp
      const startIdx = this.nodes.indexOf(startSeq)
      const endIdx = this.nodes.indexOf(endSeq)
      assert.ok(startIdx >= 0 && endIdx >= startIdx, 'replacement range must exist')
      const shadowed = this.nodes.slice(startIdx, endIdx + 1)
      for (const shadowedSeq of shadowed) {
        assert.ok(event.sourceEventSeqs.includes(shadowedSeq), 'sourceEventSeqs must include every shadowed node')
      }
      this.events.push(event)
      this.nodes.splice(startIdx, shadowed.length, seq)
      this.replaceGeneration += 1
      this.contentGeneration += 1
      return event
    }
    this.events.push(event)
    return event
  }
}

const userMessage = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistantMessage = (id, text) => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider: 'mock', model: 'mock' },
  content: [{ type: 'text', text }],
})

function appendSystem(session, text = 'SYSTEM PROMPT TEXT (audit-fix-archive)') {
  session.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 'sys-1', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] } },
    { surfaceOp: 'append', time: 1 },
  )
}

/** Token meter that also counts the plugin's own system-prompt sections. */
function measure(session, capture) {
  const nodes = session.nodes.map((seq) => {
    const message = session.deriveEventMessage(session.eventAt(seq))
    const text = JSON.stringify(message?.content ?? '')
    const tokens = Math.max(0, Math.ceil(text.length / 4))
    return { seq, tokens, heuristicTokens: tokens }
  })
  let systemTokens = 0
  for (const section of capture?.sections ?? []) {
    let text = ''
    try {
      text = section.text({ agent: { session } }) ?? ''
    } catch {
      text = ''
    }
    if (typeof text === 'string' && text.length > 0) systemTokens += Math.max(0, Math.ceil(text.length / 4))
  }
  return { totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) + systemTokens, nodes, systemTokens }
}

function makeContext(session) {
  const capture = { sections: [], tools: [], logs: [], registrations: [] }
  const toolsService = {
    register(definition) {
      const entry = { definition, disposed: false }
      capture.tools.push(entry)
      capture.registrations.push(definition)
      return () => {
        entry.disposed = true
      }
    },
  }
  const ctx = {
    logger: {
      info: (message) => capture.logs.push(['info', String(message)]),
      warn: (message) => capture.logs.push(['warn', String(message)]),
      debug: (message) => capture.logs.push(['debug', String(message)]),
    },
    tokenMeter: { measure: () => measure(session, capture) },
    systemPrompt: {
      section(sectionOptions) {
        capture.sections.push(sectionOptions)
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    effect(callback) {
      return callback()
    },
    get(name) {
      if (name === 'systemPrompt') return this.systemPrompt
      if (name === 'tokenMeter') return this.tokenMeter
      if (name === 'tools') return this.tools
      return undefined
    },
  }
  ctx.tools = toolsService
  return { ctx, capture }
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice()
  if (!patch || typeof patch !== 'object') return patch
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? deepMerge(out[key], value) : value
  }
  return out
}

/** Config overrides used by the real plugin adapter (tiny synthetic window). */
function baseOverrides(memoryDir) {
  return {
    enabled: true,
    compress: {
      enabled: true,
      triggerPercent: 1,
      compressPercent: 20,
      contextWindowTokens: 1000,
      minContextTokens: 0,
      minMessagesToCompress: 4,
      minChunkChars: 20,
      targetChunkChars: 400,
      keepRecentMessages: 1,
      allowSmallWindow: true,
      preStepEnabled: false,
      maxFoldersPerRun: 20,
      applyToSubagents: false,
      applyToMainSessions: true,
    },
    scoring: { includeLegacy: true, taskMaxTokens: 1_000_000, taskBudgetPercent: 100 },
    recall: { mode: 'fair', firstGenMax: 10, applyToSubagents: false, applyToMainSessions: true },
    time: { timezone: ASIA },
    timeTag: { mode: 'constrain' },
    storage: { dir: memoryDir, perSession: false },
    logging: { enabled: false, verbose: false },
    compat: { qqBots: 'off' },
  }
}

// ---------------------------------------------------------------------------
// temp dirs + on-disk readers
// ---------------------------------------------------------------------------
const tempDirs = []
function makeTempDir(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `dshr-audit-fix-archive-${label}-`))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // best effort
    }
  }
})

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
function foldersOf(memoryDir) {
  return readdirSync(memoryDir)
    .filter((name) => name.startsWith('mem-'))
    .sort()
    .map((name) => readJson(path.join(memoryDir, name, 'meta.json')))
}
function indexOf(memoryDir) {
  return readJson(path.join(memoryDir, 'index.json'))
}

// ---------------------------------------------------------------------------
// real adapter archive: session -> plugin.compressWithEscalation -> disk
// ---------------------------------------------------------------------------
async function archiveAdapter(label, patch, build) {
  const memoryDir = path.join(makeTempDir(label), 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const session = new FakeSession({ id: `session-${label}`, contextWindow: 1000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, deepMerge(baseOverrides(memoryDir), patch))
  plugin.start()
  build(session)
  await plugin.compressWithEscalation(session, 1, plugin.currentConfig(), 'test')
  return { memoryDir, session, capture, plugin }
}

/** Real `memory_recall` ToolDefinition over an existing memory dir. */
async function recallTool(label, memoryDir) {
  const session = new FakeSession({ id: `session-recall-${label}`, contextWindow: 100_000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, deepMerge(baseOverrides(memoryDir), { compress: { preStepEnabled: false } }))
  plugin.start()
  const definition = capture.tools.find((entry) => entry.definition?.name === 'memory_recall')?.definition
  assert.ok(definition, 'the plugin must register the real memory_recall tool')
  return {
    session,
    call: (args) => definition.execute(args, { agent: { session } }),
  }
}

/** Append one user/assistant message; `time` undefined keeps the host's time. */
function appendMessage(session, index, role, text, time, { withoutTime = false } = {}) {
  if (role === 'assistant') {
    session.append('assistant/message', { turn: 1, step: 1, message: assistantMessage(`a-${index}`, text) }, { surfaceOp: 'append', time })
  } else {
    session.append('user/message', userMessage(`u-${index}`, text), { surfaceOp: 'append', time })
  }
  if (withoutTime) {
    const event = session.events[session.events.length - 1]
    delete event.time
  }
}

// ---------------------------------------------------------------------------
// passive archive fixture (real PassiveArchiver.handle)
// ---------------------------------------------------------------------------
function passiveUserEvent(seq, text, time) {
  const event = { seq, type: 'user/message', data: { id: `u-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }
  if (time !== undefined) event.time = time
  return event
}
function passiveAssistantEvent(seq, text, time) {
  const event = {
    seq,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { id: `a-${seq}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] } },
  }
  if (time !== undefined) event.time = time
  return event
}
function passiveCheckpointEvent(seq, time) {
  return {
    seq,
    time,
    type: 'user/message',
    data: { id: `c-${seq}`, role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'foreign' }, content: [{ type: 'text', text: '<compacted-summary>架构：postgres</compacted-summary>' }] },
  }
}
function passiveSummaryEvent(seq, shadowedSeqs, time) {
  return {
    seq,
    time,
    type: 'compaction/summary',
    data: {
      compactionId: `cmp-${seq}`,
      summary: [{ type: 'text', text: 'host compaction summary' }],
      shadowedSeqs: [...shadowedSeqs],
      shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1] },
      shadowedTokenCount: 321,
    },
  }
}
function passiveSession(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return {
    id: 'session-passive-audit-fix',
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage(event) {
      if (!event || typeof event !== 'object') return null
      if (event.type === 'user/message') return event.data
      if (event.type === 'assistant/message' || event.type === 'system/message' || event.type === 'tool/result') return event.data?.message ?? null
      return null
    },
  }
}
function passiveHost(memoryDir, patch = {}) {
  const cfg = loadConfig(undefined, deepMerge({ time: { timezone: ASIA }, timeTag: { mode: 'constrain' } }, patch))
  return {
    currentConfig: () => cfg,
    scopedConfig: () => ({ ...cfg, memoryDir }),
    chatKeyFor: () => 'chat-audit-fix',
    log: () => {},
  }
}
function archivePassive(label, patch, events) {
  const memoryDir = path.join(makeTempDir(label), 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const summary = events[events.length - 1]
  new PassiveArchiver(passiveHost(memoryDir, patch)).handle(passiveSession(events), summary)
  return memoryDir
}

// ---------------------------------------------------------------------------
// time helpers
// ---------------------------------------------------------------------------
function dayStartOfShanghai(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ASIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const get = (type) => Number(parts.find((part) => part.type === type).value)
  return Date.parse(`${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}T00:00:00+08:00`)
}
function tagWithLabel(meta, label) {
  return (Array.isArray(meta.timeTags) ? meta.timeTags : []).find((tag) => tag.label === label)
}

// ===========================================================================
// F-LEAD-02 (1): extraction quality — sentence/clause-level real words
// ===========================================================================
test('F-LEAD-02: extractAssistantKeywords keeps sentence-level content words', () => {
  const cfg = loadConfig(undefined, {})
  const single = [{ role: 'assistant', content: '我建议你少喝咖啡，下午不要喝浓茶，晚上早点睡。' }]
  const singleKeywords = extractAssistantKeywords(single, cfg)
  assert.ok(Array.isArray(singleKeywords), JSON.stringify(singleKeywords))
  assert.ok(singleKeywords.includes('咖啡'), `single message must contain 咖啡: ${JSON.stringify(singleKeywords)}`)
  assert.ok(singleKeywords.includes('浓茶'), `single message must contain 浓茶: ${JSON.stringify(singleKeywords)}`)
  assert.ok(!singleKeywords.includes('我建') && !singleKeywords.includes('议你'), `no position fragments: ${JSON.stringify(singleKeywords)}`)

  const two = [
    { role: 'assistant', content: '我建议你少喝咖啡，下午不要喝浓茶，晚上早点睡。' },
    { role: 'assistant', content: '睡前可以泡脚，房间保持安静，温度二十度左右。' },
  ]
  const twoKeywords = extractAssistantKeywords(two, cfg)
  assert.ok(twoKeywords.includes('咖啡'), JSON.stringify(twoKeywords))
  assert.ok(twoKeywords.includes('浓茶'), JSON.stringify(twoKeywords))
  assert.ok(twoKeywords.includes('泡脚'), `two messages must contain 泡脚: ${JSON.stringify(twoKeywords)}`)
  assert.ok(twoKeywords.length <= 16, `cap stays inside the 8..16 design range: ${twoKeywords.length}`)

  // ASCII words are kept; v1.5.5 drops pure numbers (JSON/token post-filter).
  const mixed = extractAssistantKeywords([{ role: 'assistant', content: '把 docker 的端口改成 8080 再重启。' }], cfg)
  assert.ok(mixed.includes('docker'), JSON.stringify(mixed))
  assert.equal(mixed.includes('8080'), false, `pure numbers are filtered: ${JSON.stringify(mixed)}`)

  // Non-assistant text never contributes and an empty chunk yields [].
  assert.deepEqual(extractAssistantKeywords([{ role: 'user', content: '咖啡 浓茶' }], cfg), [])
  assert.deepEqual(extractAssistantKeywords([], cfg), [])
})

// ===========================================================================
// F-LEAD-02 (2): real pending archive persists the extracted keywords
// ===========================================================================
const ASSISTANT_CHANNEL_MESSAGES = [
  ['user', '我最近晚上睡不好，有什么办法？', NOW - 2 * DAY],
  ['assistant', '我建议你少喝咖啡，下午不要喝浓茶，晚上早点睡。', undefined],
  ['user', '还有别的建议吗？', NOW - 2 * DAY + 60_000],
  ['assistant', '睡前可以泡脚，房间保持安静，温度二十度左右。', undefined],
  ['user', '好的我试试。', NOW - 2 * DAY + 120_000],
  ['assistant', '尽量白天晒太阳，晚上减少强光。', undefined],
  ['user', '明白。', NOW - 2 * DAY + 180_000],
  ['assistant', '记得记录睡眠日志。', undefined],
]

test('F-LEAD-02: real pending archive writes assistantKeywords to meta.json and index.json', async () => {
  const { memoryDir } = await archiveAdapter('asst-pending', {}, (session) => {
    ASSISTANT_CHANNEL_MESSAGES.forEach(([role, text, time], index) => appendMessage(session, index, role, text, time))
  })
  const folders = foldersOf(memoryDir)
  assert.ok(folders.length >= 1, 'the fixture must archive at least one folder')
  const index = indexOf(memoryDir)
  const entries = new Map(index.folders.map((entry) => [entry.id, entry]))

  const pending = folders.filter((folder) => folder.scored === false)
  assert.equal(pending.length, folders.length, 'the default adapter path archives pending folders (scored:false)')
  for (const folder of pending) {
    assert.ok(Array.isArray(folder.assistantKeywords) && folder.assistantKeywords.length > 0, `${folder.id} has extracted assistantKeywords`)
    const entry = entries.get(folder.id)
    assert.ok(entry, `${folder.id} is mirrored in index.json`)
    assert.deepEqual(entry.assistantKeywords, folder.assistantKeywords, `${folder.id}: index mirrors meta.assistantKeywords`)
  }
  const union = folders.flatMap((folder) => folder.assistantKeywords ?? [])
  assert.ok(union.includes('咖啡'), JSON.stringify(union))
  assert.ok(union.includes('浓茶'), JSON.stringify(union))
  assert.ok(union.includes('泡脚'), JSON.stringify(union))
})

// ===========================================================================
// F-LEAD-02 (3): real heuristic-scored archive -> real memory_recall
// ===========================================================================
test('F-LEAD-02: real heuristic-scored archive is recallable through the assistant channel only', async () => {
  // `scoring.fallback='always'` is the documented production path that makes an
  // archived folder recallable without a model judge call (D8); the archive path,
  // its meta/index writes and the recall tool are all the real ones.
  const { memoryDir } = await archiveAdapter('asst-scored', { scoring: { fallback: 'always' } }, (session) => {
    ASSISTANT_CHANNEL_MESSAGES.forEach(([role, text, time], index) => appendMessage(session, index, role, text, time))
  })
  const folders = foldersOf(memoryDir)
  assert.ok(folders.length >= 1, 'the fixture must archive folders')
  for (const folder of folders) {
    assert.equal(folder.scored, true, 'heuristic fallback scores every folder at archive time')
    assert.equal(folder.keywordsSource, 'heuristic')
  }
  // The chunk that carries the assistant statements is the one with 咖啡; its
  // generic keyword path must NOT contain 咖啡 (otherwise the no-leak half of
  // this test could pass for the wrong reason).
  const folder = folders.find((candidate) => Array.isArray(candidate.assistantKeywords) && candidate.assistantKeywords.includes('咖啡'))
  assert.ok(folder, `a folder must carry the extracted assistant keywords: ${JSON.stringify(folders.map((candidate) => candidate.assistantKeywords))}`)
  for (const token of ['咖啡', '浓茶']) {
    assert.ok(folder.assistantKeywords.includes(token), `${token} in ${JSON.stringify(folder.assistantKeywords)}`)
    assert.ok(!folder.keywords.includes(token), `normal keywords of the archive chunk must not already contain ${token}: ${JSON.stringify(folder.keywords)}`)
  }
  const anyPaojiao = folders.some((candidate) => Array.isArray(candidate.assistantKeywords) && candidate.assistantKeywords.includes('泡脚'))
  assert.ok(anyPaojiao, '泡脚 must be extracted for the two-message scenario')

  const recall = await recallTool('asst-query', memoryDir)
  const said = await recall.call({ keywords: '咖啡 浓茶', assistantSaid: true, limit: 5 })
  assert.ok(said.found >= 1, `assistantSaid query must find the real archived folder: ${JSON.stringify(said)}`)
  assert.ok((said.entries ?? []).some((entry) => entry.id === folder.id), `assistantSaid query must return the archived folder ${folder.id}`)
  const saidPaojiao = await recall.call({ keywords: '泡脚', assistantSaid: true, limit: 5 })
  assert.ok(saidPaojiao.found >= 1, `assistantSaid 泡脚 query must find it too: ${JSON.stringify(saidPaojiao)}`)

  // Ordinary query (no assistantSaid) must not surface a folder only because a
  // synthetic `\u0003asst:` posting matched. Prove it on a token that the normal
  // keyword postings cannot match at all.
  let isolated = null
  for (const token of folder.assistantKeywords) {
    const plain = await recall.call({ keywords: token, limit: 5 })
    if (plain.found === 0) {
      isolated = token
      break
    }
  }
  assert.ok(isolated, `at least one assistant keyword must be unreachable without assistantSaid: ${JSON.stringify(folder.assistantKeywords)}`)
  const stillAbsent = await recall.call({ keywords: isolated, limit: 5 })
  assert.equal(stillAbsent.found, 0, `ordinary query "${isolated}" must not see assistant postings`)
  const channelOnly = await recall.call({ keywords: isolated, assistantSaid: true, limit: 5 })
  assert.ok(channelOnly.found >= 1, `assistantSaid query "${isolated}" must reach the folder`)
})

// ===========================================================================
// F-03-02: timeTag.mode='off' => no collection on the adapter path
// ===========================================================================
function timeTagConversation(session) {
  for (let index = 0; index < 8; index += 1) {
    appendMessage(session, index, 'user', `第${index}轮：昨天讨论部署，下周二评审，2026年10月31日上线。`, NOW + index * 1000)
    appendMessage(session, index, 'assistant', `好的，第${index}轮记录 docker 端口。`, NOW + index * 1000 + 500)
  }
}

test("F-03-02: adapter archive with timeTag.mode='off' writes no timeTags anywhere", async () => {
  const off = await archiveAdapter('tt-off-adapter', { timeTag: { mode: 'off' } }, timeTagConversation)
  assert.ok(foldersOf(off.memoryDir).length > 0, 'the fixture must archive folders')
  for (const folder of foldersOf(off.memoryDir)) {
    assert.equal('timeTags' in folder, false, `mode=off folder ${folder.id} must have no timeTags: ${JSON.stringify(folder.timeTags)}`)
    assert.equal('timeTagSource' in folder, false, `mode=off folder ${folder.id} must have no timeTagSource`)
  }
  for (const entry of indexOf(off.memoryDir).folders) {
    assert.equal('timeTags' in entry, false, `mode=off index entry ${entry.id} must have no timeTags`)
    assert.equal('timeTagSource' in entry, false, `mode=off index entry ${entry.id} must have no timeTagSource`)
  }

  // Control: mode=index still collects the same deterministic tags (no behavior
  // change for index/constrain/default).
  const indexed = await archiveAdapter('tt-index-adapter', { timeTag: { mode: 'index' } }, timeTagConversation)
  const indexedFolders = foldersOf(indexed.memoryDir)
  const tagged = indexedFolders.filter((folder) => Array.isArray(folder.timeTags) && folder.timeTags.length > 0)
  assert.ok(tagged.length > 0, 'mode=index must still collect time tags')
  assert.ok(tagged.some((folder) => folder.timeTags.some((tag) => tag.label === '昨天')), JSON.stringify(tagged.map((folder) => folder.timeTags)))
  assert.ok(tagged.every((folder) => folder.timeTagSource === 'messages'))
  const indexedEntries = new Map(indexOf(indexed.memoryDir).folders.map((entry) => [entry.id, entry]))
  for (const folder of tagged) {
    assert.deepEqual(indexedEntries.get(folder.id)?.timeTags, folder.timeTags, `${folder.id}: index mirrors meta.timeTags`)
  }
})

test("F-03-02: passive archive with timeTag.mode='off' writes no timeTags anywhere", () => {
  const events = [
    passiveUserEvent(1, '昨天把服务端口改成 9090，下周二评审。', NOW),
    passiveAssistantEvent(2, '好的，明天上午验证。', NOW),
    passiveCheckpointEvent(3, NOW),
    passiveSummaryEvent(4, [1, 2, 3], NOW),
  ]
  const offDir = archivePassive('tt-off-passive', { timeTag: { mode: 'off' } }, events)
  const offFolders = foldersOf(offDir)
  assert.equal(offFolders.length, 1)
  assert.equal('timeTags' in offFolders[0], false, JSON.stringify(offFolders[0].timeTags))
  assert.equal('timeTagSource' in offFolders[0], false)
  const offIndex = indexOf(offDir).folders
  assert.equal('timeTags' in offIndex[0], false)
  assert.equal('timeTagSource' in offIndex[0], false)

  const indexDir = archivePassive('tt-index-passive', { timeTag: { mode: 'index' } }, [
    passiveUserEvent(1, '昨天把服务端口改成 9090，下周二评审。', NOW),
    passiveAssistantEvent(2, '好的，明天上午验证。', NOW),
    passiveCheckpointEvent(3, NOW),
    passiveSummaryEvent(4, [1, 2, 3], NOW),
  ])
  const indexedFolder = foldersOf(indexDir)[0]
  assert.ok(Array.isArray(indexedFolder.timeTags) && indexedFolder.timeTags.length > 0, JSON.stringify(indexedFolder.timeTags))
  assert.equal(indexedFolder.timeTagSource, 'messages')
  assert.deepEqual(indexOf(indexDir).folders[0].timeTags, indexedFolder.timeTags, 'passive index mirrors meta.timeTags')
})

// ===========================================================================
// F-03-03: a message without `time` is anchored at the folder createdAt
// ===========================================================================
test('F-03-03: adapter archive anchors a time-less message at folder createdAt (DESIGN §1)', async () => {
  const { memoryDir } = await archiveAdapter('anchor-adapter', {}, (session) => {
    for (let index = 0; index < 10; index += 1) {
      const text = index === 1 ? '第1轮：今天下午继续讨论部署端口。' : `第${index}轮：继续讨论部署 docker 端口配置与数据库迁移记录。`
      appendMessage(session, index, 'user', text, OLD + index * 1000, { withoutTime: index === 1 })
      appendMessage(session, index, 'assistant', `好的，第${index}轮记录部署参数。`, OLD + index * 1000 + 500)
    }
  })
  const folders = foldersOf(memoryDir)
  const tagged = folders.map((folder) => ({ folder, tag: tagWithLabel(folder, '今天') })).filter((item) => item.tag)
  assert.equal(tagged.length, 1, `exactly one folder carries the time-less 今天: ${JSON.stringify(folders.map((folder) => folder.timeTags))}`)
  const { folder, tag } = tagged[0]
  const expected = dayStartOfShanghai(folder.createdAt)
  const oldChunkDay = dayStartOfShanghai(OLD)
  assert.notEqual(oldChunkDay, expected, 'the fixture must separate old message times from the archive day')
  assert.equal(tag.from, expected, `今天 must fall on the folder createdAt day (${new Date(expected).toISOString()}), not the chunk start (${new Date(oldChunkDay).toISOString()})`)
})

test('F-03-03: passive archive anchors a time-less message at folder createdAt (DESIGN §1)', () => {
  const events = [
    passiveUserEvent(1, '普通讨论：部署 docker 端口配置与数据库迁移。', OLD),
    passiveUserEvent(2, '今天下午继续讨论部署端口配置。'),
    passiveCheckpointEvent(3, NOW),
    passiveSummaryEvent(4, [1, 2, 3], NOW),
  ]
  const memoryDir = archivePassive('anchor-passive', {}, events)
  const folder = foldersOf(memoryDir)[0]
  const tag = tagWithLabel(folder, '今天')
  assert.ok(tag, 'the passive path must produce the 今天 tag')
  const expected = dayStartOfShanghai(folder.createdAt)
  const oldChunkDay = dayStartOfShanghai(OLD)
  assert.notEqual(oldChunkDay, expected, 'the fixture must separate old message times from the archive day')
  assert.equal(tag.from, expected, `今天 must fall on the folder createdAt day (${new Date(expected).toISOString()}), not the event start (${new Date(oldChunkDay).toISOString()})`)
})
