/**
 * Adapter-level tests for the v1.4.2 `memory_group_recall` tool.
 *
 * The tool is the only path that lets an **owner QQ private chat** read **group**
 * memories. These tests pin the directional privacy model (SPEC v1.4.2 §2/§3):
 *
 *   - owner private → group memory: allowed, keyword/group/time/listGroups;
 *   - group chat / WebUI / non-owner / ownerIds:[] → rejected **before any store
 *     IO** (the fake config's `memoryDir` getter proves it is never read);
 *   - private + WebUI decoy stores carrying the same keyword never leak;
 *   - group / readdir names only: the `group` argument cannot traverse paths;
 *   - the store is read-only (before/after content hash + mtime preserved, no new
 *     files);
 *   - registration is gated by compat active + `compat.crossChat.enabled`.
 *
 * All memory stores live in a tmpdir; a fake plugin stands in for the DSH side
 * except for the explicit registration tests, which boot the real RofmPlugin with
 * a mocked host context (like plugin-mock.test.mjs).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RofmPlugin } from '../lib/plugin.js'
import { DEFAULT_COMPAT_CONFIG, compatDefaults, normalizeCompatConfig } from '../lib/compat.js'
import {
  MAX_GROUP_RECALL_LIMIT,
  MAX_GROUP_RECALL_OFFSET,
  MemoryGroupRecallTool,
  authorizeCrossChatSession,
  crossChatSettings,
  normalizeGroupRecallLimit,
  normalizeGroupRecallOffset,
  parseTimeBoundary,
  renderGroupRecallResult,
} from '../lib/cross-chat-tool.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// Fake QQ ids only — never a real owner id. The tests inject them through the
// row config (`compat.ownerIds`), so no machine-local value is needed here (and
// tools/privacy-check.mjs stays clean).
const OWNER = '10001'
const NON_OWNER = '888888'
const GROUP_A = '1134030529'
const GROUP_B = '998877'
const GROUP_C = '555000111'

const T_1020 = Date.parse('2026-10-20T04:00:00.000Z')
const T_1101 = Date.parse('2026-11-01T01:00:00.000Z')
const T_1102 = Date.parse('2026-11-02T14:35:00.000Z')
const MINUTE = 60 * 1000

const folder = (id, options = {}) => ({
  id,
  createdAt: options.createdAt ?? T_1102,
  alpha: options.alpha ?? 0.5,
  keywords: options.keywords ?? [],
  title: options.title ?? '',
  messages: options.messages ?? [{ role: 'user', content: '测试内容' }],
  eventStart: options.eventStart,
  scored: options.scored !== false,
})

/** Group A: mixed keywords + one unscored sentinel + one eventStart-only folder. */
const GROUP_A_FOLDERS = [
  folder('mem-20261102T143500Z-0001', {
    createdAt: T_1102,
    alpha: 0.8,
    keywords: ['部署', '端口', '回滚'],
    title: '部署端口约定',
    messages: [
      { role: 'user', content: '我们约定部署端口用 8080，docker 容器映射 8080:8080' },
      { role: 'assistant', content: '收到，部署端口 8080 已记录' },
    ],
  }),
  folder('mem-20261020T040000Z-0002', {
    createdAt: T_1020,
    alpha: 0.3,
    keywords: ['数据库', '迁移'],
    title: '数据库迁移',
    messages: [{ role: 'user', content: '数据库迁移安排在周五晚上' }],
  }),
  folder('mem-20261101T010000Z-0003', {
    createdAt: T_1101,
    alpha: 0.5,
    keywords: ['部署', '域名'],
    title: '部署域名切换',
    messages: [{ role: 'user', content: '部署域名切换到 api.example.com' }],
  }),
  folder('mem-20261001T000000Z-0004', {
    createdAt: Date.parse('2026-10-01T00:00:00.000Z'),
    eventStart: T_1102 + 60 * MINUTE,
    alpha: 0.4,
    keywords: ['事件时间'],
    title: '事件时间记忆',
    messages: [{ role: 'user', content: '这条记忆的事件时间在 11 月' }],
  }),
  folder('mem-20261025T000000Z-0005', {
    createdAt: T_1020,
    alpha: 0.9,
    keywords: ['未评分'],
    title: '未评分记忆',
    scored: false,
    messages: [{ role: 'user', content: 'UNSCORED-SECRET 未评分记忆不可见' }],
  }),
]

/** Group B: same keyword as A (cross-group aggregation), distinct content. */
const GROUP_B_FOLDERS = [
  folder('mem-20261102T090000Z-0011', {
    createdAt: T_1102 - 60 * MINUTE,
    alpha: 0.5,
    keywords: ['部署', '域名'],
    title: 'B 群部署讨论',
    messages: [{ role: 'user', content: 'B 群讨论部署与域名绑定 api.example.org' }],
  }),
]

/** 25 bulk folders for pagination/limit clamping. */
const GROUP_C_FOLDERS = Array.from({ length: 25 }, (_, index) =>
  folder(`mem-20260901T000000Z-${String(index).padStart(4, '0')}`, {
    createdAt: Date.parse('2026-09-01T00:00:00.000Z') + index * MINUTE,
    alpha: 0.1 + index * 0.01,
    keywords: ['批量'],
    title: `批量记忆 ${index}`,
    messages: [{ role: 'user', content: `批量记忆正文 ${index}` }],
  }),
)

