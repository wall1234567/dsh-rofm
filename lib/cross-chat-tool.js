/**
 * dsh-rofm — `memory_group_recall` model tool (v1.4.2, owner-private → group).
 *
 * Directional privacy design (SPEC v1.4.2 §2/§3):
 *
 *   private chat (owner only) ── read ──► group memories      ✅ this tool
 *   group chat          ── read ──► anything                  ❌ rejected
 *   private chat        ── read ──► private memories          ❌ never scanned
 *   WebUI / subagent    ── read ──► anything                  ❌ rejected
 *
 * The tool only ever scans `<memoryDir>/sessions/<onebot-group-*|qqb-g-*>`,
 * i.e. *group* stores, and it uses the engine's **read-only** store API
 * (`readIndex` / `readFolder`). It never calls `loadIndex` / `ensureMemoryDir` /
 * `writeIndex` / `commit` / `appendStats`, never creates a directory and never
 * writes/repairs a store file.
 *
 * Safety rules that must not regress:
 *
 *   1. authorize before IO: the session category + owner identity are checked
 *      before `cfg.memoryDir` is even read. A group / WebUI / non-owner call
 *      therefore cannot touch (or learn anything about) the memory store, and
 *      its error message carries no memory content and no absolute path.
 *   2. the `group` argument only *filters* the directory names produced by
 *      `readdirSync`; it never reaches `path.join` / an `open` call, so
 *      `group:'../../x'` cannot traverse.
 *   3. keyword matching goes through the engine (`normalizeText` +
 *      `matchKeywords`, same relevance rules as recall); time filtering uses
 *      `folder.eventStart ?? folder.createdAt`.
 *
 * The class mirrors `MemoryImageTool` / `MemoryRecallTool`: a pure adapter that
 * talks to the plugin object (`currentConfig`, `toolsSessionEnabled`, optional
 * `compatDetectionNow`) and the engine, with no DSH imports of its own.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { matchKeywords, normalizeText, readFolder, readIndex } from '../engine/index.js'
import { messagesToReadableText } from './message-text.js'
import { parseSessionChatKey } from './compat.js'

const TOOL_NAME = 'memory_group_recall'

/** Tool description (model-facing; keeps the three required privacy claims). */
export const TOOL_DESCRIPTION =
  '查询 QQ 群聊的历史记忆（仅限主人私聊使用）。可传关键词、群号、时间范围，返回命中的群聊记忆片段与来源群；' +
  '不会返回任何私聊或 WebUI 记忆。在群聊会话中调用会被拒绝。'

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      description:
        '关键词/短语（专有名词、技术名、项目名、参数名等，空格分隔多词取并集）；省略或空字符串时按时间/重要度列出最近的群聊记忆',
    },
    group: {
      type: 'string',
      description: '只查指定群：群号（如 1134030529）或 chatKey（onebot-group-… / qqb-g-…）；省略 = 所有群',
    },
    limit: { type: 'integer', description: '最多返回几条，1~20，默认 8' },
    offset: { type: 'integer', description: '分页偏移，从 0 开始（上限 1000）；上一页提示「还有更多」时用它继续翻页' },
    timeFrom: {
      type: 'string',
      description: '时间范围起点：ISO 字符串（如 2026-11-02 或 2026-11-02T22:35:00+08:00）或 epoch 毫秒；按 eventStart/createdAt 过滤',
    },
    timeTo: {
      type: 'string',
      description: '时间范围终点，格式同 timeFrom；只写日期（2026-11-02）时包含当天；与 timeFrom 组成闭区间',
    },
    listGroups: {
      type: 'boolean',
      description: 'true 时只列出「有记忆的群」（群号、记忆条数、最近一条时间），不返回记忆片段',
    },
  },
  required: [],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'number', description: '本页返回的条目数' },
    matched: { type: 'number', description: '过滤后的总命中数（分页前）' },
    totalGroups: { type: 'number', description: '本次扫描的群聊记忆库数量' },
    groupsMatched: { type: 'number', description: '命中记忆的群数量' },
    offset: { type: 'number' },
    limit: { type: 'number' },
    hasMore: { type: 'boolean' },
    nextOffset: { type: 'number', description: 'hasMore=true 时下一页的 offset' },
    query: { type: 'string', description: '本次生效的关键词（原样回显）' },
    group: { type: 'string', description: '本次生效的群过滤（原样回显）' },
    timeFrom: { type: 'string', description: '本次生效的时间起点（按输入形式回显；范围颠倒时为交换后的值）' },
    timeTo: { type: 'string', description: '本次生效的时间终点（按输入形式回显；范围颠倒时为交换后的值）' },
    listGroups: { type: 'boolean' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          groupId: { type: 'string', description: '群号（由 store 目录名解析）' },
          chatKey: { type: 'string', description: '群聊 chatKey（onebot-group-… / qqb-g-…）' },
          folderId: { type: 'string' },
          createdAt: { type: 'number', description: '归档时间 (epoch ms)' },
          eventStart: { type: 'number', description: '事件时间 (epoch ms)；0 = 无事件时间，回退 createdAt' },
          alpha: { type: 'number' },
          title: { type: 'string' },
          matched: { type: 'number', description: '该条记忆命中的关键词数（无关键词查询时为 0）' },
          snippet: { type: 'string', description: '合并空白后的正文摘要（已按 maxSnippetChars 截断）' },
          truncated: { type: 'boolean' },
        },
      },
    },
    groups: {
      type: 'array',
      description: 'listGroups=true 时的群清单',
      items: {
        type: 'object',
        properties: {
          groupId: { type: 'string' },
          chatKey: { type: 'string' },
          folders: { type: 'number', description: '该群可见（已评分）记忆条数' },
          latestAt: { type: 'number', description: '最近一条记忆的 eventStart/createdAt' },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' }, description: '非阻断提示（时间解析失败、扫描上限等）' },
  },
}

/** Default / maximum number of memory entries returned to the model. */
export const DEFAULT_GROUP_RECALL_LIMIT = 8
export const MAX_GROUP_RECALL_LIMIT = 20
/** `offset` is clamped so a confused/hostile caller cannot scan forever. */
export const MAX_GROUP_RECALL_OFFSET = 1000
/** Fallbacks when `compat.crossChat` is missing (old config / fake plugins). */
const DEFAULT_MAX_RESULTS = 20
const DEFAULT_MAX_SNIPPET_CHARS = 400
const DEFAULT_MAX_GROUPS = 50
const DEFAULT_MAX_FOLDERS_PER_GROUP = 5000
const MIN_SNIPPET_CHARS = 80
const MAX_SNIPPET_CHARS = 2000
const MAX_GROUPS_CAP = 500
const MAX_FOLDERS_PER_GROUP_CAP = 100000

/** Group store directory names: the ONLY directories this tool may read. */
const GROUP_STORE_NAME_RE = /^(?:onebot-group|qqb-g)-(.+)$/

/** Shown under every result: the directional privacy contract. */
const SCOPE_NOTE = '数据范围：仅 QQ 群聊记忆；不含私聊 / WebUI / 子代理记忆。'

// Authorization errors. They must never contain memory content or a local path.
export const SESSION_SCOPE_ERROR = 'memory_group_recall 仅限 QQ 私聊使用：群聊 / WebUI / 子代理会话不可用'
export const OWNER_NOT_CONFIGURED_ERROR =
  'memory_group_recall 仅限主人私聊使用：尚未配置主人 QQ（compat.ownerIds 为空）。' +
  '请把主人 QQ 号写入 config.local.json 的 compat.ownerIds（该文件不被跟踪），再重试'
export const NOT_OWNER_ERROR = 'memory_group_recall 仅限主人私聊使用：当前私聊对象不在 compat.ownerIds 中'
export const PER_SESSION_ERROR = 'memory_group_recall 需要 storage.perSession=true（按会话隔离记忆）才能区分聊天边界'
export const COMPAT_OFF_ERROR = 'memory_group_recall 不可用：QQ 通道兼容（compat）当前未启用'
export const CROSS_CHAT_DISABLED_ERROR = 'memory_group_recall 已被配置禁用（compat.crossChat.enabled=false）'

// ---------------------------------------------------------------------------
// authorization (must run before any memory-store IO)
// ---------------------------------------------------------------------------

/**
 * Map a *private* chat key to the peer QQ. Only the two supported private-chat
 * namespaces are accepted; a group key (`onebot-group-*` / `qqb-g-*`) returns
 * `undefined` and is therefore rejected by {@link authorizeCrossChatSession}.
 *
 * @param {unknown} chatKey result of `parseSessionChatKey(session.id).chatKey`
 * @returns {{ mode: 'onebot'|'derpyu', peerId: string }|undefined}
 */
export function privatePeerOf(chatKey) {
  const text = typeof chatKey === 'string' ? chatKey : ''
  const onebot = /^onebot-private-(.+)$/.exec(text)
  if (onebot) {
    const peerId = onebot[1].trim()
    return peerId.length > 0 ? { mode: 'onebot', peerId } : undefined
  }
  const derpyu = /^qqb-p-(.+)$/.exec(text)
  if (derpyu) {
    const peerId = derpyu[1].trim()
    return peerId.length > 0 ? { mode: 'derpyu', peerId } : undefined
  }
  return undefined
}

/**
 * Decide whether this session may use the tool — **before** any store read.
 *
 * Order (SPEC v1.4.2 §2): session → private-chat category → owner identity →
 * `storage.perSession`. `crossChat.ownerOnly === false` disables only the owner
 * check (documented leak risk); the private-chat category is still required.
 *
 * @param {{ id?: unknown }|undefined} session active DSH session
 * @param {object} cfg current plugin config
 * @returns {{ chatKey: string, mode: string, peerId: string, ownerOnly: boolean }}
 * @throws {Error} when the caller is not an allowed owner private chat
 */
export function authorizeCrossChatSession(session, cfg) {
  if (!session || typeof session !== 'object') throw new Error('memory_group_recall requires an active session')
  // 1) private-chat category (chatKey, not the raw session id: a rotated
  //    Derpyu onebot suffix must not change the answer).
  const parsed = parseSessionChatKey(session.id)
  const peer = privatePeerOf(parsed.chatKey)
  if (!peer) throw new Error(SESSION_SCOPE_ERROR)
  // 2) owner identity — the peer QQ comes from the session id (not from the
  //    message text), so it cannot be spoofed by message content.
  const compat = cfg?.compat && typeof cfg.compat === 'object' ? cfg.compat : {}
  const crossChat = compat.crossChat && typeof compat.crossChat === 'object' ? compat.crossChat : {}
  const ownerOnly = crossChat.ownerOnly !== false
  const ownerIds = Array.isArray(compat.ownerIds)
    ? compat.ownerIds.filter((id) => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
    : []
  if (ownerOnly) {
    if (ownerIds.length === 0) throw new Error(OWNER_NOT_CONFIGURED_ERROR)
    if (!ownerIds.includes(peer.peerId)) throw new Error(NOT_OWNER_ERROR)
  }
  // 3) storage must keep one memory folder per chat, else "group stores" cannot
  //    be told apart from any other store under the root.
  if (cfg?.storage?.perSession === false) throw new Error(PER_SESSION_ERROR)
  return { chatKey: parsed.chatKey, mode: parsed.mode, peerId: peer.peerId, ownerOnly }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

function toCount(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0
}

function toText(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Echo one time argument back to the model.
 *
 * Numeric epoch-ms input used to echo as `''` (`toText` only passes strings), so
 * a time-filtered result rendered its conditions without the time window even
 * though the filter was applied. Numbers are echoed in their string form;
 * strings are kept verbatim (trimmed); anything else is empty (= not effective).
 *
 * @param {unknown} value raw `timeFrom` / `timeTo` argument
 * @returns {string}
 */
function timeEchoOf(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function toFiniteNumber(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

/** Local `YYYY-MM-DD HH:mm` rendering of one epoch-ms value. */
function formatDateTime(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '未知时间'
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Effective `compat.crossChat` knobs, re-clamped defensively (a hand-edited /
 * fake config must never widen the tool's own contract).
 *
 * @param {object|undefined} cfg
 */
export function crossChatSettings(cfg) {
  const raw = cfg?.compat?.crossChat
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    maxResults: clampInt(source.maxResults, 1, MAX_GROUP_RECALL_LIMIT, DEFAULT_MAX_RESULTS),
    maxSnippetChars: clampInt(source.maxSnippetChars, MIN_SNIPPET_CHARS, MAX_SNIPPET_CHARS, DEFAULT_MAX_SNIPPET_CHARS),
    maxGroups: clampInt(source.maxGroups, 1, MAX_GROUPS_CAP, DEFAULT_MAX_GROUPS),
    maxFoldersPerGroup: clampInt(
      source.maxFoldersPerGroup,
      1,
      MAX_FOLDERS_PER_GROUP_CAP,
      DEFAULT_MAX_FOLDERS_PER_GROUP,
    ),
  }
}

/**
 * Clamp the optional `limit`: missing/invalid → 8, then 1..min(20,
 * `compat.crossChat.maxResults`).
 *
 * @param {unknown} value
 * @param {number} [maxResults]
 * @returns {number}
 */
export function normalizeGroupRecallLimit(value, maxResults = DEFAULT_MAX_RESULTS) {
  const max = clampInt(maxResults, 1, MAX_GROUP_RECALL_LIMIT, DEFAULT_MAX_RESULTS)
  const fallback = Math.min(DEFAULT_GROUP_RECALL_LIMIT, max)
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(numeric)))
}

/**
 * Clamp the optional `offset`: missing/invalid → 0, otherwise 0..1000.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeGroupRecallOffset(value) {
  if (value === undefined || value === null || value === '') return 0
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.min(MAX_GROUP_RECALL_OFFSET, Math.max(0, Math.trunc(numeric)))
}

/** Start (or, with `end`, last millisecond) of a civil `YYYY[-MM[-DD]]` string. */
function parseCivilBoundary(text, end) {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (day) {
    const start = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 0, 0, 0, 0)
    if (Number.isNaN(start.getTime())) return undefined
    if (!end) return start.getTime()
    // The *next* local midnight (not `start + 24h`): a DST transition day is
    // 23/25 hours long, so a fixed 24h window would leak/drop one hour at the
    // day boundary. Same failure-safe fallback as the 1.4.1 engine fix (C-01).
    const after = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1, 0, 0, 0, 0)
    const afterMs = after.getTime()
    if (Number.isNaN(afterMs)) return start.getTime() + 24 * 60 * 60 * 1000 - 1
    return afterMs - 1
  }
  const month = /^(\d{4})-(\d{2})$/.exec(text)
  if (month) {
    const start = new Date(Number(month[1]), Number(month[2]) - 1, 1, 0, 0, 0, 0)
    if (Number.isNaN(start.getTime())) return undefined
    const after = new Date(Number(month[1]), Number(month[2]), 1, 0, 0, 0, 0)
    return end ? after.getTime() - 1 : start.getTime()
  }
  const year = /^(\d{4})$/.exec(text)
  if (year) {
    const start = new Date(Number(year[1]), 0, 1, 0, 0, 0, 0)
    if (Number.isNaN(start.getTime())) return undefined
    const after = new Date(Number(year[1]) + 1, 0, 1, 0, 0, 0, 0)
    return end ? after.getTime() - 1 : start.getTime()
  }
  return undefined
}

/**
 * Failure-tolerant time-bound parser (same spirit as `memory_recall`'s time
 * arguments): ISO strings (date / month / year / full ISO with timezone) and
 * epoch milliseconds are accepted; anything else is **ignored with a warning**
 * instead of throwing.
 *
 * @param {unknown} value `timeFrom` / `timeTo`
 * @param {{ end?: boolean, label?: string }} [options]
 * @returns {{ ms: number|undefined, warning: string|undefined }}
 */
export function parseTimeBoundary(value, options = {}) {
  const label = typeof options.label === 'string' && options.label.length > 0 ? options.label : '时间'
  if (value === undefined || value === null) return { ms: undefined, warning: undefined }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ms: undefined, warning: `${label}: 不是有效时间，已忽略` }
    return { ms: value, warning: undefined }
  }
  if (typeof value !== 'string') {
    return { ms: undefined, warning: `${label}: 需要 ISO 时间字符串或 epoch 毫秒，已忽略` }
  }
  const text = value.trim()
  if (text.length === 0) return { ms: undefined, warning: undefined }
  if (/^-?\d+$/.test(text)) {
    const numeric = Number(text)
    if (Number.isFinite(numeric)) return { ms: numeric, warning: undefined }
  }
  const civil = parseCivilBoundary(text, options.end === true)
  if (civil !== undefined) return { ms: civil, warning: undefined }
  const parsed = Date.parse(text)
  if (Number.isFinite(parsed)) return { ms: parsed, warning: undefined }
  return { ms: undefined, warning: `${label}: 无法解析为时间（需 ISO 字符串或 epoch 毫秒），已忽略` }
}

/** Normalize the `group` filter (only ever compared with readdir names). */
export function normalizeGroupFilter(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length === 0) return ''
  // A full (possibly rotated) session id is normalized to its stable chat key so
  // `qqb-g-<id>-<hex>` and `onebot-group-<id>-<retire>` still match.
  const parsed = parseSessionChatKey(text).chatKey
  return GROUP_STORE_NAME_RE.test(parsed) ? parsed : text
}

