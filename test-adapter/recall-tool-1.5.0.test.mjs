/**
 * Adapter-level tests for the v1.5.0 `memory_recall` surface.
 *
 * Covers the delta on top of `recall-tool.test.mjs` (which stays the v1.4.0
 * regression suite):
 *   - `MAX_RECALL_LIMIT = 20` (clamp 1..20, default 3 unchanged);
 *   - new parameters `locations` / `persons` / `events` / `timeText` /
 *     `assistantSaid` and their `engine.recall` pass-through (including string
 *     submissions and `event`+`events` coexistence);
 *   - `MISSING_QUERY_ERROR` now accepts "any one filter" and assistantSaid alone
 *     is still not a query;
 *   - `tagInfo` / `timeTagInfo` / `clauseInfo` / `assistantInfo` / `assistantSaid`
 *     result pass-through and model-facing rendering;
 *   - `missType='tag' | 'time-tag'` never counts as a strike;
 *   - one real-engine integration test proving the new options reach the tag and
 *     time-tag indexes (temporary memory dir only, no real memory/).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryEngine, detectQueryTimes, writeFolder } from '../engine/index.js'
import {
  ASSISTANT_SAID_NOTE,
  DEFAULT_RECALL_LIMIT,
  DISABLED_HINT,
  MAX_RECALL_LIMIT,
  MemoryRecallTool,
  MISSING_QUERY_ERROR,
  MISS_WARNING,
  normalizeClauseInfo,
  normalizeTagInfo,
  normalizeTagListArg,
  normalizeTimeTagInfo,
  normalizeTimeTextArg,
} from '../lib/recall-tool.js'

const SESSION = { id: 'session-recall-1.5.0' }
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

/**
 * Fake plugin exposing exactly the methods the tool is allowed to use.
 * `queryInfo` (v1.5.0) becomes the optional `currentQueryInfo(session)` hook.
 */
function makePlugin({ engine = makeEngine(), cfg = makeConfig(), enabled = true, sessionState = undefined, queryInfo = undefined } = {}) {
  const plugin = {
    calls: { currentConfig: 0, toolsSessionEnabled: 0, engineFor: 0, scopedConfig: 0, queryInfo: 0 },
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
      return { sessionId: 'session-recall-1.5.0', chars: 120, tokens: 40, windowTokens: 1000 }
    },
  }
  if (sessionState !== undefined) plugin.sessionState = () => sessionState
  if (queryInfo !== undefined) {
    plugin.currentQueryInfo = (session) => {
      plugin.calls.queryInfo += 1
      return typeof queryInfo === 'function' ? queryInfo(session) : queryInfo
    }
  }
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

// ---------------------------------------------------------------------------
// Definition contract (v1.5.0 delta)
// ---------------------------------------------------------------------------

test('v1.5.0 contract: limit ceiling 20, new parameters, result fields and missType enum', () => {
  const tool = new MemoryRecallTool(makePlugin())
  const definition = tool.definition()

  assert.equal(MAX_RECALL_LIMIT, 20)
  assert.equal(DEFAULT_RECALL_LIMIT, 3)

  const properties = definition.parameters.properties
  assert.deepEqual(Object.keys(properties).sort(), [
    'assistantSaid',
    'event',
    'events',
    'granularity',
    'keywords',
    'limit',
    'locations',
    'offset',
    'persons',
    'timeFrom',
    'timeText',
    'timeTo',
  ])
  assert.ok(properties.limit.description.includes('1~20'), properties.limit.description)
  assert.ok(properties.limit.description.includes('20'), properties.limit.description)
  for (const name of ['locations', 'persons', 'events']) {
    assert.equal(properties[name].type, 'array', `${name} is an array parameter`)
    assert.deepEqual(properties[name].items, { type: 'string' })
  }
  assert.ok(properties.events.description.includes('合并'), 'events documents the event+events merge')
  assert.ok(properties.event.description.includes('events'), 'event points at the events array')
  assert.equal(properties.timeText.type, 'string')
  for (const phrase of ['下周二', '昨天']) assert.ok(properties.timeText.description.includes(phrase), phrase)
  assert.equal(properties.assistantSaid.type, 'boolean')
  assert.ok(properties.assistantSaid.description.includes('你说过'), properties.assistantSaid.description)

  // Model-facing description documents the new filters and the 20-entry page.
  for (const phrase of ['20', 'locations', 'persons', 'events', 'timeText', 'assistantSaid', '标签']) {
    assert.ok(definition.description.includes(phrase), `description must mention ${phrase}`)
  }

  const output = definition.output.schema.properties
  for (const name of ['tagInfo', 'timeTagInfo', 'clauseInfo', 'assistantInfo', 'assistantSaid']) {
    assert.ok(name in output, `output schema documents ${name}`)
  }
  assert.equal(output.tagInfo.type, 'object')
  assert.equal(output.timeTagInfo.type, 'object')
  assert.equal(output.clauseInfo.type, 'array')
  assert.equal(output.assistantInfo.type, 'object')
  assert.equal(output.assistantSaid.type, 'boolean')
  assert.ok(output.missType.description.includes("'tag'"), output.missType.description)
  assert.ok(output.missType.description.includes("'time-tag'"), output.missType.description)
})

