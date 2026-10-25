/**
 * dsh-rofm engine — cached engine facade.
 *
 * `MemoryEngine` is the only object the DSH adapter (or the CLI) needs:
 * it keeps the parsed `index.json` in memory and only reloads it when the file
 * mtime changed. The warm `recall()` path therefore does exactly one `statSync`
 * plus (only for hits) one `context.json` read per recalled folder; for 1 000
 * folders that is well under 20 ms on a normal machine.
 *
 * Thread-safety: none needed — the engine is single-process and synchronous
 * (documented contract, docs/SPEC.md §7).
 */

import fs from 'node:fs'
import path from 'node:path'
import {
    defaultConfigPath,
    loadConfig,
    mergeConfig,
    normalizeBeta,
    resolveMemoryDir,
    validateConfig,
} from './config.js'
import { commitCompression, planCompression } from './compress.js'
import { buildRecallBlock, recall as runRecall } from './recall.js'
import {
    appendStats,
    ensureMemoryDir,
    memoryPaths,
    readFolder as readFolderFromStore,
    readStats,
    refreshIndex,
} from './store.js'
import { formatReport, summarizeStats } from './stats.js'

export class MemoryEngine {
  /**
   * @param {{
   *   memoryDir?: string,
   *   config?: object,
   *   configPath?: string,
   *   overrides?: object,
   *   baseDir?: string,
   *   rng?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {}
    this.configPath = opts.configPath
    this._explicitMemoryDir = !!opts.memoryDir
    if (opts.config && typeof opts.config === 'object') {
      this.cfg = Array.isArray(opts.config.warnings) ? opts.config : validateConfig(opts.config)
    } else {
      let configPath = opts.configPath
      if (!configPath) {
        const shared = defaultConfigPath()
        if (fs.existsSync(shared)) configPath = shared
      }
      this.cfg = loadConfig(configPath, opts.overrides)
    }
    this.baseDir = opts.baseDir
    this.memoryDir = opts.memoryDir ? path.resolve(String(opts.memoryDir)) : resolveMemoryDir(this.cfg, opts.baseDir)
    this.rng = typeof opts.rng === 'function' ? opts.rng : undefined
    this._cache = { index: null, mtimeMs: -1, size: -1 }
    this._loaded = false
  }

  /** Synchronously load/rebuild the index and start caching it. */
  load() {
    this._refresh()
    this._loaded = true
    return this
  }

  /** Drop the in-memory index cache and reload it from disk (forced refresh). */
  reload() {
    this._cache = { index: null, mtimeMs: -1, size: -1 }
    this._loaded = false
    return this.load()
  }

  get loaded() {
    return this._loaded
  }

  get config() {
    return this.cfg
  }

  get index() {
    return this._refresh().index
  }

  _refresh() {
    ensureMemoryDir(this.memoryDir)
    const result = refreshIndex(this.memoryDir, this.cfg, this._cache)
    this._cache = { index: result.index, mtimeMs: result.mtimeMs, size: result.size ?? -1 }
    this._loaded = true
    return result
  }

  _statIndexMtime() {
    return this._statIndexState().mtimeMs
  }