/** Private-chat / WebUI decoy stores: same keyword, must never leak. */
const DECOYS = [
  { name: `onebot-private-${OWNER}`, marker: 'PRIVATE-ONLY-SECRET', keyword: '部署' },
  { name: 'qqb-p-777', marker: 'DERPYU-PRIVATE-SECRET', keyword: '部署' },
  { name: 'session-webui-secret', marker: 'WEBUI-ONLY-SECRET', keyword: '部署' },
]

function withTempDirAsync(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-cross-chat-'))
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
}

/** Write one memory store (`<memoryDir>/sessions/<chatKey>`) with folders. */
function writeStore(memoryDir, chatKey, folders) {
  const storeDir = path.join(memoryDir, 'sessions', chatKey)
  mkdirSync(storeDir, { recursive: true })
  const indexFolders = []
  for (const entry of folders) {
    const dir = path.join(storeDir, entry.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'context.json'),
      JSON.stringify({ version: 1, id: entry.id, createdAt: entry.createdAt, messages: entry.messages }),
    )
    writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        version: 1,
        id: entry.id,
        createdAt: entry.createdAt,
        alpha: entry.alpha,
        keywords: entry.keywords,
        title: entry.title,
        scored: entry.scored,
      }),
    )
    indexFolders.push({
      id: entry.id,
      createdAt: entry.createdAt,
      alpha: entry.alpha,
      beta: 0,
      keywords: entry.keywords,
      title: entry.title,
      scored: entry.scored,
      ...(entry.eventStart === undefined ? {} : { eventStart: entry.eventStart }),
    })
  }
  writeFileSync(path.join(storeDir, 'index.json'), JSON.stringify({ version: 1, updatedAt: 1, folders: indexFolders }))
  return storeDir
}

/** Seed every group store + the private/WebUI decoys + ignored entries. */
function seedMemory(memoryDir) {
  writeStore(memoryDir, `onebot-group-${GROUP_A}`, GROUP_A_FOLDERS)
  writeStore(memoryDir, `qqb-g-${GROUP_B}`, GROUP_B_FOLDERS)
  writeStore(memoryDir, `onebot-group-${GROUP_C}`, GROUP_C_FOLDERS)
  for (const decoy of DECOYS) {
    writeStore(memoryDir, decoy.name, [
      folder(`mem-20261102T000000Z-${Math.abs(decoy.marker.length)}`, {
        createdAt: T_1102,
        alpha: 0.99,
        keywords: [decoy.keyword],
        title: decoy.marker,
        messages: [{ role: 'user', content: `${decoy.marker} ${decoy.keyword}` }],
      }),
    ])
  }
  // Ignored shapes: dot dir, plain file, non-group name.
  mkdirSync(path.join(memoryDir, 'sessions', '.hidden'), { recursive: true })
  writeFileSync(path.join(memoryDir, 'sessions', 'onebot-group-as-a-file'), 'not a directory')
  writeFileSync(path.join(memoryDir, 'index.json'), JSON.stringify({ version: 1, folders: [] }))
}

// ---------------------------------------------------------------------------
// fake plugin / config
// ---------------------------------------------------------------------------

const DEFAULT_CROSS_CHAT = {
  enabled: true,
  ownerOnly: true,
  maxResults: 20,
  maxSnippetChars: 400,
  maxGroups: 50,
  maxFoldersPerGroup: 5000,
}

/**
 * Fake plugin. `memoryDir` is an accessor so a rejection test can prove the tool
 * never even reads the store root ("authorize before IO").
 */
function makePlugin(options = {}) {
  const config = {
    enabled: options.enabled ?? true,
    memoryDir: options.memoryDir,
    storage: { perSession: options.perSession ?? true },
    compat: {
      qqBots: options.qqBots ?? 'on',
      ownerIds: options.ownerIds ?? [OWNER],
      crossChat: { ...DEFAULT_CROSS_CHAT, ...(options.crossChat ?? {}) },
      ...(options.compatExtras ?? {}),
    },
  }
  const memoryDir = options.memoryDir
  const plugin = {
    config,
    memoryDirReads: 0,
    currentConfig() {
      return config
    },
    toolsSessionEnabled: () => options.sessionEnabled ?? true,
    compatDetectionNow: () => options.detection ?? { enabled: true },
  }
  Object.defineProperty(config, 'memoryDir', {
    configurable: true,
    enumerable: true,
    get() {
      plugin.memoryDirReads += 1
      return memoryDir
    },
  })
  return plugin
}

const sessionOf = (id) => ({ id })
const execOf = (id) => ({ agent: { session: sessionOf(id) } })
const OWNER_SESSION = `onebot-private-${OWNER}`
const ownerExec = () => execOf(OWNER_SESSION)

function makeFakeTool(options = {}) {
  const plugin = makePlugin(options)
  return { plugin, tool: new MemoryGroupRecallTool(plugin), definition: new MemoryGroupRecallTool(plugin).definition() }
}

