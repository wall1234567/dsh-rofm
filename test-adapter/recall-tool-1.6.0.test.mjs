/**
 * Adapter-level tests for the v1.6.0 `memory_recall` delta.
 *
 * Covers the delta on top of `recall-tool.test.mjs` + `recall-tool-1.5.0.test.mjs`
 * (both stay the v1.4/v1.5 regression suites):
 *   - `MAX_RECALL_KEYWORDS = 16`: keywords split on whitespace / comma / 顿号 /
 *     semicolon, de-duplicated in order, the first 16 words forwarded and a
 *     non-blocking `warnings` entry when the submission was longer;
 *   - a <= 16-word submission keeps the v1.5.0 engine-facing string (whitespace
 *     collapsed only), so engine matching stays byte-compatible;
 *   - a full page (`found === limit`, or `hasMore`) renders the "raise limit and
 *     retry once" line, and never on a normal/partial page, a miss or a browse;
 *   - the 20-entry ceiling switches that line to `offset` guidance;
 *   - `persons` aliases of one person are OR-ed: the rendered tag line states the
 *     multi-value OR rule, and an unknown person suggests another alias.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_RECALL_KEYWORDS,
  MemoryRecallTool,
  normalizeRecallKeywordArgs,
  normalizeRecallKeywords,
  splitRecallKeywords,
} from '../lib/recall-tool.js'

const SESSION = { id: 'session-recall-1.6.0' }
const exec = (session = SESSION) => ({ agent: { session } })

function makeConfig(overrides = {}) {
  return { enabled: true, recall: { enabled: true }, compress: { enabled: true }, ...overrides }
}

function makeStats(overrides = {}) {
  return {
    userKeywords: [],
    matchedFolders: 0,
    excludedFolders: 0,
    attempts: 0,
    addedFolders: 0,
    addedChars: 0,
    addedTokens: 0,
    contextChars: 120,
    windowTokens: 1000,
    addedPercentOfContext: null,
    addedPercentOfWindow: null,
    byGeneration: {},
    elapsedMs: 1,
    ...overrides,
  }
}

function successResult(additions, statsOverrides = {}, extra = {}) {
  return {
    additions,
    stats: makeStats({ matchedFolders: additions.length, attempts: additions.length, addedFolders: additions.length, ...statsOverrides }),
    warnings: [],
    ...extra,
  }
}

function missResult({ matchedFolders = 0, attempts = 0 } = {}, extra = {}) {
  return { additions: [], stats: makeStats({ matchedFolders, attempts }), warnings: [], ...extra }
}

function makeAddition({ meta: metaOverrides, ...overrides } = {}) {
  const meta = {
    id: 'mem-20260101T000000Z-0001',
    createdAt: 1000,
    alpha: 0.7,
    beta: 3,
    keywords: ['docker', '端口'],
    ...metaOverrides,
  }
  return {
    id: meta.id,
    generation: 1,
    alpha: 0.7,
    beta: 3,
    createdAt: 1000,
    messages: [{ role: 'user', content: '之前说 docker 端口是 8080。' }],
    chars: 60,
    tokens: 30,
    ...overrides,
    meta,
  }
}

/** `count` distinct additions (ids mem-page-1..N) for page-size tests. */
function makePage(count) {
  return Array.from({ length: count }, (_, index) => makeAddition({ meta: { id: `mem-page-${index + 1}` } }))
}

/** Fake engine: every call pops the next queued result (falls back to a miss). */
function makeEngine(...results) {
  const engine = {
    calls: [],
    recall(userText, context, options) {
      engine.calls.push({ userText, context, options })
      return results.length > 0 ? results.shift() : missResult()
    },
  }
  return engine
}

/** Fake plugin exposing exactly the methods the tool is allowed to use. */
function makePlugin({ engine = makeEngine(), cfg = makeConfig(), enabled = true, sessionState = undefined } = {}) {
  const plugin = {
    calls: { currentConfig: 0, toolsSessionEnabled: 0, engineFor: 0, scopedConfig: 0 },
    currentConfig() {
      plugin.calls.currentConfig += 1
      return cfg
    },
    toolsSessionEnabled() {
      plugin.calls.toolsSessionEnabled += 1
      return enabled
    },
    engineFor() {
      plugin.calls.engineFor += 1
      return engine
    },
    scopedConfig(config) {
      plugin.calls.scopedConfig += 1
      return { ...config, scoped: true, memoryDir: '/scoped/memory' }
    },
    contextStats() {
      return { sessionId: 'session-recall-1.6.0', chars: 120, tokens: 40, windowTokens: 1000 }
    },
  }
  if (sessionState !== undefined) plugin.sessionState = () => sessionState
  return plugin
}

function render(tool, args, value) {
  return tool.definition().output.render(args, value)
}

