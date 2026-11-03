/**
 * v1.4.1: high-α category-word guarantee for `memory_judge`.
 *
 * Requirement: a high-α preference/agreement memory ("我喜欢美式咖啡，不加糖",
 * "以后都用 9090，不要再用 8080") must keep at least one *category word*
 * (喜好/偏好/习惯/约定/承诺/决定/规则/要求/禁忌) among its keywords — otherwise the
 * natural abstract question ("我的喜好是什么" / "我们约定了什么") can never match
 * it, because rofm recall is lexical keyword matching, not semantic search.
 *
 * The judge is instructed to submit the word; when it does not, the tool detects
 * the category from the archived text and adds (or replaces the last keyword
 * with) the word, with a non-blocking warning. These tests pin both the
 * augmentation and the resulting retrieval.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { RofmPlugin } from '../lib/plugin.js'
import { MemoryJudgeTool } from '../lib/memory-tool.js'
import { writeFolder } from '../engine/index.js'

const tempDirs = []
function tempDir(prefix = 'dshr-cat-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function makeContext() {
  return {
    logger: { info() {}, warn() {}, debug() {} },
    get() { return undefined },
    on() { return () => {} },
    effect(callback) { return callback() },
  }
}

function makePlugin(memoryDir, scoringOverrides = {}) {
  const plugin = new RofmPlugin(makeContext(), {
    enabled: true,
    storage: { dir: memoryDir, perSession: false },
    recall: { enabled: true, mode: 'fair' },
    compress: { enabled: false },
    logging: { enabled: false },
    compat: { qqBots: 'off' },
    scoring: scoringOverrides,
  })
  return plugin
}

const CURRENT_MS = 1_800_000_000_000

/** Create one pending ("待评分") folder, like the archiver does. */
function makePendingFolder(memoryDir, id, text, title = '') {
  const messages = [{ role: 'user', content: text }]
  const meta = {
    version: 1,
    id,
    createdAt: CURRENT_MS,
    alpha: 0,
    beta: 0,
    scored: false,
    keywords: [],
    title: title || text.slice(0, 24),
    alphaSource: 'pending',
    betaSource: 'pending',
    keywordsSource: 'pending',
    stats: { messages: messages.length, chars: text.length, tokens: 20 },
    source: { sessionId: 'session-cat', turn: 1, seqStart: 0, seqEnd: 0 },
  }
  writeFolder(memoryDir, { id, meta, messages })
  return { id, meta, messages }
}

async function judge(plugin, session, updates) {
  const tool = new MemoryJudgeTool(plugin)
  return tool.execute({ updates }, { agent: { session } })
}

function readMeta(plugin, session, id) {
  const engine = plugin.engineFor(session, plugin.currentConfig())
  return engine.readFolder(id)?.meta ?? {}
}

test('high-α preference without a category word gets「喜好」added and becomes retrievable', async () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const plugin = makePlugin(memoryDir)
  const session = { id: 'session-cat', header: { origin: 'main' } }
  const folder = makePendingFolder(memoryDir, 'mem-20261103T000000Z-0001', '我喜欢美式咖啡，不加糖，最好早上喝。')
  plugin.engineFor(session, plugin.currentConfig()).reload()

  const result = await judge(plugin, session, [{
    id: folder.id,
    alpha: 0.8,
    beta: 2,
    keywords: ['美式咖啡', '不加糖', '早餐'],
  }])

  assert.deepEqual(result.updated, [folder.id])
  assert.equal(result.rejected.length, 0)
  const meta = readMeta(plugin, session, folder.id)
  assert.equal(meta.scored, true)
  assert.ok(meta.keywords.includes('喜好'), `category word added (got ${JSON.stringify(meta.keywords)})`)
  assert.equal(meta.keywordCategory, '喜好')
  assert.ok(result.warnings.some((warning) => warning.includes('category-keyword-added')), 'model is told the word was added')

  // Retrieval proof: the natural abstract question now matches lexically.
  const engine = plugin.engineFor(session, plugin.currentConfig())
  const recall = engine.recall('我的喜好是什么？', { chars: 20000, windowTokens: 128000 }, {})
  assert.ok(recall.additions.some((addition) => addition.id === folder.id), 'asking「我的喜好」now recalls the memory')
})

test('Plan A: a synonym category word bridges the query (偏好 folder, 喜好 question)', async () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const plugin = makePlugin(memoryDir)
  const session = { id: 'session-cat', header: { origin: 'main' } }
  // The model submits the synonym 「偏好」 itself (no auto-add needed): the
  // deterministic category layer must still bridge 「我的喜好是什么」.
  const folder = makePendingFolder(memoryDir, 'mem-20261103T000000Z-0009', '我偏好美式咖啡，不加糖。')
  plugin.engineFor(session, plugin.currentConfig()).reload()

  await judge(plugin, session, [{ id: folder.id, alpha: 0.85, beta: 2, keywords: ['偏好', '美式咖啡', '不加糖'] }])
  const meta = readMeta(plugin, session, folder.id)
  assert.equal(meta.keywordCategory, undefined, 'no auto-add: the submitted keyword already carries the class')
  assert.ok(meta.keywords.includes('偏好'))

  const engine = plugin.engineFor(session, plugin.currentConfig())
  const recall = engine.recall('我的喜好是什么？', { chars: 20000, windowTokens: 128000 }, {})
  assert.ok(recall.additions.some((addition) => addition.id === folder.id), 'synonym bridge recalls the 偏好 memory')
  assert.deepEqual(recall.stats.categorySeeds, ['preference'])
})