// ---------------------------------------------------------------------------
// 1. definition / schema / render contract
// ---------------------------------------------------------------------------

test('definition: name, privacy description, strict parameter schema and renderer', () => {
  const { definition } = makeFakeTool()
  assert.equal(definition.name, 'memory_group_recall')
  assert.ok(definition.description.includes('仅限主人私聊'), 'description states the private-only rule')
  assert.ok(definition.description.includes('群聊'), 'description talks about group memories')
  assert.ok(definition.description.includes('不会返回任何私聊'), 'description promises no private memories')
  assert.ok(definition.description.includes('群聊会话中调用会被拒绝'), 'description warns about group sessions')

  assert.equal(definition.parameters.type, 'object')
  assert.equal(definition.parameters.additionalProperties, false, 'strict: unknown arguments are rejected')
  assert.deepEqual(definition.parameters.required ?? [], [], 'every filter is optional')
  assert.deepEqual(
    Object.keys(definition.parameters.properties).sort(),
    ['group', 'limit', 'listGroups', 'offset', 'query', 'timeFrom', 'timeTo'],
  )
  assert.equal(definition.parameters.properties.limit.type, 'integer')
  assert.equal(definition.parameters.properties.offset.type, 'integer')
  assert.equal(definition.parameters.properties.listGroups.type, 'boolean')
  assert.equal(definition.parameters.properties.query.type, 'string')

  assert.equal(definition.timeoutMs, 10000)
  assert.equal(definition.isConcurrencySafe(), true, 'read-only: concurrent calls are safe')
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(definition.output.schema.type, 'object')
  for (const key of ['found', 'matched', 'totalGroups', 'groupsMatched', 'offset', 'limit', 'hasMore', 'nextOffset']) {
    assert.ok(definition.output.schema.properties[key], `output schema declares ${key}`)
  }
  assert.equal(definition.output.schema.properties.entries.type, 'array')
  const entryProps = definition.output.schema.properties.entries.items.properties
  for (const key of ['groupId', 'chatKey', 'folderId', 'createdAt', 'eventStart', 'alpha', 'title', 'matched', 'snippet', 'truncated']) {
    assert.ok(entryProps[key], `entries.items.properties.${key} is missing`)
  }
  assert.equal(definition.output.schema.properties.groups.type, 'array')

  // Renderer is defensive: an empty value still produces a text block with the
  // directional scope note and never throws.
  const rendered = renderGroupRecallResult({}, { found: 0, matched: 0, offset: 0, limit: 8, hasMore: false, entries: [] })
  assert.ok(Array.isArray(rendered) && rendered.length > 0)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.includes('没有找到匹配的群聊记忆'))
  assert.ok(rendered[0].text.includes('数据范围：仅 QQ 群聊记忆；不含私聊 / WebUI / 子代理记忆。'))
})

// ---------------------------------------------------------------------------
// 2. owner private chat: group memories only (decoys never leak)
// ---------------------------------------------------------------------------

test('owner private chat: returns ONLY group memories (private/webui decoys stay invisible)', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const { tool, definition } = makeFakeTool({ memoryDir })
    const value = await tool.execute({ query: '部署' }, ownerExec())

    assert.ok(value.found >= 3, `expected A + B hits, got ${value.found}`)
    assert.equal(value.matched, value.found, 'all hits fit on page one')
    assert.ok(value.entries.some((entry) => entry.groupId === GROUP_A), 'group A hit')
    assert.ok(value.entries.some((entry) => entry.groupId === GROUP_B), 'group B hit (cross-group aggregation)')
    for (const entry of value.entries) {
      assert.ok(
        entry.chatKey.startsWith('onebot-group-') || entry.chatKey.startsWith('qqb-g-'),
        `entry source must be a group store, got ${entry.chatKey}`,
      )
      assert.ok(!entry.chatKey.includes('private'), 'no private store can ever appear')
    }
    // First entry sorts by matched-keyword count desc → α desc.
    assert.equal(value.entries[0].folderId, 'mem-20261102T143500Z-0001')
    assert.ok(value.entries[0].snippet.includes('8080'))

    const serialized = JSON.stringify(value)
    const renderedText = definition.output.render({}, value)[0].text
    for (const decoy of DECOYS) {
      assert.equal(serialized.includes(decoy.marker), false, `${decoy.marker} must not leak (value)`)
      assert.equal(renderedText.includes(decoy.marker), false, `${decoy.marker} must not leak (render)`)
    }
    assert.equal(serialized.includes('UNSCORED-SECRET'), false, 'unscored folders are invisible')
    // Group number + snippet are what the model needs.
    assert.ok(renderedText.includes(`[群 ${GROUP_A}]`), 'render names the source group')
    assert.ok(renderedText.includes('摘要：'), 'render includes snippets')
  })
})

