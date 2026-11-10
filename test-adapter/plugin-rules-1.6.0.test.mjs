/**
 * v1.6.0 plugin prompt-surface tests (recall escalation):
 *   - the three new `dsh-rofm:memory-rules` answering rules and their stable
 *     order: an unhelpful automatic recall block requires at least one
 *     self-initiated `memory_recall`; a full page requires one retry with a
 *     larger `limit` (<= 20); one person's several names are passed together to
 *     `persons` (same-kind OR, never a filter);
 *   - the strengthened one-line empty-recall hint (`EMPTY_RECALL_HINT`): "no
 *     automatic hit" is no longer a licence to answer 「没找到/不记得」;
 *   - `buildRecallExtras`' deterministic full-quota nudge: trigger condition
 *     (`additions.length >=` effective quota, quota = `queryInfo.quota` else
 *     `recall.firstGenMax`, `<= 0` never nudges), the trimmed-block disclosure,
 *     and the position after the v1.5.0 per-clause / tag / quoted hints;
 *   - the `记忆评分任务` rubric's new `persons 指代消解` line (pending-scoring
 *     branch only, after the v1.5.0 tag/merge rules and before the keep note).
 *
 * Hermetic adapter test with its own tiny FakeSession/context mock (same shape as
 * `test-adapter/plugin-rules-1.5.0.test.mjs`): no harness, no real memory store,
 * no model call.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RofmPlugin } from '../lib/plugin.js'

const RULES_SECTION = 'dsh-rofm:memory-rules'
const RECALL_SECTION = 'dsh-rofm:recall'
const TASKS_SECTION = 'dsh-rofm:memory-tasks'

// ---------------------------------------------------------------------------
// Mock session / plugin context
// ---------------------------------------------------------------------------

class FakeSession {
  constructor({ contextWindow = 1000, header = { origin: 'main' }, id = 'session-rules-160' } = {}) {
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-plugin-rules-160-'))
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

/** Write one scored/remembered memory folder and keep `index.json` consistent. */
function writeFolderFixture(memoryDir, id, meta, text) {
  const dir = path.join(memoryDir, id)
  mkdirSync(dir, { recursive: true })
  const createdAt = meta.createdAt ?? Date.now()
  writeFileSync(
    path.join(dir, 'context.json'),
    JSON.stringify({ version: 1, id, createdAt, messages: [{ role: 'user', content: text, time: createdAt }] }),
  )
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, ...meta, id }))
  let index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  try {
    index = JSON.parse(readFileSync(path.join(memoryDir, 'index.json'), 'utf8'))
  } catch {
    index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  }
  index.folders = Array.isArray(index.folders) ? index.folders.filter((folder) => folder.id !== id) : []
  index.folders.push({ id, createdAt, ...meta })
  writeFileSync(path.join(memoryDir, 'index.json'), JSON.stringify(index))
}

/** The empty `queryInfo` shape `buildRecallExtras` accepts. */
function baseQueryInfo(extra = {}) {
  return {
    clauses: [],
    tags: { location: [], person: [], event: [] },
    timeWindows: [],
    assistantSaid: { hit: false, phrases: [] },
    clauseInfo: null,
    quota: null,
    ...extra,
  }
}

function additionsOf(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `mem-quota-${String(index + 1).padStart(2, '0')}` }))
}

// ---------------------------------------------------------------------------
// memory-rules section: the v1.6.0 rules
// ---------------------------------------------------------------------------

