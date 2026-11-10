/**
 * dsh-rofm engine — v1.5.0 query analysis.
 *
 * One deterministic pre-pass over the user message that drives the new recall
 * behaviours (docs/SPEC.md §6.11):
 *
 *   - clause splitting: a message with several sub-questions ("A？还有 B？") is
 *     split on 。！？；/newline so every clause can be searched (and answered)
 *     separately;
 *   - tag mentions: known location/person/event tag names in the message became
 *     hard filters (`recall.tagMentions`);
 *   - fuzzy time expressions ("昨天", "下周二") are converted to absolute windows
 *     by engine/relative-time.js (time tags are matched, not plain text);
 *   - "you said" quotes ("你说过/你之前说/你建议/你答应/你让我/你不是说") enable
 *     the assistant-utterance recall channel;
 *   - complexity detection for the adaptive recall quota (20 for complex/large
 *     questions).
 *
 * Everything here is pure / failure-safe: garbage input yields empty results and
 * never throws.
 */

import { RECALL_KEYWORDS_MAX, extractKeywords } from './tokenize.js'
import { detectTagMentions } from './tag-index.js'
import { detectQueryTimes } from './relative-time.js'

/**
 * Fixed phrase list of "you told me so" quotes. Kept in code (not config) so the
 * detector is a stable, zero-config product rule; `recall.assistantSaid.enabled`
 * switches the whole channel off.
 */
export const ASSISTANT_SAID_PHRASES = Object.freeze([
  '你说过',
  '你有没有说过',
  '你是不是说过',
  '你之前说',
  '你以前说',
  '你上次说',
  '你刚才说',
  '你刚说',
  '你前面说',
  '你上面说',
  '你建议',
  '你推荐',
  '你答应',
  '你承诺',
  '你让我',
  '你不是说',
  '你不是答应',
  '你说的是',
  '你讲的',
  '你讲过',
  '你提到过',
  '你告诉过我',
  '你好像说过',
  '你好像说过吧',
])

/** Clause separators: sentence-final punctuation and hard line breaks (user decision). */
const CLAUSE_SPLIT_RE = /[。！？；!?;\n\r]+/
/** Trailing/leading whitespace and stray separators trimmed from a clause. */
const CLAUSE_TRIM_RE = /^[\s，,、：:…—\-·]+|[\s，,、：:…—\-·]+$/g

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function integerOr(value, fallback) {
  const numeric = Number(value)
  return Number.isInteger(numeric) ? numeric : fallback
}

function clampInt(value, fallback, min, max) {
  const numeric = integerOr(value, fallback)
  if (numeric < min) return min
  if (numeric > max) return max
  return numeric
}

/** Effective `recall.clauseSplit` config with contract defaults. */
export function clauseSplitConfig(cfg) {
  const group = objectOf(objectOf(cfg).recall).clauseSplit
  const source = objectOf(group)
  return {
    enabled: source.enabled !== false,
    maxClauses: clampInt(source.maxClauses, 8, 1, 32),
    minClauseChars: clampInt(source.minClauseChars, 2, 1, 64),
  }
}

/**
 * Split one user message into clauses (deterministic, punctuation based).
 *
 * - separators: 。！？；!?; and newlines (NOT comma/、 by product decision);
 * - whitespace/punctuation-only fragments are dropped, `minClauseChars` filters
 *   too-short fragments unless that would drop everything;
 * - more than `maxClauses` clauses are merged into the last one (never silently
 *   loses text);
 * - a single-clause message returns `[trimmed]`; empty/non-string input `[]`.
 *
 * @param {unknown} text
 * @param {object} [cfg]
 * @returns {string[]}
 */
export function splitClauses(text, cfg) {
  if (typeof text !== 'string') return []
  const source = text.trim()
  if (!source) return []
  const effective = clauseSplitConfig(cfg)
  if (!effective.enabled) return [source]
  const raw = source.split(CLAUSE_SPLIT_RE)
  const clauses = []
  for (const part of raw) {
    const clause = part.replace(CLAUSE_TRIM_RE, '').trim()
    if (!clause) continue
    if ([...clause].length < effective.minClauseChars) continue
    clauses.push(clause)
  }
  if (clauses.length === 0) return [source]
  if (clauses.length <= effective.maxClauses) return clauses
  const head = clauses.slice(0, effective.maxClauses - 1)
  const tail = clauses.slice(effective.maxClauses - 1).join('；')
  head.push(tail)
  return head
}

/**
 * Detect a "you said …" quote in the user message.
 *
 * @param {unknown} text
 * @param {object} [cfg]
 * @returns {{ hit: boolean, phrases: string[], quoted: string, keywords: string[] }}
 */
export function detectAssistantSaid(text, cfg) {
  const result = { hit: false, phrases: [], quoted: '', keywords: [] }
  if (typeof text !== 'string' || !text.trim()) return result
  const assistantCfg = objectOf(objectOf(objectOf(cfg).recall).assistantSaid)
  if (assistantCfg.enabled === false) return result
  let firstAt = -1
  let firstPhrase = ''
  const phrases = []
  for (const phrase of ASSISTANT_SAID_PHRASES) {
    const at = text.indexOf(phrase)
    if (at < 0) continue
    phrases.push(phrase)
    if (firstAt < 0 || at < firstAt) {
      firstAt = at
      firstPhrase = phrase
    }
  }
  if (phrases.length === 0) return result
  result.hit = true
  result.phrases = phrases.slice(0, 8)
  // The quoted content is approximated by the remainder of the message after the
  // first quote phrase; it is only used for the model hint / keyword expansion,
  // never as a hard fact.
  result.quoted = firstAt >= 0 ? text.slice(firstAt + firstPhrase.length).trim().slice(0, 200) : ''
  try {
    // The "you said" channel keeps its own, narrower pre-1.6 cap (8). The main
    // query cap (RECALL_KEYWORDS_MAX = 16) and the archival cfg.keywords.max (16)
    // intentionally do not apply to this channel's keyword expansion.
    result.keywords = extractKeywords(text, cfg, { max: 8 })
  } catch {
    result.keywords = []
  }
  return result
}

