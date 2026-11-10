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
import { buildEventIndex, normalizeEventLabel, resolveEventQuery } from './event-index.js'
import { buildRecallBlock, loadRecallAdditions, recall as runRecall } from './recall.js'
import {
    buildTagIndex,
    buildTimeTagIndex,
    normalizeTagQuery,
    resolveTagQuery,
    resolveTimeTagIds,
} from './tag-index.js'
import { detectQueryTimes } from './relative-time.js'
import {
    buildRecallIndex,
    countCandidates,
    deserializeLanes,
    emptyLanes,
    isAssistantSeed,
    lanesFingerprint,
    PAGINATE_MAX_K,
    querySeeds,
    selectRecall,
    serializeLanes,
} from './recall-index.js'
import { buildTimeIndex, folderTimeRange, normalizeTimeQuery, queryTimeIndex, timeFallbackLadder } from './time-index.js'
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

/**
 * B-03 (1.4.1): fallback for `recall.fairness.roundBudget.maxChars` when the
 * config object carries no valid value (mirrors engine/config.js DEFAULT_CONFIG).
 */
const DEFAULT_ROUND_BUDGET_CHARS = 20000

/** Clamp an optional integer option (offset/limit/round…) without throwing. */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const truncated = Math.trunc(number)
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
}

/** Normalize an optional id collection (Set, array or any iterable) to a Set. */
function toIdSet(value) {
  if (value instanceof Set) return value
  const set = new Set()
  if (value === null || value === undefined) return set
  if (typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
    for (const id of value) if (typeof id === 'string') set.add(id)
  }
  return set
}

