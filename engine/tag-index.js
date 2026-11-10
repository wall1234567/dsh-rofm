/**
 * dsh-rofm engine — location / person / event tag constraints + time-tag index.
 *
 * v1.5.0 (docs/SPEC.md §6.10, design contract §3.2). Every memory folder may
 * carry zero or more canonical tags:
 *
 *   - `locations: string[]` — explicit places ("北京", "公司", "家", "小明家");
 *   - `persons:   string[]` — explicitly mentioned people ("小明", "张三");
 *   - `events:    string[]` — the event(s) the memory belongs to (the legacy
 *     single `event` string is still accepted; `events` wins when present);
 *   - `timeTags:  {from:number,to:number,label:string,granularity}[]` —
 *     deterministic half-open `[from, to)` epoch-ms intervals computed at
 *     archive time by engine/relative-time.js.
 *
 * The canonical values live in the folder meta / `index.folders`; this module
 * only derives **in-memory** indexes from them (`buildTagIndex`,
 * `buildTimeTagIndex`). Nothing here is persisted, so there is never a second
 * source of truth on disk: delete the index and it can always be rebuilt from
 * `index.folders`.
 *
 * Label normalization rules (`normalizeTagLabel`): string/number only → NFKC →
 * zero-width removal → trim → whitespace folding → Latin lowercase → strip
 * wrapping quotes/brackets → placeholder filtering → truncate to
 * `maxLabelLength`. Placeholders ("空", "无", "不约束", "无事件", "none",
 * "null", "n/a", "na", "-" and anything without a letter/digit) become ''.
 * Locations have one extra rule: 我家/我家里/家里/在家/回家/家 collapse to
 * 「家」 and `X的家` collapses to `X家` ("小明的家" → "小明家"), because in
 * Chinese conversation both spellings name the same place. Persons and events
 * never get that special case ("小明的家" stays the person label 小明的家).
 *
 * The recall engine combines the results: same-kind tags OR (a memory tagged
 * with any requested label of a kind matches), different kinds AND, time tags
 * by half-open interval overlap.
 *
 * Mention detection (`detectTagMentions`): known labels are searched as
 * substrings, longer labels winning overlapping spans. A **single-character
 * CJK label** (「家」 is a legal location) additionally needs a word context —
 * the match starts the text, or follows a non-letter/non-digit character, or
 * follows a pronoun prefix (我/你/他/她/咱/俺, as in 我家) or a motion/position
 * prefix (在/回/到/去/来/进/出, as in 在家/回家). Otherwise 大家/国家/专家/人家
 * would look like a mention of 「家」 and hard-filter recall. Labels of two or
 * more characters keep the plain substring rule.
 *
 * Zero dependencies: no imports at all — pure string/index functions.
 */

// ---------------------------------------------------------------------------
// constants / defaults
// ---------------------------------------------------------------------------

/** Tag kinds handled by this module, in stable reporting order. */
export const TAG_KINDS = Object.freeze(['location', 'person', 'event'])

/** Allowed values of `<kind>.mode`: 'off' | 'index' | 'constrain'. */
export const TAG_MODES = Object.freeze(['off', 'index', 'constrain'])

/** Allowed `folder.timeTags[].granularity` values; anything else becomes 'day'. */
export const TIME_GRANULARITIES = Object.freeze(['day', 'week', 'month', 'year'])

/**
 * Contract defaults for the three tag groups. Kept local so this module works
 * without a validated config object; engine/config.js DEFAULT_CONFIG carries
 * the authoritative copies (`location`, `person`, `event`) with the same
 * values. Only the fields below are tag-index concerns — `event` additionally
 * has similarity/merge settings in config.js.
 *
 * @type {Readonly<Record<'location'|'person'|'event', Readonly<{mode:'off'|'index'|'constrain', maxLabelLength:number, maxPerFolder:number}>>>}
 */
export const TAG_DEFAULTS = Object.freeze({
  location: Object.freeze({ mode: 'index', maxLabelLength: 60, maxPerFolder: 8 }),
  person: Object.freeze({ mode: 'index', maxLabelLength: 60, maxPerFolder: 8 }),
  event: Object.freeze({ mode: 'index', maxLabelLength: 60, maxPerFolder: 4 }),
})

/** Literal submissions that mean "no tag" (checked after normalization). */
const EMPTY_LABELS = Object.freeze(new Set(['', '空', '无', '不约束', '无事件', 'none', 'null', 'n/a', 'na', '-']))