function textOf(content) {
  const block = content.find((entry) => entry.type === 'text')
  return block ? block.text : ''
}

/** The host validates the tool value as lossless JSON; catch undefined/-0 here. */
function assertLosslessJson(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'tool value must be lossless JSON')
}

/** 35 distinct words w1..w35 joined with spaces. */
const MANY_WORDS = Array.from({ length: 35 }, (_, index) => `w${index + 1}`)
const FIRST_SIXTEEN = MANY_WORDS.slice(0, MAX_RECALL_KEYWORDS).join(' ')

// ---------------------------------------------------------------------------
// Requirements 1+2+3 — the model-facing contract
// ---------------------------------------------------------------------------

test('v1.6.0 contract: keyword cap, full-page retry and persons aliases are documented', () => {
  assert.equal(MAX_RECALL_KEYWORDS, 16)
  const definition = new MemoryRecallTool(makePlugin()).definition()
  const description = definition.description

  // Requirement 1: keywords are capped at 16 (query cap; archive may store 30) and the separators are named.
  assert.ok(description.includes('最多 16 个'), description)
  for (const phrase of ['空格', '逗号', '前 16 个']) assert.ok(description.includes(phrase), `description mentions ${phrase}`)

  // Requirement 2: a full page must lead to one larger-quota retry.
  for (const phrase of ['本页已满', '调大', '最多 20', '不要直接放弃']) {
    assert.ok(description.includes(phrase), `description mentions ${phrase}`)
  }

  // Requirement 3: one person may carry several aliases; an alias is not a filter.
  for (const phrase of ['称呼/别名', '不会互相筛选', '拿不准']) {
    assert.ok(description.includes(phrase), `description mentions ${phrase}`)
  }

  const properties = definition.parameters.properties
  assert.ok(properties.keywords.description.includes('最多 16 个'), properties.keywords.description)
  for (const phrase of ['空格', '逗号', '顿号', '分号', '前 16 个']) {
    assert.ok(properties.keywords.description.includes(phrase), `keywords mention ${phrase}`)
  }
  assert.ok(properties.persons.type === 'array')
  for (const phrase of ['称呼/别名', '「或」', '不会互相筛选', '拿不准', '不要只传一个']) {
    assert.ok(properties.persons.description.includes(phrase), `persons mention ${phrase}`)
  }
})

// ---------------------------------------------------------------------------
// Requirement 1 — keyword parsing / normalization
// ---------------------------------------------------------------------------

test('splitRecallKeywords splits on whitespace/comma/顿号/semicolon, de-duplicates and keeps order', () => {
  assert.deepEqual(splitRecallKeywords('docker 端口,部署、灰度；回滚;Docker'), ['docker', '端口', '部署', '灰度', '回滚', 'Docker'])
  // Full-width comma and the ideographic space are separators too.
  assert.deepEqual(splitRecallKeywords('  a，b\u3000c ,, d  '), ['a', 'b', 'c', 'd'])
  // First occurrence wins (order is preserved, not sorted).
  assert.deepEqual(splitRecallKeywords('b a b a c'), ['b', 'a', 'c'])
  assert.deepEqual(splitRecallKeywords(''), [])
  assert.deepEqual(splitRecallKeywords(' , ，、;； '), [])
  assert.throws(() => splitRecallKeywords(42), { message: 'keywords must be a non-empty string' })
  assert.throws(() => splitRecallKeywords(null), { message: 'keywords must be a non-empty string' })
})

test('<= 16 distinct keywords keep the v1.5.0 engine string (whitespace collapsed only)', () => {
  // Commas/phrases stay in the string: the engine matches folder keywords against it.
  assert.equal(normalizeRecallKeywords('  docker  端口 , 部署 '), 'docker 端口 , 部署')
  assert.deepEqual(normalizeRecallKeywordArgs('  docker  端口 , 部署 '), { keywords: 'docker 端口 , 部署', warnings: [] })

  // Exactly at the cap: still no truncation and no warning.
  const thirty = MANY_WORDS.slice(0, MAX_RECALL_KEYWORDS).join(' ')
  assert.equal(normalizeRecallKeywords(thirty), thirty)
  assert.deepEqual(normalizeRecallKeywordArgs(thirty).warnings, [])

  // Duplicates are removed before the cap is applied: 35 tokens, 16 distinct words.
  const duplicated = [...MANY_WORDS.slice(0, MAX_RECALL_KEYWORDS), ...MANY_WORDS.slice(0, 5)].join(' ')
  assert.deepEqual(normalizeRecallKeywordArgs(duplicated).warnings, [], 'only distinct words count against the cap')
  assert.equal(normalizeRecallKeywords(duplicated), duplicated, 'a duplicate-only over-count is forwarded unchanged')

  assert.throws(() => normalizeRecallKeywords(undefined), { message: 'keywords must be a non-empty string' })
  assert.throws(() => normalizeRecallKeywords('   '), { message: 'keywords must be a non-empty string' })
})