// ---------------------------------------------------------------------------
// limit ceiling
// ---------------------------------------------------------------------------

test('limit 20 is accepted; 21 / 999 clamp to 20 and the clamped value reaches the engine', async () => {
  const additions = Array.from({ length: 25 }, (_, index) => makeAddition({ meta: { id: `mem-${index}` } }))
  const engine = makeEngine(
    successResult(additions),
    successResult(additions),
    successResult(additions),
    successResult(additions),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const twenty = await tool.execute({ keywords: 'docker', limit: 20 }, exec())
  assert.equal(twenty.found, 20, 'v1.5.0 allows a 20-entry page')
  assert.equal(engine.calls[0].options.limit, 20)

  const over = await tool.execute({ keywords: 'docker', limit: 21 }, exec())
  assert.equal(over.found, 20, '21 clamps down to 20')
  assert.equal(engine.calls[1].options.limit, 20)

  const huge = await tool.execute({ keywords: 'docker', limit: 999 }, exec())
  assert.equal(huge.found, 20)
  assert.equal(engine.calls[2].options.limit, 20)

  const byDefault = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(byDefault.found, 3, 'the default stays 3')
  assert.equal(engine.calls[3].options.limit, 3)
})

// ---------------------------------------------------------------------------
// New filters → engine.recall pass-through
// ---------------------------------------------------------------------------

test('locations/persons/events/timeText are forwarded to engine.recall', async () => {
  const engine = makeEngine(successResult([makeAddition()]))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute(
    {
      keywords: 'docker',
      locations: ['北京', '家'],
      persons: ['小明'],
      events: ['日本旅行', '大阪旅行'],
      timeText: '下周二',
    },
    exec(),
  )

  const options = engine.calls[0].options
  assert.deepEqual(options.locations, ['北京', '家'])
  assert.deepEqual(options.persons, ['小明'])
  assert.deepEqual(options.events, ['日本旅行', '大阪旅行'])
  assert.equal(options.timeText, '下周二')
  assert.equal(options.event, undefined, 'no single event was given')
  assert.equal(options.paginate, true, 'a keyword recall keeps the fair pagination path')
  assert.equal(engine.calls[0].userText, 'docker')
  assertLosslessJson(value)
})

test('a string submission is split into labels exactly like the engine tag query', async () => {
  const engine = makeEngine(successResult([makeAddition()]))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  await tool.execute(
    {
      keywords: 'docker',
      locations: '北京、家',
      persons: '小明 小红',
      events: '日本旅行, 大阪旅行',
      timeText: '  下周二  ',
    },
    exec(),
  )

  const options = engine.calls[0].options
  assert.deepEqual(options.locations, ['北京', '家'])
  assert.deepEqual(options.persons, ['小明', '小红'])
  assert.deepEqual(options.events, ['日本旅行', '大阪旅行'])
  assert.equal(options.timeText, '下周二', 'timeText is trimmed')
})

test('event and events are both forwarded (the engine merges them into an OR-set)', async () => {
  const engine = makeEngine(successResult([makeAddition()]), successResult([makeAddition()]), successResult([makeAddition()]))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  await tool.execute({ keywords: 'docker', event: '日本旅行', events: ['日本出差'] }, exec())
  assert.equal(engine.calls[0].options.event, '日本旅行', 'the legacy string is still forwarded')
  assert.deepEqual(engine.calls[0].options.events, ['日本出差'], 'the engine merges event+events; the adapter keeps both')

  // events alone: same call shape, no legacy `event` option.
  await tool.execute({ keywords: 'docker', events: ['日本旅行', '大阪旅行'] }, exec())
  assert.equal(engine.calls[1].options.event, undefined)
  assert.deepEqual(engine.calls[1].options.events, ['日本旅行', '大阪旅行'])

  // events-only browse (no keywords): a lookup, not a paginated recall.
  const browse = await tool.execute({ events: ['日本旅行', '大阪旅行'] }, exec())
  assert.equal(engine.calls[2].userText, '')
  assert.equal(engine.calls[2].options.paginate, undefined, 'browse never opts into pagination')
  assert.equal(browse.mode, 'browse')
})

test('each v1.5.0 filter is a valid query on its own (browse, no keywords)', async () => {
  const cases = [{ locations: ['北京'] }, { persons: ['小明'] }, { events: ['日本旅行'] }, { timeText: '下周二' }]
  const engine = makeEngine(...cases.map(() => successResult([makeAddition()])))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  for (let index = 0; index < cases.length; index += 1) {
    const value = await tool.execute(cases[index], exec())
    assert.equal(engine.calls[index].userText, '', `${JSON.stringify(cases[index])} sends no keyword text`)
    assert.equal(value.mode, 'browse')
    assert.equal(value.found, 1)
    assertLosslessJson(value)
  }
})

test('invalid multi-value filter types are parameter errors before any engine call', async () => {
  const engine = makeEngine()
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  await assert.rejects(tool.execute({ keywords: 'docker', locations: 42 }, exec()), {
    message: 'locations must be a string or an array of strings',
  })
  await assert.rejects(tool.execute({ keywords: 'docker', persons: {} }, exec()), {
    message: 'persons must be a string or an array of strings',
  })
  await assert.rejects(tool.execute({ keywords: 'docker', events: ['日本旅行', 42] }, exec()), {
    message: 'events must be a string or an array of strings',
  })
  assert.equal(engine.calls.length, 0, 'the engine is never called with an invalid filter')
})

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

test('MISSING_QUERY_ERROR: any one filter is enough, assistantSaid alone is not', async () => {
  const engine = makeEngine()
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  for (const args of [
    {},
    { keywords: undefined },
    { keywords: null },
    { assistantSaid: true },
    { locations: [] },
    { locations: ['空'] },
    { events: ['无事件'] },
    { timeText: '   ' },
  ]) {
    await assert.rejects(tool.execute(args, exec()), { message: MISSING_QUERY_ERROR }, JSON.stringify(args))
  }
  assert.equal(engine.calls.length, 0)
})

test('the MISSING_QUERY_ERROR text mentions every accepted filter', () => {
  assert.ok(MISSING_QUERY_ERROR.includes('keywords'), MISSING_QUERY_ERROR)
  for (const phrase of ['timeFrom/timeTo/granularity', 'timeText', 'event/events', 'locations', 'persons', '至少给一个']) {
    assert.ok(MISSING_QUERY_ERROR.includes(phrase), `${phrase} is documented in the error`)
  }
})

// ---------------------------------------------------------------------------
// assistantSaid channel
// ---------------------------------------------------------------------------

test('explicit assistantSaid:true is forwarded, reported and reminded to the model', async () => {
  const engine = makeEngine(successResult([makeAddition()], {}, { assistantSaid: true }))
  const plugin = makePlugin({ engine })
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ keywords: 'docker', assistantSaid: true }, exec())

  assert.equal(engine.calls[0].options.assistantSaid, true)
  assert.equal(value.assistantSaid, true)
  assert.deepEqual(value.assistantInfo, { requested: true, effective: true })
  assert.equal(plugin.calls.queryInfo, 0, 'the plugin hook is not consulted for an explicit value')
  assertLosslessJson(value)

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes(ASSISTANT_SAID_NOTE), text)
  assert.ok(text.includes('本次同时检索了你自己过去说过的话，回答引用/否认前请先核对'), text)
  assert.ok(!text.includes('触发句式'), text)
})

