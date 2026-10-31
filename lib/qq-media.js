/**
 * dsh-rofm — QQ channel local-media parsing/validation/staging (compat plan D12).
 *
 * `dsh-onebot-qq` delivers inbound images and voices as *text annotations* that
 * embed a local file path, not as DSH attachment blocks, e.g. the body carries
 * `[图片:C:\Users\...\media_1730000000_ab12cd34.jpg]` (see the bridge's
 * `lib/inbound.js` → `resolveMediaRef`; voice keeps a bare `[语音]`). rofm's
 * normal image path (`agent/pre-step` → image blocks → `<memoryDir>/images/`)
 * therefore never sees them.
 *
 * This module is the DSH-free half of the fix:
 *
 *   - `parseMediaPaths(text)` finds local image paths in arbitrary text
 *     (Windows drive paths in both separator styles, Unix absolute paths,
 *     Chinese file names, spaces and wrapping quotes/brackets);
 *   - `validateMediaPath(candidate)` proves a candidate is a real regular file,
 *     with a whitelisted image extension, under a configured media root and
 *     within a size cap — `realpath` is resolved first, so `..` tricks, symlink
 *     escapes and cross-drive paths are all rejected;
 *   - `stageMessageMedia()` copies the validated files into
 *     `<memoryDir>/.staging/<messageId>/` while the bridge's temporary files
 *     still exist, and records `index.json` for the later archive step;
 *   - `listStagedMedia()` / `takeStagedMedia()` / `cleanupStaging()` read and
 *     retire staging directories (take returns the bytes so archiving still
 *     works after the directory is removed).
 *
 * Contract: plain strings/objects/Buffers in and out, no DSH/Cordis imports,
 * zero third-party dependencies, and *no exported function ever throws* —
 * malformed input or filesystem errors degrade to an empty result / `0`.
 *
 * Like `lib/images.js` this module is a leaf: it does not import other rofm
 * modules, so wiring it into `plugin.js` cannot create import cycles.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Image file extensions accepted from message text (canonical lowercase). */
export const MEDIA_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])

/** Media type stored in staging entries for each accepted extension. */
const MEDIA_TYPE_BY_EXTENSION = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
})

/** Default per-file size cap when the caller does not configure one (8 MiB). */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** Default staging TTL: one day without being archived. */
const DEFAULT_STAGING_TTL_MS = 24 * 60 * 60 * 1000

/** Folder inside `<memoryDir>` that holds per-message staging directories. */
const STAGING_FOLDER_NAME = '.staging'

/** Per-message index file inside one staging directory. */
const STAGING_INDEX_FILE = 'index.json'

/** Current staging index schema version. */
const STAGING_INDEX_VERSION = 1

/** Longest path fragment of a message id kept as one staging directory name. */
const MAX_SAFE_MESSAGE_ID_LENGTH = 120

/** Longest candidate path accepted by the text scan (defensive bound). */
const MAX_CANDIDATE_LENGTH = 4096

/** Hard cap on bytes `takeStagedMedia()` will read into memory per file. */
const MAX_STAGED_READ_BYTES = 32 * 1024 * 1024

/** Windows device names that cannot be used as a directory even with a suffix. */
const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** A staged file is exactly `<ordinal>.<whitelisted extension>`. */
const STAGED_NAME_RE = /^([0-9]{1,9})\.(jpg|jpeg|png|gif|webp|bmp)$/i

/** An indexed/staged media type must look like `image/<subtype>`. */
const IMAGE_MEDIA_TYPE_RE = /^image\/[a-z0-9.+-]+$/i

/**
 * Text-scan regex (source kept as a string so each call gets a fresh `lastIndex`).
 *
 * The candidate body may not cross: control characters, newlines, `]` (onebot's
 * annotation terminator) or characters Windows forbids in names. The lazy
 * `{0,2048}?` plus the extension anchor makes an over-long lookahead impossible,
 * and `(?![A-Za-z0-9_\\/])` forces the engine to keep backtracking when the
 * "extension" is really a dotted directory name (`C:\imgs.png\a.jpg`).
 */
const EXTENSION_NAMES = MEDIA_EXTENSIONS.map((extension) => extension.slice(1)).join('|')
const MEDIA_PATH_SOURCE = String.raw`(?<![A-Za-z0-9._\\/~-])((?:[A-Za-z]:[\\/]|\/(?!\/))[^\u0000-\u001f\r\n<>:"|?*\]]{0,2048}?\.(?:${EXTENSION_NAMES}))(?![A-Za-z0-9_\\/])`