test('group snippet shows the conversation inside a QQ tool-result JSON (v1.4.3)', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    // Real shape: qq_get_unread_messages answers with serializeModelData(...).
    const toolJson = JSON.stringify({
      ok: true,
      key: `group:${GROUP_A}`,
      unreadCount: 1,
      messages: [{ seq: 5, messageId: '880011', sender: '群友甲', userId: '70001', text: '周末有人一起去看电影吗' }],
      readThroughSeq: 5,
    })
    writeStore(memoryDir, `qqb-g-${GROUP_A}-${'c'.repeat(32)}`, [
      folder('mem-20261102T150000Z-0001', {
        createdAt: T_1102,
        keywords: ['电影'],
        title: '电影邀约',
        messages: [{ role: 'tool', content: toolJson }],
      }),
    ])
    const { tool, definition } = makeFakeTool({ memoryDir })
    const value = await tool.execute({ query: '电影' }, ownerExec())
    assert.equal(value.found, 1)
    assert.equal(value.entries[0].snippet, '群友甲：周末有人一起去看电影吗', 'snippet is the conversation, not field names')
    const renderedText = definition.output.render({}, value)[0].text
    assert.ok(renderedText.includes('群友甲：周末有人一起去看电影吗'), renderedText)
    assert.ok(!renderedText.includes('"messageId"'), 'JSON field names must not reach the model')
  })
})

test('unscored folders and non-group stores are never returned, even by keyword', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const { tool } = makeFakeTool({ memoryDir })
    const unscored = await tool.execute({ query: '未评分' }, ownerExec())
    assert.equal(unscored.found, 0, 'scored=false is invisible')
    assert.equal(JSON.stringify(unscored).includes('UNSCORED-SECRET'), false)

    const privateOnly = await tool.execute({ query: 'PRIVATE-ONLY' }, ownerExec())
    assert.equal(privateOnly.found, 0, 'private store content is not part of the scan')
    const webuiOnly = await tool.execute({ query: 'WEBUI-ONLY' }, ownerExec())
    assert.equal(webuiOnly.found, 0, 'webui store content is not part of the scan')
  })
})

// ---------------------------------------------------------------------------
// 3. authorization: no memory-store IO before the decision
// ---------------------------------------------------------------------------

test('group-chat session: rejected BEFORE any memory-store read', async () => {
  const { plugin, tool } = makeFakeTool({ memoryDir: 'C:/must-not-be-read' })
  for (const id of [`onebot-group-${GROUP_A}`, `qqb-g-${GROUP_B}-${'a'.repeat(32)}`]) {
    await assert.rejects(
      () => tool.execute({ query: '部署' }, execOf(id)),
      /仅限 QQ 私聊使用/,
      'group sessions must be rejected',
    )
  }
  assert.equal(plugin.memoryDirReads, 0, 'the store root was never even read')
})

test('non-owner private chat, WebUI and missing session are rejected before IO', async () => {
  const { plugin, tool } = makeFakeTool({ memoryDir: 'C:/must-not-be-read' })
  await assert.rejects(() => tool.execute({ query: '部署' }, execOf(`onebot-private-${NON_OWNER}`)), /不在 compat.ownerIds/)
  await assert.rejects(
    () => tool.execute({ query: '部署' }, execOf(`qqb-p-${NON_OWNER}-${'b'.repeat(32)}`)),
    /不在 compat.ownerIds/,
    'Derpyu private chat is also owner-checked',
  )
  await assert.rejects(() => tool.execute({ query: '部署' }, execOf('session-webui-1')), /仅限 QQ 私聊使用/)
  await assert.rejects(() => tool.execute({ query: '部署' }, {}), /requires an active session/)
  assert.equal(plugin.memoryDirReads, 0, 'no rejected call touched the store root')
})

test('ownerIds empty → rejected with a config.local.json hint (privacy default)', async () => {
  const { plugin, tool } = makeFakeTool({ memoryDir: 'C:/must-not-be-read', ownerIds: [] })
  await assert.rejects(() => tool.execute({}, ownerExec()), /compat\.ownerIds/)
  await assert.rejects(() => tool.execute({}, ownerExec()), /config\.local\.json/)
  assert.equal(plugin.memoryDirReads, 0)
})

test('storage.perSession=false and disabled/off configs are rejected before IO', async () => {
  const perSessionFalse = makeFakeTool({ memoryDir: 'C:/must-not-be-read', perSession: false })
  await assert.rejects(() => perSessionFalse.tool.execute({}, ownerExec()), /storage\.perSession/)
  assert.equal(perSessionFalse.plugin.memoryDirReads, 0)

  const cases = [
    { options: { enabled: false }, pattern: /disabled/ },
    { options: { qqBots: 'off' }, pattern: /compat/ },
    { options: { crossChat: { enabled: false } }, pattern: /crossChat\.enabled/ },
    { options: { detection: { enabled: false } }, pattern: /compat/ },
  ]
  for (const { options, pattern } of cases) {
    const { plugin, tool } = makeFakeTool({ memoryDir: 'C:/must-not-be-read', ...options })
    await assert.rejects(() => tool.execute({ query: '部署' }, ownerExec()), pattern)
    assert.equal(plugin.memoryDirReads, 0, 'config rejection happens before store IO')
  }
})

test('ownerOnly=false allows a non-owner private chat but still rejects group chats', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const { tool } = makeFakeTool({ memoryDir, crossChat: { ownerOnly: false } })
    const value = await tool.execute({ query: '部署' }, execOf(`onebot-private-${NON_OWNER}`))
    assert.ok(value.found >= 3, 'non-owner private chat may read when ownerOnly=false')
    await assert.rejects(() => tool.execute({ query: '部署' }, execOf(`onebot-group-${GROUP_A}`)), /仅限 QQ 私聊使用/)
  })
})

