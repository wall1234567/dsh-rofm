/**
 * dsh-rofm engine — FAIR-DRI deterministic recall index and selector.
 *
 * Ported from the DRI reference implementation and the FAIR-DRI fairness
 * simulation (both kept outside this repository as design artifacts).
 * The model and the proofs are in DESIGN.md / proof.md; the product spec is
 * docs/SPEC.md §6.
 *
 * Global priority σ (query independent):
 *
 *   σ(m) = ( alpha desc, createdAt asc, id asc )
 *
 * Every per-keyword posting list is kept sorted by σ, so a keyword query is a
 * k-way merge over the matched posting lists: the first k not-excluded entries
 * are the deterministic top-k. Selection is fully deterministic — this module
 * never calls `Math.random()` and never lets `Date.now()` influence which
 * memories are picked (`Date.now()` only stamps `index.builtAt` for cache
 * bookkeeping).
 *
 * FAIR-DRI lanes, strictly in this order (plan §3.2.3):
 *
 *   1) rareHigh   — high α memories matched by a *rare* query term surface now
 *   2) queryBoost — high α memories evicted from the block earlier and matched again
 *   3) register   — high α memories deferred last round, 2-round TTL
 *   4) σ hi lane  — remaining high α candidates merged in σ order; lookahead
 *                   overflow goes to the register (capacity = capFactor·k_H)
 *   5) lowProbe   — one slot for an explicitly referenced low α memory
 *   6) rotation   — deterministic low α round-robin over the global explore order
 *   7) recycle    — block-evicted memories return after a cooldown
 *
 * The block trim is NOT done here (callers use `trimBlock`), so this module
 * stays a pure selector over `index` + `lanes`.
 *
 * Zero dependencies: only the engine's own tokenizer is imported (`./tokenize.js`),
 * which reuses the production normalize/tokenize/keyword-matching truth.
 */

import { extractKeywords, normalizeText, tokenize } from './tokenize.js'
// B-02 (1.4.1): direction-2 matches are *generated* from the reverse token index
// below and then verified with the authoritative bidirectional predicate, so the
// product path and `engine/keyword-match.js` can never disagree.
import { matchKeywords } from './keyword-match.js'

// ---------------------------------------------------------------------------
// constants / local defaults
// ---------------------------------------------------------------------------

/** Any CJK code point (BMP blocks + supplementary ideographs). */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u
/** ASCII word characters used by the "Latin keyword needs boundaries" rule. */
const ASCII_WORD_CHAR_RE = /[a-z0-9_]/

/**
 * Local fallbacks for `cfg.recall.fairness`. They mirror engine/config.js
 * DEFAULT_CONFIG exactly (contract §4); keeping local copies lets this module
 * be unit-tested and used without a validated config object.
 */
const DEFAULT_FAIR = Object.freeze({
  thetaHigh: 0.6,
  exploreRatio: 0.2,
  specificProbeSlots: 1,
  rareTerm: Object.freeze({ ratio: 0.002, minPosting: 8, scanCap: 512 }),
  register: Object.freeze({ lookahead: 3, capFactor: 8, ttlRounds: 2 }),
  queryBoost: true,
  recycle: Object.freeze({ enabled: true, cooldownRounds: 15, maxPerRound: 1 }),
})

/**
 * Plan A (v1.4.1 addendum) local defaults for `cfg.recall.categoryMatch`.
 * Mirrors engine/config.js DEFAULT_CONFIG exactly; the module stays usable
 * without a validated config object.
 */
const DEFAULT_CATEGORY_MATCH = Object.freeze({
  enabled: true,
  alphaMin: 0.6,
  classes: Object.freeze({
    preference: Object.freeze({ label: '喜好', words: Object.freeze(['喜好', '偏好', '喜欢', '爱好', '口味', '讨厌', '厌恶', '习惯', '爱吃', '爱喝', '不喜欢']) }),
    agreement: Object.freeze({ label: '约定', words: Object.freeze(['约定', '说好', '承诺', '以后都', '统一', '采用']) }),
    decision: Object.freeze({ label: '决定', words: Object.freeze(['决定', '确定', '结论', '方案']) }),
    rule: Object.freeze({ label: '规则', words: Object.freeze(['规则', '规范', '规定', '禁止', '必须']) }),
    requirement: Object.freeze({ label: '要求', words: Object.freeze(['要求', '需求', '参数', '配置']) }),
    taboo: Object.freeze({ label: '禁忌', words: Object.freeze(['禁忌', '忌讳']) }),
  }),
})

/** Synthetic posting/seed prefix for the category layer (never user-visible). */
const CATEGORY_SEED_PREFIX = '\u0002cat:'

/** Whether a seed is a synthetic category seed. */
function isCategorySeed(seed) {
  return typeof seed === 'string' && seed.startsWith(CATEGORY_SEED_PREFIX)
}

/** Synthetic seed for one category class key. */
function categorySeed(key) {
  return CATEGORY_SEED_PREFIX + String(key)
}

/** Normalized `recall.categoryMatch` snapshot used by build/query. */
function categoryConfigOf(cfg) {
  const raw = cfg && cfg.recall && cfg.recall.categoryMatch
  const source = raw && typeof raw === 'object' ? raw : DEFAULT_CATEGORY_MATCH
  const alphaMin = clampAlpha(numberOr(source.alphaMin, DEFAULT_CATEGORY_MATCH.alphaMin))
  const classesSource = source.classes && typeof source.classes === 'object' ? source.classes : DEFAULT_CATEGORY_MATCH.classes
  const classes = []
  for (const key of Object.keys(classesSource).sort()) {
    const def = classesSource[key]
    const rawWords = Array.isArray(def) ? def : def && typeof def === 'object' && Array.isArray(def.words) ? def.words : []
    const words = []
    for (const word of rawWords) {
      if (typeof word !== 'string') continue
      const normalized = normalizeText(word).trim()
      if (normalized.length < 2 || words.includes(normalized)) continue
      words.push(normalized)
    }
    if (words.length === 0) continue
    const label = def && typeof def === 'object' && typeof def.label === 'string' && def.label.trim().length > 0 ? def.label.trim() : key
    classes.push({ key: String(key), label, words })
  }
  return { enabled: source.enabled !== false && classes.length > 0, alphaMin, classes }
}

/** Category class keys whose word list occurs in one folder's keywords/title. */
function classesForEntry(entry, category) {
  const sources = []
  for (const keyword of entry.keywords) sources.push(keyword)
  const title = entry.folder && typeof entry.folder.title === 'string' ? normalizeText(entry.folder.title) : ''
  if (title) sources.push(title)
  if (sources.length === 0) return []
  const hits = []
  for (const cls of category.classes) {
    for (const word of cls.words) {
      if (word.length < 2) continue
      let found = false
      for (const source of sources) {
        if (source.includes(word)) {
          found = true
          break
        }
      }
      if (found) {
        hits.push(cls.key)
        break
      }
    }
  }
  return hits
}

/** Default per-round quota k (= cfg.recall.firstGenMax). */
const DEFAULT_K = 10
/** Hard safety cap for k / counts coming from configuration. */
const MAX_K = 4096
/**
 * B-01 (1.4.1) pagination window cap: `engine.recall(..., {paginate:true})`
 * selects a stable candidate window of `min(candidates, PAGINATE_MAX_K)` and
 * slices pages out of it, independent of `offset`/`limit`.
 */
export const PAGINATE_MAX_K = 10000
/** Hard safety cap for the rare-term seed scan (contract §5.1: scanCap). */
const MAX_SCAN_CAP = 4096
/** Absolute pop ceiling for one k-way merge (defensive; a merge always ends). */
const MAX_MERGE_POPS = 200000

// ---------------------------------------------------------------------------
// tiny coercion helpers
// ---------------------------------------------------------------------------

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function numberOr(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function integerOr(value, fallback) {
  const numeric = Number(value)
  return Number.isInteger(numeric) ? numeric : fallback
}

function clampNumber(value, min, max) {
  const numeric = numberOr(value, min)
  return numeric < min ? min : numeric > max ? max : numeric
}

function clampAlpha(value) {
  return clampNumber(value, 0, 1)
}

function clampInt(value, fallback, min, max) {
  const numeric = integerOr(value, fallback)
  return numeric < min ? min : numeric > max ? max : numeric
}

/** Normalized folder keyword (the unique truth for seeds/postings). */
function normalizeKeyword(value) {
  if (typeof value !== 'string') return ''
  return normalizeText(value).trim()
}

/**
 * Normalize an optional id collection (Set / array / any iterable) to a Set of
 * non-empty strings. Anything unreadable is ignored instead of throwing.
 *
 * @param {unknown} value
 * @returns {Set<string>}
 */
function toIdSet(value) {
  const set = new Set()
  if (value === null || value === undefined) return set
  if (typeof value === 'string') {
    if (value) set.add(value)
    return set
  }
  try {
    if (typeof value[Symbol.iterator] === 'function') {
      for (const id of value) if (typeof id === 'string' && id) set.add(id)
    }
  } catch {
    /* unreadable collection: no ids */
  }
  return set
}

/** Normalize an optional id filter (`timeIds` / `eventIds`): null = no constraint. */
function toIdFilter(value) {
  if (value === null || value === undefined) return null
  return toIdSet(value)
}

/** Validate an id-ish value for σ ordering (never throws). */
function idText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/** True when `value` looks like a folder id (non-empty string). */
function isValidId(value) {
  return typeof value === 'string' && value.length > 0
}

// ---------------------------------------------------------------------------
// config accessors (never throw on partial/absent cfg)
// ---------------------------------------------------------------------------

/** @returns {{ recall: object, fair: object }} */
function recallAndFair(cfg) {
  const recall = objectOf(objectOf(cfg).recall)
  return { recall, fair: objectOf(recall.fairness) }
}

function fairConfig(fair) {
  const rareTerm = objectOf(fair.rareTerm)
  const register = objectOf(fair.register)
  const recycle = objectOf(fair.recycle)
  return {
    thetaHigh: clampNumber(numberOr(fair.thetaHigh, DEFAULT_FAIR.thetaHigh), 0, 1),
    exploreRatio: clampNumber(numberOr(fair.exploreRatio, DEFAULT_FAIR.exploreRatio), 0, 1),
    specificProbeSlots: clampInt(fair.specificProbeSlots, DEFAULT_FAIR.specificProbeSlots, 0, 64),
    rareRatio: numberOr(rareTerm.ratio, DEFAULT_FAIR.rareTerm.ratio),
    rareMinPosting: Math.max(1, integerOr(rareTerm.minPosting, DEFAULT_FAIR.rareTerm.minPosting)),
    rareScanCap: clampInt(rareTerm.scanCap, DEFAULT_FAIR.rareTerm.scanCap, 1, MAX_SCAN_CAP),
    lookahead: Math.max(1, integerOr(register.lookahead, DEFAULT_FAIR.register.lookahead)),
    capFactor: Math.max(1, integerOr(register.capFactor, DEFAULT_FAIR.register.capFactor)),
    ttlRounds: Math.max(0, integerOr(register.ttlRounds, DEFAULT_FAIR.register.ttlRounds)),
    queryBoost: fair.queryBoost !== false,
    recycleEnabled: recycle.enabled !== false,
    cooldownRounds: Math.max(0, integerOr(recycle.cooldownRounds, DEFAULT_FAIR.recycle.cooldownRounds)),
    recycleMaxPerRound: Math.max(0, integerOr(recycle.maxPerRound, DEFAULT_FAIR.recycle.maxPerRound)),
  }
}

/** Read `cfg.keywords.matchMode` ('contains' default). */
function matchModeOf(cfg) {
  const keywords = objectOf(objectOf(cfg).keywords)
  return keywords.matchMode === 'exact' ? 'exact' : 'contains'
}

/** Resolve the per-round quota k (0 disables recall). */
function resolveK(explicit, configured) {
  if (explicit !== undefined && explicit !== null) {
    const numeric = Number(explicit)
    if (!Number.isFinite(numeric)) return DEFAULT_K
    return Math.max(0, Math.min(MAX_K, Math.floor(numeric)))
  }
  const numeric = Number(configured)
  if (!Number.isFinite(numeric)) return DEFAULT_K
  return Math.max(0, Math.min(MAX_K, Math.floor(numeric)))
}

/**
 * r = low-α rotation rate = max(1, min(k−1, round(k·exploreRatio))) for k>1.
 * k=1 has no room for rotation (r=0) so the single slot stays with the high
 * lane, which is what guarantees G1 for the smallest quota.
 */
function rotationRate(k, exploreRatio) {
  if (k <= 1) return 0
  const r = Math.round(k * exploreRatio)
  return Math.max(1, Math.min(k - 1, r))
}

// ---------------------------------------------------------------------------
// stable serialization / config fingerprint
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON-like serialization with sorted object keys. Used for
 * `lanesFingerprint` / `buildRecallIndex(...).signature` so a config change is
 * detected even though JS object key order is not part of the contract.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableSerialize(value) {
  if (value === null || value === undefined) return 'null'
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'string') return JSON.stringify(value)
  if (type === 'function' || type === 'symbol' || type === 'bigint') return 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
}