/** Wrapping pairs stripped from both ends of a label (only as a matched pair). */
const WRAPPING_PAIRS = Object.freeze(new Map([
  ['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’'],
  ['「', '」'], ['『', '』'], ['《', '》'], ['〈', '〉'], ['〔', '〕'],
  ['(', ')'], ['（', '）'], ['[', ']'], ['【', '】'], ['{', '}'],
  ['<', '>'], ['‹', '›'], ['«', '»'],
]))

/** Zero-width characters that would otherwise create invisible label variants. */
const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g
/** A label must contain at least one letter or digit after normalization. */
const HAS_WORD_CHAR_RE = /[\p{L}\p{N}]/u
/** Unicode letter (CJK ideographs are letters too) — the `X的家` prefix check. */
const LETTER_RE = /\p{L}/u
/** Every spelling of "home" that normalizes to 「家」 for locations. */
const HOME_ALIASES = Object.freeze(new Set(['我家', '我家里', '家里', '在家', '回家', '家']))
/** Location suffix rule: `X的家` → `X家` ("小明的家" → "小明家"). */
const HOME_SUFFIX = '的家'
/** Query-string splitter: Chinese/ASCII comma, semicolon, slash and whitespace. */
const QUERY_SPLIT_RE = /[、，,;；/\s]+/u
/** Default `cfg.recall.tagMentions.maxTagsPerKind`. */
const MAX_TAGS_PER_KIND_DEFAULT = 4
/** A single-character CJK label (e.g. 「家」) can match inside ordinary words. */
const SINGLE_CJK_LABEL_RE = /^\p{Script=Han}$/u
/** Unicode letter/digit test used by the mention word-boundary rule. */
const WORD_CHAR_RE = /[\p{L}\p{N}]/u
/**
 * Prefix characters after which a single-character CJK label is still a
 * mention: pronouns (我家/你家/他家/她家/咱家/俺家) and motion/position verbs
 * (在家/回家/到家/去家/来家/进家/出家).
 */
const MENTION_PREFIX_CHARS = Object.freeze(
  new Set(['我', '你', '他', '她', '咱', '俺', '在', '回', '到', '去', '来', '进', '出']),
)

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function numberOr(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric)) return fallback
  return numeric < min ? min : numeric > max ? max : numeric
}

/** Stable JSON serialization (sorted keys) for the index signatures. */
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
 * Effective tag configuration of one kind (`cfg.<kind>` with contract
 * defaults). Unknown / invalid values fall back to defaults instead of
 * throwing. An unknown `kind` is treated as `location` (same defaults, same
 * configured group).
 *
 * `maxPerFolder` clamps to 1..64 for location/person and 1..32 for event,
 * mirroring engine/config.js validation.
 *
 * @param {object} [cfg] validated (or raw) memory config; may be missing
 * @param {'location'|'person'|'event'} kind
 * @returns {{ mode: 'off'|'index'|'constrain', maxLabelLength: number, maxPerFolder: number }}
 */
export function tagConfig(cfg, kind) {
  const key = TAG_KINDS.includes(kind) ? kind : 'location'
  const group = objectOf(objectOf(cfg)[key])
  const defaults = TAG_DEFAULTS[key]
  return {
    mode: TAG_MODES.includes(group.mode) ? group.mode : defaults.mode,
    maxLabelLength: clampInt(group.maxLabelLength, defaults.maxLabelLength, 1, 200),
    maxPerFolder: clampInt(group.maxPerFolder, defaults.maxPerFolder, 1, key === 'event' ? 32 : 64),
  }
}

/** `cfg.recall.tagMentions.maxTagsPerKind`, clamped and defaulted (4). Mirrors engine/config.js (1..32). */
function maxTagsPerKind(cfg) {
  const recall = objectOf(objectOf(cfg).recall)
  const mentions = objectOf(recall.tagMentions)
  return clampInt(mentions.maxTagsPerKind, MAX_TAGS_PER_KIND_DEFAULT, 1, 32)
}

// ---------------------------------------------------------------------------
// label normalization
// ---------------------------------------------------------------------------

/**
 * Strip wrapping quotes / brackets from both ends, then trim. Only a *matched*
 * pair is stripped, so an inner bracket ("北京（公司）") is preserved and a
 * label can never end up with a dangling open bracket ("北京（公司").
 *
 * @param {string} text
 * @returns {string}
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
      if (WRAPPING_PAIRS.has(chars[0]) && WRAPPING_PAIRS.has(chars[chars.length - 1])) {
        // mismatched wrapping pair at both ends: strip the stray ends anyway
        value = chars.slice(1, -1).join('').trim()
        continue
      }
    }
    break
  }
  return value.trim()
}

/** True when the normalized label is a placeholder ("no tag"). */
function isEmptyLabel(text) {
  return EMPTY_LABELS.has(text) || !HAS_WORD_CHAR_RE.test(text)
}

