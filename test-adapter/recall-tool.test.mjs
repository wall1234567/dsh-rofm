/**
 * Adapter-level tests for the model-triggered `memory_recall` tool.
 *
 * These tests never boot a harness or hit the real memory dir: a fake plugin,
 * fake session, fake engine and fixtures stand in for the DSH side, so the
 * tool's pure seams (definition contract, engine call, render, consecutive-miss
 * state machine, v1.4.0 pagination/time/browse semantics, image pass-through,
 * validation) are pinned exactly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryEngine, emptyLanes, writeFolder } from '../engine/index.js'
import {
  DISABLED_HINT,
  MAX_RECALL_OFFSET,
  MemoryRecallTool,
  MISS_DISABLE_AT,
  MISS_WARNING,
  MISS_WARN_AT,
  normalizeEventArg,
  normalizeRecallOffset,
} from '../lib/recall-tool.js'

const SESSION = { id: 'session-recall' }

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
    messages: [
      { role: 'user', content: '之前说 docker 端口是 8080。' },
      { role: 'assistant', content: '记下了，端口 8080。' },
    ],
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
 * `images` is either a Map (returned by every resolve call) or a function.
 * `lanes`/`round`/`laneHooks` cover the individual v1.4.0 fair-path hooks;
 * `recallContext` covers the one-call `getRecallContext` hook.
 */
function makePlugin({
  engine = makeEngine(),
  cfg = makeConfig(),
  enabled = true,
  images = null,
  sessionState = undefined,
  lanes = undefined,
  round = undefined,
  laneHooks = undefined,
  recallContext = undefined,
} = {}) {
  const plugin = {
    calls: { currentConfig: 0, toolsSessionEnabled: 0, engineFor: 0, scopedConfig: 0, resolveImages: [], commits: [], contexts: [] },
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
      return { sessionId: 'session-recall', chars: 120, tokens: 40, windowTokens: 1000 }
    },
  }
  if (sessionState !== undefined) plugin.sessionState = () => sessionState
  if (recallContext !== undefined) {
    plugin.getRecallContext = (session, config) => {
      plugin.calls.contexts.push({ session, config })
      return typeof recallContext === 'function' ? recallContext(session, config) : recallContext
    }
    plugin.commitRecallLanes = (session, config, nextLanes) => {
      plugin.calls.commits.push({ session, config, lanes: nextLanes })
    }
  } else if (laneHooks !== false && (lanes !== undefined || round !== undefined)) {
    if (lanes !== undefined) plugin.getRecallLanes = () => lanes
    if (round !== undefined) plugin.nextRecallRound = () => round
    plugin.commitRecallLanes = (session, config, nextLanes) => {
      plugin.calls.commits.push({ session, config, lanes: nextLanes })
    }
  }
  if (images !== null) {
    // v1.2.x: the tool asks the plugin for *file paths*, never for attachments.
    plugin.imageEntriesForAdditions = (config, additions) => {
      plugin.calls.resolveImages.push({ config, additions })
      return typeof images === 'function' ? images(config, additions) : images
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
// Definition contract
// ---------------------------------------------------------------------------

test('definition exposes the memory_recall contract (v1.5.0 schema)', () => {
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine() }))
  const definition = tool.definition()

  assert.equal(definition.name, 'memory_recall')
  assert.equal(typeof definition.description, 'string')
  assert.ok(definition.description.includes('主动回忆'), definition.description)
  assert.ok(definition.description.includes('α'), 'description mentions α')
  assert.ok(definition.description.includes('β'), 'description mentions β')
  assert.ok(definition.description.includes('停用'), 'description mentions the disable escalation')
  assert.ok(definition.description.includes('关键词'), 'description mentions keywords')
  // v1.4.0 time assistance + pagination are part of the model-facing contract.
  for (const phrase of ['timeFrom', 'timeTo', 'granularity', '最小连续 3 天', 'offset', '纯时间浏览', '分页', '询问']) {
    assert.ok(definition.description.includes(phrase), `description must mention ${phrase}`)
  }
  // v1.4.0 event constraint: optional, model-chosen, "空" clears it.
  for (const phrase of ['事件约束', 'event', '「空」']) {
    assert.ok(definition.description.includes(phrase), `description must mention ${phrase}`)
  }
  // v1.5.0: tag/time-tag filters, 20-entry pages and the assistant-said channel.
  for (const phrase of ['20', 'locations', 'persons', 'events', 'timeText', 'assistantSaid', '标签']) {
    assert.ok(definition.description.includes(phrase), `description must mention ${phrase}`)
  }

  assert.equal(definition.parameters.type, 'object')
  // v1.4.0: keywords is optional when a time/event window is given (browse mode).
  assert.deepEqual(definition.parameters.required, [])
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
  assert.equal(properties.keywords.type, 'string')
  assert.ok(properties.keywords.description.includes('可省略'), 'keywords is documented as optional with a time window')
  assert.equal(properties.limit.type, 'integer')
  assert.ok(properties.limit.description.includes('1~20'))
  assert.ok(properties.limit.description.includes('20'), 'the 20-entry ceiling is documented')
  assert.equal(properties.offset.type, 'integer')
  assert.ok(properties.offset.description.includes('10000'), 'offset documents its cap')
  assert.equal(properties.timeFrom.type, 'string')
  assert.ok(properties.timeFrom.description.includes('最小连续 3 天'))
  assert.equal(properties.timeTo.type, 'string')
  assert.equal(properties.granularity.type, 'string')
  for (const name of ['day', 'month', 'year']) assert.ok(properties.granularity.description.includes(name))
  assert.equal(properties.event.type, 'string')
  for (const phrase of ['事件约束', '「空」', '省略']) assert.ok(properties.event.description.includes(phrase), phrase)
  // v1.5.0 multi-value filters are string arrays; timeText is a string and the
  // assistant-said switch is a boolean.
  for (const name of ['locations', 'persons', 'events']) {
    assert.equal(properties[name].type, 'array', `${name} is an array parameter`)
    assert.deepEqual(properties[name].items, { type: 'string' })
    assert.ok(properties[name].description.length > 0, `${name} is documented`)
  }
  assert.ok(properties.events.description.includes('合并'), 'events documents the event+events merge')
  assert.ok(properties.event.description.includes('events'), 'event points at the events array')
  assert.equal(properties.locations.description.includes('北京'), true)
  assert.equal(properties.timeText.type, 'string')
  for (const phrase of ['下周二', '昨天']) assert.ok(properties.timeText.description.includes(phrase), phrase)
  assert.equal(properties.assistantSaid.type, 'boolean')
  assert.ok(properties.assistantSaid.description.includes('你说过'), properties.assistantSaid.description)

  // The output schema documents the v1.5.0 value shape (pagination + time + event
  // + tag/timeTag + clause + assistantSaid).
  assert.equal(definition.output.schema.type, 'object')
  assert.deepEqual(Object.keys(definition.output.schema.properties).sort(), [
    'added',
    'assistantInfo',
    'assistantSaid',
    'attempted',
    'clauseInfo',
    'degraded',
    'eventInfo',
    'found',
    'hasMore',
    'images',
    'limit',
    'matchedFolders',
    'missType',
    'misses',
    'mode',
    'nextOffset',
    'offset',
    'stopHint',
    'tagInfo',
    'timeTagInfo',
    'timeWindow',
    'warnings',
  ])
  assert.equal(definition.output.schema.properties.eventInfo.type, 'object')
  assert.equal(definition.output.schema.properties.tagInfo.type, 'object')
  assert.equal(definition.output.schema.properties.timeTagInfo.type, 'object')
  assert.equal(definition.output.schema.properties.clauseInfo.type, 'array')
  assert.equal(definition.output.schema.properties.assistantInfo.type, 'object')
  assert.equal(definition.output.schema.properties.assistantSaid.type, 'boolean')
  const missTypeDescription = definition.output.schema.properties.missType.description
  assert.ok(missTypeDescription.includes("'tag'"), missTypeDescription)
  assert.ok(missTypeDescription.includes("'time-tag'"), missTypeDescription)
  assert.equal(definition.output.schema.required, undefined, 'no output field is claimed as required')
  assert.equal(definition.output.schema.properties.images.items.properties.name.type, 'string')
  assert.equal(definition.output.schema.properties.images.items.properties.path.type, 'string')
  assert.equal(definition.output.schema.properties.images.items.properties.exists.type, 'boolean')
  assert.equal(typeof definition.output.render, 'function')

  assert.ok(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0)
  assert.equal(definition.isConcurrencySafe(), false)
  assert.equal(typeof definition.execute, 'function')
})

// ---------------------------------------------------------------------------
// Successful recall
// ---------------------------------------------------------------------------

test('success returns the entries and renders heading, α/β, keywords and messages', async () => {
  const addition = makeAddition()
  const engine = makeEngine(successResult([addition]))
  const plugin = makePlugin({ engine })
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ keywords: 'docker 端口' }, exec())

  assert.equal(value.found, 1)
  assert.equal(value.matchedFolders, 1)
  assert.equal(value.attempted, 1)
  assert.deepEqual(value.added, ['mem-20260101T000000Z-0001'])
  assert.equal(value.stopHint, undefined)
  assert.equal(value.entries.length, 1)
  assert.equal(value.entries[0].alpha, 0.7)
  assert.equal(value.entries[0].beta, 3)
  assert.equal(value.entries[0].generation, 1)
  assert.deepEqual(value.entries[0].keywords, ['docker', '端口'])
  assert.deepEqual(value.entries[0].messages, ['user: 之前说 docker 端口是 8080。', 'assistant: 记下了，端口 8080。'])
  assertLosslessJson(value)

  // The engine was called with the model keywords, real context stats and an
  // exclusion set (empty here: the session has no recall block yet).
  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls[0].userText, 'docker 端口')
  assert.equal(engine.calls[0].context.sessionId, 'session-recall')
  assert.ok(engine.calls[0].options.excludeIds instanceof Set)

  const content = render(tool, { keywords: 'docker 端口' }, value)
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  const text = content[0].text
  assert.ok(text.includes('主动回忆结果'), text)
  assert.ok(text.includes('关键词：docker 端口'))
  assert.ok(text.includes('回忆到 1 条记忆'))
  assert.ok(text.includes('### 回忆 1'), text)
  assert.ok(text.includes('α=0.70'), text)
  assert.ok(text.includes('β=+3.0'), text)
  assert.ok(text.includes('第1代'), text)
  assert.ok(text.includes('关键词：docker、端口'), text)
  assert.ok(text.includes('user: 之前说 docker 端口是 8080。'), text)
  assert.ok(text.includes('assistant: 记下了，端口 8080。'), text)
  assert.ok(text.includes('β 表示信赖度'), 'a short trust note is included')
})

