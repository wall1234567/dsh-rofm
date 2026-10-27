/**
 * dsh-rofm — image folder helpers (docs/SPEC.md §3, v1.2).
 *
 * Archived conversation text never carries image bytes. The text keeps a compact
 * placeholder (`[图片：（<name>）]`) and the bytes live as ordinary files under
 * `<memoryDir>/images/`, one file per image. This module is the pure, DSH-free
 * half of that feature:
 *
 *   - the placeholder format and its parser;
 *   - a content-block walk that renders `image` blocks as placeholders and
 *     returns the image metadata stored in `meta.json` (`meta.images`);
 *   - image-file store/load/remove/list under the image folder;
 *   - defensive metadata normalization for old or hand-edited folders;
 *   - the recall-side inverse: split stored text at placeholders and re-insert
 *     DSH image blocks.
 *
 * Like lib/message-text.js it deliberately knows nothing about Cordis: no DSH
 * imports, plain strings/objects/Buffers in, plain strings/objects/Buffers out.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Host-supported conversation image media types → canonical file extension. */
export const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
})

/** Reverse lookup used to repair metadata whose media type was lost. */
const MEDIA_TYPE_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
})

/** Folder name inside `<memoryDir>` that holds every archived image. */
const IMAGE_FOLDER_NAME = 'images'

/** Longest image file name accepted/stored (safe on every target filesystem). */
const MAX_IMAGE_NAME_LENGTH = 120

/** Placeholder names are capped so a single marker cannot dominate a line. */
const MAX_PLACEHOLDER_NAME_LENGTH = 200

/** A stored image name is exactly one path segment of a conservative ASCII set. */
const SAFE_IMAGE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/

/** Media types must look like image/<subtype>; unknown-but-image types are kept. */
const IMAGE_MEDIA_TYPE_RE = /^image\/[a-z0-9.+-]+$/i

/** Windows can never create these device names, even with a file extension. */
const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Maximum characters kept for one tool-call argument blob (same as message-text). */
const TOOL_ARG_LIMIT = 400

/** One archived image placeholder; the name may not contain a newline or `）`. */
const PLACEHOLDER_RE = new RegExp(`\\[图片：（([^\\n）]{1,${MAX_PLACEHOLDER_NAME_LENGTH}})）\\]`, 'g')

/**
 * Shorten one string for display/storage without throwing on odd input.
 * Mirrors lib/message-text.js `truncate` (kept local so this module stays a leaf).
 * @param {any} value
 * @param {number} limit
 * @returns {string}
 */
