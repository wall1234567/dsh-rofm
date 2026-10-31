/**
 * dsh-rofm — cross-platform path helpers for the DSH adapter.
 *
 * The plugin targets Windows, Linux and macOS alike. All paths are composed with
 * `node:path` (never string concatenation, never a hardcoded `\` or `/`), and the
 * only shell convention this module interprets is a leading `~` in a user-edited
 * config value — a convenience that keeps one `config.json` portable across
 * machines, e.g.:
 *
 *   "storage": { "dir": "~/rofm-memory" }
 *   "compat":  { "mediaRoots": ["~/Pictures/QQ"] }
 *
 * Only a *bare* `~` or `~/…` / `~\…` is expanded; `~user` (a shell-user feature)
 * is deliberately left untouched so a path that merely starts with a tilde can
 * never be silently rewritten. Windows drive paths (`C:\…`) and POSIX absolute
 * paths (`/…`) are returned unchanged.
 *
 * Like `lib/images.js` and `lib/qq-media.js` this is a leaf module: node builtins
 * only, no DSH/Cordis imports, no side effects, never throws.
 */

import os from 'node:os'
import path from 'node:path'

/**
 * The home directory used for `~` expansion.
 *
 * `os.homedir()` is correct on every supported OS; an explicit override exists
 * for tests (and for callers that already resolved the DSH home themselves).
 * @param {{ homeDir?: string }} options
 * @returns {string}
 */
function homeDirOf(options) {
  const explicit = options !== null && typeof options === 'object' && typeof options.homeDir === 'string' ? options.homeDir : ''
  if (explicit.length > 0) return explicit
  try {
    return os.homedir()
  } catch {
    return ''
  }
}

/** Pick the injected `node:path` flavour (tests) or the host one. */
function pathImplOf(options) {
  const candidate = options !== null && typeof options === 'object' ? options.pathImpl : undefined
  if (candidate !== null && typeof candidate === 'object' && typeof candidate.join === 'function' && typeof candidate.sep === 'string') {
    return candidate
  }
  return path
}

/**
 * Expand one leading `~` segment to the user's home directory.
 *
 * Both separators are accepted after the tilde on every OS, so a config written
 * on Windows (`~\Pictures`) still resolves sensibly when the plugin later runs
 * on Linux/macOS, and vice versa. Values that are not plain strings, are empty,
 * start with `~` but not a path separator (`~user`), or contain no tilde are
 * returned verbatim (trimmed only when the caller already did so).
 *
 * @param {unknown} value config value (`storage.dir`, one `mediaRoots` item, …)
 * @param {{ homeDir?: string, pathImpl?: { join: Function, sep: string } }} [options]
 * @returns {unknown} the expanded path, or `value` unchanged
 */
export function expandHomePath(value, options = {}) {
  if (typeof value !== 'string') return value
  if (value.length === 0 || value[0] !== '~') return value
  const homeDir = homeDirOf(options)
  if (homeDir.length === 0) return value
  const rest = value.slice(1)
  if (rest.length === 0) return homeDir
  // `~user` / `~foo/bar` are shell-user expansions, not ours: leave them alone.
  if (rest[0] !== '/' && rest[0] !== '\\') return value
  const segments = rest.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return homeDir
  try {
    return pathImplOf(options).join(homeDir, ...segments)
  } catch {
    return value
  }
}

/**
 * Whether `value` looks like a `~`-rooted path (bare `~`, `~/…` or `~\…`).
 * Callers use this to decide between {@link expandHomePath} and the regular
 * absolute/relative resolution rules without duplicating the parsing.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHomeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value[0] !== '~') return false
  const rest = value.slice(1)
  return rest.length === 0 || rest[0] === '/' || rest[0] === '\\'
}