test('assistantSaid auto-enables when plugin.currentQueryInfo reports a quote hit', async () => {
  const engine = makeEngine(successResult([makeAddition()], {}, { assistantSaid: true }))
  const plugin = makePlugin({
    engine,
    queryInfo: { assistantSaid: { hit: true, phrases: ['你之前说', '你说过'] } },
  })
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ keywords: 'docker' }, exec())

  assert.equal(plugin.calls.queryInfo, 1, 'the per-turn analysis is read once')
  assert.equal(engine.calls[0].options.assistantSaid, true, 'auto-detection reaches the engine')
  assert.equal(value.assistantSaid, true)
  assert.deepEqual(value.assistantInfo, { requested: true, effective: true, phrases: ['你之前说', '你说过'] })
  assertLosslessJson(value)

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes(ASSISTANT_SAID_NOTE))
  assert.ok(text.includes('触发句式：你之前说、你说过'), text)
})

test('assistantSaid auto-detection is skipped for explicit false, a miss, a missing hook or a throwing hook', async () => {
  // 1) explicit false wins over a quote hit: the model said "don't".
  const explicitEngine = makeEngine(successResult([makeAddition()], {}, { assistantSaid: false }))
  const explicitPlugin = makePlugin({ engine: explicitEngine, queryInfo: { assistantSaid: { hit: true, phrases: ['你说过'] } } })
  const explicitTool = new MemoryRecallTool(explicitPlugin)
  const explicitValue = await explicitTool.execute({ keywords: 'docker', assistantSaid: false }, exec())
  assert.equal(explicitEngine.calls[0].options.assistantSaid, undefined)
  assert.equal(explicitValue.assistantSaid, false)
  assert.equal(explicitValue.assistantInfo, undefined)
  assert.ok(!textOf(render(explicitTool, { keywords: 'docker' }, explicitValue)).includes(ASSISTANT_SAID_NOTE))

  // 2) a non-hit analysis stays quiet.
  const missEngine = makeEngine(successResult([makeAddition()]))
  const missPlugin = makePlugin({ engine: missEngine, queryInfo: { assistantSaid: { hit: false, phrases: [] } } })
  const missValue = await new MemoryRecallTool(missPlugin).execute({ keywords: 'docker' }, exec())
  assert.equal(missEngine.calls[0].options.assistantSaid, undefined)
  assert.equal(missValue.assistantSaid, false)
  assert.equal(missValue.assistantInfo, undefined)

  // 3) a v1.4 plugin without the hook is tolerated (feature detection).
  const oldEngine = makeEngine(successResult([makeAddition()]))
  const oldValue = await new MemoryRecallTool(makePlugin({ engine: oldEngine })).execute({ keywords: 'docker' }, exec())
  assert.equal(oldEngine.calls[0].options.assistantSaid, undefined)
  assert.equal(oldValue.assistantSaid, false)

  // 4) a throwing analysis hook never breaks the recall.
  const throwEngine = makeEngine(successResult([makeAddition()]))
  const throwPlugin = makePlugin({
    engine: throwEngine,
    queryInfo: () => {
      throw new Error('analysis exploded')
    },
  })
  const throwValue = await new MemoryRecallTool(throwPlugin).execute({ keywords: 'docker' }, exec())
  assert.equal(throwEngine.calls[0].options.assistantSaid, undefined)
  assert.equal(throwValue.found, 1)
  assertLosslessJson(throwValue)
})