/**
 * Location-only home normalization, applied after the generic normalization
 * (and after truncation, matching the contract order):
 *
 *   - 我家 / 我家里 / 家里 / 在家 / 回家 / 家 → 家
 *   - `X的家` (X ends with a letter/CJK char) → `X家`
 *       "小明的家" → "小明家", "朋友的家" → "朋友家"
 *   - "XX家" (already canonical) stays as-is; "公司" is not touched.
 *
 * The rule repeats (bounded) so "我的家" → "我家" → "家".
 *
 * @param {string} text normalized label
 * @returns {string}
 */
function applyHomeRule(text) {
  let value = text
  for (let at = 0; at < 4; at += 1) {
    if (!value) return value
    if (HOME_ALIASES.has(value)) return '家'
    if (value.length > HOME_SUFFIX.length && value.endsWith(HOME_SUFFIX)) {
      const prefix = value.slice(0, -HOME_SUFFIX.length).trimEnd()
      const last = [...prefix].pop()
      if (prefix && last && LETTER_RE.test(last)) {
        value = `${prefix}家`
        continue
      }
    }
    break
  }
  return value
}

/**
 * Normalize one submitted tag label.
 *
 * Rules (design contract §3.2): string/number → String, NFKC, zero-width
 * removal, trim, whitespace folding, Latin lowercase, strip wrapping quotes /
 * brackets, placeholder filtering, truncate to `<kind>.maxLabelLength`
 * (counted in code points). Placeholders ("空", "无", "不约束", "无事件",
 * "none", "null", "n/a", "na", "-", "", punctuation-only) normalize to `''`.
 *
 * Locations additionally run `applyHomeRule` (我家/我家里/家里/在家/回家/家 →
 * 家, `X的家` → `X家`); persons and events do not.
 *
 * @param {unknown} raw
 * @param {'location'|'person'|'event'} kind
 * @param {object} [cfg]
 * @returns {string} normalized label, '' = "no tag"
 */
export function normalizeTagLabel(raw, kind, cfg) {
  const effective = tagConfig(cfg, kind)
  let text
  if (typeof raw === 'string') text = raw
  else if (typeof raw === 'number' && Number.isFinite(raw)) text = String(raw)
  else return ''
  text = text.normalize('NFKC')
  text = text.replace(ZERO_WIDTH_RE, '')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.toLowerCase()
  text = stripWrapping(text)
  text = text.replace(/\s+/g, ' ').trim()
  if (isEmptyLabel(text)) return ''
  const chars = [...text]
  if (chars.length > effective.maxLabelLength) text = chars.slice(0, effective.maxLabelLength).join('')
  text = stripWrapping(text).trim()
  if (kind === 'location') text = applyHomeRule(text)
  text = text.trim()
  if (isEmptyLabel(text)) return ''
  return text
}

// ---------------------------------------------------------------------------
// kind tag index (derived from index.folders; never persisted)
// ---------------------------------------------------------------------------

/**
 * Raw label values of one kind on a folder.
 *
 * Events: the v1.5.0 `events` array wins when present, otherwise the legacy
 * single `event` string (old index entries) is used. Locations/persons are
 * plain arrays.
 *
 * @param {object} folder
 * @param {'location'|'person'|'event'} kind
 * @returns {unknown[]}
 */
function tagLabelsOf(folder, kind) {
  if (kind === 'event') {
    if (Array.isArray(folder.events)) return folder.events
    if (typeof folder.event === 'string' || typeof folder.event === 'number') return [folder.event]
    return []
  }
  const values = kind === 'location' ? folder.locations : folder.persons
  return Array.isArray(values) ? values : []
}

/** Deterministic signature of a built tag index (label/count/firstAt/folderCount + effective config). */
function tagSignature(byKind, folderCount, effective) {
  const kinds = {}
  for (const kind of TAG_KINDS) {
    const buckets = []
    for (const bucket of byKind[kind].values()) {
      buckets.push({ key: bucket.key, label: bucket.label, count: bucket.count, firstAt: bucket.firstAt })
    }
    buckets.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    const config = effective[kind]
    kinds[kind] = {
      buckets,
      mode: config.mode,
      maxLabelLength: config.maxLabelLength,
      maxPerFolder: config.maxPerFolder,
    }
  }
  return `tag1|${stableSerialize({ folderCount, kinds })}`
}