// ---------------------------------------------------------------------------
// 4. filters: group / listGroups / keyword miss
// ---------------------------------------------------------------------------

test('listGroups lists group stores only (no snippets, no private/webui stores)', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const { tool, definition } = makeFakeTool({ memoryDir })
    const value = await tool.execute({ listGroups: true }, ownerExec())
    assert.equal(value.listGroups, true)
    assert.equal(value.entries, undefined, 'listGroups returns no snippets')
    assert.deepEqual(
      value.groups.map((group) => group.groupId),
      [GROUP_A, GROUP_B, GROUP_C],
      'sorted by latest memory desc; private/webui stores absent',
    )
    const byGroup = new Map(value.groups.map((group) => [group.groupId, group]))
    assert.equal(byGroup.get(GROUP_A).folders, 4, 'unscored folder is not counted')
    assert.equal(byGroup.get(GROUP_B).folders, 1)
    assert.equal(byGroup.get(GROUP_C).folders, 25)
    assert.ok(byGroup.get(GROUP_A).latestAt >= T_1102, 'latest uses eventStart/createdAt')

    const rendered = definition.output.render({ listGroups: true }, value)[0].text
    assert.ok(rendered.includes(`群 ${GROUP_A}`))
    assert.ok(rendered.includes('数据范围：仅 QQ 群聊记忆'))
    assert.equal(rendered.includes('PRIVATE-ONLY-SECRET'), false)

    const filtered = await tool.execute({ listGroups: true, group: `qqb-g-${GROUP_B}` }, ownerExec())
    assert.deepEqual(filtered.groups.map((group) => group.groupId), [GROUP_B])
  })
})

test('group filter matches by group number / chatKey / rotated session id only', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const { tool } = makeFakeTool({ memoryDir })
    for (const filter of [GROUP_A, `onebot-group-${GROUP_A}`]) {
      const value = await tool.execute({ query: '部署', group: filter }, ownerExec())
      assert.ok(value.found >= 1)
      assert.ok(value.entries.every((entry) => entry.groupId === GROUP_A), `filter ${filter} must only hit group A`)
    }
    for (const filter of [GROUP_B, `qqb-g-${GROUP_B}`, `qqb-g-${GROUP_B}-${'c'.repeat(32)}`]) {
      const value = await tool.execute({ query: '部署', group: filter }, ownerExec())
      assert.ok(value.found >= 1)
      assert.ok(value.entries.every((entry) => entry.groupId === GROUP_B), `filter ${filter} must only hit group B`)
    }
    const none = await tool.execute({ query: '部署', group: '123456789' }, ownerExec())
    assert.equal(none.matched, 0)
  })
})

test('keyword with no match → explicit "not found" result and render hint', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const { tool, definition } = makeFakeTool({ memoryDir })
    const value = await tool.execute({ query: '完全不存在关键词zzz' }, ownerExec())
    assert.equal(value.matched, 0)
    assert.equal(value.found, 0)
    assert.deepEqual(value.entries, [])
    const rendered = definition.output.render({}, value)[0].text
    assert.ok(rendered.includes('没有找到匹配的群聊记忆'))
    assert.ok(rendered.includes('listGroups=true'), 'render suggests listGroups')
  })
})

// ---------------------------------------------------------------------------
// 5. limit / offset / pagination clamping
// ---------------------------------------------------------------------------

test('limit/offset clamp, hasMore and pagination hint', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const { tool, definition } = makeFakeTool({ memoryDir })

    assert.equal(normalizeGroupRecallLimit(undefined), 8)
    assert.equal(normalizeGroupRecallLimit(100), MAX_GROUP_RECALL_LIMIT)
    assert.equal(normalizeGroupRecallLimit(-5), 1)
    assert.equal(normalizeGroupRecallLimit('abc'), 8)
    assert.equal(normalizeGroupRecallLimit(10, 3), 3, 'config maxResults caps the limit')
    assert.equal(normalizeGroupRecallOffset(undefined), 0)
    assert.equal(normalizeGroupRecallOffset(100000), MAX_GROUP_RECALL_OFFSET)
    assert.equal(normalizeGroupRecallOffset(-1), 0)

    const first = await tool.execute({ query: '批量', limit: 100 }, ownerExec())
    assert.equal(first.found, MAX_GROUP_RECALL_LIMIT, 'limit clamps to 20')
    assert.equal(first.matched, 25)
    assert.equal(first.hasMore, true)
    assert.equal(first.nextOffset, 20)
    const renderedFirst = definition.output.render({}, first)[0].text
    assert.ok(renderedFirst.includes('显示第 1–20 条'))
    assert.ok(renderedFirst.includes('可用 offset=20 继续'))

    const second = await tool.execute({ query: '批量', offset: 20, limit: 20 }, ownerExec())
    assert.equal(second.found, 5)
    assert.equal(second.offset, 20)
    assert.equal(second.hasMore, false)
    assert.equal(second.entries[0].folderId, 'mem-20260901T000000Z-0004', 'sorted createdAt desc within page 2')

    const beyond = await tool.execute({ query: '批量', offset: 10000 }, ownerExec())
    assert.equal(beyond.matched, 25, 'offset beyond the end keeps the total count')
    assert.equal(beyond.found, 0)
    const renderedBeyond = definition.output.render({}, beyond)[0].text
    assert.ok(renderedBeyond.includes('本页没有条目'), 'explicit beyond-the-end hint')

    const capped = makeFakeTool({ memoryDir, crossChat: { maxResults: 3 } })
    const cappedValue = await capped.tool.execute({ query: '批量', limit: 10 }, ownerExec())
    assert.equal(cappedValue.found, 3, 'compat.crossChat.maxResults is the hard cap')
  })
})