/**
 * Config fingerprint used to decide whether persisted lane cursors are still
 * valid (`recall-state.json` v3 `configFingerprint`). Only the knobs that
 * change selection semantics are included, so unrelated config edits (time,
 * compress, ...) do not reset the lanes.
 *
 * @param {object} [cfg]
 * @returns {string}
 */
export function lanesFingerprint(cfg) {
  const { recall, fair } = recallAndFair(cfg)
  const effective = fairConfig(fair)
  const payload = {
    version: 1,
    mode: typeof recall.mode === 'string' ? recall.mode : 'fair',
    firstGenMax: resolveK(undefined, recall.firstGenMax),
    hops: Math.max(0, integerOr(recall.hops, 0)),
    fairness: {
      thetaHigh: effective.thetaHigh,
      exploreRatio: effective.exploreRatio,
      specificProbeSlots: effective.specificProbeSlots,
      rareTerm: { ratio: effective.rareRatio, minPosting: effective.rareMinPosting, scanCap: effective.rareScanCap },
      register: { lookahead: effective.lookahead, capFactor: effective.capFactor, ttlRounds: effective.ttlRounds },
      queryBoost: effective.queryBoost,
      recycle: {
        enabled: effective.recycleEnabled,
        cooldownRounds: effective.cooldownRounds,
        maxPerRound: effective.recycleMaxPerRound,
      },
    },
    matchMode: matchModeOf(cfg),
    // Plan A: the category lexicon changes the candidate set, so changing it
    // must invalidate the recall-index cache and the persisted lane cursors.
    categoryMatch: (() => {
      const category = categoryConfigOf(cfg)
      if (!category.enabled) return { enabled: false }
      return {
        enabled: true,
        alphaMin: category.alphaMin,
        classes: category.classes.map((cls) => ({ key: cls.key, words: cls.words })),
      }
    })(),
  }
  return `cfg1|${stableSerialize(payload)}`
}

// ---------------------------------------------------------------------------
// σ ordering
// ---------------------------------------------------------------------------

function idCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * σ comparator: (alpha desc, createdAt asc, id asc). Returns a negative number
 * when `a` has the higher (better) priority.
 *
 * @param {{alpha?: number, createdAt?: number, id?: string}} a
 * @param {{alpha?: number, createdAt?: number, id?: string}} b
 * @returns {number}
 */
export function comparePriority(a, b) {
  const alphaA = clampAlpha(numberOr(a && a.alpha, 0))
  const alphaB = clampAlpha(numberOr(b && b.alpha, 0))
  if (alphaA !== alphaB) return alphaB - alphaA
  const createdA = numberOr(a && a.createdAt, 0)
  const createdB = numberOr(b && b.createdAt, 0)
  if (createdA !== createdB) return createdA - createdB
  return idCompare(idText(a && a.id), idText(b && b.id))
}

/**
 * Explore comparator: the exact global reverse of σ
 * (alpha asc, createdAt desc, id desc). The rotation lane walks candidates in
 * this order so low α (easily starved) memories are covered first.
 */
function compareExplore(a, b) {
  return comparePriority(b, a)
}

// ---------------------------------------------------------------------------
// Aho-Corasick automaton over normalized folder keywords (contains mode)
//
// Patterns match as substrings (CJK) or with ASCII word boundaries on both
// ends (Latin), mirroring engine/tokenize.js `keywordMatches()` byte for byte.
// ---------------------------------------------------------------------------

function isAsciiWordChar(char) {
  return typeof char === 'string' && char.length === 1 && ASCII_WORD_CHAR_RE.test(char)
}

function patternHasCjk(pattern) {
  return CJK_RE.test(pattern)
}

/**
 * Build an Aho-Corasick automaton for `patterns` (unique normalized keywords).
 * @param {string[]} patterns
 * @returns {{ nodes: Array<{ next: Map<string, number>, fail: number, out: Array<{pattern: number, length: number}> }>, patterns: string[] }}
 */
function buildAutomaton(patterns) {
  const nodes = [{ next: new Map(), fail: 0, out: [], len: 0 }]
  for (let p = 0; p < patterns.length; p += 1) {
    const pattern = patterns[p]
    let node = 0
    for (const char of pattern) {
      let next = nodes[node].next.get(char)
      if (next === undefined) {
        next = nodes.length
        nodes.push({ next: new Map(), fail: 0, out: [], len: 0 })
        nodes[node].next.set(char, next)
      }
      node = next
    }
    nodes[node].out.push({ pattern: p, length: [...pattern].length })
  }
  const queue = []
  for (const child of nodes[0].next.values()) {
    nodes[child].fail = 0
    queue.push(child)
  }
  for (let head = 0; head < queue.length; head += 1) {
    const nodeIndex = queue[head]
    const node = nodes[nodeIndex]
    for (const [char, child] of node.next) {
      let fail = node.fail
      let target
      while (fail !== 0) {
        target = nodes[fail].next.get(char)
        if (target !== undefined) break
        fail = nodes[fail].fail
      }
      if (target === undefined) target = nodes[0].next.get(char)
      nodes[child].fail = target !== undefined && target !== child ? target : 0
      queue.push(child)
    }
    if (nodeIndex !== 0) {
      const suffix = nodes[node.fail].out
      if (suffix.length) node.out = node.out.concat(suffix)
    }
  }
  return { nodes, patterns }
}

/**
 * Scan normalized text and return every matched normalized keyword.
 * @param {ReturnType<typeof buildAutomaton>} automaton
 * @param {string} normalizedText
 * @returns {string[]}
 */
function scanAutomaton(automaton, normalizedText) {
  const nodes = automaton.nodes
  const patterns = automaton.patterns
  const chars = [...normalizedText]
  const matched = []
  let state = 0
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]
    while (state !== 0 && !nodes[state].next.has(char)) state = nodes[state].fail
    const next = nodes[state].next.get(char)
    state = next === undefined ? 0 : next
    const out = nodes[state].out
    if (!out.length) continue
    for (const hit of out) {
      const pattern = patterns[hit.pattern]
      if (!patternHasCjk(pattern)) {
        const start = i + 1 - hit.length
        if (start < 0) continue
        const before = start - 1 >= 0 ? chars[start - 1] : ''
        const after = i + 1 < chars.length ? chars[i + 1] : ''
        if (isAsciiWordChar(before) || isAsciiWordChar(after)) continue
      }
      matched.push(pattern)
    }
  }
  return matched
}

// ---------------------------------------------------------------------------
// index construction
// ---------------------------------------------------------------------------

