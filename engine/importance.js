/**
 * dsh-rofm engine — α (per-folder importance) heuristic.
 *
 * α is NOT "how much should we keep this context": it is the probability
 * multiplier used when a folder is recalled (see recall.js). High α means the
 * folder is recalled very eagerly, so values above `importance.warnAbove`
 * produce a warning on `cfg.warnings` as well.
 *
 * Five deterministic signals in [0, 1] are combined with normalized weights:
 *   keywords     — average normalized keyword evidence of the folder text
 *   decisions    — decision/constraint markers per 100 chars (capped at 1)
 *   userDensity  — user-authored chars / total chars
 *   code         — code fences / URLs / versions / paths evidence
 *   recency      — chronological position when a span is split into folders
 */

import { DEFAULT_CONFIG } from './config.js'
import { contentToText, extractKeywordsDetailed } from './tokenize.js'

/** Decision / constraint markers (Latin markers use word boundaries). */
export const DECISION_MARKERS = [
  'must', 'never', 'always', 'should', 'remember', 'important',
  '决定', '必须', '不要', '禁止', '记住', '重要', '方案', '配置', '参数',
  '修复', '错误', '注意', '约定', '接口', '版本', 'TODO', 'FIXME', 'bug', 'api',
]

const LATIN_DECISION_RE = new RegExp(
  `\\b(?:${DECISION_MARKERS.filter((marker) => /^[A-Za-z]+$/.test(marker)).join('|')})\\b`,
  'gi',
)
const CJK_DECISION_MARKERS = DECISION_MARKERS.filter((marker) => /[\u3400-\u4DBF\u4E00-\u9FFF]/.test(marker))

