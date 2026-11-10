/**
 * dsh-rofm engine — event constraint: in-memory event index + label resolution.
 *
 * Every memory folder may carry one optional canonical `event` label (a trip, a
 * work project, a review thread, a long-running incident, …). The canonical
 * label lives in the folder meta (`meta.event`) and is mirrored into
 * `index.folders` by engine/store.js; this module only derives an **in-memory**
 * index from `index.folders` (never persisted, never a second truth) and
 * resolves the labels a model submits.
 *
 * Two resolution directions (design contract §2):
 *
 *  - recall time (`resolveEventQuery`): the model submits the event the current
 *    sentence belongs to. `exact` constrains the recall to that event; a
 *    `similar` (bidirectionally similar but not identical) label is NOT merged
 *    automatically — the candidates are returned so the model (or the user) can
 *    decide; `unknown` is a strict constraint to an event with no memories.
 *  - scoring time (`assignEventLabel`): the model labels a memory. A similar
 *    existing label is silently merged into the canonical one so the same event
 *    always ends up with one label in the whole library.
 *
 * Zero dependencies (no imports at all): pure string/token functions plus one
 * derived index object.
 */

// ---------------------------------------------------------------------------
// constants / defaults (mirror engine/config.js DEFAULT_CONFIG.event)
// ---------------------------------------------------------------------------

/** Allowed values of `event.mode`. */
export const EVENT_MODES = Object.freeze(['off', 'index', 'constrain'])

/** Allowed values of `event.similarity.metric`. */
export const EVENT_METRICS = Object.freeze(['dice', 'avg', 'min'])

/**
 * Defaults for the `event` config group. Kept local so this module works
 * without a validated config object; engine/config.js DEFAULT_CONFIG.event is
 * the authoritative copy (the config-consistency test compares the two).
 *
 * `similarity.metric`:
 *  - 'dice' (default) `score = 2·|A∩B| / (|A|+|B|)`, symmetric, punishes
 *    length imbalance;
 *  - 'avg'  `score = (containA + containB) / 2`;
 *  - 'min'  `score = min(containA, containB)`.
 */
export const EVENT_DEFAULTS = Object.freeze({
  mode: 'index',
  maxLabelLength: 60,
  // v1.5.0: a memory may belong to several events; a similar-but-different label
  // is never merged silently — the scoring model has to approve the merge by
  // submitting the existing canonical label. The task block can list existing
  // labels so the model can reuse one directly.
  maxPerFolder: 4,
  similarity: Object.freeze({ metric: 'dice', threshold: 0.72, maxCandidates: 5 }),
  askUserHint: true,
  mergeRequiresApproval: true,
  showExisting: true,
  showExistingLimit: 24,
})

/** Literal submissions that mean "not part of any event" (normalized first). */
const EMPTY_LABELS = Object.freeze(new Set(['', '空', '无', '不约束', '无事件', 'none', 'null', 'n/a', 'na', '-']))

/** Wrapping pairs stripped from both ends of a label (only as a matched pair). */
const WRAPPING_PAIRS = Object.freeze(new Map([
  ['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’'],
  ['「', '」'], ['『', '』'], ['《', '》'], ['〈', '〉'], ['〔', '〕'],
  ['(', ')'], ['（', '）'], ['[', ']'], ['【', '】'], ['{', '}'],
  ['<', '>'], ['‹', '›'], ['«', '»'],
]))

/** Any CJK code point (same ranges as engine/tokenize.js). */
const CJK_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]+/gu
/** Latin / digit words (a "word" must be at least 2 chars to become a token). */
const LATIN_RUN_RE = /[a-z0-9_]+/g
/** A label must contain at least one letter or digit after normalization. */
const HAS_WORD_CHAR_RE = /[\p{L}\p{N}]/u
/** Zero-width characters that would otherwise create invisible label variants. */
const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g

