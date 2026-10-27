/**
 * dsh-rofm — `memory_image` model tool (path-based archived image lookup).
 *
 * v1.2 never re-attaches archived image bytes just to make an old image visible
 * again: recalled text carries the compact `[图片：（<name>，文件：<path>）]`
 * hint instead. This tool is how the model turns such a hint into the exact
 * archived image files — by memory keyword, memory folder id or file name — and
 * hands the returned absolute path to the host `read_image` tool.
 *
 * The tool is a pure adapter, exactly like lib/recall-tool.js: the plugin owns
 * the image index (`<memoryDir>/images/index.json`, `meta.images`) and exposes it
 * as `plugin.listArchivedImages(session, cfg)`; this file only filters, sorts and
 * renders the returned entries. No DSH imports, no filesystem access, no image
 * content blocks (the host `read_image` tool does the reading).
 *
 * The tool is registered by `RofmPlugin.registerImageTool()` through
 * `ctx.tools.register()`.
 */

const TOOL_NAME = 'memory_image'

const TOOL_DESCRIPTION =
  '查找 dsh-rofm 已归档的图片在文件系统中的位置。回忆块里的图片只给出文件名与路径提示；' +
  '用本工具可按关键词/记忆 id/文件名定位图片文件，然后用 read_image 查看。' +
  '返回图片的绝对路径、所属记忆 id、媒体类型/尺寸/字节数。'

const PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '关键词，匹配记忆关键词/标题/文件名，空格分隔多词取并集',
    },
    memoryId: { type: 'string', description: '记忆文件夹 id，如 mem-…' },
    name: { type: 'string', description: '图片文件名，支持子串' },
    limit: { type: 'integer', description: '1~20，默认 10' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'number' },
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          exists: { type: 'boolean' },
          mediaType: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          bytes: { type: 'number' },
          folderId: { type: 'string' },
          createdAt: { type: 'number' },
          keywords: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
        },
      },
    },
  },
}

/** Default / maximum number of image entries returned to the model. */
export const DEFAULT_IMAGE_LIMIT = 10
export const MAX_IMAGE_LIMIT = 20

/** Shown instead of an image list when no entry matches the filters. */
const EMPTY_HINT = '没有找到匹配的归档图片（可换关键词 / 记忆 id / 文件名再试，或先让回忆归档产生图片）'

/** Short trailing note: how the model actually views the file (no image blocks). */
const READ_NOTE = '用 read_image 读取「文件：」路径即可查看图片；路径不存在时说明图片已被删除。'

/** Coerce anything to a string without throwing (non-strings read as ''). */
function toText(value) {
  return typeof value === 'string' ? value : ''
}

/** Coerce any JSON number to a non-negative integer (else 0). */
function toCount(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0
}

/** Local `YYYY-MM-DD HH:mm` rendering of one epoch-ms value. */
function formatDateTime(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value)) return '未知时间'
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Clamp the optional `limit`: missing/invalid -> 10, otherwise 1..20.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeImageLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_IMAGE_LIMIT
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_IMAGE_LIMIT
  return Math.min(MAX_IMAGE_LIMIT, Math.max(1, Math.trunc(numeric)))
}

/**
 * Project one raw entry returned by `plugin.listArchivedImages()` onto the
 * JSON-safe shape the output schema promises. Unknown/extra keys are dropped and
 * every declared field is always present, so the host never sees `undefined`
 * (class instances / undefined properties are rejected by the tool value
 * validation).
 *
 * @param {any} raw
 * @returns {{ name: string, path: string, exists: boolean, mediaType: string, width: number, height: number, bytes: number, folderId: string, createdAt: number, keywords: string[], title: string }}
 */
function toImageEntry(raw) {
  const entry = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const keywords = Array.isArray(entry.keywords)
    ? entry.keywords.filter((keyword) => typeof keyword === 'string')
    : []
  const createdRaw = Number(entry.createdAt)
  return {
    name: toText(entry.name),
    path: toText(entry.path),
    exists: entry.exists === true,
    mediaType: toText(entry.mediaType),
    width: toCount(entry.width),
    height: toCount(entry.height),
    bytes: toCount(entry.bytes),
    folderId: toText(entry.folderId),
    createdAt: Number.isFinite(createdRaw) && createdRaw > 0 ? createdRaw : 0,
    keywords,
    title: toText(entry.title),
  }
}

/**
 * Normalize the model-provided filters once: lowercased name substring,
 * exact memory id, lowercased query terms and a clamped limit.
 *
 * @param {unknown} args tool arguments
 * @returns {{ name: string, memoryId: string, terms: string[], limit: number }}
 */
function normalizeFilters(args) {
  const source = args !== null && typeof args === 'object' ? args : {}
  return {
    name: toText(source.name).trim().toLowerCase(),
    memoryId: toText(source.memoryId).trim(),
    terms: toText(source.query).trim().toLowerCase().split(/\s+/).filter(Boolean),
    limit: normalizeImageLimit(source.limit),
  }
}