/**
 * Build the in-memory location/person/event tag index from `index.folders`.
 *
 * Participating folders need a string `id` and must be recallable: folders with
 * `scored === false` (archived but not scored / still pending) never take part
 * in recall, so their tags must not create recall-time filters either — they
 * are skipped exactly like `buildRecallIndex` does. A duplicate id keeps the
 * first copy (index.folders is already de-duplicated by the store — this is a
 * defensive rule for hand-built inputs). `folderCount` counts the participating
 * (recallable) folders, including folders without tags. Folders without any
 * valid tag appear in `byId` only if they have at least one tag; every tag of a
 * folder is de-duplicated after normalization (a folder tagged "北京" twice
 * counts once).
 *
 * Bucket shape: `{ label, key, ids, count, firstAt }` where `key` is the
 * normalized label (case/space/wrapping variants collapse into one bucket),
 * `label` is the canonical label of the bucket (identical to `key` after
 * normalization, kept separate for future canonicalization), `count` is the
 * number of tagged folders and `firstAt` the earliest `createdAt` (0 when
 * missing), mirroring event-index.js conventions.
 *
 * @param {Array<{id?: string, createdAt?: number, locations?: string[], persons?: string[], events?: string[], event?: string}>} folders
 * @param {object} [cfg]
 * @returns {{
 *   byKind: {
 *     location: Map<string, {label: string, key: string, ids: string[], count: number, firstAt: number}>,
 *     person: Map<string, {label: string, key: string, ids: string[], count: number, firstAt: number}>,
 *     event: Map<string, {label: string, key: string, ids: string[], count: number, firstAt: number}>,
 *   },
 *   byId: Map<string, {location: string[], person: string[], event: string[]}>,
 *   folderCount: number,
 *   signature: string,
 * }}
 */
export function buildTagIndex(folders, cfg) {
  const list = Array.isArray(folders) ? folders : []
  const byKind = { location: new Map(), person: new Map(), event: new Map() }
  const byId = new Map()
  const effective = {
    location: tagConfig(cfg, 'location'),
    person: tagConfig(cfg, 'person'),
    event: tagConfig(cfg, 'event'),
  }
  const seenIds = new Set()
  let folderCount = 0
  for (const folder of list) {
    if (!folder || typeof folder !== 'object' || Array.isArray(folder)) continue
    // F-02-07: unscored/pending folders are not recallable; their tags must not
    // hard-filter recall (same skip as buildRecallIndex).
    if (folder.scored === false) continue
    const id = typeof folder.id === 'string' ? folder.id : ''
    if (!id || seenIds.has(id)) continue
    seenIds.add(id)
    folderCount += 1
    const createdAt = numberOr(folder.createdAt, 0)
    const entry = { location: [], person: [], event: [] }
    let tagged = false
    for (const kind of TAG_KINDS) {
      const seenLabels = new Set()
      for (const raw of tagLabelsOf(folder, kind)) {
        const label = normalizeTagLabel(raw, kind, cfg)
        if (!label || seenLabels.has(label)) continue
        seenLabels.add(label)
        entry[kind].push(label)
        tagged = true
        let bucket = byKind[kind].get(label)
        if (!bucket) {
          bucket = { label, key: label, ids: [], count: 0, firstAt: 0 }
          byKind[kind].set(label, bucket)
        }
        bucket.ids.push(id)
        bucket.count += 1
        if (bucket.count === 1 || createdAt < bucket.firstAt) bucket.firstAt = createdAt
      }
    }
    if (tagged) byId.set(id, entry)
  }
  return { byKind, byId, folderCount, signature: tagSignature(byKind, folderCount, effective) }
}

// ---------------------------------------------------------------------------
// recall-time tag query (same kind OR, cross kind AND)
// ---------------------------------------------------------------------------

/**
 * Normalize a recall tag query.
 *
 * Each kind accepts a string or a string[]:
 *   - a string is split on 、 ， , ; ； / and whitespace;
 *   - array items are individual labels (so a label may keep an inner space,
 *     e.g. "New York");
 *   - every label runs through `normalizeTagLabel`, empty/placeholder labels
 *     are dropped and duplicates removed (order preserved).
 *
 * A missing/invalid query (null, array, string, …) returns three empty arrays.
 *
 * @param {unknown} query
 * @param {object} [cfg]
 * @returns {{ location: string[], person: string[], event: string[] }}
 */