function truncate(value, limit) {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…[+${text.length - limit}]`
}

/** Coerce any JSON/attachment number to a non-negative integer (else 0). */
function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

/**
 * Normalize one attachment media type. A missing/broken media type is repaired
 * from the stored image name extension when possible, otherwise rejected.
 * @param {any} value
 * @param {string} name
 * @returns {string} normalized media type or '' when unknown
 */
function normalizeMediaType(value, name) {
  if (typeof value === 'string') {
    const mediaType = value.trim().toLowerCase()
    if (IMAGE_MEDIA_TYPE_RE.test(mediaType)) return mediaType
  }
  if (typeof name === 'string' && name.length > 0) {
    return MEDIA_TYPE_BY_EXTENSION[path.extname(name).toLowerCase()] ?? ''
  }
  return ''
}

/**
 * Validate the attachment of one DSH `{ type: 'image', attachment }` block.
 * @param {any} attachment
 * @returns {{ mediaType: string, width: number, height: number, bytes: number, attachmentId: string } | null}
 *   normalized metadata, or `null` when the block is not a usable image reference
 */
function normalizeAttachmentImage(attachment) {
  if (attachment === null || typeof attachment !== 'object' || Array.isArray(attachment)) return null
  const attachmentId = typeof attachment.attachmentId === 'string' ? attachment.attachmentId.trim() : ''
  if (attachmentId.length === 0) return null
  const mediaType = normalizeMediaType(attachment.mediaType, '')
  if (mediaType.length === 0) return null
  return {
    mediaType,
    width: nonNegativeInteger(attachment.width),
    height: nonNegativeInteger(attachment.height),
    bytes: nonNegativeInteger(attachment.bytes),
    attachmentId,
  }
}

/** Deterministic fallback name for the n-th image (`image-1.png`, `image-2.jpg`, …). */
function defaultImageName(imageIndex, mediaType) {
  return `image-${imageIndex + 1}${imageExtension(mediaType)}`
}

/** Split `name` into base + last extension (no extension → extension ''). */
function splitNameExtension(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { base: name, extension: '' }
  return { base: name.slice(0, dot), extension: name.slice(dot) }
}

/**
 * Make one image name unique inside one content walk by suffixing `-2`, `-3`, …
 * before the extension. Deterministic for a deterministic input walk.
 * @param {string} name
 * @param {Set<string>} usedNames
 * @returns {string}
 */
function uniqueImageName(name, usedNames) {
  if (!usedNames.has(name)) {
    usedNames.add(name)
    return name
  }
  const { base, extension } = splitNameExtension(name)
  for (let counter = 2; ; counter += 1) {
    const suffix = `-${counter}`
    const room = MAX_IMAGE_NAME_LENGTH - extension.length - suffix.length
    const candidate = `${base.slice(0, Math.max(1, room))}${suffix}${extension}`
    if (usedNames.has(candidate)) continue
    usedNames.add(candidate)
    return candidate
  }
}

/** Throw a TypeError for a missing/blank memory directory. */
function assertMemoryDir(memoryDir) {
  if (typeof memoryDir !== 'string' || memoryDir.trim().length === 0) {
    throw new TypeError('memoryDir must be a non-empty string')
  }
}

/** Whether `name` can be used verbatim as one file name under the image folder. */
function isSafeImageName(name) {
  return typeof name === 'string' && SAFE_IMAGE_NAME_RE.test(name)
}

/** Copy any accepted byte input into a Buffer without sharing mutable state. */
function toByteBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8')
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes)
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  throw new TypeError('image bytes must be a Buffer, Uint8Array, ArrayBuffer or string')
}

/**
 * Canonical file extension for one conversation image media type.
 * Unknown or missing media types fall back to `.png` (never throw).
 * @param {any} mediaType
 * @returns {string}
 */
export function imageExtension(mediaType) {
  if (typeof mediaType !== 'string') return '.png'
  return IMAGE_EXTENSIONS[mediaType.trim().toLowerCase()] ?? '.png'
}

/**
 * Placeholder written into archived/recalled text where one image block sat.
 * The format is fixed (full-width brackets) so image positions stay greppable.
 * @param {string} name
 * @returns {string}
 */
export function imagePlaceholder(name) {
  return `[图片：（${typeof name === 'string' ? name : ''}）]`
}

/**
 * Find every image placeholder in `text`, in order.
 * `start`/`end` are JS string offsets with `end` exclusive, so
 * `text.slice(entry.start, entry.end) === imagePlaceholder(entry.name)`.
 * Names are 1..200 chars and may not contain a newline or `）`.
 * @param {any} text
 * @returns {Array<{ name: string, start: number, end: number }>}
 */
export function parseImagePlaceholders(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const placeholders = []
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    placeholders.push({ name: match[1], start: match.index, end: match.index + match[0].length })
  }
  return placeholders
}

/**
 * Render message content to archived text, replacing each image block with its
 * placeholder and collecting that image's metadata. Non-image blocks render
 * exactly like lib/message-text.js `contentToText` (text/tool-call/tool-result/
 * tool-addition/tool-removal/file/reasoning); unknown blocks are ignored.
 *
 * `nameFor(imageIndex, block)` returns the name to store for the image
 * (0-based ordinal among the images emitted by this walk). Its result is
 * sanitized; when it is missing, throws, is not a string or sanitizes to empty,
 * the deterministic fallback `image-<n>.<ext>` is used. Repeated names are
 * deduplicated deterministically (`dup.png`, `dup-2.png`, …).
 *
 * @param {any} content DSH message content (string or block array)
 * @param {(imageIndex: number, block: any) => string} [nameFor]
 * @returns {{ text: string, images: Array<{ name: string, placeholder: string, mediaType: string, width: number, height: number, bytes: number, attachmentId: string }> }}
 */
export function contentToTextWithImages(content, nameFor) {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const nameOf = typeof nameFor === 'function' ? nameFor : null
  const parts = []
  const images = []
  const usedNames = new Set()
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`[tool-call ${block.name ?? 'unknown'} ${truncate(block.arguments, TOOL_ARG_LIMIT)}]`)
        break
      case 'tool-result':
      case 'reasoning':
        break
      case 'tool-addition':
        parts.push(`[tool-added ${block.toolName ?? 'unknown'}]`)
        break
      case 'tool-removal':
        parts.push(`[tool-removed ${block.toolName ?? 'unknown'}]`)
        break
      case 'image': {
        const normalized = normalizeAttachmentImage(block.attachment)
        if (normalized === null) break
        const imageIndex = images.length
        let rawName = ''
        if (nameOf !== null) {
          try {
            rawName = nameOf(imageIndex, block)
          } catch {
            rawName = ''
          }
        }
        let name = sanitizeImageName(rawName)
        if (name.length === 0) name = defaultImageName(imageIndex, normalized.mediaType)
        name = uniqueImageName(name, usedNames)
        const placeholder = imagePlaceholder(name)
        parts.push(placeholder)
        images.push({ name, placeholder, ...normalized })
        break
      }
      case 'file':
        parts.push(`[file ${block.attachment?.name ?? ''}]`)
        break
      default:
        break
    }
  }
  return { text: parts.join('\n').trim(), images }
}

/**
 * Reduce an arbitrary string to one basename-safe image name. The result only
 * contains `[A-Za-z0-9._-]`, always contains at least one ASCII letter/digit,
 * never starts or ends with `.`, is at most 120 chars and is never `.`/`..`;
 * Windows device names get a leading `_` (`CON` → `_CON`). Unsafe character
 * runs become `_`, so path separators can never survive. Returns `''` when
 * nothing usable is left (callers fall back to a generated name).
 * @param {any} name
 * @returns {string}
 */
export function sanitizeImageName(name) {
  if (typeof name !== 'string') return ''
  let safeName = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
  safeName = safeName.slice(0, MAX_IMAGE_NAME_LENGTH).replace(/\.+$/, '')
  if (safeName.length === 0 || !/[A-Za-z0-9]/.test(safeName)) return ''
  const stem = safeName.split('.')[0]
  if (WINDOWS_RESERVED_NAME_RE.test(stem)) {
    safeName = `_${safeName}`.slice(0, MAX_IMAGE_NAME_LENGTH)
  }
  return safeName
}

/**
 * Absolute path of the per-session image folder (`<memoryDir>/images`).
 * The folder is not created here.
 * @param {string} memoryDir
 * @returns {string}
 */
export function imageFolderPath(memoryDir) {
  assertMemoryDir(memoryDir)
  return path.join(memoryDir, IMAGE_FOLDER_NAME)
}

/**
 * Create the image folder (recursively) and return its path. Idempotent.
 * @param {string} memoryDir
 * @returns {string}
 */
export function ensureImageFolder(memoryDir) {
  const folder = imageFolderPath(memoryDir)
  fs.mkdirSync(folder, { recursive: true })
  return folder
}

/**
 * Path of one stored image file. Throws when `name` is not a safe single path
 * segment (this is the last line of defence against path traversal).
 * @param {string} memoryDir
 * @param {string} name
 * @returns {string}
 */
export function imageFilePath(memoryDir, name) {
  const folder = imageFolderPath(memoryDir)
  if (!isSafeImageName(name)) throw new Error(`invalid image file name: ${JSON.stringify(name)}`)
  return path.join(folder, name)
}

/**
 * Atomically-ish write one image: temp file in the image folder, then rename
 * over the target. Creates the image folder when missing.
 * @param {string} memoryDir
 * @param {string} name safe file name (validated, throws otherwise)
 * @param {Buffer|Uint8Array|ArrayBuffer|string} bytes
 * @returns {{ name: string, path: string, bytes: number }}
 */
export function saveImageFile(memoryDir, name, bytes) {
  const filePath = imageFilePath(memoryDir, name)
  const data = toByteBuffer(bytes)
  const folder = path.dirname(filePath)
  fs.mkdirSync(folder, { recursive: true })
  const tmpPath = path.join(
    folder,
    `.${name}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    fs.writeFileSync(tmpPath, data)
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      /* best effort: the temp file may not exist */
    }
    throw error
  }
  return { name, path: filePath, bytes: data.byteLength }
}

