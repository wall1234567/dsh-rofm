/**
 * v1.5.0 plugin prompt-surface tests (DESIGN-1.5.0 §5.3):
 *   - the new `dsh-rofm:memory-rules` system-prompt section (registration, the
 *     four answering rules, `rules.enabled=false` rollback);
 *   - the recall section extras: the quoted-assistant hint on an empty recall and
 *     the per-sub-question coverage note (`buildRecallExtras`);
 *   - `plugin.currentQueryInfo(session)` exposing the turn analysis
 *     (`assistantSaid.hit`) that `memory_recall` auto-detection reads;
 *   - the `记忆评分任务` section listing existing canonical event labels so the
 *     judge can reuse one instead of creating a near-duplicate.
 *
 * This is a hermetic adapter test with its own tiny FakeSession/context mock (same
 * shape as `plugin-mock.test.mjs`, which this file deliberately does not modify):
 * no harness, no real memory store, no model call.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { analyzeQuery } from '../engine/query-analysis.js'
import { writeFolder, writeIndex } from '../engine/store.js'
import { RofmPlugin } from '../lib/plugin.js'

const RULES_SECTION = 'dsh-rofm:memory-rules'
const RECALL_SECTION = 'dsh-rofm:recall'
const TASKS_SECTION = 'dsh-rofm:memory-tasks'

// ---------------------------------------------------------------------------
// Mock session / plugin context
// ---------------------------------------------------------------------------

class FakeSession {
  constructor({ contextWindow = 1000, header = { origin: 'main' }, id = 'session-rules-150' } = {}) {
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

  deriveEventMessage() {
    return null
  }

  deriveMessages() {
    return []
  }

  append() {}
}

/** Minimal Cordis-style context: records sections/tools, no real host. */
function makeContext() {
  const capture = { sections: [], tools: [], logs: [] }
  const toolsService = {
    register(definition) {
      const entry = { definition, disposed: false }
      capture.tools.push(entry)
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
    tokenMeter: { measure: () => ({ totalTokens: 0, nodes: [] }) },
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
    emit() {},
    dispose() {},
    get(name) {
      if (name === 'systemPrompt') return this.systemPrompt
      if (name === 'tokenMeter') return this.tokenMeter
      if (name === 'tools') return toolsService
      return undefined
    },
  }
  return { ctx, capture }
}

function sectionOf(capture, name) {
  return capture.sections.find((section) => section.name === name)
}

function sectionText(capture, name, session) {
  const section = sectionOf(capture, name)
  return section ? section.text({ agent: { session } }) : undefined
}

function baseOverrides(memoryDir, extra = {}) {
  return {
    enabled: true,
    compress: { enabled: true, applyToMainSessions: true, applyToSubagents: true },
    scoring: { includeLegacy: true, taskMaxTokens: 1_000_000, taskBudgetPercent: 100 },
    recall: { mode: 'legacy', firstGenMax: 10, applyToMainSessions: true, applyToSubagents: true },
    storage: { dir: memoryDir, perSession: false },
    logging: { enabled: true, verbose: false },
    // Hermetic: never let a developer machine's QQ plugin switch compat paths on.
    compat: { qqBots: 'off' },
    ...extra,
  }
}

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-plugin-rules-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

/** Start one plugin on a temp dir; returns the recorded capture. */
function startPlugin(memoryDir, extraOverrides = {}) {
  const session = new FakeSession()
  const { ctx, capture } = makeContext()
  const plugin = new RofmPlugin(ctx, baseOverrides(memoryDir, extraOverrides))
  plugin.start()
  return { session, ctx, capture, plugin }
}

// ---------------------------------------------------------------------------
// memory-rules section
// ---------------------------------------------------------------------------

test('start() registers the v1.5.0 memory-rules section after recall and memory-tasks', () => {
  withTempDir((dir) => {
    const { session, capture } = startPlugin(path.join(dir, 'memory'))

    const names = capture.sections.map((section) => section.name)
    assert.deepEqual(names, [RECALL_SECTION, TASKS_SECTION, RULES_SECTION], 'the rules section is the third prompt section')
    const rules = sectionOf(capture, RULES_SECTION)
    assert.equal(rules.order, 102)
    assert.equal(rules.interpolate, false)
    assert.equal(typeof rules.text, 'function')
    assert.ok(rules.text({ agent: { session } }).length > 0, 'the rules section is active by default')
    // A context without a session must stay silent instead of throwing.
    assert.equal(rules.text({}), '')
  })
})

test('memory-rules text carries the four v1.5.0 answering rules', () => {
  withTempDir((dir) => {
    const { session, capture } = startPlugin(path.join(dir, 'memory'))
    const text = sectionText(capture, RULES_SECTION, session)

    assert.ok(text.includes('## 记忆使用规则（dsh-rofm）'), text.slice(0, 40))
    // Rule 1: multi-part questions are answered one by one; missing evidence -> 不知道.
    assert.ok(text.includes('多子问题'), 'rule 1: multi-part questions')
    assert.ok(text.includes('不知道'), 'rule 1: say 「不知道」 when a sub-question has no evidence')
    assert.ok(text.includes('逐个'), 'rule 1: answer each sub-question separately')
    // Rule 2: no shared event label means "not necessarily the same event".
    assert.ok(text.includes('同一件事'), 'rule 2: same-event judgement')
    assert.ok(text.includes('事件标签'), 'rule 2: keyed on the event label')
    assert.ok(text.includes('用户确认前不得当作事实') || text.includes('确认前不得当作事实'), 'rule 2: not a fact before confirmation')
    // Rule 3: conflicting memories are listed side by side, never adjudicated.
    assert.ok(text.includes('冲突'), 'rule 3: conflicts')
    assert.ok(text.includes('无法确定'), 'rule 3: state that it cannot be determined')
    assert.ok(text.includes('禁止说「没有冲突」') || text.includes('禁止说'), 'rule 3: no "no conflict" claim')
    // Rule 4: "you said" quotes must be verified before denial/confirmation.
    assert.ok(text.includes('你说过'), 'rule 4: quoted assistant statements')
    assert.ok(text.includes('无证据否认'), 'rule 4: no evidence-free denial')
  })
})

test('rules.enabled=false is the one-switch rollback (section registered, text empty)', () => {
  withTempDir((dir) => {
    const { session, capture } = startPlugin(path.join(dir, 'memory'), { rules: { enabled: false } })

    assert.ok(sectionOf(capture, RULES_SECTION), 'the section stays registered so config can be flipped back at runtime')
    assert.equal(sectionText(capture, RULES_SECTION, session), '', 'the rollback switch suppresses the whole text')
    // The other sections keep working.
    assert.ok(sectionOf(capture, RECALL_SECTION))
    assert.ok(sectionOf(capture, TASKS_SECTION))
  })
})

// ---------------------------------------------------------------------------
// buildRecallExtras / recall section
// ---------------------------------------------------------------------------

test('buildRecallExtras: a quoted-assistant message adds the 【引用助手原话】 hint', () => {
  withTempDir((dir) => {
    const { plugin } = startPlugin(path.join(dir, 'memory'))
    const analysis = analyzeQuery({ text: '你不是说少喝咖啡吗？' })
    assert.equal(analysis.assistantSaid.hit, true, 'fixture message must be detected as a quote')

    const extras = plugin.buildRecallExtras({
      queryInfo: {
        clauses: [],
        tags: { location: [], person: [], event: [] },
        timeWindows: [],
        assistantSaid: analysis.assistantSaid,
        clauseInfo: null,
      },
    })
    assert.ok(extras.includes('【引用助手原话】'), extras)
    assert.ok(extras.includes('你不是说'), 'the detected phrase is named')
    assert.ok(extras.includes('核对回忆里你自己说过什么'), extras)
    assert.ok(extras.includes('禁止无证据否认或肯定'), extras)

    // Nothing to say without a query analysis or without a quote hit.
    assert.equal(plugin.buildRecallExtras({}), '')
    assert.equal(
      plugin.buildRecallExtras({
        queryInfo: { assistantSaid: { hit: false, phrases: [] }, tags: {}, timeWindows: [] },
      }),
      '',
    )
  })
})

test('buildRecallExtras: multi-clause coverage names every sub-question and its status', () => {
  withTempDir((dir) => {
    const { plugin } = startPlugin(path.join(dir, 'memory'))
    const extras = plugin.buildRecallExtras({
      queryInfo: {
        clauses: ['端口配置', '部署时间'],
        tags: { location: ['北京'], person: [], event: [] },
        timeWindows: [{ label: '昨天', from: 1, to: 2 }],
        assistantSaid: { hit: false, phrases: [] },
        clauseInfo: [
          { index: 0, text: '端口配置', quota: 1, hits: 2, status: 'hit' },
          { index: 1, text: '部署时间', quota: 0, hits: 0, status: 'miss' },
        ],
      },
    })
    assert.ok(extras.includes('本轮子问题'), extras)
    assert.ok(extras.includes('子问题 1：端口配置 → 已找到 2 条相关记忆'), extras)
    assert.ok(extras.includes('子问题 2：部署时间 → 未找到相关记忆'), extras)
    assert.ok(extras.includes('不知道'), 'the model is told to write 「不知道」 for an uncovered sub-question')
    assert.ok(extras.includes('【本轮标签过滤】地点=北京'), extras)
    assert.ok(extras.includes('【本轮时间标签过滤】昨天'), extras)
  })
})

test('recall section renders the quoted-assistant extras even when no memory was recalled', () => {
  withTempDir((dir) => {
    const { session, capture, plugin } = startPlugin(path.join(dir, 'memory'))
    const analysis = analyzeQuery({ text: '你不是说少喝咖啡吗？' })
    const state = plugin.sessionState(session)
    state.queryInfo = {
      clauses: [],
      tags: { location: [], person: [], event: [] },
      timeWindows: [],
      assistantSaid: analysis.assistantSaid,
      clauseInfo: null,
    }
    state.lastRecallEmpty = true
    state.recallExtras = plugin.buildRecallExtras(state)

    const text = sectionText(capture, RECALL_SECTION, session)
    assert.ok(text.includes('【引用助手原话】'), text)
    assert.ok(text.includes('你不是说'), text)
    assert.ok(!text.includes('本次未自动回忆到相关记忆'), 'the extras take precedence over the generic empty hint')
  })
})

// ---------------------------------------------------------------------------
// currentQueryInfo
// ---------------------------------------------------------------------------

test('currentQueryInfo(session) exposes the turn analysis including assistantSaid.hit', () => {
  withTempDir((dir) => {
    const { session, plugin } = startPlugin(path.join(dir, 'memory'))
    const analysis = analyzeQuery({ text: '你之前说端口是 8080，对吗？' })
    assert.equal(analysis.assistantSaid.hit, true)

    const state = plugin.sessionState(session)
    state.queryInfo = {
      clauses: analysis.clauses,
      tags: analysis.tags,
      timeWindows: analysis.timeWindows,
      assistantSaid: analysis.assistantSaid,
      complex: analysis.complex,
      quota: analysis.quota,
      clauseInfo: null,
    }

    const info = plugin.currentQueryInfo(session)
    assert.equal(info, state.queryInfo, 'the hook returns the stored per-turn analysis')
    assert.equal(info.assistantSaid.hit, true, 'memory_recall auto-detection reads this field')
    assert.ok(info.assistantSaid.phrases.includes('你之前说'))
    assert.equal(info.quota, analysis.quota)

    // Unknown / disposed / missing sessions return null instead of throwing.
    assert.equal(plugin.currentQueryInfo({ id: 'other-session' }), null)
    assert.equal(plugin.currentQueryInfo(undefined), null)
    assert.equal(plugin.currentQueryInfo(null), null)
  })
})

// ---------------------------------------------------------------------------
// memory-tasks: existing event labels
// ---------------------------------------------------------------------------

/** Write one folder + its index entry into a temp memory dir. */
function writeFolderFixture(memoryDir, id, meta, text) {
  const dir = path.join(memoryDir, id)
  mkdirSync(dir, { recursive: true })
  const createdAt = meta.createdAt ?? Date.now()
  writeFileSync(
    path.join(dir, 'context.json'),
    JSON.stringify({ version: 1, id, createdAt, messages: [{ role: 'user', content: text }] }),
  )
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, ...meta, id }))
}