/** Normalized, de-duplicated keywords of one folder entry. */
function normalizedKeywordsOf(folder) {
  const out = []
  const seen = new Set()
  const raw = folder && Array.isArray(folder.keywords) ? folder.keywords : []
  for (const keyword of raw) {
    const normalized = normalizeKeyword(keyword)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/** An empty index (used when callers pass garbage). */
function emptyIndex() {
  return {
    entries: [],
    byId: new Map(),
    postings: new Map(),
    /** B-02 direction-2 reverse index: user token → multi-token folder keywords. */
    tokenKeywords: new Map(),
    automaton: buildAutomaton([]),
    matchMode: 'contains',
    rareThreshold: Math.max(1, DEFAULT_FAIR.rareTerm.minPosting),
    folderCount: 0,
    builtAt: 0,
    signature: 'cfg1|empty',
  }
}

/** Remove Latin separators so "node.js" and "nodejs" compare equal. */
function compactLatin(text) {
  return String(text).replace(/[._\-+#]/g, '')
}

/**
 * Reverse-index keys for one folder keyword (B-02 direction 2).
 *
 * A user token can only add a *new* match when the folder keyword has more than
 * one component (space / separator / several tokens): a single-token keyword is
 * already fully covered by the v1.3.0 direction (`keywordMatches`). Indexing only
 * multi-token keywords keeps the reverse map small (the `expandLatinCase`
 * expansion adds the compact/word-run forms on top).
 */
function direction2Keys(keyword, expandLatinCase) {
  const keys = new Set()
  const tokens = tokenize(keyword)
  const multiToken = tokens.length > 1 || keyword.includes(' ') || /[._\-+#/]/.test(keyword)
  if (!multiToken) return keys
  for (const token of tokens) {
    if (typeof token === 'string' && token.length >= 2) keys.add(token)
  }
  // Latin word runs inside a mixed keyword: "node.js" → node / js, so a user
  // token "node" can seed it (direction 2 uses word boundaries, not equality).
  for (const match of keyword.matchAll(/[a-z0-9_]+/g)) {
    if (match[0].length >= 2) keys.add(match[0])
  }
  if (expandLatinCase) {
    for (const key of [...keys]) {
      const compact = compactLatin(key)
      if (compact.length >= 2) keys.add(compact)
    }
    const compactKeyword = compactLatin(keyword)
    if (compactKeyword.length >= 2) keys.add(compactKeyword)
  }
  return keys
}

/** Build the direction-2 reverse index: user token → folder keywords. */
function buildTokenKeywordIndex(entries, cfg) {
  const expandLatinCase = cfg && cfg.match && cfg.match.expandLatinCase === true
  const index = new Map()
  for (const entry of entries) {
    for (const keyword of entry.keywords) {
      for (const key of direction2Keys(keyword, expandLatinCase)) {
        let list = index.get(key)
        if (!list) {
          list = []
          index.set(key, list)
        }
        if (list[list.length - 1] !== keyword) list.push(keyword)
      }
    }
  }
  return index
}

/** Coerce a foreign index-looking object into a usable index. */
function normalizeIndex(index) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.entries)) return emptyIndex()
  if (!(index.postings instanceof Map)) return emptyIndex()
  if (!(index.byId instanceof Map)) {
    const byId = new Map()
    index.entries.forEach((entry, at) => {
      if (entry && isValidId(entry.id) && !byId.has(entry.id)) byId.set(entry.id, at)
    })
    return { ...index, byId }
  }
  if (!index.automaton) {
    return {
      ...index,
      automaton: buildAutomaton([...index.postings.keys()].filter((key) => !isCategorySeed(key))),
      categoryMatch: index.categoryMatch && typeof index.categoryMatch === 'object' ? index.categoryMatch : categoryConfigOf(undefined),
    }
  }
  return index
}

/**
 * Build the deterministic recall index from `index.folders`.
 *
 * Rules (contract §5.1):
 *  - skip `scored === false` folders and folders whose id is not a string;
 *  - duplicate ids: the first *surviving* copy wins (deterministic);
 *  - `minAlpha` is NOT applied here (it is a query-time gate);
 *  - posting lists are sorted by σ so a query is a k-way merge.
 *
 * Complexity O(BN log N); a 10^4 folder library builds in tens of ms.
 *
 * @param {Array<{id: string, alpha?: number, createdAt?: number, keywords?: string[], scored?: boolean, folder?: object}>} folders
 * @param {object} [cfg]
 * @returns {{
 *   entries: Array<{id: string, alpha: number, createdAt: number, keywords: string[], folder: object}>,
 *   byId: Map<string, number>, postings: Map<string, number[]>, automaton: object,
 *   matchMode: 'contains'|'exact', rareThreshold: number, folderCount: number,
 *   builtAt: number, signature: string,
 * }}
 */
export function buildRecallIndex(folders, cfg) {
  const { fair } = recallAndFair(cfg)
  const effective = fairConfig(fair)
  const list = Array.isArray(folders) ? folders : []
  const entries = []
  const seenIds = new Set()
  for (const folder of list) {
    if (!folder || typeof folder !== 'object') continue
    if (folder.scored === false) continue
    if (!isValidId(folder.id)) continue
    if (seenIds.has(folder.id)) continue // duplicate id: first surviving copy wins
    seenIds.add(folder.id)
    entries.push({
      id: folder.id,
      alpha: clampAlpha(numberOr(folder.alpha, 0)),
      createdAt: numberOr(folder.createdAt, 0),
      keywords: normalizedKeywordsOf(folder),
      folder,
    })
  }
  const byId = new Map()
  entries.forEach((entry, at) => byId.set(entry.id, at))
  const postings = new Map()
  entries.forEach((entry, at) => {
    for (const keyword of entry.keywords) {
      let posting = postings.get(keyword)
      if (!posting) {
        posting = []
        postings.set(keyword, posting)
      }
      posting.push(at)
    }
  })
  for (const posting of postings.values()) posting.sort((left, right) => comparePriority(entries[left], entries[right]))
  // Plan A: synthetic postings for the category layer. Only high-α entries take
  // part (generic synonyms must not flood low-α memories); each posting is sorted
  // by σ like every other posting, so all existing lanes/merge code work as-is.
  const category = categoryConfigOf(cfg)
  if (category.enabled) {
    const classPostings = new Map()
    entries.forEach((entry, at) => {
      if (!(entry.alpha >= category.alphaMin)) return
      let classes = null
      try {
        classes = classesForEntry(entry, category)
      } catch {
        classes = null
      }
      if (!Array.isArray(classes) || classes.length === 0) return
      for (const key of classes) {
        let posting = classPostings.get(key)
        if (!posting) {
          posting = []
          classPostings.set(key, posting)
        }
        posting.push(at)
      }
    })
    for (const [key, posting] of classPostings) {
      posting.sort((left, right) => comparePriority(entries[left], entries[right]))
      postings.set(categorySeed(key), posting)
    }
  }
  const folderCount = entries.length
  const rareThreshold = Math.max(
    effective.rareMinPosting,
    Math.ceil(numberOr(effective.rareRatio, DEFAULT_FAIR.rareTerm.ratio) * folderCount),
  )
  const matchMode = matchModeOf(cfg)
  const firstId = folderCount > 0 ? entries[0].id : ''
  const lastId = folderCount > 0 ? entries[folderCount - 1].id : ''
  // builtAt is cache bookkeeping only; it is never read by the selector.
  const builtAt = Date.now()
  return {
    entries,
    byId,
    postings,
    tokenKeywords: buildTokenKeywordIndex(entries, cfg),
    // Category markers are synthetic posting keys, never literal text patterns.
    automaton: buildAutomaton([...postings.keys()].filter((key) => !isCategorySeed(key))),
    categoryMatch: category,
    matchMode,
    rareThreshold,
    folderCount,
    builtAt,
    signature: `fairstore1|n=${folderCount}|first=${firstId}|last=${lastId}|${lanesFingerprint(cfg)}`,
  }
}

// ---------------------------------------------------------------------------
// query seeds
// ---------------------------------------------------------------------------

/**
 * Deterministic query seeds: normalized folder keywords that match the user
 * text (contains: CJK substring / Latin word boundary, via the same predicate
 * as engine/tokenize.js `keywordMatches`; exact: token dictionary).
 *
 * @param {object} index
 * @param {string} userText
 * @param {object} [cfg]
 * @returns {{ seeds: string[], userKeywords: string[] }}
 */
export function querySeeds(index, userText, cfg) {
  const safeIndex = normalizeIndex(index)
  const text = normalizeText(userText)
  const seeds = []
  const seen = new Set()
  if (safeIndex.matchMode === 'exact') {
    for (const token of tokenize(userText)) {
      if (!token || seen.has(token) || !safeIndex.postings.has(token)) continue
      seen.add(token)
      seeds.push(token)
    }
  } else {
    for (const keyword of scanAutomaton(safeIndex.automaton, text)) {
      if (!keyword || seen.has(keyword)) continue
      seen.add(keyword)
      seeds.push(keyword)
    }
  }
  // --- B-02 (1.4.1): direction 2 of the bidirectional match ----------------
  // v1.4.0 shipped the bidirectional predicate (`keyword-match.js`) but never
  // wired it into the product path, so "接口网关 8080" was not recalled by a user
  // saying only "网关". A user token that appears *inside* a multi-token folder
  // keyword now seeds that keyword too. The reverse map is a candidate
  // generator; `matchKeywords` is the authoritative filter, so the result is
  // "direction 1 ∪ direction 2" (monotone: nothing v1.3.0 matched is removed)
  // and stays deterministic (seeds are sorted below).
  const tokenKeywords = safeIndex.tokenKeywords instanceof Map ? safeIndex.tokenKeywords : null
  if (tokenKeywords && tokenKeywords.size > 0 && text) {
    const expandLatinCase = !!(cfg && cfg.match && cfg.match.expandLatinCase === true)
    const lookupKeys = new Set()
    for (const token of tokenize(text)) {
      if (!token || token.length < 2) continue
      lookupKeys.add(token)
      if (expandLatinCase) {
        const compact = compactLatin(token)
        if (compact.length >= 2) lookupKeys.add(compact)
      }
    }
    for (const key of lookupKeys) {
      const keywords = tokenKeywords.get(key)
      if (!keywords || !keywords.length) continue
      for (const keyword of keywords) {
        if (!keyword || seen.has(keyword)) continue
        // Verify with the authoritative bidirectional predicate (direction 2 +
        // the opt-in `match.*` expansions); a reverse-map hit that the predicate
        // rejects is simply not added.
        if (matchKeywords(text, [keyword], cfg).matchCount === 0) continue
        seen.add(keyword)
        seeds.push(keyword)
      }
    }
  }
  // --- Plan A (v1.4.1 addendum): deterministic category layer -------------
  // A query that uses a synonym of a closed category (喜好/偏好/喜欢…) seeds the
  // synthetic posting of that class, so high-α memories whose keywords carry
  // another synonym of the same class are still found — no embeddings, no
  // network, fully deterministic. Only classes with a posting are seeded.
  const category = safeIndex.categoryMatch && safeIndex.categoryMatch.enabled === true
    ? safeIndex.categoryMatch
    : categoryConfigOf(cfg)
  if (category.enabled) {
    for (const cls of category.classes) {
      let hit = false
      for (const word of cls.words) {
        if (word.length >= 2 && text.includes(word)) {
          hit = true
          break
        }
      }
      if (!hit) continue
      const seed = categorySeed(cls.key)
      if (seen.has(seed) || !safeIndex.postings.has(seed)) continue
      seen.add(seed)
      seeds.push(seed)
    }
  }
  seeds.sort(idCompare)
  const userKeywords = extractKeywords(userText, cfg || {}, { max: 16 })
  return { seeds, userKeywords }
}

// ---------------------------------------------------------------------------
// candidate scanning
// ---------------------------------------------------------------------------

/**
 * Collect the candidate set C(Q) (∪ posting lists of the seeds).
 *
 * Filters, in order: `minAlpha` (α gate) → `timeIds` (time window W) →
 * `eventIds` (event constraint E). Time/event filters are pre-filters: they do
 * not consume quota and never move the frontier (a different window / event
 * must be able to surface the memory later).
 *
 * @param {object} index
 * @param {string[]} seeds
 * @param {{ minAlpha?: number, timeIds?: Set<string>|null, eventIds?: Set<string>|null }} [options]
 * @returns {{
 *   indices: number[], windowIndices: number[], matchCount: Map<number, number>,
 *   filteredByAlpha: number, filteredByTime: number, filteredByEvent: number,
 *   windowSet: Set<number>,
 * }}
 */
function scanCandidates(index, seeds, options = {}) {
  const entries = index.entries
  const postings = index.postings
  const minAlpha = clampAlpha(numberOr(options.minAlpha, 0))
  const timeIds = options.timeIds || null
  const eventIds = options.eventIds || null
  const indices = []
  const windowIndices = []
  const windowSet = new Set()
  const matchCount = new Map()
  let filteredByAlpha = 0
  let filteredByTime = 0
  let filteredByEvent = 0
  for (const seed of seeds) {
    const posting = postings.get(seed)
    if (!posting || !posting.length) continue
    for (const at of posting) {
      const previous = matchCount.get(at)
      if (previous !== undefined) {
        matchCount.set(at, previous + 1)
        continue
      }
      const entry = entries[at]
      if (!entry) continue
      if (minAlpha > 0 && entry.alpha < minAlpha) {
        filteredByAlpha += 1
        matchCount.set(at, 0)
        continue
      }
      matchCount.set(at, 1)
      indices.push(at)
      if (timeIds && !timeIds.has(entry.id)) {
        filteredByTime += 1
        continue
      }
      if (eventIds && !eventIds.has(entry.id)) {
        filteredByEvent += 1
        continue
      }
      windowIndices.push(at)
      windowSet.add(at)
    }
  }
  return { indices, windowIndices, matchCount, filteredByAlpha, filteredByTime, filteredByEvent, windowSet }
}

/**
 * |C(Q)∩W∩E| — deduplicated candidates matched by the seeds, after the query-time
 * `minAlpha` gate, the optional `timeIds` window filter and the optional
 * `eventIds` event constraint (all three are part of the candidate definition
 * for the rank bound: `rank` must be defined on C(Q)∩W∩E).
 *
 * Not on the per-turn hot path (tests/tools/telemetry only).
 *
 * @param {object} index
 * @param {string[]} seeds
 * @param {{ minAlpha?: number, timeIds?: Set<string>|null, eventIds?: Set<string>|null }} [options]
 * @returns {number}
 */
export function countCandidates(index, seeds, options = {}) {
  const safeIndex = normalizeIndex(index)
  const scan = scanCandidates(safeIndex, Array.isArray(seeds) ? seeds : [], options)
  return scan.windowIndices.length
}

// ---------------------------------------------------------------------------
// k-way merge over σ-ordered posting lists
// ---------------------------------------------------------------------------

/** First index in a σ-sorted posting list whose entry is strictly after `key`. */
function firstAfter(posting, entries, key) {
  let low = 0
  let high = posting.length
  while (low < high) {
    const mid = (low + high) >> 1
    const entry = entries[posting[mid]]
    if (comparePriority(entry, key) <= 0) low = mid + 1
    else high = mid
  }
  return low
}

/** First index in an explore-ordered (σ reversed) array strictly after `key`. */
function firstAfterExplore(ordered, entries, key) {
  let low = 0
  let high = ordered.length
  while (low < high) {
    const mid = (low + high) >> 1
    // `ordered` is σ descending; "after key in explore order" => strictly lower σ.
    if (comparePriority(entries[ordered[mid]], key) < 0) high = mid
    else low = mid + 1
  }
  return low
}

/** σ key snapshot for lane persistence. */
function keyOf(entry) {
  if (!entry) return null
  return { alpha: entry.alpha, createdAt: entry.createdAt, id: entry.id }
}

/**
 * Best-first k-way merge over the posting lists of `seeds`.
 *
 * Contract (plan §3.2.3 / proof T2.2): pops are bounded, duplicates are
 * de-duplicated, `exclude` entries are skipped, and the frontier advances
 * monotonically so consecutive turns do not replay the already surfaced prefix.
 *
 * Time and minAlpha filters are *pre-filters*: they never consume a quota slot
 * and never move the frontier (a different time window must be able to surface
 * the memory later).
 *
 * @param {object} index
 * @param {string[]} seeds
 * @param {{
 *   k: number,
 *   exclude: Set<string>,
 *   sticky?: Set<string>,
 *   minAlpha?: number,
 *   timeIds?: Set<string>|null,
 *   eventIds?: Set<string>|null,
 *   frontier?: Map<string, {key: object, length: number}>|null,
 *   picked?: object[],
 *   seenIndices?: Set<number>,
 *   generation?: number,
 *   maxPops?: number,
 *   wantHasMore?: boolean,
 *   stats?: object,
 * }} context mutated in place: context.picked / context.stats / context.hasMore
 */
function mergeSigma(index, seeds, context) {
  const entries = index.entries
  const postings = index.postings
  const stats = context.stats
  const exclude = context.exclude || new Set()
  const sticky = context.sticky || new Set()
  const minAlpha = clampAlpha(numberOr(context.minAlpha, 0))
  const timeIds = context.timeIds || null
  const eventIds = context.eventIds || null
  const frontier = context.frontier || null
  const picked = context.picked || []
  const seenIndices = context.seenIndices || new Set()
  const generation = integerOr(context.generation, 1)
  const maxPops = integerOr(context.maxPops, MAX_MERGE_POPS)
  const target = Math.max(0, integerOr(context.k, 0))
  // k=0 still builds the merge so `wantHasMore` can answer "is there anything
  // left to surface?" (pagination with limit=0 must not report hasMore=false).
  const lists = []
  const seenSeeds = new Set()
  for (const seed of Array.isArray(seeds) ? seeds : []) {
    if (typeof seed !== 'string' || seenSeeds.has(seed)) continue
    seenSeeds.add(seed)
    const posting = postings.get(seed)
    if (!posting || !posting.length) continue
    // Posting lists are α descending: if even the head is below the gate the
    // whole list can be skipped in O(1).
    if (minAlpha > 0 && entries[posting[0]].alpha < minAlpha) continue
    let start = 0
    const record = frontier ? frontier.get(seed) : undefined
    if (record && record.key && Number.isInteger(record.length) && record.length === posting.length) {
      start = firstAfter(posting, entries, record.key)
      if (start > 0 && stats) stats.frontierHits = (stats.frontierHits || 0) + 1
    }
    // Length changed (append/rebuild): restart the list so new memories are visible.
    if (start >= posting.length) continue
    lists.push({ posting, seed, pos: start })
  }
  if (stats) stats.lists = (stats.lists || 0) + lists.length
  if (!lists.length) {
    context.hasMore = false
    return
  }
  const heap = []
  const less = (left, right) => comparePriority(entries[heap[left].e], entries[heap[right].e]) < 0
  const push = (node) => {
    heap.push(node)
    let at = heap.length - 1
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (!less(at, parent)) break
      const swap = heap[at]
      heap[at] = heap[parent]
      heap[parent] = swap
      at = parent
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let at = 0
      for (;;) {
        const left = 2 * at + 1
        const right = left + 1
        let best = at
        if (left < heap.length && less(left, best)) best = left
        if (right < heap.length && less(right, best)) best = right
        if (best === at) break
        const swap = heap[at]
        heap[at] = heap[best]
        heap[best] = swap
        at = best
      }
    }
    return top
  }
  const advanceList = (node) => {
    const list = lists[node.li]
    const next = node.pos + 1
    if (next < list.posting.length) push({ e: list.posting[next], li: node.li, pos: next })
  }
  const advanceFrontier = (node) => {
    if (!frontier) return
    const list = lists[node.li]
    frontier.set(list.seed, { key: keyOf(entries[node.e]), length: list.posting.length })
  }
  for (let li = 0; li < lists.length; li += 1) push({ e: lists[li].posting[lists[li].pos], li, pos: lists[li].pos })
  let pops = 0
  while (heap.length && picked.length < target && pops < maxPops) {
    const node = pop()
    pops += 1
    const entryIndex = node.e
    const entry = entries[entryIndex]
    if (!entry) {
      advanceList(node)
      continue
    }
    // Time window / event pre-filters: skip without touching the quota or the
    // frontier (a different window/event must be able to surface the memory later).
    if (timeIds && !timeIds.has(entry.id)) {
      if (stats) stats.filteredByTime = (stats.filteredByTime || 0) + 1
      advanceList(node)
      continue
    }
    if (eventIds && !eventIds.has(entry.id)) {
      if (stats) stats.filteredByEvent = (stats.filteredByEvent || 0) + 1
      advanceList(node)
      continue
    }
    if (minAlpha > 0 && entry.alpha < minAlpha) {
      // Posting lists are α descending and the heap is a global σ merge, so a
      // head below the gate means every remaining item is below it too.
      heap.length = 0
      break
    }
    if (seenIndices.has(entryIndex)) {
      if (stats) stats.duplicates = (stats.duplicates || 0) + 1
      advanceFrontier(node)
      advanceList(node)
      continue
    }
    if (exclude.has(entry.id)) {
      if (stats) stats.excludedSkips = (stats.excludedSkips || 0) + 1
      // Sticky (ledger / already surfaced) entries may safely move the frontier;
      // transient exclusions (block / tool exclude) must not hide memories later.
      if (sticky.has(entry.id)) advanceFrontier(node)
      advanceList(node)
      continue
    }
    seenIndices.add(entryIndex)
    advanceFrontier(node)
    picked.push({
      id: entry.id,
      alpha: entry.alpha,
      createdAt: entry.createdAt,
      generation,
      index: entryIndex,
    })
    advanceList(node)
  }
  if (stats) stats.pops = (stats.pops || 0) + pops
  context.hasMore = false
  if (!context.wantHasMore) return
  // hasMore: is there one more eligible, not-yet-surfaced candidate?
  while (heap.length && pops < maxPops) {
    const node = heap[0]
    const entryIndex = node.e
    const entry = entries[entryIndex]
    if (!entry) {
      pop()
      advanceList(node)
      pops += 1
      continue
    }
    if (timeIds && !timeIds.has(entry.id)) {
      pop()
      advanceList(node)
      pops += 1
      continue
    }
    if (eventIds && !eventIds.has(entry.id)) {
      pop()
      advanceList(node)
      pops += 1
      continue
    }
    if (minAlpha > 0 && entry.alpha < minAlpha) break
    if (seenIndices.has(entryIndex) || exclude.has(entry.id)) {
      if (stats) stats.excludedSkips = (stats.excludedSkips || 0) + 1
      if (sticky.has(entry.id)) advanceFrontier(node)
      pop()
      advanceList(node)
      pops += 1
      continue
    }
    context.hasMore = true
    break
  }
  if (stats) stats.pops = (stats.pops || 0) + 0 // pops already counted above
}

// ---------------------------------------------------------------------------
// selectSigma — low level deterministic σ top-k (deterministic mode / oracle)
// ---------------------------------------------------------------------------

/**
 * Pure DRI selection: the σ-smallest k candidates (excluding `exclude`) in
 * deterministic order. Used by `recall.mode='deterministic'`, by the tests as
 * the ranked oracle, and by the FAIR-DRI σ high lane.
 *
 * Options: `k` (default 10), `exclude`/`excludeIds`/`blockIds`/`ledger` id
 * collections, `sticky` (ids allowed to advance the last frontier; defaults to
 * `exclude` ∪ `ledger`), `minAlpha`, `timeIds`, `eventIds`, `frontier` (Map,
 * mutated), `hops` (default 0), `maxPops`, `wantHasMore` (default true).
 *
 * @param {object} index
 * @param {string[]} seeds
 * @param {object} [options]
 * @returns {{ picked: Array<{id: string, alpha: number, createdAt: number, generation: number, index: number}>, stats: object }}
 */
export function selectSigma(index, seeds, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const safeIndex = normalizeIndex(index)
  const k = clampInt(opts.k, DEFAULT_K, 0, MAX_K)
  const excluded = toIdSet(opts.excludeIds)
  for (const id of toIdSet(opts.exclude)) excluded.add(id)
  for (const id of toIdSet(opts.blockIds)) excluded.add(id)
  const ledger = toIdSet(opts.ledger)
  for (const id of ledger) excluded.add(id)
  const sticky = toIdSet(opts.sticky)
  if (opts.sticky === undefined) {
    for (const id of toIdSet(opts.exclude)) sticky.add(id)
    for (const id of ledger) sticky.add(id)
  }
  const minAlpha = clampAlpha(numberOr(opts.minAlpha, 0))
  const timeIds = toIdFilter(opts.timeIds)
  const eventIds = toIdFilter(opts.eventIds)
  const frontier = opts.frontier instanceof Map ? opts.frontier : null
  const maxPops = integerOr(opts.maxPops, MAX_MERGE_POPS)
  const stats = {
    seedCount: 0,
    lists: 0,
    pops: 0,
    duplicates: 0,
    excludedSkips: 0,
    frontierHits: 0,
    filteredByTime: 0,
    filteredByEvent: 0,
    hasMore: false,
  }
  const seedList = []
  const seenSeeds = new Set()
  for (const seed of Array.isArray(seeds) ? seeds : []) {
    if (typeof seed !== 'string' || seenSeeds.has(seed)) continue
    seenSeeds.add(seed)
    seedList.push(seed)
  }
  stats.seedCount = seedList.length
  const picked = []
  const seenIndices = new Set()
  const mergeContext = {
    k,
    exclude: excluded,
    sticky,
    minAlpha,
    timeIds,
    eventIds,
    frontier,
    picked,
    seenIndices,
    generation: 1,
    maxPops,
    wantHasMore: opts.wantHasMore !== false,
    stats,
  }
  mergeSigma(safeIndex, seedList, mergeContext)
  let hasMore = mergeContext.hasMore === true
  // Optional deterministic hop expansion (cfg.recall.hops; H=0 by default).
  const hops = Math.max(0, integerOr(opts.hops, 0))
  const hopKeywordCap = Math.max(1, integerOr(opts.hopKeywordCap, 64))
  if (hops > 0 && picked.length < k) {
    const seedSet = new Set(seedList)
    for (let hop = 1; hop <= hops && picked.length < k; hop += 1) {
      const expansion = new Set()
      for (const item of picked) {
        const entry = safeIndex.entries[item.index]
        if (!entry) continue
        for (const keyword of entry.keywords) if (!seedSet.has(keyword)) expansion.add(keyword)
      }
      if (!expansion.size) break
      const expansionSeeds = [...expansion].sort(idCompare).slice(0, hopKeywordCap)
      for (const keyword of expansionSeeds) seedSet.add(keyword)
      const hopPicked = []
      const hopContext = {
        k: k - picked.length,
        exclude: excluded,
        sticky,
        minAlpha,
        timeIds,
        eventIds,
        frontier,
        picked: hopPicked,
        seenIndices,
        generation: hop + 1,
        maxPops,
        wantHasMore: false,
        stats,
      }
      mergeSigma(safeIndex, expansionSeeds, hopContext)
      for (const item of hopPicked) picked.push(item)
    }
  }
  stats.hasMore = hasMore
  return { picked, stats: { ...stats, hasMore } }
}

// ---------------------------------------------------------------------------
// FAIR-DRI lane helpers
// ---------------------------------------------------------------------------

/**
 * Rare-term scan: find the "rare" query seeds (posting length ≤ τ) and score
 * every candidate they contain by Σ 1/ln(2+df).
 *
 * `scanCap` limits how many seeds participate in the rarity classification
 * (contract §5.1) — seeds are visited in posting-length order so the most
 * specific terms are always classified.
 *
 * @returns {{ scored: Map<number, number>, rareSeedCount: number, threshold: number }}
 */
function scanRareTerms(index, seeds, options = {}) {
  const threshold = Math.max(1, integerOr(index.rareThreshold, DEFAULT_FAIR.rareTerm.minPosting))
  const scanCap = integerOr(options.scanCap, DEFAULT_FAIR.rareTerm.scanCap)
  const minAlpha = clampAlpha(numberOr(options.minAlpha, 0))
  const timeIds = options.timeIds || null
  const eventIds = options.eventIds || null
  const entries = index.entries
  const infos = []
  for (const seed of seeds) {
    const posting = index.postings.get(seed)
    if (posting && posting.length) infos.push({ seed, posting })
  }
  infos.sort((left, right) => left.posting.length - right.posting.length || idCompare(left.seed, right.seed))
  const limited = infos.slice(0, Math.max(1, scanCap))
  const scored = new Map()
  let rareSeedCount = 0
  for (const info of limited) {
    if (info.posting.length > threshold) continue
    rareSeedCount += 1
    const weight = 1 / Math.log(2 + info.posting.length)
    for (const at of info.posting) {
      const entry = entries[at]
      if (!entry) continue
      if (minAlpha > 0 && entry.alpha < minAlpha) continue
      if (timeIds && !timeIds.has(entry.id)) continue
      if (eventIds && !eventIds.has(entry.id)) continue
      scored.set(at, (scored.get(at) || 0) + weight)
    }
  }
  return { scored, rareSeedCount, threshold }
}

/** Comparator over entry indices using `comparePriority`. */
function compareByPriority(entries) {
  return (left, right) => comparePriority(entries[left], entries[right])
}

/** Comparator for the rotation lane lookahead: matchCount desc, explore order. */
function compareRotationWindow(entries, matchCount) {
  return (left, right) => {
    const a = matchCount.get(left) || 0
    const b = matchCount.get(right) || 0
    if (a !== b) return b - a
    return compareExplore(entries[left], entries[right])
  }
}

/** Percentile helper for telemetry summarizers. */
function percentile(values, ratio) {
  if (!values.length) return null
  const sorted = values.slice().sort((left, right) => left - right)
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)))
  return sorted[at]
}