/**
 * Closing wrappers that may directly follow a path. A path containing spaces is
 * only accepted when it ends at one of these: unquoted prose like
 * `版本 1.2.3 / 2.0.1 foo.png` would otherwise be read as one bogus path.
 */
const CLOSING_WRAPPERS = new Set([']', ')', '）', '】', '」', '』', '》', '"', "'", '`', '>'])

/** Wrappers that may surround a path handed over by a caller (parse already trims). */
const WRAPPER_PAIRS = Object.freeze([
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['[', ']'],
  ['(', ')'],
  ['（', '）'],
  ['【', '】'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['<', '>'],
])

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a value to a non-negative integer, else 0.
 * @param {any} value
 * @returns {number}
 */
function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

/** Media type for one canonical extension; unknown extensions get a binary type. */
function mediaTypeForExtension(extension) {
  return MEDIA_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

/** Repair a stored media type from its extension; non-image/garbage → binary type. */
function normalizeMediaType(value, extension) {
  if (typeof value === 'string') {
    const mediaType = value.trim().toLowerCase()
    if (IMAGE_MEDIA_TYPE_RE.test(mediaType)) return mediaType
  }
  return mediaTypeForExtension(extension)
}

/**
 * Build the two-line log callback used by the staging functions. Accepts either
 * a `log(level, message)` function (rofm's `this.log`) or an object exposing
 * `.debug`/`.info`/`.warn`/`.log`; a broken logger can never break staging.
 * @param {any} logger
 * @returns {(level: string, message: string) => void}
 */
function resolveLogger(logger) {
  if (typeof logger === 'function') {
    return (level, message) => {
      try {
        logger(level, message)
      } catch {
        /* logging must never break the caller */
      }
    }
  }
  if (logger !== null && typeof logger === 'object') {
    return (level, message) => {
      try {
        const method = typeof logger[level] === 'function' ? logger[level] : typeof logger.log === 'function' ? logger.log : null
        if (method !== null) method.call(logger, message)
      } catch {
        /* ignore */
      }
    }
  }
  return () => {}
}

/**
 * Normalize the `mediaRoots` option. Accepts an array of non-empty strings (and,
 * leniently, one string). A missing root cannot contain anything later on.
 * @param {any} value
 * @returns {string[]}
 */
function normalizeMediaRoots(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? [trimmed] : []
  }
  if (!Array.isArray(value)) return []
  const roots = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length > 0 && !roots.includes(trimmed)) roots.push(trimmed)
  }
  return roots
}

/** Normalize the `maxBytes` option: finite and positive, else the 8 MiB default. */
function normalizeMaxBytes(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_BYTES
  const maxBytes = Number(value)
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return DEFAULT_MAX_BYTES
  return Math.floor(maxBytes)
}

/** Normalize the staging TTL: finite and non-negative, else one day. */
function normalizeTtl(value) {
  if (value === undefined || value === null) return DEFAULT_STAGING_TTL_MS
  const ttlMs = Number(value)
  if (!Number.isFinite(ttlMs) || ttlMs < 0) return DEFAULT_STAGING_TTL_MS
  return Math.floor(ttlMs)
}

// ---------------------------------------------------------------------------
// path parsing
// ---------------------------------------------------------------------------

/**
 * Normalize one candidate for de-duplication: Windows drive paths compare
 * case-insensitively with `\` and `/` treated alike (they name the same file);
 * Unix paths stay exactly as found (case-sensitive filesystems).
 * @param {string} candidate
 * @returns {string}
 */
function candidateKey(candidate) {
  if (/^[A-Za-z]:[\\/]/.test(candidate)) {
    return candidate.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
  }
  return candidate
}

/** Whether one candidate has a whitelisted extension (case-insensitive). */
function hasMediaExtension(candidate) {
  return MEDIA_EXTENSIONS.includes(path.extname(candidate).toLowerCase())
}

/**
 * Guard the ambiguous "path may contain spaces" case. A space is allowed inside
 * an absolute path only when (a) the character right after the root prefix is
 * not itself a space and (b) the match is followed by a closing quote/bracket —
 * so the onebot `[图片:<path>]` annotation (or a quoted path) still parses while
 * ordinary prose cannot swallow a following filename into one bogus path.
 * @param {string} candidate
 * @param {string} following character that directly follows the match ('' at EOS)
 * @returns {boolean}
 */