function readIndexOrEmpty(memoryDir) {
  return { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
}

function writeIndexFixture(memoryDir, folders) {
  writeFileSync(path.join(memoryDir, 'index.json'), JSON.stringify({ version: 1, updatedAt: Date.now(), nextCounter: 9, folders }))
}

function eventTasksFixture(dir, eventsByFolder = { 'mem-scored': ['日本旅行'] }) {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const now = Date.now()
  const index = readIndexOrEmpty(memoryDir)

  for (const [id, events] of Object.entries(eventsByFolder)) {
    const meta = {
      createdAt: now - 5_000,
      alpha: 0.7,
      beta: 3,
      keywords: ['docker'],
      events,
      scored: true,
      title: `旧记忆 ${id}`,
    }
    writeFolderFixture(memoryDir, id, meta, '旧记忆内容')
    index.folders.push({
      id,
      createdAt: meta.createdAt,
      alpha: meta.alpha,
      beta: meta.beta,
      keywords: meta.keywords,
      events,
      chars: 20,
      tokens: 10,
      messageCount: 1,
      title: meta.title,
      scored: true,
    })
  }

  // One pending (unscored) folder: the event list only renders when the model
  // actually has scoring work to do (it is the reuse hint for `memory_judge`).
  const pending = {
    createdAt: now,
    alpha: 0.5,
    beta: 0,
    keywords: [],
    events: [],
    scored: false,
    pendingEra: 'current',
    title: '待评分记忆',
  }
  writeFolderFixture(memoryDir, 'mem-pending', pending, '待评分的内容 docker 部署')
  index.folders.push({
    id: 'mem-pending',
    createdAt: pending.createdAt,
    alpha: pending.alpha,
    beta: pending.beta,
    keywords: pending.keywords,
    chars: 20,
    tokens: 10,
    messageCount: 1,
    title: pending.title,
    scored: false,
    pendingEra: 'current',
  })
  writeIndexFixture(memoryDir, index.folders)
  return memoryDir
}

test('memory-tasks lists existing event labels when pending work and tagged folders exist', () => {
  withTempDir((dir) => {
    const memoryDir = eventTasksFixture(dir)
    const { session, capture } = startPlugin(memoryDir)
    const text = sectionText(capture, TASKS_SECTION, session)

    assert.ok(text.includes('待评分的新归档记忆'), 'the pending folder is listed (fixture sanity)')
    assert.ok(text.includes('### 已有事件标签（同一事件请复用，不要另造近义标签）'), text)
    assert.ok(text.includes('日本旅行（1）'), 'the canonical label and its count are listed')
  })
})

test('memory-tasks event list honours event.showExisting=false', () => {
  withTempDir((dir) => {
    const memoryDir = eventTasksFixture(dir)
    const { session, capture } = startPlugin(memoryDir, { event: { showExisting: false } })
    const text = sectionText(capture, TASKS_SECTION, session)

    assert.ok(text.includes('待评分的新归档记忆'), 'pending work is still listed')
    assert.ok(!text.includes('已有事件标签'), 'the reuse hint is switched off')
    assert.ok(!text.includes('日本旅行（1）'))
  })
})

// ---------------------------------------------------------------------------
// Real-engine integration: onInboxInserted -> analysis -> engine filters -> section
// ---------------------------------------------------------------------------

/** Fair-mode overrides with the v1.5.0 filters active (engine defaults are index). */
function fairOverrides(memoryDir) {
  return {
    enabled: true,
    compress: { enabled: false },
    scoring: { includeLegacy: true, taskMaxTokens: 1_000_000, taskBudgetPercent: 100 },
    recall: { mode: 'fair', firstGenMax: 10, applyToMainSessions: true, applyToSubagents: true },
    storage: { dir: memoryDir, perSession: false },
    logging: { enabled: true, verbose: false },
    compat: { qqBots: 'off' },
    location: { mode: 'constrain', maxLabelLength: 60, maxPerFolder: 8, autoMention: true },
    person: { mode: 'constrain', maxLabelLength: 60, maxPerFolder: 8, autoMention: true },
    timeTag: { mode: 'constrain', maxPerFolder: 8, weekStart: 1, maxSpanDays: 366 },
    event: { mode: 'constrain', maxLabelLength: 60, maxPerFolder: 4, similarity: { metric: 'dice', threshold: 0.72, maxCandidates: 5 } },
  }
}

/** Write one scored memory folder + a consistent index.json. */
function writeMemory(dir, id, options = {}) {
  const createdAt = Date.now() - 3600_000
  const folder = {
    id,
    createdAt,
    alpha: 0.9,
    beta: 3,
    scored: true,
    keywords: options.keywords ?? ['fixture'],
    title: options.title ?? id,
  }
  const meta = {
    version: 1,
    ...folder,
    ...(options.meta ?? {}),
    stats: { messages: 1, chars: 20, tokens: 10 },
  }
  writeFolder(dir, { id, meta, messages: [{ role: 'user', content: options.text ?? `${id} CONTENT`, time: createdAt }] })
  return folder
}

function writeMemories(memoryDir, folders) {
  writeIndex(memoryDir, { version: 1, updatedAt: Date.now(), nextCounter: folders.length + 1, folders })
}

function inboxMessage(id, text) {
  return { id, role: 'user', source: { kind: 'user' }, content: text }
}

test('auto recall: multi-clause message is split, each clause reported, and tag mentions filter', () => {
  withTempDir((dir) => {
    const memoryDir = path.join(dir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeMemories(memoryDir, [
      writeMemory(memoryDir, 'mem-20261101T000000Z-0001', {
        keywords: ['北京', '火锅'],
        meta: { locations: ['北京'], events: ['北京旅行'] },
        text: '昨天在北京吃火锅',
      }),
      writeMemory(memoryDir, 'mem-20261101T000000Z-0002', {
        keywords: ['上海', '会议'],
        meta: { locations: ['上海'] },
        text: '在上海开会',
      }),
    ])
    const session = new FakeSession()
    const { ctx, capture } = makeContext()
    const plugin = new RofmPlugin(ctx, fairOverrides(memoryDir))
    plugin.start()
    // Only 北京 is mentioned: same-kind OR keeps 北京 memories, the Shanghai one is
    // a candidate keyword-wise but the location filter must exclude it.
    plugin.onInboxInserted({ agent: { session }, message: inboxMessage('u-1', '北京好玩吗？火锅店怎么样？') })
    const text = sectionText(capture, RECALL_SECTION, session)
    assert.ok(text.includes('记忆回忆'), text.slice(0, 300))
    assert.ok(text.includes('本轮子问题'), 'multi-clause recall adds the per-sub-question note')
    assert.ok(text.includes('子问题 1'), text.slice(0, 800))
    assert.ok(text.includes('子问题 2'), text.slice(0, 800))
    assert.ok(text.includes('【本轮标签过滤】地点=北京'), 'the detected location tag becomes a hard filter')
    // Every returned folder must carry the detected location tag.
    assert.ok(!text.includes('在上海开会'), 'the non-matching Shanghai memory is filtered out by the location tag')
    const info = plugin.currentQueryInfo(session)
    assert.ok(info && Array.isArray(info.clauseInfo) && info.clauseInfo.length === 2)
  })
})

test('auto recall: a quoted-assistant message searches the assistant-utterance channel', () => {
  withTempDir((dir) => {
    const memoryDir = path.join(dir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeMemories(memoryDir, [
      writeMemory(memoryDir, 'mem-20261102T000000Z-0001', {
        keywords: ['健康', '作息'],
        meta: { assistantKeywords: ['咖啡', '少喝'] },
        text: '我建议你少喝咖啡，晚上早点睡',
      }),
    ])
    const session = new FakeSession()
    const { ctx, capture } = makeContext()
    const plugin = new RofmPlugin(ctx, fairOverrides(memoryDir))
    plugin.start()
    plugin.onInboxInserted({ agent: { session }, message: inboxMessage('u-2', '你不是说少喝咖啡吗？') })
    const text = sectionText(capture, RECALL_SECTION, session)
    assert.ok(text.includes('记忆回忆'), text.slice(0, 300))
    assert.ok(text.includes('少喝咖啡'), 'the assistant utterance is recalled through the separate channel')
    assert.ok(text.includes('【引用助手原话】'), 'the model is told to verify its own words before denying')
    const info = plugin.currentQueryInfo(session)
    assert.equal(info?.assistantSaid?.hit, true)
  })
})
