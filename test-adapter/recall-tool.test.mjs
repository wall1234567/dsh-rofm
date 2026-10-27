/**
 * Adapter-level tests for the model-triggered `memory_recall` tool.
 *
 * These tests never boot a harness or touch the disk: a fake plugin, fake
 * session, fake engine and fixtures stand in for the DSH side, so the tool's
 * pure seams (definition contract, engine call, render, consecutive-miss state
 * machine, image pass-through, validation) are pinned exactly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryRecallTool, MISS_DISABLE_AT, MISS_WARN_AT } from '../lib/recall-tool.js'

const SESSION = { id: 'session-recall' }

const MISS_WARNING = '可能关键词没有选对或目标回忆 α 值太低。建议停止继续尝试，或改用更具体的关键词再试一次。'
const DISABLED_HINT = '目标回忆 α 值过低或运气不行，如有需要下一轮对话再尝试。'

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

function successResult(additions, statsOverrides = {}) {
  return {
    additions,
    stats: makeStats({ matchedFolders: additions.length, attempts: additions.length, addedFolders: additions.length, ...statsOverrides }),
    warnings: [],
  }
}

function missResult({ matchedFolders = 0, attempts = 0 } = {}) {
  return { additions: [], stats: makeStats({ matchedFolders, attempts }), warnings: [] }
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
 */
function makePlugin({ engine = makeEngine(), cfg = makeConfig(), enabled = true, images = null, sessionState = undefined } = {}) {
  const plugin = {
    calls: { currentConfig: 0, toolsSessionEnabled: 0, engineFor: 0, scopedConfig: 0, resolveImages: [] },
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

test('definition exposes the memory_recall contract', () => {
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine() }))
  const definition = tool.definition()

  assert.equal(definition.name, 'memory_recall')
  assert.equal(typeof definition.description, 'string')
  assert.ok(definition.description.includes('主动回忆'), definition.description)
  assert.ok(definition.description.includes('α'), 'description mentions α')
  assert.ok(definition.description.includes('β'), 'description mentions β')
  assert.ok(definition.description.includes('停用'), 'description mentions the disable escalation')
  assert.ok(definition.description.includes('关键词'), 'description mentions keywords')

  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['keywords'])
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['keywords', 'limit'])
  assert.equal(definition.parameters.properties.keywords.type, 'string')
  assert.equal(definition.parameters.properties.limit.type, 'integer')
  assert.ok(definition.parameters.properties.limit.description.includes('1~8'))

  // The output schema is exactly the documented value shape.
  assert.equal(definition.output.schema.type, 'object')
  assert.deepEqual(Object.keys(definition.output.schema.properties).sort(), [
    'added',
    'attempted',
    'found',
    'images',
    'matchedFolders',
    'stopHint',
  ])
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

test('a miss with keyword matches hints at the α probability instead of the keywords', async () => {
  const engine = makeEngine(missResult({ matchedFolders: 2, attempts: 2 }))
  const tool = new MemoryRecallTool(makePlugin({ engine }))

  const value = await tool.execute({ keywords: 'docker' }, exec())
  assert.equal(value.matchedFolders, 2)
  assert.equal(value.attempted, 2)
  assert.equal(value.misses, 1, 'a fresh tool starts a fresh strike run')
  assert.equal(value.stopHint, undefined)

  const text = textOf(render(tool, { keywords: 'docker' }, value))
  assert.ok(text.includes('匹配到 2 条记忆'), text)
  assert.ok(text.includes('α 概率判定均未被回忆出来'), text)
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

test('empty or non-string keywords are rejected', async () => {
  const tool = new MemoryRecallTool(makePlugin({ engine: makeEngine() }))
  for (const keywords of [undefined, null, '', '   ', 42, [], {}]) {
    await assert.rejects(tool.execute({ keywords }, exec()), {
      message: 'keywords must be a non-empty string',
    })
    await assert.rejects(tool.execute({}, exec()), { message: 'keywords must be a non-empty string' })
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

test('limit is clamped to 1..8 with a default of 3', async () => {
  const additions = Array.from({ length: 10 }, (_, index) => makeAddition({ meta: { id: `mem-${index}` } }))
  const engine = makeEngine(
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

  const huge = await tool.execute({ keywords: 'x', limit: 99 }, exec())
  assert.equal(huge.found, 8, '99 clamps down to 8')
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
