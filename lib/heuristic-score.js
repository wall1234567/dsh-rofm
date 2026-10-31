/**
 * dsh-rofm — heuristic scoring fallback (plan D8).
 *
 * The normal archive path lets the current model rate a folder through the
 * `memory_judge` tool: it lands as `scored:false` and becomes recallable only
 * after the model filled α/β/keywords. When that tool cannot reach the model
 * (a preset guard rejects it, or the user forces `compat.channelScore:
 * "heuristic"`) the archive must still produce recallable folders, so this
 * module derives the same three values deterministically:
 *
 *   α        → `engine/importance.js` (same five signals as the engine plan)
 *   keywords → `engine/tokenize.js` extractKeywords (cfg.keywords.min..max)
 *   β        → 0 (neutral trust, the documented "default" source)
 *
 * Nothing here calls a model, reads the clock or writes files: the same input
 * always produces the same output, which is what makes the fallback auditable.
 * Both exported functions are total: malformed input degrades to the
 * configured α minimum and no keywords instead of throwing.
 */

import {
  DEFAULT_CONFIG,
  cloneConfig,
  computeImportance,
  contentToText,
  extractKeywords,
} from '../engine/index.js'

/** Scoring fields merged into `meta` by the callers (never mutated itself). */
const META_EXTRA = Object.freeze({
  scored: true,
  alphaSource: 'heuristic',
  keywordsSource: 'heuristic',
  betaSource: 'default',
})

/** Signals reported for degraded input so callers can render them safely. */
const EMPTY_SIGNALS = Object.freeze({
  keywords: 0,
  decisions: 0,
  userDensity: 0,
  code: 0,
  recency: 0,
})

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Finite number or `fallback`. */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** α floor of the caller config (the documented degraded value). */
function configuredAlphaMin(cfg) {
  const value = cfg && isRecord(cfg.importance) ? cfg.importance.min : undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : DEFAULT_CONFIG.importance.min
}

function cloneDefaults(value) {
  try {
    return cloneConfig(value)
  } catch {
    // DEFAULT_CONFIG only contains plain data, so this is unreachable in
    // practice; kept so a tampered engine export cannot throw here.
    return { ...value }
  }
}

/**
 * Private config copy used for one scoring pass.
 *
 * `computeImportance` appends an `importance.warnAbove` warning to the config
 * it receives, and a long-lived adapter config is reused for every archival.
 * Cloning here keeps `cfg.warnings` (belonging to the caller) untouched, and
 * lets the caller surface the per-folder warnings this pass produced.
 * Missing/invalid groups fall back to the documented defaults.
 *
 * @param {unknown} cfg
 * @returns {object} clone with `warnings: []`
 */
function configForScoring(cfg) {
  let copy
  try {
    copy = cloneConfig(isRecord(cfg) ? cfg : {})
  } catch {
    copy = {}
  }
  if (!isRecord(copy)) copy = {}
  const defaults = DEFAULT_CONFIG

  if (!isRecord(copy.importance)) copy.importance = cloneDefaults(defaults.importance)
  const importance = copy.importance
  let min = finiteOr(importance.min, defaults.importance.min)
  let max = finiteOr(importance.max, defaults.importance.max)
  if (!(min >= 0.01 && min <= 1)) min = defaults.importance.min
  if (!(max >= min && max <= 1)) max = Math.min(1, Math.max(min, defaults.importance.max))
  importance.min = min
  importance.max = max
  if (!isRecord(importance.weights)) importance.weights = cloneDefaults(defaults.importance.weights)

  if (!isRecord(copy.keywords)) copy.keywords = cloneDefaults(defaults.keywords)
  const keywords = copy.keywords
  let keywordsMin = finiteOr(keywords.min, defaults.keywords.min)
  let keywordsMax = finiteOr(keywords.max, defaults.keywords.max)
  keywordsMin = Number.isFinite(keywordsMin) ? Math.max(0, Math.floor(keywordsMin)) : defaults.keywords.min
  keywordsMax = Number.isFinite(keywordsMax) ? Math.max(1, Math.floor(keywordsMax)) : defaults.keywords.max
  if (keywordsMax < keywordsMin) keywordsMax = Math.max(1, keywordsMin)
  keywords.min = keywordsMin
  keywords.max = keywordsMax

  // Only warnings produced by *this* pass are interesting to the caller.
  copy.warnings = []
  return copy
}