test('v1.6.0 memory-rules add active-recall / full-quota / person-alias rules in order', () => {
  withTempDir((dir) => {
    const { session, capture } = startPlugin(path.join(dir, 'memory'))
    const text = sectionText(capture, RULES_SECTION, session)

    assert.ok(text.includes('## 记忆使用规则（dsh-rofm）'), text.slice(0, 40))
    // The four v1.5.0 rules stay (rollback parity: v1.6.0 only appends).
    for (const rule of ['多子问题', '同一件事', '冲突', '助手原话']) assert.ok(text.includes(rule), `v1.5.0 rule kept: ${rule}`)

    // Rule 5: an unhelpful automatic recall demands one self-initiated recall.
    assert.ok(text.includes('主动召回'), 'rule 5: active recall')
    assert.ok(text.includes('支撑回答的证据'), 'rule 5: defines "the block did not support the answer"')
    assert.ok(text.includes('至少一次 memory_recall'), 'rule 5: at least one memory_recall call')
    assert.ok(text.includes('禁止直接说「没找到」「不记得」'), 'rule 5: forbids answering "not found" outright')
    assert.ok(text.includes('也禁止凭空猜测'), 'rule 5: forbids guessing')
    // Rule 6: a full result set demands one retry with a larger quota.
    assert.ok(text.includes('满额重试'), 'rule 6: full-quota retry')
    assert.ok(text.includes('memory_recall 的 limit 最多 20'), 'rule 6: names the hard limit')
    assert.ok(text.includes('不要停在第一页'), 'rule 6: do not stop at the first page')
    // Rule 7: one person may have several names; persons is an OR, not a filter.
    assert.ok(text.includes('人物称呼'), 'rule 7: person aliases')
    assert.ok(text.includes('同一人物可能有多个称呼'), 'rule 7: states the alias fact')
    assert.ok(text.includes('一并传入 persons'), 'rule 7: pass the aliases together')
    assert.ok(text.includes('不会互相筛选'), 'rule 7: same-kind values are an OR')
    assert.ok(text.includes('拿不准就都传上'), 'rule 7: when unsure, pass all aliases')

    // Stable order: old rules first, then v1.6.0 rules in the same order as the
    // prompt is written (someone reading the section top-down gets the flow).
    const order = ['多子问题', '同一件事', '冲突', '助手原话', '主动召回', '满额重试', '人物称呼']
    let previous = -1
    for (const needle of order) {
      const index = text.indexOf(needle)
      assert.ok(index >= 0, `rule present: ${needle}`)
      assert.ok(index > previous, `rule order: ${needle} comes after the previous rule`)
      previous = index
    }
    // This section is a system prompt on every request: keep it compact.
    assert.ok(text.length < 1200, `the rules section stays compact (got ${text.length} chars)`)
  })
})

// ---------------------------------------------------------------------------
// EMPTY_RECALL_HINT: no automatic hit is not "no memory"
// ---------------------------------------------------------------------------