test('image file entries from the plugin helper are exposed as paths (no image blocks)', async () => {
  const entries = [{ name: 'mem-1-1.png', path: '/scoped/memory/images/mem-1-1.png', exists: true }]
  const addition = makeAddition({ meta: { images: [{ name: 'mem-1-1.png', placeholder: '[图片：（mem-1-1.png）]' }] } })
  const engine = makeEngine(successResult([addition]))
  const cfg = makeConfig()
  const plugin = makePlugin({ engine, cfg, images: entries })
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ keywords: 'docker' }, exec())

  assert.equal(value.images.length, 1)
  assert.deepEqual(value.images[0], { name: 'mem-1-1.png', path: '/scoped/memory/images/mem-1-1.png', exists: true })
  assertLosslessJson(value)

  // The helper received the scoped config + only the additions actually returned.
  assert.equal(plugin.calls.resolveImages.length, 1)
  assert.equal(plugin.calls.resolveImages[0].config.memoryDir, '/scoped/memory')
  assert.deepEqual(plugin.calls.resolveImages[0].additions, [addition])

  const content = render(tool, { keywords: 'docker' }, value)
  assert.equal(content.length, 1, 'text only: the image is a file path, not an attachment')
  assert.equal(content[0].type, 'text')
  const text = textOf(content)
  assert.ok(text.includes('图片文件（用'), text)
  assert.ok(text.includes('mem-1-1.png：/scoped/memory/images/mem-1-1.png'), text)
  assert.ok(text.includes('read_image'), 'the model is told to read the file with read_image')
})

test('image placeholders in recalled messages are expanded to their file paths', async () => {
  const entries = [{ name: 'pic.png', path: '/scoped/memory/images/pic.png', exists: true }]
  const addition = makeAddition()
  addition.messages = [{ role: 'user', content: '截图见 [图片：（pic.png）]' }]
  const additionWithImage = makeAddition({ meta: { images: [{ name: 'pic.png' }] } })
  additionWithImage.messages = [{ role: 'user', content: '截图见 [图片：（pic.png）]' }]
  const engine = makeEngine(successResult([additionWithImage]))
  const tool = new MemoryRecallTool(makePlugin({ engine, images: entries }))

  const value = await tool.execute({ keywords: 'docker' }, exec())
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('[图片：（pic.png，文件：/scoped/memory/images/pic.png）]'), text)
  assert.ok(!text.includes('[图片：（pic.png）]'), 'the bare placeholder is expanded')
})

test('missing image files are marked （缺失） in the text list', async () => {
  const entries = [{ name: 'lost.png', path: '/scoped/memory/images/lost.png', exists: false }]
  const addition = makeAddition({ meta: { images: [{ name: 'lost.png' }] } })
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine(successResult([addition])), images: entries }))

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.deepEqual(value.images, [{ name: 'lost.png', path: '/scoped/memory/images/lost.png', exists: false }])
  assertLosslessJson(value)
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('lost.png：/scoped/memory/images/lost.png（缺失）'), text)
})

test('images without plugin path info are still listed by name without breaking the result', async () => {
  const addition = makeAddition({ meta: { images: [{ name: 'img-a.png' }, { name: 'img-b.png' }] } })
  const plugin = makePlugin({ engine: makeEngine(successResult([addition])) }) // no imageEntriesForAdditions
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.found, 1, 'the recalled text still reaches the model')
  assert.deepEqual(value.images, [
    { name: 'img-a.png', path: '', exists: false },
    { name: 'img-b.png', path: '', exists: false },
  ])
  assertLosslessJson(value)
  assert.equal(render(tool, { keywords: 'docker' }, value).length, 1, 'no image blocks')
})

test('a throwing image helper never breaks the recall result', async () => {
  const addition = makeAddition({ meta: { images: [{ name: 'img-a.png' }] } })
  const plugin = makePlugin({
    engine: makeEngine(successResult([addition])),
    images: () => {
      throw new Error('attachment service unavailable')
    },
  })
  const tool = new MemoryRecallTool(plugin)
  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.found, 1, 'the recalled text still reaches the model')
  assert.deepEqual(value.images, [{ name: 'img-a.png', path: '', exists: false }])
})

// ---------------------------------------------------------------------------
// Misses and the 3/6 escalation state machine
// ---------------------------------------------------------------------------

test('a miss with no keyword match hints at keywords and counts as miss 1', async () => {
  const engine = makeEngine(missResult())
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'nothing matches' }, exec())
  assert.equal(value.found, 0)
  assert.deepEqual(value.added, [])
  assert.deepEqual(value.entries, [])
  assert.equal(value.misses, 1)
  assert.equal(value.stopHint, undefined)
  assertLosslessJson(value)

  const text = textOf(render(tool, { keywords: 'nothing matches' }, value))
  assert.ok(text.includes('未回忆到记忆'), text)
  assert.ok(text.includes('连续第 1 次未命中'), text)
  assert.ok(text.includes('没有匹配到任何记忆'), text)
  assert.ok(text.includes('专有名词/技术名'), text)
})

test('a fair-mode miss with keyword matches is not a strike and hints at paging/time instead of α luck', async () => {
  const cfg = makeConfig({ recall: { enabled: true, mode: 'fair' } })
  const fairTool = new MemoryRecallTool(makePlugin({ engine: makeEngine(missResult({ matchedFolders: 2, attempts: 2 })), cfg }))

  const value = await fairTool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.matchedFolders, 2)
  assert.equal(value.attempted, 2)
  // fair/deterministic: only a true miss (no keyword candidates) counts.
  assert.equal(value.misses, undefined, 'matched-but-excluded is not a strike in fair mode')
  assert.equal(value.stopHint, undefined)

  const text = textOf(render(fairTool, { keywords: 'docker' }, value))
  assert.ok(text.includes('匹配到 2 条记忆'), text)
  assert.ok(text.includes('offset 翻页'), 'fair hint points at pagination')
  assert.ok(!text.includes('α 概率判定均未被回忆出来'), 'the legacy α-probability wording is gone in fair mode')
  assert.ok(text.includes('询问'), 'the hint may ask the user for a time range')

  // legacy keeps the v1.3.0 wording and the old strike accounting.
  const legacyCfg = makeConfig({ recall: { enabled: true, mode: 'legacy' } })
  const legacyTool = new MemoryRecallTool(makePlugin({ engine: makeEngine(missResult({ matchedFolders: 2, attempts: 2 })), cfg: legacyCfg }))
  const legacyValue = await legacyTool.execute({ keywords: 'docker' }, exec())
  assert.equal(legacyValue.misses, 1, 'legacy still counts every empty result as a miss')
  const legacyText = textOf(render(legacyTool, { keywords: 'docker' }, legacyValue))
  assert.ok(legacyText.includes('α 概率判定均未被回忆出来'), legacyText)
})

test('matched folders that are already in the recall block are not re-injected or re-rolled', async () => {
  const engine = makeEngine(missResult({ matchedFolders: 1, attempts: 0 }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.attempted, 0)
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('已在当前回忆区块中，未重复注入'), text)
})