/**
 * Read one stored image file back. Missing files, unsafe names and read errors
 * all return `undefined` (best effort: recall keeps the placeholder instead).
 * @param {string} memoryDir
 * @param {string} name
 * @returns {Buffer | undefined}
 */
export function loadImageFile(memoryDir, name) {
  if (!isSafeImageName(name)) return undefined
  try {
    return fs.readFileSync(imageFilePath(memoryDir, name))
  } catch {
    return undefined
  }
}

/**
 * Remove the given image files (best effort). Unsafe names are skipped, missing
 * files and unlink errors are ignored.
 * @param {string} memoryDir
 * @param {any} names
 * @returns {number} number of files actually removed
 */
export function removeImageFiles(memoryDir, names) {
  if (!Array.isArray(names) || names.length === 0) return 0
  let removed = 0
  for (const name of names) {
    if (!isSafeImageName(name)) continue
    try {
      fs.unlinkSync(imageFilePath(memoryDir, name))
      removed += 1
    } catch {
      /* best effort */
    }
  }
  return removed
}

/**
 * List stored image files (regular files with a safe name and a known image
 * extension), sorted lexicographically. A missing image folder lists as `[]`.
 * @param {string} memoryDir
 * @returns {string[]}
 */
export function listImageFiles(memoryDir) {
  let dirents
  try {
    dirents = fs.readdirSync(imageFolderPath(memoryDir), { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue
    const name = dirent.name
    if (!isSafeImageName(name)) continue
    if (MEDIA_TYPE_BY_EXTENSION[path.extname(name).toLowerCase()] === undefined) continue
    names.push(name)
  }
  names.sort()
  return names
}

/**
 * Validate one `meta.images` array read back from disk (or handed over by a
 * caller). Malformed entries are dropped, names are sanitized and deduplicated
 * (first valid entry wins), placeholders are regenerated from the name, and a
 * missing media type is repaired from the file extension when possible.
 * @param {any} value
 * @returns {Array<{ name: string, placeholder: string, mediaType: string, width: number, height: number, bytes: number, attachmentId: string }>}
 */
export function normalizeImageMeta(value) {
  const images = []
  if (!Array.isArray(value)) return images
  const seen = new Set()
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const name = sanitizeImageName(item.name)
    if (name.length === 0 || seen.has(name)) continue
    const mediaType = normalizeMediaType(item.mediaType, name)
    if (mediaType.length === 0) continue
    const attachmentId = typeof item.attachmentId === 'string' ? item.attachmentId.trim() : ''
    if (attachmentId.length === 0) continue
    seen.add(name)
    images.push({
      name,
      placeholder: imagePlaceholder(name),
      mediaType,
      width: nonNegativeInteger(item.width),
      height: nonNegativeInteger(item.height),
      bytes: nonNegativeInteger(item.bytes),
      attachmentId,
    })
  }
  return images
}

/**
 * Split recalled/archived `text` at image placeholders and re-insert DSH image
 * content blocks. For each placeholder whose name is known in `images`,
 * `resolveAttachment(name, image)` is called; when it returns a non-null ref the
 * placeholder is replaced by `{ type: 'image', attachment: ref }`, otherwise the
 * placeholder stays in the surrounding text unchanged.
 *
 * All non-placeholder text is preserved exactly: concatenating the returned
 * text blocks (and putting `imagePlaceholder(name)` back for image blocks)
 * reproduces `text` byte for byte. Empty text yields `[]`.
 *
 * @param {any} text
 * @param {any} images image metadata array (e.g. `meta.images`)
 * @param {(name: string, image: any) => any} [resolveAttachment]
 * @returns {Array<{ type: 'text', text: string } | { type: 'image', attachment: any }>}
 */
export function interleaveImageBlocks(text, images, resolveAttachment) {
  const source = typeof text === 'string' ? text : ''
  if (source.length === 0) return []
  const byName = new Map()
  if (Array.isArray(images)) {
    for (const image of images) {
      if (image === null || typeof image !== 'object' || Array.isArray(image)) continue
      const name = sanitizeImageName(image.name)
      if (name.length === 0 || byName.has(name)) continue
      byName.set(name, image)
    }
  }
  const resolve = typeof resolveAttachment === 'function' ? resolveAttachment : null
  const blocks = []
  let cursor = 0
  for (const marker of parseImagePlaceholders(source)) {
    const image = byName.get(marker.name)
    if (image === undefined || resolve === null) continue
    const ref = resolve(marker.name, image)
    if (ref === undefined || ref === null) continue
    if (marker.start > cursor) blocks.push({ type: 'text', text: source.slice(cursor, marker.start) })
    blocks.push({ type: 'image', attachment: ref })
    cursor = marker.end
  }
  if (cursor < source.length) blocks.push({ type: 'text', text: source.slice(cursor) })
  return blocks
}

/**
 * Aggregate one image metadata array for telemetry/diagnostics (normalizes
 * first, so malformed entries are not counted).
 * @param {any} images
 * @returns {{ count: number, totalBytes: number, byMediaType: Record<string, number> }}
 */
export function imageFolderSummary(images) {
  const entries = normalizeImageMeta(images)
  const byMediaType = {}
  let totalBytes = 0
  for (const image of entries) {
    totalBytes += image.bytes
    byMediaType[image.mediaType] = (byMediaType[image.mediaType] ?? 0) + 1
  }
  const sortedByMediaType = {}
  for (const mediaType of Object.keys(byMediaType).sort()) sortedByMediaType[mediaType] = byMediaType[mediaType]
  return { count: entries.length, totalBytes, byMediaType: sortedByMediaType }
}

// ---------------------------------------------------------------- image index
// The per-session `images/index.json` is a fast lookup table for the
// `memory_image` tool: it maps every archived image file to the memory folder it
// belongs to, without scanning all `mem-*/meta.json` files on each model call.
// The image files themselves stay the source of truth: the tool verifies every
// path and silently skips entries whose file/folder disappeared.

const IMAGE_INDEX_FILE = 'index.json'
const SAFE_FOLDER_ID = /^[A-Za-z0-9._-]+$/

/** Absolute path of the per-session image lookup index (`<memoryDir>/images/index.json`). */
export function imageIndexPath(memoryDir) {
  return path.join(imageFolderPath(memoryDir), IMAGE_INDEX_FILE)
}

/** Validate one raw index entry; returns undefined for malformed entries. */
function normalizeIndexEntry(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
  const name = sanitizeImageName(item.name)
  if (name.length === 0) return undefined
  const folderId = typeof item.folderId === 'string' && SAFE_FOLDER_ID.test(item.folderId) && item.folderId !== '.' && item.folderId !== '..'
    ? item.folderId
    : ''
  if (folderId.length === 0) return undefined
  const mediaType = normalizeMediaType(item.mediaType, name)
  if (mediaType.length === 0) return undefined
  const keywords = Array.isArray(item.keywords) ? item.keywords.filter((keyword) => typeof keyword === 'string') : []
  return {
    name,
    folderId,
    mediaType,
    width: nonNegativeInteger(item.width),
    height: nonNegativeInteger(item.height),
    bytes: nonNegativeInteger(item.bytes),
    createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : 0,
    keywords,
    title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
  }
}

/**
 * Read the image lookup index. Missing/corrupt files read as an empty index.
 * @param {string} memoryDir
 * @returns {{ version: number, updatedAt: number, images: object[] }}
 */
export function readImageIndex(memoryDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(imageIndexPath(memoryDir), 'utf8'))
    const raw = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.images) ? parsed.images : []
    const images = []
    const seen = new Set()
    for (const item of raw) {
      const entry = normalizeIndexEntry(item)
      if (entry === undefined || seen.has(entry.name)) continue
      seen.add(entry.name)
      images.push(entry)
    }
    return { version: 1, updatedAt: Number(parsed?.updatedAt) || 0, images }
  } catch {
    return { version: 1, updatedAt: 0, images: [] }
  }
}