export function normalizeTagQuery(query, cfg) {
  const result = { location: [], person: [], event: [] }
  if (!query || typeof query !== 'object' || Array.isArray(query)) return result
  for (const kind of TAG_KINDS) {
    const value = query[kind]
    const labels = []
    const seen = new Set()
    const push = (raw) => {
      const label = normalizeTagLabel(raw, kind, cfg)
      if (!label || seen.has(label)) return
      seen.add(label)
      labels.push(label)
    }
    if (typeof value === 'string') {
      for (const part of value.split(QUERY_SPLIT_RE)) push(part)
    } else if (typeof value === 'number') {
      push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) push(item)
    }
    result[kind] = labels
  }
  return result
}

/**
 * Resolve a tag query against a built tag index (contract §3.2).
 *
 * Per kind: `constrain` enforces a hard filter (same-kind labels are ORed into
 * one id set), `index` merely reports matches and never constrains, `off`
 * ignores the kind and adds a warning. The enforcing kinds are then ANDed
 * (set intersection) into `ids`.
 *
 * Status:
 *  - `empty`    — nothing requested: ids = null;
 *  - `disabled` — no enforcing kind (all `off`, or `index`-only with no known
 *                 label): ids = null;
 *  - `exact`    — every requested label exists (index-only requests report the
 *                 known labels without constraining): ids = null when no kind
 *                 enforces, otherwise the intersection;
 *  - `partial`  — some labels are unknown, others resolve;
 *  - `unknown`  — an enforcing kind is entirely unknown ⇒ its id set is empty
 *                 and so is the intersection.
 *
 * `matched` lists only existing labels using the index's canonical label and
 * bucket count; `unknown` lists missing `{kind, label}` pairs.
 *
 * @param {object|null} tagIndex `buildTagIndex()` result (invalid → empty index)
 * @param {{location?: string|string[], person?: string|string[], event?: string|string[]}} query
 * @param {object} [cfg]
 * @returns {{
 *   status: 'empty'|'exact'|'partial'|'unknown'|'disabled',
 *   requested: {location: string[], person: string[], event: string[]},
 *   matched: {location: Array<{label: string, count: number}>, person: Array<{label: string, count: number}>, event: Array<{label: string, count: number}>},
 *   unknown: Array<{kind: 'location'|'person'|'event', label: string}>,
 *   ids: Set<string>|null,
 *   warnings: string[],
 * }}
 */
export function resolveTagQuery(tagIndex, query, cfg) {
  const requested = normalizeTagQuery(query, cfg)
  const matched = { location: [], person: [], event: [] }
  const unknown = []
  const warnings = []
  if (!TAG_KINDS.some((kind) => requested[kind].length > 0)) {
    return { status: 'empty', requested, matched, unknown, ids: null, warnings }
  }
  const byKind = tagIndex && typeof tagIndex === 'object' ? objectOf(tagIndex.byKind) : {}
  /** @type {Set<string>[]} id set of every enforcing kind (OR within kind) */
  const enforced = []
  let anyMatch = false
  let anyUnknown = false
  let anyEnforcedKindAllUnknown = false
  for (const kind of TAG_KINDS) {
    const labels = requested[kind]
    if (!labels.length) continue
    const effective = tagConfig(cfg, kind)
    if (effective.mode === 'off') {
      warnings.push(`${kind}: ${kind}.mode is off; ${kind} arguments are ignored`)
      continue
    }
    const map = byKind[kind] instanceof Map ? byKind[kind] : new Map()
    const kindMatched = []
    const seen = new Set()
    let matchedCount = 0
    for (const label of labels) {
      const bucket = map.get(label)
      if (!bucket) {
        unknown.push({ kind, label })
        anyUnknown = true
        continue
      }
      matchedCount += 1
      anyMatch = true
      const ids = Array.isArray(bucket.ids) ? bucket.ids : []
      const count = Number.isFinite(bucket.count) ? bucket.count : ids.length
      if (!seen.has(label)) {
        seen.add(label)
        kindMatched.push({
          label: typeof bucket.label === 'string' && bucket.label ? bucket.label : label,
          count,
          ids,
        })
      }
    }
    matched[kind] = kindMatched.map((item) => ({ label: item.label, count: item.count }))
    if (effective.mode === 'constrain') {
      if (matchedCount === 0) anyEnforcedKindAllUnknown = true
      const classIds = new Set()
      for (const item of kindMatched) for (const id of item.ids) classIds.add(id)
      enforced.push(classIds)
    }
  }
  for (const item of unknown) warnings.push(`${item.kind}: no memory has tag ${JSON.stringify(item.label)}`)
  let ids = null
  if (enforced.length) {
    const intersection = new Set(enforced[0])
    for (let at = 1; at < enforced.length; at += 1) {
      const next = enforced[at]
      for (const id of [...intersection]) if (!next.has(id)) intersection.delete(id)
      if (!intersection.size) break
    }
    ids = intersection
  }
  let status
  if (enforced.length) {
    if (anyEnforcedKindAllUnknown) status = 'unknown'
    else if (anyUnknown) status = 'partial'
    else status = 'exact'
  } else {
    // No enforcing kind: index-only (or off) requests never constrain; the
    // status only says whether the requested labels are known.
    status = anyMatch ? 'exact' : 'disabled'
  }
  return { status, requested, matched, unknown, ids, warnings }
}