test('empty automatic recall demands at least one self-initiated memory_recall', () => {
  withTempDir((dir) => {
    const memoryDir = path.join(dir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    // A scored memory that does not match this message lexically: the automatic
    // recall is empty, but "no memory" would be the wrong conclusion.
    writeFolderFixture(
      memoryDir,
      'mem-20260101T000000Z-0001',
      { createdAt: Date.now() - 3600_000, alpha: 0.9, beta: 3, keywords: ['星港'], title: '星港项目复盘' },
      '星港项目的复盘内容',
    )
    const session = new FakeSession({ id: 'session-empty-hint-160' })
    const { ctx, capture } = makeContext()
    const plugin = new RofmPlugin(ctx, baseOverrides(memoryDir))
    plugin.start()
    plugin.onInboxInserted({
      agent: { session },
      message: { id: 'u-empty-160', role: 'user', source: { kind: 'user' }, content: '完全无关的问题：晚饭吃什么' },
    })
    const hint = sectionText(capture, RECALL_SECTION, session)

    // v1.4.0 contract kept: the model can tell "no memory" from "missed".
    assert.ok(hint.includes('未自动回忆到相关记忆'), hint)
    assert.ok(hint.includes('如记忆与某个事件相关'), 'the event-related note is kept')
    assert.ok(hint.includes('memory_recall 的 event 参数'), 'the event filter is still named')
    // v1.6.0: one active recall before answering is mandatory.
    assert.ok(hint.includes('回答前必须自行调用至少一次 memory_recall'), hint)
    assert.ok(hint.includes('不要凭空猜测'), 'guessing stays forbidden')
    assert.ok(hint.includes('「没找到」「不记得」'), 'answering "not found" outright is forbidden')
    assert.equal(hint.split('\n').length, 1, 'still one low-noise line (no permanent extra prompt)')
  })
})

// ---------------------------------------------------------------------------
// buildRecallExtras: full-quota nudge
// ---------------------------------------------------------------------------

test('buildRecallExtras: the full-quota nudge fires at additions >= effective quota', () => {
  const plugin = new RofmPlugin(makeContext().ctx, { enabled: true, recall: { firstGenMax: 3 } })
  const stateAt = (count, extra = {}) => ({ additions: additionsOf(count), queryInfo: baseQueryInfo(extra) })

  const atQuota = plugin.buildRecallExtras(stateAt(3))
  assert.ok(atQuota.includes('【本轮自动回忆已满配额（3 条）】'), atQuota)
  assert.ok(atQuota.includes('必须调用 memory_recall 把 limit 调大（最多 20）再检索一次'), atQuota)
  // The accumulated block can exceed one page; it still qualifies.
  assert.ok(plugin.buildRecallExtras(stateAt(5)).includes('【本轮自动回忆已满配额（5 条）】'))
  // Below the quota the block is not "full": no nudge (old sessions stay quiet).
  const belowQuota = plugin.buildRecallExtras(stateAt(2))
  assert.equal(belowQuota, '', 'no extras when the block is below quota')
  // `queryInfo.quota` is null for a non-adaptive turn: fall back to firstGenMax.
  assert.ok(plugin.buildRecallExtras(stateAt(3, { quota: null })).includes('已满配额'))
})

test('buildRecallExtras: adaptive quota wins, <=0 never nudges, and trim is disclosed', () => {
  const fallbackPlugin = new RofmPlugin(makeContext().ctx, { enabled: true, recall: { firstGenMax: 10 } })
  const state = (count, extra = {}) => ({ additions: additionsOf(count), queryInfo: baseQueryInfo(extra) })

  // Tiny adaptive quota overrides the larger configured firstGenMax.
  const adaptive = fallbackPlugin.buildRecallExtras(state(2, { quota: 2 }))
  assert.ok(adaptive.includes('【本轮自动回忆已满配额（2 条）】'), adaptive)

  // The call-site cfg argument is honoured (memoryDir may be session-scoped and
  // so may the recall block config): optional third arg wins over currentConfig.
  const scopedCfg = fallbackPlugin.buildRecallExtras(state(2), undefined, { recall: { firstGenMax: 2 } })
  assert.ok(scopedCfg.includes('【本轮自动回忆已满配额（2 条）】'), scopedCfg)

  // `recall.firstGenMax=0` is the documented recall kill switch: never nudge.
  const killSwitch = new RofmPlugin(makeContext().ctx, { enabled: true, recall: { firstGenMax: 0 } })
  assert.equal(killSwitch.buildRecallExtras(state(5)), '', 'the kill switch suppresses the nudge')
  assert.equal(killSwitch.buildRecallExtras(state(5, { quota: null })), '', 'the kill switch also wins without an adaptive quota')

  // A trimmed block discloses how many entries the window budget dropped.
  const trimmed = fallbackPlugin.buildRecallExtras(state(10), { droppedBlocks: 4 })
  assert.ok(trimmed.includes('【本轮自动回忆已满配额（10 条）】'), trimmed)
  assert.ok(trimmed.includes('另有 4 条因窗口预算被裁掉'), trimmed)
  // Without a trim there is no trim note.
  assert.ok(!fallbackPlugin.buildRecallExtras(state(10)).includes('被裁掉'))
})

test('buildRecallExtras: the quota nudge stays after the v1.5.0 hints', () => {
  const plugin = new RofmPlugin(makeContext().ctx, { enabled: true, recall: { firstGenMax: 2 } })
  const extras = plugin.buildRecallExtras({
    additions: additionsOf(2),
    queryInfo: baseQueryInfo({
      clauses: ['端口配置', '部署时间'],
      tags: { location: ['北京'], person: [], event: [] },
      timeWindows: [{ label: '昨天', from: 1, to: 2 }],
      assistantSaid: { hit: true, phrases: ['你不是说'] },
      clauseInfo: [
        { index: 0, text: '端口配置', quota: 1, hits: 1, status: 'hit', keywords: ['端口'] },
        { index: 1, text: '部署时间', quota: 0, hits: 0, status: 'miss', keywords: ['部署'] },
      ],
      quota: 2,
    }),
  })

  assert.ok(extras.startsWith('## 本轮子问题'), extras)
  assert.ok(extras.includes('【引用助手原话】'), extras)
  assert.ok(extras.includes('【本轮自动回忆已满配额（2 条）】'), extras)
  const order = [
    '## 本轮子问题',
    '- 子问题 2：',
    '【本轮标签过滤】地点=北京',
    '【本轮时间标签过滤】昨天',
    '【引用助手原话】',
    '【本轮自动回忆已满配额',
  ]
  let previous = -1
  for (const needle of order) {
    const index = extras.indexOf(needle)
    assert.ok(index >= 0, `section present: ${needle}`)
    assert.ok(index > previous, `existing hint order kept, ${needle} comes after the previous one`)
    previous = index
  }
})

// ---------------------------------------------------------------------------
// 记忆评分任务 rubric: persons pronoun disambiguation
// ---------------------------------------------------------------------------

test('memory-tasks rubric adds the persons pronoun-disambiguation rule for pending scoring', () => {
  withTempDir((dir) => {
    const memoryDir = path.join(dir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    const now = Date.now()
    // One pending (unscored) folder: the rubric only renders when the judge has
    // actual scoring work to do (same fixture shape as plugin-rules-1.5.0).
    writeFolderFixture(
      memoryDir,
      'mem-pending-160',
      {
        createdAt: now,
        alpha: 0.5,
        beta: 0,
        keywords: [],
        scored: false,
        pendingEra: 'current',
        title: '待评分记忆',
        stats: { messages: 1, chars: 20, tokens: 10 },
      },
      '他昨天说要把端口改成 8080',
    )
    const { session, capture } = startPlugin(memoryDir)
    const text = sectionText(capture, TASKS_SECTION, session)

    assert.ok(text.includes('待评分的新归档记忆'), 'the pending folder is listed (fixture sanity)')
    assert.ok(text.includes('- persons 指代消解（v1.6.0）：'), text.slice(0, 600))
    assert.ok(text.includes('「他/她/TA/那个人/对方」'), 'the pronoun list is named')
    assert.ok(text.includes('先结合本条记忆原文与相邻语境判断指代谁'), 'the judge must resolve from context')
    assert.ok(text.includes('禁止猜测'), 'guessing is forbidden')
    assert.ok(text.includes('同一人的多个称呼都写上'), 'person aliases are written together')
    // v1.6.0 consistency with the `memory_judge` tool description: the v1.5.0 tag
    // rule no longer claims "one canonical name per person"; aliases are written
    // as they appear, and keywords must cover the pronoun-resolved names too.
    assert.ok(text.includes('同一人可能有多个称呼，原文出现几个就都写上'), 'the tag rule accepts several names per person')
    assert.ok(text.includes('keywords 必须覆盖这些名字（含代词消解出的人名）'), 'keywords must cover resolved names too')

    // Position: after the v1.5.0 tag/merge rules, before the keep guidance.
    const indexOf = (needle) => text.indexOf(needle)
    assert.ok(indexOf('- events/locations/persons（可选但建议') < indexOf('- persons 指代消解'), 'tag rule comes before the pronoun rule')
    assert.ok(indexOf('- 事件归并需确认') < indexOf('- persons 指代消解'), 'merge rule comes before the pronoun rule')
    assert.ok(indexOf('- persons 指代消解') < indexOf('无法判断或不需要修改时'), 'keep guidance stays last')

    // The line belongs to the pendingNew branch: with no pending work the rubric
    // (and therefore the pronoun line) is not rendered at all.
    const emptyDir = path.join(dir, 'memory-empty')
    mkdirSync(emptyDir, { recursive: true })
    const { session: idleSession, capture: idleCapture } = startPlugin(emptyDir)
    const idleText = sectionText(idleCapture, TASKS_SECTION, idleSession)
    assert.equal(idleText, '', 'no pending work renders no task block')
    assert.ok(!idleText.includes('指代消解'), 'the pronoun rule only exists in the pendingNew rubric')
  })
})

// ---------------------------------------------------------------------------
// v1.5.4: time citation — archive time is the title, event time is the caliber
// ---------------------------------------------------------------------------

test('v1.5.4 memory-rules: dates cite the event time, the title is the archive time', () => {
  withTempDir((dir) => {
    const { session, capture } = startPlugin(path.join(dir, 'memory'))
    const text = sectionText(capture, RULES_SECTION, session)
    const rule = text.split('\n').find((line) => line.startsWith('- 时间引用：')) || ''
    assert.ok(rule.length > 0, `the v1.5.4 time rule is present:\n${text}`)
    for (const needle of ['归档于 X', '归档时间', '「事件时间」为准', '禁止把归档时间当作事件时间引用']) {
      assert.ok(rule.includes(needle), `rule must mention ${needle}: ${rule}`)
    }
    // Appended after the v1.6.0 rules: the section keeps its stable order and
    // stays compact (it is a system prompt on every request).
    const order = ['多子问题', '同一件事', '冲突', '助手原话', '主动召回', '满额重试', '人物称呼', '时间引用']
    let previous = -1
    for (const needle of order) {
      const index = text.indexOf(needle)
      assert.ok(index >= 0, `rule present: ${needle}`)
      assert.ok(index > previous, `rule order: ${needle} comes after the previous rule`)
      previous = index
    }
    assert.ok(text.length < 1200, `the rules section stays compact (got ${text.length} chars)`)
  })
})

// ---------------------------------------------------------------------------
// v1.5.6: memory-related questions need at least one active recall
// ---------------------------------------------------------------------------

test('v1.5.6 memory-rules: a memory-related question unresolved by auto recall needs one memory_recall', () => {
  withTempDir((dir) => {
    const { session, capture } = startPlugin(path.join(dir, 'memory'))
    const text = sectionText(capture, RULES_SECTION, session)
    const rule = text.split('\n').find((line) => line.startsWith('- 记忆相关问题（v1.5.6）：')) || ''
    assert.ok(rule.length > 0, `the v1.5.6 memory-question rule is present:\n${text}`)
    for (const needle of [
      '只要当前问题需要依赖记忆',
      '自动召回没有直接解决它',
      '至少进行一次主动召回（memory_recall）',
    ]) {
      assert.ok(rule.includes(needle), `rule must mention ${needle}: ${rule}`)
    }
    // The user removed the old prohibitions from this rule (they belong to the
    // v1.6.0 主动召回 rule): pin the deletion so a future edit cannot re-add them.
    for (const removed of ['不得凭印象作答', '不得直接说「没找到」「不记得」', '不得让用户重新说明']) {
      assert.ok(!rule.includes(removed), `the removed prohibition must stay out: ${removed}`)
    }
    // Placement: right after the v1.6.0 active-recall rule, before the full-page
    // retry rule; the doc order stays stable top-down.
    const order = ['主动召回', '记忆相关问题（v1.5.6）', '满额重试', '人物称呼', '时间引用']
    let previous = -1
    for (const needle of order) {
      const index = text.indexOf(needle)
      assert.ok(index >= 0, `rule present: ${needle}`)
      assert.ok(index > previous, `rule order: ${needle} comes after the previous rule`)
      previous = index
    }
    // The section is a system prompt on every request: keep it compact.
    assert.ok(text.length < 1200, `the rules section stays compact (got ${text.length} chars)`)
  })
})