test('an engine without the assistantSaid echo must not claim the channel was searched (F-04-03/F-04-05)', async () => {
  const engine = makeEngine(successResult([makeAddition()])) // older result shape: no echo
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker', assistantSaid: true }, exec())
  assert.equal(engine.calls[0].options.assistantSaid, true, 'the request is still forwarded to the engine')
  // Audit fix F-04-03/F-04-05: the top-level `assistantSaid` only reports a
  // channel the engine really searched. An old/downgraded engine returns no
  // echo, so the value must stay false — `assistantInfo.requested` keeps the
  // tool's intent and `effective=false` records the downgrade. Previously this
  // flag was OR-ed with the request and the model-visible text then claimed
  // 「同时检索了你过去说过的话」 even though only the keyword channel ran.
  assert.equal(value.assistantSaid, false, 'a requested-but-not-confirmed channel is not reported as searched')
  assert.deepEqual(value.assistantInfo, { requested: true, effective: false })
  assert.ok(
    !textOf(render(tool, { keywords: 'docker' }, value)).includes(ASSISTANT_SAID_NOTE),
    'the model-visible text must not claim the assistant channel was searched',
  )
  assertLosslessJson(value)
})

// ---------------------------------------------------------------------------
// Result field pass-through
// ---------------------------------------------------------------------------

const EXACT_TAG_INFO = {
  status: 'exact',
  requested: { location: ['北京'], person: ['小明'], event: [] },
  matched: {
    location: [{ label: '北京', count: 3 }],
    person: [{ label: '小明', count: 2 }],
    event: [],
  },
  unknown: [],
  enforced: true,
}

const EXACT_TIME_TAG_INFO = {
  status: 'exact',
  labels: ['下周二'],
  windows: [{ from: 1000, to: 2000, label: '下周二', granularity: 'day' }],
  enforced: true,
}

const CLAUSE_INFO = [
  { index: 0, text: 'docker 端口', quota: 1, hits: 2, status: 'hit' },
  { index: 1, text: '部署时间', quota: 0, hits: 0, status: 'miss' },
]

