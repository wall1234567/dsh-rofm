/**
 * dsh-rofm engine — persistent storage.
 *
 * Layout (docs/SPEC.md §3):
 *
 *   <memoryDir>/
 *   ├── index.json          fast recall path (always consistent with folders)
 *   ├── stats.jsonl         append-only telemetry (best effort)
 *   └── mem-<stamp>-<NNNN>/ meta.json + context.json
 *
 * All JSON writes are atomic: write a temp file in the same directory then
 * `renameSync` over the target. The index is disposable: `loadIndex` rebuilds it
 * from `memory/ * /meta.json` whenever it is missing or corrupt.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CONFIG, normalizeBeta } from './config.js'

const INDEX_VERSION = 1
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/
const FOLDER_ID_RE = /^mem-(\d{8}T\d{6}Z)-(\d{4})$/

/** Whether `id` is safe as a single path segment (never '.' or '..'). */
function isSafeFolderId(id) {
  return typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..' && SAFE_ID_RE.test(id)
}

/** Validate a folder id before using it as a path segment. */
function assertSafeId(id) {
  if (!isSafeFolderId(id)) {
    throw new Error(`invalid memory folder id: ${JSON.stringify(id)}`)
  }
  return id
}

/** @returns {{ indexPath: string, statsPath: string }} */
export function memoryPaths(memoryDir, cfg) {
  const storage = (cfg && cfg.storage) || DEFAULT_CONFIG.storage
  const indexFile = typeof storage.indexFile === 'string' && storage.indexFile ? storage.indexFile : DEFAULT_CONFIG.storage.indexFile
  const statsFile = typeof storage.statsFile === 'string' && storage.statsFile ? storage.statsFile : DEFAULT_CONFIG.storage.statsFile
  return {
    indexPath: path.join(memoryDir, indexFile),
    statsPath: path.join(memoryDir, statsFile),
  }
}

/** Create the memory directory if needed and return it. */
export function ensureMemoryDir(memoryDir) {
  fs.mkdirSync(memoryDir, { recursive: true })
  return memoryDir
}

/**
 * Atomic JSON write: temp file in the same directory, then rename.
 * @param {string} filePath
 * @param {any} value
 */
export function atomicWriteJson(filePath, value) {
  const data = JSON.stringify(value)
  if (data === undefined) throw new TypeError(`atomicWriteJson: value for ${filePath} is not JSON serializable`)
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    fs.writeFileSync(tmp, data, 'utf8')
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
  return filePath
}

/** Compact UTC stamp used by folder ids: 20261023T110000Z */
export function folderStamp(now) {
  const date = new Date(Number.isFinite(now) ? now : Date.now())
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z'
}

/** Build `mem-<UTC timestamp>-<4 digit counter>` exactly as documented. */
export function formatFolderId(now, counter) {
  const safeCounter = Number.isInteger(counter) && counter > 0 ? counter : 1
  return `mem-${folderStamp(now)}-${String(safeCounter).padStart(4, '0')}`
}

function counterFromId(id) {
  const match = typeof id === 'string' ? FOLDER_ID_RE.exec(id) : null
  return match ? Number.parseInt(match[2], 10) : 0
}

function computeNextCounter(folders) {
  let max = 0
  for (const folder of folders || []) {
    const counter = counterFromId(folder && folder.id)
    if (counter > max) max = counter
  }
  return max + 1
}

/** 0.01 fallback keeps alpha usable even for hand-written folders. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Build one index folder entry from a `meta.json` object (or normalize an
 * already built index entry; `writeIndex` re-normalizes entries).
 */
export function indexEntryFromMeta(meta) {
  const source = meta && typeof meta === 'object' ? meta : {}
  const stats = source.stats && typeof source.stats === 'object' ? source.stats : null
  return {
    id: source.id,
    createdAt: numberOr(source.createdAt, 0),
    alpha: numberOr(source.alpha, 0.01),
    beta: normalizeBeta(source.beta),
    // A folder archived by the adapter starts as `scored: false` until the model
    // submits α/β/keywords via the memory_judge tool; legacy folders without the
    // field are already usable for recall.
    scored: source.scored !== false,
    rescorePending: source.rescorePending === true,
    keywords: Array.isArray(source.keywords) ? source.keywords.filter((keyword) => typeof keyword === 'string') : [],
    chars: stats ? numberOr(stats.chars, 0) : numberOr(source.chars, 0),
    tokens: stats ? numberOr(stats.tokens, 0) : numberOr(source.tokens, 0),
    messageCount: stats ? numberOr(stats.messages, 0) : numberOr(source.messageCount, 0),
    title: typeof source.title === 'string' ? source.title : '',
  }
}