// ---------------------------------------------------------------------------
// mention detection (keyword-triggered tag filters)
// ---------------------------------------------------------------------------

/** NFKC + lowercase + whitespace folding for the mention haystack. */
function normalizeMentionText(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')
}

/** Long labels first, then kind order, then label — deterministic tie-break. */
function compareMentionEntries(left, right) {
  if (left.length !== right.length) return right.length - left.length
  const kindOrder = TAG_KINDS.indexOf(left.kind) - TAG_KINDS.indexOf(right.kind)
  if (kindOrder !== 0) return kindOrder
  return left.label < right.label ? -1 : left.label > right.label ? 1 : 0
}

/** Hits in text order, then kind order, then label. */
function compareMentionHits(left, right) {
  if (left.index !== right.index) return left.index - right.index
  const kindOrder = TAG_KINDS.indexOf(left.kind) - TAG_KINDS.indexOf(right.kind)
  if (kindOrder !== 0) return kindOrder
  return left.label < right.label ? -1 : left.label > right.label ? 1 : 0
}

/** Whether `label` is a single code point of the Han script (e.g. 「家」). */
function isSingleCharCjkLabel(label) {
  return label.length > 0 && [...label].length === 1 && SINGLE_CJK_LABEL_RE.test(label)
}

/** Previous code point of `text` ending right before `index` ('' at the start). */
function previousCodePoint(text, index) {
  if (index <= 0) return ''
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index)
  }
  return text.charAt(index - 1)
}

/**
 * Context gate for a single-character CJK label mention (F-02-03). Accepted
 * when the match starts the text, when the previous code point is a non-word
 * character (a word boundary), or when it is one of the documented prefixes
 * (我家 / 在家 / 回家 …). Every other occurrence — 大家/国家/专家/人家 — is not
 * a mention, and the caller keeps looking for a later valid occurrence.
 *
 * @param {string} haystack normalized mention text
 * @param {number} index code-unit offset of the match inside `haystack`
 * @returns {boolean}
 */
function mentionContextAllowed(haystack, index) {
  if (index <= 0) return true
  const previous = previousCodePoint(haystack, index)
  if (!previous) return true
  if (MENTION_PREFIX_CHARS.has(previous)) return true
  return !WORD_CHAR_RE.test(previous)
}

/**
 * First occurrence of `needle` whose character range is not claimed yet and
 * whose context is accepted. Invalid occurrences (rejected by `accept`) are
 * skipped by advancing one code unit, so a later valid occurrence still wins.
 *
 * @param {string} haystack normalized mention text
 * @param {string} needle label to search
 * @param {Array<{start: number, end: number}>} claims already claimed spans
 * @param {((haystack: string, index: number) => boolean)|undefined} [accept]
 * @returns {number} code-unit offset or -1
 */
function findFreeOccurrence(haystack, needle, claims, accept) {
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return -1
    const end = at + needle.length
    let overlaps = false
    for (const claim of claims) {
      if (at < claim.end && claim.start < end) {
        overlaps = true
        break
      }
    }
    if (!overlaps && (!accept || accept(haystack, at))) return at
    from = at + 1
  }
}

