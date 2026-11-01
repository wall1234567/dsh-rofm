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
import { buildRecallBlock, loadRecallAdditions, recall as runRecall } from './recall.js'
import {
    buildRecallIndex,
    countCandidates,
    deserializeLanes,
    emptyLanes,
    lanesFingerprint,
    querySeeds,
    selectRecall,
    serializeLanes,
} from './recall-index.js'
import { buildTimeIndex, normalizeTimeQuery, queryTimeIndex, timeFallbackLadder } from './time-index.js'
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

/** Round to two decimals (telemetry) without ever returning -0. */
function round2(value) {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Same ordering rules as the v1.3.0 recall renderer (`recall.sort`). */
function sortRecallAdditions(additions, sortMode) {
  const list = Array.isArray(additions) ? additions.slice() : []
  const createdAtOf = (addition) => (Number.isFinite(Number(addition?.createdAt)) ? Number(addition.createdAt) : 0)
  const idCompare = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (sortMode === 'alpha') list.sort((a, b) => b.alpha - a.alpha || createdAtOf(a) - createdAtOf(b) || idCompare(a, b))
  else if (sortMode === 'generation') list.sort((a, b) => a.generation - b.generation || createdAtOf(a) - createdAtOf(b) || idCompare(a, b))
  else list.sort((a, b) => createdAtOf(a) - createdAtOf(b) || idCompare(a, b))
  return list
}

/**
 * Unique candidate counts for one query: |C(Q)| (all keyword matches above the
 * α floor) and |C(Q) ∩ W| (inside the time window).
 *
 * The selector's own counters are lane/pop oriented (and count per-lane work),
 * so telemetry and the time-miss classification measure the two set sizes here.
 * O(sum of posting lengths), Set-deduplicated.
 */
function uniqueCandidateCounts(index, seeds, options = {}) {
  const entries = index && Array.isArray(index.entries) ? index.entries : []
  const postings = index && index.postings instanceof Map ? index.postings : new Map()
  const minAlpha = Number(options.minAlpha)
  const alphaFloor = Number.isFinite(minAlpha) ? Math.min(1, Math.max(0, minAlpha)) : 0
  const timeIds = options.timeIds instanceof Set ? options.timeIds : null
  const seen = new Set()
  let all = 0
  let inWindow = 0
  for (const seed of Array.isArray(seeds) ? seeds : []) {
    const posting = postings.get(seed)
    if (!Array.isArray(posting)) continue
    for (const at of posting) {
      if (seen.has(at)) continue
      seen.add(at)
      const entry = entries[at]
      if (!entry) continue
      if (alphaFloor > 0 && entry.alpha < alphaFloor) continue
      all += 1
      if (timeIds && !timeIds.has(entry.id)) continue
      inWindow += 1
    }
  }
  return { all, inWindow }
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
    // v1.4.0 derived caches are config-fingerprint keyed; drop them eagerly.
    this._timeIndexCache = undefined
    this._recallIndexCache = undefined
    this._lanes = undefined
    this._round = 0
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
        : this._deterministicRecall({
            userText,
            context: ctx,
            options: opts,
            index: refreshed.index,
            mode,
            timePlan,
            startedAt: typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : undefined,
          })
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

    // --- v1.4.0 pagination ---------------------------------------------------
    // The deterministic selector already paginated (it needs offset+limit to
    // build the page); the legacy path is sliced here for signature parity.
    let offset = 0
    let limit = additions.length
    let pageItems = additions
    let page
    if (result.paginated === true && result.page) {
      page = result.page
      offset = page.offset
      limit = page.limit
    } else {
      offset = clampInt(opts.offset, 0, 1_000_000, 0)
      const limitRaw = Number(opts.limit)
      limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : additions.length
      pageItems = offset > 0 || limit < additions.length ? additions.slice(offset, offset + limit) : additions
      page = {
        offset,
        limit,
        total: additions.length,
        returned: pageItems.length,
        hasMore: offset + limit < additions.length,
      }
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
          hardWindow: timePlan.hardWindow === true,
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
      // A caller-provided explicit *range* (both endpoints) is a HARD window: it
      // must not silently widen, because "no memory in that range" is exactly the
      // signal the model needs ("the time may be wrong — ask the user"). A single
      // day/month/year is a SOFT window and follows the fallback ladder.
      const hasFrom = opts.timeFrom !== undefined && opts.timeFrom !== null && opts.timeFrom !== ''
      const hasTo = opts.timeTo !== undefined && opts.timeTo !== null && opts.timeTo !== ''
      return {
        active: true,
        normalized,
        // `ids === null` means "not constrained" (time.mode is index/off, or the
        // window covers everything): the selector must not filter then.
        ids: query.ids,
        hits: query.count,
        enforced: query.ids !== null,
        hardWindow: hasFrom && hasTo,
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
   * v1.4.0 FAIR-DRI recall (engine/recall-index.js): deterministic selection with
   * the rare-term / high-α / register / probe / rotation / recycle lanes.
   *
   * Returns `null` for `mode === 'legacy'` callers (see recall()). The lane state
   * is mutable and *replaced* by the selector's normalized copy, so the caller
   * (the adapter, via recall-state.json v3) must persist `result.lanes`.
   */
  _deterministicRecall(input) {
    const request = input && typeof input === 'object' ? input : {}
    const opts = request.options && typeof request.options === 'object' ? request.options : {}
    const cfg = this.cfg
    const recallCfg = cfg && typeof cfg.recall === 'object' && cfg.recall ? cfg.recall : {}
    const timeCfg = cfg && typeof cfg.time === 'object' && cfg.time ? cfg.time : {}
    const timePlan = request.timePlan || { active: false, ids: null, enforced: false, normalized: null }
    const mode = request.mode === 'deterministic' ? 'deterministic' : 'fair'
    const userText = typeof request.userText === 'string' ? request.userText : ''

    // --- page window (deterministic: k = offset + limit) ---------------------
    const offset = clampInt(opts.offset, 0, 1_000_000, 0)
    const limitRaw = Number(opts.limit)
    const requestedLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : null
    const firstGenMax = Number.isFinite(Number(recallCfg.firstGenMax)) ? Math.max(1, Math.floor(Number(recallCfg.firstGenMax))) : 10
    const take = requestedLimit ?? firstGenMax
    // +1 lookahead pick so the page can report `hasMore` without a second pass.
    const k = Math.min(2000, offset + take + 1)

    const index = this.recallIndex()
    const baseLanes = opts.lanes && typeof opts.lanes === 'object' && opts.lanes
      ? opts.lanes
      : this._lanes && typeof this._lanes === 'object'
        ? this._lanes
        : emptyLanes()
    const fallbackRound = Number.isFinite(Number(baseLanes.round)) ? Number(baseLanes.round) + 1 : 1
    const round = clampInt(opts.round, 1, 2_000_000_000, Math.max(1, fallbackRound))
    const hopsRaw = Number(opts.hops)
    const hops = Number.isFinite(hopsRaw) ? Math.max(0, Math.floor(hopsRaw)) : recallCfg.hops
    const warnings = []

    // --- time fallback ladder (plan §3.3.3): L0 → day3 → month → year → all --
    const attempts = [{ ids: timePlan.active ? timePlan.ids : null, widenedTo: null, level: timePlan.normalized ? timePlan.normalized.level : null }]
    const canLadder = timePlan.active === true && timePlan.enforced === true && timePlan.hardWindow !== true && timeCfg.mode === 'constrain'
    if (canLadder) {
      try {
        const timeIndex = this.timeIndex()
        for (const rung of timeFallbackLadder(timePlan.normalized, cfg)) {
          const query = queryTimeIndex(timeIndex, rung, cfg)
          attempts.push({
            // ids === null means "no constraint" (the `all` rung): never filter.
            ids: query.ids,
            widenedTo: rung.widenedTo,
            level: rung.level,
          })
        }
      } catch (error) {
        warnings.push(`recall: time ladder failed (${error && error.message ? error.message : error}); using the requested window`)
      }
    }
    const minResults = Math.max(1, Number(timeCfg.fallbackMinResults) || 1)
    // A failed (too narrow) rung must not advance cursor/register/recycle state:
    // every attempt starts from this pre-round snapshot and only the chosen
    // attempt's lane state is committed at the end.
    const laneSnapshot = serializeLanes(baseLanes)
    let chosen
    for (let step = 0; step < attempts.length; step += 1) {
      const attempt = attempts[step]
      const lanesForAttempt = deserializeLanes(laneSnapshot)
      const result = selectRecall(index, userText, {
        cfg,
        lanes: lanesForAttempt,
        round,
        mode,
        blockIds: opts.blockIds,
        ledger: opts.ledger,
        excludeIds: opts.excludeIds,
        minAlpha: opts.minAlpha,
        timeIds: attempt.ids,
        k,
        hops,
      })
      if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        for (const warning of result.warnings) if (!warnings.includes(warning)) warnings.push(warning)
      }
      if (!chosen) chosen = { result, attempt }
      if ((result.picks || []).length >= minResults) {
        chosen = { result, attempt }
        break
      }
      if (!canLadder) break
    }

    const result = chosen.result
    const attempt = chosen.attempt
    const selectStats = result.stats || {}
    const allPicks = Array.isArray(result.picks) ? result.picks : []
    const pagePicks = allPicks.slice(offset, offset + take)
    const pageHasMore = allPicks.length > offset + take

    // --- load the folder bodies (same shape as the legacy path) -------------
    const picked = []
    for (const pick of pagePicks) {
      const at = index.byId.get(pick.id)
      const entry = at === undefined ? null : index.entries[at]
      picked.push({
        folder: entry && entry.folder ? entry.folder : { id: pick.id, alpha: pick.alpha, createdAt: pick.createdAt },
        id: pick.id,
        generation: Number.isFinite(pick.generation) ? pick.generation : 1,
        alpha: Number.isFinite(pick.alpha) ? pick.alpha : 0,
        createdAt: Number.isFinite(pick.createdAt) ? pick.createdAt : 0,
        probability: 1,
        roll: 1,
        lane: pick.lane,
      })
    }
    const loadWarnings = []
    const additions = sortRecallAdditions(loadRecallAdditions(picked, { memoryDir: this.memoryDir, warnings: loadWarnings }), recallCfg.sort)
    for (const warning of loadWarnings) warnings.push(warning)

    // --- stats (v1.3.0 field names + v1.4.0 lanes) -------------------------
    const ctx = request.context && typeof request.context === 'object' ? request.context : {}
    // `matchedFolders` keeps the v1.3.0 meaning: candidates *inside* the time
    // window (the legacy path counts after its first-generation filter). The
    // selector's own counters are lane/pop oriented, so the two unique candidate
    // counts are measured here — O(sum of posting lengths), not per-lane work.
    let candidatesInWindow = Number(selectStats.candidates) || 0
    let candidatesAll = candidatesInWindow
    let timeFiltered = Number(selectStats.filteredByTime) || 0
    try {
      const seedList = querySeeds(index, userText, cfg).seeds
      const counts = uniqueCandidateCounts(index, seedList, {
        minAlpha: opts.minAlpha,
        timeIds: timePlan.active && timePlan.enforced ? timePlan.ids : null,
      })
      candidatesAll = counts.all
      candidatesInWindow = counts.inWindow
      timeFiltered = Math.max(0, counts.all - counts.inWindow)
    } catch {
      /* keep the selector counters when the recount fails */
    }
    let userKeywords = []
    try {
      userKeywords = querySeeds(index, userText, cfg).userKeywords
    } catch {
      userKeywords = []
    }
    let addedChars = 0
    let addedTokens = 0
    const byGeneration = {}
    for (const addition of additions) {
      addedChars += Number(addition.chars) || 0
      addedTokens += Number(addition.tokens) || 0
      const key = String(addition.generation)
      byGeneration[key] = (byGeneration[key] || 0) + 1
    }
    const contextChars = Number.isFinite(ctx.chars) ? ctx.chars : null
    const windowTokens = Number.isFinite(ctx.windowTokens) ? ctx.windowTokens : null
    const stats = {
      userKeywords,
      matchedFolders: candidatesInWindow,
      excludedFolders: Number(selectStats.excludedSkips) || 0,
      attempts: Number(selectStats.pops) || 0,
      addedFolders: additions.length,
      addedChars,
      addedTokens,
      contextChars,
      windowTokens,
      addedPercentOfContext: contextChars > 0 ? round2((addedChars / contextChars) * 100) : null,
      addedPercentOfWindow: windowTokens > 0 ? round2((addedTokens / windowTokens) * 100) : null,
      byGeneration,
      elapsedMs: round2(typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() - (request.startedAt ?? performance.now()) : 0),
      // v1.4.0 lane telemetry (contract §7)
      candidates: candidatesInWindow,
      candidatesAll,
      lowCandidates: Number(selectStats.lowCandidates) || 0,
      lanesPicked: selectStats.lanesPicked || null,
      pops: Number(selectStats.pops) || 0,
      frontierHits: Number(selectStats.frontierHits) || 0,
      registerDrops: Number(selectStats.registerDrops) || 0,
      reInjections: Number(selectStats.reInjections) || 0,
      degraded: selectStats.degraded === true,
      timeFiltered,
      filteredByAlpha: Number(selectStats.filteredByAlpha) || 0,
      round,
    }

    // Commit the winning lane state (the selector returns a normalized copy).
    if (result.lanes && typeof result.lanes === 'object') {
      this._lanes = result.lanes
      this._round = Number.isFinite(result.lanes.round) ? result.lanes.round : round
    }
    const hasMore = pageHasMore || result.hasMore === true

    return {
      additions,
      stats,
      warnings,
      lanes: result.lanes,
      timeWindow: { widenedTo: attempt.widenedTo ?? null, level: attempt.level ?? null },
      paginated: true,
      page: {
        offset,
        limit: take,
        returned: additions.length,
        candidates: Number(selectStats.candidates) || 0,
        hasMore,
      },
    }
  }

  /** The in-memory deterministic recall index (rebuilt when the index/config changed). */
  recallIndex() {
    const refreshed = this._refresh()
    const folders = Array.isArray(refreshed.index.folders) ? refreshed.index.folders : []
    const key = `${refreshed.mtimeMs}|${refreshed.size ?? -1}|${folders.length}|${lanesFingerprint(this.cfg)}`
    if (this._recallIndexCache && this._recallIndexCache.key === key) return this._recallIndexCache.value
    const value = buildRecallIndex(folders, this.cfg)
    this._recallIndexCache = { key, value }
    return value
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