/**
 * One entry matches when every provided filter matches (AND): file name is a
 * case-insensitive substring, memory id is exact, and the query terms are OR-ed
 * over the entry's keywords, title and file name (any term, case-insensitive
 * substring; 多词取并集).
 */
function matchesFilter(entry, filter) {
  if (filter.name.length > 0 && !entry.name.toLowerCase().includes(filter.name)) return false
  if (filter.memoryId.length > 0 && entry.folderId !== filter.memoryId) return false
  if (filter.terms.length > 0) {
    const name = entry.name.toLowerCase()
    const title = entry.title.toLowerCase()
    const keywords = entry.keywords.map((keyword) => keyword.toLowerCase())
    const matched = filter.terms.some(
      (term) => name.includes(term) || title.includes(term) || keywords.some((keyword) => keyword.includes(term)),
    )
    if (!matched) return false
  }
  return true
}

/** Newest first; same timestamp ordered by file name so the output is stable. */
function compareImages(a, b) {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * `output.render`: one text-only content block (no image blocks — the model is
 * told to read the file path with the host `read_image` tool instead).
 *
 * Shape:
 *   ## 归档图片（N 张）
 *   - <name>（<mediaType>, WxH, <bytes> B）
 *     文件：<absolute path>（缺失）
 *     记忆：<folderId> · <YYYY-MM-DD HH:mm> · 关键词：<…>
 *   用 read_image 读取「文件：」路径即可查看图片；路径不存在时说明图片已被删除。
 *
 * @param {unknown} _args tool arguments (unused: the value is already filtered)
 * @param {unknown} value structured execute() result
 * @returns {Array<{ type: 'text', text: string }>} ContentBlock[]
 */
export function renderImageResult(_args, value) {
  const images = Array.isArray(value?.images)
    ? value.images.filter((image) => image !== null && typeof image === 'object' && typeof image.name === 'string')
    : []
  const found = images.length
  const matched = toCount(value?.matched)
  const lines = [`## 归档图片（${found} 张）`]
  if (found === 0) {
    lines.push('')
    lines.push(EMPTY_HINT)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (matched > found) {
    lines.push('')
    lines.push(`（共匹配 ${matched} 张，受 limit 限制只显示前 ${found} 张；可加大 limit 再查）`)
  }
  for (const image of images) {
    const keywords = Array.isArray(image.keywords) ? image.keywords.filter((keyword) => typeof keyword === 'string') : []
    const bytes = toCount(image.bytes)
    const width = toCount(image.width)
    const height = toCount(image.height)
    const createdAt = Number(image.createdAt)
    const timeText = Number.isFinite(createdAt) && createdAt > 0 ? ` · ${formatDateTime(createdAt)}` : ''
    const keywordText = keywords.length > 0 ? ` · 关键词：${keywords.join('、')}` : ''
    const fileText = typeof image.path === 'string' && image.path.length > 0 ? image.path : '（未知路径）'
    lines.push('')
    lines.push(`- ${image.name}（${toText(image.mediaType) || '未知类型'}, ${width}x${height}, ${bytes} B）`)
    lines.push(`  文件：${fileText}${image.exists === false ? '（缺失）' : ''}`)
    lines.push(`  记忆：${toText(image.folderId) || '未知'}${timeText}${keywordText}`)
  }
  lines.push('')
  lines.push(READ_NOTE)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * One live `memory_image` tool bound to one plugin instance. The plugin passes
 * itself in so the tool uses the same config/session isolation as the other
 * dsh-rofm paths.
 */
export class MemoryImageTool {
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
        render: (args, value) => renderImageResult(args, value),
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      execute: (args, exec) => tool.execute(args, exec),
    }
  }

  /**
   * Execute one image lookup in the calling session.
   *
   * Throws (never returns a normal value) when: the tool is not attached to a
   * plugin, there is no active session, dsh-rofm is disabled for the session, or
   * the plugin cannot list archived images.
   */
  async execute(args, exec) {
    const plugin = this.plugin
    if (!plugin || typeof plugin !== 'object') throw new Error('memory_image is not attached to a dsh-rofm plugin')
    const session = exec?.agent?.session
    if (!session || typeof session !== 'object') throw new Error('memory_image requires an active session')
    const cfg = plugin.currentConfig()
    if (!plugin.toolsSessionEnabled(session, cfg)) throw new Error('dsh-rofm is disabled for this session')
    if (typeof plugin.listArchivedImages !== 'function') {
      throw new Error('dsh-rofm image archive listing is unavailable')
    }
    const listed = await plugin.listArchivedImages(session, cfg)
    const filter = normalizeFilters(args)
    const entries = (Array.isArray(listed) ? listed : [])
      .map((item) => toImageEntry(item))
      .filter((entry) => entry.name.length > 0 && matchesFilter(entry, filter))
    entries.sort(compareImages)
    const images = entries.slice(0, filter.limit)
    // `matched` is render-only (cardinality before the limit); `found`/`images`
    // are the contract fields.
    return { found: images.length, matched: entries.length, images }
  }
}
