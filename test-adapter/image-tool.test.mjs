/**
 * Adapter-level tests for the model-triggered `memory_image` tool.
 *
 * These tests never boot a harness and never touch the disk: a fake plugin,
 * fake session and fixtures stand in for the DSH/plugin side, so the tool's pure
 * seams stay pinned — definition contract, the `plugin.listArchivedImages()`
 * call, filtering (query / memoryId / name), sorting, limit clamping, render
 * text (paths only, no image blocks) and error handling.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_IMAGE_LIMIT,
  MAX_IMAGE_LIMIT,
  MemoryImageTool,
  normalizeImageLimit,
  renderImageResult,
} from '../lib/image-tool.js'

const SESSION = { id: 'session-image' }
const CONFIG = { enabled: true }

const exec = (session = SESSION) => ({ agent: { session } })

/** Temp absolute paths: the files need not exist (the tool only renders them). */
const IMAGE_DIR = path.join(os.tmpdir(), 'dsh-rofm-image-tool-test')
const imagePath = (name) => path.join(IMAGE_DIR, name)

const T1 = Date.UTC(2026, 9, 20, 1, 2, 3)
const T2 = T1 + 60_000
const T3 = T2 + 60_000

function makeEntry(overrides = {}) {
  const name = overrides.name ?? 'img-12-0.png'
  return {
    name,
    path: imagePath(name),
    exists: true,
    mediaType: 'image/png',
    width: 1280,
    height: 720,
    bytes: 204800,
    folderId: 'mem-20261020T010203Z-0001',
    createdAt: T1,
    keywords: ['部署', 'docker'],
    title: '部署配置讨论',
    ...overrides,
  }
}

/** Three archived images spread over time, with distinct keyword/title/name sets. */
const ENTRIES = [
  makeEntry({ name: 'img-12-0.png' }),
  makeEntry({
    name: 'img-20-1.jpg',
    mediaType: 'image/jpeg',
    width: 800,
    height: 600,
    bytes: 51200,
    folderId: 'mem-20261020T020203Z-0002',
    createdAt: T2,
    keywords: ['截图', '端口'],
    title: '端口截图与配置',
  }),
  makeEntry({
    name: 'img-30-0.webp',
    mediaType: 'image/webp',
    width: 640,
    height: 480,
    bytes: 30720,
    folderId: 'mem-20261020T030203Z-0003',
    createdAt: T3,
    keywords: [],
    title: '无关键词的截图',
  }),
]

/**
 * Fake plugin: `listArchivedImages` records its call and returns the fixture
 * array, exactly like the real helper returns the merged image index.
 */
function makePlugin(entries = ENTRIES, overrides = {}) {
  const listCalls = []
  return {
    listCalls,
    currentConfig: () => CONFIG,
    toolsSessionEnabled: () => true,
    listArchivedImages: async (session, cfg) => {
      listCalls.push({ session, cfg })
      return entries
    },
    ...overrides,
  }
}

function makeTool(plugin = makePlugin()) {
  return new MemoryImageTool(plugin)
}

/** Run one tool call; returns the value, its definition and the fake plugin. */
async function runTool(args, options = {}) {
  const plugin = options.plugin ?? makePlugin(options.entries)
  const definition = new MemoryImageTool(plugin).definition()
  const value = await definition.execute(args, options.exec ?? exec())
  return { value, definition, plugin }
}

const TOOL_DESCRIPTION =
  '查找 dsh-rofm 已归档的图片在文件系统中的位置。回忆块里的图片只给出文件名与路径提示；' +
  '用本工具可按关键词/记忆 id/文件名定位图片文件，然后用 read_image 查看。' +
  '返回图片的绝对路径、所属记忆 id、媒体类型/尺寸/字节数。'