/** Effective `recall.adaptiveQuota` config with contract defaults. */
export function adaptiveQuotaConfig(cfg) {
  const group = objectOf(objectOf(cfg).recall).adaptiveQuota
  const source = objectOf(group)
  return {
    enabled: source.enabled !== false,
    complexQuota: clampInt(source.complexQuota, 20, 1, 64),
    complexMinClauses: clampInt(source.complexMinClauses, 2, 1, 32),
    complexMinChars: clampInt(source.complexMinChars, 160, 1, 1000000),
    complexMinKeywords: clampInt(source.complexMinKeywords, 8, 1, 128),
  }
}

/**
 * Whether a message counts as complex/large for the adaptive recall quota.
 *
 * A message is complex when it has several clauses, is long, or carries many
 * keywords (any one is enough). Deterministic; no model call.
 *
 * @param {{ clauses?: string[]|number, chars?: number, keywords?: string[] }} analysis
 * @param {object} [cfg]
 * @returns {boolean}
 */
export function isComplexQuery(analysis, cfg) {
  const effective = adaptiveQuotaConfig(cfg)
  if (!effective.enabled) return false
  const source = objectOf(analysis)
  const clauseCount = Array.isArray(source.clauses) ? source.clauses.length : Number(source.clauses) || 0
  const chars = Number(source.chars) || 0
  const keywordCount = Array.isArray(source.keywords) ? source.keywords.length : Number(source.keywords) || 0
  return clauseCount >= effective.complexMinClauses || chars >= effective.complexMinChars || keywordCount >= effective.complexMinKeywords
}

/**
 * Effective per-round recall quota: `recall.firstGenMax`, raised to
 * `recall.adaptiveQuota.complexQuota` for complex/large questions.
 *
 * @param {{ complex?: boolean }|null} analysis
 * @param {object} [cfg]
 * @returns {number}
 */
export function effectiveRecallQuota(analysis, cfg) {
  const recallCfg = objectOf(objectOf(cfg).recall)
  const base = Number.isFinite(Number(recallCfg.firstGenMax)) ? Math.max(0, Math.floor(Number(recallCfg.firstGenMax))) : 10
  const effective = adaptiveQuotaConfig(cfg)
  if (!effective.enabled) return base
  const complex = analysis && typeof analysis === 'object' ? analysis.complex === true : false
  if (!complex) return base
  return Math.max(base, effective.complexQuota)
}

/** Effective `recall.tagMentions` config with contract defaults. */
export function tagMentionsConfig(cfg) {
  const source = objectOf(objectOf(objectOf(cfg).recall).tagMentions)
  return { enabled: source.enabled !== false, maxTagsPerKind: clampInt(source.maxTagsPerKind, 4, 1, 32) }
}

/**
 * Full deterministic query analysis for one user message.
 *
 * @param {{
 *   text: unknown,
 *   cfg?: object,
 *   now?: number,
 *   tagIndex?: object|null,
 * }} input
 * @returns {{
 *   text: string, chars: number, clauses: string[], keywords: string[],
 *   tags: { location: string[], person: string[], event: string[] },
 *   timeWindows: Array<{label: string, from: number, to: number, granularity: string}>,
 *   assistantSaid: { hit: boolean, phrases: string[], quoted: string, keywords: string[] },
 *   complex: boolean, quota: number,
 * }}
 */
export function analyzeQuery(input = {}) {
  const source = objectOf(input)
  const cfg = objectOf(source.cfg)
  const text = typeof source.text === 'string' ? source.text : ''
  const now = Number.isFinite(Number(source.now)) ? Number(source.now) : Date.now()
  const clauses = splitClauses(text, cfg)
  let keywords = []
  try {
    // Query-side cap stays at the pre-1.6 value (16); the archival
    // cfg.keywords.max (16 = one folder's keyword budget) never widens queries.
    keywords = extractKeywords(text, cfg, { max: RECALL_KEYWORDS_MAX })
  } catch {
    keywords = []
  }
  let tags = { location: [], person: [], event: [] }
  const tagMentions = tagMentionsConfig(cfg)
  if (tagMentions.enabled && source.tagIndex && typeof source.tagIndex === 'object') {
    try {
      const detected = detectTagMentions(source.tagIndex, text, cfg)
      tags = {
        location: Array.isArray(detected.location) ? detected.location.slice(0, tagMentions.maxTagsPerKind) : [],
        person: Array.isArray(detected.person) ? detected.person.slice(0, tagMentions.maxTagsPerKind) : [],
        event: Array.isArray(detected.event) ? detected.event.slice(0, tagMentions.maxTagsPerKind) : [],
      }
    } catch {
      tags = { location: [], person: [], event: [] }
    }
  }
  let timeWindows = []
  try {
    const timeTagCfg = objectOf(cfg.timeTag)
    if (timeTagCfg.mode !== 'off' && text.trim()) timeWindows = detectQueryTimes(text, now, cfg)
  } catch {
    timeWindows = []
  }
  const assistantSaid = detectAssistantSaid(text, cfg)
  const complex = isComplexQuery({ clauses, chars: text.length, keywords }, cfg)
  return {
    text,
    chars: text.length,
    clauses,
    keywords,
    tags,
    timeWindows: Array.isArray(timeWindows) ? timeWindows.slice(0, 8) : [],
    assistantSaid,
    complex,
    quota: effectiveRecallQuota({ complex }, cfg),
  }
}