/**
 * Atomically write the image lookup index (temp file + rename in the same folder).
 * Failure is best effort: the image files remain usable without the index.
 * @param {string} memoryDir
 * @param {object[]} entries
 */
export function writeImageIndex(memoryDir, entries) {
  const images = []
  const seen = new Set()
  for (const item of Array.isArray(entries) ? entries : []) {
    const entry = normalizeIndexEntry(item)
    if (entry === undefined || seen.has(entry.name)) continue
    seen.add(entry.name)
    images.push(entry)
  }
  images.sort((a, b) => a.createdAt - b.createdAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const folder = ensureImageFolder(memoryDir)
  const file = path.join(folder, IMAGE_INDEX_FILE)
  const tmp = path.join(folder, `.${IMAGE_INDEX_FILE}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  const payload = { version: 1, updatedAt: Date.now(), images }
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
  return images
}

/**
 * Merge new image entries into the lookup index and drop retired names.
 * Best effort: never throws (the index is an optimisation, not data).
 * @param {string} memoryDir
 * @param {any[]} entries
 * @param {any[]} [removeNames]
 * @returns {object[]} the merged image list
 */
export function upsertImageIndexEntries(memoryDir, entries, removeNames = []) {
  try {
    const current = readImageIndex(memoryDir).images
    const removed = new Set((Array.isArray(removeNames) ? removeNames : []).map((name) => sanitizeImageName(name)).filter(Boolean))
    const byName = new Map()
    for (const entry of current) if (!removed.has(entry.name)) byName.set(entry.name, entry)
    for (const entry of Array.isArray(entries) ? entries : []) {
      const normalized = normalizeIndexEntry(entry)
      if (normalized !== undefined) byName.set(normalized.name, normalized)
    }
    return writeImageIndex(memoryDir, [...byName.values()])
  } catch {
    return []
  }
}

/**
 * Absolute file path of one image and whether the file currently exists.
 * @param {string} memoryDir
 * @param {string} name
 * @returns {{ name: string, path: string, exists: boolean }}
 */
export function imageFileInfo(memoryDir, name) {
  const safeName = sanitizeImageName(name)
  if (safeName.length === 0) return { name: String(name ?? ''), path: '', exists: false }
  let filePath = ''
  try {
    filePath = imageFilePath(memoryDir, safeName)
  } catch {
    return { name: safeName, path: '', exists: false }
  }
  let exists = false
  try {
    exists = fs.existsSync(filePath)
  } catch {
    exists = false
  }
  return { name: safeName, path: filePath, exists }
}

/**
 * Replace every `[图片：（<name>）]` placeholder in `text` with a path hint:
 * `[图片：（<name>，文件：<absolute path>）]` (plus `（缺失）` when the file is gone).
 * This is the v1.2.x path-based image recall: the recall block and recall tool
 * output show *where the file is* instead of re-attaching image bytes; the model
 * can read it with the host `read_image` tool. Non-placeholder text is preserved
 * byte-for-byte.
 * @param {string} text
 * @param {string} memoryDir
 * @returns {string}
 */
export function injectImagePaths(text, memoryDir) {
  const source = typeof text === 'string' ? text : ''
  if (source.length === 0 || !source.includes('[图片：（')) return source
  let out = ''
  let cursor = 0
  for (const marker of parseImagePlaceholders(source)) {
    out += source.slice(cursor, marker.start)
    try {
      const info = imageFileInfo(memoryDir, marker.name)
      out += `[图片：（${marker.name}，文件：${info.path}${info.exists ? '' : '（缺失）'}）]`
    } catch {
      out += source.slice(marker.start, marker.end)
    }
    cursor = marker.end
  }
  return out + source.slice(cursor)
}