// ---------------------------------------------------------------------------
// lane state
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   frontier: Map<string, {key: {alpha: number, createdAt: number, id: string}|null, length: number}>,
 *   exploreCursor: null | {seed: string|null, key: {alpha: number, createdAt: number, id: string}|null, pos: number, length: number},
 *   pendingHigh: string[], pendingHighRound: number[],
 *   highRecycle: Array<{id: string, round: number}>,
 *   recycle: Array<{id: string, eligibleRound: number}>,
 *   degraded: boolean, round: number,
 * }} LaneState
 */

/** Fresh, serializable lane state. */
export function emptyLanes() {
  return {
    frontier: new Map(),
    exploreCursor: null,
    pendingHigh: [],
    pendingHighRound: [],
    highRecycle: [],
    recycle: [],
    degraded: false,
    round: 0,
  }
}

/** Repair an in-memory lane state (arrays/booleans present, pending aligned). */
function normalizeLaneState(lanes) {
  if (!(lanes.frontier instanceof Map)) lanes.frontier = new Map()
  if (!Array.isArray(lanes.pendingHigh)) lanes.pendingHigh = []
  if (!Array.isArray(lanes.pendingHighRound)) lanes.pendingHighRound = []
  if (!Array.isArray(lanes.highRecycle)) lanes.highRecycle = []
  if (!Array.isArray(lanes.recycle)) lanes.recycle = []
  if (typeof lanes.degraded !== 'boolean') lanes.degraded = false
  lanes.round = Math.max(0, integerOr(lanes.round, 0))
  if (lanes.exploreCursor === undefined) lanes.exploreCursor = null
  while (lanes.pendingHighRound.length < lanes.pendingHigh.length) lanes.pendingHighRound.push(0)
  if (lanes.pendingHighRound.length > lanes.pendingHigh.length) lanes.pendingHighRound.length = lanes.pendingHigh.length
  return lanes
}

