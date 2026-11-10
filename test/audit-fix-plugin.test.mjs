/**
 * v1.5.0 audit-fix regressions for the adapter wiring (fix round).
 *
 * Covers the defects the independent audit found in `lib/plugin.js` /
 * `lib/recall-tool.js` / the docs:
 *
 *   - F-05-01: the `记忆评分任务` section must stay within
 *     `min(scoring.taskMaxTokens, windowTokens * scoring.taskBudgetPercent%)`
 *     even in the worst case with the 1.5.0 「已有事件标签」 list (24 distinct
 *     max-length labels) and long pending summaries;
 *   - F-LEAD-03: the task-block rubric keeps exactly one multi-event `events`
 *     rule + one `events/locations/persons` rule (the legacy single-event
 *     `event（可选但建议）` line is gone);
 *   - F-04-06: after the block-budget trim the per-clause note must not claim
 *     more memories than the block actually carries, and the trim must be
 *     disclosed with a 「预算/裁剪」 notice;
 *   - F-04-07: a clause without candidates says 「未找到相关记忆」 (the wording
 *     CHANGELOG/README/SPEC promise) — the `no-keywords` / `no-slot` branches
 *     are gone;
 *   - F-05-02: docs/SPEC.md no longer promises the v1.4.1 silent same-batch
 *     merge, README's old same-batch bullet is updated, CHANGELOG lists the
 *     audit-fix round.
 *
 * These tests use the same fake-host mock contract as the other adapter tests:
 * a real `RofmPlugin` over a hermetic temp memory dir.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RofmPlugin } from '../lib/plugin.js'
import { estimateTokens } from '../engine/index.js'

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const clone = (value) => JSON.parse(JSON.stringify(value))

class FakeSession {
  constructor({ contextWindow = 20000, id = 'session-audit-fix' } = {}) {
    this.id = id
    this.header = { origin: 'main' }
    this.windowTokens = contextWindow
    this.events = []
    this.nodes = []
    this.replaceGeneration = 0
    this.contentGeneration = 0
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
    const event = { type, seq, time: Date.now(), data: clone(data) }
    if (SURFACE_TYPES.has(type)) {
      assert.ok(options.surfaceOp === 'append', 'audit-fix fixtures only append surface nodes')
      this.events.push(event)
      this.nodes.push(seq)
      this.contentGeneration += 1
      return event
    }
    this.events.push(event)
    return event
  }
}

const userMessage = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** Minimal fake DSH context: prompt sections + tools + a static token meter. */
function makeContext() {
  const capture = { sections: [], tools: [], logs: [] }
  const toolsService = {
    register(definition) {
      capture.tools.push({ definition, disposed: false })
      return () => {}
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
      section(options) {
        capture.sections.push(options)
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
      if (name === 'tools') return toolsService
      return undefined
    },
  }
  ctx.tools = toolsService
  return { ctx, capture }
}

function sectionOf(capture, name) {
  return capture.sections.find((section) => section.name === name)
}

const tasksText = (capture, session) => sectionOf(capture, 'dsh-rofm:memory-tasks')?.text({ agent: { session } }) ?? ''
const recallText = (capture, session) => sectionOf(capture, 'dsh-rofm:recall')?.text({ agent: { session } }) ?? ''
const recalledEntryCount = (text) => (String(text).match(/^### 回忆/gm) ?? []).length

function withTempDir(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-audit-plugin-'))
    try {
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

/** Write one memory folder (context.json + meta.json) and its index entry. */
function writeFolderFixture(memoryDir, id, options = {}) {
  const {
    alpha = 0.5,
    beta = 0,
    keywords = ['fixture'],
    text = 'FIXTURE-MEMORY-CONTENT',
    createdAt = Date.now(),
    scored = true,
    rescorePending = false,
    events,
  } = options
  const dir = path.join(memoryDir, id)
  mkdirSync(dir, { recursive: true })
  const messages = [{ role: 'user', content: text }]
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify({ version: 1, id, createdAt, messages }))
  const optionalTags = Array.isArray(events) ? { events } : {}
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      version: 1,
      id,
      createdAt,
      alpha,
      beta,
      keywords,
      title: text.slice(0, 40),
      scored,
      rescorePending,
      pendingSince: scored ? undefined : createdAt,
      alphaSource: scored ? 'heuristic' : 'pending',
      betaSource: scored ? 'default' : 'pending',
      keywordsSource: scored ? 'heuristic' : 'pending',
      stats: { messages: messages.length, chars: text.length, tokens: 10 },
      ...optionalTags,
    }),
  )
  let index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
  if (existsSync(path.join(memoryDir, 'index.json'))) {
    try {
      index = JSON.parse(readFileSync(path.join(memoryDir, 'index.json'), 'utf8'))
    } catch {
      index = { version: 1, updatedAt: Date.now(), nextCounter: 1, folders: [] }
    }
  }
  index.folders = (index.folders ?? []).filter((folder) => folder.id !== id)
  index.folders.push({
    id,
    createdAt,
    alpha,
    beta,
    keywords,
    chars: text.length,
    tokens: 10,
    messageCount: 1,
    title: text.slice(0, 40),
    scored,
    rescorePending,
    ...optionalTags,
  })
  writeFileSync(path.join(memoryDir, 'index.json'), JSON.stringify(index))
}

function startPlugin(memoryDir, { contextWindow = 20000, patch = {} } = {}) {
  const session = new FakeSession({ contextWindow })
  const { ctx, capture } = makeContext()
  const plugin = new RofmPlugin(ctx, {
    enabled: true,
    storage: { dir: memoryDir, perSession: false },
    compress: { contextWindowTokens: 0, allowSmallWindow: true, preStepEnabled: false },
    scoring: { includeLegacy: true, taskMaxTokens: 12000, taskBudgetPercent: 15 },
    ...patch,
  })
  plugin.start()
  return { session, ctx, capture, plugin }
}

// ---------------------------------------------------------------------------
// F-05-01: task-block budget invariant (worst case with the event-label list)
// ---------------------------------------------------------------------------

const EVENT_HEADER = '### 已有事件标签（同一事件请复用，不要另造近义标签）'
const eventLabel = (index, length = 60) => `${'事'.repeat(length - 4)}${String(index).padStart(4, '0')}`

function buildBudgetStore(label, { pending = 30, labelLength = 60 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `dsh-rofm-budget-${label}-`))
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  for (let index = 0; index < 24; index += 1) {
    const holders = 1 + (index % 3)
    for (let copy = 0; copy < holders; copy += 1) {
      writeFolderFixture(memoryDir, `mem-tag-${String(index).padStart(2, '0')}-${copy}`, {
        events: [eventLabel(index, labelLength)],
        text: `event label holder ${index}/${copy}`,
      })
    }
  }
  for (let index = 0; index < pending; index += 1) {
    writeFolderFixture(memoryDir, `mem-pend-${String(index).padStart(3, '0')}`, {
      scored: false,
      keywords: ['部署', 'docker', '端口'],
      createdAt: Date.now() - 60_000 - index,
      text: `PENDING-${String(index).padStart(3, '0')} ${'甲'.repeat(200)}`,
    })
  }
  return { dir, memoryDir }
}