/** Round to two decimals (telemetry) without ever returning -0. */
function round2(value) {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Zeroed recall stats for early-return paths (event ambiguity, browsing, …). */
function emptyRecallStats(context) {
  const ctx = context && typeof context === 'object' ? context : {}
  return {
    userKeywords: [],
    matchedFolders: 0,
    excludedFolders: 0,
    timeFiltered: 0,
    eventFiltered: 0,
    attempts: 0,
    addedFolders: 0,
    addedChars: 0,
    addedTokens: 0,
    contextChars: Number.isFinite(ctx.chars) ? ctx.chars : null,
    windowTokens: Number.isFinite(ctx.windowTokens) ? ctx.windowTokens : null,
    addedPercentOfContext: null,
    addedPercentOfWindow: null,
    byGeneration: {},
    elapsedMs: 0,
    candidates: 0,
    candidatesAll: 0,
    lanesPicked: null,
    pops: 0,
    frontierHits: 0,
    registerDrops: 0,
    reInjections: 0,
    degraded: false,
    filteredByAlpha: 0,
  }
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
  const eventIds = options.eventIds instanceof Set ? options.eventIds : null
  // v1.5.0 audit (F-02-05): the location/person tag filter and the time-tag
  // filter are counted separately so `tagFiltered` no longer swallows the
  // time-tag exclusions (telemetry keeps a real `timeTagFiltered`).
  const tagIds = options.tagIds instanceof Set ? options.tagIds : null
  const timeTagIds = options.timeTagIds instanceof Set ? options.timeTagIds : null
  const constrainIds = options.constrainIds instanceof Set ? options.constrainIds : null
  const seen = new Set()
  let all = 0
  let inWindow = 0
  let inEvent = 0
  let inEventTag = 0
  let inTag = 0
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
      if (eventIds && !eventIds.has(entry.id)) continue
      inEvent += 1
      if (tagIds && !tagIds.has(entry.id)) continue
      inEventTag += 1
      if (timeTagIds && !timeTagIds.has(entry.id)) continue
      if (constrainIds && !constrainIds.has(entry.id)) continue
      inTag += 1
    }
  }
  return { all, inWindow, inEvent, inEventTag, inTag }
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
    /** v1.4.0 in-memory event index (never persisted; plan §3.4 event constraint). */
    this._eventIndexCache = undefined
    /** v1.4.0 deterministic recall index (wave-2). */
    this._recallIndexCache = undefined
    /** v1.5.0 in-memory location/person/event tag index (derived, never persisted). */
    this._tagIndexCache = undefined
    /** v1.5.0 in-memory time-tag index (derived from folder.timeTags). */
    this._timeTagIndexCache = undefined
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
    this._eventIndexCache = undefined
    this._recallIndexCache = undefined
    this._tagIndexCache = undefined
    this._timeTagIndexCache = undefined
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
   *   paginate?: boolean,
   *   timeFrom?: string|number, timeTo?: string|number, granularity?: string,
   *   lanes?: object, round?: number, blockIds?: Iterable<string>, ledger?: Iterable<string> }} [options]
   *   `excludeIds`: folders already in the injected recall block — never
   *   re-added, never counted against `firstGenMax`, but still usable as keyword
   *   bridges for new folders. `minAlpha`: optional α floor (v1.3.0 QQ compat),
   *   folders below it behave exactly like unscored ones.
   *   `paginate` (1.4.1): stable page cursor semantics — select a fixed window
   *   `min(candidates, 10000)` from a **snapshot** of `lanes` (never written
   *   back), exclude only `blockIds`, then return `picks.slice(offset, offset+limit)`
   *   with an exact `page.hasMore`. Ignores `ledger`/`excludeIds`/roundBudget so
   *   page N is reproducible; an offset past the window is an empty page.
   */
  recall(userText, context = {}, options = {}) {
    const ctx = context && typeof context === 'object' ? context : {}
    const opts = options && typeof options === 'object' ? options : {}
    const refreshed = this._refresh()
    const mode = this.recallMode(opts)
    const timePlan = this._recallTimePlan(opts)
    const eventPlan = this._recallEventPlan(opts)
    // v1.5.0: location/person tag constraint + fuzzy-time (time-tag) constraint.
    const tagPlan = this._recallTagPlan(opts)
    const timeTagPlan = this._recallTimeTagPlan(opts)
    // v1.5.0 audit (F-04-03): `recall.assistantSaid.enabled === false` is a hard
    // rollback switch: the automatic path already honoured it, but an explicit
    // `memory_recall assistantSaid:true` used to bypass it. Gate the request once
    // here so every downstream path (and the echoed `assistantSaid`/"effective"
    // flags) agree with what was actually searched.
    const assistantSaidCfg = this.cfg?.recall?.assistantSaid && typeof this.cfg.recall.assistantSaid === 'object'
      ? this.cfg.recall.assistantSaid
      : {}
    const assistantSaid = opts.assistantSaid === true && assistantSaidCfg.enabled !== false
    // Pre-filter intersection of the non-time/non-event constraints (the time
    // ladder and the event filter keep their own counters/semantics).
    const restrictIds = (() => {
      const parts = []
      if (tagPlan.enforced === true && tagPlan.ids instanceof Set) parts.push(tagPlan.ids)
      if (timeTagPlan.enforced === true && timeTagPlan.ids instanceof Set) parts.push(timeTagPlan.ids)
      if (parts.length === 0) return null
      const out = new Set(parts[0])
      for (let index = 1; index < parts.length; index += 1) {
        for (const id of out) if (!parts[index].has(id)) out.delete(id)
      }
      return out
    })()
    // Pure browsing works in every mode (it is a lookup, not a recall decision):
    // `memory_recall` without keywords returns the folders inside the requested
    // time window and/or event, ordered by event start.
    // Browsing needs an *enforced* filter: an `event.mode='index'`/
    // `time.mode='index'` window alone must not turn into an unconstrained
    // "browse the whole library" (C-05, 1.4.1; the event side already checked).
    const browsing =
      typeof userText === 'string' &&
      userText.trim().length === 0 &&
      ((timePlan.active === true && timePlan.enforced === true) ||
        (eventPlan.active === true && eventPlan.enforced === true) ||
        (tagPlan.active === true && tagPlan.enforced === true) ||
        (timeTagPlan.active === true && timeTagPlan.enforced === true))
    // C-05: make the "normalized but not enforced" case explicit instead of
    // silently returning the whole library.
    if (typeof userText === 'string' && userText.trim().length === 0 && timePlan.active === true && timePlan.enforced !== true) {
      timePlan.warnings = [
        ...(Array.isArray(timePlan.warnings) ? timePlan.warnings : []),
        'recall: time.mode is "index" (window normalized, not enforced); pure time browsing needs time.mode="constrain"',
      ]
    }
    // Event ambiguity: never guess. Return BOTH events so the model can decide
    // whether they are the same event (and ask the user when it cannot tell).
    const ambiguous = eventPlan.active === true && eventPlan.status === 'similar'
    let result
    if (ambiguous) {
      result = {
        additions: [],
        stats: emptyRecallStats(ctx),
        warnings: [],
        paginated: true,
        ambiguous: true,
        page: { offset: clampInt(opts.offset, 0, 1_000_000, 0), limit: 0, returned: 0, candidates: 0, hasMore: false },
      }
    } else if (browsing) {
      const configuredFirstGenMax = Number.isFinite(Number(this.cfg?.recall?.firstGenMax))
        ? Math.max(0, Math.floor(Number(this.cfg.recall.firstGenMax)))
        : 10
      const quota = Number.isFinite(Number(opts.quota)) ? Math.max(0, Math.floor(Number(opts.quota))) : configuredFirstGenMax
      result = this._browseRecall({
        index: this.recallIndex(),
        opts,
        timePlan,
        eventPlan,
        tagPlan,
        timeTagPlan,
        restrictIds,
        context: ctx,
        offset: clampInt(opts.offset, 0, 1_000_000, 0),
        take: Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
          ? Math.min(1000, Math.floor(Number(opts.limit)))
          : quota,
        warnings: [],
      })
    } else if (mode === 'legacy') {
      result = null
    } else {
      result = this._deterministicRecall({
        userText,
        context: ctx,
        options: opts,
        index: refreshed.index,
        mode,
        timePlan,
        eventPlan,
        restrictIds,
        quota: Number.isFinite(Number(opts.quota)) ? Math.max(0, Math.floor(Number(opts.quota))) : undefined,
        clauses: Array.isArray(opts.clauses) ? opts.clauses : null,
        assistantSaid,
        // v1.5.0 audit (F-02-05): the per-kind filter id sets let the telemetry
        // split `tagFiltered` (location/person) from `timeTagFiltered`.
        tagIds: tagPlan.enforced === true && tagPlan.ids instanceof Set ? tagPlan.ids : null,
        timeTagIds: timeTagPlan.enforced === true && timeTagPlan.ids instanceof Set ? timeTagPlan.ids : null,
        startedAt: typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : undefined,
      })
    }
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
        // v1.4.0: first-generation filters (C(Q) ∩ W ∩ E).
        timeIds: timePlan.ids,
        eventIds: eventPlan.ids,
        // v1.5.0: tag / time-tag constraints (legacy path keeps its probability
        // semantics but honours the pre-filter, rollback parity is otherwise kept).
        restrictIds,
      })
    }
    const stats = result.stats || {}
    const additions = Array.isArray(result.additions) ? result.additions : []
    // Time/event input warnings (ignored/failed/normalized) are part of the result
    // the adapter and the model tool surface; never drop them.
    for (const plan of [timePlan, eventPlan, tagPlan, timeTagPlan]) {
      if (Array.isArray(plan.warnings) && plan.warnings.length > 0) {
        result.warnings = [...(Array.isArray(result.warnings) ? result.warnings : []), ...plan.warnings]
      }
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
    const matchedFolders = Number(stats.matchedFolders) || 0
    const timeFiltered = Number(stats.timeFiltered) || 0
    const eventFiltered = Number(stats.eventFiltered) || 0
    const tagFiltered = Number(stats.tagFiltered) || 0
    const timeTagFiltered = Number(stats.timeTagFiltered) || 0
    const preFilterCandidates = matchedFolders + timeFiltered + eventFiltered + tagFiltered + timeTagFiltered
    const afterTimeFilter = matchedFolders + eventFiltered + tagFiltered + timeTagFiltered
    let missType = null
    if (pageItems.length === 0) {
      if (ambiguous) missType = 'event-ambiguous'
      else if (result.browse === true) {
        if (timePlan.active) missType = 'time'
        else if (eventPlan.active) missType = 'event'
        else if (timeTagPlan.active) missType = 'time-tag'
        else if (tagPlan.active) missType = 'tag'
        else missType = 'keyword'
      } else if (preFilterCandidates === 0) missType = 'keyword'
      else if (timePlan.active && afterTimeFilter === 0) missType = 'time'
      // v1.5.0 audit (F-02-04): a filter may only own the miss when it actually
      // dropped candidates ("who caused the empty result"), never merely because
      // the result is empty. The filters apply in time → event → tag → time-tag
      // order, so the deepest filter that still had candidates to drop wins.
      else if (timeTagPlan.active && timeTagPlan.enforced && timeTagFiltered > 0 && matchedFolders === 0) missType = 'time-tag'
      else if (tagPlan.active && tagPlan.enforced && tagFiltered > 0 && matchedFolders === 0) missType = 'tag'
      else if (eventPlan.active && eventPlan.enforced && eventFiltered > 0 && matchedFolders === 0) missType = 'event'
    }

    const eventInfo = eventPlan.active && eventPlan.visible !== false
      ? {
          status: eventPlan.status,
          requested: eventPlan.requested,
          label: eventPlan.label,
          count: eventPlan.count,
          candidates: eventPlan.candidates,
          enforced: eventPlan.enforced,
        }
      : null

    const tagInfo = tagPlan.active && tagPlan.visible !== false
      ? {
          status: tagPlan.status,
          requested: tagPlan.requested,
          matched: tagPlan.matched,
          unknown: tagPlan.unknown,
          enforced: tagPlan.enforced,
        }
      : null
    const timeTagInfo = timeTagPlan.active && timeTagPlan.visible !== false
      ? {
          status: timeTagPlan.status,
          labels: timeTagPlan.labels,
          windows: timeTagPlan.windows,
          enforced: timeTagPlan.enforced,
        }
      : null

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
      categorySeeds: Array.isArray(stats.categorySeeds) ? stats.categorySeeds : [],
      degraded: stats.degraded === true,
      timeFiltered,
      // --- v1.4.0 event constraint telemetry ---
      eventStatus: eventInfo ? eventInfo.status : 'absent',
      eventLabel: eventInfo ? eventInfo.label : null,
      eventFiltered,
      // --- v1.5.0 tag / time-tag telemetry ---
      tagStatus: tagInfo ? tagInfo.status : 'absent',
      tagFiltered,
      timeTagStatus: timeTagInfo ? timeTagInfo.status : 'absent',
      timeTagLabels: timeTagInfo ? timeTagInfo.labels : [],
      timeTagFiltered,
      // v1.5.0 audit (F-04-03/F-04-05): echo only what the engine *actually*
      // searched. The legacy path never scans the assistant channel and a
      // disabled switch was already gated, so `opts.assistantSaid` alone is not
      // evidence (it used to make `assistantInfo.effective` claim a search).
      assistantSaid: result.assistantSaid === true,
      clauseCount: Array.isArray(result.clauseInfo) ? result.clauseInfo.length : 0,
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
      eventInfo,
      tagInfo,
      timeTagInfo,
      clauseInfo: Array.isArray(result.clauseInfo) ? result.clauseInfo : null,
      // `assistantSaid` is the *effective* flag (did the engine search the
      // assistant channel?); the tool derives `assistantInfo.requested` from
      // the caller's argument and `effective` from this flag.
      assistantSaid: result.assistantSaid === true,
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
      // v1.5.0: time-tagged folders are filtered by their absolute time tags, not
      // by eventStart/eventEnd ("回忆侧优先用标签"); untagged folders keep the
      // historical interval semantics.
      const preferredIds = this._applyTimeTagPreference(query.ids, normalized.from, normalized.to)
      query.ids = preferredIds
      query.count = preferredIds instanceof Set ? preferredIds.size : query.count
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
    // v1.5.0 audit (F-02-06): SPEC §6.8 promises the same normalization + hit set
    // as `engine.recall`, so the time-tag priority predicate must be applied here
    // too — time-tagged folders are matched by their tags, not eventStart/End.
    const preferredIds = this._applyTimeTagPreference(query.ids, normalized.from, normalized.to)
    return {
      normalized,
      from: normalized.from,
      to: normalized.to,
      level: normalized.level,
      granularity: normalized.granularity,
      requested: normalized.requested,
      widenedTo: null,
      enforced: preferredIds !== null,
      hits: preferredIds instanceof Set ? preferredIds.size : query.count,
      ids: preferredIds,
      timezone: typeof timeCfg.timezone === 'string' ? timeCfg.timezone : '',
      warnings: Array.isArray(normalized.warnings) ? normalized.warnings : [],
    }
  }

  /**
   * The in-memory event index, rebuilt lazily when the loaded index or the event
   * settings change (never persisted; the canonical label lives in folder meta).
   */
  eventIndex() {
    const refreshed = this._refresh()
    const folders = Array.isArray(refreshed.index.folders) ? refreshed.index.folders : []
    const eventCfg = this.cfg && typeof this.cfg.event === 'object' && this.cfg.event ? this.cfg.event : {}
    const similarity = eventCfg.similarity && typeof eventCfg.similarity === 'object' ? eventCfg.similarity : {}
    const key = `${refreshed.mtimeMs}|${refreshed.size ?? -1}|${folders.length}|${eventCfg.maxLabelLength ?? ''}|${similarity.metric ?? ''}|${similarity.threshold ?? ''}`
    if (this._eventIndexCache && this._eventIndexCache.key === key) return this._eventIndexCache.value
    const value = buildEventIndex(folders, this.cfg)
    this._eventIndexCache = { key, value }
    return value
  }

  /**
   * v1.5.0: the in-memory location/person/event tag index. Derived from
   * `index.folders` on demand (never persisted, the folder meta is the single
   * truth), rebuilt lazily when the loaded index or the tag caps change.
   */
  tagIndex() {
    const refreshed = this._refresh()
    const folders = Array.isArray(refreshed.index.folders) ? refreshed.index.folders : []
    const keys = [
      refreshed.mtimeMs,
      refreshed.size ?? -1,
      folders.length,
      this.cfg?.location?.maxLabelLength ?? '',
      this.cfg?.person?.maxLabelLength ?? '',
      this.cfg?.event?.maxLabelLength ?? '',
    ].join('|')
    if (this._tagIndexCache && this._tagIndexCache.key === keys) return this._tagIndexCache.value
    const value = buildTagIndex(folders, this.cfg)
    this._tagIndexCache = { key: keys, value }
    return value
  }

  /**
   * v1.5.0: the in-memory time-tag index. Derived from `folder.timeTags`, which
   * the archive path computes deterministically (engine/relative-time.js); it is
   * never persisted as a second truth.
   */
  timeTagIndex() {
    const refreshed = this._refresh()
    const folders = Array.isArray(refreshed.index.folders) ? refreshed.index.folders : []
    const key = `${refreshed.mtimeMs}|${refreshed.size ?? -1}|${folders.length}`
    if (this._timeTagIndexCache && this._timeTagIndexCache.key === key) return this._timeTagIndexCache.value
    const value = buildTimeTagIndex(folders, this.cfg)
    this._timeTagIndexCache = { key, value }
    return value
  }

  /**
   * v1.5.0 "回忆侧优先用标签": for one absolute [from, to) window, folders that
   * carry time tags are matched by their tags (eventStart/eventEnd ignored), the
   * remaining folders keep the historical interval semantics.
   *
   * Returns `null` when the window is unusable / no constraint applies.
   */
  _timeIdsForWindow(from, to) {
    const start = Number(from)
    const end = Number(to)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return null
    try {
      // Time-tag queries must work even when `time.mode` is 'index'/'off' (the
      // timeTag group has its own mode): force the interval scan on.
      const timeCfg = this.cfg?.time && typeof this.cfg.time === 'object' ? this.cfg.time : {}
      const constrainCfg = { ...this.cfg, time: { ...timeCfg, mode: 'constrain' } }
      const query = queryTimeIndex(this.timeIndex(), { from: start, to: end, level: 'day' }, constrainCfg)
      return this._applyTimeTagPreference(query.ids, start, end)
    } catch {
      return null
    }
  }

  /**
   * v1.5.0: replace the interval filter of time-tagged folders with their time
   * tags (conflict rule "回忆侧优先用标签"). Folders without tags are untouched.
   */
  _applyTimeTagPreference(ids, from, to) {
    if (!(ids instanceof Set)) return ids
    const ttCfg = this.cfg?.timeTag && typeof this.cfg.timeTag === 'object' ? this.cfg.timeTag : {}
    if (ttCfg.mode !== 'constrain') return ids
    const start = Number(from)
    const end = Number(to)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return ids
    try {
      const tagIndex = this.timeTagIndex()
      if (!tagIndex || !(tagIndex.taggedIds instanceof Set) || tagIndex.taggedIds.size === 0) return ids
      const tagIds = resolveTimeTagIds(tagIndex, [{ from: start, to: end }], this.cfg).ids
      const corrected = new Set()
      for (const id of ids) if (!tagIndex.taggedIds.has(id)) corrected.add(id)
      for (const id of tagIds) corrected.add(id)
      return corrected
    } catch {
      return ids
    }
  }

  /**
   * v1.5.0 tag constraint plan (location + person; events are resolved by
   * `_recallEventPlan`). Multiple values of one kind are ORed, the kinds are
   * ANDed. `ids === null` means "not constrained".
   */
  _recallTagPlan(options) {
    const opts = options && typeof options === 'object' ? options : {}
    const has = (key) => Object.prototype.hasOwnProperty.call(opts, key) && opts[key] !== undefined && opts[key] !== null
    const inactive = {
      active: false,
      status: 'absent',
      requested: { location: [], person: [], event: [] },
      matched: { location: [], person: [], event: [] },
      unknown: [],
      ids: null,
      enforced: false,
      warnings: [],
    }
    if (!has('locations') && !has('persons')) return inactive
    const locationCfg = this.cfg?.location && typeof this.cfg.location === 'object' ? this.cfg.location : {}
    const personCfg = this.cfg?.person && typeof this.cfg.person === 'object' ? this.cfg.person : {}
    if (locationCfg.mode === 'off' && personCfg.mode === 'off') {
      return { ...inactive, active: true, status: 'off', warnings: ['recall: location/person arguments ignored because both modes are "off"'] }
    }
    try {
      // `normalizeTagQuery` takes the singular kind keys (location/person/event).
      const query = normalizeTagQuery({ location: opts.locations, person: opts.persons }, this.cfg)
      const resolved = resolveTagQuery(this.tagIndex(), query, this.cfg)
      const constrained = resolved.ids instanceof Set
      return {
        active: true,
        visible: true,
        status: resolved.status,
        requested: resolved.requested,
        matched: resolved.matched,
        unknown: resolved.unknown,
        ids: constrained ? resolved.ids : null,
        enforced: constrained,
        warnings: Array.isArray(resolved.warnings) ? resolved.warnings : [],
      }
    } catch (error) {
      return { ...inactive, active: true, status: 'disabled', warnings: [`recall: tag query failed (${error && error.message ? error.message : error}); ignored`] }
    }
  }

  /**
   * v1.5.0 time-tag plan: a fuzzy time expression in the user message ("下周二",
   * "昨天", …) or a model-submitted `timeText` is converted to absolute windows
   * (engine/relative-time.js) and matched against the folders' time tags.
   * Folders without time tags keep the interval semantics (`_timeIdsForWindow`).
   */
  _recallTimeTagPlan(options) {
    const opts = options && typeof options === 'object' ? options : {}
    const hasText = typeof opts.timeText === 'string' && opts.timeText.trim().length > 0
    const inputWindows = Array.isArray(opts.timeTagWindows) ? opts.timeTagWindows : []
    const inactive = { active: false, windows: [], ids: null, enforced: false, labels: [], warnings: [] }
    if (!hasText && inputWindows.length === 0) return inactive
    const ttCfg = this.cfg?.timeTag && typeof this.cfg.timeTag === 'object' ? this.cfg.timeTag : {}
    if (ttCfg.mode === 'off') {
      return { ...inactive, active: true, status: 'off', visible: false, warnings: ['recall: time-tag arguments ignored because timeTag.mode is "off"'] }
    }
    if (ttCfg.mode !== 'constrain') {
      return { ...inactive, active: true, status: 'index', visible: true, warnings: ['recall: timeTag.mode is "index"; time tags are indexed but not enforced'] }
    }
    let rawWindows = inputWindows
    if (hasText) {
      try {
        rawWindows = detectQueryTimes(opts.timeText, Date.now(), this.cfg)
      } catch (error) {
        return { ...inactive, active: true, status: 'disabled', warnings: [`recall: time-text parse failed (${error && error.message ? error.message : error}); ignored`] }
      }
    }
    const windows = []
    for (const item of Array.isArray(rawWindows) ? rawWindows : []) {
      if (!item || typeof item !== 'object') continue
      const from = Number(item.from)
      const to = Number(item.to)
      if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) continue
      windows.push({ from, to, label: typeof item.label === 'string' ? item.label : '', granularity: typeof item.granularity === 'string' ? item.granularity : 'day' })
      if (windows.length >= 8) break
    }
    if (windows.length === 0) {
      return { ...inactive, active: true, status: 'empty', visible: true, warnings: ['recall: no time expression could be resolved from the submitted text'] }
    }
    const ids = new Set()
    try {
      for (const window of windows) {
        const windowIds = this._timeIdsForWindow(window.from, window.to)
        if (windowIds instanceof Set) for (const id of windowIds) ids.add(id)
      }
    } catch (error) {
      return { ...inactive, active: true, status: 'disabled', windows, warnings: [`recall: time-tag query failed (${error && error.message ? error.message : error}); ignored`] }
    }
    return { active: true, visible: true, status: 'exact', windows, ids, enforced: true, labels: windows.map((window) => window.label), warnings: [] }
  }

  /** Effective per-round quota (v1.5.0 adaptive quota: complex questions get 20). */
  recallQuota(analysis) {
    const recallCfg = this.cfg?.recall && typeof this.cfg.recall === 'object' ? this.cfg.recall : {}
    const base = Number.isFinite(Number(recallCfg.firstGenMax)) ? Math.max(0, Math.floor(Number(recallCfg.firstGenMax))) : 10
    // v1.5.0 audit (F-04-04): `recall.firstGenMax=0` is the documented "recall
    // disabled" kill switch (README/SPEC §6, B-05) and the 1.5.0 CHANGELOG does
    // not change its semantics. The adaptive complex quota must never raise it.
    if (base === 0) return 0
    const adaptive = recallCfg.adaptiveQuota && typeof recallCfg.adaptiveQuota === 'object' ? recallCfg.adaptiveQuota : {}
    if (adaptive.enabled === false || !analysis || analysis.complex !== true) return base
    const complexQuota = Number.isFinite(Number(adaptive.complexQuota)) ? Math.max(1, Math.floor(Number(adaptive.complexQuota))) : 20
    return Math.max(base, complexQuota)
  }

  /**
   * v1.4.0 event constraint: resolve the model-submitted `event` argument into a
   * folder-id filter (ANDed with any time window). Never throws; a bad value
   * degrades to "no constraint" + warning.
   *
   * Statuses: absent (no `event` argument) | empty (explicit "空") | exact |
   * similar (ambiguous — the caller must return both events to the model) |
   * unknown (no memory carries that event) | disabled (`event.mode` is not
   * 'constrain').
   */
  _recallEventPlan(options) {
    const opts = options && typeof options === 'object' ? options : {}
    const eventCfg = this.cfg?.event && typeof this.cfg.event === 'object' ? this.cfg.event : {}
    const inactive = {
      active: false,
      status: 'absent',
      requested: '',
      label: null,
      labels: [],
      ids: null,
      candidates: [],
      count: null,
      enforced: false,
      warnings: [],
    }
    // v1.5.0: one recall may be constrained to several events (OR). The legacy
    // single `event` string keeps working byte-for-byte for one label.
    const submitted = []
    if (Object.prototype.hasOwnProperty.call(opts, 'event') && opts.event !== undefined && opts.event !== null) submitted.push(opts.event)
    if (opts.events !== undefined && opts.events !== null) {
      if (Array.isArray(opts.events)) submitted.push(...opts.events)
      else submitted.push(opts.events)
    }
    if (submitted.length === 0) return inactive
    if (eventCfg.mode === 'off') {
      return { ...inactive, active: true, status: 'off', visible: false, warnings: ['recall: event arguments ignored because event.mode is "off"'] }
    }
    const labels = []
    for (const raw of submitted) {
      if (typeof raw !== 'string') continue
      const label = normalizeEventLabel(raw, this.cfg)
      if (label && !labels.includes(label)) labels.push(label)
    }
    if (labels.length === 0) return { ...inactive, active: true, status: 'empty', visible: true }
    try {
      const index = this.eventIndex()
      const parts = labels.map((label) => ({ label, resolved: resolveEventQuery(index, label, this.cfg) }))
      const warnings = []
      for (const part of parts) for (const warning of part.resolved.warnings || []) warnings.push(warning)
      const similar = parts.filter((part) => part.resolved.status === 'similar')
      // Ambiguity: never guess. Return every similar candidate so the model (or
      // the user) can decide; nothing is enforced.
      if (similar.length > 0) {
        const candidates = []
        for (const part of similar) {
          for (const candidate of part.resolved.candidates || []) {
            if (!candidates.some((item) => item.label === candidate.label)) candidates.push(candidate)
          }
        }
        candidates.sort((left, right) => right.score - left.score || right.count - left.count || (left.label < right.label ? -1 : 1))
        const maxCandidates = Number.isFinite(Number(eventCfg.similarity?.maxCandidates)) ? Number(eventCfg.similarity.maxCandidates) : 5
        return {
          active: true,
          visible: true,
          status: 'similar',
          requested: labels.join('、'),
          label: labels.length === 1 ? labels[0] : labels,
          labels,
          ids: null,
          candidates: candidates.slice(0, Math.max(1, maxCandidates)),
          count: null,
          enforced: false,
          warnings,
        }
      }
      const exact = parts.filter((part) => part.resolved.status === 'exact')
      const unknown = parts.filter((part) => part.resolved.status === 'unknown')
      const constrained = eventCfg.mode === 'constrain' && (exact.length > 0 || unknown.length > 0)
      let ids = null
      if (constrained) {
        ids = new Set()
        for (const part of exact) for (const id of part.resolved.ids) ids.add(id)
      }
      // v1.5.0 audit (F-02-02): a non-similar resolution still carries the
      // closest existing events (resolveEventQuery computed them; v1.4.4 passed
      // them through). Dropping them made `renderEventUnknown`'s 「最接近的已有
      // 事件」 hint unreachable for every unknown label.
      const candidatePool = []
      for (const part of parts) {
        for (const candidate of Array.isArray(part.resolved.candidates) ? part.resolved.candidates : []) {
          if (!candidate || typeof candidate.label !== 'string') continue
          if (!candidatePool.some((item) => item.label === candidate.label)) candidatePool.push(candidate)
        }
      }
      candidatePool.sort((left, right) => right.score - left.score || right.count - left.count || (left.label < right.label ? -1 : 1))
      const maxCandidates = Number.isFinite(Number(eventCfg.similarity?.maxCandidates)) ? Number(eventCfg.similarity.maxCandidates) : 5
      const status = exact.length > 0 ? 'exact' : unknown.length > 0 ? 'unknown' : 'disabled'
      return {
        active: true,
        visible: true,
        status,
        requested: labels.join('、'),
        label: labels.length === 1 ? labels[0] : labels,
        labels,
        // `ids === null` means "not constrained" (empty/similar/disabled).
        ids,
        candidates: candidatePool.slice(0, Math.max(1, maxCandidates)),
        count: ids instanceof Set ? ids.size : null,
        enforced: constrained,
        warnings,
      }
    } catch (error) {
      return {
        ...inactive,
        active: true,
        status: 'disabled',
        warnings: [`recall: event query failed (${error && error.message ? error.message : error}); ignored`],
      }
    }
  }

  /**
   * Public helper for tools/tests: resolve one raw event submission.
   */
  eventQueryFor(event) {
    return this._recallEventPlan({ event })
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
    const eventPlan = request.eventPlan || { active: false, ids: null, enforced: false }
    const eventIds = eventPlan.ids instanceof Set ? eventPlan.ids : null
    // v1.5.0 tag/time-tag pre-filter (location/person/time tags).
    const constrainIds = request.restrictIds instanceof Set ? request.restrictIds : null
    // Per-kind id sets for the telemetry split (v1.5.0 audit, F-02-05).
    const tagIds = request.tagIds instanceof Set ? request.tagIds : null
    const timeTagIds = request.timeTagIds instanceof Set ? request.timeTagIds : null
    const mode = request.mode === 'deterministic' ? 'deterministic' : 'fair'
    const userText = typeof request.userText === 'string' ? request.userText : ''

    // --- page window ---------------------------------------------------------
    // B-01 (1.4.1): `opts.paginate=true` selects a *fixed* candidate window
    // (`min(candidates, PAGINATE_MAX_K)`) from a snapshot of the lane state and
    // slices the page out of it, so page N is stable for a given state/query and
    // pages never overlap or skip candidates. Callers that do not opt in keep the
    // historical window (`k = offset+take+1`).
    const paginate = opts.paginate === true
    const offset = clampInt(opts.offset, 0, 1_000_000, 0)
    const limitRaw = Number(opts.limit)
    const requestedLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : null
    // B-05 (1.4.1): `recall.firstGenMax=0` is the documented "recall disabled"
    // quota; the engine wrapper used to force it to 1 and inject one memory in
    // fair/deterministic mode (legacy already returned 0).
    const configuredFirstGenMax = Number.isFinite(Number(recallCfg.firstGenMax))
      ? Math.max(0, Math.floor(Number(recallCfg.firstGenMax)))
      : 10
    const take = requestedLimit ?? (Number.isFinite(Number(request.quota)) ? Math.max(0, Math.floor(Number(request.quota))) : configuredFirstGenMax)

    const index = this.recallIndex()
    // --- v1.5.0 multi-clause recall ----------------------------------------
    // A user message with several clauses is searched per clause; every clause
    // with candidates gets at least one slot while the rest of the quota keeps
    // the global (whole-message) ranking. Clause coverage is best effort only
    // when the quota is smaller than the number of clauses.
    const assistantSaid = request.assistantSaid === true
    // v1.5.0: `recall.assistantSaid.reserveSlots` slots of the quota are reserved
    // for the assistant's own archived words when that channel is requested, so a
    // "你说过…" question cannot be crowded out by ordinary keyword hits.
    const assistantSaidCfg = recallCfg.assistantSaid && typeof recallCfg.assistantSaid === 'object' ? recallCfg.assistantSaid : {}
    const configuredAssistantReserve = assistantSaid && assistantSaidCfg.enabled !== false
      // v1.5.0 audit (F-04-02): clampInt(value, min, max, fallback) — the old call
      // passed the fallback (8) as `max`, so every configured value was clamped to
      // 0 and the reserved assistant pass was dead code.
      ? clampInt(assistantSaidCfg.reserveSlots, 0, 8, 0)
      : 0
    const assistantReserveEffective = Math.min(configuredAssistantReserve, Math.max(0, take - 1))
    // v1.5.5 high-relevance guaranteed quota (保底配额): a folder matching
    // several distinct query keywords keeps a guaranteed slot even when the
    // FAIR-DRI ranking would push it out of a small quota.
    const highRelCfg = recallCfg.highRelevance && typeof recallCfg.highRelevance === 'object' ? recallCfg.highRelevance : {}
    const highRelEnabled = highRelCfg.enabled !== false
    const highRelMinMatches = clampInt(highRelCfg.minMatches, 1, 16, 2)
    const highRelReserveSlots = clampInt(highRelCfg.reserveSlots, 0, 8, 2)
    const clauseTexts = Array.isArray(request.clauses)
      ? request.clauses.map((clause) => (typeof clause === 'string' ? clause.trim() : '')).filter((clause) => clause.length > 0)
      : []
    const useClauses = !paginate && clauseTexts.length > 1
    const clauseSeeds = useClauses
      ? clauseTexts.map((clause) => {
          try {
            return querySeeds(index, clause, cfg, { assistantSaid }).seeds
          } catch {
            return []
          }
        })
      : []
    const clauseHasCandidates = useClauses
      ? clauseSeeds.map((seeds) => {
          try {
            return countCandidates(index, seeds, { minAlpha: opts.minAlpha, timeIds: null, eventIds, constrainIds }) > 0
          } catch {
            return false
          }
        })
      : []
    const reservedClauses = clauseHasCandidates.filter(Boolean).length
    const reservedEffective = useClauses ? Math.min(reservedClauses, Math.max(0, take - assistantReserveEffective)) : 0
    const mainTake = useClauses || assistantReserveEffective > 0
      ? Math.max(1, take - reservedEffective - assistantReserveEffective)
      : take
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

    // --- pure time browsing (no keywords): the time window *is* the query ----
    // `memory_recall` without keywords is a documented 1.4.0 mode (plan §3.3.3
    // "纯时间浏览"): every scored folder inside the window, ordered by event start.
    // C-05 (1.4.1): only an *enforced* window may turn empty keywords into a
    // browse — `time.mode='index'` must not return the whole library.
    const browsing = userText.trim().length === 0 && timePlan.active === true && timePlan.enforced === true
    if (browsing) {
      return this._browseRecall({ index, opts, timePlan, offset, take, warnings, context: request.context })
    }
    // B-05: quota 0 → an empty round that consumes no lane state.
    if (take <= 0) {
      const ctx0 = request.context && typeof request.context === 'object' ? request.context : {}
      return {
        additions: [],
        stats: {
          userKeywords: [],
          matchedFolders: 0,
          excludedFolders: 0,
          attempts: 0,
          addedFolders: 0,
          addedChars: 0,
          addedTokens: 0,
          contextChars: Number.isFinite(ctx0.chars) ? ctx0.chars : null,
          windowTokens: Number.isFinite(ctx0.windowTokens) ? ctx0.windowTokens : null,
          addedPercentOfContext: null,
          addedPercentOfWindow: null,
          byGeneration: {},
          elapsedMs: 0,
          candidates: 0,
          candidatesAll: 0,
          lowCandidates: 0,
          lanesPicked: {},
          pops: 0,
          frontierHits: 0,
          registerDrops: 0,
          reInjections: 0,
          degraded: baseLanes.degraded === true,
          timeFiltered: 0,
          eventFiltered: 0,
          filteredByAlpha: 0,
          round,
        },
        warnings,
        lanes: baseLanes,
        candidateIds: null,
        timeWindow: { widenedTo: null, level: timePlan.normalized ? timePlan.normalized.level : null },
        paginated: true,
        page: { offset, limit: 0, returned: 0, candidates: 0, hasMore: false },
      }
    }

    // --- time fallback ladder (plan §3.3.3): L0 → day3 → month → year → all --
    const attempts = [{ ids: timePlan.active ? timePlan.ids : null, widenedTo: null, level: timePlan.normalized ? timePlan.normalized.level : null }]
    const canLadder = timePlan.active === true && timePlan.enforced === true && timePlan.hardWindow !== true && timeCfg.mode === 'constrain'
    if (canLadder) {
      try {
        const timeIndex = this.timeIndex()
        for (const rung of timeFallbackLadder(timePlan.normalized, cfg)) {
          const query = queryTimeIndex(timeIndex, rung, cfg)
          // v1.5.0 audit (F-LEAD-01/F-02-01): the "回忆侧优先用标签" rule must be
          // applied to *every* widened rung too, not only to the requested window.
          // Otherwise a tag-2020 memory whose eventStart happens to fall inside the
          // rung is injected and the ladder stops early, hiding the memory that
          // belongs to the wider window. `all` keeps ids=null (no constraint).
          const preferredIds = this._applyTimeTagPreference(query.ids, rung.from, rung.to)
          attempts.push({
            // ids === null means "no constraint" (the `all` rung): never filter.
            ids: preferredIds,
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
    if (paginate) {
      // B-01: choose the ladder rung by *candidate count* (not by offset), so all
      // pages of one query see the same window. The selection then runs on a
      // lane snapshot and its lane mutations are discarded below.
      let attemptChosen = null
      for (let step = 0; step < attempts.length; step += 1) {
        const attempt = attempts[step]
        let candidates = 0
        try {
          const seedList = querySeeds(index, userText, cfg, { assistantSaid }).seeds
          candidates = countCandidates(index, seedList, { minAlpha: opts.minAlpha, timeIds: attempt.ids, eventIds, constrainIds })
        } catch {
          candidates = 0
        }
        attemptChosen = { attempt, candidates }
        if (candidates > 0) break
        if (!canLadder) break
      }
      const pageWindow = Math.min(Math.max(0, attemptChosen.candidates), PAGINATE_MAX_K)
      const pageLanes = deserializeLanes(laneSnapshot)
      const pageResult = pageWindow > 0
        ? selectRecall(index, userText, {
            cfg,
            lanes: pageLanes,
            round,
            mode,
            // B-01: the exclusion set is only the ids currently in the block; the
            // ever-surfaced ledger must not shift items between pages.
            blockIds: opts.blockIds,
            ledger: undefined,
            excludeIds: undefined,
            minAlpha: opts.minAlpha,
            timeIds: attemptChosen.attempt.ids,
            eventIds,
            constrainIds,
            assistantSaid,
            k: pageWindow,
            paginate: true,
          })
        : { picks: [], stats: {}, hasMore: false, warnings: [] }
      if (Array.isArray(pageResult.warnings)) {
        for (const warning of pageResult.warnings) if (!warnings.includes(warning)) warnings.push(warning)
      }
      chosen = { result: pageResult, attempt: attemptChosen.attempt }
    } else {
      const k = requestedLimit === null && offset === 0 ? mainTake : Math.min(2000, offset + take + 1)
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
          eventIds,
          constrainIds,
          assistantSaid,
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
    }

    const result = chosen.result
    const attempt = chosen.attempt
    const selectStats = result.stats || {}
    const allPicks = Array.isArray(result.picks) ? result.picks : []
    let finalPicks = allPicks
    let finalLanes = result.lanes
    let clauseInfo = null
    let assistantPicked = 0
    const assistantReservedIds = new Set()
    let clauseGuaranteedIds = new Set()
    // v1.5.0 reserved assistant-utterance pass ("你说过…"): the dedicated channel
    // gets its reserved slots before the clause/leftover fill, so those memories
    // are actually injected even when the main ranking is full.
    if (assistantSaid && assistantReserveEffective > 0) {
      const reserved = this._assistantReservePicks({
        index,
        userText,
        opts,
        round,
        mode,
        timeIds: attempt.ids,
        eventIds,
        constrainIds,
        hops,
        slots: assistantReserveEffective,
        picks: finalPicks,
        lanes: finalLanes,
      })
      if (reserved.lanes && typeof reserved.lanes === 'object') finalLanes = reserved.lanes
      if (reserved.picks.length > 0) {
        const merged = finalPicks.slice()
        const seen = new Set(merged.map((pick) => pick.id))
        for (const pick of reserved.picks) {
          if (!pick || seen.has(pick.id)) continue
          seen.add(pick.id)
          merged.push(pick)
        }
        assistantPicked = merged.length - finalPicks.length
        for (const pick of reserved.picks) if (pick && typeof pick.id === 'string') assistantReservedIds.add(pick.id)
        finalPicks = merged
      }
    }
    // v1.5.0 clause coverage: every clause with candidates gets one slot before
    // the remaining quota is used for the global ranking.
    if (useClauses) {
      const coverage = this._clauseGuaranteePicks({
        index,
        userText,
        clauses: clauseTexts,
        clauseSeeds,
        clauseHasCandidates,
        opts,
        round,
        mode,
        timeIds: attempt.ids,
        eventIds,
        constrainIds,
        assistantSaid,
        hops,
        take,
        picks: finalPicks,
        lanes: finalLanes,
        // The pre-round lane snapshot every clause pass must share (DESIGN §4.2);
        // reusing `finalLanes` leaked the whole-message register into the clause
        // slots (v1.5.0 audit F-04-01).
        laneSnapshot,
      })
      finalPicks = coverage.picks
      finalLanes = coverage.lanes || finalLanes
      clauseInfo = coverage.clauseInfo
      clauseGuaranteedIds = coverage.guaranteedIds instanceof Set ? coverage.guaranteedIds : new Set(Array.isArray(coverage.guaranteedIds) ? coverage.guaranteedIds : [])
    }
    // v1.5.5: high-relevance guaranteed quota runs after the FAIR-DRI, assistant
    // and clause passes (so it cannot be crowded out) and before the page slice.
    let highRelStats = { candidates: 0, picks: 0, replaced: 0 }
    // `deterministic` mode is the pure-DRI research/rollback control: its oracle is
    // the plain sigma top-k, so the fairness enhancement only runs in `fair` mode.
    if (!paginate && mode === 'fair' && highRelEnabled && highRelReserveSlots > 0) {
      const guarantee = this._highRelevanceGuarantee({
        index,
        userText,
        opts,
        timeIds: attempt.ids,
        eventIds,
        constrainIds,
        take,
        slots: highRelReserveSlots,
        minMatches: highRelMinMatches,
        picks: finalPicks,
        protectedIds: new Set([...assistantReservedIds, ...clauseGuaranteedIds]),
      })
      finalPicks = guarantee.picks
      highRelStats = guarantee.stats
    }
    const pagePicks = finalPicks.slice(offset, offset + take)
    const pageHasMore = finalPicks.length > offset + take

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
    const loadedAdditions = loadRecallAdditions(picked, { memoryDir: this.memoryDir, warnings: loadWarnings })
    // B-01: a page is exactly `picks.slice(offset, offset+limit)` — re-sorting the
    // page would break the "page N == next limit of one ordered list" contract.
    const additions = paginate ? loadedAdditions : sortRecallAdditions(loadedAdditions, recallCfg.sort)
    for (const warning of loadWarnings) warnings.push(warning)

    // --- B-03 (1.4.1): per-round character budget ---------------------------
    // `recall.fairness.roundBudget.maxChars` was documented but never read. A
    // single round now keeps the highest-priority prefix that fits and drops the
    // tail (lowest priority lanes) with a warning + telemetry instead of
    // injecting an unbounded block. At least one folder is always kept, mirroring
    // `trimBlock`'s hard-cap behaviour.
    const roundBudget = { maxChars: null, dropped: 0, chars: null }
    if (!paginate) {
      const fairCfg = recallCfg.fairness && typeof recallCfg.fairness === 'object' ? recallCfg.fairness : {}
      const budgetCfg = fairCfg.roundBudget && typeof fairCfg.roundBudget === 'object' ? fairCfg.roundBudget : {}
      const configuredBudget = Number(budgetCfg.maxChars)
      const maxChars = Number.isFinite(configuredBudget) && configuredBudget > 0 ? Math.floor(configuredBudget) : DEFAULT_ROUND_BUDGET_CHARS
      let usedChars = additions.length > 0 ? Number(additions[0].chars) || 0 : 0
      let kept = additions.length > 0 ? 1 : 0
      while (kept < additions.length) {
        const chars = Number(additions[kept].chars) || 0
        if (usedChars + chars > maxChars) break
        usedChars += chars
        kept += 1
      }
      const dropped = additions.length - kept
      if (dropped > 0) {
        additions.splice(kept)
        roundBudget.maxChars = maxChars
        roundBudget.dropped = dropped
        roundBudget.chars = usedChars
        warnings.push(
          `recall: round char budget recall.fairness.roundBudget.maxChars=${maxChars} exceeded; kept ${kept} folder(s) ` +
            `(${usedChars} chars), dropped ${dropped} lowest-priority pick(s)`,
        )
      }
    }

    // --- stats (v1.3.0 field names + v1.4.0 lanes) -------------------------
    const ctx = request.context && typeof request.context === 'object' ? request.context : {}
    // `matchedFolders` keeps the v1.3.0 meaning: candidates *inside* the time
    // window (the legacy path counts after its first-generation filter). The
    // selector's own counters are lane/pop oriented, so the two unique candidate
    // counts are measured here — O(sum of posting lengths), not per-lane work.
    let candidatesInWindow = Number(selectStats.candidates) || 0
    let candidatesAll = candidatesInWindow
    let timeFiltered = Number(selectStats.filteredByTime) || 0
    let eventFiltered = Number(selectStats.filteredByEvent) || 0
    let tagFiltered = 0
    let timeTagFiltered = 0
    try {
      const seedList = querySeeds(index, userText, cfg, { assistantSaid }).seeds
      const counts = uniqueCandidateCounts(index, seedList, {
        minAlpha: opts.minAlpha,
        // B-07 (1.4.1): use the *chosen* ladder rung's window. Re-counting the
        // originally requested window made "returned 1, candidates 0" telemetry.
        timeIds: attempt.ids instanceof Set ? attempt.ids : null,
        eventIds,
        // v1.5.0 audit (F-02-05): count the location/person tag filter and the
        // time-tag filter separately; time-tag exclusions used to be folded into
        // `tagFiltered`, leaving the documented `timeTagFiltered` a dead field.
        tagIds,
        timeTagIds,
        constrainIds,
      })
      candidatesAll = counts.all
      timeFiltered = Math.max(0, counts.all - counts.inWindow)
      eventFiltered = Math.max(0, counts.inWindow - counts.inEvent)
      tagFiltered = Math.max(0, counts.inEvent - counts.inEventTag)
      timeTagFiltered = Math.max(0, counts.inEventTag - counts.inTag)
      candidatesInWindow = counts.inTag
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
    // Lane attribution covers the injected page only: the +1 lookahead pick is a
    // pagination probe, not part of the round's block. sum(lanesPicked) therefore
    // always equals additions.length.
    const lanesPicked = {}
    for (const addition of additions) {
      const lane = typeof addition.lane === 'string' && addition.lane ? addition.lane : 'hi'
      lanesPicked[lane] = (lanesPicked[lane] || 0) + 1
    }
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
      lanesPicked,
      pops: Number(selectStats.pops) || 0,
      frontierHits: Number(selectStats.frontierHits) || 0,
      registerDrops: Number(selectStats.registerDrops) || 0,
      reInjections: Number(selectStats.reInjections) || 0,
      degraded: selectStats.degraded === true,
      timeFiltered,
      eventFiltered,
      tagFiltered,
      // v1.5.0 audit (F-02-05): real count of folders dropped by the time-tag
      // preference (kept out of `tagFiltered` so the telemetry keys mean one
      // thing each).
      timeTagFiltered,
      filteredByAlpha: Number(selectStats.filteredByAlpha) || 0,
      categorySeeds: Array.isArray(selectStats.categorySeeds) ? selectStats.categorySeeds : [],
      assistantSaid: assistantSaid === true,
      assistantPicks: assistantPicked,
      // v1.5.5 high-relevance guarantee telemetry (0 candidates/slots = inert).
      highRelevanceEnabled: highRelEnabled,
      highRelevanceMinMatches: highRelMinMatches,
      highRelevanceReserveSlots: highRelReserveSlots,
      highRelevanceCandidates: highRelStats.candidates,
      highRelevancePicks: highRelStats.picks,
      highRelevanceReplaced: highRelStats.replaced,
      clauseCount: Array.isArray(clauseInfo) ? clauseInfo.length : 0,
      // B-03 (1.4.1): per-round character budget telemetry (null/0 = no drop).
      roundBudgetMaxChars: roundBudget.maxChars,
      roundBudgetDropped: roundBudget.dropped,
      roundBudgetChars: roundBudget.chars,
      round,
    }

    // Commit the winning lane state (the selector returns a normalized copy).
    // B-01: a paginated call never advances/writes back lane state — the pages
    // must be reproducible from the same snapshot on every request.
    if (!paginate && finalLanes && typeof finalLanes === 'object') {
      this._lanes = finalLanes
      this._round = Number.isFinite(finalLanes.round) ? finalLanes.round : round
    }
    const hasMore = paginate ? pageHasMore : pageHasMore || result.hasMore === true

    return {
      additions,
      stats,
      warnings,
      lanes: paginate ? baseLanes : finalLanes,
      clauseInfo,
      assistantSaid: assistantSaid === true,
      // σ-ordered ids of C(Q)∩W: `engine.trimBlock` uses this set to trim
      // "not in the current query" entries first (plan §3.2.4).
      candidateIds: !paginate && Array.isArray(result.candidateIds) ? result.candidateIds : null,
      timeWindow: { widenedTo: attempt.widenedTo ?? null, level: attempt.level ?? null },
      paginated: true,
      page: {
        offset,
        limit: take,
        returned: additions.length,
        candidates: candidatesInWindow,
        hasMore,
      },
    }
  }

  /**
   * v1.5.0 reserved assistant-utterance pass: search ONLY the assistant channel
   * and return up to `slots` picks that are not already in `picks`.
   *
   * Feature-gated by `recall.assistantSaid.enabled` and the caller's
   * `assistantSaid` request flag; a failure degrades to "no reserved picks"
   * (never breaks the recall round).
   *
   * @param {{
   *   index: object, userText: string, opts: object, round: number, mode: string,
   *   timeIds: Set<string>|null, eventIds: Set<string>|null, constrainIds: Set<string>|null,
   *   hops: number, slots: number, picks: object[], lanes: object,
   * }} input
   * @returns {{ picks: object[], lanes: object|null }}
   */
  _assistantReservePicks(input) {
    const result = { picks: [], lanes: input.lanes }
    try {
      // v1.5.0 audit (F-04-02): same clampInt argument-order bug as the caller —
      // `max` must be 8 and the fallback 0, otherwise the reserved pass is inert.
      const slots = clampInt(input.slots, 0, 8, 0)
      if (slots <= 0) return result
      const pickedIds = new Set((Array.isArray(input.picks) ? input.picks : []).map((pick) => pick && pick.id).filter(Boolean))
      const blockIds = new Set()
      for (const id of toIdSet(input.opts?.blockIds)) blockIds.add(id)
      for (const id of pickedIds) blockIds.add(id)
      const reserved = selectRecall(input.index, input.userText, {
        cfg: this.cfg,
        lanes: input.lanes,
        round: input.round,
        mode: input.mode,
        blockIds,
        ledger: input.opts?.ledger,
        excludeIds: input.opts?.excludeIds,
        minAlpha: input.opts?.minAlpha,
        timeIds: input.timeIds,
        eventIds: input.eventIds,
        constrainIds: input.constrainIds,
        assistantSaid: true,
        assistantOnly: true,
        k: slots,
        hops: input.hops,
      })
      if (reserved.lanes && typeof reserved.lanes === 'object') result.lanes = reserved.lanes
      for (const pick of Array.isArray(reserved.picks) ? reserved.picks : []) {
        if (!pick || pickedIds.has(pick.id)) continue
        pickedIds.add(pick.id)
        result.picks.push(pick)
        if (result.picks.length >= slots) break
      }
    } catch {
      // The reserved pass is an enhancement: never let it break the main recall.
    }
    return result
  }

  /**
   * v1.5.0 multi-clause coverage: after the main (whole-message) selection,
   * every clause whose seeds have candidates gets at least one dedicated slot
   * (when the quota allows it); leftover quota tops the result back up with the
   * global ranking. Returns the merged picks, the advanced lane state and one
   * `clauseInfo` record per clause for the model-facing section.
   *
   * @param {{
   *   index: object, userText: string, clauses: string[], clauseSeeds: string[][],
   *   clauseHasCandidates: boolean[], opts: object, round: number, mode: string,
   *   timeIds: Set<string>|null, eventIds: Set<string>|null, constrainIds: Set<string>|null,
   *   assistantSaid: boolean, hops: number, take: number, picks: object[], lanes: object,
   * }} input
   * @returns {{ picks: object[], lanes: object|null, clauseInfo: object[] }}
   */
  _clauseGuaranteePicks(input) {
    const {
      index,
      userText,
      clauses,
      clauseSeeds,
      clauseHasCandidates,
      opts,
      round,
      mode,
      timeIds,
      eventIds,
      constrainIds,
      assistantSaid,
      hops,
      take,
    } = input
    const picks = Array.isArray(input.picks) ? input.picks.slice() : []
    let lanes = input.lanes
    const pickedIds = new Set(picks.map((pick) => pick.id))
    const guaranteedIds = new Set()
    const seedsOf = (clauseAt) => new Set(Array.isArray(clauseSeeds[clauseAt]) ? clauseSeeds[clauseAt] : [])
    const entryKeywords = (pick) => {
      const at = index.byId instanceof Map ? index.byId.get(pick.id) : undefined
      const entry = at === undefined ? null : index.entries[at]
      return entry && Array.isArray(entry.keywords) ? entry.keywords : []
    }
    // A pick may only be attributed to a clause whose own seeds it matches.
    const belongsToClause = (pick, seeds) => {
      if (!pick || typeof pick.id !== 'string' || seeds.size === 0) return false
      for (const keyword of entryKeywords(pick)) {
        if (seeds.has(keyword)) return true
      }
      return false
    }
    const hitIdsOf = (clauseAt) => {
      const seeds = seedsOf(clauseAt)
      const ids = []
      for (const pick of picks) {
        if (belongsToClause(pick, seeds)) ids.push(pick.id)
      }
      return ids
    }
    const clauseInfo = clauses.map((text, clauseAt) => {
      const seeds = Array.isArray(clauseSeeds[clauseAt]) ? clauseSeeds[clauseAt] : []
      const ids = hitIdsOf(clauseAt)
      return {
        index: clauseAt,
        text,
        keywords: seeds.slice(0, 8),
        quota: 0,
        hits: ids.length,
        // v1.5.0 audit (F-04-06): the ids actually attributed to this clause, so
        // the caller can recompute the real hit count after a budget trim.
        ids,
        status: seeds.length === 0 ? 'no-keywords' : ids.length > 0 ? 'hit' : 'none',
      }
    })
    // v1.5.0 audit (F-04-01): a per-clause pass must NOT reuse the lane state the
    // whole-message selection just advanced — its `pendingHigh` register holds
    // memories deferred for *other* clauses, and the register lane injects them
    // without checking the seeds. DESIGN §4.2: every clause selectRecall shares
    // the same pre-round attempt lane snapshot (blockIds accumulate) and only the
    // chosen attempt's lane state is committed, so these passes are throwaway.
    const hasSnapshot = input.laneSnapshot && typeof input.laneSnapshot === 'object'
    const clauseLanes = () => (hasSnapshot ? deserializeLanes(input.laneSnapshot) : lanes)
    const extra = (clauseText, k) => {
      if (k <= 0) return null
      const blockIds = new Set()
      for (const id of toIdSet(opts.blockIds)) blockIds.add(id)
      for (const id of pickedIds) blockIds.add(id)
      try {
        return selectRecall(index, clauseText, {
          cfg: this.cfg,
          lanes: clauseLanes(),
          round,
          mode,
          blockIds,
          ledger: opts.ledger,
          excludeIds: opts.excludeIds,
          minAlpha: opts.minAlpha,
          timeIds,
          eventIds,
          constrainIds,
          assistantSaid: assistantSaid === true,
          k,
          hops,
        })
      } catch {
        return null
      }
    }
    // 1) Guarantee one slot for every uncovered clause that has candidates.
    for (let clauseAt = 0; clauseAt < clauses.length; clauseAt += 1) {
      if (picks.length >= take) break
      if (!clauseHasCandidates[clauseAt]) continue
      if (clauseInfo[clauseAt].hits > 0) continue
      const seeds = seedsOf(clauseAt)
      const result = extra(clauses[clauseAt], 1)
      if (!result) {
        clauseInfo[clauseAt].status = 'miss'
        continue
      }
      let added = 0
      for (const pick of Array.isArray(result.picks) ? result.picks : []) {
        if (!pick || typeof pick.id !== 'string' || pickedIds.has(pick.id)) continue
        // Never let a memory of another clause fill this clause's guaranteed slot.
        if (!belongsToClause(pick, seeds)) continue
        pickedIds.add(pick.id)
        picks.push(pick)
        added += 1
      }
      clauseInfo[clauseAt].quota = 1
      clauseInfo[clauseAt].status = added > 0 ? 'hit' : 'miss'
      if (added > 0) for (const pick of picks.slice(-added)) if (pick && typeof pick.id === 'string') guaranteedIds.add(pick.id)
    }
    // 2) Leftover quota: continue the global ranking (no clause left starved).
    const leftover = take - picks.length
    if (leftover > 0) {
      const result = extra(userText, leftover)
      if (result && result.lanes && typeof result.lanes === 'object' && !hasSnapshot) lanes = result.lanes
      if (result) {
        for (const pick of Array.isArray(result.picks) ? result.picks : []) {
          if (!pick || typeof pick.id !== 'string' || pickedIds.has(pick.id)) continue
          pickedIds.add(pick.id)
          picks.push(pick)
        }
      }
    }
    // 3) Real per-clause attribution over the final page (main selection + the
    // guaranteed slots + the leftover fill): `hits` is the number of injected
    // picks that actually belong to the clause — never `max(1, …)` padding.
    for (let clauseAt = 0; clauseAt < clauses.length; clauseAt += 1) {
      const ids = hitIdsOf(clauseAt)
      const record = clauseInfo[clauseAt]
      record.ids = ids
      record.hits = ids.length
      if (record.status === 'no-keywords') continue
      if (ids.length > 0) record.status = 'hit'
      else if (record.quota > 0) record.status = 'miss'
      else record.status = 'none'
    }
    return { picks, lanes, clauseInfo, guaranteedIds }
  }

  /**
   * v1.5.5 high-relevance guaranteed quota (保底配额).
   *
   * A folder is "highly relevant" when it matches at least `minMatches`
   * *distinct* query keywords. Up to `slots` such folders must survive the
   * round: free slots are filled first; when the quota is already full the
   * lowest-priority unprotected tail pick is replaced (the assistant-utterance
   * and multi-clause guarantees are never evicted). Applies to the whole-message
   * query (clause passes keep their own guarantee) and never to paginated calls
   * (a guarantee would make page N depend on the live lane state).
   *
   * Best effort by design: a malformed index/query degrades to "no guarantee"
   * and never breaks the recall round.
   *
   * @param {{
   *   index: object, userText: string, opts: object,
   *   timeIds: Set<string>|null, eventIds: Set<string>|null,
   *   constrainIds: Set<string>|null, take: number, slots: number,
   *   minMatches: number, picks: object[], protectedIds: Iterable<string>,
   * }} input
   * @returns {{ picks: object[], stats: { candidates: number, picks: number, replaced: number } }}
   */
  _highRelevanceGuarantee(input) {
    const result = { picks: Array.isArray(input.picks) ? input.picks.slice() : [], stats: { candidates: 0, picks: 0, replaced: 0 } }
    try {
      const index = input.index || this.recallIndex()
      const entries = Array.isArray(index.entries) ? index.entries : []
      const postings = index.postings instanceof Map ? index.postings : null
      const slots = clampInt(input.slots, 0, 8, 0)
      const take = clampInt(input.take, 0, 2000, 0)
      if (slots <= 0 || take <= 0 || entries.length === 0 || !postings) return result
      const picks = result.picks
      // Offset pages (non-paginated path) keep their historical window shape.
      if (picks.length > take) return result
      const userText = typeof input.userText === 'string' ? input.userText : ''
      if (userText.trim().length === 0) return result
      const seeds = querySeeds(index, userText, this.cfg, { assistantSaid: false }).seeds.filter((seed) => {
        if (typeof seed !== 'string' || seed.length === 0) return false
        if (isAssistantSeed(seed)) return false
        // Synthetic category seeds start with U+0002 (engine/recall-index.js);
        // only real keyword seeds count for relevance.
        return seed.charCodeAt(0) !== 2
      })
      if (seeds.length < 2) return result
      const counts = new Map()
      for (const seed of seeds) {
        const posting = postings.get(seed)
        if (!Array.isArray(posting)) continue
        for (const at of posting) counts.set(at, (counts.get(at) || 0) + 1)
      }
      const minMatches = clampInt(input.minMatches, 2, 16, 2)
      const blockIds = toIdSet(input.opts && input.opts.blockIds)
      const excludeIds = toIdSet(input.opts && input.opts.excludeIds)
      const ledgerIds = toIdSet(input.opts && input.opts.ledger)
      // Mirror the selector: an explicit call floor wins, otherwise the
      // configured recall.minAlpha gate applies (E-05). The guarantee must never
      // re-admit a memory the configured floor hides.
      const explicitFloor = Number(input.opts && input.opts.minAlpha)
      const configuredFloor = Number(this.cfg && this.cfg.recall && this.cfg.recall.minAlpha)
      const alphaRaw = Number.isFinite(explicitFloor) ? explicitFloor : Number.isFinite(configuredFloor) ? configuredFloor : 0
      const alphaFloor = Math.min(1, Math.max(0, alphaRaw))
      const candidates = []
      for (const [at, count] of counts) {
        if (count < minMatches) continue
        const entry = entries[at]
        if (!entry || typeof entry.id !== 'string') continue
        if (alphaFloor > 0 && (Number(entry.alpha) || 0) < alphaFloor) continue
        if (input.timeIds && !input.timeIds.has(entry.id)) continue
        if (input.eventIds && !input.eventIds.has(entry.id)) continue
        if (input.constrainIds && !input.constrainIds.has(entry.id)) continue
        if (blockIds.has(entry.id) || excludeIds.has(entry.id) || ledgerIds.has(entry.id)) continue
        candidates.push({ entry, count })
      }
      result.stats.candidates = candidates.length
      if (candidates.length === 0) return result
      candidates.sort(
        (left, right) =>
          right.count - left.count ||
          (Number(right.entry.alpha) || 0) - (Number(left.entry.alpha) || 0) ||
          (Number(left.entry.createdAt) || 0) - (Number(right.entry.createdAt) || 0) ||
          (left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0),
      )
      const highIds = new Set(candidates.map((candidate) => candidate.entry.id))
      const protectedIds = toIdSet(input.protectedIds)
      const pickedIds = new Set(picks.map((pick) => pick && pick.id).filter(Boolean))
      let guaranteed = 0
      for (const pick of picks) if (pick && highIds.has(pick.id)) guaranteed += 1
      const target = Math.min(slots, candidates.length, take)
      let need = Math.max(0, target - guaranteed)
      for (const candidate of candidates) {
        if (need <= 0) break
        const entry = candidate.entry
        if (pickedIds.has(entry.id)) continue
        const pick = { id: entry.id, alpha: entry.alpha, createdAt: entry.createdAt, generation: 1, probability: 1, roll: 1, lane: 'highRel' }
        if (picks.length < take) {
          picks.push(pick)
        } else {
          let evictAt = -1
          for (let at = picks.length - 1; at >= 0; at -= 1) {
            const existing = picks[at]
            if (!existing || typeof existing.id !== 'string') continue
            if (protectedIds.has(existing.id)) continue
            if (highIds.has(existing.id)) continue
            evictAt = at
            break
          }
          if (evictAt < 0) break
          picks.splice(evictAt, 1, pick)
          result.stats.replaced += 1
        }
        pickedIds.add(entry.id)
        need -= 1
        guaranteed += 1
      }
      result.stats.picks = picks.reduce((count, pick) => count + (pick && highIds.has(pick.id) ? 1 : 0), 0)
    } catch {
      // The guarantee is an enhancement: never let it break the main recall.
    }
    return result
  }

  /**
   * Pure time browsing (v1.4.0 §3.3.3): `memory_recall` called without keywords
   * returns the scored folders inside the requested time window, ordered by the
   * folder's event start (`eventStart` when known, else `createdAt`).
   *
   * No lane state is consumed (browsing is not a "recall decision"), but folders
   * already injected into the current block (`excludeIds`) are skipped so the
   * answer is not a duplicate of what the model already sees.
   */
  _browseRecall(input) {
    const request = input && typeof input === 'object' ? input : {}
    const opts = request.opts && typeof request.opts === 'object' ? request.opts : {}
    const timePlan = request.timePlan || {}
    const eventPlan = request.eventPlan || {}
    const ctx = request.context && typeof request.context === 'object' ? request.context : {}
    const index = request.index || this.recallIndex()
    const offset = clampInt(request.offset, 0, 1_000_000, 0)
    // B-05 (1.4.1): a 0 quota (recall.firstGenMax=0) must yield an empty page,
    // not the historical fallback to 10.
    const take = Number.isFinite(request.take) ? Math.max(0, Math.floor(request.take)) : 10
    const warnings = Array.isArray(request.warnings) ? request.warnings : []
    const windowIds = timePlan.ids instanceof Set ? timePlan.ids : null
    const eventIds = eventPlan.ids instanceof Set ? eventPlan.ids : null
    const tagPlan = request.tagPlan || {}
    const timeTagPlan = request.timeTagPlan || {}
    const tagIds = tagPlan.ids instanceof Set ? tagPlan.ids : null
    const timeTagIds = timeTagPlan.ids instanceof Set ? timeTagPlan.ids : null
    const restrictIds = request.restrictIds instanceof Set ? request.restrictIds : null
    const excluded = toIdSet(opts.excludeIds)
    const minAlphaRaw = Number(opts.minAlpha)
    const alphaFloor = Number.isFinite(minAlphaRaw) ? Math.min(1, Math.max(0, minAlphaRaw)) : 0

    const candidates = []
    // v1.5.0 audit (F-02-05): browsing must report which constraint dropped the
    // candidates (`tagFiltered`/`timeTagFiltered` were missing from this stats
    // object entirely, so the telemetry always read 0). The filters are applied
    // in the same order as the deterministic path: time window → event → tag →
    // time tag (all ANDed; the counters only describe the drops).
    let inEventCount = 0
    let inTagCount = 0
    let inRestrictCount = 0
    for (const entry of index.entries) {
      if (windowIds && !windowIds.has(entry.id)) continue
      if (alphaFloor > 0 && entry.alpha < alphaFloor) continue
      if (eventIds && !eventIds.has(entry.id)) continue
      inEventCount += 1
      if (tagIds && !tagIds.has(entry.id)) continue
      inTagCount += 1
      if (timeTagIds && !timeTagIds.has(entry.id)) continue
      if (restrictIds && !restrictIds.has(entry.id)) continue
      inRestrictCount += 1
      if (excluded.has(entry.id)) continue
      const folder = entry.folder && typeof entry.folder === 'object' ? entry.folder : {}
      let range = null
      try {
        range = folderTimeRange(folder)
      } catch {
        range = null
      }
      const start = Number.isFinite(range?.start) ? range.start : Number(entry.createdAt) || 0
      candidates.push({ entry, start })
    }
    candidates.sort(
      (left, right) =>
        left.start - right.start ||
        Number(left.entry.createdAt) - Number(right.entry.createdAt) ||
        (left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0),
    )

    const pageCandidates = candidates.slice(offset, offset + take)
    const picked = pageCandidates.map((candidate) => ({
      folder: candidate.entry.folder || { id: candidate.entry.id, alpha: candidate.entry.alpha, createdAt: candidate.entry.createdAt },
      id: candidate.entry.id,
      generation: 1,
      alpha: candidate.entry.alpha,
      createdAt: candidate.entry.createdAt,
      probability: 1,
      roll: 1,
      lane: 'browse',
    }))
    const loadWarnings = []
    // C-02 (1.4.1): pure time browsing is documented as ordered by event start
    // (SPEC §6.8); `recall.sort` re-sorted it by createdAt and the CLI/engine API
    // returned the wrong order. `picked` is already in event-start order.
    const additions = loadRecallAdditions(picked, { memoryDir: this.memoryDir, warnings: loadWarnings })
    for (const warning of loadWarnings) warnings.push(warning)

    let addedChars = 0
    let addedTokens = 0
    for (const addition of additions) {
      addedChars += Number(addition.chars) || 0
      addedTokens += Number(addition.tokens) || 0
    }
    const contextChars = Number.isFinite(ctx.chars) ? ctx.chars : null
    const windowTokens = Number.isFinite(ctx.windowTokens) ? ctx.windowTokens : null
    const stats = {
      userKeywords: [],
      matchedFolders: candidates.length,
      excludedFolders: 0,
      attempts: 0,
      addedFolders: additions.length,
      addedChars,
      addedTokens,
      contextChars,
      windowTokens,
      addedPercentOfContext: contextChars > 0 ? round2((addedChars / contextChars) * 100) : null,
      addedPercentOfWindow: windowTokens > 0 ? round2((addedTokens / windowTokens) * 100) : null,
      byGeneration: additions.length > 0 ? { 1: additions.length } : {},
      elapsedMs: 0,
      candidates: candidates.length,
      candidatesAll: candidates.length,
      lowCandidates: 0,
      lanesPicked: null,
      pops: 0,
      frontierHits: 0,
      registerDrops: 0,
      reInjections: 0,
      degraded: false,
      timeFiltered: 0,
      // v1.5.0 audit (F-02-05): a pure browse applies the same tag/time-tag
      // constraints, so it must report how many folders those filters dropped.
      tagFiltered: Math.max(0, inEventCount - inTagCount),
      timeTagFiltered: Math.max(0, inTagCount - inRestrictCount),
      filteredByAlpha: 0,
      browse: true,
      round: Number.isFinite(Number(this._round)) ? this._round : 0,
    }
    return {
      additions,
      stats,
      warnings,
      lanes: this._lanes,
      timeWindow: { widenedTo: null, level: timePlan.normalized ? timePlan.normalized.level : null },
      paginated: true,
      browse: true,
      page: {
        offset,
        limit: take,
        returned: additions.length,
        candidates: candidates.length,
        hasMore: take > 0 && offset + take < candidates.length,
      },
    }
  }

  /** The in-memory deterministic recall index (rebuilt when the index/config changed). */
  recallIndex() {
    const refreshed = this._refresh()
    const folders = Array.isArray(refreshed.index.folders) ? refreshed.index.folders : []
    // v1.5.0 audit (F-04-03): the assistant-utterance postings are only built when
    // the channel is enabled, so the switch is part of the cache fingerprint.
    const assistantSaidEnabled = !(
      this.cfg?.recall?.assistantSaid && this.cfg.recall.assistantSaid.enabled === false
    )
    const key = `${refreshed.mtimeMs}|${refreshed.size ?? -1}|${folders.length}|${lanesFingerprint(this.cfg)}|asst=${assistantSaidEnabled ? 1 : 0}`
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