/**
 * Turn anything lane-shaped into a live LaneState. A serialized object (the
 * output of `serializeLanes`, e.g. parsed from recall-state.json) is restored;
 * garbage becomes `emptyLanes()` and never throws.
 */
function asLaneState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyLanes()
  if (value.frontier instanceof Map) return normalizeLaneState(value)
  return deserializeLanes(value)
}

/** Extract a σ key from arbitrary serialized data. */
function normalizeKey(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!isValidId(raw.id)) return null
  return {
    alpha: clampAlpha(numberOr(raw.alpha, 0)),
    createdAt: numberOr(raw.createdAt, 0),
    id: raw.id,
  }
}

/**
 * Serialize the lane state to a JSON-safe object (recall-state.json v3 shape,
 * contract §6). Never throws.
 *
 * @param {LaneState} lanes
 * @returns {object}
 */
export function serializeLanes(lanes) {
  try {
    // Never mutate the caller's live lane object: `normalizeLaneState` repairs
    // fields in place, and a pagination snapshot must stay byte-identical.
    const safe = lanes && typeof lanes === 'object' && !Array.isArray(lanes)
      ? deserializeLanes(lanes)
      : emptyLanes()
    const frontier = []
    for (const [seed, record] of safe.frontier) {
      if (typeof seed !== 'string' || !record || typeof record !== 'object') continue
      const key = normalizeKey(record.key)
      if (!key) continue
      frontier.push({ seed, key, length: Math.max(0, integerOr(record.length, 0)) })
    }
    const cursor = safe.exploreCursor && typeof safe.exploreCursor === 'object' ? safe.exploreCursor : null
    const exploreCursor = cursor
      ? {
        seed: typeof cursor.seed === 'string' ? cursor.seed : null,
        key: normalizeKey(cursor.key),
        pos: Math.max(0, integerOr(cursor.pos, 0)),
        length: Math.max(0, integerOr(cursor.length, 0)),
      }
      : null
    const pendingHigh = []
    const pendingHighRound = []
    for (let at = 0; at < safe.pendingHigh.length; at += 1) {
      const id = safe.pendingHigh[at]
      if (!isValidId(id)) continue
      pendingHigh.push(id)
      pendingHighRound.push(Math.max(0, integerOr(safe.pendingHighRound[at], 0)))
    }
    const highRecycle = []
    for (const item of safe.highRecycle) {
      if (!item || !isValidId(item.id)) continue
      highRecycle.push({ id: item.id, round: Math.max(0, integerOr(item.round, 0)) })
    }
    const recycle = []
    for (const item of safe.recycle) {
      if (!item || !isValidId(item.id)) continue
      recycle.push({ id: item.id, eligibleRound: Math.max(0, integerOr(item.eligibleRound, 0)) })
    }
    return {
      frontier,
      exploreCursor,
      pendingHigh,
      pendingHighRound,
      highRecycle,
      recycle,
      degraded: safe.degraded === true,
      round: safe.round,
    }
  } catch {
    return serializeLanes(emptyLanes())
  }
}

/**
 * Restore a LaneState from serialized data. Every bad field degrades to its
 * empty value; the function never throws.
 *
 * @param {unknown} raw
 * @returns {LaneState}
 */
export function deserializeLanes(raw) {
  const lanes = emptyLanes()
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return lanes
    const frontier = raw.frontier
    if (frontier instanceof Map) {
      for (const [seed, record] of frontier) {
        if (typeof seed !== 'string' || !record || typeof record !== 'object') continue
        const key = normalizeKey(record.key)
        if (!key) continue
        lanes.frontier.set(seed, { key, length: Math.max(0, integerOr(record.length, 0)) })
      }
    } else if (Array.isArray(frontier)) {
      for (const record of frontier) {
        if (!record || typeof record !== 'object' || !isValidId(record.seed)) continue
        const key = normalizeKey(record.key)
        if (!key) continue
        lanes.frontier.set(record.seed, { key, length: Math.max(0, integerOr(record.length, 0)) })
      }
    }
    const cursor = raw.exploreCursor
    if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
      lanes.exploreCursor = {
        seed: typeof cursor.seed === 'string' ? cursor.seed : null,
        key: normalizeKey(cursor.key),
        pos: Math.max(0, integerOr(cursor.pos, 0)),
        length: Math.max(0, integerOr(cursor.length, 0)),
      }
    }
    if (Array.isArray(raw.pendingHigh)) {
      const rounds = Array.isArray(raw.pendingHighRound) ? raw.pendingHighRound : []
      const seen = new Set()
      for (let at = 0; at < raw.pendingHigh.length; at += 1) {
        const id = raw.pendingHigh[at]
        if (!isValidId(id) || seen.has(id)) continue
        seen.add(id)
        lanes.pendingHigh.push(id)
        lanes.pendingHighRound.push(Math.max(0, integerOr(rounds[at], 0)))
      }
    }
    if (Array.isArray(raw.highRecycle)) {
      for (const item of raw.highRecycle) {
        if (!item || !isValidId(item.id)) continue
        lanes.highRecycle.push({ id: item.id, round: Math.max(0, integerOr(item.round, 0)) })
      }
    }
    if (Array.isArray(raw.recycle)) {
      for (const item of raw.recycle) {
        if (!item || !isValidId(item.id)) continue
        lanes.recycle.push({ id: item.id, eligibleRound: Math.max(0, integerOr(item.eligibleRound, 0)) })
      }
    }
    lanes.degraded = raw.degraded === true
    lanes.round = Math.max(0, integerOr(raw.round, 0))
  } catch {
    return emptyLanes()
  }
  return lanes
}

// ---------------------------------------------------------------------------
// selectRecall — FAIR-DRI per-turn selection
// ---------------------------------------------------------------------------

/** Build the required stats skeleton (contract §5.1). */
function emptySelectStats(round, mode) {
  return {
    candidates: 0,
    candidatesAll: 0,
    lanesPicked: { rareHigh: 0, queryBoost: 0, register: 0, hi: 0, lowProbe: 0, rotation: 0, recycle: 0 },
    pops: 0,
    frontierHits: 0,
    duplicates: 0,
    excludedSkips: 0,
    registerDrops: 0,
    reInjections: 0,
    degraded: false,
    filteredByTime: 0,
    filteredByEvent: 0,
    filteredByAlpha: 0,
    categorySeeds: [],
    round,
    mode,
  }
}

/** Final pick object shape (contract §5.1). */
function makePick(entry, lane, sigmaRank, rareScore, generation) {
  return {
    id: entry.id,
    lane,
    alpha: entry.alpha,
    createdAt: entry.createdAt,
    generation: Number.isInteger(generation) ? generation : 1,
    sigmaRank: Number.isInteger(sigmaRank) ? sigmaRank : null,
    rareScore: Number.isFinite(rareScore) ? rareScore : 0,
  }
}

