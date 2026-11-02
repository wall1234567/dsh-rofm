/**
 * E2E: long-session simulation through the REAL adapter path (plan §5.1 "e2e 模拟",
 * contract §11.14).
 *
 * What this file proves that unit tests cannot:
 *
 *   archive (pre-step, deterministic) -> pending folders -> the model calls the
 *   REAL `memory_judge` ToolDefinition -> fair/deterministic recall on later
 *   turns -> persisted recall state -> restart restore.
 *
 * The fake host mirrors `test-adapter/plugin-mock.test.mjs` (a minimal Session
 * implementing exactly the public surface the plugin uses) but is copied here
 * instead of imported: `plugin-mock.test.mjs` is another owner's file and must
 * stay untouched, and importing a `node:test` file would register its whole
 * suite twice.
 *
 * v1.4.0 P0-1 premise: the fake token meter counts the plugin's *system prompt
 * sections* too (`measure()` calls `section.text({ agent: { session } })` like
 * the host does). Without that the "记忆评分任务" block would be invisible to the
 * measured context and the self-amplifying archive loop could never be caught;
 * `fake token meter counts the system-prompt sections` pins this premise.
 *
 * Scale (task brief: "≥700 turn, or 120 turns × several messages but keep the
 * ≥700 messages scale, say so in the test name/comment"): the long session runs
 * `LONG_TURNS = 240` model turns with three messages each (user -> assistant
 * tool-call -> tool result -> final assistant = 4 surface nodes, but 240×3
 * = 720 *conversation messages*), i.e. well above the required ≥700 message
 * scale. 240 agentic tool turns is what a real coding session looks like, and it
 * keeps the whole e2e file inside its < 60 s budget instead of paying 700
 * synchronous host pre-steps for the same archive/recall dynamics.
 *
 * Event constraint (v1.4.0 addendum, design contract §9 "e2e"): the last three
 * cases drive the REAL `memory_judge` / `memory_recall` ToolDefinitions end to
 * end: event tagging (including the `event-merged:` label-merge warning),
 * event-scoped recall, `event:'空'` / omitted = unconstrained, the R5 ambiguous
 * flow (Dice-similar candidates returned without results), `unknown` events,
 * time+event AND, and automatic recall staying unconstrained.
 *
 * Node:test cases in this file: 8 long-session/scale + 4 event-constraint = 12.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RofmPlugin } from '../lib/plugin.js'
import { deserializeLanes, estimateTokens, lanesFingerprint, serializeLanes } from '../engine/index.js'

// ---------------------------------------------------------------------------
// Fake host (mirrors test-adapter/plugin-mock.test.mjs; DO NOT import that file)
// ---------------------------------------------------------------------------

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const clone = (value) => JSON.parse(JSON.stringify(value))

class FakeSession {
  constructor({ contextWindow = 20000, header = { origin: 'main' }, id = 'session-e2e' } = {}) {
    this.id = id
    this.header = header
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
const toolCallMessage = (id, callId, name, args) => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider: 'mock', model: 'mock' },
  content: [
    { type: 'text', text: '读取文件以确认参数' },
    { type: 'tool-call', id: callId, name, arguments: args },
  ],
})
const toolResultMessage = (id, callId, text) => ({
  id,
  role: 'tool',
  source: { kind: 'tool', callId },
  toolCallId: callId,
  content: [{ type: 'text', text }],
})

function appendSystem(session, text = 'SYSTEM PROMPT TEXT (e2e)') {
  session.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 'sys-1', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] } },
    { surfaceOp: 'append', time: 1 },
  )
}

/**
 * Token-meter measurement of the model-visible context. v1.4.0: the plugin's
 * system-prompt sections are part of the request, so the fake meter MUST count
 * them (this is the P0-1 feedback-loop premise, plan §2.4).
 */
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

/** Mock plugin context: no `llm` service (archiving must never call a model). */
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

function sectionOf(capture, name) {
  return capture.sections.find((section) => section.name === name)
}

/** Text of the recall block system-prompt section ('' before any recall). */
function recallText(capture, session) {
  const section = sectionOf(capture, 'dsh-rofm:recall')
  return section ? section.text({ agent: { session } }) : ''
}

/** Text of the `记忆评分任务` system-prompt section ('' when there is no work). */
function tasksText(capture, session) {
  const section = sectionOf(capture, 'dsh-rofm:memory-tasks')
  return section ? section.text({ agent: { session } }) : ''
}

function judgeDefinition(capture) {
  return capture.tools.find((entry) => entry.definition?.name === 'memory_judge')?.definition
}

// ---------------------------------------------------------------------------
// Config / temp dir helpers
// ---------------------------------------------------------------------------

const LONG_WINDOW = 20000
/** 240 model turns x 3 conversation messages = 720 messages (≥700, see header). */
const LONG_TURNS = 240
const TASK_BUDGET_PERCENT = 15
const TASK_MAX_TOKENS = 12000

function makeOverrides(memoryDir, patch = {}) {
  return {
    enabled: true,
    compress: {
      enabled: true,
      triggerPercent: 60,
      compressPercent: 20,
      // 0 = use the host-reported window (the real adapter contract).
      contextWindowTokens: 0,
      minContextTokens: 0,
      minMessagesToCompress: 4,
      minChunkChars: 50,
      targetChunkChars: 1200,
      maxFoldersPerRun: 20,
      keepRecentMessages: 2,
      applyToSubagents: true,
      applyToMainSessions: true,
      preStepEnabled: true,
      emergencyPercent: 85,
      emergencyCompressPercent: 40,
      maxExtraPasses: 0,
      hardLimitPercent: 95,
      hardLimitStop: true,
      // 20000 tokens is exactly the small-window boundary: NOT below it.
      allowSmallWindow: false,
      smallWindowTokens: 20000,
      maxFoldersPerStep: 500,
    },
    scoring: {
      includeLegacy: false,
      taskBudgetPercent: TASK_BUDGET_PERCENT,
      taskMaxTokens: TASK_MAX_TOKENS,
      order: 'newest',
      maxPending: 200,
      // The simulated model always judges in the same turn, so the archive path
      // never needs to pause or degrade to heuristic scoring.
      fallback: 'never',
    },
    recall: {
      mode: 'fair',
      firstGenMax: 10,
      persistInjected: true,
      applyToSubagents: true,
      applyToMainSessions: true,
      triggerSourceKinds: ['user'],
      espEmptyHint: true,
    },
    // v1.4.0 event constraint (addendum): the packaged product enables
    // 'constrain'; pinned here so the e2e cases do not depend on config.json.
    event: {
      mode: 'constrain',
      maxLabelLength: 60,
      similarity: { metric: 'dice', threshold: 0.72, maxCandidates: 5 },
      askUserHint: true,
    },
    importance: { min: 0.01, max: 1, warnAbove: 0.8 },
    keywords: { min: 3, max: 8 },
    storage: { dir: memoryDir, perSession: false },
    logging: { enabled: true, verbose: false },
    compat: { qqBots: 'off' },
    ...patch,
  }
}

const tempDirs = []
function makeTempDir(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `dsh-rofm-e2e-${label}-`))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // temp cleanup is best effort
    }
  }
})

const readIndexFile = (memoryDir) => JSON.parse(readFileSync(path.join(memoryDir, 'index.json'), 'utf8'))