// ---------------------------------------------------------------------------
// coercions / config
// ---------------------------------------------------------------------------

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function numberOr(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function clampNumber(value, min, max) {
  const numeric = numberOr(value, min)
  return numeric < min ? min : numeric > max ? max : numeric
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric)) return fallback
  return numeric < min ? min : numeric > max ? max : numeric
}

/**
 * Effective event configuration (`cfg.event` with contract defaults).
 * Unknown / invalid values fall back to EVENT_DEFAULTS instead of throwing.
 */
export function eventConfig(cfg) {
  const event = objectOf(objectOf(cfg).event)
  const similarity = objectOf(event.similarity)
  const mode = EVENT_MODES.includes(event.mode) ? event.mode : EVENT_DEFAULTS.mode
  return {
    mode,
    maxLabelLength: clampInt(event.maxLabelLength, EVENT_DEFAULTS.maxLabelLength, 1, 200),
    maxPerFolder: clampInt(event.maxPerFolder, EVENT_DEFAULTS.maxPerFolder, 1, 32),
    metric: EVENT_METRICS.includes(similarity.metric) ? similarity.metric : EVENT_DEFAULTS.similarity.metric,
    threshold: clampNumber(numberOr(similarity.threshold, EVENT_DEFAULTS.similarity.threshold), 0, 1),
    maxCandidates: clampInt(similarity.maxCandidates, EVENT_DEFAULTS.similarity.maxCandidates, 1, 10),
    askUserHint: event.askUserHint !== false,
    mergeRequiresApproval: event.mergeRequiresApproval !== false,
    showExisting: event.showExisting !== false,
    showExistingLimit: clampInt(event.showExistingLimit, EVENT_DEFAULTS.showExistingLimit, 1, 200),
  }
}

/** Coerce `cfg` / index arguments never throw. */
function normalizeEventIndex(index) {
  if (!index || typeof index !== 'object') return null
  if (!Array.isArray(index.labels) || !(index.byKey instanceof Map)) return null
  return index
}

/** Stable JSON serialization (sorted keys) for the index signature. */
function stableSerialize(value) {
  if (value === null || value === undefined) return 'null'
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  if (type !== 'object') return 'null'
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
}

/**
 * Strip wrapping quotes / brackets from both ends, then trim. Only a *matched*
 * pair is stripped, so an inner bracket ("日本旅行（计划）") is preserved and a
 * label can never end up with a dangling open bracket ("日本旅行（计划").
 */
function stripWrapping(text) {
  let value = text
  for (;;) {
    const chars = [...value]
    if (chars.length >= 2) {
      const closing = WRAPPING_PAIRS.get(chars[0])
      if (closing !== undefined && chars[chars.length - 1] === closing) {
        value = chars.slice(1, -1).join('').trim()
        continue
      }
    }
    if (chars.length >= 2 && WRAPPING_PAIRS.has(chars[0]) && WRAPPING_PAIRS.has(chars[chars.length - 1])) {
      // mismatched wrapping pair at both ends: strip the stray ends anyway
      value = chars.slice(1, -1).join('').trim()
      continue
    }
    break
  }
  return value.trim()
}

/** True when the normalized label is a placeholder ("no event"). */
function isEmptyLabel(text) {
  return EMPTY_LABELS.has(text) || !HAS_WORD_CHAR_RE.test(text)
}

// ---------------------------------------------------------------------------
// normalization / key / similarity
// ---------------------------------------------------------------------------

/**
 * Normalize a submitted event label.
 *
 * Rules (design contract §2): string → trim → NFKC → collapse whitespace →
 * Latin lowercase → strip wrapping quotes/brackets → truncate to
 * `event.maxLabelLength`. Placeholders ("空", "无", "不约束", "无事件", "none",
 * "null", "n/a", "na", "-", "" and punctuation-only labels) normalize to `''`,
 * which means "not part of any event".
 *
 * @param {unknown} raw
 * @param {object} [cfg]
 * @returns {string}
 */