// ---------------------------------------------------------------------------
// 6. time filtering
// ---------------------------------------------------------------------------

test('timeFrom/timeTo filter by eventStart ?? createdAt (epoch, date-only and invalid input)', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const { tool, definition } = makeFakeTool({ memoryDir })

    // Epoch milliseconds.
    const fromEpoch = await tool.execute({ query: '部署', timeFrom: T_1101 - 60 * MINUTE, timeTo: T_1102 + 24 * 60 * MINUTE }, ownerExec())
    assert.ok(fromEpoch.matched >= 2)
    // Numeric epoch input must be echoed back: it used to render as '' while the
    // filter was still applied, dropping the time window from the conditions.
    assert.equal(fromEpoch.timeFrom, String(T_1101 - 60 * MINUTE), 'numeric timeFrom is echoed back')
    assert.equal(fromEpoch.timeTo, String(T_1102 + 24 * 60 * MINUTE), 'numeric timeTo is echoed back')
    const renderedEpoch = definition.output.render({}, fromEpoch)[0].text
    assert.ok(renderedEpoch.includes('时间='), 'numeric time bounds still render the time condition')

    // Date-only strings: 2026-11-01 includes group A's 11-01 memory but not 11-02.
    const dayOne = await tool.execute({ query: '部署', timeFrom: '2026-11-01', timeTo: '2026-11-01' }, ownerExec())
    assert.ok(dayOne.matched >= 1)
    assert.ok(dayOne.entries.every((entry) => entry.groupId === GROUP_A), 'only the 11-01 group A memory is in range')
    assert.ok(dayOne.entries.every((entry) => entry.folderId === 'mem-20261101T010000Z-0003'))

    // eventStart wins over createdAt: this folder was archived in October.
    const byEvent = await tool.execute({ query: '事件时间', timeFrom: '2026-11-01', timeTo: '2026-11-03' }, ownerExec())
    assert.equal(byEvent.found, 1, 'filtered by eventStart (Nov), not createdAt (Oct)')
    const outsideEvent = await tool.execute({ query: '事件时间', timeFrom: '2026-11-03' }, ownerExec())
    assert.equal(outsideEvent.found, 0, 'eventStart outside the range is excluded')

    // Invalid input is ignored with a warning, never a throw.
    const invalid = await tool.execute({ query: '部署', timeFrom: '不是时间' }, ownerExec())
    assert.ok(invalid.matched >= 3, 'invalid timeFrom does not filter')
    assert.ok(invalid.warnings.some((warning) => warning.includes('timeFrom')), 'invalid time is reported')
    const rendered = definition.output.render({}, invalid)[0].text
    assert.ok(rendered.includes('提示：'), 'warning rendered')

    // Reversed bounds are swapped with a warning. The swap happens on the raw
    // inputs (not on the resolved instants), so a date-only endpoint keeps its
    // day-start/day-end meaning and the full Nov 1..Nov 3 range stays visible.
    const reversed = await tool.execute({ query: '部署', timeFrom: '2026-11-03', timeTo: '2026-11-01' }, ownerExec())
    assert.ok(reversed.warnings.some((warning) => warning.includes('交换')))
    assert.equal(reversed.matched, 3, 'swapping raw inputs keeps the full two-day range')
    assert.equal(reversed.timeFrom, '2026-11-01', 'effective from is echoed after the swap')
    assert.equal(reversed.timeTo, '2026-11-03', 'effective to is echoed after the swap')

    // Direct parser unit checks.
    assert.equal(parseTimeBoundary(undefined).ms, undefined)
    assert.equal(parseTimeBoundary(1700000000000).ms, 1700000000000)
    assert.equal(parseTimeBoundary('1700000000000').ms, 1700000000000)
    assert.equal(parseTimeBoundary('garbage').ms, undefined)
    assert.ok(parseTimeBoundary('garbage').warning.includes('无法解析'))
  })
})

// ---------------------------------------------------------------------------
// 7. hostile arguments: traversal / control characters / wrong types
// ---------------------------------------------------------------------------