/** Trim a lane pool to `max` entries (oldest dropped first); returns dropped count. */
function capPool(pool, max) {
  if (!Array.isArray(pool) || pool.length <= max) return 0
  const dropped = pool.length - max
  pool.splice(0, dropped)
  return dropped
}

/**
 * FAIR-DRI single-turn selection. Fully deterministic: same index + userText +
 * options + lanes ⇒ byte-identical result. No `Math.random`, and `Date.now()`
 * never affects the picks.
 *
 * @param {object} index
 * @param {string} userText
 * @param {{
 *   lanes?: LaneState, cfg?: object, round?: number,
 *   blockIds?: Set<string>|string[], ledger?: Set<string>|string[],
 *   excludeIds?: Set<string>|string[], minAlpha?: number,
 *   timeIds?: Set<string>|null, eventIds?: Set<string>|null, k?: number,
 *   mode?: 'fair'|'deterministic', hops?: number,
 * }} [options]
 * @returns {{
 *   picks: Array<{id: string, lane: string, alpha: number, createdAt: number, generation: number, sigmaRank: number|null, rareScore: number}>,
 *   stats: object, hasMore: boolean, lanes: LaneState, warnings: string[],
 *   candidateIds?: string[],
 * }}
 */
export function selectRecall(index, userText, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const cfg = objectOf(opts.cfg)
  const { recall, fair } = recallAndFair(cfg)
  const effective = fairConfig(fair)
  const safeIndex = normalizeIndex(index)
  const entries = safeIndex.entries
  const byId = safeIndex.byId
  const warnings = []
  const requestedMode = typeof opts.mode === 'string' ? opts.mode : typeof recall.mode === 'string' ? recall.mode : 'fair'
  let mode = 'fair'
  if (requestedMode === 'deterministic') {
    mode = 'deterministic'
  } else if (requestedMode === 'legacy') {
    mode = 'deterministic'
    warnings.push('recall: legacy mode is handled by engine/recall.js; selectRecall used deterministic DRI')
  } else if (requestedMode !== 'fair') {
    warnings.push(`recall: unknown mode ${JSON.stringify(requestedMode)}; using fair`)
  }
  const lanes = asLaneState(opts.lanes)
  const fallbackRound = lanes.round + 1
  const round = Math.max(1, integerOr(opts.round, fallbackRound))
  lanes.round = round
  // B-01: the pagination window is fixed by the caller (`min(candidates,
  // PAGINATE_MAX_K)`), so the page slice is independent of offset/limit and the
  // k safety clamp must not shrink it.
  const k = opts.paginate === true ? clampInt(opts.k, 0, 0, PAGINATE_MAX_K) : resolveK(opts.k, recall.firstGenMax)
  const blockIds = toIdSet(opts.blockIds)
  const ledger = toIdSet(opts.ledger)
  const extraExclude = toIdSet(opts.excludeIds)
  const minAlpha = clampAlpha(numberOr(opts.minAlpha, numberOr(recall.minAlpha, 0)))
  const timeIds = toIdFilter(opts.timeIds)
  const eventIds = toIdFilter(opts.eventIds)
  const thetaHigh = effective.thetaHigh
  const exploreRatio = effective.exploreRatio
  const r = rotationRate(k, exploreRatio)
  const kHigh = Math.max(1, k - r)
  const hops = Math.max(0, integerOr(opts.hops, integerOr(recall.hops, 0)))
  const stats = emptySelectStats(round, mode)

  const seeds = querySeeds(safeIndex, userText, cfg).seeds
  stats.categorySeeds = seeds.filter(isCategorySeed).map((seed) => seed.slice(CATEGORY_SEED_PREFIX.length))
  if (k <= 0 || entries.length === 0) {
    stats.hasMore = entries.length > 0 && seeds.length > 0
    stats.degraded = lanes.degraded === true
    return { picks: [], stats, hasMore: stats.hasMore, lanes, warnings }
  }
  const scan = scanCandidates(safeIndex, seeds, { minAlpha, timeIds, eventIds })
  // `candidates` is the rank domain |C(Q)∩W∩E| (after the α/time/event
  // pre-filters); `candidatesAll` additionally counts the candidates rejected by
  // the time window, and `filteredByEvent` the time-passed candidates rejected by
  // the event constraint (telemetry / missType decisions).
  stats.candidates = scan.windowIndices.length
  stats.candidatesAll = scan.indices.length
  stats.filteredByAlpha = scan.filteredByAlpha
  stats.filteredByTime = scan.filteredByTime
  stats.filteredByEvent = scan.filteredByEvent
  const windowIndices = scan.windowIndices
  const windowSet = scan.windowSet
  const matchCount = scan.matchCount
  const sigmaSorted = windowIndices.slice().sort(compareByPriority(entries))
  const sigmaRank = new Map()
  sigmaSorted.forEach((at, at2) => sigmaRank.set(at, at2 + 1))
  const lowIndices = windowIndices.filter((at) => entries[at].alpha < thetaHigh)
  const lowCount = lowIndices.length
  stats.lowCandidates = lowCount

  // ----- deterministic mode: pure DRI + sticky ledger + priority trim --------
  if (mode === 'deterministic') {
    const excludeIds = new Set()
    for (const id of ledger) excludeIds.add(id)
    for (const id of blockIds) excludeIds.add(id)
    for (const id of extraExclude) excludeIds.add(id)
    const sticky = new Set(ledger)
    const result = selectSigma(safeIndex, seeds, {
      k,
      exclude: excludeIds,
      sticky,
      minAlpha,
      timeIds,
      eventIds,
      frontier: lanes.frontier,
      hops,
      maxPops: MAX_MERGE_POPS,
    })
    stats.pops = result.stats.pops
    stats.frontierHits = result.stats.frontierHits
    stats.duplicates = result.stats.duplicates
    stats.excludedSkips = result.stats.excludedSkips
    // Merge-level time/event skips are a different counter (a popped entry can
    // be reached from several posting lists); the telemetry `filteredByTime` /
    // `filteredByEvent` are the deduplicated candidate counts from scanCandidates.
    stats.laneTimeSkips = result.stats.filteredByTime
    stats.laneEventSkips = result.stats.filteredByEvent
    const picks = result.picked
      .map((item) => {
        const entry = entries[item.index]
        return entry ? makePick(entry, 'hi', sigmaRank.get(item.index), 0, item.generation) : null
      })
      .filter(Boolean)
    stats.lanesPicked.hi = picks.length
    stats.degraded = lanes.degraded === true
    return {
      picks,
      stats,
      hasMore: result.stats.hasMore === true,
      lanes,
      warnings,
    }
  }

  // ----- fair mode ----------------------------------------------------------
  const picks = []
  const pickedIds = new Set()
  const pickedIndices = new Set()
  const pushPick = (at, lane, rareScore, generation) => {
    const entry = entries[at]
    if (!entry || pickedIds.has(entry.id)) return false
    pickedIds.add(entry.id)
    pickedIndices.add(at)
    picks.push(makePick(entry, lane, sigmaRank.get(at), rareScore, generation || 1))
    stats.lanesPicked[lane] = (stats.lanesPicked[lane] || 0) + 1
    return true
  }
  const excludedFromLanes = new Set()
  for (const id of ledger) excludedFromLanes.add(id)
  for (const id of blockIds) excludedFromLanes.add(id)
  for (const id of extraExclude) excludedFromLanes.add(id)

  // 1) rareHigh — high α memories matched by a rare query term.
  const rare = scanRareTerms(safeIndex, seeds, {
    minAlpha,
    timeIds,
    eventIds,
    scanCap: effective.rareScanCap,
  })
  const rareHigh = []
  for (const [at, score] of rare.scored) {
    const entry = entries[at]
    if (!entry || entry.alpha < thetaHigh) continue
    if (excludedFromLanes.has(entry.id)) continue
    rareHigh.push({ at, score, entry })
  }
  rareHigh.sort((left, right) => right.score - left.score || comparePriority(left.entry, right.entry))
  stats.rareHighCandidates = rareHigh.length
  if (rareHigh.length > kHigh) {
    warnings.push(
      `recall: ${rareHigh.length} rare high-α candidates exceed the high-lane capacity ${kHigh}; the surplus is deferred (G1 has no finite bound under this arrival rate)`,
    )
  }
  for (const item of rareHigh) {
    if (picks.length >= kHigh) break
    pushPick(item.at, 'rareHigh', item.score, 1)
  }

  // 2) queryBoost — evicted high α memories that are matched again now.
  if (effective.queryBoost && lanes.highRecycle.length) {
    const kept = []
    for (const item of lanes.highRecycle) {
      const at = byId.get(item.id)
      if (at === undefined) continue // folder gone: drop
      const entry = entries[at]
      if (!entry) continue
      if (minAlpha > 0 && entry.alpha < minAlpha) continue // gate: drop
      if (entry.alpha < thetaHigh) continue // only high α is re-admitted here
      const matchedNow = windowSet.has(at)
      if (!matchedNow || pickedIds.has(entry.id) || blockIds.has(entry.id) || extraExclude.has(entry.id)) {
        kept.push(item)
        continue
      }
      // B-04 (1.4.1) G4 cooldown: a high-α memory evicted from the block may only
      // be re-injected after `fairness.recycle.cooldownRounds` rounds (README
      // G4 / SPEC §6.2: "same id injected twice has round distance ≥ cooldown").
      // v1.4.0 read `item.round` nowhere and re-admitted on the very next hit.
      const recycledRound = numberOr(item.round, 0)
      if (effective.cooldownRounds > 0 && round - recycledRound < effective.cooldownRounds) {
        kept.push(item)
        continue
      }
      if (picks.length >= kHigh) {
        kept.push(item)
        continue
      }
      if (pushPick(at, 'queryBoost', 0, 1)) {
        if (ledger.has(entry.id)) stats.reInjections += 1
      } else {
        kept.push(item)
      }
    }
    lanes.highRecycle = kept
    capPool(lanes.highRecycle, Math.max(16, k * 4))
  }

  // 3) register — high α candidates deferred last round (TTL ttlRounds).
  const pendingRecords = []
  for (let at = 0; at < lanes.pendingHigh.length; at += 1) {
    const id = lanes.pendingHigh[at]
    const enqueuedRound = numberOr(lanes.pendingHighRound[at], 0)
    if (!isValidId(id)) continue
    if (round - enqueuedRound > effective.ttlRounds) continue // expired
    const indexAt = byId.get(id)
    if (indexAt === undefined) continue // folder gone
    const entry = entries[indexAt]
    if (!entry) continue
    if (minAlpha > 0 && entry.alpha < minAlpha) continue // gate: drop
    if (ledger.has(id)) continue // already surfaced elsewhere: drop
    if ((timeIds && !timeIds.has(id)) || (eventIds && !eventIds.has(id))) {
      pendingRecords.push({ id, round: enqueuedRound, at: indexAt })
      continue
    }
    pendingRecords.push({ id, round: enqueuedRound, at: indexAt })
  }
  pendingRecords.sort((left, right) => comparePriority(entries[left.at], entries[right.at]))
  const keptPending = []
  for (const record of pendingRecords) {
    const canInject = picks.length < kHigh
      && !pickedIds.has(record.id)
      && !blockIds.has(record.id)
      && !extraExclude.has(record.id)
      && !(timeIds && !timeIds.has(record.id))
      && !(eventIds && !eventIds.has(record.id))
    if (canInject && pushPick(record.at, 'register', 0, 1)) continue
    keptPending.push(record)
  }
  lanes.pendingHigh = keptPending.map((record) => record.id)
  lanes.pendingHighRound = keptPending.map((record) => record.round)
  // High-lane picks so far (lanes 1-3). Unused high quota flows to the rotation
  // lane (spill) so a small k still fills every available slot.
  const highLanePicks = picks.length

  // 4) σ high lane — remaining high α slots, σ k-way merge with lookahead.
  //
  // The lookahead is a *deferral buffer*, not a free-for-all: the register TTL
  // (ttlRounds=2) means a deferred high-α memory must be injected within 2
  // rounds, so the buffer is capped at one drain-round worth per TTL round
  // (`ttlRounds * k_H`), and every round refills exactly the difference. With
  // the default lookahead=3 this is 2·k_H ≤ 3·k_H entries, i.e. the whole
  // lookahead window is used for "remaining slots + refill".
  const capFactor = effective.capFactor
  const registerCap = Math.max(1, capFactor * kHigh)
  const lookCount = Math.max(1, effective.lookahead * kHigh)
  const bufferTarget = Math.min(lookCount, Math.max(1, effective.ttlRounds * kHigh))
  const remainingHigh = Math.max(0, kHigh - highLanePicks)
  const pendingSize = lanes.pendingHigh.length
  const popTarget = remainingHigh + Math.max(0, bufferTarget - pendingSize)
  if (popTarget > 0) {
    const excludeHigh = new Set(excludedFromLanes)
    for (const id of pickedIds) excludeHigh.add(id)
    for (const id of lanes.pendingHigh) excludeHigh.add(id)
    const stickyHigh = new Set(ledger)
    for (const id of pickedIds) stickyHigh.add(id)
    for (const id of lanes.pendingHigh) stickyHigh.add(id)
    const lanePicked = []
    // A separate stats object: merges are allowed to re-visit time-filtered
    // entries on every round, while telemetry.filteredByTime is the deduplicated
    // candidate count computed by scanCandidates.
    const mergeStats = { pops: 0, frontierHits: 0, duplicates: 0, excludedSkips: 0, filteredByTime: 0, filteredByEvent: 0, lists: 0 }
    mergeSigma(safeIndex, seeds, {
      k: popTarget,
      exclude: excludeHigh,
      sticky: stickyHigh,
      minAlpha: Math.max(minAlpha, thetaHigh),
      timeIds,
      eventIds,
      frontier: lanes.frontier,
      picked: lanePicked,
      seenIndices: new Set(),
      generation: 1,
      maxPops: Math.max(1024, popTarget * 16),
      wantHasMore: false,
      stats: mergeStats,
    })
    stats.pops += mergeStats.pops
    stats.frontierHits += mergeStats.frontierHits
    stats.duplicates += mergeStats.duplicates
    stats.excludedSkips += mergeStats.excludedSkips
    stats.laneTimeSkips = (stats.laneTimeSkips || 0) + mergeStats.filteredByTime
    stats.laneEventSkips = (stats.laneEventSkips || 0) + mergeStats.filteredByEvent
    let slots = remainingHigh
    const deferred = []
    for (const item of lanePicked) {
      if (slots > 0 && pushPick(item.index, 'hi', 0, 1)) slots -= 1
      else deferred.push(item.index)
    }
    if (deferred.length) {
      const combined = keptPending.map((record) => ({ id: record.id, round: record.round, at: record.at }))
      for (const at of deferred) combined.push({ id: entries[at].id, round, at })
      combined.sort((left, right) => comparePriority(entries[left.at], entries[right.at]))
      if (combined.length > registerCap) {
        stats.registerDrops += combined.length - registerCap
        combined.length = registerCap
      }
      lanes.pendingHigh = combined.map((record) => record.id)
      lanes.pendingHighRound = combined.map((record) => record.round)
    }
  }
  if (stats.registerDrops > 0) {
    warnings.push(
      `recall: register capacity exceeded (${stats.registerDrops} deferred high-α candidates dropped); the high-α deferral bound (+${effective.ttlRounds} rounds) is degraded`,
    )
  }

  // 5) lowProbe — one slot for an explicitly referenced low α memory.
  if (effective.specificProbeSlots > 0 && picks.length < k) {
    const probe = []
    for (const [at, score] of rare.scored) {
      const entry = entries[at]
      if (!entry || entry.alpha >= thetaHigh) continue
      if (excludedFromLanes.has(entry.id) || pickedIds.has(entry.id)) continue
      probe.push({ at, score, entry })
    }
    probe.sort((left, right) => right.score - left.score || comparePriority(left.entry, right.entry))
    let slots = effective.specificProbeSlots
    for (const item of probe) {
      if (slots <= 0 || picks.length >= k) break
      if (pushPick(item.at, 'lowProbe', item.score, 1)) slots -= 1
    }
  }

  // 6) rotation — deterministic low α round-robin over the global explore order.
  const lowProbePicked = stats.lanesPicked.lowProbe
  // Unused high-lane quota flows into rotation; the low probe consumes one of
  // the rotation slots (`r`), so rotation can still fill all remaining slots.
  const spill = Math.max(0, kHigh - highLanePicks)
  const rotationSlots = Math.min(
    Math.max(0, k - picks.length),
    Math.max(1, r - lowProbePicked + spill),
  )
  const exploration = windowIndices.slice().sort((left, right) => compareExplore(entries[left], entries[right]))
  const exploreLength = exploration.length
  const cursorBefore = lanes.exploreCursor
  const previousLow = cursorBefore && Number.isInteger(cursorBefore.length) ? cursorBefore.length : null
  // a_low ≥ r arrival pressure ⇒ the ceil(L/r) rotation bound is not promised.
  if (previousLow !== null && r > 0 && lowCount - previousLow >= r) {
    lanes.degraded = true
  }
  if (rotationSlots > 0 && exploreLength > 0) {
    let start = 0
    if (cursorBefore && cursorBefore.key) {
      const located = firstAfterExplore(exploration, entries, cursorBefore.key)
      start = located >= exploreLength ? 0 : located
    } else if (cursorBefore && Number.isInteger(cursorBefore.pos)) {
      start = Math.min(exploreLength - 1, Math.max(0, cursorBefore.pos))
    }
    const lookaheadWindow = Math.max(rotationSlots, 3 * rotationSlots + 4)
    const minScan = Math.min(exploreLength * 2 + 8, 2048)
    const window = []
    let at = start
    let scanned = 0
    let lastScanned = -1
    while (scanned < minScan && window.length < lookaheadWindow) {
      if (at >= exploreLength) at = 0
      const entryAt = exploration[at]
      lastScanned = entryAt
      at += 1
      scanned += 1
      const entry = entries[entryAt]
      if (!entry) continue
      if (pickedIndices.has(entryAt)) continue
      if (excludedFromLanes.has(entry.id)) continue
      window.push(entryAt)
    }
    lanes.exploreCursor = {
      seed: null,
      key: lastScanned >= 0 ? keyOf(entries[lastScanned]) : null,
      pos: exploreLength ? at % exploreLength : 0,
      length: lowCount,
    }
    window.sort(compareRotationWindow(entries, matchCount))
    let added = 0
    for (const entryAt of window) {
      if (added >= rotationSlots || picks.length >= k) break
      if (pushPick(entryAt, 'rotation', 0, 1)) added += 1
    }
  }

  // 7) recycle — evicted memories return after a cooldown (one per round).
  if (effective.recycleEnabled && picks.length < k) {
    const kept = []
    let injected = 0
    for (const item of lanes.recycle) {
      const at = byId.get(item.id)
      if (at === undefined) continue // folder gone: drop
      const entry = entries[at]
      if (!entry) continue
      if (minAlpha > 0 && entry.alpha < minAlpha) {
        kept.push(item)
        continue
      }
      if (timeIds && !timeIds.has(entry.id)) {
        kept.push(item)
        continue
      }
      if (eventIds && !eventIds.has(entry.id)) {
        kept.push(item)
        continue
      }
      if (pickedIds.has(entry.id) || blockIds.has(entry.id) || extraExclude.has(entry.id)) {
        kept.push(item)
        continue
      }
      const eligibleRound = numberOr(item.eligibleRound, 0)
      if (injected >= effective.recycleMaxPerRound || picks.length >= k || round < eligibleRound) {
        kept.push(item)
        continue
      }
      if (pushPick(at, 'recycle', 0, 1)) {
        injected += 1
        if (ledger.has(entry.id)) stats.reInjections += 1
      } else {
        kept.push(item)
      }
    }
    lanes.recycle = kept
  }
  stats.recycleDropped = capPool(lanes.recycle, Math.max(16, k * 4))

  // 8) Optional deterministic hop expansion (H=0 by default; breaks the rank bound).
  if (hops > 0 && picks.length < k && picks.length > 0) {
    const seedSet = new Set(seeds)
    const hopKeywordCap = 64
    for (let hop = 1; hop <= hops && picks.length < k; hop += 1) {
      const expansion = new Set()
      for (const pick of picks) {
        const at = byId.get(pick.id)
        if (at === undefined) continue
        for (const keyword of entries[at].keywords) if (!seedSet.has(keyword)) expansion.add(keyword)
      }
      if (!expansion.size) break
      const expansionSeeds = [...expansion].sort(idCompare).slice(0, hopKeywordCap)
      for (const keyword of expansionSeeds) seedSet.add(keyword)
      const hopPicked = []
      const hopStats = { pops: 0, frontierHits: 0, duplicates: 0, excludedSkips: 0, filteredByTime: 0, filteredByEvent: 0, lists: 0 }
      const hopExclude = new Set(excludedFromLanes)
      for (const id of pickedIds) hopExclude.add(id)
      mergeSigma(safeIndex, expansionSeeds, {
        k: k - picks.length,
        exclude: hopExclude,
        sticky: new Set(ledger),
        minAlpha,
        timeIds,
        eventIds,
        frontier: lanes.frontier,
        picked: hopPicked,
        seenIndices: new Set(),
        generation: hop + 1,
        maxPops: 4096,
        wantHasMore: false,
        stats: hopStats,
      })
      stats.pops += hopStats.pops
      stats.frontierHits += hopStats.frontierHits
      stats.duplicates += hopStats.duplicates
      stats.excludedSkips += hopStats.excludedSkips
      stats.laneTimeSkips = (stats.laneTimeSkips || 0) + hopStats.filteredByTime
      stats.laneEventSkips = (stats.laneEventSkips || 0) + hopStats.filteredByEvent
      for (const item of hopPicked) pushPick(item.index, 'hi', 0, item.generation)
    }
  }

  // A lane can surface an id that is still queued in a deferral/recycle pool
  // (e.g. rotation picks a deferred candidate). Prune those so the next round
  // cannot inject the exact same id twice.
  if (pickedIds.size > 0) {
    const keptIds = []
    const keptRounds = []
    for (let at = 0; at < lanes.pendingHigh.length; at += 1) {
      const id = lanes.pendingHigh[at]
      if (pickedIds.has(id)) continue
      keptIds.push(id)
      keptRounds.push(lanes.pendingHighRound[at])
    }
    lanes.pendingHigh = keptIds
    lanes.pendingHighRound = keptRounds
    lanes.highRecycle = lanes.highRecycle.filter((item) => !pickedIds.has(item.id))
    lanes.recycle = lanes.recycle.filter((item) => !pickedIds.has(item.id))
    stats.highRecycleDropped = capPool(lanes.highRecycle, Math.max(16, k * 4))
    stats.recycleDropped += capPool(lanes.recycle, Math.max(16, k * 4))
  }

  // hasMore: one more candidate under the same conditions that is not surfaced.
  let hasMore = false
  for (const at of windowIndices) {
    if (pickedIndices.has(at)) continue
    const entry = entries[at]
    if (!entry) continue
    if (excludedFromLanes.has(entry.id)) continue
    hasMore = true
    break
  }
  stats.hasMore = hasMore
  stats.degraded = lanes.degraded === true
  if (lanes.degraded === true) {
    warnings.push('recall: low-α arrival rate a_low ≥ r; the ceil(L/r) rotation bound is not promised (consider a larger r)')
  }
  return {
    picks,
    stats,
    hasMore,
    lanes,
    warnings,
    candidateIds: sigmaSorted.map((at) => entries[at].id),
  }
}