/** Concatenated conversation text of the messages being scored. */
function bodyText(messages) {
  const list = Array.isArray(messages) ? messages : []
  const parts = []
  for (const message of list) {
    if (message === null || typeof message !== 'object') continue
    let text = ''
    try {
      text = contentToText(message.content)
    } catch {
      text = ''
    }
    if (typeof text === 'string' && text.length > 0) parts.push(text)
  }
  return parts.join('\n')
}

/** Trim, drop empties/duplicates (case-insensitive) and cap at `max`. */
function cleanKeywords(raw, max) {
  const out = []
  const seen = new Set()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'string') continue
    let keyword = entry
    try {
      keyword = entry.normalize('NFKC')
    } catch {
      keyword = entry
    }
    keyword = keyword.trim()
    if (keyword.length === 0) continue
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(keyword)
    if (out.length >= max) break
  }
  return out
}

/** The degraded result: configured α floor, no keywords, zeroed signals. */
function degraded(alpha, reason) {
  return {
    alpha,
    beta: 0,
    keywords: [],
    signals: { ...EMPTY_SIGNALS },
    warnings: [`heuristic-score: ${reason}; using importance.min for alpha`],
    metaExtra: { ...META_EXTRA },
  }
}

/**
 * Deterministically score one folder without a model (D8 fallback path).
 *
 * @param {unknown} messages engine-neutral or DSH messages ({role, content});
 *   anything that is not an array is treated as degraded input.
 * @param {object} [cfg] adapter/engine config; a clone is used, so warnings the
 *   importance pass produces never leak into the caller's `cfg.warnings`.
 * @returns {{
 *   alpha: number,
 *   beta: 0,
 *   keywords: string[],
 *   signals: { keywords: number, decisions: number, userDensity: number, code: number, recency: number },
 *   warnings: string[],
 *   metaExtra: { scored: true, alphaSource: 'heuristic', keywordsSource: 'heuristic', betaSource: 'default' },
 * }} `metaExtra` is the scanning-flag set the caller merges into `meta`.
 */
export function scoreHeuristic(messages, cfg) {
  if (!Array.isArray(messages)) {
    return degraded(configuredAlphaMin(cfg), 'messages is not an array')
  }
  let scopedCfg
  try {
    scopedCfg = configForScoring(cfg)
  } catch {
    scopedCfg = configForScoring({})
  }
  try {
    const list = messages
    const importance = computeImportance(list, scopedCfg)
    const alpha = finiteOr(importance.alpha, scopedCfg.importance.min)
    const keywordsCfg = scopedCfg.keywords
    const keywords = cleanKeywords(
      extractKeywords(bodyText(list), scopedCfg, { min: keywordsCfg.min, max: keywordsCfg.max }),
      keywordsCfg.max,
    )
    const signals = isRecord(importance.signals) ? importance.signals : EMPTY_SIGNALS
    return {
      alpha,
      beta: 0,
      keywords,
      signals: { ...signals },
      warnings: Array.isArray(scopedCfg.warnings) ? scopedCfg.warnings.slice() : [],
      metaExtra: { ...META_EXTRA },
    }
  } catch {
    return degraded(configuredAlphaMin(cfg), 'unexpected scoring failure')
  }
}

/**
 * Apply heuristic scoring to a folder `meta` object.
 *
 * Returns a NEW object (the input is never mutated) with α/β/keywords/signals
 * filled and the folder marked scored. `pendingSince` is removed because the
 * folder is no longer waiting for a model judge; every other field is kept, so
 * a pending folder can be converted in place by the caller.
 *
 * @param {unknown} meta existing folder meta (may be `null`/`undefined`)
 * @param {unknown} messages messages that belong to the folder
 * @param {object} [cfg]
 * @returns {object} new meta object
 */
export function applyHeuristicMeta(meta, messages, cfg) {
  const base = isRecord(meta) ? { ...meta } : {}
  const score = scoreHeuristic(messages, cfg)
  const next = {
    ...base,
    alpha: score.alpha,
    beta: score.beta,
    keywords: score.keywords.slice(),
    signals: { ...score.signals },
    scored: true,
    alphaSource: 'heuristic',
    keywordsSource: 'heuristic',
    betaSource: 'default',
  }
  delete next.pendingSince
  return next
}