test('hostile group/query arguments cannot traverse paths, throw or leak a path', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const { tool, definition } = makeFakeTool({ memoryDir })
    const hostileGroups = ['../../x', '..\\..', '../..', '..', 'C:\\Windows\\System32', `onebot-group-../../x`, 'sessions/../../x']
    for (const group of hostileGroups) {
      const value = await tool.execute({ query: '部署', group }, ownerExec())
      assert.equal(value.matched, 0, `hostile group ${group} must not select a store`)
      const rendered = definition.output.render({}, value)[0].text
      assert.equal(rendered.includes(memoryDir), false, 'no absolute memory path in the output')
      assert.equal(JSON.stringify(value).includes(memoryDir), false)
    }
    // Control characters in query: stripped, no exception, no keyword leak. A
    // query that becomes empty after stripping is a "recent group memories"
    // browse (like omitting query), never an error.
    const control = await tool.execute({ query: '\u0000\u0001\u007f部署' }, ownerExec())
    assert.ok(control.found >= 3, 'control characters are stripped, the keyword still matches')
    const onlyControls = await tool.execute({ query: '\u0000\u0001' }, ownerExec())
    assert.ok(onlyControls.matched > 0, 'empty-after-strip query browses recent group memories')
    assert.ok(onlyControls.entries.every((entry) => entry.chatKey.startsWith('onebot-group-') || entry.chatKey.startsWith('qqb-g-')))
    // Wrong types are tolerated like the other tools (schema is advisory at runtime).
    const wrongTypes = await tool.execute({ group: 123, query: null, limit: 'x', offset: {}, listGroups: 'yes' }, ownerExec())
    assert.equal(wrongTypes.limit, 8, 'invalid limit falls back to 8')
    assert.equal(wrongTypes.offset, 0, 'invalid offset falls back to 0')
    assert.ok(wrongTypes.matched > 0, 'null query means "list recent group memories"')
    assert.equal(wrongTypes.listGroups, undefined, 'non-boolean listGroups is not treated as true')
  })
})

// ---------------------------------------------------------------------------
// 8. read-only guarantee
// ---------------------------------------------------------------------------

function snapshotTree(root) {
  const snapshot = {}
  const walk = (dir, prefix) => {
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name)
      const key = prefix.length === 0 ? dirent.name : `${prefix}/${dirent.name}`
      if (dirent.isDirectory()) {
        walk(full, key)
        continue
      }
      let stat
      let content
      try {
        stat = statSync(full)
        content = readFileSync(full)
      } catch {
        continue
      }
      snapshot[key] = { mtimeMs: stat.mtimeMs, size: stat.size, hash: createHash('sha256').update(content).digest('hex') }
    }
  }
  walk(root, '')
  return snapshot
}

test('read-only: every store file keeps its content hash/mtime and no new file appears', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const before = snapshotTree(memoryDir)
    assert.ok(Object.keys(before).length > 10, 'fixture really wrote files')

    const { tool } = makeFakeTool({ memoryDir })
    const calls = [
      () => tool.execute({}, ownerExec()),
      () => tool.execute({ query: '部署' }, ownerExec()),
      () => tool.execute({ query: '批量', limit: 20, offset: 5 }, ownerExec()),
      () => tool.execute({ query: '部署', timeFrom: '2026-10-01', timeTo: '2026-12-01' }, ownerExec()),
      () => tool.execute({ listGroups: true }, ownerExec()),
      () => tool.execute({ query: '部署', group: GROUP_A }, ownerExec()),
    ]
    for (const call of calls) await call()

    const after = snapshotTree(memoryDir)
    assert.deepEqual(after, before, 'no store file changed (content hash + mtime + size) and no file was created/removed')
    const keys = Object.keys(after)
    assert.equal(keys.some((key) => key.endsWith('.tmp')), false, 'no atomic-write temp file was produced')
    assert.equal(keys.some((key) => key.includes('.commit-')), false, 'no commit journal was produced')
  })
})

// ---------------------------------------------------------------------------
// 9. compat.crossChat configuration (lib/compat.js)
// ---------------------------------------------------------------------------

test('compat config: crossChat defaults, clamping warnings and ownerOnly leak warning', () => {
  const defaults = normalizeCompatConfig(undefined)
  assert.deepEqual(defaults.warnings, [], 'missing block → defaults without warnings')
  assert.deepEqual(defaults.compat.crossChat, DEFAULT_CROSS_CHAT)
  assert.equal(DEFAULT_COMPAT_CONFIG.crossChat.enabled, true)
  assert.equal(compatDefaults().crossChat.ownerOnly, true, 'compatDefaults exposes a fresh crossChat copy')

  const invalid = normalizeCompatConfig({
    crossChat: {
      enabled: 'yes',
      ownerOnly: 'no',
      maxResults: 999,
      maxSnippetChars: 10,
      maxGroups: 0,
      maxFoldersPerGroup: 1.5,
    },
  })
  assert.deepEqual(invalid.compat.crossChat, DEFAULT_CROSS_CHAT, 'every invalid field falls back to its default')
  assert.equal(invalid.warnings.length, 6, invalid.warnings.join('\n'))
  for (const field of ['enabled', 'ownerOnly', 'maxResults', 'maxSnippetChars', 'maxGroups', 'maxFoldersPerGroup']) {
    assert.ok(
      invalid.warnings.some((warning) => warning.startsWith(`compat.crossChat.${field}`)),
      `warning for compat.crossChat.${field}`,
    )
  }

  const leaky = normalizeCompatConfig({ crossChat: { ownerOnly: false } })
  assert.equal(leaky.compat.crossChat.ownerOnly, false, 'explicit ownerOnly=false is honoured')
  assert.ok(
    leaky.warnings.some((warning) => warning.includes('ownerOnly=false')),
    'ownerOnly=false is surfaced as a leak risk',
  )

  const notObject = normalizeCompatConfig({ crossChat: 'nope' })
  assert.ok(notObject.warnings.some((warning) => warning.startsWith('compat.crossChat')))

  // Per-call settings are re-clamped; a hostile config cannot widen the contract.
  assert.equal(crossChatSettings({ compat: { crossChat: { maxResults: 999, maxGroups: 0 } } }).maxResults, 20)
  assert.equal(crossChatSettings({ compat: { crossChat: { maxGroups: 0 } } }).maxGroups, 1, 'out-of-range values clamp to the minimum')
  assert.equal(crossChatSettings({}).maxSnippetChars, 400)
})