export function normalizeEventLabel(raw, cfg) {
  const effective = eventConfig(cfg)
  let text
  if (typeof raw === 'string') text = raw
  else if (typeof raw === 'number' && Number.isFinite(raw)) text = String(raw)
  else return ''
  text = text.normalize('NFKC').toLowerCase()
  text = text.replace(ZERO_WIDTH_RE, '')
  text = stripWrapping(text.replace(/\s+/g, ' ').trim())
  text = text.replace(/\s+/g, ' ').trim()
  if (isEmptyLabel(text)) return ''
  const chars = [...text]
  if (chars.length > effective.maxLabelLength) text = chars.slice(0, effective.maxLabelLength).join('')
  text = stripWrapping(text).trim()
  if (isEmptyLabel(text)) return ''
  return text
}

/**
 * Stable event key of a label: the normalized label text itself. Two
 * submissions that normalize to the same text share one event bucket; used as
 * the `byKey` map key.
 *
 * @param {unknown} label
 * @param {object} [cfg]
 * @returns {string}
 */
export function eventKeyOf(label, cfg) {
  return normalizeEventLabel(label, cfg)
}

/**
 * Token set used by the similarity metric:
 *   - Latin/digit words with length >= 2,
 *   - every CJK bigram of a CJK run,
 *   - every CJK single character of a CJK run (a 1-char run contributes that char).
 *
 * @param {string} normalizedLabel already normalized label
 * @returns {Set<string>}
 */
function eventTokens(normalizedLabel) {
  const tokens = new Set()
  const text = typeof normalizedLabel === 'string' ? normalizedLabel : ''
  LATIN_RUN_RE.lastIndex = 0
  let match
  while ((match = LATIN_RUN_RE.exec(text)) !== null) {
    const token = match[0].replace(/^_+|_+$/g, '')
    if ([...token].length >= 2) tokens.add(token)
  }
  CJK_RUN_RE.lastIndex = 0
  while ((match = CJK_RUN_RE.exec(text)) !== null) {
    const chars = [...match[0]]
    if (chars.length === 1) {
      tokens.add(chars[0])
      continue
    }
    for (const char of chars) tokens.add(char)
    for (let at = 0; at + 1 < chars.length; at += 1) tokens.add(chars[at] + chars[at + 1])
  }
  return tokens
}

/**
 * Bidirectional event similarity.
 *
 *   containA = |tokens(A) ∩ tokens(B)| / |tokens(A)|
 *   containB = |tokens(A) ∩ tokens(B)| / |tokens(B)|
 *
 * and the effective `similarity.metric` turns the two directions into a score:
 *  - 'dice' (default): `2·|A∩B| / (|A|+|B|)` — symmetric, punishes a large
 *    length imbalance, and still requires both directions to be reasonably
 *    high ("项目" cannot swallow "登录重构项目" while "日本旅行" ≈
 *    "日本旅行计划" stays similar);
 *  - 'avg': `(containA + containB) / 2` (opt-in tuning/testing);
 *  - 'min': `min(containA, containB)` (strictest; a strict subset scores by the
 *    longer label's extra tokens, so `日本旅行` vs `日本旅行计划` is only 0.636).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {object} [cfg]
 * @returns {{ score: number, metric: 'dice'|'avg'|'min', containA: number, containB: number, keyA: string, keyB: string }}
 */
export function eventSimilarity(a, b, cfg) {
  const effective = eventConfig(cfg)
  const keyA = eventKeyOf(a, cfg)
  const keyB = eventKeyOf(b, cfg)
  return similarityOfKeys(keyA, keyB, effective)
}