test('the 3rd consecutive miss warns exactly once; the 6th disables the tool', async () => {
  const additions = [makeAddition()]
  const engine = makeEngine(
    missResult(),
    missResult(),
    missResult(),
    missResult(),
    missResult(),
    missResult(),
    successResult(additions),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const first = await tool.execute({ keywords: 'a' }, exec())
  const second = await tool.execute({ keywords: 'b' }, exec())
  assert.equal(first.stopHint, undefined)
  assert.equal(second.stopHint, undefined)

  const third = await tool.execute({ keywords: 'c' }, exec())
  assert.equal(third.misses, MISS_WARN_AT)
  assert.equal(third.stopHint, MISS_WARNING)
  assert.equal(third.found, 0)
  assert.ok(textOf(render(tool, { keywords: 'c' }, third)).includes(MISS_WARNING), 'warning is rendered')
  assert.ok(textOf(render(tool, { keywords: 'c' }, third)).includes('连续第 3 次未命中'))

  // Continuing keeps counting but the warning itself is emitted only once.
  const fourth = await tool.execute({ keywords: 'd' }, exec())
  assert.equal(fourth.misses, 4)
  assert.equal(fourth.stopHint, undefined)
  await tool.execute({ keywords: 'e' }, exec())
  const sixth = await tool.execute({ keywords: 'f' }, exec())
  assert.equal(sixth.misses, MISS_DISABLE_AT)
  assert.equal(sixth.stopHint, DISABLED_HINT)
  assert.ok(textOf(render(tool, { keywords: 'f' }, sixth)).includes(DISABLED_HINT))

  // Disabled for the rest of the turn: further calls throw and never reach the engine.
  const callsBefore = engine.calls.length
  await assert.rejects(tool.execute({ keywords: 'g' }, exec()), {
    message: `memory_recall 本轮已停用：${DISABLED_HINT}`,
  })
  assert.equal(engine.calls.length, callsBefore, 'the engine is not called while disabled')

  // Next real user message re-enables the tool (the plugin calls resetAttempts).
  tool.resetAttempts(SESSION)
  const afterReset = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(afterReset.found, 1, 'recall works again after resetAttempts')
  assert.equal(afterReset.stopHint, undefined)
})

test('a successful recall clears the strike run (counter and warning)', async () => {
  const engine = makeEngine(
    missResult(),
    missResult(),
    missResult(), // warns at 3
    successResult([makeAddition()]),
    missResult(), // fresh run: miss 1 again, no stale warning
    missResult(),
    missResult(), // fresh run reaches 3 -> warns again
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  await tool.execute({ keywords: 'a' }, exec())
  await tool.execute({ keywords: 'b' }, exec())
  const warned = await tool.execute({ keywords: 'c' }, exec())
  assert.equal(warned.stopHint, MISS_WARNING)

  const success = await tool.execute({ keywords: 'docker 端口' }, exec())
  assert.equal(success.found, 1)
  assert.equal(success.stopHint, undefined)

  const missAfterSuccess = await tool.execute({ keywords: 'd' }, exec())
  assert.equal(missAfterSuccess.misses, 1, 'success reset the counter')
  assert.equal(missAfterSuccess.stopHint, undefined)
  await tool.execute({ keywords: 'e' }, exec())
  const warnedAgain = await tool.execute({ keywords: 'f' }, exec())
  assert.equal(warnedAgain.stopHint, MISS_WARNING, 'the warning is re-armed after a success')
})

test('resetAttempts tolerates missing/unknown sessions', () => {
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine() }))
  assert.doesNotThrow(() => tool.resetAttempts(undefined))
  assert.doesNotThrow(() => tool.resetAttempts(null))
  assert.doesNotThrow(() => tool.resetAttempts('not-a-session'))
  assert.doesNotThrow(() => tool.resetAttempts({ id: 'other-session' }))
})

// ---------------------------------------------------------------------------
// Validation, limits, exclusions and unavailable dependencies
// ---------------------------------------------------------------------------

test('empty or non-string keywords are rejected; a completely empty query is rejected with a hint', async () => {
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine() }))
  // A supplied but broken keyword value is still an argument error.
  for (const keywords of ['', '   ', 42, [], {}]) {
    await assert.rejects(tool.execute({ keywords }, exec()), {
      message: 'keywords must be a non-empty string',
    })
  }
  // v1.4.0: keywords may be omitted only when a time window or an event is given.
  for (const args of [{}, { keywords: undefined }, { keywords: null }, { event: '空' }, { timeFrom: '' }]) {
    await assert.rejects(tool.execute(args, exec()), {
      message:
        'memory_recall 需要 keywords（关键词），或任一过滤器（timeFrom/timeTo/granularity、timeText、event/events、locations、persons），至少给一个',
    })
  }
})

test('the tool requires an active session', async () => {
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine() }))
  await assert.rejects(tool.execute({ keywords: 'docker' }, {}), { message: 'memory_recall requires an active session' })
  await assert.rejects(tool.execute({ keywords: 'docker' }, undefined), {
    message: 'memory_recall requires an active session',
  })
})

test('a session the plugin is disabled for is rejected before recall', async () => {
  const engine = makeEngine()
  const tool = new MemoryRecallTool(makePlugin({ engine, enabled: false }))
  await assert.rejects(tool.execute({ keywords: 'docker' }, exec()), { message: 'dsh-rofm is disabled for this session' })
  assert.equal(engine.calls.length, 0)
})

test('an unavailable memory engine is rejected', async () => {
  const plugin = makePlugin({ engine: makeEngine() })
  plugin.engineFor = () => undefined
  const tool = new MemoryRecallTool(plugin)
  await assert.rejects(tool.execute({ keywords: 'docker' }, exec()), { message: 'memory engine unavailable' })
})

test('limit is clamped to 1..20 with a default of 3 (v1.5.0 ceiling)', async () => {
  const additions = Array.from({ length: 25 }, (_, index) => makeAddition({ meta: { id: `mem-${index}` } }))
  const engine = makeEngine(
    successResult(additions),
    successResult(additions),
    successResult(additions),
    successResult(additions),
    successResult(additions),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const byDefault = await tool.execute({ keywords: 'x' }, exec())
  assert.equal(byDefault.found, 3, 'default limit is 3')
  assert.equal(byDefault.added.length, 3)

  const two = await tool.execute({ keywords: 'x', limit: 2 }, exec())
  assert.equal(two.found, 2)

  const zero = await tool.execute({ keywords: 'x', limit: 0 }, exec())
  assert.equal(zero.found, 1, '0 clamps up to 1')

  const twenty = await tool.execute({ keywords: 'x', limit: 20 }, exec())
  assert.equal(twenty.found, 20, 'the v1.5.0 ceiling allows a 20-entry page')

  const huge = await tool.execute({ keywords: 'x', limit: 99 }, exec())
  assert.equal(huge.found, 20, '99 clamps down to 20')
  assert.equal(engine.calls.at(-1).options.limit, 20, 'the clamped limit reaches the engine')
})

test('recalled ids from the session state are excluded from re-injection', async () => {
  const recalledIds = new Set(['mem-already-1', 'mem-already-2'])
  const engine = makeEngine(successResult([makeAddition()]))
  const plugin = makePlugin({ engine, sessionState: { recalledIds } })
  const tool = new MemoryRecallTool(plugin)

  await tool.execute({ keywords: 'docker' }, exec())
  assert.deepEqual([...engine.calls[0].options.excludeIds].sort(), ['mem-already-1', 'mem-already-2'])
})

test('the exclusions are empty when the plugin exposes no session state', async () => {
  const engine = makeEngine(successResult([makeAddition()]))
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  await tool.execute({ keywords: 'docker' }, exec())
  assert.deepEqual([...engine.calls[0].options.excludeIds], [])
})

test('malformed engine results degrade to a miss instead of throwing', async () => {
  const engine = { calls: [], recall: () => ({}) }
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.found, 0)
  assert.equal(value.matchedFolders, 0)
  assert.equal(value.attempted, 0)
  assert.equal(value.misses, 1)
  assertLosslessJson(value)
})

// ---------------------------------------------------------------------------
// v1.4.0 pagination (offset / limit / hasMore)
// ---------------------------------------------------------------------------

test('offset is clamped to 0..10000 and never throws', () => {
  assert.equal(MAX_RECALL_OFFSET, 10000)
  assert.equal(normalizeRecallOffset(undefined), 0)
  assert.equal(normalizeRecallOffset(null), 0)
  assert.equal(normalizeRecallOffset(''), 0)
  assert.equal(normalizeRecallOffset('abc'), 0)
  assert.equal(normalizeRecallOffset(-3), 0)
  assert.equal(normalizeRecallOffset('4.9'), 4)
  assert.equal(normalizeRecallOffset(MAX_RECALL_OFFSET + 1), MAX_RECALL_OFFSET)
})

test('pagination passes offset/limit to the engine and renders a next-page hint', async () => {
  const page = [makeAddition({ meta: { id: 'mem-page-1' } }), makeAddition({ meta: { id: 'mem-page-2' } })]
  const engine = makeEngine(successResult(page, {}, { page: { offset: 2, limit: 2, hasMore: true } }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker', offset: 2, limit: 2 }, exec())
  assert.equal(engine.calls[0].options.offset, 2)
  assert.equal(engine.calls[0].options.limit, 2)
  assert.equal(value.offset, 2)
  assert.equal(value.limit, 2)
  assert.equal(value.hasMore, true)
  assert.equal(value.nextOffset, 4)
  assertLosslessJson(value)

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('本页：第 3 ～ 4 条'), text)
  assert.ok(text.includes('还有更多'), text)
  assert.ok(text.includes('offset=4'), text)
})

test('the first page without more results renders no pagination chrome', async () => {
  const engine = makeEngine(successResult([makeAddition()]))
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.offset, 0)
  assert.equal(value.hasMore, false)
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(!text.includes('还有更多'), text)
  assert.ok(!text.includes('本页：'), text)
})

// ---------------------------------------------------------------------------
// v1.4.0 time assistance (timeFrom / timeTo / granularity, browse mode)
// ---------------------------------------------------------------------------