// ---------------------------------------------------------------------------
// trimBlock — priority based block trimming (replaces the v1.3.0 FIFO)
// ---------------------------------------------------------------------------

/**
 * Trim the injected recall block by priority.
 *
 * Eviction key (lowest priority is evicted first, plan §3.2.4):
 *   (not in this round's candidate set, α < θ_H, α asc, injectedRound asc, id)
 *
 * High α pinning: while the block contains any low α entry, high α entries are
 * never evicted. The hard `maxChars` limit still keeps at least one entry.
 *
 * @param {Array<{id: string, injectedRound?: number}>} block
 * @param {{
 *   index?: object, candidates?: Set<string>|string[]|null, cfg?: object,
 *   maxBlocks?: number, maxChars?: number, maxWindowPercent?: number, windowTokens?: number,
 * }} [options]
 * @returns {{
 *   keep: Array<{id: string, injectedRound: number}>,
 *   evicted: Array<{id: string, alpha: number, high: boolean}>,
 *   droppedChars: number, droppedBlocks: number, pinnedHigh: number,
 * }}
 */
export function trimBlock(block, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const cfg = objectOf(opts.cfg)
  const { recall, fair } = recallAndFair(cfg)
  const blockTrim = objectOf(fair.blockTrim)
  const effective = fairConfig(fair)
  const thetaHigh = effective.thetaHigh
  const index = normalizeIndex(opts.index)
  const entries = index.entries
  const byId = index.byId
  let candidates = null
  if (opts.candidates instanceof Set) candidates = opts.candidates
  else if (Array.isArray(opts.candidates)) {
    candidates = new Set()
    for (const id of opts.candidates) if (isValidId(id)) candidates.add(id)
  }
  const alphaOf = (id) => {
    const at = byId.get(id)
    return at === undefined ? -1 : entries[at].alpha
  }
  const charsOf = (id) => {
    const at = byId.get(id)
    if (at === undefined) return 0
    const entry = entries[at]
    return Math.max(0, numberOr(entry.folder && entry.folder.chars, 0))
  }
  const keep = []
  const seen = new Set()
  for (const raw of Array.isArray(block) ? block : []) {
    if (!raw) continue
    const id = typeof raw === 'string' ? raw : isValidId(raw.id) ? raw.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    keep.push({ id, injectedRound: Math.max(0, numberOr(raw.injectedRound, 0)) })
  }
  const maxBlocks = Math.max(1, integerOr(opts.maxBlocks, integerOr(recall.maxRecalledBlocks, 64)))
  const hardChars = Math.max(0, integerOr(opts.maxChars, integerOr(recall.maxRecalledChars, 120000)))
  const maxWindowPercent = numberOr(opts.maxWindowPercent, numberOr(recall.maxWindowPercent, 10))
  const windowTokens = numberOr(opts.windowTokens, 0)
  let charLimit = hardChars
  if (maxWindowPercent > 0 && windowTokens > 0) {
    // ≈4 chars per token heuristic; the block must stay under this share of the window.
    const windowCharLimit = Math.max(0, Math.floor(windowTokens * 4 * (maxWindowPercent / 100)))
    charLimit = charLimit > 0 ? Math.min(charLimit, windowCharLimit) : windowCharLimit
  }
  const protectCurrentQuery = blockTrim.protectCurrentQuery !== false && candidates !== null
  const pinHigh = blockTrim.pinHigh !== false
  let chars = keep.reduce((sum, item) => sum + charsOf(item.id), 0)
  const evicted = []
  const limitReached = () => keep.length > maxBlocks || (charLimit > 0 && chars > charLimit)
  while (limitReached()) {
    if (keep.length <= 1) break // hard limits always keep at least one entry
    let evictAt = -1
    let evictKey = null
    for (let at = 0; at < keep.length; at += 1) {
      const item = keep[at]
      const alpha = alphaOf(item.id)
      const high = alpha >= thetaHigh
      if (pinHigh && high) {
        const lowPresent = keep.some((other, otherAt) => otherAt !== at && alphaOf(other.id) < thetaHigh)
        if (lowPresent) continue
      }
      const key = [
        protectCurrentQuery && !candidates.has(item.id) ? 0 : 1,
        high ? 1 : 0,
        alpha,
        item.injectedRound,
        item.id,
      ]
      if (evictKey === null || compareTrimKey(key, evictKey) < 0) {
        evictKey = key
        evictAt = at
      }
    }
    if (evictAt < 0) break
    const [item] = keep.splice(evictAt, 1)
    const alpha = alphaOf(item.id)
    const dropped = charsOf(item.id)
    chars -= dropped
    evicted.push({ id: item.id, alpha, high: alpha >= thetaHigh })
  }
  const lowEvicted = evicted.some((item) => !item.high)
  const pinnedHigh = lowEvicted ? keep.filter((item) => alphaOf(item.id) >= thetaHigh).length : 0
  // Return `keep` in the original block order (minus evictions) for stable rendering.
  return {
    keep,
    evicted,
    droppedChars: evicted.reduce((sum, item) => sum + charsOf(item.id), 0),
    droppedBlocks: evicted.length,
    pinnedHigh,
  }
}