/** Similarity over two already-normalized keys, using an effective config. */
function similarityOfKeys(keyA, keyB, effective) {
  const metric = effective.metric
  const empty = { score: 0, metric, containA: 0, containB: 0, keyA, keyB }
  if (!keyA || !keyB) return empty
  if (keyA === keyB) return { score: 1, metric, containA: 1, containB: 1, keyA, keyB }
  const tokensA = eventTokens(keyA)
  const tokensB = eventTokens(keyB)
  if (!tokensA.size || !tokensB.size) return empty
  let shared = 0
  for (const token of tokensA) if (tokensB.has(token)) shared += 1
  if (!shared) return empty
  const containA = shared / tokensA.size
  const containB = shared / tokensB.size
  let score
  if (metric === 'avg') score = (containA + containB) / 2
  else if (metric === 'min') score = Math.min(containA, containB)
  else score = (2 * shared) / (tokensA.size + tokensB.size) // 'dice'
  return { score, metric, containA, containB, keyA, keyB }
}

// ---------------------------------------------------------------------------
// in-memory event index (derived from index.folders; never persisted)
// ---------------------------------------------------------------------------

/**
 * Build the in-memory event index from `index.folders`.
 *
 * Only folders with a valid string id participate; a label that normalizes to
 * `''` means "not part of any event" and is skipped. Duplicate ids keep the
 * first copy (index.folders is already de-duplicated by the store, this is a
 * defensive rule for hand-built inputs).
 *
 * @param {Array<{id?: string, event?: string, createdAt?: number}>} folders
 * @param {object} [cfg]
 * @returns {{
 *   labels: Array<{label: string, key: string, count: number, firstAt: number}>,
 *   byKey: Map<string, {label: string, key: string, ids: string[], count: number, firstAt: number}>,
 *   byId: Map<string, {label: string, key: string}>,
 *   folderCount: number, builtAt: number, signature: string,
 * }}
 */
export function buildEventIndex(folders, cfg) {
  const effective = eventConfig(cfg)
  const list = Array.isArray(folders) ? folders : []
  const byKey = new Map()
  const byId = new Map()
  const byIdAll = new Map()
  const seenIds = new Set()
  let folderCount = 0
  for (const folder of list) {
    if (!folder || typeof folder !== 'object') continue
    const id = typeof folder.id === 'string' ? folder.id : ''
    if (!id || seenIds.has(id)) continue
    seenIds.add(id)
    folderCount += 1
    // v1.5.0: one folder may belong to several events. `folder.events` is the
    // multi-label truth; the legacy single `folder.event` stays as a fallback for
    // folders written before 1.5.0 (and for old indexes that mirror only `event`).
    const submitted = []
    if (Array.isArray(folder.events)) {
      for (const raw of folder.events) submitted.push(raw)
    }
    if (submitted.length === 0 && folder.event !== undefined) submitted.push(folder.event)
    const folderLabels = []
    for (const raw of submitted) {
      const label = normalizeEventLabel(raw, cfg)
      if (!label || folderLabels.includes(label)) continue
      folderLabels.push(label)
      if (folderLabels.length >= effective.maxPerFolder) break
    }
    for (const label of folderLabels) {
      const key = eventKeyOf(label, cfg)
      let bucket = byKey.get(key)
      if (!bucket) {
        bucket = { label, key, ids: [], count: 0, firstAt: 0 }
        byKey.set(key, bucket)
      }
      bucket.ids.push(id)
      bucket.count += 1
      const createdAt = numberOr(folder.createdAt, 0)
      if (bucket.count === 1 || createdAt < bucket.firstAt) bucket.firstAt = createdAt
    }
    if (folderLabels.length > 0) {
      const all = folderLabels.map((label) => ({ label, key: eventKeyOf(label, cfg) }))
      byIdAll.set(id, all)
      // Compatibility: `byId` keeps the first (canonical) label as before.
      byId.set(id, all[0])
    }
  }
  const labels = []
  for (const bucket of byKey.values()) labels.push({ label: bucket.label, key: bucket.key, count: bucket.count, firstAt: bucket.firstAt })
  labels.sort((left, right) => right.count - left.count || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0))
  // builtAt is cache bookkeeping only; selection never reads it.
  const builtAt = Date.now()
  const signature = `event1|n=${folderCount}|labels=${stableSerialize(labels.map((item) => ({ key: item.key, count: item.count, firstAt: item.firstAt })))}|max=${effective.maxLabelLength}|metric=${effective.metric}|threshold=${effective.threshold}`
  return { labels, byKey, byId, byIdAll, folderCount, builtAt, signature }
}