/** Filter the scanned group stores by the user-supplied `group` argument. */
function applyGroupFilter(stores, groupFilter) {
  if (groupFilter.length === 0) return stores
  return stores.filter((store) => store.chatKey === groupFilter || store.groupId === groupFilter)
}

/** Time used for filtering/sorting/labels: `eventStart ?? createdAt`. */
function folderTimeOf(folder) {
  const eventStart = toFiniteNumber(folder?.eventStart, 0)
  if (eventStart > 0) return eventStart
  return toFiniteNumber(folder?.createdAt, 0)
}

/**
 * List the group stores under `<memoryDir>/sessions`.
 *
 * Only directories whose name matches {@link GROUP_STORE_NAME_RE} are accepted.
 * Everything else (`onebot-private-*`, `qqb-p-*`, `session-*`, dot dirs, plain
 * files) is ignored silently — the private/WebUI stores must never be opened.
 *
 * @param {unknown} memoryDir **global** (unscoped) `cfg.memoryDir`
 * @param {string[]} warnings
 * @returns {Array<{ chatKey: string, groupId: string, dir: string }>}
 */
function listGroupStores(memoryDir, warnings) {
  if (typeof memoryDir !== 'string' || memoryDir.trim().length === 0) {
    warnings.push('记忆目录不可用（cfg.memoryDir 缺失），无法查询群聊记忆')
    return []
  }
  let dirents
  try {
    dirents = readdirSync(join(memoryDir, 'sessions'), { withFileTypes: true })
  } catch {
    // No sessions/ directory (fresh install) or unreadable root: an empty result,
    // never an error and never a write attempt.
    return []
  }
  const stores = []
  for (const dirent of dirents) {
    if (!dirent || dirent.isDirectory() !== true) continue
    const name = dirent.name
    if (typeof name !== 'string' || name.length === 0 || name.startsWith('.')) continue
    const match = GROUP_STORE_NAME_RE.exec(name)
    if (!match || match[1].length === 0) continue
    stores.push({ chatKey: name, groupId: match[1], dir: join(memoryDir, 'sessions', name) })
  }
  stores.sort((a, b) => (a.chatKey < b.chatKey ? -1 : a.chatKey > b.chatKey ? 1 : 0))
  return stores
}