function allowsWhitespaceInPath(candidate, following) {
  if (!/\s/.test(candidate)) return true
  const prefixLength = /^[A-Za-z]:[\\/]/.test(candidate) ? 3 : 1
  if (/\s/.test(candidate.slice(prefixLength, prefixLength + 1))) return false
  return CLOSING_WRAPPERS.has(following)
}

/**
 * Extract local image path candidates from arbitrary text, in appearance order.
 *
 * Recognizes absolute Windows drive paths (`C:\dir\a.png`, `C:/dir/a.png`) and
 * Unix absolute paths (`/home/u/a.png`), including paths wrapped in quotes or
 * brackets (`"...\a.png"`, `（/home/u/a.jpg）`, `[图片:/tmp/a.webp]`) and paths
 * containing spaces or CJK characters. Only paths ending in one of
 * `MEDIA_EXTENSIONS` are returned; relative paths, URLs, and non-image
 * extensions are ignored. Exact duplicates (and Windows `\`/`/`/case variants of
 * the same spelling) are removed keeping the first occurrence.
 *
 * Never throws: non-string input (or an odd `options`, which is reserved for
 * future filters) yields `[]`.
 * @param {any} text message text (onebot puts `[图片:<local path>]` in it)
 * @param {object} [options] reserved; accepted for forward compatibility
 * @returns {string[]}
 */
export function parseMediaPaths(text, options = {}) {
  void options
  try {
    if (typeof text !== 'string' || text.length === 0) return []
    const matcher = new RegExp(MEDIA_PATH_SOURCE, 'gi')
    const candidates = []
    const seen = new Set()
    for (const match of text.matchAll(matcher)) {
      const candidate = match[1]
      if (typeof candidate !== 'string') continue
      if (candidate.length === 0 || candidate.length > MAX_CANDIDATE_LENGTH) continue
      if (!hasMediaExtension(candidate)) continue
      // Reject prose that merely *looks* like a path start: "/ 2.0.1 … foo.png"
      // would otherwise be swallowed as one bogus Unix path. A space is only
      // allowed inside a path that is visibly delimited (quote/bracket/annotation).
      const following = text.slice(match.index + match[0].length, match.index + match[0].length + 1)
      if (!allowsWhitespaceInPath(candidate, following)) continue
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(candidate)
    }
    return candidates
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// path validation
// ---------------------------------------------------------------------------

/**
 * Strip one layer of wrapping quotes/brackets (repeated twice) from a caller
 * supplied candidate, e.g. `"[图片:C:\a.png]"`-style noise around a raw path.
 * @param {any} value
 * @returns {string}
 */
function unwrapCandidate(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  for (let pass = 0; pass < 2; pass += 1) {
    let stripped = false
    for (const [open, close] of WRAPPER_PAIRS) {
      if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, text.length - close.length).trim()
        stripped = true
        break
      }
    }
    if (!stripped) break
  }
  return text
}

/** Whether a string is an absolute path on either Windows or POSIX rules. */
function isAbsoluteMediaPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value)
}

/** Pick the injected `node:path` flavour (tests) or the host one. */
function resolvePathImpl(value) {
  if (value !== null && typeof value === 'object') {
    const required = ['join', 'resolve', 'relative', 'isAbsolute', 'extname']
    if (required.every((name) => typeof value[name] === 'function') && typeof value.sep === 'string') return value
  }
  return path
}

/** Pick the injected platform name (tests) or the host one. */
function resolvePlatform(value) {
  return typeof value === 'string' && value.length > 0 ? value : process.platform
}

/**
 * Resolve one path for containment comparison.
 *
 * Windows paths compare case-insensitively (NTFS) and with `\`/`/` treated
 * alike — `path.resolve` already normalises the separators. POSIX paths keep
 * their exact case: Linux is case-sensitive, and on macOS the case-insensitive
 * APFS is handled by comparing the *real* paths (`realpathSync` returns the
 * on-disk spelling), so folding case there would only weaken the escape check
 * for a case-sensitive volume.
 * @param {string} value
 * @param {string} platform
 * @param {object} pathImpl
 * @returns {string}
 */