/**
 * Detect known tag labels occurring in a user message (automatic recall's
 * keyword-triggered filter). The text is NFKC-normalized, lowercased and
 * whitespace-folded first; every known label is then searched as a substring.
 *
 * Same text span: **longer labels win** ("小明家" claims the span, so the
 * shorter location "小明" — or a person named 小明 — is not counted again for
 * that span), which prevents double counting variants such as 「小明」 vs
 * 「小明家」. Per kind at most `cfg.recall.tagMentions.maxTagsPerKind` labels
 * (default 4) are reported; results are sorted by occurrence position.
 *
 * A **single-character CJK label** must additionally pass the word-context
 * rule (F-02-03): the match starts the text, follows a non-letter/non-digit
 * character, or follows a pronoun (我/你/他/她/咱/俺 → 我家) or motion/position
 * prefix (在/回/到/去/来/进/出 → 在家/回家). Thus 「大家好」 does not mention
 * 「家」 while 「我家/我家里/家里/在家/回家」 do. Invalid occurrences are skipped
 * so a later valid occurrence of the same label still counts. Labels of two or
 * more code points keep the plain substring rule.
 *
 * `index` in a hit is the code-unit offset inside the normalized haystack.
 * Labels are returned in their canonical (index) form. Whether this channel is
 * enabled and how the mentions become filters is decided by the caller.
 *
 * @param {object|null} tagIndex `buildTagIndex()` result
 * @param {string} text user message
 * @param {object} [cfg]
 * @returns {{
 *   location: string[], person: string[], event: string[],
 *   hits: Array<{kind: 'location'|'person'|'event', label: string, index: number}>,
 * }}
 */
export function detectTagMentions(tagIndex, text, cfg) {
  const result = { location: [], person: [], event: [], hits: [] }
  if (typeof text !== 'string' || !text) return result
  const byKind = tagIndex && typeof tagIndex === 'object' ? objectOf(tagIndex.byKind) : {}
  const entries = []
  for (const kind of TAG_KINDS) {
    const map = byKind[kind]
    if (!(map instanceof Map)) continue
    for (const bucket of map.values()) {
      const label = bucket && typeof bucket.label === 'string' ? bucket.label : bucket && typeof bucket.key === 'string' ? bucket.key : ''
      if (!label) continue
      entries.push({ kind, label, length: [...label].length, singleCharCjk: isSingleCharCjkLabel(label) })
    }
  }
  if (!entries.length) return result
  const haystack = normalizeMentionText(text)
  if (!haystack) return result
  entries.sort(compareMentionEntries)
  const limit = maxTagsPerKind(cfg)
  const counts = { location: 0, person: 0, event: 0 }
  const claims = []
  const accepted = []
  for (const entry of entries) {
    if (counts[entry.kind] >= limit) continue
    // Single-character CJK labels only count when their context allows it; the
    // search keeps going so a later valid occurrence still wins.
    const accept = entry.singleCharCjk ? mentionContextAllowed : undefined
    const at = findFreeOccurrence(haystack, entry.label, claims, accept)
    if (at < 0) continue
    claims.push({ start: at, end: at + entry.label.length })
    counts[entry.kind] += 1
    accepted.push({ kind: entry.kind, label: entry.label, index: at })
  }
  accepted.sort(compareMentionHits)
  for (const hit of accepted) result[hit.kind].push(hit.label)
  result.hits = accepted.map((hit) => ({ kind: hit.kind, label: hit.label, index: hit.index }))
  return result
}

// ---------------------------------------------------------------------------
// time-tag index (derived from folder.timeTags; never persisted)
// ---------------------------------------------------------------------------

