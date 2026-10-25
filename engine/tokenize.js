/**
 * dsh-rofm engine — tokenization, message normalization and keyword
 * extraction.
 *
 * Keyword extraction is dictionary-free (works for Chinese without any word
 * list): text is normalized, Latin/digit tokens are kept verbatim, CJK runs are
 * turned into 2-grams and 3-grams. Candidates are scored by
 * `frequency × length`, filtered through built-in zh+en stopwords + particle
 * characters + CJK trigram evidence, de-duplicated by substring containment and
 * finally capped to `keywords.min..keywords.max`.
 *
 * Token estimate (used only as fallback when the host does not provide real
 * token numbers):
 *
 *   estimateTokens(text) = ceil(latinChars/4 + cjkChars/1.6 + 4)
 *
 * where `cjkChars` counts CJK code points and `latinChars` counts every other
 * non-whitespace character (ASCII letters, digits, punctuation, ...). The `+4`
 * is per-message framing overhead; `estimateMessagesTokens` applies it per
 * message.
 */

import { DEFAULT_CONFIG } from './config.js'

/** Any CJK code point (BMP blocks + supplementary ideographs). */
export const CJK_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u
const CJK_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]+/gu
const LATIN_RUN_RE = /[a-z][a-z0-9_+#.-]*/g
const NUMBER_RE = /\d+(?:\.\d+)*/g

/** Characters that make a CJK n-gram look like a filler fragment. */
const PARTICLE_CHARS = new Set(['的', '了', '着', '过', '呢', '吗', '吧', '啊', '呀', '哦', '嗯', '嘛', '呗', '啦', '哈'])
/** Single-character function words: a gram made ONLY of these is filler. */
const SINGLE_STOP_CHARS = new Set([
  '的', '了', '着', '过', '是', '在', '我', '你', '您', '他', '她', '它', '们', '这', '那',
  '就', '都', '也', '又', '还', '很', '太', '更', '最', '好', '去', '来', '说', '做', '用',
  '会', '能', '要', '把', '被', '给', '让', '从', '到', '对', '于', '与', '和', '及', '等',
  '中', '上', '下', '里', '后', '前', '请', '个', '些', '有', '没', '不', '所', '以', '而',
  '其', '此', '该', '每', '各', '哪', '谁', '啥', '么', '之', '或', '且', '则', '若', '如',
])

/** Lowercase + unicode-normalize (full-width -> half-width) some text. */
export function normalizeText(text) {
  return String(text === undefined || text === null ? '' : text)
    .normalize('NFKC')
    .toLowerCase()
}

function trimToken(token) {
  // Latin runs can greedily swallow trailing separators ("node.js." -> "node.js").
  let out = token
  while (out.length && (out[out.length - 1] === '.' || out[out.length - 1] === '-' || out[out.length - 1] === '_')) out = out.slice(0, -1)
  while (out.length && (out[0] === '.' || out[0] === '-' || out[0] === '_')) out = out.slice(1)
  return out
}

/**
 * Raw tokenization: Latin/digit tokens + every CJK 2/3-gram, in text order.
 * Duplicates are preserved (callers that need counts use this array).
 * Stopword filtering happens later in `extractKeywords`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const normalized = normalizeText(text)
  /** @type {{ index: number, token: string }[]} */
  const found = []

  // Latin / technical tokens (docker, node.js, http2, api_key, c++ ...)
  LATIN_RUN_RE.lastIndex = 0
  let match
  while ((match = LATIN_RUN_RE.exec(normalized)) !== null) {
    const token = trimToken(match[0])
    if (token.length >= 2) found.push({ index: match.index, token })
  }

  // Numeric tokens (ports, versions, ids): 8080, 3.11, 2026.10 ...
  NUMBER_RE.lastIndex = 0
  while ((match = NUMBER_RE.exec(normalized)) !== null) {
    const token = trimToken(match[0])
    if (token.length >= 2) found.push({ index: match.index, token })
  }

  // CJK runs -> 2-grams and 3-grams (single/double runs are emitted as-is).
  CJK_RUN_RE.lastIndex = 0
  while ((match = CJK_RUN_RE.exec(normalized)) !== null) {
    const run = match[0]
    const chars = [...run]
    if (chars.length === 1) {
      found.push({ index: match.index, token: chars[0] })
    } else {
      for (let i = 0; i + 1 < chars.length; i++) {
        found.push({ index: match.index + i, token: chars[i] + chars[i + 1] })
      }
      for (let i = 0; i + 2 < chars.length; i++) {
        found.push({ index: match.index + i, token: chars[i] + chars[i + 1] + chars[i + 2] })
      }
    }
  }

  found.sort((a, b) => a.index - b.index || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
  return found.map((entry) => entry.token)
}

/** Score normalization used by α's `keywords` signal (0..1, capped). */
export function normalizeKeywordScore(score) {
  const s = Number(score)
  if (!Number.isFinite(s) || s <= 0) return 0
  return Math.min(1, s / 12)
}

/**
 * Keyword extraction (dictionary-free) with per-keyword evidence.
 *
 * @param {string} text
 * @param {object} cfg
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {{ keyword: string, score: number, normalized: number, count: number, length: number, kind: 'cjk'|'latin'|'number' }[]}
 */
export function extractKeywordsDetailed(text, cfg, opts = {}) {
  const keywordsCfg = (cfg && cfg.keywords) || DEFAULT_CONFIG.keywords
  const hardMax = Math.max(1, Number.isFinite(opts.max) ? Math.floor(opts.max) : keywordsCfg.max)
  const wantMin = Math.min(hardMax, Math.max(0, Number.isFinite(opts.min) ? Math.floor(opts.min) : keywordsCfg.min))
  const stopwords = new Set(
    [...(keywordsCfg.stopwords || []), ...(keywordsCfg.extraStopwords || [])]
      .map((word) => normalizeText(word).trim())
      .filter(Boolean),
  )

  const occurrences = tokenize(text)
  /** @type {Map<string, { token: string, count: number, first: number, len: number, kind: string }>} */
  const stats = new Map()
  occurrences.forEach((token, index) => {
    let entry = stats.get(token)
    if (!entry) {
      entry = {
        token,
        count: 0,
        first: index,
        len: [...token].length,
        kind: CJK_CHAR_RE.test(token) ? 'cjk' : /^\d/.test(token) ? 'number' : 'latin',
      }
      stats.set(token, entry)
    }
    entry.count += 1
  })

  const candidates = []
  for (const entry of stats.values()) {
    const { token, len, kind, count } = entry
    if (len < 2 || len > 24) continue
    if (stopwords.has(token)) continue
    if (kind === 'cjk') {
      if ([...token].some((ch) => PARTICLE_CHARS.has(ch))) continue
      if ([...token].every((ch) => SINGLE_STOP_CHARS.has(ch))) continue
      if (len === 3 && count < 2) {
        // A one-off 3-gram is usually noise unless one of its bigrams repeats.
        const left = stats.get(token.slice(0, 2))
        const right = stats.get(token.slice(1))
        if ((left ? left.count : 0) < 2 && (right ? right.count : 0) < 2) continue
      }
    }
    const score = count * Math.min(len, 10)
    if (score <= 0) continue
    candidates.push({ ...entry, score })
  }

  candidates.sort((a, b) => b.score - a.score || b.len - a.len || a.first - b.first || (a.token < b.token ? -1 : 1))

  // Evidence threshold: drop one-off sliding-window fragments (e.g. "口配" from
  // "端口配置") when the text has at least one strong keyword. Short texts fall
  // back to filling up to keywords.min from every candidate.
  const bestScore = candidates.length > 0 ? candidates[0].score : 0
  const threshold = Math.max(3, bestScore * 0.15)

  const selected = []
  const dedupedAway = []
  const belowThreshold = []
  for (const candidate of candidates) {
    if (candidate.score < threshold) {
      belowThreshold.push(candidate)
      continue
    }
    if (selected.length >= hardMax) break
    const overlaps = selected.some((chosen) => chosen.token.includes(candidate.token) || candidate.token.includes(chosen.token))
    if (overlaps) {
      dedupedAway.push(candidate)
      continue
    }
    selected.push(candidate)
  }
  // Try to satisfy keywords.min even when the evidence threshold/de-duplication
  // were aggressive.
  for (const candidate of [...dedupedAway, ...belowThreshold]) {
    if (selected.length >= wantMin) break
    if (selected.some((chosen) => chosen.token === candidate.token)) continue
    selected.push(candidate)
  }
  selected.sort((a, b) => b.score - a.score || b.len - a.len || a.first - b.first)

  return selected.slice(0, hardMax).map((candidate) => ({
    keyword: candidate.token,
    score: candidate.score,
    normalized: normalizeKeywordScore(candidate.score),
    count: candidate.count,
    length: candidate.len,
    kind: candidate.kind,
  }))
}

/**
 * Extract the most informative keywords.
 * @param {string} text
 * @param {object} cfg
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {string[]}
 */
export function extractKeywords(text, cfg, opts) {
  return extractKeywordsDetailed(text, cfg, opts).map((entry) => entry.keyword)
}

// ---------------------------------------------------------------------------
// keyword matching
// ---------------------------------------------------------------------------

const WORD_CHAR = /[a-z0-9_]/

function isWordCode(code) {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code === 95
}

/** Latin keyword matching with word boundaries ("dock" must not match "docker"). */
function latinWordBoundaryMatch(text, keyword) {
  if (!keyword) return false
  let from = 0
  while (from <= text.length - keyword.length) {
    const index = text.indexOf(keyword, from)
    if (index < 0) return false
    const before = index === 0 ? -1 : text.charCodeAt(index - 1)
    const after = index + keyword.length >= text.length ? -1 : text.charCodeAt(index + keyword.length)
    if ((before === -1 || !isWordCode(before)) && (after === -1 || !isWordCode(after))) return true
    from = index + 1
  }
  return false
}

function cjkSegments(text) {
  return text.split(/[^\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]+/u).filter(Boolean)
}

/**
 * Match a folder keyword against an ALREADY normalized haystack.
 * `contains` (default): CJK substring / Latin word-boundary match.
 * `exact`: exact token equality (CJK: 2/3-gram token; Latin: whole token).
 *
 * @param {string} normalizedText
 * @param {string} keyword
 * @param {'contains'|'exact'} [matchMode]
 */
export function keywordMatches(normalizedText, keyword, matchMode = 'contains') {
  const text = normalizedText || ''
  const keywordNormalized = normalizeText(keyword).trim()
  if (!text || !keywordNormalized) return false
  const isCjk = CJK_CHAR_RE.test(keywordNormalized)
  if (matchMode === 'exact') {
    if (isCjk) {
      if ([...keywordNormalized].length === 1) return cjkSegments(text).includes(keywordNormalized)
      const tokens = new Set(tokenize(text).filter((token) => CJK_CHAR_RE.test(token)))
      return tokens.has(keywordNormalized)
    }
    return tokenize(text).includes(keywordNormalized)
  }
  if (isCjk) return text.includes(keywordNormalized)
  return latinWordBoundaryMatch(text, keywordNormalized)
}

/**
 * Match a keyword against raw haystack text.
 * @param {string} haystack
 * @param {string} keyword
 * @param {'contains'|'exact'} [matchMode]
 */
export function matchesKeyword(haystack, keyword, matchMode = 'contains') {
  return keywordMatches(normalizeText(haystack), keyword, matchMode)
}

/**
 * Count how many `keywords` match `haystack` (normalization done once).
 * @param {string} haystack
 * @param {string[]} keywords
 * @param {'contains'|'exact'} [matchMode]
 * @param {string} [normalizedHaystack] pre-normalized haystack (optimization)
 */
export function countKeywordMatches(haystack, keywords, matchMode = 'contains', normalizedHaystack) {
  const text = typeof normalizedHaystack === 'string' ? normalizedHaystack : normalizeText(haystack)
  if (!Array.isArray(keywords) || !keywords.length) return 0
  let count = 0
  for (const keyword of keywords) {
    if (keywordMatches(text, keyword, matchMode)) count += 1
  }
  return count
}

/** Whether two keyword lists share at least one (normalized) keyword. */
export function sharedKeywordCount(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0
  const setA = new Set(a.map((keyword) => normalizeText(keyword).trim()).filter(Boolean))
  let count = 0
  const seen = new Set()
  for (const keyword of b) {
    const normalized = normalizeText(keyword).trim()
    if (normalized && setA.has(normalized) && !seen.has(normalized)) {
      seen.add(normalized)
      count += 1
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// message normalization / rendering / token estimation
// ---------------------------------------------------------------------------

/** @typedef {{ role: string, content: string, time?: number, name?: string, tokens?: number }} MemMessage */

const ROLE_MAP = {
  user: 'user',
  assistant: 'assistant',
  ai: 'assistant',
  model: 'assistant',
  tool: 'tool',
  'tool-result': 'tool',
  tool_result: 'tool',
  function: 'tool',
  system: 'system',
  developer: 'developer',
}

function normalizeRole(role) {
  if (typeof role !== 'string') return 'user'
  const key = role.trim().toLowerCase()
  return ROLE_MAP[key] || key || 'user'
}

function toolNameOf(block) {
  if (typeof block.name === 'string' && block.name) return block.name
  if (typeof block.toolName === 'string' && block.toolName) return block.toolName
  if (block.tool && typeof block.tool.name === 'string' && block.tool.name) return block.tool.name
  if (block.function && typeof block.function.name === 'string' && block.function.name) return block.function.name
  if (typeof block.tool_name === 'string' && block.tool_name) return block.tool_name
  return ''
}

function blockToText(block) {
  if (block === null || block === undefined) return ''
  if (typeof block === 'string') return block
  if (typeof block !== 'object') return String(block)
  const type = typeof block.type === 'string' ? block.type : ''
  switch (type) {
    case 'text':
    case 'input_text':
    case 'output_text':
      return typeof block.text === 'string' ? block.text : ''
    case 'tool-call':
    case 'tool_use':
    case 'tool_call': {
      const name = toolNameOf(block)
      return name ? `[tool-call: ${name}]` : '[tool-call]'
    }
    case 'tool-result':
    case 'tool_result':
    case 'tool-output': {
      const name = toolNameOf(block)
      return name ? `[tool-result: ${name}]` : '[tool-result]'
    }
    case 'image':
    case 'image_url':
    case 'input_image':
      return '[image]'
    case 'file':
    case 'file_url':
    case 'input_file':
      return typeof block.name === 'string' && block.name ? `[file: ${block.name}]` : '[file]'
    case 'reasoning':
    case 'thinking':
      return '[reasoning]'
    default:
      if (typeof block.text === 'string') return block.text
      return type ? `[${type}]` : '[block]'
  }
}

/** Join a message content value (string or DSH content blocks) into text. */
export function contentToText(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => blockToText(block))
      .filter((part) => part !== '')
      .join('\n')
  }
  if (typeof content === 'object') return blockToText(content)
  return String(content)
}

/**
 * Convert DSH-like message objects into the engine-neutral `MemMessage[]`.
 * @param {any[]} raw
 * @returns {MemMessage[]}
 */
export function normalizeMessages(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const message = {
      role: normalizeRole(item.role),
      content: contentToText(item.content),
    }
    if (typeof item.time === 'number' && Number.isFinite(item.time)) message.time = item.time
    if (typeof item.name === 'string' && item.name) message.name = item.name
    if (typeof item.tokens === 'number' && Number.isFinite(item.tokens) && item.tokens >= 0) message.tokens = item.tokens
    out.push(message)
  }
  return out
}

/**
 * Render one message as plain text (`"user: ..."`), so every message can be
 * reconstructed as text for prompts/token estimates.
 * @param {MemMessage|{role?: string, content?: any}} message
 * @returns {string}
 */
export function renderMessage(message) {
  const role = (message && typeof message.role === 'string' && message.role) || 'user'
  const content = message && typeof message.content === 'string' ? message.content : contentToText(message && message.content)
  return `${role}: ${content}`
}

/**
 * Fallback token estimate: ceil(latinChars/4 + cjkChars/1.6 + 4).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const value = String(text === undefined || text === null ? '' : text)
  let cjkChars = 0
  let latinChars = 0
  for (const char of value) {
    if (CJK_CHAR_RE.test(char)) cjkChars += 1
    else if (!/\s/.test(char)) latinChars += 1
  }
  return Math.ceil(latinChars / 4 + cjkChars / 1.6 + 4)
}

/**
 * Token estimate for a whole message list.
 * @param {MemMessage[]} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) total += estimateTokens(renderMessage(message))
  return total
}