test('> 16 distinct keywords are truncated to the first 16 with a non-blocking warning', () => {
  const parsed = normalizeRecallKeywordArgs(MANY_WORDS.join(' '))
  assert.equal(parsed.keywords, FIRST_SIXTEEN)
  assert.equal(parsed.warnings.length, 1)
  assert.ok(parsed.warnings[0].includes('只使用前 16 个关键词'), parsed.warnings[0])
  assert.ok(parsed.warnings[0].includes('共 35 个'), parsed.warnings[0])
  assert.equal(normalizeRecallKeywords(MANY_WORDS.join(' ')), FIRST_SIXTEEN, 'the plain normalizer truncates too')

  // A comma-separated over-long submission is re-joined with spaces (engine form).
  assert.equal(normalizeRecallKeywords(MANY_WORDS.join('，')), FIRST_SIXTEEN)
})

test('a truncated keyword submission still recalls: first 16 words reach the engine, warning is rendered', async () => {
  const engine = makeEngine(successResult([makeAddition()], {}, { warnings: ['引擎提示：示例'] }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const args = { keywords: MANY_WORDS.join(' ') }
  const value = await tool.execute(args, exec())

  assert.equal(engine.calls[0].userText, FIRST_SIXTEEN, 'the engine only sees the first 16 words')
  assert.equal(value.found, 1, 'the recall itself is not blocked')
  assert.ok(
    value.warnings.some((warning) => warning.includes('只使用前 16 个关键词') && warning.includes('共 35 个')),
    JSON.stringify(value.warnings),
  )
  assert.ok(value.warnings.includes('引擎提示：示例'), 'engine warnings are kept alongside the truncation one')
  assertLosslessJson(value)

  const text = textOf(render(tool, args, value))
  assert.ok(text.includes('提示：'), text)
  assert.ok(text.includes('只使用前 16 个关键词'), text)
  assert.ok(text.includes('共 35 个，只显示前 16 个'), 'the header echo shows the words actually used')
})

test('a truncated keyword submission keeps its warning on the miss path too', async () => {
  const engine = makeEngine(missResult())
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: MANY_WORDS.join(' ') }, exec())

  assert.equal(value.found, 0)
  assert.ok(
    value.warnings.some((warning) => warning.includes('只使用前 16 个关键词')),
    JSON.stringify(value.warnings),
  )
  const text = textOf(render(tool, { keywords: MANY_WORDS.join(' ') }, value))
  assert.ok(text.includes('只使用前 16 个关键词'), text)
})

// ---------------------------------------------------------------------------
// Requirement 2 — full page => raise the quota and retry once
// ---------------------------------------------------------------------------

test('a full page (found === limit) renders the raise-limit retry line', async () => {
  const engine = makeEngine(successResult(makePage(3), {}, { page: { offset: 0, limit: 3, hasMore: false } }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.found, 3)
  assert.equal(value.limit, 3)
  assert.equal(value.hasMore, false)

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('【本页已满：limit=3，已返回 3 条】'), text)
  assert.ok(text.includes('如果其中没有目标记忆，必须把 limit 调大（最多 20）再检索一次，不要直接放弃。'), text)
  assert.ok(!text.includes('还有更多匹配'), 'no pagination line on the only page')
  // v1.5.4: the full-page hint belongs to the preamble — before the first entry.
  assert.ok(text.indexOf('【本页已满') < text.indexOf('### 回忆 1'), 'the hint sits before the first entry')
  assert.ok(text.indexOf('【本页已满') < text.indexOf('提示：以上是更早对话'), 'the hint comes before the trust note')
})

test('hasMore renders the retry line once, keeping the offset guide', async () => {
  const engine = makeEngine(successResult(makePage(2), {}, { page: { offset: 0, limit: 2, hasMore: true } }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker', limit: 2 }, exec())
  assert.equal(value.hasMore, true)

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('【本页已满：limit=2，已返回 2 条，且还有更多】'), text)
  assert.ok(text.includes('还有更多匹配：可用 offset=2 继续翻页。'), 'the pagination guide is kept')
  assert.ok(text.includes('必须把 limit 调大（最多 20）再检索一次'), text)
  assert.equal(text.split('【本页已满').length - 1, 1, 'the hint is never duplicated')
})

test('a partial page renders no retry line', async () => {
  const engine = makeEngine(successResult([makeAddition()]))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.found, 1)
  assert.equal(value.limit, 3)

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(!text.includes('本页已满'), text)
  assert.ok(!text.includes('必须把 limit 调大'), text)
})