test('time arguments are passed through untouched and the widened window is rendered', async () => {
  const window = {
    from: Date.UTC(2026, 9, 30),
    to: Date.UTC(2026, 10, 2),
    level: 'day',
    widenedTo: 'day3',
    timezone: 'UTC',
    requested: { from: Date.UTC(2026, 9, 31), to: Date.UTC(2026, 10, 1) },
  }
  const engine = makeEngine(successResult([makeAddition()], {}, { timeWindow: window }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute(
    { keywords: 'docker', timeFrom: '2026-10-31', timeTo: '2026-11-01', granularity: 'day' },
    exec(),
  )
  // Invalid/mis-typed values are the engine normalizer's job: pass them through.
  assert.equal(engine.calls[0].options.timeFrom, '2026-10-31')
  assert.equal(engine.calls[0].options.timeTo, '2026-11-01')
  assert.equal(engine.calls[0].options.granularity, 'day')
  assert.deepEqual(value.timeWindow, window)
  assertLosslessJson(value)

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('时间范围：2026-10-30 ~ 2026-11-01'), text)
  assert.ok(text.includes('已放宽到 ±1 天'), text)
  assert.ok(text.includes('原查询：2026-10-31'), text)
})

test('time-only browse: no keywords, empty userText, chronological event order, mode=browse', async () => {
  // The engine may return any order; browse mode must sort by eventStart asc.
  const late = makeAddition({ meta: { id: 'mem-late', eventStart: 3000, createdAt: 1000 } })
  const early = makeAddition({ meta: { id: 'mem-early', eventStart: 2000, createdAt: 2500 } })
  const engine = makeEngine(
    successResult([late, early], {}, { mode: 'fair', timeWindow: { from: 1000, to: 4000, level: 'day', timezone: 'UTC' } }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ timeFrom: '2026-10-31' }, exec())
  assert.equal(engine.calls[0].userText, '', 'browse sends no keyword text to the engine')
  assert.equal(engine.calls[0].options.timeFrom, '2026-10-31')
  assert.equal(value.mode, 'browse')
  assert.deepEqual(value.added, ['mem-early', 'mem-late'], 'browse is chronological by eventStart')
  assert.deepEqual(value.entries.map((entry) => entry.eventStart), [2000, 3000])
  assertLosslessJson(value)

  const text = textOf(render(tool, { timeFrom: '2026-10-31' }, value))
  assert.ok(text.includes('纯时间浏览'), text)
  assert.ok(text.includes('事件：'), 'browse headings show the event time')
  assert.ok(text.includes('时间范围：'), text)
})

test('an empty browse result is a time miss with a widening/ask-user hint', async () => {
  const engine = makeEngine(
    missResult({}, { mode: 'fair', timeWindow: { from: 1000, to: 2000, level: 'day', timezone: 'UTC' } }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ timeFrom: '2026-10-31', granularity: 'day' }, exec())

  assert.equal(value.mode, 'browse')
  assert.equal(value.missType, 'time')
  assert.equal(value.misses, undefined, 'a browse miss never counts as a strike')
  assertLosslessJson(value)
  const text = textOf(render(tool, { timeFrom: '2026-10-31' }, value))
  assert.ok(text.includes('纯时间浏览'), text)
  assert.ok(text.includes('指定时间范围内没有找到记忆'), text)
  assert.ok(text.includes('询问期望的事件名'), 'a time miss also mentions the event reminder')
  assert.ok(text.includes('询问'), text)
})

test('time.mode=off drops time arguments with a warning; a time-only call is rejected', async () => {
  const engine = makeEngine(successResult([makeAddition()]))
  const cfg = makeConfig({ recall: { enabled: true, mode: 'fair' }, time: { mode: 'off' } })
  const tool = new MemoryRecallTool(makePlugin({ engine, cfg }))

  const value = await tool.execute({ keywords: 'docker', timeFrom: '2026-10-31' }, exec())
  assert.equal(engine.calls[0].options.timeFrom, undefined, 'time is rolled back when time.mode=off')
  assert.ok(value.warnings.some((warning) => warning.includes('time.mode=off')), JSON.stringify(value.warnings))
  assert.ok(textOf(render(tool, { keywords: 'docker' }, value)).includes('time.mode=off'))

  await assert.rejects(tool.execute({ timeFrom: '2026-10-31' }, exec()), {
    message:
      'memory_recall 需要 keywords（关键词），或任一过滤器（timeFrom/timeTo/granularity、timeText、event/events、locations、persons），至少给一个',
  })
})

test('invalid time values are delegated to the engine normalizer (warnings, never a throw)', async () => {
  const engine = makeEngine(
    missResult({}, { missType: 'time', warnings: ["time: 无法解析查询时间 '不是时间'，已忽略时间约束，按关键词检索"] }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker', timeFrom: '不是时间' }, exec())

  assert.equal(engine.calls[0].options.timeFrom, '不是时间')
  assert.equal(value.missType, 'time')
  assert.ok(value.warnings[0].includes('无法解析'))
  assertLosslessJson(value)
  assert.ok(textOf(render(tool, { keywords: 'docker' }, value)).includes('提示：'))
})

// ---------------------------------------------------------------------------
// v1.4.0 miss semantics: time miss ≠ strike; fair vs legacy accounting
// ---------------------------------------------------------------------------

test('missType=time does not count a strike and returns an ask-the-user hint', async () => {
  const engine = makeEngine(
    missResult({ matchedFolders: 3, attempts: 0 }, { missType: 'time', mode: 'fair', timeWindow: { from: 1000, to: 2000, level: 'day' } }),
    missResult({ matchedFolders: 3, attempts: 0 }, { missType: 'time', mode: 'fair' }),
    missResult({ matchedFolders: 0, attempts: 0 }, { missType: 'keyword', mode: 'fair' }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const first = await tool.execute({ keywords: 'docker', timeFrom: '2026-10-31' }, exec())
  assert.equal(first.found, 0)
  assert.equal(first.missType, 'time')
  assert.equal(first.misses, undefined, 'time miss is not a strike')
  assert.equal(first.stopHint, undefined)
  assertLosslessJson(first)
  const text = textOf(render(tool, { keywords: 'docker', timeFrom: '2026-10-31' }, first))
  assert.ok(text.includes('时间范围过滤'), text)
  assert.ok(text.includes('询问'), text)

  const second = await tool.execute({ keywords: 'docker', timeFrom: '2026-10-31' }, exec())
  assert.equal(second.missType, 'time')
  assert.equal(second.misses, undefined, 'repeated time misses never accumulate strikes')

  const third = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(third.misses, 1, 'a true miss starts the strike run')
})

test('the three model-visible hints tell the model it may ask the user for a time range AND an event name', () => {
  // The 3rd-miss warning and the 6th-miss disable hint keep their v1.3.0
  // sentences (rollback parity) and append the v1.4.0 time-assistance sentence.
  assert.ok(MISS_WARNING.includes('可能关键词没有选对'), 'legacy warning sentence kept')
  assert.ok(MISS_WARNING.includes('询问'), '3rd-miss warning mentions asking the user')
  assert.ok(MISS_WARNING.includes('最小连续 3 天'), MISS_WARNING)
  // v1.4.0 event assist: the same hints may ask the user for the expected event.
  assert.ok(MISS_WARNING.includes('询问期望的事件名'), MISS_WARNING)
  assert.ok(MISS_WARNING.includes('event'), MISS_WARNING)
  assert.ok(DISABLED_HINT.includes('目标回忆 α 值过低'), 'legacy disable sentence kept')
  assert.ok(DISABLED_HINT.includes('询问'), '6th-miss hint mentions asking the user')
  assert.ok(DISABLED_HINT.includes('最小连续 3 天'), DISABLED_HINT)
  assert.ok(DISABLED_HINT.includes('询问期望的事件名'), DISABLED_HINT)
  assert.ok(DISABLED_HINT.includes('event'), DISABLED_HINT)

  // The empty-result missHint is the third model-visible place.
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine() }))
  const value = {
    found: 0,
    matchedFolders: 0,
    attempted: 0,
    added: [],
    images: [],
    entries: [],
    misses: 1,
    askUserHint: true,
  }
  const text = textOf(render(tool, { keywords: 'nothing' }, value))
  assert.ok(text.includes('没有匹配到任何记忆'), text)
  assert.ok(text.includes('询问'), 'empty-result hint mentions asking the user')
  assert.ok(text.includes('最小连续 3 天'), text)
  assert.ok(text.includes('询问期望的事件名'), text)
  assert.ok(text.includes('event 参数'), text)
})

test('the event "ask the user" reminder honours event.askUserHint=false', () => {
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine() }))
  const value = {
    found: 0,
    matchedFolders: 0,
    attempted: 0,
    added: [],
    images: [],
    entries: [],
    misses: 1,
    askUserHint: true,
    eventAskUserHint: false,
  }
  const text = textOf(render(tool, { keywords: 'nothing' }, value))
  assert.ok(!text.includes('询问期望的事件名'), 'event reminder is suppressed by event.askUserHint=false')
  assert.ok(text.includes('询问期望的时间范围'), 'the time reminder is independent and still present')
})

// ---------------------------------------------------------------------------
// v1.4.0 lane state and legacy rollback
// ---------------------------------------------------------------------------

test('fair path passes plugin lanes/round as a pagination snapshot and commits nothing (B-01)', async () => {
  const lanes = { round: 7, pendingHigh: [] }
  const returnedLanes = { round: 8, pendingHigh: ['mem-x'] }
  const engine = makeEngine(successResult([makeAddition()], {}, { mode: 'fair', lanes: returnedLanes }))
  const plugin = makePlugin({ engine, lanes, round: 8 })
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(engine.calls[0].options.paginate, true, 'fair mode opts into the stable pagination window')
  assert.equal(engine.calls[0].options.lanes, lanes)
  assert.equal(engine.calls[0].options.round, 8)
  // B-01: the engine returns the *input* snapshot, so committing it would make
  // the next page see different state. The adapter must not write lane state.
  assert.equal(plugin.calls.commits.length, 0, 'no commitRecallLanes on the paginated path')
  assert.equal(value.mode, 'fair')
  assertLosslessJson(value)
})

test('getRecallContext: lanes/round/blockIds travel together; ledger is omitted and nothing is committed (B-01/G4)', async () => {
  const lanes = { round: 3, pendingHigh: [] }
  const returnedLanes = { round: 4, pendingHigh: [] }
  const blockIds = new Set(['mem-in-block'])
  const ledger = ['mem-surfaced-1', 'mem-surfaced-2']
  const engine = makeEngine(successResult([makeAddition()], {}, { mode: 'fair', lanes: returnedLanes }))
  const plugin = makePlugin({ engine, recallContext: { lanes, round: 4, blockIds, ledger } })
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(plugin.calls.contexts.length, 1, 'the one-call hook is preferred')
  assert.equal(engine.calls[0].options.paginate, true)
  assert.equal(engine.calls[0].options.lanes, lanes)
  assert.equal(engine.calls[0].options.round, 4)
  assert.deepEqual(engine.calls[0].options.blockIds, blockIds, 'block ids are passed (the only exclusion on this path)')
  // B-01: the ever-surfaced ledger would move candidates between pages, so the
  // paginated path must not forward it and must not commit the snapshot.
  assert.equal(engine.calls[0].options.ledger, undefined, 'the surfaced ledger is not used for pagination')
  assert.equal(plugin.calls.commits.length, 0)
  assert.equal(value.mode, 'fair')
  assertLosslessJson(value)
})