test('definition: name, optional parameters, 5s timeout and read-only concurrency', () => {
  const definition = makeTool().definition()
  assert.equal(definition.name, 'memory_image')
  assert.equal(definition.description, TOOL_DESCRIPTION)
  assert.ok(definition.description.includes('read_image'))
  assert.equal(definition.parameters.type, 'object')
  // Every filter is optional: no required parameters at all.
  assert.deepEqual(definition.parameters.required ?? [], [])
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['limit', 'memoryId', 'name', 'query'])
  assert.equal(definition.parameters.properties.limit.type, 'integer')
  assert.equal(definition.parameters.properties.limit.description, '1~20，默认 10')
  assert.equal(definition.timeoutMs, 5000)
  assert.equal(definition.isConcurrencySafe(), true)
  assert.equal(typeof definition.execute, 'function')
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(definition.output.schema.properties.found.type, 'number')
  assert.equal(definition.output.schema.properties.images.type, 'array')
  const itemProps = definition.output.schema.properties.images.items.properties
  for (const key of ['name', 'path', 'exists', 'mediaType', 'width', 'height', 'bytes', 'folderId', 'createdAt', 'keywords', 'title']) {
    assert.ok(itemProps[key], `images.items.properties.${key} is missing`)
  }
})

test('execute: passes the session and config to plugin.listArchivedImages', async () => {
  const { plugin } = await runTool({})
  assert.equal(plugin.listCalls.length, 1)
  assert.equal(plugin.listCalls[0].session, SESSION)
  assert.equal(plugin.listCalls[0].cfg, CONFIG)
})

test('execute: no filter returns the most recently archived images first', async () => {
  const { value } = await runTool({})
  assert.equal(value.found, 3)
  assert.deepEqual(value.images.map((image) => image.name), ['img-30-0.webp', 'img-20-1.jpg', 'img-12-0.png'])
  assert.deepEqual(value.images.map((image) => image.createdAt), [T3, T2, T1])
})

test('execute: equal timestamps break ties by file name', async () => {
  const entries = [makeEntry({ name: 'b.png', createdAt: T1 }), makeEntry({ name: 'a.png', createdAt: T1 })]
  const { value } = await runTool({}, { entries })
  assert.deepEqual(value.images.map((image) => image.name), ['a.png', 'b.png'])
})

test('execute: name is a case-insensitive substring filter', async () => {
  const hit = await runTool({ name: 'IMG-20' })
  assert.deepEqual(hit.value.images.map((image) => image.name), ['img-20-1.jpg'])
  const full = await runTool({ name: 'img-30-0.webp' })
  assert.deepEqual(full.value.images.map((image) => image.name), ['img-30-0.webp'])
  const miss = await runTool({ name: 'IMG-99' })
  assert.equal(miss.value.found, 0)
  assert.deepEqual(miss.value.images, [])
})

test('execute: memoryId is an exact folder id filter', async () => {
  const exact = await runTool({ memoryId: 'mem-20261020T020203Z-0002' })
  assert.deepEqual(exact.value.images.map((image) => image.name), ['img-20-1.jpg'])
  // A prefix/substring of a valid id is not a match.
  const partial = await runTool({ memoryId: 'mem-20261020T020203Z' })
  assert.equal(partial.value.found, 0)
})

test('execute: query matches memory keywords case-insensitively', async () => {
  const upper = await runTool({ query: 'DOCKER' })
  assert.deepEqual(upper.value.images.map((image) => image.name), ['img-12-0.png'])
  const chinese = await runTool({ query: '部署' })
  assert.deepEqual(chinese.value.images.map((image) => image.name), ['img-12-0.png'])
})

test('execute: query matches the memory title', async () => {
  const { value } = await runTool({ query: '无关键词的' })
  assert.deepEqual(value.images.map((image) => image.name), ['img-30-0.webp'])
})

test('execute: query matches the image file name', async () => {
  const { value } = await runTool({ query: 'img-30' })
  assert.deepEqual(value.images.map((image) => image.name), ['img-30-0.webp'])
})