// ---------------------------------------------------------------------------
// recall-time resolution
// ---------------------------------------------------------------------------

/** Rank similar events by (score desc, count desc, label asc). */
function compareCandidates(left, right) {
  if (left.score !== right.score) return right.score - left.score
  if (left.count !== right.count) return right.count - left.count
  return left.label < right.label ? -1 : left.label > right.label ? 1 : 0
}

/**
 * Build the candidate list for a normalized label.
 *
 * @param {object|null} eventIndex
 * @param {string} key normalized submitted label
 * @param {object} effective eventConfig() result
 * @param {'similar'|'below'} mode
 *   - 'similar': score >= threshold (the recall-time `similar` state);
 *   - 'below':   0 < score < threshold (closest events for the `unknown` state).
 */
function similarCandidates(eventIndex, key, effective, mode = 'similar') {
  const candidates = []
  if (!eventIndex) return candidates
  for (const bucket of eventIndex.labels) {
    if (bucket.key === key) continue
    const similarity = similarityOfKeys(key, bucket.key, effective)
    const above = similarity.score >= effective.threshold
    if (mode === 'similar' ? !above : !(similarity.score > 0 && !above)) continue
    candidates.push({ label: bucket.label, count: bucket.count, score: similarity.score })
  }
  candidates.sort(compareCandidates)
  return candidates.slice(0, effective.maxCandidates)
}

/**
 * Recall-time event resolution (contract §2 five states):
 *
 *  - `empty`    — nothing submitted / placeholder: no constraint (ids = null);
 *  - `disabled` — `cfg.event.mode !== 'constrain'`: ids = null, label is recorded
 *                 but never enforced;
 *  - `exact`    — label resolves to an existing canon: ids = all ids of the event;
 *  - `similar`  — not an existing label but bidirectionally similar to some:
 *                 ids = null + candidates (the model/user decides, no auto-merge);
 *  - `unknown`  — no existing label reaches the threshold: ids = empty Set
 *                 (strictly constrained to an event with no memories ⇒ no
 *                 results) + `candidates` = the closest below-threshold events.
 *
 * @param {object|null} eventIndex
 * @param {unknown} submitted
 * @param {object} [cfg]
 * @returns {{
 *   status: 'empty'|'exact'|'similar'|'unknown'|'disabled',
 *   requested: string,
 *   label: string|null,
 *   key: string|null,
 *   ids: Set<string>|null,
 *   candidates: Array<{label: string, count: number, score: number}>,
 *   warnings: string[],
 * }}
 */