function readFolderText(memoryDir, id) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(memoryDir, id, 'context.json'), 'utf8'))
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
    return messages
      .map((message) => {
        const content = message?.content
        if (typeof content === 'string') return content
        if (Array.isArray(content)) return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join(' ')
        return ''
      })
      .join('\n')
  } catch {
    return ''
  }
}

function pendingFolders(memoryDir) {
  try {
    return readIndexFile(memoryDir).folders.filter((folder) => folder.scored === false)
  } catch {
    return []
  }
}

/**
 * The simulated model scores every archived folder through the REAL
 * `memory_judge` ToolDefinition: rare-topic folders become high α with the rare
 * keyword, everything else becomes a low-α log entry with content-unique
 * keywords (so it can never be recalled by accident).
 */
async function judgePendingFolders({ memoryDir, capture, session, markers, markerFolderIds }) {
  const definition = judgeDefinition(capture)
  assert.ok(definition, 'memory_judge must be registered by the plugin')
  const index = readIndexFile(memoryDir)
  const updates = []
  for (const folder of index.folders.filter((entry) => entry.scored === false)) {
    const text = readFolderText(memoryDir, folder.id)
    const marker = markers.find((candidate) => text.includes(candidate))
    const hash = (String(folder.id).match(/(\d{4})$/)?.[1] ?? '0000')
    if (marker) {
      updates.push({
        id: folder.id,
        alpha: 0.95,
        beta: 6,
        keywords: [marker, `${marker}纪要`, `${marker}档案`],
        reason: `用户明确强调的长期约定：${marker}`,
      })
      if (!markerFolderIds.has(marker)) markerFolderIds.set(marker, new Set())
      markerFolderIds.get(marker).add(folder.id)
    } else {
      updates.push({
        id: folder.id,
        alpha: 0.2,
        beta: 0,
        keywords: [`归档${hash}`, `记录${hash}0`, `片段${hash}1`],
        reason: '工具输出/过程日志',
      })
    }
  }
  // Folders whose recalled copy was re-archived need a review, not new keywords.
  for (const folder of index.folders.filter((entry) => entry.rescorePending === true)) {
    updates.push({ id: folder.id, keep: true })
  }
  if (updates.length === 0) return 0
  const result = await definition.execute({ updates }, { agent: { session } })
  assert.deepEqual(result.rejected, [], `the simulated model update must be accepted (${JSON.stringify(result.rejected)})`)
  return result.updated.length
}

// ---------------------------------------------------------------------------
// The long session, executed once and shared by the assertions below
// ---------------------------------------------------------------------------

/** Rare topics: archived early, judged high α, queried much later. */
const MARKERS = ['鲸落协议', '星轨参数', '赤霄端口']
const MARKER_TURNS = { 30: MARKERS[0], 40: MARKERS[1], 50: MARKERS[2] }
const QUERY_TURNS = { 150: MARKERS[0], 180: MARKERS[1], 210: MARKERS[2] }
const LONG_SESSION_ID = 'session-e2e-long'

function turnUserText(turn) {
  const base = `继续讨论部署 docker 端口配置与数据库迁移，记录编号 ${turn}。`
  const marker = MARKER_TURNS[turn]
  if (marker) return `关于「${marker}」的设计记录：这是我们已经确定的长期约定，编号 ${turn}。${base}`
  const query = QUERY_TURNS[turn]
  if (query) return `请回忆「${query}」相关的设计记录。${base}`
  return base
}

function toolOutputText(turn) {
  // Every 12th turn models a large file read: it is what pushes a real session
  // over the archive trigger in one step (instead of a per-turn trickle).
  if (turn % 12 !== 0) return `读取成功：第 ${turn} 行的 docker 端口配置为 808${turn % 10}。`
  return (
    '文件内容：\n' +
    Array.from(
      { length: 60 },
      (_, line) => `第 ${line} 行：docker 端口映射与数据库迁移配置的详细说明，参数 value_${turn}_${line}，需要保持一致。`,
    ).join('\n')
  )
}

let longRunPromise
function getLongRun() {
  if (!longRunPromise) longRunPromise = runLongSession()
  return longRunPromise
}

async function runLongSession() {
  const dir = makeTempDir('long')
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const session = new FakeSession({ id: LONG_SESSION_ID, contextWindow: LONG_WINDOW })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir))
  plugin.start()
  assert.ok(judgeDefinition(capture), 'memory_judge is registered at start()')

  const markerFolderIds = new Map()
  const observations = {
    dir,
    memoryDir,
    session,
    plugin,
    capture,
    markerFolderIds,
    recallByTurn: new Map(),
    firstSeenTurnByFolder: new Map(),
    queryTurns: new Map(),
    percentSeries: [],
    maxTaskTokens: 0,
    taskRenders: 0,
    taskBudget: Math.min(TASK_MAX_TOKENS, (LONG_WINDOW * TASK_BUDGET_PERCENT) / 100),
    archivedTurns: 0,
    currentUserArchived: false,
    hardLimitConsecutiveMax: 0,
  }

  let hardLimitRun = 0
  for (let turn = 1; turn <= LONG_TURNS; turn += 1) {
    const user = userMessage(`u-${turn}`, turnUserText(turn))
    const userSeq = session.append('user/message', user, { surfaceOp: 'append', time: 1_790_000_000_000 + turn * 1000 }).seq
    // 1) inbox: a new real user message triggers automatic fair recall.
    plugin.onInboxInserted({ agent: { session }, message: user })
    const state = plugin.sessions.get(session)
    const additions = Array.isArray(state?.additions) ? state.additions : []
    if (additions.length > 0) {
      observations.recallByTurn.set(turn, additions.map((addition) => addition.id))
      for (const addition of additions) {
        if (!observations.firstSeenTurnByFolder.has(addition.id)) observations.firstSeenTurnByFolder.set(addition.id, turn)
      }
    }
    const queryMarker = QUERY_TURNS[turn]
    if (queryMarker) observations.queryTurns.set(queryMarker, { turn, additions: additions.map((addition) => addition.id) })

    // 2) host pre-step: archive when the measured context is over the trigger.
    await plugin.onPreStep({ agent: { session }, turn }, async () => ({ kind: 'enter' }))
    // P0-3: the question being answered may never be archived mid-turn.
    if (!session.nodes.includes(userSeq)) {
      observations.currentUserArchived = true
      observations.currentUserArchivedTurn = turn
    }

    // 3) the model-visible task block (P0-1 token budget) — measured before judging.
    const taskText = tasksText(capture, session)
    if (taskText.length > 0) {
      observations.taskRenders += 1
      observations.maxTaskTokens = Math.max(observations.maxTaskTokens, estimateTokens(taskText))
    }

    // 4) the model scores everything pending (real memory_judge execute).
    await judgePendingFolders({ memoryDir, capture, session, markers: MARKERS, markerFolderIds })
    if (pendingFolders(memoryDir).length > 0) observations.archivedTurns += 1

    // 5) tool step of the same agentic turn + final assistant reply.
    session.append(
      'assistant/message',
      { turn, step: 1, message: toolCallMessage(`tc-${turn}`, `call-${turn}`, 'read_file', { path: `src/文件-${turn}.js` }), stream: [] },
      { surfaceOp: 'append', time: 1_790_000_000_000 + turn * 1000 + 10 },
    )
    session.append(
      'tool/result',
      { turn, step: 2, message: toolResultMessage(`tr-${turn}`, `call-${turn}`, toolOutputText(turn)) },
      { surfaceOp: 'append', time: 1_790_000_000_000 + turn * 1000 + 20 },
    )
    session.append(
      'assistant/message',
      { turn, step: 2, message: assistantMessage(`a-${turn}`, `好的，第 ${turn} 轮记录了参数，保持 docker 端口与数据库迁移配置一致。`), stream: [] },
      { surfaceOp: 'append', time: 1_790_000_000_000 + turn * 1000 + 30 },
    )

    const percent = (measure(session, capture).totalTokens / LONG_WINDOW) * 100
    observations.percentSeries.push(percent)
    if (percent > 95) {
      hardLimitRun += 1
      observations.hardLimitConsecutiveMax = Math.max(observations.hardLimitConsecutiveMax, hardLimitRun)
    } else {
      hardLimitRun = 0
    }
  }

  // Final model turn: make sure at least one recalled memory is live in the
  // block when the session stops, so the restart path is exercised (a pass-0
  // re-archive may have removed earlier block entries).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await judgePendingFolders({ memoryDir, capture, session, markers: MARKERS, markerFolderIds })
    const state = plugin.sessions.get(session)
    if (Array.isArray(state?.additions) && state.additions.length > 0) break
    const user = userMessage(`u-quiet-${attempt}`, `请回忆「${MARKERS[0]}」的约定。补充编号 ${9000 + attempt}。`)
    session.append('user/message', user, { surfaceOp: 'append', time: 1_790_000_000_000 + LONG_TURNS * 1000 + attempt })
    plugin.onInboxInserted({ agent: { session }, message: user })
  }

  const state = plugin.sessions.get(session)
  observations.preText = typeof state?.text === 'string' ? state.text : ''
  observations.preIds = Array.isArray(state?.additions) ? state.additions.map((addition) => addition.id) : []
  observations.pendingAtEnd = pendingFolders(memoryDir).length
  observations.index = (() => {
    try {
      return readIndexFile(memoryDir)
    } catch {
      return { folders: [] }
    }
  })()
  observations.recallStateFile = path.join(memoryDir, 'recall-state.json')
  observations.recallState = existsSync(observations.recallStateFile)
    ? JSON.parse(readFileSync(observations.recallStateFile, 'utf8'))
    : null
  observations.warnLogs = capture.logs.filter(([level]) => level === 'warn').map(([, message]) => message)
  return observations
}