/** Normalize/repair a raw parsed index object. */
export function normalizeIndex(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const folders = []
  const seen = new Set()
  const rawFolders = Array.isArray(source.folders) ? source.folders : []
  for (const item of rawFolders) {
    if (!item || typeof item !== 'object') continue
    if (!isSafeFolderId(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    folders.push(indexEntryFromMeta(item))
  }
  folders.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    ...source,
    version: INDEX_VERSION,
    updatedAt: numberOr(source.updatedAt, Date.now()),
    nextCounter: Number.isInteger(source.nextCounter) && source.nextCounter >= 1 ? source.nextCounter : computeNextCounter(folders),
    folders,
  }
}

/** Read and parse `index.json`; returns `null` when missing/corrupt. */
export function readIndex(memoryDir, cfg) {
  try {
    const { indexPath } = memoryPaths(memoryDir, cfg)
    const raw = fs.readFileSync(indexPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.folders)) return null
    return normalizeIndex(parsed)
  } catch {
    return null
  }
}

/** Scan every `memory/<id>/meta.json`; corrupt folders are skipped. */
export function scanFolderMetas(memoryDir) {
  ensureMemoryDir(memoryDir)
  let dirents = []
  try {
    dirents = fs.readdirSync(memoryDir, { withFileTypes: true })
  } catch {
    return []
  }
  const metas = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    if (!isSafeFolderId(dirent.name)) continue
    const metaPath = path.join(memoryDir, dirent.name, 'meta.json')
    try {
      const raw = fs.readFileSync(metaPath, 'utf8')
      const meta = JSON.parse(raw)
      if (!meta || typeof meta !== 'object') continue
      if (typeof meta.id !== 'string' || !meta.id) meta.id = dirent.name
      metas.push(meta)
    } catch {
      /* missing/corrupt meta.json: ignore this folder */
    }
  }
  metas.sort((a, b) => numberOr(a.createdAt, 0) - numberOr(b.createdAt, 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return metas
}

/** Rebuild `index.json` by scanning folder `meta.json` files. */
export function rebuildIndex(memoryDir, cfg) {
  ensureMemoryDir(memoryDir)
  const metas = scanFolderMetas(memoryDir)
  const index = {
    version: INDEX_VERSION,
    updatedAt: Date.now(),
    nextCounter: computeNextCounter(metas),
    folders: metas.map((meta) => indexEntryFromMeta(meta)),
  }
  return writeIndex(memoryDir, cfg, index)
}

/** Atomically write the index (updates `updatedAt`); returns the written object. */
export function writeIndex(memoryDir, cfg, index) {
  ensureMemoryDir(memoryDir)
  const folders = (index && Array.isArray(index.folders) ? index.folders : [])
    .filter((folder) => isSafeFolderId(folder?.id))
    .map((folder) => indexEntryFromMeta(folder))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const nextFromFolders = computeNextCounter(folders)
  const nextCounter = Math.max(
    Number.isInteger(index && index.nextCounter) && index.nextCounter >= 1 ? index.nextCounter : 1,
    nextFromFolders,
  )
  const written = {
    ...(index && typeof index === 'object' ? index : {}),
    version: INDEX_VERSION,
    updatedAt: Date.now(),
    nextCounter,
    folders,
  }
  const { indexPath } = memoryPaths(memoryDir, cfg)
  atomicWriteJson(indexPath, written)
  return written
}

/**
 * Load the index, rebuilding it from folder `meta.json` files when it is
 * missing or corrupt. Never throws for corrupt data.
 */
export function loadIndex(memoryDir, cfg) {
  ensureMemoryDir(memoryDir)
  const index = readIndex(memoryDir, cfg)
  if (index) return index
  return rebuildIndex(memoryDir, cfg)
}

/** True when the index file changed since `cache.mtimeMs` / `cache.size`. */
export function refreshIndex(memoryDir, cfg, cache) {
  ensureMemoryDir(memoryDir)
  const { indexPath } = memoryPaths(memoryDir, cfg)
  let stat = null
  try {
    stat = fs.statSync(indexPath)
  } catch {
    stat = null
  }
  // Backward-compatible cache shape: older callers only tracked mtimeMs.
  const sameSize = !cache || cache.size === undefined || cache.size === stat?.size
  if (stat && cache && cache.index && cache.mtimeMs === stat.mtimeMs && sameSize) {
    return { index: cache.index, mtimeMs: stat.mtimeMs, size: stat.size, reloaded: false }
  }
  const index = loadIndex(memoryDir, cfg)
  let mtimeMs = -1
  let size = -1
  try {
    const after = fs.statSync(indexPath)
    mtimeMs = after.mtimeMs
    size = after.size
  } catch {
    mtimeMs = -1
    size = -1
  }
  return { index, mtimeMs, size, reloaded: true }
}

/** Folder entries of the (rebuilt when needed) index. */
export function listFolders(memoryDir, cfg) {
  return loadIndex(memoryDir, cfg).folders
}

/** Absolute directory of one folder (id validated). */
export function folderDir(memoryDir, id) {
  return path.join(memoryDir, assertSafeId(id))
}

/** Whether `memory/<id>/meta.json` exists. */
export function folderExists(memoryDir, id) {
  try {
    return fs.existsSync(path.join(folderDir(memoryDir, id), 'meta.json'))
  } catch {
    return false
  }
}

/** Read one folder: meta + context + messages. */
export function readFolder(memoryDir, id) {
  const dir = folderDir(memoryDir, id)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  const context = JSON.parse(fs.readFileSync(path.join(dir, 'context.json'), 'utf8'))
  const messages = Array.isArray(context.messages) ? context.messages : []
  return { id: typeof meta.id === 'string' ? meta.id : id, meta, context, messages, dir }
}

/**
 * Atomically write `context.json` then `meta.json` (meta is the commit marker).
 * @param {string} memoryDir
 * @param {{ id: string, meta: object, messages?: any[], context?: object }} folder
 */
export function writeFolder(memoryDir, folder) {
  const id = assertSafeId(folder && folder.id)
  const messages = Array.isArray(folder.messages) ? folder.messages : []
  const meta = {
    version: INDEX_VERSION,
    ...(folder.meta && typeof folder.meta === 'object' ? folder.meta : {}),
    id,
  }
  if (!Number.isFinite(meta.createdAt)) meta.createdAt = Date.now()
  if (!meta.stats || typeof meta.stats !== 'object') meta.stats = { messages: messages.length, chars: 0, tokens: 0 }
  const context = folder.context && typeof folder.context === 'object'
    ? { ...folder.context, version: INDEX_VERSION, id, createdAt: numberOr(folder.context.createdAt, meta.createdAt), messages }
    : { version: INDEX_VERSION, id, createdAt: meta.createdAt, messages }
  const dir = folderDir(memoryDir, id)
  fs.mkdirSync(dir, { recursive: true })
  atomicWriteJson(path.join(dir, 'context.json'), context)
  atomicWriteJson(path.join(dir, 'meta.json'), meta)
  return { id, dir, meta, context, messages }
}

/**
 * Allocate the next unique folder id and advance `index.nextCounter` in place.
 * Collisions with folders already on disk are skipped.
 */
export function allocateFolderId(memoryDir, cfg, index, now) {
  const safeIndex = index && typeof index === 'object' ? index : { folders: [], nextCounter: 1 }
  let counter = Number.isInteger(safeIndex.nextCounter) && safeIndex.nextCounter >= 1
    ? safeIndex.nextCounter
    : computeNextCounter(Array.isArray(safeIndex.folders) ? safeIndex.folders : [])
  let id = formatFolderId(now, counter)
  let guard = 0
  while (folderExists(memoryDir, id) && guard < 100000) {
    counter += 1
    id = formatFolderId(now, counter)
    guard += 1
  }
  safeIndex.nextCounter = counter + 1
  return id
}

/**
 * Append one telemetry event (best effort: telemetry failures never break
 * compression/recall). Adds `time` when missing.
 * @returns {boolean} true when the line was written
 */
export function appendStats(memoryDir, cfg, event) {
  try {
    ensureMemoryDir(memoryDir)
    const { statsPath } = memoryPaths(memoryDir, cfg)
    const record = {
      ...(event && typeof event === 'object' ? event : {}),
      type: (event && typeof event.type === 'string' && event.type) || 'event',
    }
    if (!Number.isFinite(record.time)) record.time = Date.now()
    fs.appendFileSync(statsPath, JSON.stringify(record) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** Read all telemetry events; corrupt lines are skipped. */
export function readStats(memoryDir, cfg) {
  try {
    const { statsPath } = memoryPaths(memoryDir, cfg)
    const raw = fs.readFileSync(statsPath, 'utf8')
    const events = []
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed)
      } catch {
        /* keep best effort: ignore corrupt telemetry lines */
      }
    }
    return events
  } catch {
    return []
  }
}
