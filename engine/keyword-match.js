/**
 * dsh-rofm engine — bidirectional keyword matching + match quality.
 *
 * v1.3.0 only checked one direction: *folder keyword ⊆ user text* (CJK
 * substring / Latin word boundary, engine/tokenize.js `keywordMatches`). That
 * misses natural paraphrases, multi-word keywords and "user says a short piece
 * of a phrase" cases (P0-5). This module keeps the v1.3.0 direction as the
 * baseline (so any folder that used to match still matches — hard no-regression
 * constraint, contract §5.2) and adds:
 *
 *   direction 2 — a user-text token that appears inside the folder keyword
 *                 ("接口网关 8080" also matches when the user only says "网关",
 *                 and multi-word phrases match through their parts);
 *   phraseHit   — a multi-word folder keyword matched as a whole phrase;
 *   titleHit    — an optional folder title token appears in the user text.
 *
 * `match.expandLatinCase` / `match.cjkBigram` are opt-in expansions (default
 * OFF, contract §4): when enabled they can only *add* matches, never remove
 * one, so the default product behaviour is unchanged.
 *
 * This file is only used for fair/deterministic relevance signals (legacy
 * probability recall keeps using `countKeywordMatches` directly).
 */

import { CJK_CHAR_RE, keywordMatches, normalizeText, tokenize } from './tokenize.js'

/** ASCII word characters (mirrors engine/tokenize.js `isWordCode`). */
const WORD_CHAR_RE = /[a-z0-9_]/

/** Bounded cache of normalized-text facts (text tokens / compact form). */
const TEXT_CACHE = new Map()
const MAX_TEXT_CACHE = 64

function isWordChar(char) {
  return typeof char === 'string' && char.length === 1 && WORD_CHAR_RE.test(char)
}