/** Validate/coerce one `folder.timeTags[]` entry; null = invalid. */
function normalizeTimeTag(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const from = Number(item.from)
  const to = Number(item.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
  return {
    from,
    to,
    label: typeof item.label === 'string' ? item.label : '',
    granularity: TIME_GRANULARITIES.includes(item.granularity) ? item.granularity : 'day',
  }
}

/** Stable de-duplication key of one valid time tag. */
function timeTagKey(tag) {
  return JSON.stringify([tag.from, tag.to, tag.label, tag.granularity])
}

/** Deterministic order: from asc, to asc, label asc, granularity asc. */
function compareTimeTags(left, right) {
  if (left.from !== right.from) return left.from - right.from
  if (left.to !== right.to) return left.to - right.to
  if (left.label !== right.label) return left.label < right.label ? -1 : 1
  return left.granularity < right.granularity ? -1 : left.granularity > right.granularity ? 1 : 0
}

/**
 * Build the in-memory time-tag index from `folder.timeTags`.
 *
 * Only half-open `[from, to)` epoch-ms intervals with finite endpoints and
 * `to > from` participate; `label` must be a string (default '') and
 * `granularity` must be one of day/week/month/year (default 'day'). Identical
 * tags on one folder are de-duplicated; tags are sorted by `from`. Folders with
 * `scored === false` (pending/unscored memories, never recallable) are skipped
 * entirely (F-02-07), matching `buildTagIndex`/`buildRecallIndex`. Folders
 * without a valid tag are not in `byId`/`taggedIds` but still count in
 * `folderCount` (they take part in "has time tags?" decisions as untagged).
 *
 * @param {Array<{id?: string, timeTags?: Array<{from?: number, to?: number, label?: string, granularity?: string}>}>} folders
 * @param {object} [cfg]
 * @returns {{
 *   byId: Map<string, Array<{from: number, to: number, label: string, granularity: 'day'|'week'|'month'|'year'}>>,
 *   taggedIds: Set<string>,
 *   folderCount: number,
 *   signature: string,
 * }}
 */
export function buildTimeTagIndex(folders, cfg) {
  const list = Array.isArray(folders) ? folders : []
  const byId = new Map()
  const taggedIds = new Set()
  const seenIds = new Set()
  let folderCount = 0
  for (const folder of list) {
    if (!folder || typeof folder !== 'object' || Array.isArray(folder)) continue
    // F-02-07: unscored/pending folders are not recallable; their time tags must
    // not create a time-tag filter either (same skip as buildRecallIndex).
    if (folder.scored === false) continue
    const id = typeof folder.id === 'string' ? folder.id : ''
    if (!id || seenIds.has(id)) continue
    seenIds.add(id)
    folderCount += 1
    const rawTags = Array.isArray(folder.timeTags) ? folder.timeTags : []
    const tags = []
    const seenTags = new Set()
    for (const item of rawTags) {
      const tag = normalizeTimeTag(item)
      if (!tag) continue
      const key = timeTagKey(tag)
      if (seenTags.has(key)) continue
      seenTags.add(key)
      tags.push(tag)
    }
    if (!tags.length) continue
    tags.sort(compareTimeTags)
    byId.set(id, tags)
    taggedIds.add(id)
  }
  const serializedFolders = []
  for (const id of [...byId.keys()].sort()) {
    serializedFolders.push({
      id,
      tags: byId.get(id).map((tag) => ({ from: tag.from, to: tag.to, label: tag.label, granularity: tag.granularity })),
    })
  }
  const signature = `timeTag1|${stableSerialize({ folderCount, folders: serializedFolders })}`
  return { byId, taggedIds, folderCount, signature }
}

/**
 * Folders whose time tags overlap any query window.
 *
 * A query window is `{from, to}` with finite endpoints and `to > from`
 * (half-open, same representation as the tags); overlapping means
 * `tag.from < window.to && window.from < tag.to`, so adjacent intervals
 * (`[100,200)` vs window `[200,250)`) do NOT match. Any tag × any window hit
 * includes the folder. With no valid window or no index the result is an empty
 * id set (never throws); invalid windows are reported in `warnings`.
 *
 * `matched` is the number of matched folders (= `ids.size`).
 *
 * @param {object|null} timeTagIndex `buildTimeTagIndex()` result
 * @param {Array<{from?: number, to?: number}>} windows
 * @param {object} [cfg]
 * @returns {{ ids: Set<string>, matched: number, warnings: string[] }}
 */
export function resolveTimeTagIds(timeTagIndex, windows, cfg) {
  const ids = new Set()
  const warnings = []
  const validWindows = []
  let invalid = 0
  if (Array.isArray(windows)) {
    for (const window of windows) {
      if (!window || typeof window !== 'object' || Array.isArray(window)) {
        invalid += 1
        continue
      }
      const from = Number(window.from)
      const to = Number(window.to)
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        invalid += 1
        continue
      }
      validWindows.push({ from, to })
    }
  } else if (windows !== undefined && windows !== null) {
    invalid += 1
  }
  if (invalid) {
    warnings.push(
      validWindows.length
        ? `time-tag: ignored ${invalid} invalid time window(s)`
        : 'time-tag: no valid time window; time tags are not applied',
    )
  }
  const byId = timeTagIndex && typeof timeTagIndex === 'object' && timeTagIndex.byId instanceof Map ? timeTagIndex.byId : null
  if (!validWindows.length || !byId) return { ids, matched: 0, warnings }
  for (const [id, tags] of byId) {
    const list = Array.isArray(tags) ? tags : []
    let hit = false
    for (const tag of list) {
      if (!tag || typeof tag !== 'object') continue
      const from = Number(tag.from)
      const to = Number(tag.to)
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue
      for (const window of validWindows) {
        if (from < window.to && window.from < to) {
          hit = true
          break
        }
      }
      if (hit) break
    }
    if (hit) ids.add(id)
  }
  return { ids, matched: ids.size, warnings }
}