export function resolveEventQuery(eventIndex, submitted, cfg) {
  const effective = eventConfig(cfg)
  const requested = typeof submitted === 'string' ? submitted : ''
  const key = normalizeEventLabel(submitted, cfg)
  const index = normalizeEventIndex(eventIndex)
  const warnings = []
  if (!key) {
    return { status: 'empty', requested, label: null, key: null, ids: null, candidates: [], warnings }
  }
  if (effective.mode === 'off') {
    warnings.push('event: event.mode is off; event arguments are ignored')
    return { status: 'disabled', requested, label: null, key: null, ids: null, candidates: [], warnings }
  }
  if (effective.mode === 'index') {
    const bucket = index ? index.byKey.get(key) : undefined
    if (bucket) {
      return { status: 'disabled', requested, label: bucket.label, key: bucket.key, ids: null, candidates: [], warnings }
    }
    return { status: 'disabled', requested, label: key, key, ids: null, candidates: [], warnings }
  }
  const bucket = index ? index.byKey.get(key) : undefined
  if (bucket) {
    return { status: 'exact', requested, label: bucket.label, key: bucket.key, ids: new Set(bucket.ids), candidates: [], warnings }
  }
  // "Bidirectionally highly similar" (>= threshold) => let the model decide, do
  // NOT auto-merge at recall time.
  const candidates = similarCandidates(index, key, effective)
  if (candidates.length) {
    return { status: 'similar', requested, label: key, key, ids: null, candidates, warnings }
  }
  // Unknown event: still return the closest (< threshold) existing events so the
  // tool can render "该事件还没有记忆；最接近的已有事件：X（0.60）".
  const closest = similarCandidates(index, key, effective, 'below')
  warnings.push(`event: no memory has event label ${JSON.stringify(key)}${effective.askUserHint ? '; consider asking the user which event it is' : ''}`)
  return { status: 'unknown', requested, label: key, key, ids: new Set(), candidates: closest, warnings }
}

/**
 * Scoring-time resolution: the label a memory should be written with.
 *
 * A label that is bidirectionally similar to an existing canonical event is
 * silently merged into that canon (`merged` describes the merge so the judge
 * summary can warn about it); this is what keeps one event map to exactly one
 * label in the whole library. Clearing an event (`'空'`) returns `''`.
 *
 * @param {object|null} eventIndex
 * @param {unknown} submitted
 * @param {object} [cfg]
 * @returns {{ label: string, merged: null | {from: string, to: string, score: number}, warnings: string[] }}
 */
export function assignEventLabel(eventIndex, submitted, cfg) {
  const effective = eventConfig(cfg)
  const key = normalizeEventLabel(submitted, cfg)
  const warnings = []
  if (!key) return { label: '', merged: null, candidates: [], warnings }
  const index = normalizeEventIndex(eventIndex)
  const bucket = index ? index.byKey.get(key) : undefined
  if (bucket) return { label: bucket.label, merged: null, candidates: [], warnings }
  const candidates = similarCandidates(index, key, effective)
  if (candidates.length) {
    const best = candidates[0]
    if (effective.mergeRequiresApproval !== true) {
      // Backwards-compatible rollback: the old v1.4.x behaviour silently merged a
      // similar label into the existing canonical one. Kept only when the operator
      // explicitly sets event.mergeRequiresApproval=false.
      warnings.push(
        `event-merged: 事件「${key}」与已有事件「${best.label}」高度相似（${best.score.toFixed(2)}），已归并到后者，保证同一事件标签一致`,
      )
      return { label: best.label, merged: { from: key, to: best.label, score: best.score }, candidates: [], warnings }
    }
    // v1.5.0: no silent merge. The submitted label is kept as its own canonical
    // label; the candidates are surfaced so the model can approve the merge by
    // re-submitting the existing label (an exact match then merges).
    warnings.push(
      `event-candidate: 事件「${key}」与已有事件「${best.label}」高度相似（${best.score.toFixed(2)}），尚未归并；` +
        '如确认是同一事件，请用已有标签重新提交 memory_judge（event 传已有标签）以完成归并',
    )
    return { label: key, merged: null, candidates, warnings }
  }
  return { label: key, merged: null, candidates: [], warnings }
}

/**
 * Ids of one event (`null` when the label is empty or unknown), e.g. for
 * "browse the memories of this event" paths.
 *
 * @param {object|null} eventIndex
 * @param {unknown} label
 * @param {object} [cfg]
 * @returns {Set<string>|null}
 */
export function eventIdsFor(eventIndex, label, cfg) {
  const key = eventKeyOf(label, cfg)
  if (!key) return null
  const index = normalizeEventIndex(eventIndex)
  if (!index) return null
  const bucket = index.byKey.get(key)
  if (!bucket) return null
  return new Set(bucket.ids)
}