test('legacy rollback ignores getRecallContext too (nothing lane-shaped is passed)', async () => {
  const engine = makeEngine(successResult([makeAddition()]))
  const cfg = makeConfig({ recall: { enabled: true, mode: 'legacy' } })
  const plugin = makePlugin({
    engine,
    cfg,
    recallContext: { lanes: { round: 2 }, round: 3, blockIds: new Set(['a']), ledger: ['b'] },
  })
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.found, 1)
  assert.equal(plugin.calls.contexts.length, 0, 'legacy never reads the lane context')
  for (const key of ['lanes', 'round', 'blockIds', 'ledger']) {
    assert.equal(engine.calls[0].options[key], undefined, `legacy must not pass ${key}`)
  }
  assert.equal(plugin.calls.commits.length, 0)
})

test('throwing lane hooks never break the recall result', async () => {
  const engine = makeEngine(successResult([makeAddition()], {}, { mode: 'fair', lanes: { round: 2 } }))
  const plugin = makePlugin({ engine })
  plugin.getRecallLanes = () => {
    throw new Error('recall-state corrupt')
  }
  plugin.nextRecallRound = () => {
    throw new Error('recall-state corrupt')
  }
  plugin.commitRecallLanes = () => {
    throw new Error('disk full')
  }
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.found, 1)
  assertLosslessJson(value)
})

test('legacy rollback keeps the v1.3.0 call shape and miss accounting', async () => {
  const engine = makeEngine(
    missResult({ matchedFolders: 2, attempts: 2 }),
    missResult({ matchedFolders: 0, attempts: 0 }, { missType: 'time' }),
    successResult([makeAddition()]),
  )
  const plugin = makePlugin({
    engine,
    cfg: makeConfig({ recall: { enabled: true, mode: 'legacy' } }),
    lanes: { round: 1 },
    round: 5,
  })
  const tool = new MemoryRecallTool(plugin)

  const miss = await tool.execute({ keywords: 'x' }, exec())
  assert.equal(miss.misses, 1, 'legacy counts a matched-but-empty result as a miss')
  assert.equal(miss.timeWindow, undefined)
  assert.equal(miss.missType, undefined)
  assert.equal(miss.hasMore, false)
  assert.equal(miss.mode, 'legacy')
  assertLosslessJson(miss)
  assert.equal(engine.calls[0].options.lanes, undefined, 'legacy never gets lane options')
  assert.equal(engine.calls[0].options.round, undefined)

  // Even in legacy, a *time* miss is not a strike (the keywords were right).
  const timeMiss = await tool.execute({ keywords: 'x', timeFrom: '2026-10-31' }, exec())
  assert.equal(timeMiss.missType, 'time')
  assert.equal(timeMiss.misses, undefined, 'time misses never advance the legacy strike run')

  const found = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(found.found, 1)
  assert.equal(found.mode, 'legacy')
})