function comparablePath(value, platform, pathImpl) {
  const resolved = pathImpl.resolve(value)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Whether `child` is `parent` or lives underneath it, comparing resolved real
 * paths. `path.relative` rejects `..` escapes and cross-drive paths (which come
 * back absolute); `..foo`-style sibling names stay valid children.
 *
 * `platform` and `pathImpl` are injectable so the Windows and POSIX rules can be
 * unit-tested on any host OS; production callers always use the host values.
 * @param {string} parent
 * @param {string} child
 * @param {{ platform?: string, pathImpl?: object }} [options]
 * @returns {boolean}
 */
function isPathInside(parent, child, options = {}) {
  const platform = resolvePlatform(options.platform)
  const pathImpl = resolvePathImpl(options.pathImpl)
  try {
    const relative = pathImpl.relative(comparablePath(parent, platform, pathImpl), comparablePath(child, platform, pathImpl))
    if (relative === '') return true
    if (relative === '..' || relative.startsWith(`..${pathImpl.sep}`)) return false
    if (pathImpl.isAbsolute(relative)) return false
    return true
  } catch {
    return false
  }
}

/** Pick the injectable filesystem (tests) or the real `node:fs`. */
function resolveFsImpl(fsImpl) {
  if (fsImpl !== null && typeof fsImpl === 'object' && typeof fsImpl.realpathSync === 'function' && typeof fsImpl.statSync === 'function') {
    return fsImpl
  }
  return fs
}

/** A rejected validation result. */
function rejected(reason, extra) {
  return { ok: false, reason, ...(extra === undefined ? {} : extra) }
}

/**
 * Validate one candidate media path before it is copied anywhere.
 *
 * The checks, in order: candidate is an absolute path with a whitelisted image
 * extension; `mediaRoots` is non-empty (`no-media-roots` when it is not); the
 * path resolves through `realpath` (so symlinks are followed); it is an
 * existing **regular file** no larger than `maxBytes`; and the resolved real path
 * still lives inside one of the resolved `mediaRoots` (a `..` escape, a symlink
 * pointing outside, or a different drive is rejected with
 * `outside-media-roots`).
 *
 * Never throws: every failure returns `{ ok: false, reason }` with one of
 * `invalid-candidate` / `no-media-roots` / `extension-not-allowed` /
 * `not-found` / `realpath-failed` / `not-a-file` / `too-large` /
 * `outside-media-roots` / `internal-error`.
 *
 * @param {any} candidate path to check
 * @param {{ mediaRoots?: string[], maxBytes?: number, fsImpl?: object, platform?: string, pathImpl?: object }} [options]
 *   Test/portability hooks, all optional: `fsImpl` may supply `realpathSync` +
 *   `statSync`; `platform` (`"win32"`/`"linux"`/`"darwin"`) and `pathImpl`
 *   (`node:path`, `path.posix`, `path.win32`) select the path rules to apply.
 *   Production callers omit them, so the host OS rules are used.
 * @returns {{ ok: boolean, realPath?: string, ext?: string, bytes?: number, reason?: string }}
 */
export function validateMediaPath(candidate, options = {}) {
  try {
    const settings = options !== null && typeof options === 'object' ? options : {}
    const fsImpl = resolveFsImpl(settings.fsImpl)
    const pathImpl = resolvePathImpl(settings.pathImpl)
    const platform = resolvePlatform(settings.platform)
    const maxBytes = normalizeMaxBytes(settings.maxBytes)
    const value = unwrapCandidate(candidate)
    if (value.length === 0 || !isAbsoluteMediaPath(value)) return rejected('invalid-candidate')
    const roots = normalizeMediaRoots(settings.mediaRoots)
    if (roots.length === 0) return rejected('no-media-roots')
    const extension = pathImpl.extname(value).toLowerCase()
    if (!MEDIA_EXTENSIONS.includes(extension)) return rejected('extension-not-allowed', { ext: extension })

    let realPath
    try {
      realPath = fsImpl.realpathSync(value)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : ''
      return code === 'ENOENT' || code === 'ENOTDIR' ? rejected('not-found') : rejected('realpath-failed')
    }
    if (typeof realPath !== 'string' || realPath.length === 0 || !pathImpl.isAbsolute(realPath)) return rejected('realpath-failed')

    let stat
    try {
      stat = fsImpl.statSync(realPath)
    } catch {
      return rejected('not-found')
    }
    if (stat === null || typeof stat !== 'object' || typeof stat.isFile !== 'function' || stat.isFile() !== true) {
      return rejected('not-a-file')
    }
    const bytes = nonNegativeInteger(stat.size)
    if (bytes > maxBytes) return rejected('too-large', { bytes })

    for (const root of roots) {
      let realRoot
      try {
        realRoot = fsImpl.realpathSync(root)
      } catch {
        continue // a missing/unreadable root cannot contain anything
      }
      if (typeof realRoot !== 'string' || realRoot.length === 0) continue
      if (isPathInside(realRoot, realPath, { platform, pathImpl })) return { ok: true, realPath, ext: extension, bytes }
    }
    return rejected('outside-media-roots')
  } catch {
    return rejected('internal-error')
  }
}

// ---------------------------------------------------------------------------
// staging directory helpers
// ---------------------------------------------------------------------------

/**
 * Classify what currently exists at `target` without following a final symlink.
 * @param {string} target
 * @returns {'missing'|'dir'|'file'|'symlink'|'other'|'unknown'}
 */
function inspectPath(target) {
  try {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isDirectory()) return 'dir'
    if (stat.isFile()) return 'file'
    return 'other'
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'ENOENT' ? 'missing' : 'unknown'
  }
}