// ---------------------------------------------------------------------------
// 10. registration / lifecycle with the real plugin
// ---------------------------------------------------------------------------

function makeHostContext() {
  const capture = { tools: [], sections: [], logs: [] }
  const ctx = {
    logger: {
      info: (message) => capture.logs.push(['info', String(message)]),
      warn: (message) => capture.logs.push(['warn', String(message)]),
      debug: () => {},
    },
    tokenMeter: { measure: () => ({ totalTokens: 0, nodes: [] }) },
    systemPrompt: {
      section(section) {
        capture.sections.push(section)
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
    tools: {
      register(definition) {
        capture.tools.push({ definition })
        return () => {}
      },
    },
  }
  return { ctx, capture }
}

function compatOverrides(memoryDir, compat) {
  return {
    enabled: true,
    storage: { dir: memoryDir, perSession: true },
    // Hermetic: never patch a developer machine's real Derpyu profile.
    compat: { autoPatchDerpyu: false, ownerIds: [OWNER], ...compat },
  }
}

const toolNames = (capture) => capture.tools.map((entry) => entry.definition.name).sort()

test('registration: compat off → no memory_group_recall (still 3 model tools)', async () => {
  await withTempDirAsync(async (dir) => {
    const { ctx, capture } = makeHostContext()
    const plugin = new RofmPlugin(ctx, compatOverrides(path.join(dir, 'memory'), { qqBots: 'off' }))
    plugin.start()
    assert.equal(capture.tools.length, 3)
    assert.deepEqual(toolNames(capture), ['memory_image', 'memory_judge', 'memory_recall'])
    assert.equal(capture.tools.some((entry) => entry.definition.name === 'memory_group_recall'), false)
  })
})

test('registration: compat on + crossChat.enabled=false → no memory_group_recall', async () => {
  await withTempDirAsync(async (dir) => {
    const { ctx, capture } = makeHostContext()
    const plugin = new RofmPlugin(
      ctx,
      compatOverrides(path.join(dir, 'memory'), { qqBots: 'on', crossChat: { enabled: false } }),
    )
    plugin.start()
    assert.equal(capture.tools.length, 3)
    assert.equal(capture.tools.some((entry) => entry.definition.name === 'memory_group_recall'), false)
  })
})

test('registration: compat on → 4 tools, and the registered tool works end-to-end', async () => {
  await withTempDirAsync(async (dir) => {
    const memoryDir = path.join(dir, 'memory')
    seedMemory(memoryDir)
    const { ctx, capture } = makeHostContext()
    const plugin = new RofmPlugin(ctx, compatOverrides(memoryDir, { qqBots: 'on' }))
    plugin.start()
    assert.equal(capture.tools.length, 4)
    assert.deepEqual(toolNames(capture), ['memory_group_recall', 'memory_image', 'memory_judge', 'memory_recall'])
    const definition = capture.tools.find((entry) => entry.definition.name === 'memory_group_recall').definition
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(plugin.currentConfig().compat.crossChat.enabled, true, 'crossChat defaults survive config normalization')

    const value = await definition.execute({ query: '部署' }, ownerExec())
    assert.ok(value.found >= 3, 'owner private chat reads real group stores through the plugin')
    assert.ok(value.entries.some((entry) => entry.groupId === GROUP_A))
    assert.equal(JSON.stringify(value).includes('PRIVATE-ONLY-SECRET'), false)

    // Group-chat sessions go through the same tool and are rejected.
    await assert.rejects(
      () => definition.execute({ query: '部署' }, execOf(`onebot-group-${GROUP_A}`)),
      /仅限 QQ 私聊使用/,
    )
  })
})

test('registration: a missing tools service degrades silently (no throw)', async () => {
  await withTempDirAsync(async (dir) => {
    const { ctx, capture } = makeHostContext()
    ctx.get = () => undefined // no tools / systemPrompt / tokenMeter services
    const plugin = new RofmPlugin(ctx, compatOverrides(path.join(dir, 'memory'), { qqBots: 'on' }))
    assert.doesNotThrow(() => plugin.start())
    assert.equal(capture.tools.length, 0)
    assert.equal(plugin.groupRecallTool instanceof MemoryGroupRecallTool, true)
  })
})