// ---------------------------------------------------------------------------
// 1) P0-1 premise: the fake meter counts the system-prompt sections
// ---------------------------------------------------------------------------

/**
 * Fixed timestamps for fixtures: CURRENT_ERA_MS sits after the v1.2.0 legacy
 * cutoff (2026-10-27T19:14:00Z) so `scoring.includeLegacy=false` (the product
 * default) does not filter the fixture out of the task block.
 */
const CURRENT_ERA_MS = 1_793_500_000_000

function writeFolderFixture(memoryDir, id, options = {}) {
  const {
    alpha = 0.5,
    beta = 0,
    keywords = ['fixture', '记忆片段', '测试条目'],
    text = 'FIXTURE-MEMORY-CONTENT',
    createdAt = CURRENT_ERA_MS,
    scored = true,
  } = options
  const dir = path.join(memoryDir, id)
  mkdirSync(dir, { recursive: true })
  const messages = [{ role: 'user', content: text }]
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify({ version: 1, id, createdAt, messages }))
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      version: 1,
      id,
      createdAt,
      alpha,
      beta,
      keywords,
      title: text.slice(0, 24),
      scored,
      stats: { messages: messages.length, chars: text.length, tokens: 10 },
    }),
  )
  let index = { version: 1, updatedAt: createdAt, nextCounter: 1, folders: [] }
  try {
    index = readIndexFile(memoryDir)
  } catch {
    index = { version: 1, updatedAt: createdAt, nextCounter: 1, folders: [] }
  }
  index.folders = (index.folders ?? []).filter((folder) => folder.id !== id)
  index.folders.push({ id, createdAt, alpha, beta, keywords, chars: text.length, tokens: 10, messageCount: 1, title: text.slice(0, 24), scored })
  writeFileSync(path.join(memoryDir, 'index.json'), JSON.stringify(index))
}

test('fake token meter counts the system-prompt sections (P0-1 premise)', async () => {
  const dir = makeTempDir('meter')
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // A pending folder makes the `记忆评分任务` section non-empty.
  writeFolderFixture(memoryDir, 'mem-meter-0001', { scored: false, alpha: 0, beta: 0, keywords: [], text: '待评分记忆内容' })
  const session = new FakeSession({ id: 'session-meter', contextWindow: LONG_WINDOW })
  appendSystem(session)
  session.append('user/message', userMessage('u-1', '继续讨论部署参数。'), { surfaceOp: 'append' })
  const { ctx, capture } = makeContext(session)
  const plugin = new RofmPlugin(ctx, makeOverrides(memoryDir, { compress: { ...makeOverrides(memoryDir).compress, enabled: false } }))
  plugin.start()
  const measurement = measure(session, capture)
  const nodeTokens = measurement.nodes.reduce((sum, node) => sum + node.tokens, 0)
  const taskText = tasksText(capture, session)
  assert.ok(taskText.length > 0, 'the pending folder renders a task block')
  assert.ok(measurement.systemTokens > 0, 'the fake meter counts section tokens')
  assert.ok(measurement.totalTokens > nodeTokens, 'totalTokens includes the system-prompt sections')
  assert.ok(
    measurement.totalTokens - nodeTokens >= Math.ceil(taskText.length / 4),
    `the task section contributes its own tokens (system=${measurement.totalTokens - nodeTokens}, section chars=${taskText.length})`,
  )
})

// ---------------------------------------------------------------------------
// 2) The long session: archive -> pending -> judge -> recall
// ---------------------------------------------------------------------------