async function measureBlock({ windowTokens, taskMaxTokens = 12000, taskBudgetPercent = 15, showExisting = true, labelLength = 60, scratch }) {
  const { session, capture } = startPlugin(scratch.memoryDir, {
    contextWindow: windowTokens,
    patch: {
      scoring: { includeLegacy: true, taskMaxTokens, taskBudgetPercent },
      event: { showExisting, showExistingLimit: 24, maxLabelLength: labelLength },
    },
  })
  const text = tasksText(capture, session)
  const budget = Math.min(taskMaxTokens, (windowTokens * taskBudgetPercent) / 100)
  return { text, budget, tokens: estimateTokens(text) }
}

test('F-05-01: worst-case task block (24 distinct 60-char event labels) stays within budget', withTempDir(async (dir) => {
  for (const windowTokens of [20000, 12000, 8000]) {
    const scratch = buildBudgetStore(`w${windowTokens}`)
    try {
      const result = await measureBlock({ windowTokens, scratch })
      assert.ok(
        result.tokens <= result.budget,
        `window=${windowTokens}: estimateTokens(block)=${result.tokens} must be <= budget=${result.budget}`,
      )
      if (windowTokens === 20000) {
        // The reuse list is shown when it fits — and the header must stay intact.
        assert.ok(result.text.includes(EVENT_HEADER), 'the event-label reuse list is rendered when the budget allows it')
        const labelLine = result.text.split('\n')[result.text.split('\n').indexOf(EVENT_HEADER) + 1] ?? ''
        assert.equal(labelLine.split('、').length, 24, 'all 24 long labels are listed')
      }
    } finally {
      rmSync(scratch.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}))

test('F-05-01: showExisting=true/false, maxLabelLength=200 and taskMaxTokens caps all stay bounded', withTempDir(async () => {
  const scratch = buildBudgetStore('variants', { labelLength: 200 })
  try {
    // maxLabelLength=200 amplification (validated 1..200) on an 8k window.
    const longLabels = await measureBlock({ windowTokens: 8000, labelLength: 200, scratch })
    assert.ok(longLabels.tokens <= longLabels.budget, `maxLabelLength=200: ${longLabels.tokens} <= ${longLabels.budget}`)

    // Control: without the label list the block must also stay bounded.
    const noLabels = await measureBlock({ windowTokens: 8000, showExisting: false, scratch })
    assert.ok(noLabels.tokens <= noLabels.budget, `showExisting=false: ${noLabels.tokens} <= ${noLabels.budget}`)
    assert.ok(!noLabels.text.includes(EVENT_HEADER), 'showExisting=false removes the reuse list')
  } finally {
    rmSync(scratch.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}))

test('F-05-01: the absolute scoring.taskMaxTokens cap binds and the block degrades loudly', withTempDir(async () => {
  const scratch = buildBudgetStore('caps')
  try {
    for (const taskMaxTokens of [1200, 1000, 900]) {
      const result = await measureBlock({ windowTokens: 20000, taskMaxTokens, taskBudgetPercent: 100, scratch })
      assert.ok(
        result.tokens <= result.budget,
        `taskMaxTokens=${taskMaxTokens}: ${result.tokens} <= ${result.budget}`,
      )
      assert.ok(result.text.includes('任务区块预算不足'), 'a too-small budget degrades to the bounded compact notice')
    }
  } finally {
    rmSync(scratch.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}))

// ---------------------------------------------------------------------------
// F-LEAD-03: rubric has no duplicated/legacy single-event line
// ---------------------------------------------------------------------------

test('F-LEAD-03: the task-block rubric keeps one multi-event rule + one tag rule (no legacy single-event line)', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFolderFixture(memoryDir, 'mem-pend-0001', {
    scored: false,
    keywords: ['部署', 'docker', '端口'],
    createdAt: Date.now() - 60_000,
    text: `PENDING-0001 ${'甲'.repeat(200)}`,
  })
  const { session, capture } = startPlugin(memoryDir)
  const text = tasksText(capture, session)
  assert.ok(text.includes('- events（可选但建议，可多个）'), 'the multi-event rule stays')
  assert.ok(text.includes('- events/locations/persons（可选但建议）'), 'the combined tag rule stays')
  assert.ok(!text.includes('- event（可选但建议）'), 'the legacy single-event rule is deleted (F-LEAD-03)')
  assert.equal((text.match(/可选但建议/g) ?? []).length, 2, 'exactly two tag-rule lines remain')
  assert.ok(text.includes('一条记忆可以属于多个事件'), 'the multi-event rule states multi-event')
  assert.ok(text.includes('events 可多个'), 'the combined rule also states multi-event')
  const indexOf = (needle) => text.indexOf(needle)
  assert.ok(indexOf('- events（可选但建议') < indexOf('- events/locations/persons（可选但建议）'), 'rules are ordered')
  assert.ok(indexOf('- events/locations/persons（可选但建议）') < indexOf('无法判断或不需要修改时'), 'keep guidance stays last')
}))

// ---------------------------------------------------------------------------
// F-04-06 / F-04-07: trimmed block reports real counts + trim notice + wording
// ---------------------------------------------------------------------------

test('F-04-06/F-04-07: buildRecallExtras recounts clauses against the injected block and discloses the trim', withTempDir(async () => {
  const plugin = new RofmPlugin(makeContext().ctx, { enabled: true })
  const state = {
    additions: [
      { id: 'mem-a1', meta: { keywords: ['端口', 'docker'] } },
      { id: 'mem-b1', meta: { keywords: ['迁移', '数据库'] } },
    ],
    queryInfo: {
      clauses: ['端口配置', '数据库迁移', '量子计算'],
      tags: { location: [], person: [], event: [] },
      timeWindows: [],
      assistantSaid: { hit: false, phrases: [] },
      clauseInfo: [
        { index: 0, text: '端口配置', quota: 1, hits: 6, status: 'hit', keywords: ['端口'] },
        { index: 1, text: '数据库迁移', quota: 1, hits: 4, status: 'hit', keywords: ['迁移'] },
        { index: 2, text: '量子计算', quota: 0, hits: 0, status: 'no-keywords', keywords: [] },
      ],
    },
  }
  const extras = plugin.buildRecallExtras(state, { droppedBlocks: 5 })
  assert.ok(extras.includes('子问题 1：端口配置 → 已找到 1 条相关记忆'), extras)
  assert.ok(extras.includes('子问题 2：数据库迁移 → 已找到 1 条相关记忆'), extras)
  assert.ok(!extras.includes('已找到 6 条相关记忆'), 'a clause must not claim more hits than the block carries')
  assert.ok(!extras.includes('已找到 4 条相关记忆'), 'a clause must not claim more hits than the block carries')
  assert.ok(extras.includes('子问题 3：量子计算 → 未找到相关记忆'), 'F-04-07 wording: no-candidate clause says 未找到相关记忆')
  assert.ok(!extras.includes('没有可用关键词'), 'the no-keywords wording is gone (F-04-07)')
  assert.ok(!extras.includes('受本轮配额限制未检索'), 'the dead no-slot branch is gone (F-04-07)')
  assert.match(extras, /裁剪/, 'a trimmed block discloses the trim (F-04-06)')

  // The optional engine extension `clauseInfo[i].ids` is preferred when present.
  const withIds = plugin.buildRecallExtras(
    {
      ...state,
      queryInfo: {
        ...state.queryInfo,
        clauseInfo: [
          { index: 0, text: '端口配置', quota: 1, hits: 6, status: 'hit', keywords: ['端口'], ids: ['mem-a1', 'mem-gone'] },
          { index: 1, text: '数据库迁移', quota: 1, hits: 4, status: 'hit', keywords: ['迁移'], ids: ['mem-b1'] },
          { index: 2, text: '量子计算', quota: 0, hits: 0, status: 'none', keywords: [] },
        ],
      },
    },
    { droppedBlocks: 3 },
  )
  assert.ok(withIds.includes('子问题 1：端口配置 → 已找到 1 条相关记忆'), withIds)
  assert.ok(withIds.includes('子问题 2：数据库迁移 → 已找到 1 条相关记忆'), withIds)
}))

test('F-04-06: end-to-end automatic recall on a tiny window counts only the injected entries', withTempDir(async (dir) => {
  const memoryDir = path.join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  for (let index = 0; index < 20; index += 1) {
    writeFolderFixture(memoryDir, `mem-a-${String(index).padStart(2, '0')}`, {
      alpha: 0.9,
      keywords: ['部署', 'docker', '端口', '参数'],
      createdAt: Date.now() - 10 * 86_400_000 + index * 1000,
      // Each folder's archived chars must be large enough that 20 candidates
      // exceed the tiny window's block budget (10% of 1000 tokens ≈ 400 chars).
      text: `部署 docker 端口参数 ${index} ${'甲'.repeat(240)}`,
    })
  }
  for (let index = 0; index < 10; index += 1) {
    writeFolderFixture(memoryDir, `mem-b-${String(index).padStart(2, '0')}`, {
      alpha: 0.9,
      keywords: ['数据库', '迁移'],
      createdAt: Date.now() - 5 * 86_400_000 + index * 1000,
      text: `数据库迁移最终方案 ${index} ${'乙'.repeat(240)}`,
    })
  }
  const { session, capture, plugin } = startPlugin(memoryDir, { contextWindow: 1000 })
  const message = userMessage('u-budget-trim', '部门那次部署 docker 的端口参数到底是多少？数据库迁移最后的参数编号是什么？')
  session.append('user/message', message, { surfaceOp: 'append' })
  plugin.onInboxInserted({ agent: { session }, message })

  const block = recallText(capture, session)
  const entries = recalledEntryCount(block)
  assert.ok(entries >= 1 && entries < 20, `the tiny window must trim the 20-entry page (got ${entries})`)
  const clauseLines = block.split('\n').filter((line) => line.startsWith('- 子问题'))
  assert.ok(clauseLines.length >= 2, block)
  const claimed = Math.max(0, ...clauseLines.map((line) => Number((line.match(/已找到 (\d+) 条/) ?? [])[1]) || 0))
  assert.ok(claimed <= entries, `per-clause claim ${claimed} must not exceed the injected ${entries} entries`)
  assert.match(block, /裁剪|预算/, 'the trimmed block carries a budget/trim notice (no silent trim)')
  for (const line of clauseLines) {
    assert.ok(!line.includes('没有可用关键词'), line)
    assert.ok(!line.includes('受本轮配额限制未检索'), line)
  }
}))

// ---------------------------------------------------------------------------
// F-05-02: docs semantics (SPEC / README / CHANGELOG)
// ---------------------------------------------------------------------------

test('F-05-02: SPEC no longer promises the v1.4.1 silent same-batch merge', () => {
  const spec = readFileSync(path.join(REPO_DIR, 'docs/SPEC.md'), 'utf8')
  const offending = spec.split('\n').filter((line) => line.includes('eventStats.merged'))
  assert.deepEqual(offending, [], 'SPEC must not promise `eventStats.merged ≥ 1` for the default 1.5.0 behaviour')
  assert.ok(spec.includes('**v1.4.1 (D-02) / v1.5.0**'), 'the D-02 section is updated')
  assert.ok(/no\s+longer merges similar labels by default/.test(spec), 'the default is “no silent merge”')
  assert.ok(spec.includes('mergeRequiresApproval: false'), 'the rollback (silent merge) is documented')
  assert.ok(spec.includes('F-05-01'), 'the task-block budget fix is documented')
})

test('F-05-02: README same-batch bullet and CHANGELOG audit-fix section are updated', () => {
  const readme = readFileSync(path.join(REPO_DIR, 'README.md'), 'utf8')
  assert.ok(!readme.includes('在同一批里会归并成 1 个标签'), 'the stale v1.4.1 same-batch merge bullet is updated')
  assert.ok(readme.includes('同样不再静默归并'), 'README explains the 1.5.0 same-batch behaviour')

  const changelog = readFileSync(path.join(REPO_DIR, 'CHANGELOG.md'), 'utf8')
  assert.ok(changelog.includes('### 修复（1.5.0 审计缺陷修复）'), 'CHANGELOG has the audit-fix section')
  for (const id of ['F-05-01', 'F-LEAD-03', 'F-04-06', 'F-04-07', 'F-04-04']) {
    assert.ok(changelog.includes(id), `CHANGELOG must name ${id}`)
  }
  assert.ok(changelog.includes('test/audit-fix-plugin.test.mjs'), 'CHANGELOG lists the new regression test')
})