/** Lexicographic compare of trim keys (arrays of number|string). */
function compareTrimKey(left, right) {
  for (let at = 0; at < left.length; at += 1) {
    const a = left[at]
    const b = right[at]
    if (a === b) continue
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return String(a) < String(b) ? -1 : 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// simulateTurns / summarizeGuarantees (tests & tools)
// ---------------------------------------------------------------------------

/**
 * Consecutive recall turns over a fixed query: each turn surfaces the next k
 * items in σ order among candidates that were not surfaced yet. Used by tests
 * and by the model tool to reason about "how many turns until a memory shows
 * up" (rank bound oracle).
 *
 * @param {object} index
 * @param {string[]} seeds
 * @param {{k?: number, minAlpha?: number, maxTurns?: number, timeIds?: Set<string>|null, eventIds?: Set<string>|null}} [options]
 * @returns {{ firstSeen: Map<string, number>, turns: string[][], total: number }}
 */
export function simulateTurns(index, seeds, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const safeIndex = normalizeIndex(index)
  const k = Math.max(1, integerOr(opts.k, DEFAULT_K))
  const maxTurns = Math.max(1, integerOr(opts.maxTurns, 64))
  const minAlpha = clampAlpha(numberOr(opts.minAlpha, 0))
  const timeIds = toIdFilter(opts.timeIds)
  const eventIds = toIdFilter(opts.eventIds)
  const total = countCandidates(safeIndex, seeds, { minAlpha, timeIds, eventIds })
  const exclude = new Set()
  const firstSeen = new Map()
  const turns = []
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const result = selectSigma(safeIndex, seeds, { k, exclude, minAlpha, timeIds, eventIds })
    turns.push(result.picked.map((item) => item.id))
    if (!result.picked.length) break
    for (const item of result.picked) {
      firstSeen.set(item.id, turn)
      exclude.add(item.id)
    }
    if (exclude.size >= total) break
  }
  return { firstSeen, turns, total }
}

/**
 * Aggregate recall guarantee telemetry for tests/tools.
 *
 * Accepts a list of round records. A record is either a `selectRecall` result
 * (`{picks, stats, hasMore}`) or a flat stats-like object; optional
 * `targets: [{kind: 'high'|'low', hit: boolean, delay?: number}]` entries feed
 * the G1/G2 hit-rate summaries.
 *
 * @param {Array<object>} history
 * @returns {object}
 */
export function summarizeGuarantees(history) {
  const records = Array.isArray(history) ? history.filter((record) => record && typeof record === 'object') : []
  const lanes = { rareHigh: 0, queryBoost: 0, register: 0, hi: 0, lowProbe: 0, rotation: 0, recycle: 0 }
  const picksPerRound = []
  const popValues = []
  let totalPicks = 0
  let registerDrops = 0
  let reInjections = 0
  let degradedRounds = 0
  let hasMoreRounds = 0
  let duplicates = 0
  let excludedSkips = 0
  const highTargets = { queried: 0, hit: 0, delays: [] }
  const lowTargets = { queried: 0, hit: 0, delays: [] }
  for (const record of records) {
    const stats = record.stats && typeof record.stats === 'object' ? record.stats : record
    const roundPicks = Array.isArray(record.picks)
      ? record.picks.length
      : stats && stats.lanesPicked && typeof stats.lanesPicked === 'object'
        ? Object.values(stats.lanesPicked).reduce((sum, value) => sum + (numberOr(value, 0) || 0), 0)
        : 0
    picksPerRound.push(roundPicks)
    totalPicks += roundPicks
    if (Number.isFinite(Number(stats && stats.pops))) popValues.push(Number(stats.pops))
    if (stats && stats.lanesPicked && typeof stats.lanesPicked === 'object') {
      for (const lane of Object.keys(lanes)) lanes[lane] += numberOr(stats.lanesPicked[lane], 0)
    }
    registerDrops += numberOr(stats && stats.registerDrops, 0)
    reInjections += numberOr(stats && stats.reInjections, 0)
    duplicates += numberOr(stats && stats.duplicates, 0)
    excludedSkips += numberOr(stats && stats.excludedSkips, 0)
    if (stats && stats.degraded === true) degradedRounds += 1
    if ((record && record.hasMore === true) || (stats && stats.hasMore === true)) hasMoreRounds += 1
    for (const target of Array.isArray(record.targets) ? record.targets : []) {
      if (!target || typeof target !== 'object') continue
      const bucket = target.kind === 'high' ? highTargets : target.kind === 'low' ? lowTargets : null
      if (!bucket) continue
      bucket.queried += 1
      if (target.hit === true) {
        bucket.hit += 1
        bucket.delays.push(Math.max(0, numberOr(target.delay, 0)))
      }
    }
  }
  const summarizeBucket = (bucket) => ({
    queried: bucket.queried,
    hit: bucket.hit,
    hitRate: bucket.queried ? bucket.hit / bucket.queried : null,
    delayP50: percentile(bucket.delays, 0.5),
    delayP95: percentile(bucket.delays, 0.95),
    delayMax: bucket.delays.length ? Math.max(...bucket.delays) : null,
  })
  const laneTotal = Object.values(lanes).reduce((sum, value) => sum + value, 0)
  const laneShares = {}
  for (const lane of Object.keys(lanes)) laneShares[lane] = laneTotal ? lanes[lane] / laneTotal : 0
  return {
    rounds: records.length,
    totalPicks,
    picksPerRound: {
      mean: picksPerRound.length ? picksPerRound.reduce((sum, value) => sum + value, 0) / picksPerRound.length : 0,
      p50: percentile(picksPerRound, 0.5),
      p95: percentile(picksPerRound, 0.95),
      max: picksPerRound.length ? Math.max(...picksPerRound) : 0,
    },
    pops: {
      mean: popValues.length ? popValues.reduce((sum, value) => sum + value, 0) / popValues.length : 0,
      p50: percentile(popValues, 0.5),
      p95: percentile(popValues, 0.95),
      max: popValues.length ? Math.max(...popValues) : 0,
    },
    lanes,
    laneShares,
    registerDrops,
    reInjections,
    duplicates,
    excludedSkips,
    degradedRounds,
    hasMoreRounds,
    highTarget: summarizeBucket(highTargets),
    lowTarget: summarizeBucket(lowTargets),
  }
}