test('execute: query terms are OR-ed (any term may match)', async () => {
  const { value } = await runTool({ query: '不存在的词 端口' })
  assert.deepEqual(value.images.map((image) => image.name), ['img-20-1.jpg'])
})

test('execute: name + memoryId + query combine with AND', async () => {
  const hit = await runTool({ name: 'img-12', memoryId: 'mem-20261020T010203Z-0001', query: 'docker' })
  assert.deepEqual(hit.value.images.map((image) => image.name), ['img-12-0.png'])
  const miss = await runTool({ memoryId: 'mem-20261020T020203Z-0002', query: 'docker' })
  assert.equal(miss.value.found, 0)
})

test('normalizeImageLimit: default 10 and clamp to 1..20', () => {
  assert.equal(DEFAULT_IMAGE_LIMIT, 10)
  assert.equal(MAX_IMAGE_LIMIT, 20)
  assert.equal(normalizeImageLimit(undefined), 10)
  assert.equal(normalizeImageLimit(null), 10)
  assert.equal(normalizeImageLimit(''), 10)
  assert.equal(normalizeImageLimit('abc'), 10)
  assert.equal(normalizeImageLimit(Number.NaN), 10)
  assert.equal(normalizeImageLimit(0), 1)
  assert.equal(normalizeImageLimit(-5), 1)
  assert.equal(normalizeImageLimit(7), 7)
  assert.equal(normalizeImageLimit('7'), 7)
  assert.equal(normalizeImageLimit(25), 20)
})

test('execute: limit defaults to 10 and is clamped to 1..20', async () => {
  const entries = Array.from({ length: 25 }, (_, index) =>
    makeEntry({ name: `bulk-${String(index).padStart(2, '0')}.png`, createdAt: T1 + index * 1000 }),
  )
  const byDefault = await runTool({}, { entries })
  assert.equal(byDefault.value.found, 10)
  assert.equal(byDefault.value.matched, 25)
  const low = await runTool({ limit: 0 }, { entries })
  assert.equal(low.value.found, 1)
  const high = await runTool({ limit: 9999 }, { entries })
  assert.equal(high.value.found, 20)
  const explicit = await runTool({ limit: 3 }, { entries })
  assert.equal(explicit.value.found, 3)
})

test('execute: a non-array listing reads as no images', async () => {
  const plugin = makePlugin(ENTRIES, { listArchivedImages: async () => null })
  const value = await makeTool(plugin).execute({}, exec())
  assert.equal(value.found, 0)
  assert.deepEqual(value.images, [])
})

test('execute: missing session throws', async () => {
  const tool = makeTool()
  await assert.rejects(() => tool.execute({}, undefined), /memory_image requires an active session/)
  await assert.rejects(() => tool.execute({}, {}), /memory_image requires an active session/)
  await assert.rejects(() => tool.execute({}, { agent: {} }), /memory_image requires an active session/)
})

test('execute: disabled session throws before listing', async () => {
  const plugin = makePlugin(ENTRIES, { toolsSessionEnabled: () => false })
  await assert.rejects(() => makeTool(plugin).execute({}, exec()), /dsh-rofm is disabled for this session/)
  assert.equal(plugin.listCalls.length, 0)
})

test('execute: a missing listing helper throws a clear error', async () => {
  const plugin = makePlugin()
  delete plugin.listArchivedImages
  await assert.rejects(() => makeTool(plugin).execute({}, exec()), /image archive listing is unavailable/)
})

test('execute: an unattached tool throws', async () => {
  const tool = new MemoryImageTool(undefined)
  await assert.rejects(() => tool.execute({}, exec()), /not attached to a dsh-rofm plugin/)
})

test('render: an empty result shows the no-match hint as one text block', async () => {
  const { value, definition } = await runTool({}, { entries: [] })
  assert.equal(value.found, 0)
  const blocks = definition.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('## 归档图片（0 张）'))
  assert.ok(blocks[0].text.includes('没有找到匹配的归档图片'))
})