test(`long session (${LONG_TURNS} turns × 3 messages = ${LONG_TURNS * 3} messages ≥ 700): archive → judge → recall, no self-destruction`, async () => {
  const run = await getLongRun()
  const { memoryDir, index, capture, session, plugin } = run

  // (a) every archived folder was scored: nothing is left pending.
  assert.ok(Array.isArray(index.folders) && index.folders.length > 0, 'the long session archived memory folders')
  assert.ok(index.folders.length >= 20, `a long session archives a substantial store (got ${index.folders.length})`)
  const stillPending = index.folders.filter((folder) => folder.scored === false)
  assert.deepEqual(stillPending.map((folder) => folder.id), [], 'pending drains to 0: every archived folder has scored !== false')
  assert.equal(run.pendingAtEnd, 0, 'the final task block has no work left')
  for (const folder of index.folders) {
    assert.notEqual(folder.scored, false, `folder ${folder.id} is scored`)
  }

  // (b) recall actually fired on ≥3 different turns, and the high-α folder of a
  //     rare-topic query shows up within one turn of the first query (G1).
  const recallTurns = [...run.recallByTurn.keys()]
  assert.ok(recallTurns.length >= 3, `recall hit at least 3 different turns (got ${recallTurns.length}: ${recallTurns.join(',')})`)
  for (const marker of MARKERS) {
    const query = run.queryTurns.get(marker)
    assert.ok(query, `marker ${marker} was queried by the simulated user`)
    const folderIds = run.markerFolderIds.get(marker) ?? new Set()
    assert.ok(folderIds.size > 0, `the judged store contains a folder with the rare keyword ${marker}`)
    // The rare-topic folder must be injected by the first query (same turn) or
    // the immediately following turn — plan §3.2.1 G1 "rare word high-α same round".
    const injected = [...folderIds]
      .map((id) => ({ id, turn: run.firstSeenTurnByFolder.get(id) }))
      .filter((entry) => Number.isFinite(entry.turn))
    assert.ok(injected.length > 0, `the ${marker} folder was injected at some turn`)
    const first = injected.sort((left, right) => left.turn - right.turn)[0]
    assert.ok(
      first.turn - query.turn >= 0 && first.turn - query.turn <= 1,
      `high-α ${marker} folder appears within one turn of the first query (query turn ${query.turn}, injected turn ${first.turn})`,
    )
    // The injected folder is high α (the mock judge gave rare topics 0.95).
    const entry = index.folders.find((folder) => folder.id === first.id)
    assert.ok(entry, `the injected folder ${first.id} is in the index`)
    assert.ok(Number(entry.alpha) >= 0.9, `the ${marker} folder is high α (got ${entry.alpha})`)
    assert.ok(!query.additions.includes('__never__'), 'sanity')
  }
  // The recall block is rendered as a system-prompt section the model sees.
  const recalledBlock = recallText(capture, session)
  assert.ok(recalledBlock.length > 0, 'a recall block is rendered into the system prompt')
  assert.ok((recalledBlock.match(/^### 回忆/gm) ?? []).length > 0, 'the rendered block contains memory entries')

  // (c) the task block never exceeds min(taskMaxTokens, window*taskBudgetPercent%).
  assert.ok(run.taskRenders > 0, 'the task section rendered work during the session')
  assert.ok(run.maxTaskTokens > 0, 'the task section token measurement is non-empty')
  assert.ok(
    run.maxTaskTokens <= run.taskBudget,
    `task block stays within its budget (max ${run.maxTaskTokens} ≤ ${run.taskBudget} tokens; window ${LONG_WINDOW}, ${TASK_BUDGET_PERCENT}%, absolute cap ${TASK_MAX_TOKENS})`,
  )

  // (d) no self-destruction: no runaway growth, no sustained hard-limit stay.
  const maxPercent = Math.max(...run.percentSeries)
  assert.ok(Number.isFinite(maxPercent), 'context measurement is finite every turn')
  assert.ok(maxPercent < 95, `the measured context never crosses hardLimitPercent=95 (max ${maxPercent.toFixed(1)}%)`)
  assert.ok(run.hardLimitConsecutiveMax <= 2, 'no sustained > hardLimitPercent stay between turns')
  assert.ok(run.percentSeries.filter((percent) => percent > 60).length < run.percentSeries.length * 0.9, 'the session does not stay permanently above the trigger')

  // (f/g) current-turn protection: the question being answered was never archived.
  assert.equal(run.currentUserArchived, false, `multi-message turns never archive the current question (turn ${run.currentUserArchivedTurn ?? '-'})`)

  // Recall state v1/v2 compatibility surface exists and carries the injected block.
  assert.ok(run.recallState, 'the plugin persisted recall-state.json after recall')
  assert.ok(typeof run.recallState.version === 'number', 'recall-state carries a numeric version')
  assert.ok(Array.isArray(run.recallState.ids), 'recall-state keeps the v1/v2 `ids` array')
  assert.ok(typeof run.recallState.block === 'string', 'recall-state keeps the rendered block text')
  assert.equal(run.recallState.block, run.preText, 'the persisted block is exactly the injected block text')

  // Sanity: the store is not the real one (temp dir) and archiving provenance is 1.4.0.
  assert.ok(memoryDir.startsWith(os.tmpdir()), 'the e2e store lives in os.tmpdir()')
  const modelArchived = index.folders.filter((folder) => folder.scoreMode === 'model')
  assert.ok(modelArchived.length > 0, 'archived folders carry scoreMode=model provenance (P0-2)')
  assert.equal(plugin.disposed, false, 'the plugin instance stays alive through the session')
})

// ---------------------------------------------------------------------------
// 3) Restart: injected text + v3 lane state survive a plugin restart
// ---------------------------------------------------------------------------

test('restart restore: same session id + memoryDir re-injects the block (≥90% same ids) and keeps the rendered text', async () => {
  const run = await getLongRun()
  assert.ok(run.preIds.length > 0, 'the long session ends with at least one recalled memory in the block')

  const session2 = new FakeSession({ id: LONG_SESSION_ID, contextWindow: LONG_WINDOW })
  const { ctx: ctx2, capture: capture2 } = makeContext(session2)
  const plugin2 = new RofmPlugin(ctx2, makeOverrides(run.memoryDir))
  plugin2.start()
  // The host's first pre-step after a restart is what re-injects the block.
  await plugin2.onPreStep({ agent: { session: session2 }, turn: 1 }, async () => ({ kind: 'enter' }))

  const restored = plugin2.sessions.get(session2)
  const restoredText = typeof restored?.text === 'string' ? restored.text : ''
  const restoredIds = Array.isArray(restored?.additions) ? restored.additions.map((addition) => addition.id) : []
  assert.equal(restoredText, run.preText, 'the re-injected text is byte-identical to the pre-restart block')
  assert.equal(recallText(capture2, session2), run.preText, 'the recall section renders the restored block')
  const overlap = restoredIds.filter((id) => run.preIds.includes(id)).length
  assert.ok(
    overlap / run.preIds.length >= 0.9,
    `≥90% of the pre-restart ids are restored (${overlap}/${run.preIds.length})`,
  )
})

test('recall-state v3 persists lanes + ledger and round-trips them (contract §6)', async () => {
  const run = await getLongRun()
  const payload = run.recallState
  assert.ok(payload, 'recall-state.json exists')
  assert.equal(payload.version, 3, `recall-state v3 is required by contract §6 (got version ${payload.version})`)
  assert.equal(payload.sessionId, LONG_SESSION_ID, 'v3 records the session id')
  assert.ok(Number.isFinite(Number(payload.updatedAt)), 'v3 records updatedAt')
  assert.ok(Array.isArray(payload.ids) && payload.ids.length > 0, 'v3 keeps the v1/v2 `ids` array (backward compatibility)')
  assert.ok(Array.isArray(payload.additions) && payload.additions.length > 0, 'v3 keeps the v2 `additions` snapshot')
  assert.ok(Number.isFinite(Number(payload.round)) && Number(payload.round) >= 1, 'v3 records the recall round')
  assert.ok(typeof payload.configFingerprint === 'string' && payload.configFingerprint.length > 0, 'v3 records configFingerprint')
  assert.ok(payload.lanes && typeof payload.lanes === 'object', 'v3 records the FAIR-DRI lane state')
  assert.ok(Array.isArray(payload.ledger), 'v3 records the recall ledger')
  assert.ok(payload.counters && typeof payload.counters === 'object', 'v3 records the counters block')
  for (const key of ['frontier', 'pendingHigh', 'pendingHighRound', 'highRecycle', 'recycle']) {
    assert.ok(Array.isArray(payload.lanes[key]), `v3 lanes.${key} is a JSON-safe array`)
  }
  assert.ok(payload.lanes.exploreCursor === null || typeof payload.lanes.exploreCursor === 'object', 'v3 lanes.exploreCursor is null or an object')
  assert.equal(typeof payload.lanes.degraded, 'boolean', 'v3 lanes.degraded is a boolean')
  for (const key of ['reInjections', 'registerDrops', 'recallTimeEvicted', 'timeMisses']) {
    assert.equal(typeof payload.counters[key], 'number', `v3 counters.${key} is a number`)
  }

  // configFingerprint must be the documented lanesFingerprint(cfg) of the live config.
  const pluginCfg = run.plugin.currentConfig()
  assert.equal(payload.configFingerprint, lanesFingerprint(pluginCfg), 'configFingerprint = lanesFingerprint(cfg)')

  // Round-trip: serialize(deserialize(payload)) is stable (self-healing lane state).
  const lanes = deserializeLanes(payload.lanes)
  const roundTripped = serializeLanes(lanes)
  assert.deepEqual(roundTripped, payload.lanes, 'lanes survive deserialize → serialize unchanged')
  const jsonRestored = deserializeLanes(JSON.parse(JSON.stringify(roundTripped)))
  assert.deepEqual(serializeLanes(jsonRestored), roundTripped, 'lanes survive a JSON round-trip')

  // The adapter exposes the lane hooks `memory_recall` needs (contract §5.8).
  for (const method of ['getRecallLanes', 'commitRecallLanes', 'nextRecallRound']) {
    assert.equal(typeof run.plugin[method], 'function', `plugin exposes ${method}() for memory_recall (contract §5.8)`)
  }
  const laneState = run.plugin.getRecallLanes(LONG_SESSION_ID === run.session.id ? run.session : run.session, pluginCfg)
  assert.ok(laneState && typeof laneState === 'object', 'getRecallLanes returns the persisted lane state')
  assert.ok(Number(run.plugin.nextRecallRound(run.session)) >= Number(payload.round), 'nextRecallRound continues above the persisted round')
})

// ---------------------------------------------------------------------------
// 4) Determinism: same memory + same input twice -> identical recall ids
// ---------------------------------------------------------------------------

const DETERMINISM_SEED = Object.freeze([
  { id: 'mem-det-0001', alpha: 0.95, createdAt: 1_790_100_000_000, keywords: ['鲸落协议', '鲸落协议纪要', '鲸落协议档案'], text: '鲸落协议：端口 8080 与数据库迁移约定。' },
  { id: 'mem-det-0002', alpha: 0.55, createdAt: 1_790_100_001_000, keywords: ['docker部署', '数据库迁移', '端口映射'], text: 'docker 部署与数据库迁移的参数记录。' },
  { id: 'mem-det-0003', alpha: 0.2, createdAt: 1_790_100_002_000, keywords: ['归档记录', '过程日志', '参数快照'], text: '过程日志与参数快照。' },
])
const DETERMINISM_INPUT = Object.freeze([
  '鲸落协议 怎么样',
  'docker部署 与 数据库迁移 进度',
  '回忆鲸落协议纪要',
  '过程日志 归档记录 看一下',
  '端口映射 检查',
  '鲸落协议 再确认一次',
  '参数快照 归档记录',
  '总结一下 docker部署',
])

async function replayDeterministicScenario(label) {
  const dir = makeTempDir(`det-${label}`)
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  for (const folder of DETERMINISM_SEED) writeFolderFixture(memoryDir, folder.id, folder)
  const session = new FakeSession({ id: 'session-deterministic', contextWindow: 200000 })
  appendSystem(session)
  const overrides = makeOverrides(memoryDir)
  // Archiving is off: this scenario replays the recall decision only.
  overrides.compress = { ...overrides.compress, enabled: false, preStepEnabled: false }
  const { ctx } = makeContext(session)
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const perTurn = []
  for (let index = 0; index < DETERMINISM_INPUT.length; index += 1) {
    const user = userMessage(`u-det-${index}`, DETERMINISM_INPUT[index])
    session.append('user/message', user, { surfaceOp: 'append', time: 1_790_100_100_000 + index })
    plugin.onInboxInserted({ agent: { session }, message: user })
    const state = plugin.sessions.get(session)
    perTurn.push((state?.additions ?? []).map((addition) => addition.id))
  }
  return perTurn
}

test('determinism: the same memory + the same session input replayed on fresh stores yields identical recall ids', async () => {
  const first = await replayDeterministicScenario('a')
  const second = await replayDeterministicScenario('b')
  assert.deepEqual(second, first, 'recall ids are identical across two independent replays')
  assert.equal(first.length, DETERMINISM_INPUT.length, 'every input turn was replayed')
  const nonEmpty = first.filter((ids) => ids.length > 0).length
  assert.ok(nonEmpty >= 3, `the deterministic scenario actually recalls on multiple turns (got ${nonEmpty})`)
  // The rare high-α memory must be recalled on its first mention, every replay.
  assert.ok(first[0].includes('mem-det-0001'), 'the high-α rare memory is recalled on the first mention')
})

// ---------------------------------------------------------------------------
// 5) Small windows (8k / 16k): default refuses automatic archiving, no backlog
// ---------------------------------------------------------------------------

function smallWindowOverrides(memoryDir, { windowTokens, allowSmallWindow }) {
  const overrides = makeOverrides(memoryDir)
  overrides.compress = {
    ...overrides.compress,
    // Below the 20000-token small-window threshold by construction.
    triggerPercent: 5,
    allowSmallWindow,
  }
  return { overrides, windowTokens }
}

async function runSmallWindowScenario({ windowTokens, allowSmallWindow }) {
  const dir = makeTempDir(`small-${windowTokens}-${allowSmallWindow ? 'optin' : 'default'}`)
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const session = new FakeSession({ id: `session-small-${windowTokens}`, contextWindow: windowTokens })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const { overrides } = smallWindowOverrides(memoryDir, { windowTokens, allowSmallWindow })
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const markerFolderIds = new Map()
  const percentSeries = []
  for (let turn = 1; turn <= 60; turn += 1) {
    const user = userMessage(`u-${turn}`, `第${turn}轮：继续讨论部署 docker 端口配置与数据库迁移，参数编号 ${turn}。`)
    session.append('user/message', user, { surfaceOp: 'append', time: 1_790_200_000_000 + turn * 1000 })
    plugin.onInboxInserted({ agent: { session }, message: user })
    await plugin.onPreStep({ agent: { session }, turn }, async () => ({ kind: 'enter' }))
    await judgePendingFolders({ memoryDir, capture, session, markers: MARKERS, markerFolderIds })
    session.append(
      'assistant/message',
      { turn, step: 1, message: assistantMessage(`a-${turn}`, `好的，第 ${turn} 轮记录了 docker 端口参数。`), stream: [] },
      { surfaceOp: 'append', time: 1_790_200_000_000 + turn * 1000 + 10 },
    )
    percentSeries.push((measure(session, capture).totalTokens / windowTokens) * 100)
  }
  const folders = existsSync(path.join(memoryDir, 'index.json')) ? readIndexFile(memoryDir).folders : []
  return {
    folders,
    pending: folders.filter((folder) => folder.scored === false).length,
    percentSeries,
    warnLogs: capture.logs.filter(([level]) => level === 'warn').map(([, message]) => message),
    capture,
    session,
  }
}

test('8k window: default (allowSmallWindow=false) refuses automatic archiving and builds no backlog', async () => {
  const run = await runSmallWindowScenario({ windowTokens: 8000, allowSmallWindow: false })
  assert.deepEqual(run.folders, [], 'a sub-threshold window archives nothing by default (P1-6)')
  assert.equal(run.pending, 0, 'no pending backlog is produced')
  const smallWindowWarnings = run.warnLogs.filter((message) => /small context window|fake\/synthetic window/i.test(message))
  assert.ok(smallWindowWarnings.length >= 1, 'the refusal is explainable: a WARN names the small window')
  assert.ok(smallWindowWarnings.length <= 1, 'the small-window warning is emitted once per session, not per pass')
  const maxPercent = Math.max(...run.percentSeries)
  assert.ok(maxPercent < 500, `no fake-window (500%+) runaway is recorded (max ${maxPercent.toFixed(0)}%)`)
  // The same 8k window only archives when the operator explicitly opts in.
  const optIn = await runSmallWindowScenario({ windowTokens: 8000, allowSmallWindow: true })
  assert.ok(optIn.folders.length > 0, 'allowSmallWindow=true is the documented opt-in that enables archiving again')
})

test('16k window: default refuses archiving, opt-in archives (guard is the gate, not the trigger)', async () => {
  const run = await runSmallWindowScenario({ windowTokens: 16000, allowSmallWindow: false })
  assert.deepEqual(run.folders, [], '16k < smallWindowTokens=20000 → refused by default')
  assert.equal(run.pending, 0, 'no unbounded backlog')
  assert.ok(
    run.warnLogs.some((message) => /small context window/i.test(message)),
    'the 16k refusal logs the small-window WARN',
  )
})

// ---------------------------------------------------------------------------
// 6) Task block: the absolute taskMaxTokens cap binds on a large window
// ---------------------------------------------------------------------------

test('task block: absolute taskMaxTokens cap binds when window*15% is larger', async () => {
  const dir = makeTempDir('budget')
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // 60 pending folders with long summaries: far more than the absolute cap.
  for (let index = 0; index < 60; index += 1) {
    writeFolderFixture(memoryDir, `mem-budget-${String(index).padStart(4, '0')}`, {
      scored: false,
      alpha: 0,
      beta: 0,
      keywords: [],
      createdAt: CURRENT_ERA_MS + index,
      text: `待评分记忆 ${index}：${'甲'.repeat(280)}`,
    })
  }
  // A large window means window*15% (=30000) is far above the absolute cap, so
  // the absolute `taskMaxTokens` is the binding limit (contract §4 scoring).
  const absoluteCap = 2500
  const session = new FakeSession({ id: 'session-budget', contextWindow: 200000 })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const overrides = makeOverrides(memoryDir)
  overrides.compress = { ...overrides.compress, enabled: false, preStepEnabled: false }
  overrides.scoring = { ...overrides.scoring, taskMaxTokens: absoluteCap }
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const text = tasksText(capture, session)
  assert.ok(text.length > 0, 'the 60 pending folders render a task block')
  const tokens = estimateTokens(text)
  const windowShare = (200000 * TASK_BUDGET_PERCENT) / 100 // 30000
  assert.ok(windowShare > absoluteCap, 'the window share is larger, so the absolute cap is the binding one')
  assert.ok(tokens <= absoluteCap, `the absolute taskMaxTokens=${absoluteCap} cap binds (got ${tokens} tokens)`)
  assert.ok(text.includes('因任务区块预算未列出'), 'truncation is disclosed to the model')
})

// ---------------------------------------------------------------------------
// 7) Event constraint (v1.4.0 addendum): memory_judge tags, memory_recall filters
// ---------------------------------------------------------------------------

/** Two fixed event days (Asia/Shanghai morning), current-era and deterministic. */
const EVENT_DAY_ONE = Date.UTC(2026, 9, 28, 18) // 2026-10-29 02:00 +08
const EVENT_DAY_TWO = Date.UTC(2026, 9, 31, 18) // 2026-11-01 02:00 +08
const EVENT_TRIP = '日本旅行'
const EVENT_PROJECT = '登录重构项目'
const EVENT_KEYWORDS = ['项目记录', '参数快照', '事件索引']
/** Fixture memories: two trip, one work project, one with no event at all. */
const EVENT_FIXTURES = [
  { id: 'mem-event-a1', createdAt: EVENT_DAY_ONE, text: '日本旅行 第一天 行程 记录' },
  { id: 'mem-event-a2', createdAt: EVENT_DAY_TWO, text: '日本旅行 计划 变更 记录' },
  { id: 'mem-event-b1', createdAt: EVENT_DAY_ONE, text: '登录重构项目 评审 记录' },
  { id: 'mem-event-none', createdAt: EVENT_DAY_TWO, text: '今天天气不错 闲聊' },
]

function recallDefinition(capture) {
  return capture.tools.find((entry) => entry.definition?.name === 'memory_recall')?.definition
}

let eventFixturePromise
function getEventFixture() {
  if (!eventFixturePromise) eventFixturePromise = createEventFixture()
  return eventFixturePromise
}

/**
 * Store with the four event-fixture memories, tagged through two REAL
 * `memory_judge` calls:
 *   1) canonical labels 日本旅行 / 登录重构项目 + one memory left without event;
 *   2) the approximate label 「日本旅行计划」 which `assignEventLabel` must merge
 *      into 「日本旅行」 (Dice 0.778) and report with the `event-merged:` marker.
 */
async function createEventFixture() {
  const dir = makeTempDir('event')
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  for (const fixture of EVENT_FIXTURES) {
    writeFolderFixture(memoryDir, fixture.id, {
      scored: false,
      alpha: 0,
      beta: 0,
      keywords: [],
      createdAt: fixture.createdAt,
      text: fixture.text,
    })
  }
  const session = new FakeSession({ id: 'session-event-constraint', contextWindow: LONG_WINDOW })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const overrides = makeOverrides(memoryDir)
  overrides.compress = { ...overrides.compress, enabled: false, preStepEnabled: false }
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const judge = judgeDefinition(capture)
  const recall = recallDefinition(capture)
  assert.ok(judge, 'memory_judge must be registered')
  assert.ok(recall, 'memory_recall must be registered')

  const firstCall = await judge.execute(
    {
      updates: [
        { id: 'mem-event-a1', alpha: 0.9, beta: 3, keywords: EVENT_KEYWORDS, event: EVENT_TRIP, reason: '旅行第一天的行程记录' },
        { id: 'mem-event-b1', alpha: 0.8, beta: 3, keywords: EVENT_KEYWORDS, event: EVENT_PROJECT, reason: '工作项目的评审记录' },
        { id: 'mem-event-none', alpha: 0.5, beta: 0, keywords: EVENT_KEYWORDS, reason: '一次闲聊' },
      ],
    },
    { agent: { session } },
  )
  const secondCall = await judge.execute(
    {
      updates: [
        { id: 'mem-event-a2', alpha: 0.9, beta: 3, keywords: EVENT_KEYWORDS, event: `${EVENT_TRIP}计划`, reason: '旅行计划变更记录' },
      ],
    },
    { agent: { session } },
  )
  const engine = plugin.engineFor(session, plugin.currentConfig())
  const index = readIndexFile(memoryDir)
  let sessionSeq = 0
  return {
    dir,
    memoryDir,
    session,
    plugin,
    capture,
    judge,
    recall,
    firstCall,
    secondCall,
    engine,
    index,
    memoryOf: (id) => JSON.parse(readFileSync(path.join(memoryDir, id, 'meta.json'), 'utf8')),
    // Fresh sessions keep the deterministic lane/frontier state per scenario,
    // exactly like separate model turns that never replayed an earlier recall.
    nextSession: () => new FakeSession({ id: `session-event-tool-${++sessionSeq}`, contextWindow: LONG_WINDOW }),
  }
}

/** Execute memory_recall through the real ToolDefinition and render the model text. */
async function runRecallTool(run, args, session) {
  const target = session ?? run.nextSession()
  const value = await run.recall.execute(args, { agent: { session: target } })
  const rendered = run.recall.output.render(args, value)[0].text
  return { session: target, args, value, rendered, ids: Array.isArray(value?.added) ? value.added : [] }
}

test('event constraint (a): memory_judge tags canonical event labels and merges similar ones', async () => {
  const run = await getEventFixture()

  // (1) canonical labels land in meta.json and are mirrored into index.json.
  const a1 = run.memoryOf('mem-event-a1')
  const a2 = run.memoryOf('mem-event-a2')
  const b1 = run.memoryOf('mem-event-b1')
  const none = run.memoryOf('mem-event-none')
  assert.equal(a1.event, EVENT_TRIP, 'the first trip memory is tagged with the canonical event')
  assert.equal(a2.event, EVENT_TRIP, 'the approximate label 日本旅行计划 is merged into 日本旅行')
  assert.equal(b1.event, EVENT_PROJECT, 'the work project memory keeps its own event')
  assert.equal(none.event, undefined, 'a memory without an event writes no event field (old-data compatible)')
  for (const meta of [a1, a2, b1]) {
    assert.equal(meta.eventSource, 'llm', 'event provenance is the scoring model')
    assert.ok(Number.isFinite(Number(meta.eventAt)), 'the last event-label write time is recorded')
  }
  assert.equal(none.eventSource, undefined, 'no event provenance for an event-less memory')
  const indexEvents = Object.fromEntries(run.index.folders.map((folder) => [folder.id, folder.event]))
  assert.equal(indexEvents['mem-event-a1'], EVENT_TRIP, 'index.json mirrors the canonical event')
  assert.equal(indexEvents['mem-event-a2'], EVENT_TRIP, 'index.json mirrors the merged event')
  assert.equal(indexEvents['mem-event-b1'], EVENT_PROJECT, 'index.json mirrors the project event')
  assert.equal(indexEvents['mem-event-none'], undefined, 'index.json has no event for the event-less memory')

  // (2) batch accounting + the model-visible warnings.
  assert.deepEqual(run.firstCall.eventStats, { assigned: 2, merged: 0, cleared: 0 }, 'the first batch assigns two events')
  assert.ok(
    run.firstCall.warnings.some((warning) => warning.includes('没有 event 标签')),
    'a new memory judged without an event gets a non-blocking reminder',
  )
  assert.deepEqual(run.secondCall.eventStats, { assigned: 0, merged: 1, cleared: 0 }, 'the second batch reports one merge')
  const mergeWarning = run.secondCall.warnings.find((warning) => warning.startsWith('event-merged:'))
  assert.ok(mergeWarning, 'the merge carries the stable `event-merged:` marker')
  assert.ok(mergeWarning.includes(EVENT_TRIP) && mergeWarning.includes('0.78'), `the merge warning names both labels and the score (${mergeWarning})`)
  const judgeText = run.judge.output.render(null, run.secondCall)[0].text
  assert.match(judgeText, /事件标签：归并 1 条/, 'the judge summary counts event merges without printing label text')

  // (3) the in-memory derived event index agrees (count desc, canonical labels only).
  const eventIndex = run.engine.eventIndex()
  assert.deepEqual(
    eventIndex.labels.map((entry) => ({ label: entry.label, count: entry.count })),
    [
      { label: EVENT_TRIP, count: 2 },
      { label: EVENT_PROJECT, count: 1 },
    ],
    'event index buckets are canonical and count-sorted',
  )
  assert.equal(eventIndex.byKey.size, 2, 'two canonical events share one key each')
  assert.equal(eventIndex.byId.size, 3, 'three memories carry an event; the fourth has none')
  assert.equal(eventIndex.byId.get('mem-event-a2').label, EVENT_TRIP, 'the merged memory points at the canonical label')
})

test('event constraint (b): memory_recall scopes to the event; 空/omitted are unconstrained; time AND event', async () => {
  const run = await getEventFixture()

  // (1) event-scoped recall returns exactly that event's memories.
  const exact = await runRecallTool(run, { keywords: '项目记录', event: EVENT_TRIP, limit: 8 })
  assert.equal(exact.value.found, 2, 'the trip event has exactly two memories')
  assert.deepEqual([...exact.ids].sort(), ['mem-event-a1', 'mem-event-a2'], 'only the trip event is returned')
  assert.deepEqual(
    { status: exact.value.eventInfo.status, label: exact.value.eventInfo.label, enforced: exact.value.eventInfo.enforced, count: exact.value.eventInfo.count },
    { status: 'exact', label: EVENT_TRIP, enforced: true, count: 2 },
    'eventInfo reports the exact enforced event with its size',
  )
  assert.ok(
    exact.rendered.includes('本次回忆已约束事件：「日本旅行」（该事件共 2 条记忆）'),
    'the model sees the event constraint line with the event size',
  )
  const project = await runRecallTool(run, { keywords: '项目记录', event: EVENT_PROJECT, limit: 8 })
  assert.equal(project.value.found, 1, 'the project event has one memory')
  assert.deepEqual(project.ids, ['mem-event-b1'], 'no cross-event leakage into the project recall')

  // (2) explicit `event:'空'` clears the constraint; omitted means the same.
  const empty = await runRecallTool(run, { keywords: '项目记录', event: '空', limit: 8 })
  assert.equal(empty.value.found, 4, 'clearing the event constraint returns every matching memory')
  assert.equal(empty.value.eventInfo.status, 'empty', 'explicit 空 is recorded as the empty state')
  assert.equal(empty.value.eventInfo.enforced, false, 'the empty state never filters')
  assert.ok(!empty.rendered.includes('本次回忆已约束事件'), 'no constraint line is rendered for 空')
  assert.ok(empty.ids.includes('mem-event-b1'), 'an unconstrained recall can return memories of other events')
  const omitted = await runRecallTool(run, { keywords: '项目记录', limit: 8 })
  assert.equal(omitted.value.found, 4, 'omitting event is unconstrained too')
  assert.equal(omitted.value.eventInfo, undefined, 'omitted event produces no eventInfo')
  assert.deepEqual([...omitted.ids].sort(), [...empty.ids].sort(), '空 and omitted select the same memories')

  // (3) time + event are ANDed: the hard window covers day one only.
  const and = await runRecallTool(run, { keywords: '项目记录', event: EVENT_TRIP, timeFrom: '2026-10-28', timeTo: '2026-10-31', limit: 8 })
  assert.equal(and.value.found, 1, 'only the day-one trip memory is inside both constraints')
  assert.deepEqual(and.ids, ['mem-event-a1'], 'the day-two trip memory is outside the hard time window')
  assert.equal(and.value.timeWindow.hardWindow, true, 'an explicit from+to range is a hard window')
  assert.equal(and.value.eventInfo.status, 'exact', 'the event constraint is still applied alongside time')
  assert.ok(and.rendered.includes('时间范围：') && and.rendered.includes('本次回忆已约束事件'), 'both constraint lines are rendered (AND)')
  const timeOnly = await runRecallTool(run, { keywords: '项目记录', timeFrom: '2026-10-28', timeTo: '2026-10-31', limit: 8 })
  assert.equal(timeOnly.value.found, 2, 'the same window without the event constraint returns both day-one memories')
  assert.deepEqual([...timeOnly.ids].sort(), ['mem-event-a1', 'mem-event-b1'], 'time-only recall spans both events')
})

test('event constraint (c): ambiguous labels wait for the model, unknown events miss cleanly, auto recall stays unconstrained', async () => {
  const run = await getEventFixture()

  // (1) R5 ambiguity: a new-but-similar label returns candidates and NO results.
  const session = run.nextSession()
  const ambiguous = await runRecallTool(run, { keywords: '项目记录', event: `${EVENT_TRIP}计划`, limit: 8 }, session)
  assert.equal(ambiguous.value.found, 0, 'an ambiguous label never guesses a result')
  assert.deepEqual(ambiguous.ids, [], 'no additions for an ambiguous event')
  assert.equal(ambiguous.value.missType, 'event-ambiguous', 'the miss type tells the model to arbitrate')
  assert.equal(ambiguous.value.eventInfo.status, 'similar', 'the R5 status is similar')
  assert.equal(ambiguous.value.eventInfo.enforced, false, 'an ambiguous label never filters')
  assert.deepEqual(
    ambiguous.value.eventInfo.candidates.map((candidate) => ({ label: candidate.label, count: candidate.count })),
    [{ label: EVENT_TRIP, count: 2 }],
    'the similar canonical event is returned as a candidate',
  )
  assert.ok(Math.abs(Number(ambiguous.value.eventInfo.candidates[0].score) - 0.7778) < 0.01, 'the candidate carries the Dice score')
  assert.ok(ambiguous.rendered.includes('与已有事件高度相似'), 'the model is told the submitted event is similar to an existing one')
  assert.ok(ambiguous.rendered.includes('请判断是否为同一事件'), 'the model is asked to decide whether they are the same event')
  assert.ok(ambiguous.rendered.includes('event:"空"'), 'the model is told how to drop the constraint')

  // (2) ambiguous/time/event misses never count as a 3/6 strike.
  const miss = await runRecallTool(run, { keywords: '完全无关的词汇' }, session)
  assert.equal(miss.value.found, 0)
  assert.equal(miss.value.missType, 'keyword')
  assert.equal(miss.value.misses, 1, 'the ambiguous attempt did not count as a strike (first true miss = 1)')

  // (3) submitting the candidate label resolves to the exact event.
  const resolved = await runRecallTool(run, { keywords: '项目记录', event: EVENT_TRIP, limit: 8 }, session)
  assert.equal(resolved.value.found, 2, 're-submitting the candidate label hits the exact event')
  assert.equal(resolved.value.eventInfo.status, 'exact')

  // (4) unknown event: strict constraint to an event with no memories.
  const unknown = await runRecallTool(run, { keywords: '项目记录', event: '火星基地', limit: 8 })
  assert.equal(unknown.value.found, 0, 'an unknown event returns no memories')
  assert.equal(unknown.value.missType, 'event', 'unknown events report an event miss')
  assert.equal(unknown.value.eventInfo.status, 'unknown')
  assert.equal(unknown.value.eventInfo.enforced, true, 'an unknown event is still a strict constraint')
  assert.equal(unknown.value.eventInfo.count, 0, 'the unknown event has zero memories')
  assert.ok(unknown.rendered.includes('事件「火星基地」还没有任何记忆'), 'the model sees the unknown-event hint')
  assert.ok(unknown.rendered.includes('①'), 'the hint lists the next steps (tag memories / clear / ask the user)')

  // (5) automatic recall (onInboxInserted) never receives an event constraint: a
  // message matching the shared keyword recalls memories of BOTH events.
  const user = userMessage('u-event-auto', '继续讨论项目记录 的细节')
  run.session.append('user/message', user, { surfaceOp: 'append', time: EVENT_DAY_ONE })
  run.plugin.onInboxInserted({ agent: { session: run.session }, message: user })
  const additions = (run.plugin.sessions.get(run.session)?.additions ?? []).map((addition) => addition.id)
  assert.ok(additions.length >= 3, `automatic recall injects the shared-keyword memories (got ${additions.length})`)
  assert.ok(additions.includes('mem-event-b1'), 'auto recall is not limited to the trip event')
  assert.ok(additions.some((id) => id.startsWith('mem-event-a')), 'auto recall also injects the trip memories')
  assert.ok(additions.includes('mem-event-none'), 'auto recall also injects the event-less memory')
})

test('event constraint (d): memory_judge clears an event tag with 空 (design §6.2)', async () => {
  const dir = makeTempDir('event-clear')
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFolderFixture(memoryDir, 'mem-event-clear', {
    scored: false,
    alpha: 0,
    beta: 0,
    keywords: [],
    createdAt: EVENT_DAY_ONE,
    text: '一段临时旅行笔记',
  })
  const session = new FakeSession({ id: 'session-event-clear', contextWindow: LONG_WINDOW })
  appendSystem(session)
  const { ctx, capture } = makeContext(session)
  const overrides = makeOverrides(memoryDir)
  overrides.compress = { ...overrides.compress, enabled: false, preStepEnabled: false }
  const plugin = new RofmPlugin(ctx, overrides)
  plugin.start()
  const judge = judgeDefinition(capture)
  const recall = recallDefinition(capture)
  const metaOf = () => JSON.parse(readFileSync(path.join(memoryDir, 'mem-event-clear', 'meta.json'), 'utf8'))

  // Tag first, then clear with the documented placeholder.
  const tagged = await judge.execute(
    { updates: [{ id: 'mem-event-clear', alpha: 0.7, beta: 2, keywords: EVENT_KEYWORDS, event: '旅行笔记', reason: '旅行笔记' }] },
    { agent: { session } },
  )
  assert.deepEqual(tagged.eventStats, { assigned: 1, merged: 0, cleared: 0 })
  assert.equal(metaOf().event, '旅行笔记')
  const cleared = await judge.execute({ updates: [{ id: 'mem-event-clear', event: '空' }] }, { agent: { session } })
  assert.deepEqual(cleared.eventStats, { assigned: 0, merged: 0, cleared: 1 }, 'clearing an event is counted separately')
  assert.equal(metaOf().event, undefined, '空 deletes meta.event instead of writing an empty string')
  assert.equal(metaOf().eventSource, undefined, 'clearing removes the event provenance too')
  assert.match(judge.output.render(null, cleared)[0].text, /事件标签：清空 1 条/)
  const indexEntry = readIndexFile(memoryDir).folders.find((folder) => folder.id === 'mem-event-clear')
  assert.equal(indexEntry.event, undefined, 'index.json no longer carries the cleared event')
  // The cleared label no longer matches anything: the event is unknown now.
  const afterClear = await recall.execute({ keywords: '项目记录', event: '旅行笔记', limit: 8 }, { agent: { session } })
  assert.equal(afterClear.found, 0, 'a cleared event tag is not recallable')
  assert.equal(afterClear.eventInfo.status, 'unknown', 'the cleared label resolves to an unknown event')
})