test('degraded lane state is surfaced as an observation hint (no latency promise)', async () => {
  const engine = makeEngine(successResult([makeAddition()], { degraded: true }, { mode: 'fair' }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker' }, exec())

  assert.equal(value.degraded, true)
  assertLosslessJson(value)
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('降级观测'), text)
  assert.ok(text.includes('exploreRatio'), 'the hint suggests tuning exploreRatio')
  assert.ok(text.includes('offset'), 'the hint suggests pagination as a fallback')
})

test('enforced=false (time.mode=index) is labelled as "not filtered by time", never as a time filter', async () => {
  const window = {
    from: Date.UTC(2026, 9, 30),
    to: Date.UTC(2026, 10, 2),
    level: 'day',
    enforced: false,
    timezone: 'UTC',
    requested: { from: Date.UTC(2026, 9, 31), to: Date.UTC(2026, 10, 1) },
  }
  const engine = makeEngine(successResult([makeAddition()], {}, { timeWindow: window }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker', timeFrom: '2026-10-31', timeTo: '2026-11-01' }, exec())

  assert.equal(value.timeWindow.enforced, false)
  assertLosslessJson(value)
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('未启用时间约束'), text)
  assert.ok(text.includes('time.mode=index'), text)
  assert.ok(!text.includes('时间范围：'), 'must not render as an applied time range')
  assert.ok(!text.includes('已放宽到'), 'no widening claim when the window was not enforced')
})

test('lanes are only passed together with a round (pairing rule)', async () => {
  const lanes = emptyLanesForTest()
  const engine = makeEngine(successResult([makeAddition()]))
  // A plugin that exposes lane state but no round hook (transient rollout):
  // neither option may reach the engine, so register/TTL stays consistent.
  const plugin = makePlugin({ engine, lanes })
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.found, 1)
  assert.equal(engine.calls[0].options.lanes, undefined)
  assert.equal(engine.calls[0].options.round, undefined)
  assert.equal(plugin.calls.commits.length, 0)
})

test('browse never reads or passes lanes/round/blockIds/ledger and never commits lane state', async () => {
  const engine = makeEngine(
    successResult([makeAddition()], {}, { mode: 'fair', lanes: { round: 9 }, timeWindow: { from: 1000, to: 2000, level: 'day' } }),
  )
  const plugin = makePlugin({
    engine,
    recallContext: { lanes: emptyLanesForTest(), round: 9, blockIds: new Set(['mem-x']), ledger: ['mem-y'] },
  })
  const tool = new MemoryRecallTool(plugin)

  const value = await tool.execute({ timeFrom: '2026-10-31' }, exec())
  assert.equal(value.found, 1)
  assert.equal(value.mode, 'browse')
  assert.equal(plugin.calls.contexts.length, 0, 'browse is a lookup, not a recall decision')
  for (const key of ['lanes', 'round', 'blockIds', 'ledger']) {
    assert.equal(engine.calls[0].options[key], undefined, `browse must not pass ${key}`)
  }
  assert.equal(plugin.calls.commits.length, 0, 'browse must not persist lane state')
})

/** Minimal JSON-safe LaneState for fake-engine tests (no engine dependency). */
function emptyLanesForTest() {
  return {
    frontier: [],
    exploreCursor: null,
    pendingHigh: [],
    pendingHighRound: [],
    highRecycle: [],
    recycle: [],
    degraded: false,
    round: 1,
  }
}

// ---------------------------------------------------------------------------
// v1.4.0 real-engine integration (temporary memory dir only, no real memory/)
// ---------------------------------------------------------------------------

function withRelMemoryDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-recall-tool-'))
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

const REAL_DAY_30 = Date.UTC(2026, 9, 30)
const REAL_DAY_31 = Date.UTC(2026, 9, 31)

/**
 * Hermetic real-engine environment: an `engine.recall`-wired `MemoryEngine` on a
 * temp memory dir behind a fake plugin. `withLanes` also wires the v1.4.0
 * `getRecallContext`/`commitRecallLanes` hooks (D's one-call contract) and a
 * mutable `ledgerBox` so a test can surface/un-surface ids.
 */
function makeRealEnv(dir, { folders = [], recallMode = 'fair', timeMode = 'constrain', excludeIds = [], withLanes = false } = {}) {
  const memoryDir = path.join(dir, 'memory')
  const engine = new MemoryEngine({
    memoryDir,
    config: {
      recall: { mode: recallMode, firstGenMax: 10 },
      time: { mode: timeMode, timezone: 'Asia/Shanghai', judgeEventTime: false },
    },
  })
  for (const folder of folders) {
    writeFolder(memoryDir, {
      id: folder.id,
      meta: {
        createdAt: folder.createdAt ?? REAL_DAY_31 + 3600_000,
        scored: true,
        alpha: folder.alpha ?? 0.5,
        beta: folder.beta ?? 3,
        keywords: folder.keywords ?? ['docker'],
        ...(folder.eventStart === undefined
          ? {}
          : {
              eventStart: folder.eventStart,
              eventEnd: folder.eventEnd ?? folder.eventStart + 1,
              eventTimeSource: 'messages',
            }),
      },
      messages: [{ role: 'user', content: folder.text ?? `内容 ${folder.id}` }],
    })
  }
  engine.load()
  const cfg = { ...engine.config, memoryDir }
  const laneCalls = { context: 0, commits: [] }
  const laneStore = { value: emptyLanes(), round: 0 }
  const ledgerBox = { value: [] }
  const plugin = {
    currentConfig: () => cfg,
    toolsSessionEnabled: () => true,
    scopedConfig: () => cfg,
    engineFor: () => engine,
    contextStats: () => ({ sessionId: 'session-real', chars: 200, tokens: 50, windowTokens: 1_000_000 }),
    sessionState: () => ({ recalledIds: new Set(excludeIds) }),
  }
  if (withLanes) {
    plugin.getRecallContext = () => {
      laneCalls.context += 1
      return {
        lanes: laneStore.value,
        round: laneStore.round + 1,
        blockIds: new Set(excludeIds),
        ledger: ledgerBox.value,
      }
    }
    plugin.commitRecallLanes = (session, config, lanes) => {
      laneCalls.commits.push(lanes)
      laneStore.value = lanes
      const round = Number(lanes?.round)
      if (Number.isFinite(round) && round > 0) laneStore.round = Math.trunc(round)
    }
  }
  return { memoryDir, engine, cfg, plugin, laneCalls, laneStore, ledgerBox, tool: new MemoryRecallTool(plugin) }
}

const MEMORY_FOLDERS = [
  { id: 'mem-20260101T000000Z-0001', alpha: 0.9, keywords: ['docker', '端口'], eventStart: REAL_DAY_30, eventEnd: REAL_DAY_31, text: 'DOCKER-PORT-8080' },
  { id: 'mem-20260101T000000Z-0002', alpha: 0.8, keywords: ['docker', '部署'], eventStart: REAL_DAY_31, eventEnd: REAL_DAY_31 + 1, text: 'DOCKER-DEPLOY' },
  { id: 'mem-20260101T000000Z-0003', alpha: 0.7, keywords: ['docker', '灰度'], eventStart: Date.UTC(2026, 8, 1), eventEnd: Date.UTC(2026, 8, 2), text: 'DOCKER-CANARY' },
]

test('real engine: time-only browse is chronological, mode=browse, and an empty window is a time miss (no strike)', async () => {
  await withRelMemoryDir(async (dir) => {
    const { tool } = makeRealEnv(dir, { folders: MEMORY_FOLDERS })

    const value = await tool.execute({ timeFrom: '2026-10-30', timeTo: '2026-10-31' }, exec())
    assert.equal(value.found, 2, 'both October folders fall inside the window')
    assert.equal(value.mode, 'browse')
    assert.deepEqual(value.added, ['mem-20260101T000000Z-0001', 'mem-20260101T000000Z-0002'])
    assert.deepEqual(
      value.entries.map((entry) => entry.eventStart),
      [REAL_DAY_30, REAL_DAY_31],
      'browse is sorted by event start',
    )
    assertLosslessJson(value)
    const text = textOf(render(tool, { timeFrom: '2026-10-30', timeTo: '2026-10-31' }, value))
    assert.ok(text.includes('纯时间浏览'), text)
    assert.ok(text.includes('时间范围：'), text)

    // A window with nothing in it: missType='time', no strike, ask-user hint.
    const empty = await tool.execute({ timeFrom: '2026-10-01', timeTo: '2026-10-02' }, exec())
    assert.equal(empty.found, 0)
    assert.equal(empty.missType, 'time')
    assert.equal(empty.misses, undefined, 'an empty browse window must not strike the tool')
    assert.equal(empty.stopHint, undefined)
    assertLosslessJson(empty)
    const emptyText = textOf(render(tool, { timeFrom: '2026-10-01', timeTo: '2026-10-02' }, empty))
    assert.ok(emptyText.includes('询问'), emptyText)
  })
})

test('real engine: offset/limit/hasMore paginate a deterministic fair recall', async () => {
  await withRelMemoryDir(async (dir) => {
    const { tool } = makeRealEnv(dir, { folders: MEMORY_FOLDERS })

    const first = await tool.execute({ keywords: 'docker', limit: 1 }, exec())
    assert.equal(first.found, 1)
    assert.equal(first.offset, 0)
    assert.equal(first.hasMore, true)
    assert.equal(first.nextOffset, 1)
    assert.deepEqual(first.added, ['mem-20260101T000000Z-0001'])

    const second = await tool.execute({ keywords: 'docker', limit: 1, offset: 1 }, exec())
    assert.equal(second.offset, 1)
    assert.deepEqual(second.added, ['mem-20260101T000000Z-0002'])
    assert.equal(second.hasMore, true)
    assert.equal(second.nextOffset, 2)

    const third = await tool.execute({ keywords: 'docker', limit: 1, offset: 2 }, exec())
    assert.equal(third.offset, 2)
    assert.deepEqual(third.added, ['mem-20260101T000000Z-0003'])
    assert.equal(third.hasMore, false)
    assert.equal(third.nextOffset, undefined)

    const text = textOf(render(tool, { keywords: 'docker' }, third))
    assert.ok(text.includes('本页：第 3 ～ 3 条'), text)
    assert.ok(text.includes('已到末页'), text)
  })
})

test('real engine: fair mode 3/6 strike escalation on true misses, time miss exempt', async () => {
  await withRelMemoryDir(async (dir) => {
    const { tool } = makeRealEnv(dir, { folders: MEMORY_FOLDERS })

    // A time window that excludes the keyword matches is a time miss -> no strike.
    const timeMiss = await tool.execute({ keywords: 'docker', timeFrom: '2026-10-01', timeTo: '2026-10-02' }, exec())
    assert.equal(timeMiss.found, 0)
    assert.equal(timeMiss.missType, 'time')
    assert.equal(timeMiss.misses, undefined)

    let last
    for (let attempt = 0; attempt < MISS_DISABLE_AT; attempt += 1) {
      last = await tool.execute({ keywords: `完全无关词${attempt}` }, exec())
      assert.equal(last.found, 0)
    }
    assert.equal(last.misses, MISS_DISABLE_AT)
    assert.equal(last.stopHint, DISABLED_HINT, 'the 6th true miss disables the tool')
    await assert.rejects(tool.execute({ keywords: '再一次' }, exec()), /memory_recall 本轮已停用/)
  })
})

test('real engine: getRecallContext lanes/round are read once per page and never committed (B-01)', async () => {
  await withRelMemoryDir(async (dir) => {
    const env = makeRealEnv(dir, { folders: MEMORY_FOLDERS, withLanes: true })
    const { tool, laneCalls, laneStore } = env

    const first = await tool.execute({ keywords: 'docker' }, exec())
    assert.equal(first.found, 3)
    assert.equal(laneCalls.context, 1, 'the one-call lane context is read once')
    // B-01: paginate returns the unchanged snapshot; committing it would drift.
    assert.equal(laneCalls.commits.length, 0, 'paginated recalls never commit lanes')
    assert.equal(laneStore.value.round, 0, 'the persisted round is untouched')

    const second = await tool.execute({ keywords: 'docker' }, exec())
    assert.equal(second.found, 3)
    assert.equal(laneCalls.context, 2)
    assert.equal(laneCalls.commits.length, 0)
  })
})

test('real engine: blockIds (current block) still exclude ids from paginated manual recall (B-01/G4)', async () => {
  await withRelMemoryDir(async (dir) => {
    const blockedIds = MEMORY_FOLDERS.map((folder) => folder.id)
    const env = makeRealEnv(dir, { folders: MEMORY_FOLDERS, withLanes: true, excludeIds: blockedIds })
    const { tool } = env

    // Everything is already in the injected block: the paginated path excludes
    // the block ids (the only exclusion it uses; the ledger is not consulted so
    // pages cannot drift between calls). The empty page is informational.
    const blocked = await tool.execute({ keywords: 'docker' }, exec())
    assert.equal(blocked.found, 0)
    assert.equal(blocked.misses, undefined, 'excluded-by-block is not a keyword miss')

    // Without the block ids the same query finds them again.
    const open = makeRealEnv(dir, { folders: MEMORY_FOLDERS, withLanes: true })
    const allowed = await open.tool.execute({ keywords: 'docker' }, exec())
    assert.equal(allowed.found, 3)
  })
})

test('real engine: browse reads/writes no lane state (lookup, not a recall decision)', async () => {
  await withRelMemoryDir(async (dir) => {
    const env = makeRealEnv(dir, { folders: MEMORY_FOLDERS, withLanes: true })
    const { tool, laneCalls, laneStore } = env

    const value = await tool.execute({ timeFrom: '2026-10-30', timeTo: '2026-10-31' }, exec())
    assert.equal(value.found, 2)
    assert.equal(value.mode, 'browse')
    assert.equal(laneCalls.context, 0, 'browse never reads the lane context')
    assert.equal(laneCalls.commits.length, 0, 'browse never commits lanes')
    assert.equal(laneStore.value.round, 0, 'browse leaves the round untouched')
  })
})

test('real engine: time.mode=index records the window but does not filter (rendered as unenforced)', async () => {
  await withRelMemoryDir(async (dir) => {
    const { tool } = makeRealEnv(dir, { folders: MEMORY_FOLDERS, timeMode: 'index' })

    const value = await tool.execute({ keywords: 'docker', timeFrom: '2026-10-01', timeTo: '2026-10-02' }, exec())
    assert.equal(value.found, 3, 'time.mode=index does not filter by the time window')
    assert.equal(value.timeWindow.enforced, false)
    assertLosslessJson(value)
    const text = textOf(render(tool, { keywords: 'docker' }, value))
    assert.ok(text.includes('未启用时间约束'), text)
    assert.ok(text.includes('time.mode=index'), text)
  })
})

// ---------------------------------------------------------------------------
// v1.4.0 event constraint (design §6.1)
// ---------------------------------------------------------------------------

const exactEventInfo = (count = 12) => ({
  status: 'exact',
  requested: '日本旅行',
  label: '日本旅行',
  count,
  candidates: [],
  enforced: true,
})

test('normalizeEventArg: omitted/blank = no constraint, placeholders = explicit empty, too long = error', () => {
  // Omitted / blank -> nothing is forwarded.
  for (const value of [undefined, null, '', '   ']) {
    assert.deepEqual(normalizeEventArg(value, {}), { hasEvent: false, explicitEmpty: false })
  }
  // Placeholders mean "explicitly no event" -> forwarded (telemetry empty) but
  // never constrain the query.
  for (const value of ['空', '无', '不约束', '无事件', 'NONE', 'n/a', '-', '  空  ']) {
    const parsed = normalizeEventArg(value, {})
    assert.equal(parsed.hasEvent, false, `${value} must not constrain`)
    assert.equal(parsed.explicitEmpty, true, `${value} is an explicit empty`)
    assert.equal(typeof parsed.event, 'string')
  }
  // Real labels are trimmed/collapsed and forwarded verbatim (engine canonicalizes).
  assert.deepEqual(normalizeEventArg('  日本旅行  ', {}), {
    hasEvent: true,
    explicitEmpty: false,
    event: '日本旅行',
  })
  assert.equal(normalizeEventArg('登录  重构项目', {}).event, '登录 重构项目')
  // Too long is a parameter error (silent truncation would target another event).
  const long = '日'.repeat(61)
  assert.throws(() => normalizeEventArg(long, {}), /event 过长（61 字符，最多 60 字符）/)
  assert.doesNotThrow(() => normalizeEventArg('日'.repeat(60), {}))
  assert.throws(() => normalizeEventArg('日'.repeat(11), { event: { maxLabelLength: 10 } }), /最多 10 字符/)
  assert.throws(() => normalizeEventArg(42, {}), { message: 'event must be a string' })
})

test('event is forwarded to engine.recall; event-only is a valid browse query', async () => {
  const engine = makeEngine(
    successResult([makeAddition()], {}, { mode: 'fair', eventInfo: exactEventInfo(12) }),
    successResult([makeAddition()], {}, { mode: 'fair', eventInfo: exactEventInfo(12) }),
    successResult([makeAddition()], {}, { mode: 'fair', eventInfo: exactEventInfo(12) }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const keywordEvent = await tool.execute({ keywords: 'docker', event: '日本旅行' }, exec())
  assert.equal(engine.calls[0].options.event, '日本旅行')
  assert.equal(engine.calls[0].userText, 'docker')
  assert.equal(keywordEvent.found, 1)
  assert.deepEqual(keywordEvent.eventInfo, exactEventInfo(12))
  assertLosslessJson(keywordEvent)

  const browse = await tool.execute({ event: '日本旅行' }, exec())
  assert.equal(engine.calls[1].userText, '', 'event-only browse sends no keyword text')
  assert.equal(engine.calls[1].options.event, '日本旅行')
  assert.equal(browse.mode, 'browse')
  const browseText = textOf(render(tool, { event: '日本旅行' }, browse))
  assert.ok(browseText.includes('事件浏览'), browseText)
  assert.ok(browseText.includes('本次回忆已约束事件：「日本旅行」（该事件共 12 条记忆）'), browseText)

  // Explicit "空" is forwarded (engine records status=empty) but does not make a
  // query valid on its own.
  const cleared = await tool.execute({ keywords: 'docker', event: '空' }, exec())
  assert.equal(engine.calls[2].options.event, '空')
  assert.equal(cleared.found, 1)
  await assert.rejects(tool.execute({ event: '空' }, exec()), /至少给一个/)
})

test('event exact is rendered with the constraint line; time+event render both (AND)', async () => {
  const window = { from: Date.UTC(2026, 9, 30), to: Date.UTC(2026, 10, 2), level: 'day', enforced: true, timezone: 'UTC' }
  const engine = makeEngine(
    successResult([makeAddition()], {}, { mode: 'fair', timeWindow: window, eventInfo: exactEventInfo(7) }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker', timeFrom: '2026-10-30', timeTo: '2026-10-31', event: '日本旅行' }, exec())

  assert.equal(engine.calls[0].options.event, '日本旅行')
  assert.equal(engine.calls[0].options.timeFrom, '2026-10-30')
  assertLosslessJson(value)
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('时间范围：2026-10-30 ~ 2026-11-01'), text)
  assert.ok(text.includes('本次回忆已约束事件：「日本旅行」（该事件共 7 条记忆）'), text)
  // Both constraint lines come before the entries.
  assert.ok(text.indexOf('时间范围：') < text.indexOf('### 回忆 1'), text)
  assert.ok(text.indexOf('本次回忆已约束事件：') < text.indexOf('### 回忆 1'), text)
})

test('event exact without a count still renders (tolerant to older engine shapes)', async () => {
  const engine = makeEngine(
    successResult([makeAddition()], {}, {
      mode: 'fair',
      eventInfo: { status: 'exact', requested: '日本旅行', label: '日本旅行', count: null, candidates: [], enforced: true },
    }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker', event: '日本旅行' }, exec())
  assert.equal(value.eventInfo.count, undefined)
  assertLosslessJson(value)
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('本次回忆已约束事件：「日本旅行」'), text)
  assert.ok(!text.includes('该事件共'), text)
})

test('event unknown: does not strike, suggests the 3 next steps and the closest events', async () => {
  const engine = makeEngine(
    missResult({ matchedFolders: 0 }, {
      missType: 'event',
      eventInfo: {
        status: 'unknown',
        requested: '火星旅行',
        label: null,
        count: 0,
        candidates: [{ label: '日本旅行', count: 12, score: 0.6 }],
        enforced: true,
      },
    }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: '旅行', event: '火星旅行' }, exec())

  assert.equal(value.found, 0)
  assert.equal(value.missType, 'event')
  assert.equal(value.misses, undefined, 'an unknown event is not a keyword strike')
  assert.equal(value.eventInfo.count, 0)
  assertLosslessJson(value)
  const text = textOf(render(tool, { keywords: '旅行', event: '火星旅行' }, value))
  assert.ok(text.includes('事件「火星旅行」还没有任何记忆'), text)
  assert.ok(text.includes('最接近的已有事件：日本旅行（0.60）'), text)
  assert.ok(text.includes('① 先用 memory_judge 给相关记忆打上该事件标签'), text)
  assert.ok(text.includes('② 用 event:"空" 取消事件约束'), text)
  assert.ok(text.includes('③ 询问用户属于哪个事件'), text)
})

test('event ambiguous (R5): lists similar events, never strikes, waits for the model judgement', async () => {
  const ambiguousInfo = {
    status: 'similar',
    requested: '旅行经历',
    label: null,
    count: null,
    candidates: [
      { label: '日本旅行', count: 12, score: 0.83 },
      { label: '日本出差', count: 5, score: 0.75 },
    ],
    enforced: true,
  }
  const engine = makeEngine(
    missResult({ matchedFolders: 0 }, { missType: 'event-ambiguous', eventInfo: ambiguousInfo }),
    missResult({ matchedFolders: 0 }, { missType: 'event-ambiguous', eventInfo: ambiguousInfo }),
    missResult({ matchedFolders: 0 }, { missType: 'keyword' }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const first = await tool.execute({ keywords: '旅行', event: '旅行经历' }, exec())
  assert.equal(first.missType, 'event-ambiguous')
  assert.equal(first.misses, undefined, 'ambiguous is not a strike')
  assertLosslessJson(first)
  const text = textOf(render(tool, { keywords: '旅行', event: '旅行经历' }, first))
  assert.ok(text.includes('你提交的事件「旅行经历」与已有事件高度相似'), text)
  assert.ok(text.includes('日本旅行（12 条，相似度 0.83）'), text)
  assert.ok(text.includes('日本出差（5 条，相似度 0.75）'), text)
  assert.ok(text.includes('是 → 用该事件标签重试'), text)
  assert.ok(text.includes('否 → 用 event:"空" 重新检索'), text)
  assert.ok(text.includes('无法判断 → 询问用户'), text)

  // Repeated ambiguous results still never accumulate strikes...
  const second = await tool.execute({ keywords: '旅行', event: '旅行经历' }, exec())
  assert.equal(second.misses, undefined)
  // ...while a real keyword miss starts the run.
  const realMiss = await tool.execute({ keywords: '旅行', event: '旅行经历' }, exec())
  assert.equal(realMiss.misses, 1, 'a true keyword miss still counts')
})

test('event miss (exact window, no member matches the keywords) does not strike and names the event', async () => {
  const engine = makeEngine(
    missResult({ matchedFolders: 7 }, { missType: 'event', eventInfo: exactEventInfo(12) }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker', event: '日本旅行' }, exec())

  assert.equal(value.missType, 'event')
  assert.equal(value.misses, undefined, 'event miss is not a strike')
  assertLosslessJson(value)
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('关键词命中了 7 条记忆，但都不属于事件「日本旅行」'), text)
  assert.ok(text.includes('可换一个事件名、取消事件约束（event:"空"）或询问用户'), text)
  assert.ok(!text.includes('本次回忆已约束事件'), 'the miss hint already names the event; no duplicate constraint line')
})

test('event.mode=index (status=disabled) is explained as recorded-but-not-enforced', async () => {
  const disabledInfo = { status: 'disabled', requested: '日本旅行', label: '日本旅行', count: null, candidates: [], enforced: false }
  const engine = makeEngine(successResult([makeAddition()], {}, { mode: 'fair', eventInfo: disabledInfo }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ keywords: 'docker', event: '日本旅行' }, exec())

  assert.equal(value.eventInfo.enforced, false)
  assertLosslessJson(value)
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('事件条件：日本旅行（当前 event.mode=index，只记录事件条件、未启用事件约束，本次未按事件过滤）'), text)
  assert.ok(!text.includes('本次回忆已约束事件'), 'must not claim the event was enforced')
})

test('event.askUserHint=false drops the "ask the user" suggestion from unknown/ambiguous hints', async () => {
  const cfg = makeConfig({
    recall: { enabled: true, mode: 'fair' },
    event: { askUserHint: false, maxLabelLength: 60 },
  })
  const engine = makeEngine(
    missResult({}, {
      missType: 'event',
      eventInfo: { status: 'unknown', requested: '火星旅行', label: null, count: 0, candidates: [], enforced: true },
    }),
    missResult({}, {
      missType: 'event-ambiguous',
      eventInfo: { status: 'similar', requested: '旅行经历', label: null, count: null, candidates: [{ label: '日本旅行', count: 12, score: 0.8 }], enforced: true },
    }),
  )
  const tool = new MemoryRecallTool(makePlugin({ engine, cfg }))

  const unknown = await tool.execute({ keywords: '旅行', event: '火星旅行' }, exec())
  const unknownText = textOf(render(tool, { keywords: '旅行' }, unknown))
  assert.ok(unknownText.includes('事件「火星旅行」还没有任何记忆'), unknownText)
  assert.ok(!unknownText.includes('询问用户'), unknownText)

  const ambiguous = await tool.execute({ keywords: '旅行', event: '旅行经历' }, exec())
  const ambiguousText = textOf(render(tool, { keywords: '旅行' }, ambiguous))
  assert.ok(ambiguousText.includes('与已有事件高度相似'), ambiguousText)
  assert.ok(!ambiguousText.includes('询问用户'), ambiguousText)
})

test('an overlong event argument is a parameter error before any engine call', async () => {
  const engine = makeEngine()
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  await assert.rejects(tool.execute({ keywords: 'docker', event: '日'.repeat(61) }, exec()), /event 过长/)
  assert.equal(engine.calls.length, 0, 'the engine is never called with an invalid event')
})

test('an event-only browse that finds nothing is an event miss by fallback (no strike)', async () => {
  const engine = makeEngine(missResult({ matchedFolders: 0 })) // engine did not classify the miss
  const tool = new MemoryRecallTool(makePlugin({ engine }))
  const value = await tool.execute({ event: '日本旅行' }, exec())

  assert.equal(value.mode, 'browse')
  assert.equal(value.missType, 'event')
  assert.equal(value.misses, undefined)
  assertLosslessJson(value)
  const text = textOf(render(tool, { event: '日本旅行' }, value))
  assert.ok(text.includes('没有属于事件'), text)
})

// ---------------------------------------------------------------------------
// B-01 (v1.4.1): stable manual-recall pagination (engine `opts.paginate`)
// ---------------------------------------------------------------------------

test('B-01: 30-candidate manual recall pages 3 at a time -> 30 distinct, no duplicate, no gap', async () => {
  await withRelMemoryDir(async (dir) => {
    const folders = []
    for (let index = 0; index < 30; index += 1) {
      folders.push({
        id: `mem-20260101T000000Z-${String(index + 1).padStart(4, '0')}`,
        alpha: 0.4 + (index % 5) * 0.1,
        keywords: ['docker', '部署', '端口'],
        createdAt: REAL_DAY_31 + index * 1000,
        text: `MEM-${index}-部署 docker 端口`,
      })
    }
    const { tool, laneCalls } = makeRealEnv(dir, { folders, withLanes: true })
    const seen = []
    const pages = []
    let offset = 0
    for (let guard = 0; guard < 20; guard += 1) {
      const value = await tool.execute({ keywords: '部署 docker 端口', limit: 3, offset }, exec())
      assert.equal(value.mode, 'fair')
      assert.ok(value.found <= 3, `a page never exceeds the requested limit (got ${value.found})`)
      pages.push({ offset: value.offset, found: value.found, hasMore: value.hasMore, nextOffset: value.nextOffset })
      seen.push(...value.added)
      if (!value.hasMore) break
      assert.equal(value.nextOffset, offset + value.found, 'nextOffset advances by the page size')
      offset = value.nextOffset
    }
    assert.equal(pages.length, 10, '30 candidates / limit 3 = 10 pages')
    assert.equal(seen.length, 30, 'every candidate is returned exactly once across pages')
    assert.equal(new Set(seen).size, 30, 'no duplicate id across pages')
    for (const folder of folders) assert.ok(seen.includes(folder.id), `missing ${folder.id}`)
    assert.equal(pages.at(-1).hasMore, false, 'the last page reports hasMore=false')
    for (const page of pages.slice(0, -1)) assert.equal(page.hasMore, true, 'non-last pages report hasMore=true')

    // B-01: the engine returns the unchanged lane snapshot and the adapter must
    // NOT commit it (the next page has to see the same snapshot; a commit would
    // let recall state drift between pages).
    assert.equal(laneCalls.commits.length, 0, 'no commitRecallLanes on the paginated path')
    assert.equal(laneCalls.context, 10, 'each page reads the lane snapshot')

    // Page stability: repeating one page after others never changes it.
    const firstAgain = await tool.execute({ keywords: '部署 docker 端口', limit: 3, offset: 0 }, exec())
    const firstPage = pages[0]
    assert.equal(firstAgain.found, firstPage.found)
    assert.equal(firstAgain.hasMore, firstPage.hasMore)
    assert.equal(new Set(firstAgain.added).size, 3, 'a page is always three distinct ids')
  })
})

test('B-01: an offset past the candidate count is an empty page with hasMore=false (no throw)', async () => {
  await withRelMemoryDir(async (dir) => {
    const folders = []
    for (let index = 0; index < 5; index += 1) {
      folders.push({ id: `mem-20260101T000000Z-${String(index + 1).padStart(4, '0')}`, alpha: 0.6, keywords: ['docker', '部署', '端口'], text: `MEM-${index}` })
    }
    const { tool } = makeRealEnv(dir, { folders, withLanes: true })
    const value = await tool.execute({ keywords: '部署 docker 端口', limit: 3, offset: 2500 }, exec())
    assert.equal(value.found, 0)
    assert.equal(value.hasMore, false)
    assert.equal(value.offset, 2500)
    assert.equal(value.misses, undefined, 'an out-of-range page is not a strike')
    // The engine covers the "10,000 candidates, offset 2500 is not empty" case
    // (test/recall-1.4.1-regressions.test.mjs); the adapter forwards offset/limit
    // untouched, which this call proves.
  })
})

test('B-01: legacy mode keeps the historical call shape (no paginate option)', async () => {
  const engine = makeEngine(successResult([makeAddition()], {}, { page: { offset: 0, limit: 3, returned: 1, candidates: 1, hasMore: false } }))
  const cfg = makeConfig({ recall: { enabled: true, mode: 'legacy' } })
  const tool = new MemoryRecallTool(makePlugin({ engine, cfg }))
  await tool.execute({ keywords: 'docker', limit: 3 }, exec())
  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls[0].options.paginate, undefined, 'legacy must not receive opts.paginate')
})

test('B-01: fair mode passes paginate:true together with offset/limit', async () => {
  const engine = makeEngine(successResult([], { matchedFolders: 0 }, {}))
  const cfg = makeConfig({ recall: { enabled: true, mode: 'fair' } })
  const tool = new MemoryRecallTool(makePlugin({ engine, cfg }))
  await tool.execute({ keywords: 'docker', limit: 3, offset: 6 }, exec())
  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls[0].options.paginate, true)
  assert.equal(engine.calls[0].options.offset, 6)
  assert.equal(engine.calls[0].options.limit, 3)
})

// ---------------------------------------------------------------------------
// v1.5.4: memory_recall headings follow the recall-block time caliber
// ---------------------------------------------------------------------------

test('v1.5.4: memory_recall heading labels archive time and event time under computeDates', async () => {
  const addition = makeAddition({
    meta: {
      createdAt: Date.parse('2026-04-19T13:10:00Z'),
      keywords: ['docker'],
      eventStart: Date.parse('2026-04-15T01:00:00Z'),
      eventEnd: Date.parse('2026-04-15T10:00:00Z'),
    },
  })
  addition.messages = [{ role: 'user', content: '明天上线', time: Date.parse('2026-05-27T04:00:00Z') }]
  const cfg = makeConfig({
    recall: { enabled: true, computeDates: true },
    time: { timezone: 'Asia/Shanghai' },
  })
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine(successResult([addition])), cfg }))
  const value = await tool.execute({ keywords: 'docker' }, exec())
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  // Same caliber as the automatic recall block: archive time labelled, event time
  // in parentheses — never a bare archive date that the model could copy.
  assert.match(
    text,
    /### 回忆 1 · α=0\.70 · β=\+3\.0 · 第1代 · 归档于 2026-04-19 周日 21:10（事件时间 2026-04-15 周三） · 关键词：docker/,
    text,
  )
  assert.ok(!text.includes('· 2026-04-19 21:10'), 'no bare archive date heading')

  // Legacy config (computeDates off / absent) keeps the v1.5.0 heading.
  const legacyTool = new MemoryRecallTool(makePlugin({ engine: makeEngine(successResult([addition])) }))
  const legacyValue = await legacyTool.execute({ keywords: 'docker' }, exec())
  const legacyText = textOf(render(legacyTool, { keywords: 'docker' }, legacyValue))
  assert.ok(!legacyText.includes('归档于'), legacyText)
  assert.equal(legacyValue.entries[0].archiveTimeText, undefined, 'legacy entries carry no computable labels')
})

test('v1.5.4: memory_recall heading derives the event time from message.time when meta lacks it', async () => {
  const addition = makeAddition({ meta: { createdAt: Date.parse('2026-04-19T13:10:00Z'), keywords: ['docker'] } })
  addition.messages = [
    { role: 'user', content: '第一句', time: Date.parse('2026-04-15T01:00:00Z') },
    { role: 'assistant', content: '第二句', time: Date.parse('2026-04-16T10:00:00Z') },
  ]
  const cfg = makeConfig({ recall: { enabled: true, computeDates: true }, time: { timezone: 'Asia/Shanghai' } })
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine(successResult([addition])), cfg }))
  const value = await tool.execute({ keywords: 'docker' }, exec())
  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.match(text, /归档于 2026-04-19 周日 21:10（事件时间 2026-04-15 周三 ~ 2026-04-16 周四）/, text)
})

test('v1.5.4: browse mode still labels the event start, never the archive date', async () => {
  const addition = makeAddition({
    meta: {
      createdAt: Date.parse('2026-04-19T13:10:00Z'),
      keywords: [],
      eventStart: Date.parse('2026-04-15T01:00:00Z'),
    },
  })
  const cfg = makeConfig({ recall: { enabled: true, computeDates: true }, time: { timezone: 'Asia/Shanghai' } })
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine(successResult([addition])), cfg }))
  const value = await tool.execute({ timeFrom: '2026-04-15', timeTo: '2026-04-18' }, exec())
  const text = textOf(render(tool, { timeFrom: '2026-04-15', timeTo: '2026-04-18' }, value))
  assert.match(text, /· 事件：2026-04-15 \d{2}:\d{2}/, text)
  assert.ok(!text.includes('归档于'), 'browse stays an event-time view')
})