test('a miss renders the miss hint only — no full-page retry line', async () => {
  const engine = makeEngine(missResult())
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: '完全无关词' }, exec())
  assert.equal(value.found, 0)

  const text = textOf(render(tool, { keywords: '完全无关词' }, value))
  assert.ok(!text.includes('本页已满'), text)
  assert.ok(text.includes('没有匹配到任何记忆'), text)
})

test('browse mode never renders the retry line even when the page is full', async () => {
  const timeWindow = { from: Date.UTC(2026, 9, 30), to: Date.UTC(2026, 10, 2), level: 'day', timezone: 'UTC' }
  const engine = makeEngine(successResult(makePage(3), {}, { timeWindow }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ timeFrom: '2026-10-31' }, exec())
  assert.equal(value.mode, 'browse')
  assert.equal(value.found, 3)
  assert.equal(value.limit, 3, 'the page is exactly full')

  const text = textOf(render(tool, { timeFrom: '2026-10-31' }, value))
  assert.ok(!text.includes('本页已满'), text)
  assert.ok(!text.includes('必须把 limit 调大'), text)
  assert.ok(text.includes('纯时间浏览'), text)
})

test('at the 20-entry ceiling the retry line switches to offset guidance', async () => {
  const engine = makeEngine(successResult(makePage(20), {}, { page: { offset: 0, limit: 20, hasMore: true } }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker', limit: 20 }, exec())
  assert.equal(value.found, 20)
  assert.equal(value.limit, 20)

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('【本页已满：limit=20，已返回 20 条，且还有更多】'), text)
  assert.ok(text.includes('已到单次返回上限（20 条）'), text)
  assert.ok(text.includes('必须用 offset 翻页或换关键词再检索一次'), text)
  assert.ok(!text.includes('把 limit 调大'), 'raising limit is impossible at the ceiling')
})

// ---------------------------------------------------------------------------
// Requirement 3 — persons aliases: OR between labels, alias hint on unknown
// ---------------------------------------------------------------------------

const ALIAS_TAG_INFO = {
  status: 'partial',
  requested: { location: [], person: ['周岑', '小周', '岑哥'], event: [] },
  matched: { location: [], person: [{ label: '周岑', count: 1 }], event: [] },
  unknown: [
    { kind: 'person', label: '小周' },
    { kind: 'person', label: '岑哥' },
  ],
  enforced: true,
}

test('multi-value person aliases state the OR rule and suggest another alias', async () => {
  const engine = makeEngine(successResult([makeAddition()], {}, { tagInfo: ALIAS_TAG_INFO }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const args = { keywords: 'docker', persons: ['周岑', '小周', '岑哥'] }
  const value = await tool.execute(args, exec())
  assert.deepEqual(value.tagInfo.unknown.map((item) => item.label), ['小周', '岑哥'])
  assertLosslessJson(value)

  const text = textOf(render(tool, args, value))
  assert.ok(text.includes('标签条件：人物「周岑」「小周」「岑哥」'), text)
  assert.ok(text.includes('（同类多值为「或」，不会互相筛选）'), text)
  assert.ok(text.includes('未知标签：人物「小周」、人物「岑哥」'), text)
  assert.ok(text.includes('未知人物可换用同一人的其他称呼/别名再试'), text)
})

test('a single-value tag filter does not render the OR note', async () => {
  const tagInfo = {
    status: 'exact',
    requested: { location: ['北京'], person: [], event: [] },
    matched: { location: [{ label: '北京', count: 1 }], person: [], event: [] },
    unknown: [],
    enforced: true,
  }
  const engine = makeEngine(successResult([makeAddition()], {}, { tagInfo }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker', locations: ['北京'] }, exec())
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('标签条件：地点「北京」'), text)
  assert.ok(!text.includes('同类多值为「或」'), 'a single label needs no OR note')
  assert.ok(!text.includes('未知人物'), text)
})

test('a tag miss with an unknown person also suggests trying another alias', async () => {
  const tagInfo = {
    status: 'unknown',
    requested: { location: [], person: ['岑哥'], event: [] },
    matched: { location: [], person: [], event: [] },
    unknown: [{ kind: 'person', label: '岑哥' }],
    enforced: true,
  }
  const engine = makeEngine(missResult({ matchedFolders: 2 }, { missType: 'tag', tagInfo }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker', persons: ['岑哥'] }, exec())
  assert.equal(value.missType, 'tag')
  assert.equal(value.misses, undefined, 'a tag miss never counts as a strike')

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('不符合标签条件'), text)
  assert.ok(text.includes('这些标签还没有任何记忆：人物「岑哥」'), text)
  assert.ok(text.includes('人物可能有别的称呼/别名，可换一个称呼再试'), text)
  assert.ok(!text.includes('本页已满'), 'a constraint miss is not a full page')
})