test('tagInfo/timeTagInfo/clauseInfo/assistantSaid from the engine are carried JSON-safely', async () => {
  const engine = makeEngine(
    successResult([makeAddition()], {}, {
      tagInfo: EXACT_TAG_INFO,
      timeTagInfo: EXACT_TIME_TAG_INFO,
      clauseInfo: CLAUSE_INFO,
      assistantSaid: true,
    }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker', locations: ['北京'], timeText: '下周二' }, exec())
  assert.deepEqual(value.tagInfo, EXACT_TAG_INFO)
  assert.deepEqual(value.timeTagInfo, EXACT_TIME_TAG_INFO)
  assert.deepEqual(value.clauseInfo, CLAUSE_INFO)
  assert.equal(value.assistantSaid, true)
  assert.deepEqual(value.assistantInfo, { requested: false, effective: true })
  assertLosslessJson(value)
})

test('unknown tag labels are carried so the model can ask the user or tag them first', async () => {
  const tagInfo = {
    status: 'partial',
    requested: { location: ['北京', '杭州'], person: [], event: [] },
    matched: { location: [{ label: '北京', count: 2 }], person: [], event: [] },
    unknown: [{ kind: 'location', label: '杭州' }],
    enforced: true,
  }
  const engine = makeEngine(successResult([makeAddition()], {}, { tagInfo }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker', locations: ['北京', '杭州'] }, exec())

  assert.deepEqual(value.tagInfo.unknown, [{ kind: 'location', label: '杭州' }])
  assert.deepEqual(value.tagInfo.matched.location, [{ label: '北京', count: 2 }])
  assertLosslessJson(value)
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('标签条件：地点「北京」「杭州」'), text)
  assert.ok(text.includes('未知标签：地点「杭州」'), text)
})

test('results from an engine without v1.5.0 fields stay backward compatible', async () => {
  const engine = makeEngine(successResult([makeAddition()]))
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker' }, exec())

  assert.equal(value.tagInfo, undefined)
  assert.equal(value.timeTagInfo, undefined)
  assert.equal(value.clauseInfo, undefined)
  assert.equal(value.assistantSaid, false)
  assert.equal(value.assistantInfo, undefined)
  assertLosslessJson(value)

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(!text.includes('标签条件'), text)
  assert.ok(!text.includes('时间标签条件'), text)
  assert.ok(!text.includes(ASSISTANT_SAID_NOTE), text)
})

test('tag/time-tag constraint lines are rendered before the recalled entries', async () => {
  const engine = makeEngine(
    successResult([makeAddition()], {}, { tagInfo: EXACT_TAG_INFO, timeTagInfo: EXACT_TIME_TAG_INFO, assistantSaid: true }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker', locations: ['北京'], timeText: '下周二' }, exec())

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('标签条件：地点「北京」；人物「小明」'), text)
  assert.ok(text.includes('时间标签条件：下周二（'), text)
  assert.ok(text.includes(ASSISTANT_SAID_NOTE), text)
  assert.ok(text.indexOf('标签条件：') < text.indexOf('### 回忆 1'), 'the constraint comes before the entries')
  assert.ok(text.indexOf('时间标签条件：') < text.indexOf('### 回忆 1'))
  assert.ok(text.indexOf('标签条件：') < text.indexOf('时间标签条件：'))
})

test('index-mode tag/time-tag conditions are labelled as recorded-but-not-enforced', async () => {
  const tagInfo = { ...EXACT_TAG_INFO, status: 'disabled', enforced: false }
  const timeTagInfo = { ...EXACT_TIME_TAG_INFO, status: 'index', enforced: false }
  const engine = makeEngine(successResult([makeAddition()], {}, { tagInfo, timeTagInfo }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker', locations: ['北京'], timeText: '下周二' }, exec())

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('未启用标签约束'), text)
  assert.ok(text.includes('未启用时间标签约束'), text)
  assert.ok(!text.includes('本次回忆已约束标签'), 'never claims the tag filter was enforced')
})

// ---------------------------------------------------------------------------
// missType 'tag' / 'time-tag' never strikes
// ---------------------------------------------------------------------------

const UNKNOWN_TAG_INFO = {
  status: 'unknown',
  requested: { location: ['杭州'], person: [], event: [] },
  matched: { location: [], person: [], event: [] },
  unknown: [{ kind: 'location', label: '杭州' }],
  enforced: true,
}

test('missType=tag is a constraint miss: never a strike, hint names the filter', async () => {
  const engine = makeEngine(
    missResult({ matchedFolders: 0 }, { missType: 'tag', tagInfo: UNKNOWN_TAG_INFO }),
    missResult({ matchedFolders: 0 }, { missType: 'tag', tagInfo: UNKNOWN_TAG_INFO }),
    missResult({ matchedFolders: 0 }, { missType: 'keyword' }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const first = await tool.execute({ keywords: 'docker', locations: ['杭州'] }, exec())
  assert.equal(first.found, 0)
  assert.equal(first.missType, 'tag')
  assert.equal(first.misses, undefined, 'a tag miss never counts as a strike')
  assert.equal(first.stopHint, undefined)
  assert.deepEqual(first.tagInfo.unknown, [{ kind: 'location', label: '杭州' }])
  assertLosslessJson(first)

  const text = textOf(render(tool, { keywords: 'docker', locations: ['杭州'] }, first))
  assert.ok(text.includes('没有符合标签条件'), text)
  assert.ok(text.includes('地点「杭州」'), text)
  assert.ok(text.includes('这些标签还没有任何记忆：地点「杭州」'), text)
  assert.ok(text.includes('询问用户期望的地点/人物'), text)

  const second = await tool.execute({ keywords: 'docker', locations: ['杭州'] }, exec())
  assert.equal(second.misses, undefined, 'repeated tag misses never accumulate strikes')

  const keywordMiss = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(keywordMiss.misses, 1, 'a true keyword miss starts the strike run')
})

test('missType=time-tag is a constraint miss with a rephrase/absolute-time hint', async () => {
  const timeTagInfo = { ...EXACT_TIME_TAG_INFO }
  const engine = makeEngine(
    missResult({ matchedFolders: 2 }, { missType: 'time-tag', timeTagInfo }),
    missResult({ matchedFolders: 0 }, { missType: 'keyword' }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker', timeText: '下周二' }, exec())
  assert.equal(value.missType, 'time-tag')
  assert.equal(value.misses, undefined, 'a time-tag miss never counts as a strike')
  assert.deepEqual(value.timeTagInfo.labels, ['下周二'])
  assertLosslessJson(value)

  const text = textOf(render(tool, { keywords: 'docker', timeText: '下周二' }, value))
  assert.ok(text.includes('关键词命中了 2 条记忆，但都不在时间标签「下周二」范围内'), text)
  assert.ok(text.includes('改用 timeFrom/timeTo'), text)
  assert.ok(!text.includes('时间标签条件：下周二（'), 'the miss hint already names the time tag; no duplicate line')

  const keywordMiss = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(keywordMiss.misses, 1, 'a true keyword miss starts the strike run')
})

test('a keyword-less tag/timeText browse miss falls back to tag/time-tag (no strike)', async () => {
  const engine = makeEngine(missResult(), missResult(), missResult(), missResult())
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const tag = await tool.execute({ locations: ['北京'] }, exec())
  assert.equal(tag.mode, 'browse')
  assert.equal(tag.missType, 'tag', 'an unclassified tag-only browse is a tag miss')
  assert.equal(tag.misses, undefined)

  const timeTag = await tool.execute({ timeText: '下周二' }, exec())
  assert.equal(timeTag.mode, 'browse')
  assert.equal(timeTag.missType, 'time-tag', 'an unclassified time-only browse is a time-tag miss')
  assert.equal(timeTag.misses, undefined)

  const events = await tool.execute({ events: ['日本旅行'] }, exec())
  assert.equal(events.missType, 'event', 'an unclassified event-list browse is an event miss')
  assert.equal(events.misses, undefined)

  // A keyword-less event-only browse keeps its v1.4.0 classification.
  const single = await tool.execute({ event: '日本旅行' }, exec())
  assert.equal(single.missType, 'event')
  assert.equal(single.misses, undefined)
})

test('repeated tag/time-tag misses never reach the 3/6 warning/disable thresholds', async () => {
  const engine = makeEngine(...Array.from({ length: 8 }, () => missResult({}, { missType: 'tag', tagInfo: UNKNOWN_TAG_INFO })))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = await tool.execute({ keywords: 'docker', locations: ['杭州'] }, exec())
    assert.equal(value.found, 0)
    assert.equal(value.misses, undefined, 'constraint misses are exempt from the strike state machine')
    assert.equal(value.stopHint, undefined)
  }
  assert.equal(engine.calls.length, 8, 'the tool is never disabled by constraint misses')
})

test('tag/time-tag misses do not advance a keyword strike run (the 3rd real miss still warns)', async () => {
  const engine = makeEngine(
    missResult(), // keyword miss 1
    missResult({ matchedFolders: 3 }, { missType: 'tag', tagInfo: UNKNOWN_TAG_INFO }), // constraint miss: no strike
    missResult(), // keyword miss 2
    missResult(), // keyword miss 3 -> warning
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  await tool.execute({ keywords: 'a' }, exec())
  await tool.execute({ keywords: 'b', locations: ['杭州'] }, exec())
  const second = await tool.execute({ keywords: 'c' }, exec())
  assert.equal(second.misses, 2, 'the tag miss did not advance the counter')
  const third = await tool.execute({ keywords: 'd' }, exec())
  assert.equal(third.misses, 3)
  assert.equal(third.stopHint, MISS_WARNING, 'the normal 3rd-miss warning still fires')
})

test('the updated miss hints mention the new filters and keep the v1.4 sentences', () => {
  for (const phrase of ['locations/persons/events/timeText', '询问期望的地点/人物/事件/时间']) {
    assert.ok(MISS_WARNING.includes(phrase), `MISS_WARNING mentions ${phrase}`)
    assert.ok(DISABLED_HINT.includes(phrase), `DISABLED_HINT mentions ${phrase}`)
  }
  assert.ok(MISS_WARNING.includes('可能关键词没有选对'), 'the v1.3.0 warning sentence is kept')
  assert.ok(MISS_WARNING.includes('最小连续 3 天'))
  assert.ok(MISS_WARNING.includes('询问期望的事件名'))
  assert.ok(DISABLED_HINT.includes('目标回忆 α 值过低'), 'the v1.3.0 disable sentence is kept')
  assert.ok(DISABLED_HINT.includes('最小连续 3 天'))
  assert.ok(DISABLED_HINT.includes('询问期望的事件名'))
})

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

test('normalizeTagListArg: string / array / placeholders / types', () => {
  assert.deepEqual(normalizeTagListArg(undefined, 'locations'), { provided: false, values: [] })
  assert.deepEqual(normalizeTagListArg(null, 'locations'), { provided: false, values: [] })
  assert.deepEqual(normalizeTagListArg('北京、家', 'locations'), { provided: true, values: ['北京', '家'] })
  assert.deepEqual(normalizeTagListArg('  小明   小红  ', 'persons'), { provided: true, values: ['小明', '小红'] })
  assert.deepEqual(normalizeTagListArg(['New York', ' 小明 ', '小明'], 'persons'), {
    provided: true,
    values: ['New York', '小明'],
  })
  assert.deepEqual(normalizeTagListArg('空', 'events'), { provided: false, values: [] })
  assert.deepEqual(normalizeTagListArg(['', '无事件', '日本旅行'], 'events'), { provided: true, values: ['日本旅行'] })
  assert.throws(() => normalizeTagListArg(42, 'locations'), { message: 'locations must be a string or an array of strings' })
  assert.throws(() => normalizeTagListArg([42], 'events'), { message: 'events must be a string or an array of strings' })
})

test('normalizeTimeTextArg: strings only, trimmed, blanks absent', () => {
  assert.deepEqual(normalizeTimeTextArg(undefined), { hasTimeText: false })
  assert.deepEqual(normalizeTimeTextArg(42), { hasTimeText: false })
  assert.deepEqual(normalizeTimeTextArg('   '), { hasTimeText: false })
  assert.deepEqual(normalizeTimeTextArg('  下周二 '), { hasTimeText: true, timeText: '下周二' })
})

test('tagInfo/timeTagInfo/clauseInfo normalizers tolerate partial and invalid engine shapes', () => {
  assert.equal(normalizeTagInfo(null), null)
  assert.equal(normalizeTagInfo('nope'), null)
  assert.deepEqual(normalizeTagInfo({ status: 'exact' }), {
    status: 'exact',
    requested: { location: [], person: [], event: [] },
    matched: { location: [], person: [], event: [] },
    unknown: [],
  })
  assert.equal(normalizeTimeTagInfo(undefined), null)
  assert.deepEqual(normalizeTimeTagInfo({ status: 'exact', labels: ['下周二'], windows: [{ from: 2, to: 1 }] }), {
    status: 'exact',
    labels: ['下周二'],
    windows: [],
  })
  assert.equal(normalizeClauseInfo(null), null)
  assert.deepEqual(normalizeClauseInfo([{ index: 0, text: 'a', quota: 1, hits: 2, status: 'hit' }, { bad: true }]), [
    { index: 0, text: 'a', quota: 1, hits: 2, status: 'hit' },
  ])
})

// ---------------------------------------------------------------------------
// Real-engine integration (temporary memory dir only, no real memory/)
// ---------------------------------------------------------------------------

function withRelMemoryDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-recall-tool-150-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  let result
  try {
    result = fn(dir)
  } catch (error) {
    cleanup()
    throw error
  }
  if (result && typeof result.then === 'function') return result.finally(cleanup)
  cleanup()
  return result
}

test('real engine: locations/persons and timeText reach the tag / time-tag indexes', async () => {
  await withRelMemoryDir(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    const config = {
      recall: { mode: 'fair', firstGenMax: 10 },
      time: { mode: 'constrain', timezone: 'Asia/Shanghai' },
      location: { mode: 'constrain' },
      person: { mode: 'constrain' },
      timeTag: { mode: 'constrain' },
    }
    const engine = new MemoryEngine({ memoryDir, config })
    const resolvedConfig = { ...engine.config, memoryDir }
    // Resolve the fuzzy expression with the same helper the engine uses, then
    // store it as the folder's deterministic time tags.
    const nextTuesday = detectQueryTimes('下周二', Date.now(), resolvedConfig)
    assert.equal(nextTuesday.length, 1)

    const folders = [
      {
        id: 'mem-20260101T000000Z-0001',
        meta: { location: ['北京'], person: ['小明'], timeTags: nextTuesday },
        text: '北京-小明-下周二',
      },
      { id: 'mem-20260101T000000Z-0002', meta: { location: ['上海'], person: ['小红'], timeTags: [] }, text: '上海-小红' },
      { id: 'mem-20260101T000000Z-0003', meta: { location: ['北京', '上海'], person: ['小明', '小红'], timeTags: [] }, text: '两地' },
    ]
    for (const folder of folders) {
      writeFolder(memoryDir, {
        id: folder.id,
        meta: {
          createdAt: Date.now(),
          scored: true,
          alpha: 0.9,
          beta: 3,
          keywords: ['docker'],
          locations: folder.meta.location,
          persons: folder.meta.person,
          ...(folder.meta.timeTags.length > 0 ? { timeTags: folder.meta.timeTags, timeTagSource: 'messages' } : {}),
        },
        messages: [{ role: 'user', content: folder.text }],
      })
    }
    engine.load()

    const plugin = {
      currentConfig: () => resolvedConfig,
      toolsSessionEnabled: () => true,
      scopedConfig: () => resolvedConfig,
      engineFor: () => engine,
      contextStats: () => ({ sessionId: 'session-real-150', chars: 200, tokens: 50, windowTokens: 1_000_000 }),
      sessionState: () => ({ recalledIds: new Set() }),
    }
    const tool = new MemoryRecallTool(plugin)

    const byLocation = await tool.execute({ keywords: 'docker', locations: ['北京'] }, exec())
    assert.deepEqual(byLocation.added.sort(), ['mem-20260101T000000Z-0001', 'mem-20260101T000000Z-0003'])
    assert.equal(byLocation.tagInfo.status, 'exact')
    assert.equal(byLocation.tagInfo.enforced, true)
    assert.deepEqual(byLocation.tagInfo.requested.location, ['北京'])
    assertLosslessJson(byLocation)
    assert.ok(textOf(render(tool, { keywords: 'docker' }, byLocation)).includes('标签条件：地点「北京」'))

    const byPerson = await tool.execute({ keywords: 'docker', persons: ['小红'] }, exec())
    assert.deepEqual(byPerson.added.sort(), ['mem-20260101T000000Z-0002', 'mem-20260101T000000Z-0003'])

    const byTimeText = await tool.execute({ keywords: 'docker', timeText: '下周二' }, exec())
    assert.deepEqual(byTimeText.added, ['mem-20260101T000000Z-0001'])
    assert.deepEqual(byTimeText.timeTagInfo.labels, ['下周二'])
    assert.equal(byTimeText.timeTagInfo.enforced, true)

    // A tag-only browse works without keywords.
    const browse = await tool.execute({ locations: ['北京'] }, exec())
    assert.equal(browse.mode, 'browse')
    assert.deepEqual(browse.added, ['mem-20260101T000000Z-0001', 'mem-20260101T000000Z-0003'])

    // An unknown label is a tag miss (not a keyword strike).
    const unknown = await tool.execute({ keywords: 'docker', locations: ['杭州'] }, exec())
    assert.equal(unknown.found, 0)
    assert.equal(unknown.missType, 'tag')
    assert.equal(unknown.misses, undefined)
    assert.deepEqual(unknown.tagInfo.unknown, [{ kind: 'location', label: '杭州' }])
  })
})