/**
 * Read one group store's index and keep the visible (scored) folders.
 *
 * `readIndex` is the engine's **read-only** index reader: it never creates,
 * repairs or rewrites anything (unlike `loadIndex`).
 *
 * @returns {{ folders: object[], total: number }|undefined}
 */
function visibleFoldersOf(store, cfg, settings, warnings) {
  const index = readIndex(store.dir, cfg)
  if (!index || !Array.isArray(index.folders)) {
    warnings.push(`群 ${store.groupId}: 记忆索引不可读，已跳过`)
    return undefined
  }
  const visible = index.folders.filter((folder) => folder !== null && typeof folder === 'object' && folder.scored !== false)
  if (visible.length > settings.maxFoldersPerGroup) {
    warnings.push(`群 ${store.groupId}: 可见记忆超过 ${settings.maxFoldersPerGroup} 条，只扫描前 ${settings.maxFoldersPerGroup} 条`)
  }
  return { folders: visible.slice(0, settings.maxFoldersPerGroup), total: visible.length }
}

/** Compact snippet of one folder's context.json (read-only; never throws out). */
function snippetOf(storeDir, folderId, maxSnippetChars) {
  try {
    const loaded = readFolder(storeDir, folderId)
    const messages = Array.isArray(loaded?.messages) ? loaded.messages : []
    // v1.4.3: readable rendering — a group-memory folder archived from a QQ tool
    // result must show its conversation, not truncated JSON field names.
    const text = messagesToReadableText(messages).replace(/\s+/g, ' ').trim()
    if (text.length <= maxSnippetChars) return { snippet: text, truncated: false }
    return { snippet: `${text.slice(0, maxSnippetChars)}…`, truncated: true }
  } catch {
    // Missing/corrupt context.json: the hit still exists in the index, so report
    // it with an empty snippet instead of failing the whole call.
    return { snippet: '', truncated: false }
  }
}

