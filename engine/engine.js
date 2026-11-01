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
import { buildTimeIndex, normalizeTimeQuery, queryTimeIndex } from './time-index.js'
import {
    appendStats,
    cleanupCommitJournals,
    ensureMemoryDir,
    memoryPaths,
    readFolder as readFolderFromStore,
    readStats,
    refreshIndex,
} from './store.js'
import { formatReport, summarizeStats } from './stats.js'

/** Clamp an optional integer option (offset/limit/round…) without throwing. */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const truncated = Math.trunc(number)
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
}

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
    /** v1.4.0 in-memory time index (never persisted; plan §3.3.1). */
    this._timeIndexCache = undefined
    /** v1.4.0 deterministic recall index (wave-2). */
    this._recallIndexCache = undefined
    /** v1.4.0 in-memory FAIR-DRI lane state when the caller does not pass one. */
    this._lanes = undefined
    this._round = 0
    this._loaded = false
  }

  /** Synchronously load/rebuild the index and start caching it. */
  load() {
    this._refresh()
    this._loaded = true
    // v1.4.0: drop commit journals left behind by a crashed archival run. This
    // never deletes memory folders (in-process rollback owns that); it only
    // clears the stale intent records so they cannot accumulate forever.
    try {
      cleanupCommitJournals(this.memoryDir)
    } catch {
      /* best effort */
    }
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
   * one pass (used by the adapter's emergency passes with a larger percentage).
   *
   * v1.4.0 forwards the robustness options the adapter needs: `protectTurn` /
   * `protectSeq` (never archive the current turn, P0-3), `pendingCount` /
   * `allowSmallWindow` / `maxFolders` (scoring pressure + small-window sanity,
   * P1-6) and `eventTimes` (optional per-message times for eventStart/eventEnd).
   */
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
      // v1.4.0 robustness (all optional, ignored by older compress.js)
      protectTurn: options.protectTurn,
      protectSeq: options.protectSeq,
      pendingCount: options.pendingCount,
      allowSmallWindow: options.allowSmallWindow,
      maxFolders: options.maxFolders,
      eventTimes: options.eventTimes,
      seqStart: options.seqStart,
      seqEnd: options.seqEnd,
      contentHash: options.contentHash,
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
      // v1.4.0 commit transaction: idempotency key + journal options
      seqStart: options.seqStart,
      seqEnd: options.seqEnd,
      contentHash: options.contentHash,
      idempotencyKey: options.idempotencyKey,
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
   *
   * v1.4.0 adds three things on top of the v1.3.0 signature (all optional):
   *   - `mode`: 'fair' | 'deterministic' | 'legacy' (defaults to cfg.recall.mode);
   *   - `timeFrom` / `timeTo` / `granularity`: time-constrained recall (§6.8);
   *   - `offset` / `limit`: deterministic pagination of the matched candidates;
   *   - `lanes` / `round` / `blockIds` / `ledger`: the FAIR-DRI lane state the
   *     adapter persists in `recall-state.json` v3.
   *
   * @param {string} userText
   * @param {{ chars?: number, tokens?: number, windowTokens?: number, sessionId?: string }} [context]
   * @param {{ excludeIds?: Iterable<string>, minAlpha?: number,
   *   offset?: number, limit?: number, mode?: string,
   *   timeFrom?: string|number, timeTo?: string|number, granularity?: string,
   *   lanes?: object, round?: number, blockIds?: Iterable<string>, ledger?: Iterable<string> }} [options]
   *   `excludeIds`: folders already in the injected recall block — never
   *   re-added, never counted against `firstGenMax`, but still usable as keyword
   *   bridges for new folders. `minAlpha`: optional α floor (v1.3.0 QQ compat),
   *   folders below it behave exactly like unscored ones.
   */
  recall(userText, context = {}, options = {}) {
    const ctx = context && typeof context === 'object' ? context : {}
    const opts = options && typeof options === 'object' ? options : {}
    const refreshed = this._refresh()
    const mode = this.recallMode(opts)
    const timePlan = this._recallTimePlan(opts)
    let result =
      mode === 'legacy'
        ? null
        : this._deterministicRecall({ userText, context: ctx, options: opts, index: refreshed.index, mode, timePlan })
    if (!result) {
      result = runRecall({
        userText,
        cfg: this.cfg,
        index: refreshed.index,
        rng: this.rng,
        context: ctx,
        memoryDir: this.memoryDir,
        excludeIds: opts.excludeIds,
        // v1.3.0: α floor for QQ channel recalls (non-owner group member, D4).
        minAlpha: opts.minAlpha,
        // v1.4.0: first-generation time filter (C(Q) ∩ W).
        timeIds: timePlan.ids,
      })
    }
    const stats = result.stats || {}
    const additions = Array.isArray(result.additions) ? result.additions : []
    // Time-input warnings (ignored/failed/normalized) are part of the result the
    // adapter and the model tool surface; never drop them.
    if (Array.isArray(timePlan.warnings) && timePlan.warnings.length > 0) {
      result.warnings = [...(Array.isArray(result.warnings) ? result.warnings : []), ...timePlan.warnings]
    }

    // --- v1.4.0 pagination (deterministic selectors only in practice) --------
    const offset = clampInt(opts.offset, 0, 1_000_000, 0)
    const limitRaw = Number(opts.limit)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : additions.length
    const pageItems = offset > 0 || limit < additions.length ? additions.slice(offset, offset + limit) : additions
    const page = {
      offset,
      limit,
      total: additions.length,
      returned: pageItems.length,
      hasMore: offset + limit < additions.length,
    }

    // --- v1.4.0 miss classification (drives the memory_recall strike logic) --
    const preFilterCandidates = (Number(stats.matchedFolders) || 0) + (Number(stats.timeFiltered) || 0)
    let missType = null
    if (pageItems.length === 0) {
      if (timePlan.active && preFilterCandidates > 0 && (Number(stats.matchedFolders) || 0) === 0) missType = 'time'
      else if (preFilterCandidates === 0) missType = 'keyword'
    }

    const timeWindow = timePlan.active
      ? {
          from: timePlan.normalized.from,
          to: timePlan.normalized.to,
          level: timePlan.normalized.level,
          granularity: timePlan.normalized.granularity,
          widenedTo: result.timeWindow?.widenedTo ?? null,
          requested: timePlan.normalized.requested,
          enforced: timePlan.enforced,
          hits: timePlan.hits,
          timezone: timePlan.timezone,
        }
      : null

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
      // --- v1.4.0 telemetry (contract §7) ---
      mode,
      candidates: Number.isFinite(stats.candidates) ? stats.candidates : stats.matchedFolders || 0,
      lanesPicked: stats.lanesPicked || null,
      pops: Number.isFinite(stats.pops) ? stats.pops : null,
      frontierHits: Number.isFinite(stats.frontierHits) ? stats.frontierHits : null,
      registerDrops: Number.isFinite(stats.registerDrops) ? stats.registerDrops : null,
      reInjections: Number.isFinite(stats.reInjections) ? stats.reInjections : null,
      degraded: stats.degraded === true,
      timeFiltered: Number.isFinite(stats.timeFiltered) ? stats.timeFiltered : 0,
      timeWindow: timeWindow ? { from: timeWindow.from, to: timeWindow.to, level: timeWindow.level, widenedTo: timeWindow.widenedTo } : null,
      offset,
      limit,
      hasMore: page.hasMore,
      missType,
      added: pageItems.map((addition) => ({
        id: addition.id,
        generation: addition.generation,
        alpha: addition.alpha,
        beta: Number.isFinite(Number(addition.beta)) ? normalizeBeta(addition.beta) : 0,
        probability: addition.probability,
        chars: addition.chars,
        tokens: addition.tokens,
        lane: typeof addition.lane === 'string' ? addition.lane : null,
      })),
    })

    return {
      ...result,
      additions: pageItems,
      page,
      timeWindow,
      missType,
      mode,
      lanes: result.lanes,
    }
  }

  /** Resolve the effective recall selector for one call. */
  recallMode(options) {
    const raw = options && typeof options.mode === 'string' ? options.mode : undefined
    const candidates = [raw, this.cfg?.recall?.mode, 'fair']
    for (const candidate of candidates) {
      if (candidate === 'deterministic' || candidate === 'legacy' || candidate === 'fair') return candidate
    }
    return 'fair'
  }

  /**
   * v1.4.0 time assistance: normalize the raw `timeFrom`/`timeTo`/`granularity`
   * inputs and resolve the folder-id filter for the first generation.
   * Never throws: a bad time input degrades to "no time constraint" + warning.
   */
  _recallTimePlan(options) {
    const opts = options && typeof options === 'object' ? options : {}
    const hasInput = opts.timeFrom !== undefined || opts.timeTo !== undefined || opts.granularity !== undefined
    const timeCfg = this.cfg?.time && typeof this.cfg.time === 'object' ? this.cfg.time : {}
    const timezone = typeof timeCfg.timezone === 'string' && timeCfg.timezone ? timeCfg.timezone : ''
    const inactive = { active: false, normalized: null, ids: null, hits: 0, enforced: false, timezone, warnings: [] }
    if (!hasInput) return inactive
    if (timeCfg.mode === 'off') {
      return { ...inactive, warnings: ['recall: time arguments ignored because time.mode is "off"'] }
    }
    try {
      const normalized = normalizeTimeQuery({ timeFrom: opts.timeFrom, timeTo: opts.timeTo, granularity: opts.granularity }, this.cfg, Date.now())
      const timeIndex = this.timeIndex()
      const query = queryTimeIndex(timeIndex, normalized, this.cfg)
      return {
        active: true,
        normalized,
        // `ids === null` means "not constrained" (time.mode is index/off, or the
        // window covers everything): the selector must not filter then.
        ids: query.ids,
        hits: query.count,
        enforced: query.ids !== null,
        timezone,
        warnings: Array.isArray(normalized.warnings) ? normalized.warnings : [],
      }
    } catch (error) {
      return { ...inactive, warnings: [`recall: time query failed (${error && error.message ? error.message : error}); ignored`] }
    }
  }

  /**
   * The in-memory (never persisted) time index, rebuilt lazily when the loaded
   * index or the configured timezone changes (plan §3.3.1).
   */
  timeIndex() {
    const refreshed = this._refresh()
    const timezone = typeof this.cfg?.time?.timezone === 'string' ? this.cfg.time.timezone : ''
    const folders = Array.isArray(refreshed.index.folders) ? refreshed.index.folders : []
    const key = `${refreshed.mtimeMs}|${folders.length}|${timezone}`
    if (this._timeIndexCache && this._timeIndexCache.key === key) return this._timeIndexCache.value
    const value = buildTimeIndex(folders, this.cfg)
    this._timeIndexCache = { key, value }
    return value
  }

  /**
   * Public helper for `memory_recall` / CLI / tests: normalized window + the
   * matching folder-id set for one raw time query.
   */
  timeWindowFor(input = {}, now = Date.now()) {
    const opts = input && typeof input === 'object' ? input : {}
    const timeCfg = this.cfg?.time && typeof this.cfg.time === 'object' ? this.cfg.time : {}
    const normalized = normalizeTimeQuery({ timeFrom: opts.timeFrom, timeTo: opts.timeTo, granularity: opts.granularity }, this.cfg, now)
    const timeIndex = this.timeIndex()
    const query = queryTimeIndex(timeIndex, normalized, this.cfg)
    return {
      normalized,
      from: normalized.from,
      to: normalized.to,
      level: normalized.level,
      granularity: normalized.granularity,
      requested: normalized.requested,
      widenedTo: null,
      enforced: query.ids !== null,
      hits: query.count,
      ids: query.ids,
      timezone: typeof timeCfg.timezone === 'string' ? timeCfg.timezone : '',
      warnings: Array.isArray(normalized.warnings) ? normalized.warnings : [],
    }
  }

  /**
   * v1.4.0 FAIR-DRI recall. Implemented in engine/recall-index.js (wave-2); the
   * engine keeps the v1.3.0 probability path as long as this returns null so the
   * migration never ships a half-wired selector.
   */
  _deterministicRecall() {
    return null
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
