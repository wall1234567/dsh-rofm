/**
 * dsh-rofm — "is this module the script Node was asked to run?" helper.
 *
 * The hand-rolled pattern this replaces was
 *
 *   import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
 *
 * which is wrong on real paths:
 *   - `#` (and `?` / `%`) in a path is parsed as URL fragment/query/escape
 *     syntax, so the comparison never matches (e.g. a checkout under
 *     `<tmp>/run #1/dsh-rofm/tools/repair-session-log.mjs`);
 *   - a hand-built URL string is not the loader's normalized URL;
 *   - a symlinked invocation resolves to two different paths for the same
 *     file, so `main()` silently never runs: macOS `/tmp` is
 *     `/private/tmp`, and the DSH profile's `node_modules/dsh-rofm` is a
 *     symlink to the real checkout.
 *
 * `isMainModule()` is the pure comparison (no filesystem access, injectable
 * platform) and `canonicalScriptPath()` resolves the entry symlinks so both
 * sides describe the same file. Callers also use `invokedAsMain()`, which wires
 * both to `process.argv[1]`.
 *
 * The file is ESM-only and zero-dependency, like every other `tools/*` script.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Platforms whose default filesystem compares paths case-insensitively
 * (Windows NTFS, macOS APFS/HFS+). Both sides are resolved with `realpath`
 * before comparison, and case folding only makes the comparison tolerant of a
 * differently-cased invocation spelling.
 */
const CASE_INSENSITIVE_PLATFORMS = new Set(['win32', 'darwin'])

/**
 * Whether `moduleUrl` (typically `import.meta.url`) names the script at
 * `entryPath` (typically `process.argv[1]`).
 *
 * Pure: no filesystem access and no global state; `platform` is injectable so
 * the case-folding rules can be tested on any OS. The caller is responsible for
 * resolving symlinks on `entryPath` (see {@link canonicalScriptPath}).
 *
 * @param {string} moduleUrl `file:` URL of the loaded module (`import.meta.url`).
 * @param {string} entryPath native path the runtime was asked to execute.
 * @param {string} [platform] defaults to `process.platform`.
 * @returns {boolean}
 */
export function isMainModule(moduleUrl, entryPath, platform = process.platform) {
  if (typeof moduleUrl !== 'string' || moduleUrl.length === 0) return false
  if (typeof entryPath !== 'string' || entryPath.length === 0) return false
  let moduleFile
  try {
    // Percent-decodes the URL again (spaces, CJK, `#` -> `%23`, ...), which is
    // what makes `#`-containing paths work at all.
    moduleFile = fileURLToPath(moduleUrl)
  } catch {
    return false
  }
  const normalize = (value) => {
    let resolved
    try {
      resolved = path.resolve(value)
    } catch {
      return ''
    }
    return CASE_INSENSITIVE_PLATFORMS.has(platform) ? resolved.toLowerCase() : resolved
  }
  const modulePath = normalize(moduleFile)
  return modulePath.length > 0 && modulePath === normalize(entryPath)
}

/**
 * Absolute path of a script with symlinks resolved (best effort: when the path
 * cannot be resolved — e.g. it no longer exists — the plain absolute path is
 * returned). Node's ESM loader loads the real path, so `import.meta.url` must
 * be compared with the canonical entry path.
 *
 * @param {string} scriptPath
 * @returns {string}
 */
export function canonicalScriptPath(scriptPath) {
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) return ''
  const absolute = path.resolve(scriptPath)
  try {
    return fs.realpathSync(absolute)
  } catch {
    return absolute
  }
}

/**
 * True when the module at `moduleUrl` is the process entry script.
 *
 * @param {string} moduleUrl `import.meta.url`.
 * @param {string[]} [argv] defaults to `process.argv`.
 * @param {string} [platform] defaults to `process.platform`.
 * @returns {boolean}
 */
export function invokedAsMain(moduleUrl, argv = process.argv, platform = process.platform) {
  const entry = Array.isArray(argv) ? argv[1] : undefined
  if (typeof entry !== 'string' || entry.length === 0) return false
  return isMainModule(moduleUrl, canonicalScriptPath(entry), platform)
}