/**
 * Reduce an arbitrary message id to one safe path segment: only
 * `[A-Za-z0-9._-]` survives, runs of anything else become `_`, leading/trailing
 * dots are dropped, the result is capped at 120 chars, Windows device names are
 * prefixed with `_`, and an empty result becomes `msg`. Never `.`/`..`.
 * @param {any} value
 * @returns {string}
 */
function safeMessageId(value) {
  const raw = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
  let safe = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/\.+$/, '')
    .slice(0, MAX_SAFE_MESSAGE_ID_LENGTH)
  if (safe.length === 0) return 'msg'
  if (WINDOWS_RESERVED_NAME_RE.test(safe.split('.')[0])) safe = `_${safe}`.slice(0, MAX_SAFE_MESSAGE_ID_LENGTH)
  return safe
}

/** Original message id as stored in `index.json` (display/audit only). */
function originalMessageId(value) {
  if (typeof value === 'string') return value.slice(0, 500)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Resolve `<memoryDir>/.staging` for read-only operations. A symlink or a
 * non-directory in that place is treated as "nothing staged" so reads never
 * follow an attacker-controlled link.
 * @param {any} memoryDir
 * @returns {string|null}
 */
function readStagingRoot(memoryDir) {
  const directory = typeof memoryDir === 'string' ? memoryDir.trim() : ''
  if (directory.length === 0) return null
  const stagingRoot = path.join(path.resolve(directory), STAGING_FOLDER_NAME)
  const state = inspectPath(stagingRoot)
  if (state !== 'dir') return null
  return stagingRoot
}

/**
 * Create/replace `<memoryDir>/.staging/<safeMessageId>/` for writing.
 *
 * Security: a symlinked `.staging` root is refused outright; the per-message
 * directory is removed with `rmSync` (which unlinks symlinks instead of
 * following them) and recreated; finally both directories are `realpath`-ed and
 * required to stay inside the real memory directory.
 * @param {string} memoryDir
 * @param {any} messageId
 * @returns {{ ok: true, dir: string } | { ok: false, reason: string }}
 */
function prepareStagingDir(memoryDir, messageId) {
  try {
    const absoluteMemoryDir = path.resolve(memoryDir)
    const stagingRoot = path.join(absoluteMemoryDir, STAGING_FOLDER_NAME)
    const rootState = inspectPath(stagingRoot)
    if (rootState === 'symlink') return { ok: false, reason: 'staging-root-symlink' }
    if (rootState === 'file' || rootState === 'other') return { ok: false, reason: 'staging-root-not-directory' }
    if (rootState === 'unknown') return { ok: false, reason: 'staging-root-unreadable' }
    try {
      fs.mkdirSync(stagingRoot, { recursive: true })
    } catch {
      return { ok: false, reason: 'staging-root-create-failed' }
    }
    let realRoot
    let realMemoryDir
    try {
      realRoot = fs.realpathSync(stagingRoot)
      realMemoryDir = fs.realpathSync(absoluteMemoryDir)
    } catch {
      return { ok: false, reason: 'staging-root-unresolvable' }
    }
    if (!isPathInside(realMemoryDir, realRoot)) return { ok: false, reason: 'staging-root-outside-memory' }

    const stagingDir = path.join(stagingRoot, safeMessageId(messageId))
    if (inspectPath(stagingDir) !== 'missing') {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true })
      } catch {
        return { ok: false, reason: 'staging-dir-rebuild-failed' }
      }
    }
    try {
      fs.mkdirSync(stagingDir, { recursive: true })
    } catch {
      return { ok: false, reason: 'staging-dir-create-failed' }
    }
    let dirStat
    try {
      dirStat = fs.lstatSync(stagingDir)
    } catch {
      return { ok: false, reason: 'staging-dir-unreadable' }
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { ok: false, reason: 'staging-dir-unsafe' }
    let realStagingDir
    try {
      realStagingDir = fs.realpathSync(stagingDir)
    } catch {
      return { ok: false, reason: 'staging-dir-unresolvable' }
    }
    if (!isPathInside(realRoot, realStagingDir)) return { ok: false, reason: 'staging-dir-outside-root' }
    return { ok: true, dir: stagingDir }
  } catch {
    return { ok: false, reason: 'staging-prepare-failed' }
  }
}