const URL_RE = /https?:\/\/[^\s<>"')]+/gi
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?\b/gi
/**
 * Windows absolute path (`C:\x`, `C:/x`). The lookbehind stops the regex from
 * grabbing the `s:/…` tail of a URL scheme or the `n:/bin` tail of a POSIX
 * PATH list (`PATH=/usr/bin:/bin`) as a drive-letter path.
 */
const WINDOWS_PATH_RE = /(?<![A-Za-z0-9_+.-])[A-Za-z]:[\\/][^\s"'`]+/g
/**
 * POSIX path evidence: absolute (`/usr/bin/node`), relative (`./src/a.js`,
 * `../docs/spec.md`) and home-relative (`~/proj/a.js`) paths. The path must
 * start at the beginning of the text or after whitespace/a quote/a bracket/
 * `=`/`:` so prose such as dates (`2026/10/31`) never counts; a leading `//`
 * is rejected so protocol-relative URLs are not counted as paths either.
 */
const POSIX_PATH_RE = /(?:^|[\s("'`=:;,|[{（【「『《：，；])(?:~\/|\.{0,2}\/(?!\/))[^\s"'`]+/g

const clamp01 = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  if (number <= 0) return 0
  if (number >= 1) return 1
  return number
}

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100

function countMatches(text, regex) {
  regex.lastIndex = 0
  let count = 0
  while (regex.exec(text) !== null) count += 1
  return count
}

function countDecisionMarkers(text) {
  let count = countMatches(text, LATIN_DECISION_RE)
  for (const marker of CJK_DECISION_MARKERS) {
    let from = 0
    while (from <= text.length - marker.length) {
      const index = text.indexOf(marker, from)
      if (index < 0) break
      count += 1
      from = index + marker.length
    }
  }
  return count
}

function codeSignal(text) {
  const fences = countMatches(text, /```/g)
  const urls = countMatches(text, URL_RE)
  const versions = countMatches(text, VERSION_RE)
  const paths = countMatches(text, WINDOWS_PATH_RE) + countMatches(text, POSIX_PATH_RE)
  return clamp01(Math.min(1, fences * 0.5 + urls * 0.3 + versions * 0.1 + paths * 0.1))
}

/** @typedef {{ keywords: number, decisions: number, userDensity: number, code: number, recency: number }} ImportanceSignals */

/**
 * Compute deterministic α for a span of messages.
 *
 * @param {import('./tokenize.js').MemMessage[]} messages
 * @param {object} cfg
 * @param {{ recency?: number, index?: number, folderCount?: number, warnings?: string[] }} [context]
 *   `recency`: explicit value in [0,1] (used when a run splits into folders).
 *   `index`/`folderCount`: 0-based position -> `index / max(1, folderCount-1)`.
 * @returns {{ alpha: number, signals: ImportanceSignals, warnings: string[] }}
 */
export function computeImportance(messages, cfg, context = {}) {
  const config = cfg && cfg.importance ? cfg : DEFAULT_CONFIG
  const importanceCfg = config.importance
  const warnings = []
  const list = Array.isArray(messages) ? messages : []
  // Signal text is the message *content* only: role prefixes ("user: ") would
  // otherwise win keyword extraction and inflate the code/decision signals.
  const contents = list.map((message) => contentToText(message && message.content))
  const text = contents.join('\n')

  // keywords signal: average normalized evidence of the extracted keywords.
  const keywords = extractKeywordsDetailed(text, config)
  const keywordsSignal = keywords.length
    ? clamp01(keywords.reduce((sum, entry) => sum + entry.normalized, 0) / keywords.length)
    : 0

  // decisions signal: density per 100 chars, capped at 1.
  const chars = Math.max(1, text.length)
  const decisionsSignal = clamp01(countDecisionMarkers(text) / (chars / 100))

  // userDensity signal: user-authored characters / total characters.
  let userChars = 0
  let totalChars = 0
  for (let index = 0; index < list.length; index += 1) {
    const length = contents[index].length
    totalChars += length
    if (list[index] && list[index].role === 'user') userChars += length
  }
  const userDensitySignal = clamp01(userChars / Math.max(1, totalChars))

  const code = codeSignal(text)

  let recency
  if (context && Number.isFinite(context.recency)) {
    recency = clamp01(context.recency)
  } else if (context && Number.isFinite(context.index) && Number.isFinite(context.folderCount)) {
    recency = clamp01(context.index / Math.max(1, context.folderCount - 1))
  } else {
    recency = 0.5
  }

  const signals = {
    keywords: round2(keywordsSignal),
    decisions: round2(decisionsSignal),
    userDensity: round2(userDensitySignal),
    code: round2(code),
    recency: round2(recency),
  }

  const weights = importanceCfg.weights || DEFAULT_CONFIG.importance.weights
  const keys = Object.keys(DEFAULT_CONFIG.importance.weights)
  const weightSum = keys.reduce((sum, key) => sum + (Number(weights[key]) || 0), 0)
  let weightedMean = 0
  if (weightSum > 0) {
    for (const key of keys) {
      weightedMean += (Number(weights[key]) || 0) * (Number(signals[key]) || 0)
    }
    weightedMean /= weightSum
  }

  const min = Number(importanceCfg.min)
  const max = Number(importanceCfg.max)
  const alphaRaw = min + (max - min) * clamp01(weightedMean)
  let alpha = round2(Math.min(max, Math.max(min, alphaRaw)))
  alpha = Math.min(max, Math.max(min, alpha))

  if (alpha > Number(importanceCfg.warnAbove)) {
    const warning = `alpha=${alpha} exceeds importance.warnAbove=${importanceCfg.warnAbove}; high importance makes recall likely — set it deliberately`
    warnings.push(warning)
    // Deduplicated: a long-lived engine config is reused for every compression
    // pass, so pushing the same string on each call grew cfg.warnings (and every
    // plan copy of it) without bound.
    if (Array.isArray(config.warnings) && !config.warnings.includes(warning)) config.warnings.push(warning)
    if (context && Array.isArray(context.warnings)) context.warnings.push(warning)
  }

  return { alpha, signals, warnings }
}

/**
 * Convenience wrapper: α only.
 * @param {import('./tokenize.js').MemMessage[]} messages
 * @param {object} cfg
 * @param {object} [context]
 * @returns {number}
 */
export function alphaForFolder(messages, cfg, context) {
  return computeImportance(messages, cfg, context).alpha
}