/** Normalize a folder keyword; non-strings and duplicates are dropped. */
function normalizeKeywords(folderKeywords) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(folderKeywords)) return out
  for (const keyword of folderKeywords) {
    if (typeof keyword !== 'string') continue
    const normalized = normalizeText(keyword).trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/** Remove Latin separators so "node.js" and "nodejs" compare equal. */
function compactLatin(text) {
  return String(text).replace(/[._\-+#]/g, '')
}

/**
 * Text facts for one normalized haystack: unique tokens of length >= 2 and the
 * separator-free form (used only by `expandLatinCase`). Cached because the
 * adapter calls `matchKeywords` once per candidate folder with the same text.
 */
function textFacts(normalizedText) {
  const cached = TEXT_CACHE.get(normalizedText)
  if (cached) {
    TEXT_CACHE.delete(normalizedText)
    TEXT_CACHE.set(normalizedText, cached)
    return cached
  }
  const tokens = []
  const seen = new Set()
  for (const token of tokenize(normalizedText)) {
    if (!token || token.length < 2 || seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
  }
  const facts = {
    tokens,
    compact: compactLatin(normalizedText),
    hasCjk: CJK_CHAR_RE.test(normalizedText),
  }
  TEXT_CACHE.set(normalizedText, facts)
  if (TEXT_CACHE.size > MAX_TEXT_CACHE) {
    const oldest = TEXT_CACHE.keys().next()
    if (!oldest.done) TEXT_CACHE.delete(oldest.value)
  }
  return facts
}

/** Latin token must appear as a whole word inside the keyword (default rule). */
function latinWordContained(keyword, token) {
  let from = 0
  while (from <= keyword.length - token.length) {
    const at = keyword.indexOf(token, from)
    if (at < 0) return false
    const before = at === 0 ? '' : keyword[at - 1]
    const after = at + token.length >= keyword.length ? '' : keyword[at + token.length]
    if (!isWordChar(before) && !isWordChar(after)) return true
    from = at + 1
  }
  return false
}

/**
 * Direction 2: does any user-text token appear inside the folder keyword?
 * CJK tokens use plain containment; Latin tokens use a word boundary inside
 * the keyword unless `expandLatinCase` relaxes it to a substring/compound match.
 */
function tokenInsideKeyword(keyword, facts, expandLatinCase) {
  for (const token of facts.tokens) {
    if (CJK_CHAR_RE.test(token)) {
      if (keyword.includes(token)) return true
      continue
    }
    if (expandLatinCase) {
      if (keyword.includes(token)) return true
      if (facts.compact.includes(compactLatin(token)) && compactLatin(keyword).includes(compactLatin(token))) return true
      continue
    }
    if (latinWordContained(keyword, token)) return true
  }
  return false
}

/**
 * `cjkBigram` expansion: a long CJK keyword matches when at least half of its
 * bigrams appear anywhere in the user text. It is a monotone (add-only) safety
 * net on top of direction 2.
 */
function cjkBigramHit(normalizedText, keyword) {
  const chars = [...keyword]
  if (chars.length < 2) return false
  const bigrams = []
  for (let at = 0; at + 1 < chars.length; at += 1) bigrams.push(chars[at] + chars[at + 1])
  if (!bigrams.length) return false
  let present = 0
  for (const bigram of bigrams) if (normalizedText.includes(bigram)) present += 1
  return present >= Math.max(1, Math.ceil(bigrams.length / 2))
}

/** `expandLatinCase`: separator-insensitive Latin substring match. */
function latinCompoundHit(normalizedText, keyword, facts) {
  if (!keyword) return false
  if (normalizedText.includes(keyword)) return true
  const compactKeyword = compactLatin(keyword)
  return compactKeyword.length >= 2 && facts.compact.includes(compactKeyword)
}

/** Read the two opt-in match flags from `cfg.match` (default OFF). */
function matchOptionsOf(cfg) {
  const match = cfg && typeof cfg === 'object' && cfg.match && typeof cfg.match === 'object' ? cfg.match : {}
  return {
    expandLatinCase: match.expandLatinCase === true,
    cjkBigram: match.cjkBigram === true,
  }
}

/** Read the configured keyword match mode (v1.3.0: 'contains' | 'exact'). */
function matchModeOf(cfg) {
  const keywords = cfg && typeof cfg === 'object' && cfg.keywords && typeof cfg.keywords === 'object' ? cfg.keywords : {}
  return keywords.matchMode === 'exact' ? 'exact' : 'contains'
}

/**
 * Bidirectional keyword match + quality score.
 *
 * @param {string} normalizedUserText user text (normalized by the caller; this
 *   function normalizes defensively again — the operation is idempotent)
 * @param {string[]} folderKeywords raw folder keywords
 * @param {object} [cfg] validated engine config (reads `match.*` / `keywords.matchMode`)
 * @param {{ title?: string }} [options] optional folder title for `titleHit`
 * @returns {{ matchCount: number, phraseHit: boolean, titleHit: boolean, matched: string[] }}
 */
export function matchKeywords(normalizedUserText, folderKeywords, cfg, options = {}) {
  const text = normalizeText(normalizedUserText)
  const keywords = normalizeKeywords(folderKeywords)
  const result = { matchCount: 0, phraseHit: false, titleHit: false, matched: [] }
  if (!text || !keywords.length) return result
  const facts = textFacts(text)
  const { expandLatinCase, cjkBigram } = matchOptionsOf(cfg)
  const matchMode = matchModeOf(cfg)
  for (const keyword of keywords) {
    const isCjk = CJK_CHAR_RE.test(keyword)
    // Direction 1 — the exact v1.3.0 predicate: every folder keyword that
    // keywordMatches() accepts must be matched here too (no regression).
    let hit = keywordMatches(text, keyword, matchMode)
    if (hit && keyword.includes(' ')) result.phraseHit = true
    // Direction 2 — a user token appears inside the folder keyword.
    if (!hit) hit = tokenInsideKeyword(keyword, facts, expandLatinCase)
    // Opt-in expansions.
    if (!hit && isCjk && cjkBigram) hit = cjkBigramHit(text, keyword)
    if (!hit && !isCjk && expandLatinCase) hit = latinCompoundHit(text, keyword, facts)
    if (!hit) continue
    result.matchCount += 1
    result.matched.push(keyword)
  }
  // Optional title hit (title words are matched against the user text).
  const title = options && typeof options.title === 'string' ? normalizeText(options.title).trim() : ''
  if (title) {
    if (text.includes(title)) {
      result.titleHit = true
    } else {
      const titleTokens = new Set()
      for (const token of tokenize(title)) if (token && token.length >= 2) titleTokens.add(token)
      for (const token of titleTokens) {
        if (keywordMatches(text, token, matchMode)) {
          result.titleHit = true
          break
        }
      }
    }
  }
  return result
}

/**
 * Fast path: does the folder match the user text at all?
 *
 * @param {string} normalizedUserText
 * @param {string[]} folderKeywords
 * @param {object} [cfg]
 * @returns {boolean}
 */
export function hasMatch(normalizedUserText, folderKeywords, cfg) {
  return matchKeywords(normalizedUserText, folderKeywords, cfg).matchCount > 0
}