/**
 * Atomically write one staging `index.json` (temp file + rename in the same
 * directory). Throws on failure; callers catch.
 * @param {string} directory
 * @param {{ version: number, messageId: string, createdAt: number, files: object[] }} payload
 */
function writeStagingIndex(directory, payload) {
  const file = path.join(directory, STAGING_INDEX_FILE)
  const temp = path.join(
    directory,
    `.${STAGING_INDEX_FILE}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    fs.writeFileSync(temp, JSON.stringify(payload), 'utf8')
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.unlinkSync(temp)
    } catch {
      /* best effort: the temp file may not exist */
    }
    throw error
  }
}

/** Read and defensively normalize one staging `index.json`; null when unusable. */
function readStagingIndex(directory) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, STAGING_INDEX_FILE), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const createdAt = Number(parsed.createdAt)
    return {
      version: Number.isFinite(Number(parsed.version)) ? Number(parsed.version) : STAGING_INDEX_VERSION,
      messageId: typeof parsed.messageId === 'string' ? parsed.messageId : '',
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
      files: Array.isArray(parsed.files) ? parsed.files : [],
    }
  } catch {
    return null
  }
}

/**
 * Normalize one staged file entry (`{ name, mediaType?, bytes? }`) against the
 * real filesystem: the name must be `<ordinal>.<whitelisted ext>` and the file
 * must still exist as a regular file. Returns `{ name, path, mediaType, bytes }`
 * or `null`.
 * @param {any} item
 * @param {string} directory
 * @returns {{ name: string, path: string, mediaType: string, bytes: number } | null}
 */
function normalizeStagedEntry(item, directory) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  const match = STAGED_NAME_RE.exec(name)
  if (match === null) return null
  const filePath = path.join(directory, name)
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return null
  }
  if (stat === null || typeof stat !== 'object' || typeof stat.isFile !== 'function' || stat.isFile() !== true) return null
  const extension = `.${match[2].toLowerCase()}`
  const bytes = Number.isFinite(Number(item.bytes)) && Number(item.bytes) >= 0 ? Math.trunc(Number(item.bytes)) : stat.size
  // `source` is the original path found in the message text: the archive step
  // needs it to replace exactly that substring with an image placeholder.
  const source = typeof item.source === 'string' ? item.source : ''
  return { name, path: filePath, mediaType: normalizeMediaType(item.mediaType, extension), bytes, source }
}

/** Numeric ordinal of one staged file name; 0 when it does not match. */
function stagedOrdinal(name) {
  const match = STAGED_NAME_RE.exec(typeof name === 'string' ? name : '')
  return match === null ? 0 : Number(match[1])
}

/**
 * Read one staging directory: the index is authoritative, but when it is
 * missing/corrupt the directory itself is scanned for `<ordinal>.<ext>` files
 * (covers a crash between copying and writing the index). Only existing regular
 * files are returned, sorted by ordinal.
 * @param {string} directory
 * @returns {Array<{ name: string, path: string, mediaType: string, bytes: number }>}
 */
function readStagingEntries(directory) {
  const byName = new Map()
  const index = readStagingIndex(directory)
  if (index !== null) {
    for (const item of index.files) {
      const entry = normalizeStagedEntry(item, directory)
      if (entry !== null && !byName.has(entry.name)) byName.set(entry.name, entry)
    }
  }
  if (byName.size === 0) {
    try {
      for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!dirent.isFile()) continue
        const entry = normalizeStagedEntry({ name: dirent.name }, directory)
        if (entry !== null) byName.set(entry.name, entry)
      }
    } catch {
      /* unreadable staging directory reads as empty */
    }
  }
  return [...byName.values()].sort((a, b) => stagedOrdinal(a.name) - stagedOrdinal(b.name))
}

// ---------------------------------------------------------------------------
// public staging API
// ---------------------------------------------------------------------------

/**
 * Stage the local image files referenced by one message's text.
 *
 * Parses the text (`parseMediaPaths`), validates every candidate
 * (`validateMediaPath` with `mediaRoots`/`maxBytes`) and copies the accepted
 * files to `<memoryDir>/.staging/<safeMessageId>/<ordinal>.<ext>`, then writes
 * `index.json`:
 *
 *     { version: 1, messageId, createdAt, files: [{ name, path, mediaType, bytes }] }
 *
 * A pre-existing staging directory for the same message id is deleted and
 * rebuilt, so repeated calls never mix old and new media. Rejected candidates
 * are counted in `skipped` and described in `reasons` (each entry is
 * `"<reason>: <candidate>"`; setup failures contribute a single reason code).
 *
 * Never throws. When `memoryDir`/`text` is unusable or nothing validates, the
 * result is `{ staged: [], skipped, reasons }` and no directory is created.
 *
 * @param {{
 *   memoryDir?: string,
 *   messageId?: string,
 *   text?: string,
 *   mediaRoots?: string[],
 *   maxBytes?: number,
 *   logger?: Function | { warn?: Function, debug?: Function, info?: Function, log?: Function },
 * }} [options]
 * @returns {{ staged: Array<{ name: string, path: string, mediaType: string, bytes: number }>, skipped: number, reasons: string[] }}
 */
export function stageMessageMedia(options = {}) {
  const result = { staged: [], skipped: 0, reasons: [] }
  try {
    const settings = options !== null && typeof options === 'object' ? options : {}
    const memoryDir = typeof settings.memoryDir === 'string' ? settings.memoryDir.trim() : ''
    if (memoryDir.length === 0) {
      result.reasons.push('invalid-memory-dir')
      return result
    }
    const log = resolveLogger(settings.logger)
    const candidates = parseMediaPaths(settings.text)
    if (candidates.length === 0) return result
    const mediaRoots = normalizeMediaRoots(settings.mediaRoots)
    const maxBytes = normalizeMaxBytes(settings.maxBytes)

    const accepted = []
    for (const candidate of candidates) {
      const validation = validateMediaPath(candidate, { mediaRoots, maxBytes })
      if (validation.ok !== true) {
        result.skipped += 1
        result.reasons.push(`${validation.reason ?? 'rejected'}: ${candidate}`)
        log('debug', `qq-media: skipped ${candidate} (${validation.reason ?? 'rejected'})`)
        continue
      }
      accepted.push({ candidate, validation })
    }
    if (accepted.length === 0) return result

    const prepared = prepareStagingDir(memoryDir, settings.messageId)
    if (prepared.ok !== true) {
      result.skipped += accepted.length
      result.reasons.push(prepared.reason)
      log('warn', `qq-media: staging unavailable (${prepared.reason})`)
      return result
    }

    let sequence = 0
    for (const item of accepted) {
      const name = `${sequence + 1}${item.validation.ext}`
      const targetPath = path.join(prepared.dir, name)
      try {
        fs.copyFileSync(item.validation.realPath, targetPath)
      } catch (error) {
        result.skipped += 1
        result.reasons.push(`copy-failed: ${item.candidate}`)
        log('warn', `qq-media: copy failed for ${item.candidate} (${error?.code ?? 'error'})`)
        continue
      }
      sequence += 1
      let bytes = Number(item.validation.bytes) || 0
      try {
        const copied = fs.statSync(targetPath)
        if (copied !== null && typeof copied === 'object' && Number.isFinite(copied.size)) bytes = copied.size
      } catch {
        /* keep the validated size when stat fails */
      }
      result.staged.push({ name, path: targetPath, mediaType: mediaTypeForExtension(item.validation.ext), bytes, source: item.candidate })
    }

    try {
      writeStagingIndex(prepared.dir, {
        version: STAGING_INDEX_VERSION,
        messageId: originalMessageId(settings.messageId),
        createdAt: Date.now(),
        files: result.staged,
      })
    } catch (error) {
      result.reasons.push('index-write-failed')
      log('warn', `qq-media: staging index write failed (${error?.code ?? 'error'})`)
    }
    return result
  } catch {
    result.reasons.push('internal-error')
    return result
  }
}

/**
 * Read the staged media of several message ids without consuming them.
 *
 * The returned map only contains ids that currently have at least one readable
 * staged file; keys are the message ids exactly as passed in (use the same
 * values for `takeStagedMedia`). Entries are `{ name, path, mediaType, bytes }`
 * with `path` inside `<memoryDir>/.staging/<safeMessageId>/`.
 *
 * Never throws: a missing/invalid memory dir, a symlinked staging root or a
 * single unreadable entry degrades to an empty map / fewer entries.
 * @param {any} memoryDir
 * @param {any} messageIds array of message ids (a single id is accepted too)
 * @returns {Map<any, Array<{ name: string, path: string, mediaType: string, bytes: number }>>}
 */
export function listStagedMedia(memoryDir, messageIds) {
  const stagedByMessage = new Map()
  try {
    const stagingRoot = readStagingRoot(memoryDir)
    if (stagingRoot === null) return stagedByMessage
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds]
    for (const id of ids) {
      if (typeof id !== 'string' && typeof id !== 'number') continue
      const entries = readStagingEntries(path.join(stagingRoot, safeMessageId(id)))
      if (entries.length === 0) continue
      stagedByMessage.set(id, entries)
    }
    return stagedByMessage
  } catch {
    return stagedByMessage
  }
}

/**
 * Claim the staged media of one message id: read it, then delete the staging
 * directory. The returned entries are `{ name, path, mediaType, bytes }` plus a
 * `data` Buffer copy of the file (when it is readable and not larger than the
 * 32 MiB hard read cap), because `path` stops existing right after this call —
 * callers should persist `data` (e.g. via `images.js` `saveImageFile`) rather
 * than re-open `path`. Index order (`1.png`, `2.jpg`, …) is preserved.
 *
 * Never throws: an unknown/invalid message id, an unsafe staging root or
 * unreadable files return `[]` / fewer entries; the directory is removed even
 * when it holds no valid entries.
 * @param {any} memoryDir
 * @param {any} messageId
 * @returns {Array<{ name: string, path: string, mediaType: string, bytes: number, data?: Buffer }>}
 */
export function takeStagedMedia(memoryDir, messageId) {
  const taken = []
  try {
    const stagingRoot = readStagingRoot(memoryDir)
    if (stagingRoot === null) return taken
    if (typeof messageId !== 'string' && typeof messageId !== 'number') return taken
    const directory = path.join(stagingRoot, safeMessageId(messageId))
    for (const entry of readStagingEntries(directory)) {
      const claimed = { name: entry.name, path: entry.path, mediaType: entry.mediaType, bytes: entry.bytes }
      try {
        const stat = fs.statSync(entry.path)
        if (stat.size <= MAX_STAGED_READ_BYTES) {
          const data = fs.readFileSync(entry.path)
          claimed.data = data
          claimed.bytes = data.byteLength
        }
      } catch {
        /* metadata-only entry: caller can still see it was staged */
      }
      taken.push(claimed)
    }
    try {
      fs.rmSync(directory, { recursive: true, force: true })
    } catch {
      /* best effort: cleanupStaging() retires it later */
    }
    return taken
  } catch {
    return taken
  }
}

/**
 * Delete staging directories older than `ttlMs` (default one day).
 *
 * Age comes from `index.json` `createdAt`; when that is missing/unreadable the
 * directory's own mtime is used (covers a crash before the index was written).
 * Entries only one TTL old exactly at the boundary are kept (`now - createdAt >
 * ttlMs`). A symlinked/unreadable staging root is left untouched.
 *
 * Never throws: an invalid memory dir or any filesystem error returns `0`.
 * @param {{ memoryDir?: string, ttlMs?: number, now?: number }} [options]
 * @returns {number} number of staging entries removed
 */
export function cleanupStaging(options = {}) {
  try {
    const settings = options !== null && typeof options === 'object' ? options : {}
    const stagingRoot = readStagingRoot(settings.memoryDir)
    if (stagingRoot === null) return 0
    const ttlMs = normalizeTtl(settings.ttlMs)
    const now = Number.isFinite(Number(settings.now)) ? Number(settings.now) : Date.now()
    let dirents
    try {
      dirents = fs.readdirSync(stagingRoot, { withFileTypes: true })
    } catch {
      return 0
    }
    let removed = 0
    for (const dirent of dirents) {
      const target = path.join(stagingRoot, dirent.name)
      let createdAt = 0
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        const index = readStagingIndex(target)
        if (index !== null && index.createdAt > 0) createdAt = index.createdAt
      }
      if (createdAt === 0) {
        try {
          const stat = fs.lstatSync(target)
          createdAt = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0
        } catch {
          continue // already gone / unreadable: nothing to count
        }
      }
      if (now - createdAt > ttlMs) {
        try {
          fs.rmSync(target, { recursive: true, force: true })
          removed += 1
        } catch {
          /* best effort: a locked entry is retried on the next pass */
        }
      }
    }
    return removed
  } catch {
    return 0
  }
}
