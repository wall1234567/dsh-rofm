/**
 * Plugin configuration: built-in adapter defaults, the plugin's config.json,
 * and an optional profile-level patch config, merged the same way for every
 * cache generation. `config.json` is re-read automatically when its content
 * changes, so tuning needs no restart.
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { mergeConfigFile } from '../engine/index.js'

/**
 * Adapter-only defaults. Everything under `compress`, `importance`, `keywords`,
 * `recall` (probability fields), `storage`, `logging` and `test` is completed by
 * the engine defaults; these keys are the adapter's own knobs.
 */
export const ADAPTER_DEFAULTS = Object.freeze({
  enabled: true,
  compress: Object.freeze({
    applyToSubagents: false,
    applyToMainSessions: true,
    /** Compress before every model step (catches mid-turn tool-output growth). */
    preStepEnabled: true,
    /** When still above this percent after the normal pass, run extra passes. */
    emergencyPercent: 85,
    /** Share removed by each extra (emergency) pass. */
    emergencyCompressPercent: 40,
    /** Maximum extra passes per pressure episode (normal pass excluded). */
    maxExtraPasses: 2,
    /** Above this percent, log a warning if nothing removable is left. */
    hardLimitPercent: 95,
  }),
  recall: Object.freeze({
    applyToSubagents: false,
    applyToMainSessions: true,
    maxRecalledBlocks: 64,
    maxRecalledChars: 120000,
    /** Message source kinds that count as "the user is speaking". */
    triggerSourceKinds: Object.freeze(['user']),
    /** Persist recalled block ids so a host restart re-injects them without a new message. */
    persistInjected: true,
  }),
  /** Per-session private memory folder; recall never crosses sessions. */
  storage: Object.freeze({ perSession: true }),
  logging: Object.freeze({ enabled: true, verbose: false }),
  test: Object.freeze({ dryRun: false }),
})

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Assign an own data property. A plain `target[key] = value` for a JSON key
 * named `__proto__` would invoke Object.prototype's setter and replace the
 * object prototype instead of storing the key; config.json and profile patch
 * configs are parsed JSON, so they can contain that key as an own property.
 */
function setOwnProperty(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
  } else {
    target[key] = value
  }
}

/** Deep-merge plain objects; arrays and scalars are replaced, not concatenated. */
export function deepMerge(base, override) {
  if (!isPlainObject(base)) return clone(override)
  if (!isPlainObject(override)) return override === undefined ? clone(base) : clone(override)
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    setOwnProperty(out, key, isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : clone(value))
  }
  return out
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) setOwnProperty(out, key, clone(item))
    return out
  }
  return value
}

/**
 * Live configuration holder. `get()` is cheap: one small file read; the
 * expensive rebuild only runs when the file content changed.
 */
export class ConfigStore {
  /**
   * @param {string} pluginDir absolute plugin root directory
   * @param {Record<string, unknown>} rowConfig optional config from the DSH patch row
   */
  constructor(pluginDir, rowConfig) {
    this.pluginDir = pluginDir
    this.rowConfig = isPlainObject(rowConfig) ? rowConfig : {}
    this.configPath = resolve(pluginDir, 'config.json')
    this.current = undefined
    this.version = 0
    this.mtime = -1
    this.size = -1
    /** Last raw config.json text seen (null = file missing/unreadable). */
    this.raw = null
    /** Whether `raw` came from a readable file. */
    this.readOk = false
    /** Last observed load failure, kept for diagnostics; cleared on success. */
    this.lastError = undefined
  }

  /** Read the current configuration, hot-reloading config.json when it changed. */
  get() {
    this.refresh()
    return this.current
  }

  /** Force a reload regardless of the file content. */
  reload() {
    return this.refresh(true)
  }

  /**
   * Rebuild the config when the file content changed.
   *
   * `mtime` + `size` alone is not a reliable change signal: two writes within one
   * filesystem clock tick can share `mtimeMs` (and a same-size edit changes
   * nothing else), so the tiny config file is compared by content. This mirrors
   * the engine's index cache (mtime+size) but is hardened for same-tick saves.
   */
  refresh(force = false) {
    let raw = null
    let readable = false
    let mtime = 0
    let size = -1
    try {
      raw = readFileSync(this.configPath, 'utf8')
      readable = true
      try {
        const stat = statSync(this.configPath)
        mtime = stat.mtimeMs
        size = stat.size
      } catch {
        // Content was read successfully; the stats are diagnostics only.
      }
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT' && this.current !== undefined) {
        // Unreadable (EPERM/EBUSY/EISDIR/…): keep the last good config instead
        // of silently resetting every knob and moving memoryDir to the default.
        this.lastError = error
        return this.current
      }
      // Missing (ENOENT) or first read: the file is optional, use defaults.
      raw = null
      readable = false
    }
    // Content compare also covers same-tick / same-size rewrites that a
    // (mtime, size) cache would miss. A `touch` (content unchanged) therefore
    // does not bump `version`, so callers do not rebuild engines for a no-op save.
    if (!force && this.current !== undefined && readable === this.readOk && raw === this.raw) {
      return this.current
    }
    this.raw = raw
    this.readOk = readable
    this.mtime = mtime
    this.size = size
    let parsed
    let parseError
    if (readable) {
      try {
        parsed = JSON.parse(raw)
        if (!isPlainObject(parsed)) throw new Error('config.json 顶层不是 JSON 对象')
      } catch (error) {
        parseError = error
      }
    }
    if (parseError !== undefined) {
      // Keep the last good config instead of silently switching every knob to
      // the built-in defaults (e.g. a transient truncated write while saving).
      if (this.current !== undefined) {
        this.lastError = parseError
        return this.current
      }
      // First load of a broken file: fall back to defaults but surface it (the
      // plugin logs cfg.warnings on activation), instead of staying silent.
    }
    try {
      const engineConfig = mergeConfigFile(parsed ?? {}, this.rowConfig)
      this.current = deepMerge(ADAPTER_DEFAULTS, engineConfig)
      this.current.storage = { ...this.current.storage }
      this.current.memoryDir = isAbsolute(this.current.storage.dir)
        ? this.current.storage.dir
        : resolve(this.pluginDir, this.current.storage.dir)
      if (parseError !== undefined) {
        this.current.warnings = [
          `config.json 解析失败，已使用默认配置：${parseError instanceof Error ? parseError.message : String(parseError)}`,
          ...(this.current.warnings ?? []),
        ]
      }
      this.lastError = parseError
    } catch (error) {
      // A broken config must never take the plugin down: fall back to defaults
      // from the engine, which still validates field by field.
      this.current = deepMerge(ADAPTER_DEFAULTS, mergeConfigFile(undefined, this.rowConfig))
      this.current.storage = { ...this.current.storage }
      this.current.memoryDir = resolve(this.pluginDir, this.current.storage.dir)
      this.current.warnings = [
        ...(this.current.warnings ?? []),
        `config.json 读取失败，已使用默认配置：${error instanceof Error ? error.message : String(error)}`,
      ]
      this.lastError = error
    }
    this.version += 1
    return this.current
  }
}