/** Collect every folder that passes the query + time filters (no snippets yet). */
function collectCandidates(stores, cfg, settings, options, warnings) {
  const { normalizedQuery, timeFromMs, timeToMs } = options
  const candidates = []
  for (const store of stores) {
    const visible = visibleFoldersOf(store, cfg, settings, warnings)
    if (visible === undefined) continue
    for (const folder of visible.folders) {
      const time = folderTimeOf(folder)
      if (timeFromMs !== undefined && !(time >= timeFromMs)) continue
      if (timeToMs !== undefined && !(time <= timeToMs)) continue
      let matchCount = 0
      if (normalizedQuery.length > 0) {
        const result = matchKeywords(normalizedQuery, folder.keywords, cfg, { title: folder.title })
        matchCount = toCount(result?.matchCount)
        if (matchCount === 0) continue
      }
      candidates.push({
        store,
        folder,
        matchCount,
        createdAt: toFiniteNumber(folder.createdAt, 0),
        eventStart: toFiniteNumber(folder.eventStart, 0),
        time,
      })
    }
  }
  const hasQuery = normalizedQuery.length > 0
  candidates.sort((a, b) => {
    // SPEC §3: with keywords → match count desc → α desc → createdAt desc;
    // without keywords (recent/important browse) → createdAt desc → α desc.
    if (hasQuery && a.matchCount !== b.matchCount) return b.matchCount - a.matchCount
    if (!hasQuery && a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
    const alphaA = toFiniteNumber(a.folder.alpha, 0)
    const alphaB = toFiniteNumber(b.folder.alpha, 0)
    if (alphaA !== alphaB) return alphaB - alphaA
    if (hasQuery && a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
    const idA = String(a.folder.id ?? '')
    const idB = String(b.folder.id ?? '')
    return idA < idB ? -1 : idA > idB ? 1 : 0
  })
  return candidates
}

/** Build `{ groupId, chatKey, folders, latestAt }` entries for `listGroups`. */
function collectGroupSummaries(stores, cfg, settings, warnings) {
  const groups = []
  for (const store of stores) {
    const visible = visibleFoldersOf(store, cfg, settings, warnings)
    if (visible === undefined || visible.folders.length === 0) continue
    let latestAt = 0
    for (const folder of visible.folders) {
      const time = folderTimeOf(folder)
      if (time > latestAt) latestAt = time
    }
    groups.push({ groupId: store.groupId, chatKey: store.chatKey, folders: visible.total, latestAt })
  }
  groups.sort((a, b) => b.latestAt - a.latestAt || (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0))
  return groups
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function renderConditions(value) {
  const parts = []
  const query = toText(value?.query).trim()
  if (query.length > 0) parts.push(`关键词=${query}`)
  const group = toText(value?.group).trim()
  if (group.length > 0) parts.push(`群=${group}`)
  const timeFrom = toText(value?.timeFrom).trim()
  const timeTo = toText(value?.timeTo).trim()
  if (timeFrom.length > 0 || timeTo.length > 0) parts.push(`时间=${timeFrom || '…'} ~ ${timeTo || '…'}`)
  return parts.length > 0 ? `条件：${parts.join(' · ')}` : ''
}

function appendWarnings(lines, value) {
  const warnings = Array.isArray(value?.warnings)
    ? value.warnings.filter((warning) => typeof warning === 'string' && warning.length > 0)
    : []
  if (warnings.length === 0) return
  lines.push('')
  lines.push(`提示：${warnings.join('；')}`)
}

/**
 * `output.render`: one text-only content block (never contains private/WebUI
 * memories — only what `execute` was allowed to scan).
 *
 * @param {unknown} _args tool arguments (the value already carries the echoes)
 * @param {unknown} value structured execute() result
 * @returns {Array<{ type: 'text', text: string }>}
 */
export function renderGroupRecallResult(_args, value) {
  const lines = []
  if (value?.listGroups === true) {
    const groups = Array.isArray(value?.groups) ? value.groups.filter((group) => group && typeof group === 'object') : []
    lines.push('跨群记忆查询（仅群聊 · listGroups）')
    lines.push('')
    if (groups.length === 0) {
      lines.push('没有找到任何群聊记忆：QQ 群聊里还没有归档（或还不可见）的记忆。')
    } else {
      for (const group of groups) {
        const latestAt = toFiniteNumber(group.latestAt, 0)
        lines.push(
          `- 群 ${toText(group.groupId) || '?'}（${toText(group.chatKey) || '?'}）· ${toCount(group.folders)} 条记忆 · 最近 ${formatDateTime(latestAt)}`,
        )
      }
      lines.push('')
      lines.push(`共 ${groups.length} 个群有群聊记忆。`)
    }
    appendWarnings(lines, value)
    lines.push('')
    lines.push(SCOPE_NOTE)
    return [{ type: 'text', text: lines.join('\n').trimEnd() }]
  }

  const entries = Array.isArray(value?.entries)
    ? value.entries.filter((entry) => entry && typeof entry === 'object')
    : []
  const found = entries.length
  const matched = toCount(value?.matched)
  const offset = Math.max(0, Math.trunc(toFiniteNumber(value?.offset, 0)))
  const header =
    found === 0 && matched > 0
      ? `跨群记忆查询（仅群聊，共 ${matched} 条命中；本页无结果）`
      : found === 0
        ? '跨群记忆查询（仅群聊，共 0 条命中）'
        : `跨群记忆查询（仅群聊，共 ${matched} 条命中；显示第 ${offset + 1}–${offset + found} 条）`
  lines.push(header)
  const conditions = renderConditions(value)
  if (conditions.length > 0) lines.push(conditions)

  if (found === 0) {
    lines.push('')
    if (matched > 0) {
      lines.push(`本页没有条目：offset=${offset} 超出范围（共 ${matched} 条命中），可用更小的 offset 重试。`)
    } else {
      lines.push('没有找到匹配的群聊记忆：可换关键词、群号或时间范围再试；也可用 listGroups=true 查看哪些群有记忆。')
    }
  } else {
    lines.push('')
    entries.forEach((entry, index) => {
      const groupId = toText(entry.groupId) || '?'
      const alpha = toFiniteNumber(entry.alpha, 0)
      const time = toFiniteNumber(entry.eventStart, 0) > 0 ? entry.eventStart : entry.createdAt
      const heading = [`[群 ${groupId}]`, formatDateTime(toFiniteNumber(time, 0)), `α=${alpha.toFixed(2)}`]
      const title = toText(entry.title).trim()
      if (title.length > 0) heading.push(`标题=${title}`)
      lines.push(`${offset + index + 1}. ${heading.join(' · ')}`)
      const snippet = toText(entry.snippet).trim()
      const truncated = entry.truncated === true ? '（已截断）' : ''
      lines.push(`   摘要：${snippet.length > 0 ? snippet : '（正文不可读）'}${truncated}`)
    })
    if (value?.hasMore === true) {
      lines.push('')
      lines.push(`（还有更多：可用 offset=${toCount(value?.nextOffset)} 继续）`)
    }
  }
  appendWarnings(lines, value)
  lines.push('')
  lines.push(SCOPE_NOTE)
  return [{ type: 'text', text: lines.join('\n').trimEnd() }]
}

// ---------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------

/**
 * One live `memory_group_recall` tool bound to one plugin instance.
 */
export class MemoryGroupRecallTool {
  constructor(plugin) {
    this.plugin = plugin
  }

  /** ToolDefinition handed to `ctx.tools.register()`. */
  definition() {
    const tool = this
    return {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (args, value) => renderGroupRecallResult(args, value),
      },
      timeoutMs: 10000,
      isConcurrencySafe: () => true,
      execute: (args, exec) => tool.execute(args, exec),
    }
  }

  /** Runtime config gates (compat hot-reload safety; SPEC §5). */
  ensureConfigAllows(cfg) {
    if (!cfg || typeof cfg !== 'object') throw new Error('memory_group_recall: configuration unavailable')
    if (cfg.enabled === false) throw new Error('dsh-rofm is disabled for this session')
    const compat = cfg.compat && typeof cfg.compat === 'object' ? cfg.compat : {}
    if (compat.qqBots === 'off') throw new Error(COMPAT_OFF_ERROR)
    if (compat.crossChat && typeof compat.crossChat === 'object' && compat.crossChat.enabled === false) {
      throw new Error(CROSS_CHAT_DISABLED_ERROR)
    }
    // Re-check the live QQ detection when the plugin exposes it; a config that
    // was hot-switched away from a QQ channel must stop working immediately.
    if (typeof this.plugin?.compatDetectionNow === 'function') {
      let detection
      try {
        detection = this.plugin.compatDetectionNow(cfg)
      } catch {
        detection = undefined
      }
      if (detection && typeof detection === 'object' && detection.enabled === false) throw new Error(COMPAT_OFF_ERROR)
    }
  }

  /**
   * Execute one owner-private → group-memory query.
   *
   * Order matters: config gates → session authorization → **only then** the
   * read-only scan. Any rejection happens before a store file is opened.
   */
  async execute(args, exec) {
    const plugin = this.plugin
    if (!plugin || typeof plugin !== 'object') {
      throw new Error('memory_group_recall is not attached to a dsh-rofm plugin')
    }
    const session = exec?.agent?.session
    if (!session || typeof session !== 'object') throw new Error('memory_group_recall requires an active session')
    const cfg = typeof plugin.currentConfig === 'function' ? plugin.currentConfig() : undefined
    this.ensureConfigAllows(cfg)
    if (typeof plugin.toolsSessionEnabled === 'function' && plugin.toolsSessionEnabled(session, cfg) !== true) {
      throw new Error('dsh-rofm is disabled for this session')
    }
    // ---- authorization first: no memory-store IO may happen above this line.
    authorizeCrossChatSession(session, cfg)

    const source = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
    const warnings = []
    const settings = crossChatSettings(cfg)
    const queryText = toText(source.query).trim()
    const normalizedQuery = queryText.length > 0
      // Control characters cannot match engine keywords; dropping them keeps the
      // matcher deterministic and avoids odd regex/substring surprises.
      ? normalizeText(queryText.replace(/[\u0000-\u001f\u007f]/g, ' ')).trim()
      : ''
    const groupFilter = normalizeGroupFilter(source.group)
    const limit = normalizeGroupRecallLimit(source.limit, settings.maxResults)
    const offset = normalizeGroupRecallOffset(source.offset)
    const listGroups = source.listGroups === true

    // Time bounds are parsed before the scan; invalid input is ignored with a
    // warning instead of failing the call (same failure-safe contract as recall).
    const fromParsed = parseTimeBoundary(source.timeFrom, { label: 'timeFrom' })
    const toParsed = parseTimeBoundary(source.timeTo, { label: 'timeTo', end: true })
    for (const parsed of [fromParsed, toParsed]) if (parsed.warning) warnings.push(parsed.warning)
    let timeFromMs = fromParsed.ms
    let timeToMs = toParsed.ms
    let fromEchoValue = source.timeFrom
    let toEchoValue = source.timeTo
    if (timeFromMs !== undefined && timeToMs !== undefined && timeFromMs > timeToMs) {
      warnings.push('timeFrom 晚于 timeTo：已交换时间范围')
      // Swap the *raw inputs* and resolve again: the two endpoints do not mean
      // the same thing ("2026-11-01" as timeFrom is its 00:00, as timeTo it is
      // its last millisecond). Swapping the already-resolved instants turned
      // "11-03 → 11-01" into an almost-empty [11-01 23:59:59.999, 11-03 00:00)
      // window instead of the intended full range.
      const swappedFrom = parseTimeBoundary(source.timeTo, { label: 'timeFrom' })
      const swappedTo = parseTimeBoundary(source.timeFrom, { label: 'timeTo', end: true })
      timeFromMs = swappedFrom.ms
      timeToMs = swappedTo.ms
      fromEchoValue = source.timeTo
      toEchoValue = source.timeFrom
    }
    const timeEchoFrom = timeFromMs === undefined ? '' : timeEchoOf(fromEchoValue)
    const timeEchoTo = timeToMs === undefined ? '' : timeEchoOf(toEchoValue)

    // ---- read-only data scope: `<cfg.memoryDir>/sessions/*` group stores only.
    const memoryDir = cfg.memoryDir
    const allStores = listGroupStores(memoryDir, warnings)
    const filteredStores = applyGroupFilter(allStores, groupFilter)
    let stores = filteredStores
    if (stores.length > settings.maxGroups) {
      stores = stores.slice(0, settings.maxGroups)
      warnings.push(`本次只扫描前 ${settings.maxGroups} 个群聊记忆库（共 ${filteredStores.length} 个；compat.crossChat.maxGroups 可调）`)
    }

    const value = {
      found: 0,
      matched: 0,
      totalGroups: stores.length,
      groupsMatched: 0,
      offset,
      limit,
      hasMore: false,
      query: queryText,
      group: groupFilter,
      timeFrom: timeEchoFrom,
      timeTo: timeEchoTo,
      warnings,
    }

    if (listGroups) {
      const groups = collectGroupSummaries(stores, cfg, settings, warnings)
      value.listGroups = true
      value.groups = groups
      value.totalGroups = stores.length
      value.groupsMatched = groups.length
      return value
    }

    const candidates = collectCandidates(stores, cfg, settings, { normalizedQuery, timeFromMs, timeToMs }, warnings)
    const matched = candidates.length
    const page = candidates.slice(offset, offset + limit)
    const entries = page.map((candidate) => {
      const { snippet, truncated } = snippetOf(candidate.store.dir, candidate.folder.id, settings.maxSnippetChars)
      return {
        groupId: candidate.store.groupId,
        chatKey: candidate.store.chatKey,
        folderId: String(candidate.folder.id ?? ''),
        createdAt: candidate.createdAt,
        eventStart: candidate.eventStart,
        alpha: toFiniteNumber(candidate.folder.alpha, 0),
        title: toText(candidate.folder.title),
        matched: candidate.matchCount,
        snippet,
        truncated,
      }
    })
    value.found = entries.length
    value.matched = matched
    value.totalGroups = stores.length
    value.groupsMatched = new Set(candidates.map((candidate) => candidate.store.chatKey)).size
    value.entries = entries
    value.hasMore = offset + entries.length < matched
    if (value.hasMore) value.nextOffset = offset + entries.length
    return value
  }
}