test('render: lists absolute path, memory id, size and the read_image note', async () => {
  const { value, definition } = await runTool({ name: 'img-12' })
  const blocks = definition.output.render({ name: 'img-12' }, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  // Path-based by design: never an image block (the host read_image tool reads it).
  assert.ok(!blocks.some((block) => block.type === 'image'))
  const text = blocks[0].text
  assert.ok(text.includes('## 归档图片（1 张）'))
  assert.ok(text.includes('- img-12-0.png（image/png, 1280x720, 204800 B）'))
  assert.ok(text.includes(`  文件：${imagePath('img-12-0.png')}`))
  assert.match(text, /  记忆：mem-20261020T010203Z-0001 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  assert.ok(text.includes('关键词：部署、docker'))
  assert.ok(text.includes('用 read_image 读取「文件：」路径即可查看图片'))
  assert.ok(text.includes('路径不存在时说明图片已被删除'))
})

test('render: missing files are marked and do not crash', async () => {
  const entries = [makeEntry({ name: 'gone.png', exists: false })]
  const { value, definition } = await runTool({}, { entries })
  assert.equal(value.images[0].exists, false)
  const text = definition.output.render({}, value)[0].text
  assert.ok(text.includes(`文件：${imagePath('gone.png')}（缺失）`))
  assert.ok(text.includes('read_image'))
})

test('render: truncation by limit is disclosed', async () => {
  const entries = Array.from({ length: 12 }, (_, index) =>
    makeEntry({ name: `bulk-${index}.png`, createdAt: T1 + index * 1000 }),
  )
  const { value, definition } = await runTool({ limit: 2 }, { entries })
  assert.equal(value.found, 2)
  assert.equal(value.matched, 12)
  const text = definition.output.render({}, value)[0].text
  assert.ok(text.includes('共匹配 12 张'))
  assert.ok(text.includes('只显示前 2 张'))
})

test('execute: malformed listing entries are normalized or skipped', async () => {
  const entries = [
    null,
    undefined,
    'not-an-entry',
    {},
    { name: 'x.png', keywords: 'oops', width: -5, height: 'nope', bytes: null, createdAt: 'bad' },
    makeEntry({ name: 'keep.png' }),
  ]
  const plugin = makePlugin(ENTRIES, { listArchivedImages: async () => entries })
  const value = await makeTool(plugin).execute({}, exec())
  // Entries without a name are dropped; the newest-first order keeps keep.png first.
  assert.deepEqual(value.images.map((image) => image.name), ['keep.png', 'x.png'])
  assert.deepEqual(value.images[1], {
    name: 'x.png',
    path: '',
    exists: false,
    mediaType: '',
    width: 0,
    height: 0,
    bytes: 0,
    folderId: '',
    createdAt: 0,
    keywords: [],
    title: '',
  })
})

test('execute: result is lossless JSON (no undefined or class instances)', async () => {
  const { value } = await runTool({})
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  for (const image of value.images) {
    assert.equal(typeof image.name, 'string')
    assert.equal(typeof image.path, 'string')
    assert.equal(typeof image.exists, 'boolean')
    assert.equal(typeof image.mediaType, 'string')
    assert.equal(typeof image.width, 'number')
    assert.equal(typeof image.height, 'number')
    assert.equal(typeof image.bytes, 'number')
    assert.equal(typeof image.folderId, 'string')
    assert.equal(typeof image.createdAt, 'number')
    assert.ok(Array.isArray(image.keywords))
    assert.equal(typeof image.title, 'string')
  }
})

test('renderImageResult: tolerates a missing value', () => {
  const blocks = renderImageResult({}, undefined)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('## 归档图片（0 张）'))
  assert.ok(blocks[0].text.includes('没有找到'))
})