test('high-α agreement gets「约定」and an unrelated category word is not invented', async () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const plugin = makePlugin(memoryDir)
  const session = { id: 'session-cat', header: { origin: 'main' } }
  const agreement = makePendingFolder(memoryDir, 'mem-20261103T000000Z-0002', '以后都用 9090 端口，不要再用 8080。')
  const plain = makePendingFolder(memoryDir, 'mem-20261103T000000Z-0003', '明天可能下雨，出门记得带伞。')
  plugin.engineFor(session, plugin.currentConfig()).reload()

  await judge(plugin, session, [
    { id: agreement.id, alpha: 0.75, beta: 3, keywords: ['端口', '9090', '部署'] },
    { id: plain.id, alpha: 0.7, beta: 0, keywords: ['天气', '下雨', '雨伞'] },
  ])

  const agreementMeta = readMeta(plugin, session, agreement.id)
  assert.ok(agreementMeta.keywords.includes('约定'), `agreement category word added (got ${JSON.stringify(agreementMeta.keywords)})`)
  const plainMeta = readMeta(plugin, session, plain.id)
  assert.equal(plainMeta.keywordCategory, undefined, 'no category word is invented for a text without markers')
  assert.equal(plainMeta.keywords.length, 3, 'plain text keywords are untouched')

  const engine = plugin.engineFor(session, plugin.currentConfig())
  const recall = engine.recall('我们约定了什么端口？', { chars: 20000, windowTokens: 128000 }, {})
  assert.ok(recall.additions.some((addition) => addition.id === agreement.id), 'asking「约定了什么」now recalls the agreement')
})

test('low-α memories are not touched by the category-word guarantee', async () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const plugin = makePlugin(memoryDir)
  const session = { id: 'session-cat', header: { origin: 'main' } }
  const folder = makePendingFolder(memoryDir, 'mem-20261103T000000Z-0004', '我其实喜欢喝咖啡，不过这不重要。')
  plugin.engineFor(session, plugin.currentConfig()).reload()

  await judge(plugin, session, [{ id: folder.id, alpha: 0.2, beta: 0, keywords: ['咖啡', '闲聊', '不重要'] }])
  const meta = readMeta(plugin, session, folder.id)
  assert.equal(meta.keywords.includes('喜好'), false, 'low-α keywords are not padded')
  assert.equal(meta.keywordCategory, undefined)
})

test('a submitted category word is not duplicated', async () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const plugin = makePlugin(memoryDir)
  const session = { id: 'session-cat', header: { origin: 'main' } }
  const folder = makePendingFolder(memoryDir, 'mem-20261103T000000Z-0005', '我喜欢喝咖啡。')
  plugin.engineFor(session, plugin.currentConfig()).reload()

  const result = await judge(plugin, session, [{ id: folder.id, alpha: 0.9, beta: 2, keywords: ['喜好', '咖啡', '早餐'] }])
  const meta = readMeta(plugin, session, folder.id)
  assert.deepEqual(meta.keywords, ['喜好', '咖啡', '早餐'])
  assert.equal(result.warnings.some((warning) => warning.includes('category-keyword')), false)
})

test('at the 8-keyword cap the last keyword is replaced (with a warning) instead of exceeding the cap', async () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const plugin = makePlugin(memoryDir)
  const session = { id: 'session-cat', header: { origin: 'main' } }
  const folder = makePendingFolder(memoryDir, 'mem-20261103T000000Z-0006', '我喜欢美式咖啡，不加糖。')
  plugin.engineFor(session, plugin.currentConfig()).reload()

  const eight = ['美式咖啡', '不加糖', '早餐', '早晨', '提神', '饮品', '口味', '替换我']
  const result = await judge(plugin, session, [{ id: folder.id, alpha: 0.8, beta: 1, keywords: eight }])
  const meta = readMeta(plugin, session, folder.id)
  assert.equal(meta.keywords.length, 8, 'keyword cap is respected')
  assert.ok(meta.keywords.includes('喜好'))
  assert.equal(meta.keywords.includes('替换我'), false, 'the least-important-looking last keyword made room')
  assert.ok(result.warnings.some((warning) => warning.includes('category-keyword-replaced')))
})

test('scoring.categoryKeyword.enabled=false disables the guarantee', async () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const plugin = makePlugin(memoryDir, { categoryKeyword: { enabled: false } })
  const session = { id: 'session-cat', header: { origin: 'main' } }
  const folder = makePendingFolder(memoryDir, 'mem-20261103T000000Z-0007', '我喜欢美式咖啡，不加糖。')
  plugin.engineFor(session, plugin.currentConfig()).reload()

  await judge(plugin, session, [{ id: folder.id, alpha: 0.8, beta: 1, keywords: ['美式咖啡', '不加糖', '早餐'] }])
  const meta = readMeta(plugin, session, folder.id)
  assert.equal(meta.keywords.includes('喜好'), false)
  assert.equal(meta.keywordCategory, undefined)
})

test('a partial α/β review (no keywords submitted) does not rewrite the keyword list', async () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const plugin = makePlugin(memoryDir)
  const session = { id: 'session-cat', header: { origin: 'main' } }
  const folder = makePendingFolder(memoryDir, 'mem-20261103T000000Z-0008', '我喜欢美式咖啡，不加糖。')
  plugin.engineFor(session, plugin.currentConfig()).reload()

  await judge(plugin, session, [{ id: folder.id, alpha: 0.8, beta: 2, keywords: ['美式咖啡', '不加糖', '早餐'] }])
  await judge(plugin, session, [{ id: folder.id, alpha: 0.9 }])
  const meta = readMeta(plugin, session, folder.id)
  assert.equal(meta.alpha, 0.9, 'partial review applied')
  assert.ok(meta.keywords.includes('喜好'), 'existing category word kept')
  assert.equal(meta.keywords.length, 4)
})