  _statIndexState() {
    try {
      const { indexPath } = memoryPaths(this.memoryDir, this.cfg)
      const stat = fs.statSync(indexPath)
      return { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      return { mtimeMs: -1, size: -1 }
    }
  }

  /**
   * Deep-merge `partial` into the config, then reload index/folders.
   * @param {object} partial
   * @returns {object} the new validated config
   */
  setConfig(partial) {
    this.cfg = validateConfig(mergeConfig(this.cfg, partial || {}))
    if (!this._explicitMemoryDir) this.memoryDir = resolveMemoryDir(this.cfg, this.baseDir)
    this._cache = { index: null, mtimeMs: -1, size: -1 }
    this._loaded = false
    this.load()
    return this.cfg
  }

  /** Plan only (nothing written). `opts.cfg` overrides the engine config for
   * one pass (used by the adapter's emergency passes with a larger percentage). */
  planCompression(messages, usedPercent, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {}
    return planCompression({
      messages,
      usedPercent,
      cfg: options.cfg && typeof options.cfg === 'object' ? options.cfg : this.cfg,
      sessionId: options.sessionId,
      now: options.now,
      turn: options.turn,
      totalUsedTokens: options.totalUsedTokens,
      windowTokens: options.windowTokens,
    })
  }

  /**
   * Plan + commit: move the earliest part of the context into memory folders.
   * @param {any[]} messages complete model-visible conversation (MemMessage[])
   * @param {number} usedPercent
   * @param {{ sessionId?: string, now?: number, turn?: number, totalUsedTokens?: number,
   *   windowTokens?: number, source?: object }} [opts]
   */
  compress(messages, usedPercent, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {}
    const plan = this.planCompression(messages, usedPercent, options)
    if (!plan.shouldCompress) {
      return { plan, committed: false, folders: [], removed: [], keep: plan.keep, warnings: plan.warnings, skipped: 0 }
    }
    const committed = commitCompression(plan, {
      memoryDir: this.memoryDir,
      cfg: this.cfg,
      sessionId: options.sessionId,
      turn: options.turn,
      source: options.source,
    })
    this._cache = { index: committed.index, ...this._statIndexState() }
    if (committed.refused === true) {
      // The safety cap refused the whole archive: report it as NOT committed so
      // callers never replace the conversation with a note that covers nothing.
      return { ...committed, plan, committed: false, refused: true }
    }
    return { ...committed, plan, committed: true }
  }

  /**
   * Recall memory folders for the latest user text and append the recall
   * telemetry event (`stats.jsonl`).
   * @param {string} userText
   * @param {{ chars?: number, tokens?: number, windowTokens?: number, sessionId?: string }} [context]
   * @param {{ excludeIds?: Iterable<string> }} [options] folders already in the
   *   injected recall block: never re-added, never counted against
   *   `firstGenMax`, but still usable as keyword bridges for new folders.
   */
  recall(userText, context = {}, options = {}) {
    const ctx = context && typeof context === 'object' ? context : {}
    const opts = options && typeof options === 'object' ? options : {}
    const refreshed = this._refresh()
    const result = runRecall({
      userText,
      cfg: this.cfg,
      index: refreshed.index,
      rng: this.rng,
      context: ctx,
      memoryDir: this.memoryDir,
      excludeIds: opts.excludeIds,
    })
    const stats = result.stats || {}
    appendStats(this.memoryDir, this.cfg, {
      type: 'recall',
      time: Date.now(),
      sessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : null,
      userKeywords: Array.isArray(stats.userKeywords) ? stats.userKeywords : [],
      contextChars: Number.isFinite(stats.contextChars) ? stats.contextChars : null,
      windowTokens: Number.isFinite(stats.windowTokens) ? stats.windowTokens : null,
      matchedFolders: stats.matchedFolders || 0,
      excludedFolders: stats.excludedFolders || 0,
      attempts: stats.attempts || 0,
      addedFolders: stats.addedFolders || 0,
      addedChars: stats.addedChars || 0,
      addedTokens: stats.addedTokens || 0,
      addedPercentOfContext: Number.isFinite(stats.addedPercentOfContext) ? stats.addedPercentOfContext : null,
      addedPercentOfWindow: Number.isFinite(stats.addedPercentOfWindow) ? stats.addedPercentOfWindow : null,
      byGeneration: stats.byGeneration || {},
      latencyMs: stats.elapsedMs || 0,
      added: (result.additions || []).map((addition) => ({
        id: addition.id,
        generation: addition.generation,
        alpha: addition.alpha,
        beta: Number.isFinite(Number(addition.beta)) ? normalizeBeta(addition.beta) : 0,
        probability: addition.probability,
        chars: addition.chars,
        tokens: addition.tokens,
      })),
    })
    return result
  }

  /** Render the recall block (see docs/SPEC.md §6.7). */
  buildRecallBlock(additions) {
    return buildRecallBlock(additions, this.cfg)
  }

  /** Aggregate `stats.jsonl` into the test-phase report numbers (+ `text`). */
  report() {
    const events = readStats(this.memoryDir, this.cfg)
    const summary = summarizeStats(events)
    return { ...summary, text: formatReport(summary), events: events.length, memoryDir: this.memoryDir }
  }

  /** Folder entries from the cached index. */
  list() {
    return this._refresh().index.folders
  }

  /** Read one folder (meta + messages). */
  readFolder(id) {
    return readFolderFromStore(this.memoryDir, id)
  }
}
