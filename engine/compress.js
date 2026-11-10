/**
 * dsh-rofm engine — compression planning + commit.
 *
 * `planCompression` is pure (nothing is written): it decides how much of the
 * earliest model-visible context to move into recall folders. `commitCompression`
 * writes the planned folders atomically, updates `index.json`, appends the
 * `compress` telemetry event and is idempotent-safe: committing the same plan
 * twice does not duplicate folders.
 *
 * Selection rules (docs/SPEC.md §5):
 * - only when `usedPercent > compress.triggerPercent` and the context is big enough;
 * - the removed span is the earliest `compressPercent` percent of the *used*
 *   context (token weighted, using real `totalUsedTokens` when the host provides
 *   it, otherwise the estimate of `messages`);
 * - the cut is extended to the end of the last user turn, so no assistant
 *   tool-call is ever separated from its `tool` result and the remaining history
 *   starts at a user message whenever possible;
 * - the newest `keepRecentMessages` messages are never removed;
 * - the removed span is split into ~`targetChunkChars` folders (tiny tail merged),
 *   each with its own α, keywords and title; an oversized message is cut only at
 *   sentence boundaries, so a longer sentence may make its folder exceed
 *   `targetChunkChars` (sentence integrity wins over the size target).
 *
 * v1.4.0 robustness (docs/SPEC.md §5.4/§5.5, plan §3.5):
 * - current-turn protection (P0-3): with `protectSeq` (and messages carrying
 *   `seq`) the removal prefix stops before the first protected message; when no
 *   legal user boundary exists the plan refuses instead of cutting inside a turn;
 * - small-window sanity (P1-6): a host window below `compress.smallWindowTokens`
 *   (or one that contradicts `compress.contextWindowTokens`) refuses to archive
 *   unless `allowSmallWindow` is explicitly enabled;
 * - the folder count is capped by `maxFoldersPerStep`, `maxFoldersPerRun`, the
 *   caller's `maxFolders` and an estimate of what the remaining window still
 *   needs to release;
 * - `eventTimeRangeOf` collects the archived span's event time (message `time`,
 *   half-open interval) into `meta.eventStart/eventEnd/eventTimeSource`;
 * - `commitCompression` is transactional (P1-4): folders are written first,
 *   `index.json` last; any failure rolls back the folders/images written by that
 *   call, drops its journal and rethrows, so the index never lists a missing
 *   folder. An optional `idempotencyKey` dedupes retries by
 *   (sessionId, turn, seqStart, seqEnd, contentHash) instead of `createdAt`.
 */

import { createHash } from 'node:crypto'
import { DEFAULT_BETA, DEFAULT_CONFIG, resolveMemoryDir } from './config.js'
import { computeImportance } from './importance.js'
import {
  allocateFolderId,
  appendStats,
  beginCommitJournal,
  cleanupCommitJournals,
  countFoldersOnDisk,
  ensureMemoryDir,
  finishCommitJournal,
  folderExists,
  formatFolderId,
  indexEntryFromMeta,
  loadIndex,
  readFolder,
  readIndex,
  removeFolder,
  scanFolderMetas,
  writeFolder,
  writeIndex,
} from './store.js'
import { estimateTokens, extractKeywords, normalizeMessages, renderMessage } from './tokenize.js'
import { extractTimeTags } from './relative-time.js'

const roundNumber = (value, digits = 2) => {
  const factor = 10 ** digits
  const rounded = Math.round((Number(value) + Number.EPSILON) * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Tokens for one message: real `msg.tokens` when the host provides it. */
function messageTokens(message) {
  if (message && typeof message.tokens === 'number' && Number.isFinite(message.tokens) && message.tokens >= 0) return message.tokens
  return estimateTokens(renderMessage(message))
}

function messagesTokens(messages) {
  let total = 0
  for (const message of messages) total += messageTokens(message)
  return total
}

function messagesChars(messages) {
  let total = 0
  for (const message of messages) total += renderMessage(message).length
  return total
}

/** Default small-window threshold when `compress.smallWindowTokens` is missing
 * from an old config object (contract: DEFAULT_CONFIG ships the same value). */
const DEFAULT_SMALL_WINDOW_TOKENS = 20000
/** Default per-pass folder cap when `compress.maxFoldersPerStep` is missing. */
const DEFAULT_MAX_FOLDERS_PER_STEP = 500

/**
 * Finite number from an optional value; numeric strings are accepted, while
 * `null` / `undefined` / booleans mean "no value". Never use `Number(value)`
 * directly on optional fields: `Number(null) === 0` would turn a missing
 * timestamp / seq into a real 0.
 */
function finiteNumberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Half-open event range `[min, max+1)` from a list of raw times; null when
 * none of them is a finite number. */
function rangeFromTimes(times) {
  let start = null
  let end = null
  for (const raw of times) {
    const time = finiteNumberOrNull(raw)
    if (time === null) continue
    if (start === null || time < start) start = time
    if (end === null || time > end) end = time
  }
  if (start === null) return null
  return { start, end: end + 1, source: 'messages' }
}

/**
 * v1.5.0 / v1.5.5: deterministic assistant-utterance keywords for one archived
 * chunk.
 *
 * The "you said it" channel must index what the **assistant actually said**, so
 * it must not reuse the generic `extractKeywords` path: that path is tuned for
 * long mixed text and, on one short Chinese sentence, drops every one-off
 * 3-gram and then back-fills position fragments ("我建/建议/议你"). This
 * extractor works sentence/clause by clause instead.
 *
 * v1.5.5 filtering (the old version extracted tool-call/JSON junk as "the
 * assistant's words", so "你说过…" questions missed the real commitments):
 *   - only real assistant conversation is read: `role === 'assistant'`,
 *     array content blocks contribute their `type === 'text'` parts only
 *     (tool-call blocks are dropped), and messages whose text is JSON-like
 *     (`{…}` / `[…]`) or a protocol marker (`[tool-call …]`, `[tool-added …]`,
 *     `[tool-removed …]`, `[tool-result …]`) are skipped;
 *   - per-turn priority: the LAST natural-language reply of each turn is read
 *     first, and selection round-robins across turns, so every turn gets at
 *     least one slot before a turn takes a second and one long JSON blob cannot
 *     crowd out the turn's actual reply;
 *   - post-filter drops JSON keys/tokens: `tool-call`, `id`, `alpha`, `beta`,
 *     `keywords`, `mem-…` ids, pure numbers and pure-lowercase JSON identifiers.
 *
 * Extraction rules (unchanged): ASCII/number words of length >= 2 are candidates;
 * CJK bigrams with a function/pronoun/connective character are grammar glue and
 * are dropped; per clause the tail bigram ranks first (head-final compounds);
 * overlapping position fragments are dropped; the deterministic selection is
 * capped at ASSISTANT_KEYWORDS_MAX (12, inside the 8..16 design range).
 *
 * Dictionary-free, deterministic, never throws. Returns `[]` when the chunk has
 * no readable assistant text.
 *
 * @param {any[]} messages
 * @param {object} [cfg] plugin config (kept for API compatibility; the assistant
 *   channel has no tunable config key of its own)
 * @returns {string[]}
 */
export function extractAssistantKeywords(messages, cfg) {
  const turns = assistantConversationTurns(messages)
  if (turns.length === 0) return []
  return assistantKeywordsFromTurns(turns)
}

/** Protocol marker prefixes that are not natural language. */
const ASSISTANT_PROTOCOL_PREFIXES = ['[tool-call', '[tool-added', '[tool-removed', '[tool-result']
/** JSON keys / protocol tokens that must never become assistant keywords. */
const ASSISTANT_JSON_KEY_TOKENS = new Set([
  'tool-call', 'tool-added', 'tool-removed', 'tool-result', 'role', 'content', 'type',
  'id', 'ids', 'alpha', 'beta', 'keyword', 'keywords', 'reason', 'keep', 'update',
  'updates', 'ok', 'true', 'false', 'null', 'seq', 'time', 'createdat', 'message',
  'messages', 'sender', 'userid', 'messageid', 'readthroughseq', 'index', 'data',
  'meta', 'value', 'name', 'text', 'key', 'count', 'status', 'error', 'code', 'tool',
])

/**
 * Natural-language text of one assistant message (v1.5.5): array content blocks
 * contribute only their text parts; JSON-like payloads and protocol markers are
 * not speech and yield ''.
 *
 * @param {any} message
 * @returns {string}
 */
function assistantNaturalText(message) {
  if (!message || typeof message !== 'object' || message.role !== 'assistant') return ''
  const content = message.content
  let raw = ''
  if (typeof content === 'string') {
    raw = content
  } else if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type !== 'text') continue // drop tool-call / tool-result blocks
      const text = typeof block.text === 'string' ? block.text : typeof block.content === 'string' ? block.content : ''
      if (text) parts.push(text)
    }
    raw = parts.join('\n')
  } else {
    return ''
  }
  raw = raw.trim()
  if (raw.length === 0) return ''
  // A serialized tool result / JSON payload is not the assistant speaking.
  if (raw.startsWith('{') || raw.startsWith('[')) return ''
  const lines = raw.split('\n').filter((line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return true
    return !ASSISTANT_PROTOCOL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  })
  const text = lines.join('\n').trim()
  if (text.length === 0) return ''
  if (text.startsWith('{') || text.startsWith('[')) return ''
  return text
}

/**
 * Group the assistant's natural-language messages by conversational turn
 * (v1.5.5): a new turn starts at every `user` message; tool results and other
 * roles stay inside the current turn. Turns with no natural-language assistant
 * message are dropped.
 *
 * @param {any[]} messages
 * @returns {string[][]} one array of assistant texts per turn, in message order
 */
function assistantConversationTurns(messages) {
  const turns = []
  let current = null
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'user') {
      current = null
      continue
    }
    if (message.role !== 'assistant') continue
    if (current === null) {
      current = []
      turns.push(current)
    }
    const text = assistantNaturalText(message)
    if (text.length > 0) current.push(text)
  }
  return turns.filter((texts) => texts.length > 0)
}

/**
 * Whether one candidate token survives the v1.5.5 JSON/token post-filter.
 *
 * Drops known JSON keys, `mem-…` ids, pure numbers and pure-lowercase JSON
 * identifiers (`readthroughseq`, `assistant_keywords`, …). Ordinary lowercase
 * technical words ("docker", "ttl") stay keywords — the JSON-like payloads were
 * already skipped before this filter runs.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isUsefulAssistantKeyword(token) {
  if (typeof token !== 'string') return false
  const text = token.trim()
  if (text.length === 0 || text.length > 48) return false
  const lower = text.toLowerCase()
  if (ASSISTANT_JSON_KEY_TOKENS.has(lower)) return false
  if (/^mem-[a-z0-9._-]+$/i.test(text)) return false
  if (/^\d+(?:\.\d+)?$/.test(text)) return false
  if (/^[a-z][a-z0-9_.-]*$/.test(text)) {
    // Pure-lowercase ASCII identifier: underscores/dots or a long JSON-key shape
    // are never ordinary words, so they are JSON/token junk.
    if (text.includes('_') || text.includes('.') || text.length > 11) return false
  }
  return true
}

/**
 * Pick assistant keywords from per-turn texts (v1.5.5).
 *
 * Each turn reads its LAST natural-language reply first (that is the turn's
 * conclusion / promise), then the earlier replies in message order; within a
 * message the existing clause order applies. Selection round-robins across
 * turns, so every turn gets at least one slot before a turn takes a second.
 *
 * @param {string[][]} turns
 * @returns {string[]}
 */
function assistantKeywordsFromTurns(turns) {
  const perTurn = turns.map((texts) => {
    const ordered = texts.length > 1 ? [texts[texts.length - 1], ...texts.slice(0, -1)] : texts.slice()
    const flat = []
    for (const text of ordered) {
      for (const part of String(text).split(ASSISTANT_CLAUSE_SPLIT_RE)) {
        const clause = part.trim()
        if (clause.length === 0) continue
        for (const token of assistantClauseCandidates(clause)) {
          if (isUsefulAssistantKeyword(token)) flat.push(token)
        }
      }
    }
    return flat
  })
  const selected = []
  const seen = new Set()
  for (let round = 0; selected.length < ASSISTANT_KEYWORDS_MAX; round += 1) {
    let progressed = false
    for (const turn of perTurn) {
      if (selected.length >= ASSISTANT_KEYWORDS_MAX) break
      const token = turn[round]
      if (token === undefined) continue
      progressed = true
      const normalized = token.toLowerCase()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      selected.push(token)
    }
    if (!progressed) break
  }
  return selected
}

/** Max assistant-utterance keywords per archived folder (design range 8..16). */
const ASSISTANT_KEYWORDS_MAX = 12
/** Sentence/clause separators: punctuation and line breaks split clauses. */
const ASSISTANT_CLAUSE_SPLIT_RE = /[。！？!?；;，,、：:…—\n\r\t]+/
/** CJK ideograph runs (the same ranges engine/tokenize.js uses). */
const ASSISTANT_CJK_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]+/gu
/** Latin/technical words and numbers; the length check happens after trimming. */
const ASSISTANT_LATIN_WORD_RE = /[a-z][a-z0-9_+#.-]*|\d+(?:\.\d+)*/gi
/**
 * High-frequency function / pronoun / connective / numeral characters. A CJK
 * bigram containing one of them is grammar glue, not a content word: this is
 * exactly what produced the old "我建/议你/你少" fragments.
 */
const ASSISTANT_STOP_CHARS = new Set([
  '的', '地', '得', '了', '着', '过', '是', '在', '我', '你', '您', '他', '她', '它', '咱', '俺', '们',
  '这', '那', '哪', '此', '其', '之', '就', '都', '也', '又', '还', '很', '太', '更', '最', '好',
  '会', '能', '要', '可', '以', '应', '该', '请', '别', '把', '被', '给', '让', '从', '到', '对',
  '于', '与', '和', '及', '等', '个', '些', '有', '没', '不', '无', '所', '而', '但', '却', '因',
  '为', '如', '并', '且', '则', '若', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '嘛', '么', '什',
  '怎', '谁', '啥', '多', '少', '零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '百', '千', '万',
])
/**
 * Whole bigrams that survive the character filter but are still pure grammar.
 * Only exact tokens are dropped, so real words built from the same characters
 * ("建议", "就业") are never lost.
 */
const ASSISTANT_STOP_TOKENS = new Set([
  '还是', '还有', '没有', '不是', '不能', '不会', '不用', '不要', '需要', '应该', '一定', '一样',
  '一些', '一下', '一个', '有点', '一点', '什么', '怎么', '这样', '那样', '这个', '那个', '这些',
  '那些', '因为', '所以', '但是', '如果', '然后', '已经', '非常', '特别', '比较', '无论', '虽然',
  '不过', '而且', '或者', '以及', '之后', '之前', '以后', '以前', '的话', '时候',
])

/** Trim leading/trailing ASCII separators that the greedy word regex swallowed. */
function trimAssistantWord(word) {
  let out = word
  while (out.length > 0 && '._-+#'.includes(out[out.length - 1])) out = out.slice(0, -1)
  while (out.length > 0 && '._-+#'.includes(out[0])) out = out.slice(1)
  return out
}

/** Whether two CJK bigrams share a character (i.e. they overlap in the text). */
function assistantBigramsOverlap(left, right) {
  return left[0] === right[0] || left[0] === right[1] || left[1] === right[0] || left[1] === right[1]
}

/** Ranked candidates of one clause (tail/word first), as plain strings. */
function assistantClauseCandidates(clause) {
  const words = []
  ASSISTANT_LATIN_WORD_RE.lastIndex = 0
  let match
  while ((match = ASSISTANT_LATIN_WORD_RE.exec(clause)) !== null) {
    const token = trimAssistantWord(match[0])
    if (token.length >= 2 && !words.includes(token)) words.push(token)
  }
  const bigrams = []
  const seen = new Set()
  ASSISTANT_CJK_RUN_RE.lastIndex = 0
  while ((match = ASSISTANT_CJK_RUN_RE.exec(clause)) !== null) {
    const chars = [...match[0]]
    for (let index = 0; index + 1 < chars.length; index += 1) {
      const token = chars[index] + chars[index + 1]
      if (ASSISTANT_STOP_CHARS.has(chars[index]) || ASSISTANT_STOP_CHARS.has(chars[index + 1])) continue
      if (ASSISTANT_STOP_TOKENS.has(token) || seen.has(token)) continue
      seen.add(token)
      bigrams.push({ token, tail: index + 2 === chars.length })
    }
  }
  // Tail bigrams first (head-final compounds), then the remaining bigrams in
  // text order; ASCII/number words outrank both (they are unambiguous).
  const ranked = [...bigrams.filter((entry) => entry.tail), ...bigrams.filter((entry) => !entry.tail)]
  const ordered = [...words]
  for (const entry of ranked) {
    if (ordered.some((chosen) => assistantBigramsOverlap(chosen, entry.token))) continue
    ordered.push(entry.token)
  }
  return ordered
}

/**
 * Event-time range of a message list: `min(message.time)` to
 * `max(message.time) + 1` (half-open interval, plan §3.3.2), source
 * `'messages'`. Returns `null` when no message carries a finite `time` — the
 * caller then writes no event fields at all (old folder shape unchanged).
 * Pure function, exported for tests and the in-memory time index.
 *
 * @param {any[]} messages
 * @returns {{ start: number, end: number, source: 'messages' } | null}
 */
export function eventTimeRangeOf(messages) {
  const source = Array.isArray(messages) ? messages : []
  const times = []
  for (const message of source) times.push(message && message.time)
  return rangeFromTimes(times)
}

/** One event time from the optional parallel `eventTimes` input; null if absent. */
function eventTimeAt(eventTimes, index) {
  if (eventTimes === null || eventTimes === undefined) return null
  if (Array.isArray(eventTimes)) return finiteNumberOrNull(eventTimes[index])
  if (eventTimes instanceof Map) return finiteNumberOrNull(eventTimes.get(index))
  if (typeof eventTimes === 'object') return finiteNumberOrNull(eventTimes[index])
  return null
}

/** Event range of one planned chunk: message `time` wins, then the parallel
 * `eventTimes` (chunk.start/chunk.end are source-message indexes, so a chunk
 * split from one huge message still maps back to its source message). */
function chunkEventRange(chunkMessages, chunk, eventTimes) {
  const direct = eventTimeRangeOf(chunkMessages)
  if (direct) return direct
  if (eventTimes === null || eventTimes === undefined) return null
  const startIndex = Number.isInteger(chunk && chunk.start) ? Math.max(0, chunk.start) : 0
  const endIndex = Number.isInteger(chunk && chunk.end) ? chunk.end : startIndex
  const times = []
  for (let index = startIndex; index <= endIndex; index += 1) times.push(eventTimeAt(eventTimes, index))
  return rangeFromTimes(times)
}

/**
 * P1-6 estimate of what one archive run may still release: the tokens that have
 * to leave the context to get back below `compress.triggerPercent`, expressed
 * both in tokens and in recall folders (`targetChunkChars` each, converted with
 * the observed chars/token ratio of the message span). Returns `null` when the
 * window / usage percentage is unknown — nothing to cap then.
 */
function estimateWindowRelease({ usedPercent, usedTokens, windowTokens, totalTokens, totalChars, targetPercent, targetChunkChars }) {
  const window = finiteNumberOrNull(windowTokens)
  const percent = finiteNumberOrNull(usedPercent)
  const target = finiteNumberOrNull(targetPercent)
  if (!(window > 0) || percent === null || target === null || !(percent > target)) return null
  const used = finiteNumberOrNull(usedTokens)
  if (!(used > 0)) return null
  // v1.4.0: the release target is a *floor* (default 50%): an archival must at
  // least free enough tokens to bring the context strictly below it, so the
  // exact target boundary gets one extra token of margin.
  const releasableTokens = ((percent - target) / 100) * window
  const strictTokens = Math.ceil(releasableTokens) + 1
  if (!(releasableTokens > 0)) return null
  const tokens = Math.min(strictTokens, used)
  const messageTokens = finiteNumberOrNull(totalTokens)
  const charsPerToken = totalChars > 0 && messageTokens > 0 ? totalChars / messageTokens : 3
  const tokensPerFolder = Math.max(1, targetChunkChars / Math.max(charsPerToken, 0.05))
  return { tokens, folders: Math.max(1, Math.ceil(tokens / tokensPerFolder)), tokensPerFolder }
}

/**
 * P0-3: index of the first message belonging to the protected current turn.
 *
 * The adapter passes `protectSeq` (session seq of the current turn's first
 * message) and the visible messages each carrying their own `seq`; the removal
 * prefix must stop before the first `seq >= protectSeq`, so the current turn's
 * user message and its tool pairs are never archived. `protectTurn` is only
 * telemetry/context (the message→turn mapping does not exist in the engine).
 * Without seq identity on the messages the guard cannot be applied; callers
 * that pass no protectSeq at all keep the historical behaviour.
 *
 * @returns {{ index: number | null, active: boolean, reason: string }}
 */
function resolveProtectedStart(messages, options, compressCfg) {
  const enabled = compressCfg.protectCurrentTurn === undefined ? true : compressCfg.protectCurrentTurn !== false
  if (!enabled) return { index: null, active: false, reason: 'disabled' }
  const protectSeq = finiteNumberOrNull(options.protectSeq)
  if (protectSeq === null) return { index: null, active: false, reason: 'no-seq-input' }
  let hasSeq = false
  for (const message of messages) {
    if (finiteNumberOrNull(message && message.seq) !== null) {
      hasSeq = true
      break
    }
  }
  if (!hasSeq) return { index: null, active: false, reason: 'no-message-seq' }
  for (let index = 0; index < messages.length; index += 1) {
    const seq = finiteNumberOrNull(messages[index] && messages[index].seq)
    if (seq !== null && seq >= protectSeq) return { index, active: true, reason: 'ok' }
  }
  // Every visible message is older than the protected turn: nothing to protect.
  return { index: null, active: false, reason: 'beyond-messages' }
}

/** Normalize a message content value into a title: whitespace collapsed, trimmed
 * and capped to 24 Unicode code points (the documented `meta.title` limit). */
function normalizeTitle(content) {
  const text = String(content === undefined || content === null ? '' : content).replace(/\s+/g, ' ').trim()
  return [...text].slice(0, 24).join('')
}

/** Title of the first user message in `messages` whose content is non-empty. */
function firstUserTitle(messages) {
  const source = Array.isArray(messages) ? messages : []
  for (const message of source) {
    if (!message || message.role !== 'user') continue
    const title = normalizeTitle(message.content)
    if (title) return title
  }
  return ''
}

/** Title of one chunk (v1.2 R2): the chunk's first user message; otherwise the
 * nearest preceding user message in the archived span (a chunk may start
 * mid-turn at an assistant/tool message); otherwise the chunk's first message
 * (legacy fallback). A chunk whose first user message has empty content also
 * inherits. Returns '' when there is no text at all — the caller numbers it. */
function titleOf(chunkMessages, removedMessages, chunkStart) {
  const own = firstUserTitle(chunkMessages)
  if (own) return own
  const removed = Array.isArray(removedMessages) ? removedMessages : []
  const lastIndex = Number.isInteger(chunkStart) ? Math.min(chunkStart - 1, removed.length - 1) : removed.length - 1
  for (let index = lastIndex; index >= 0; index -= 1) {
    const message = removed[index]
    if (!message || message.role !== 'user') continue
    const inherited = normalizeTitle(message.content)
    if (inherited) return inherited
  }
  const source = Array.isArray(chunkMessages) ? chunkMessages : []
  return source.length > 0 ? normalizeTitle(source[0].content) : ''
}

/** Split messages into user turns: [{ start, msgs }]. */
function userTurnSegments(messages) {
  const segments = []
  let current = []
  let start = 0
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message && message.role === 'user' && current.length > 0) {
      segments.push({ start, msgs: current })
      current = []
    }
    if (current.length === 0) start = index
    current.push(message)
  }
  if (current.length > 0) segments.push({ start, msgs: current })
  return segments
}

/** Sentence terminators that end a sentence without needing a following space:
 * Chinese `。！？；…` and a newline. */
const CJK_SENTENCE_END = /[。！？；…]/
/** Latin terminators end a sentence only before whitespace (or the text end), so
 * decimals (`3.14`) and version strings (`v1.2.0`) are never cut. */
const LATIN_SENTENCE_END = /[.!?;]/
/** Closing quotes/brackets that belong to the sentence being ended. */
const SENTENCE_CLOSER = /[”’"'』」）)\]】》]/

/** Index just past the first sentence boundary at/after `start`, or -1 when the
 * rest of the text has no boundary (the rest counts as one long sentence). A
 * boundary keeps its terminator run (`……`, `！？`, `?!`) and closing quotes, so
 * the next fragment always starts at the first character of a new sentence. */
function findSentenceEnd(content, start) {
  for (let index = start; index < content.length; index += 1) {
    const char = content[index]
    const atEnd = index + 1 >= content.length
    const cjk = CJK_SENTENCE_END.test(char)
    const latin = LATIN_SENTENCE_END.test(char) && (atEnd || /\s/.test(content[index + 1]))
    if (char !== '\n' && !cjk && !latin) continue
    let end = index + 1
    while (
      end < content.length &&
      (CJK_SENTENCE_END.test(content[end]) || LATIN_SENTENCE_END.test(content[end]) || SENTENCE_CLOSER.test(content[end]))
    ) {
      end += 1
    }
    return end
  }
  return -1
}

/** Split one message's text into fragments at sentence boundaries, packing whole
 * sentences up to ~targetChars. A single sentence longer than targetChars is kept
 * whole in its own fragment: sentence integrity outranks the size target, so the
 * resulting folder may exceed targetChunkChars (the accepted trade-off). Slicing
 * only ever happens after a terminator, and concatenating the fragments returns
 * `content` unchanged. */
function splitSentences(content, targetChars) {
  const fragments = []
  let current = ''
  let offset = 0
  while (offset < content.length) {
    const boundary = findSentenceEnd(content, offset)
    const end = boundary === -1 ? content.length : boundary
    const sentence = content.slice(offset, end)
    offset = end
    if (current.length > 0 && current.length + sentence.length > targetChars) {
      fragments.push(current)
      current = ''
    }
    current += sentence
  }
  if (current.length > 0) fragments.push(current)
  return fragments
}

/** Greedy split into chunks of ~targetChars while keeping whole user turns.
 * A single message can be larger than targetChars (a huge tool result). Such a
 * message is split at sentence boundaries so no recall folder ends mid-sentence;
 * a sentence longer than targetChars stays whole (the folder may exceed the
 * target, which is accepted for sentence integrity). */
function chunkSegments(segments, targetChars) {
  const chunks = []
  let current = { start: 0, end: 0, msgs: [], chars: 0 }
  const flush = () => {
    if (current.msgs.length > 0) chunks.push(current)
  }
  const pushMessage = (message, start) => {
    const chars = messagesChars([message])
    if (current.msgs.length > 0 && current.chars + chars > targetChars) {
      flush()
      current = { start, end: start, msgs: [], chars: 0 }
    }
    if (current.msgs.length === 0) current.start = start
    // Remembers the source-index of the last message in this chunk so
    // meta.source.seqEnd stays correct even when one huge message is split.
    current.end = start
    current.msgs.push(message)
    current.chars += chars
  }
  for (const segment of segments) {
    for (let index = 0; index < segment.msgs.length; index += 1) {
      const message = segment.msgs[index]
      const start = segment.start + index
      const chars = messagesChars([message])
      if (chars > targetChars && typeof message.content === 'string') {
        // Keep the source message's identity on every fragment: the surface
        // `seq` keeps `meta.source`/turn-protection checks meaningful and the
        // event time keeps eventStart/eventEnd (plan §3.3.2) on the folders.
        const identity = {}
        if (message && message.time !== undefined) identity.time = message.time
        if (message && finiteNumberOrNull(message.seq) !== null) identity.seq = message.seq
        for (const fragment of splitSentences(message.content, targetChars)) {
          pushMessage({ role: message.role, content: fragment, ...identity }, start)
        }
      } else {
        pushMessage(message, start)
      }
    }
  }
  flush()
  return chunks
}

/** Merge a trailing/leading chunk smaller than minChunkChars forward. */
function mergeTinyChunks(chunks, minChunkChars) {
  let changed = true
  while (changed && chunks.length > 1) {
    changed = false
    const last = chunks[chunks.length - 1]
    if (last.chars < minChunkChars) {
      const previous = chunks[chunks.length - 2]
      previous.msgs.push(...last.msgs)
      previous.chars += last.chars
      previous.end = last.end
      chunks.pop()
      changed = true
      continue
    }
    const first = chunks[0]
    if (first.chars < minChunkChars) {
      const next = chunks[1]
      next.msgs.unshift(...first.msgs)
      next.chars += first.chars
      next.start = first.start
      chunks.shift()
      changed = true
    }
  }
  return chunks
}

/** Keep folder count under maxFoldersPerRun by merging the smallest neighbours. */
function capChunks(chunks, maxFolders) {
  while (chunks.length > maxFolders) {
    let bestIndex = 0
    let bestChars = Infinity
    for (let index = 0; index + 1 < chunks.length; index += 1) {
      const combined = chunks[index].chars + chunks[index + 1].chars
      if (combined < bestChars) {
        bestChars = combined
        bestIndex = index
      }
    }
    const left = chunks[bestIndex]
    const right = chunks[bestIndex + 1]
    left.msgs.push(...right.msgs)
    left.chars += right.chars
    left.end = right.end
    chunks.splice(bestIndex + 1, 1)
  }
  return chunks
}

function buildBasePlan(messages, usedPercent, cfg, reason) {
  return {
    shouldCompress: false,
    reason,
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : 0,
    totalTokens: messagesTokens(messages),
    usedTokens: 0,
    targetTokens: 0,
    remove: [],
    keep: messages.slice(),
    folders: [],
    warnings: [],
    removeChars: 0,
    removeTokens: 0,
    windowTokens: null,
  }
}

/**
 * Plan a compression run. Pure: nothing is written.
 *
 * All v1.4.0 inputs below are optional, so old callers keep the historical
 * behaviour; the only intentional behaviour change is the P0-3 fail-safe — a
 * plan that cannot align its cut to a user boundary now refuses instead of
 * cutting inside a turn.
 *
 * @param {{
 *   messages: any[],
 *   usedPercent: number,
 *   cfg: object,
 *   sessionId?: string,
 *   now?: number,
 *   turn?: number,
 *   totalUsedTokens?: number,
 *   windowTokens?: number,
 *   protectTurn?: number|null,         // current turn number (telemetry/debug)
 *   protectSeq?: number|null,          // session seq of the current turn's first message
 *   pendingCount?: number,             // pending folders before archiving (telemetry/backpressure)
 *   allowSmallWindow?: boolean,        // per-plan override of compress.allowSmallWindow
 *   maxFolders?: number,               // per-plan folder cap (adapter: min(maxFoldersPerStep, release estimate))
 *   hardLimitReached?: boolean,        // adapter: consecutive hard-limit passes, stop retrying (P1-6)
 *   eventTimes?: number[]|Map|object,  // message event times (epoch ms), parallel to `messages`
 * }} options
 */
export function planCompression(options = {}) {
  const cfg = options.cfg && typeof options.cfg === 'object' ? options.cfg : DEFAULT_CONFIG
  const compressCfg = cfg.compress || DEFAULT_CONFIG.compress
  const usedPercent = Number(options.usedPercent)
  const rawMessages = Array.isArray(options.messages) ? options.messages : []
  const messages = rawMessages.map((message) => (message && typeof message === 'object' ? message : { role: 'user', content: String(message) }))
  const totalUsedTokens = Number(options.totalUsedTokens)
  const plan = buildBasePlan(messages, usedPercent, cfg, 'below-threshold')
  plan.warnings = Array.isArray(cfg.warnings) ? cfg.warnings.slice() : []
  const hostWindow = finiteNumberOrNull(options.windowTokens)
  plan.windowTokens = hostWindow !== null && hostWindow > 0 ? hostWindow : null
  plan.usedTokens = Number.isFinite(totalUsedTokens) && totalUsedTokens > 0 ? totalUsedTokens : plan.totalTokens
  plan.protectedTurn = false
  plan.protectedStart = null
  plan.smallWindow = false
  plan.maxFoldersCapped = false
  plan.hardLimit = false
  plan.trickleArchive = false
  plan.allowSmallWindow = options.allowSmallWindow === true || compressCfg.allowSmallWindow === true
  plan.pendingAtArchive = finiteNumberOrNull(options.pendingCount)
  plan.pendingCount = plan.pendingAtArchive

  if (!compressCfg.enabled) {
    plan.reason = 'below-threshold'
    plan.warnings.push('compress.enabled is false; compression skipped')
    return plan
  }
  if (!Number.isFinite(usedPercent) || !(usedPercent > compressCfg.triggerPercent)) return plan

  // Small-window sanity (P1-6): archiving inside a context that cannot hold the
  // archive note plus the remaining history only self-amplifies. The host window
  // is the only trustworthy source; a conflicting compress.contextWindowTokens
  // (one is below 25% of the other) is equally refused. `allowSmallWindow` is the
  // documented explicit escape hatch (stress tests / tiny test hosts).
  if (plan.windowTokens !== null && plan.allowSmallWindow !== true) {
    const configuredWindow = finiteNumberOrNull(compressCfg.contextWindowTokens)
    if (
      configuredWindow !== null && configuredWindow > 0 &&
      (configuredWindow < plan.windowTokens * 0.25 || plan.windowTokens < configuredWindow * 0.25)
    ) {
      plan.smallWindow = true
      plan.windowConflict = true
      plan.reason = 'window-conflict'
      plan.warnings.push(
        `planCompression: compress.contextWindowTokens=${configuredWindow} conflicts with the host window ` +
          `${plan.windowTokens} (one is below 25% of the other); refused until compress.allowSmallWindow=true is set`,
      )
      return plan
    }
    const smallWindowLimit = Math.max(1, finiteNumberOrNull(compressCfg.smallWindowTokens) ?? DEFAULT_SMALL_WINDOW_TOKENS)
    if (plan.windowTokens < smallWindowLimit) {
      plan.smallWindow = true
      plan.reason = 'small-window'
      plan.warnings.push(
        `planCompression: windowTokens=${plan.windowTokens} is below compress.smallWindowTokens=${smallWindowLimit}; ` +
          'automatic archiving is disabled for small windows (set compress.allowSmallWindow=true to override)',
      )
      return plan
    }
  }

  // P1-6 hard-limit stop: the adapter tracks consecutive over-limit passes and
  // tells the engine when to stop retrying; the refusal carries its own reason
  // and warning, so it is distinguishable from a normal below-threshold skip.
  if (options.hardLimitReached === true && compressCfg.hardLimitStop !== false) {
    plan.hardLimit = true
    plan.reason = 'hard-limit'
    plan.warnings.push(
      'planCompression: compress.hardLimitStop is active and the hard limit was reached repeatedly; ' +
        'archiving stopped instead of retrying on every model step',
    )
    return plan
  }

  // Context size gate: prefer the host-provided real token count.
  if (plan.usedTokens < compressCfg.minContextTokens) {
    plan.reason = 'too-few-messages'
    return plan
  }

  const keepRecent = Math.max(0, Number.isInteger(compressCfg.keepRecentMessages) ? compressCfg.keepRecentMessages : 0)
  const removableCount = messages.length - keepRecent
  if (messages.length < compressCfg.minMessagesToCompress || removableCount <= 0) {
    plan.reason = 'nothing-to-remove'
    return plan
  }

  const totalChars = messagesChars(messages)
  let targetTokens = plan.usedTokens * (compressCfg.compressPercent / 100)
  if (!(targetTokens > 0)) {
    plan.reason = 'nothing-to-remove'
    return plan
  }
  // v1.4.0 archive target (release floor, not a cap): every archival must at
  // least free enough tokens to bring the context below
  // `compress.releaseTargetPercent` (default 50%). `compressPercent` remains the
  // normal target; when it would leave the context above the release target, the
  // removed span is enlarged instead of capped.
  const releaseTargetPercent = finiteNumberOrNull(compressCfg.releaseTargetPercent)
  const release = compressCfg.releaseFloorEnabled === false
    ? null
    : estimateWindowRelease({
    usedPercent,
    usedTokens: plan.usedTokens,
    windowTokens: plan.windowTokens,
    totalTokens: plan.totalTokens,
    totalChars,
    targetPercent: releaseTargetPercent,
    targetChunkChars: Math.max(1, finiteNumberOrNull(compressCfg.targetChunkChars) ?? 1200),
  })
  if (release) {
    plan.releaseTargetPercent = releaseTargetPercent
    plan.releaseTokens = roundNumber(release.tokens, 2)
    plan.releaseFolders = release.folders
    if (release.tokens > targetTokens) {
      targetTokens = release.tokens
      plan.releaseFloor = true
      plan.warnings.push(
        `planCompression: archiving at least ~${Math.round(release.tokens)} tokens to get below ` +
          `releaseTargetPercent=${releaseTargetPercent}% (compressPercent=${compressCfg.compressPercent}% would only ` +
          `remove ~${Math.round(plan.usedTokens * (compressCfg.compressPercent / 100))} tokens)`,
      )
    }
  }
  // `releaseCapped` is the v1.4.0 cap-era field; the behavior is now a floor, so
  // it is never set and only kept for telemetry/backward compatibility.
  plan.targetTokens = roundNumber(targetTokens, 2)

  const tokens = messages.map((message) => messageTokens(message))
  // Never remove the newest messages (and always keep at least one message).
  const maxCut = Math.min(messages.length - keepRecent, messages.length - 1)
  let accumulated = 0
  let cut = 0
  while (cut < maxCut && accumulated < targetTokens) {
    accumulated += tokens[cut]
    cut += 1
  }
  if (cut <= 0) {
    plan.reason = 'nothing-to-remove'
    return plan
  }

  // Extend/retract the cut to a user-turn boundary: the remaining history must
  // start at a user message, so assistant tool-calls stay with their tool
  // results. `cut` crossed the target (20%); the *next* user boundary can
  // overshoot the target a lot in long tool-heavy turns, so prefer it only when
  // the overshoot is bounded (maxBoundaryOvershoot); otherwise remove the
  // shorter prefix up to the previous user boundary.
  //
  // P0-3: `protectSeq` marks the first message of the current turn. The removal
  // prefix may never reach it; when no legal user boundary exists before it the
  // plan refuses (fail-safe) instead of cutting inside the current turn.
  const protectedInfo = resolveProtectedStart(messages, options, compressCfg)
  const protectedStart = protectedInfo.index
  if (protectedInfo.active) {
    plan.protectedTurn = true
    plan.protectedStart = protectedStart
  } else if (protectedInfo.reason === 'no-message-seq') {
    plan.warnings.push(
      'planCompression: protectSeq was provided but the messages carry no seq numbers; ' +
        'the current turn cannot be protected (pass entries with their surface seq)',
    )
  }
  const allowedMaxCut = protectedStart === null ? maxCut : Math.min(maxCut, protectedStart)
  if (protectedStart !== null && allowedMaxCut <= 0) {
    plan.reason = 'protected-turn'
    plan.warnings.push(
      'planCompression: the current turn starts at the first visible message; nothing can be removed ' +
        'without archiving the current turn (refused, P0-3)',
    )
    return plan
  }
  const tokenPrefix = new Array(messages.length + 1)
  tokenPrefix[0] = 0
  for (let index = 0; index < messages.length; index += 1) tokenPrefix[index + 1] = tokenPrefix[index] + tokens[index]
  // Finite sentinel for an unreachable boundary: v1.3.0 returned Infinity here,
  // which leaked "would remove Infinity tokens" warnings from fake-window
  // sessions (P1-6). The span total is the true upper bound.
  const spanTokens = tokenPrefix[messages.length]
  const tokensUpTo = (boundary) =>
    Number.isInteger(boundary) && boundary >= 0 && boundary <= messages.length ? tokenPrefix[boundary] : spanTokens
  const findBoundaryAtOrAfter = () => {
    for (let boundary = cut; boundary <= allowedMaxCut; boundary += 1) {
      if (messages[boundary] && messages[boundary].role === 'user') return boundary
    }
    return -1
  }
  const findBoundaryBefore = () => {
    for (let boundary = Math.min(cut, allowedMaxCut); boundary >= 1; boundary -= 1) {
      if (messages[boundary] && messages[boundary].role === 'user') return boundary
    }
    return -1
  }
  if (protectedStart !== null && cut > allowedMaxCut) {
    plan.warnings.push(
      `planCompression: current-turn protection capped the removal at message ${allowedMaxCut} ` +
        `(the target wanted ${cut}); the current turn is never archived`,
    )
  }
  const forward = findBoundaryAtOrAfter()
  const backward = findBoundaryBefore()
  const overshootFactor = Number(compressCfg.maxBoundaryOvershoot) > 0 ? Number(compressCfg.maxBoundaryOvershoot) : 1.25
  const forwardTokens = tokensUpTo(forward)
  const backwardTokens = tokensUpTo(backward)
  let chosen = -1
  if (forward > 0 && forwardTokens <= targetTokens * overshootFactor) {
    chosen = forward
  } else if (backward > 0 && backwardTokens > 0) {
    chosen = backward
    plan.warnings.push(
      `planCompression: next user boundary would remove ${Math.round(forwardTokens)} tokens ` +
        `(> ${overshootFactor}x target ${Math.round(targetTokens)}); kept the shorter ${Math.round(backwardTokens)}-token prefix`,
    )
  } else if (forward > 0) {
    chosen = forward
    plan.warnings.push('planCompression: no shorter user-turn boundary available; removal overshoots the target')
  } else {
    // v1.3.0 fell back to an arbitrary cut here, which can separate a tool pair
    // or start the remaining history mid-turn (P0-3). Fail-safe instead: keep
    // the conversation untouched and let the caller decide.
    plan.reason = plan.protectedTurn === true ? 'protected-turn' : 'no-legal-cut'
    plan.warnings.push(
      plan.protectedTurn === true
        ? 'planCompression: no legal cut point before the protected current turn; refused to archive (P0-3 fail-safe)'
        : 'planCompression: could not align the cut to a user-turn boundary; refused to split a turn (fail-safe)',
    )
    return plan
  }
  if (chosen <= 0) {
    plan.reason = 'nothing-to-remove'
    return plan
  }

  const remove = messages.slice(0, chosen)
  const keep = messages.slice(chosen)
  plan.remove = remove
  plan.keep = keep
  plan.removeChars = messagesChars(remove)
  plan.removeTokens = messagesTokens(remove)

  const targetChunkChars = Math.max(1, finiteNumberOrNull(compressCfg.targetChunkChars) ?? 1200)
  const minChunkChars = Math.max(1, finiteNumberOrNull(compressCfg.minChunkChars) ?? 200)
  const maxFoldersPerRun = Math.max(1, finiteNumberOrNull(compressCfg.maxFoldersPerRun) ?? 500)
  const maxFoldersPerStep = Math.max(1, finiteNumberOrNull(compressCfg.maxFoldersPerStep) ?? DEFAULT_MAX_FOLDERS_PER_STEP)
  const explicitMaxFolders = finiteNumberOrNull(options.maxFolders)
  const eventTimesInput = options.eventTimes
  // P1-6 triple cap: the configured per-run/per-step caps plus the caller cap
  // and the "remaining window releasable" estimate. capChunks only merges
  // neighbours, so the archived span stays exactly the planned prefix.
  const folderCaps = [maxFoldersPerRun, maxFoldersPerStep]
  if (explicitMaxFolders !== null && explicitMaxFolders > 0) folderCaps.push(Math.max(1, Math.floor(explicitMaxFolders)))
  if (release) folderCaps.push(release.folders)
  const folderCap = Math.max(1, Math.min(...folderCaps))
  let chunks = chunkSegments(userTurnSegments(remove), targetChunkChars)
  chunks = mergeTinyChunks(chunks, minChunkChars)
  const naturalFolderCount = chunks.length
  chunks = capChunks(chunks, folderCap)
  plan.maxFolders = folderCap
  plan.maxFoldersCapped = chunks.length < naturalFolderCount
  if (plan.maxFoldersCapped) {
    plan.warnings.push(
      `planCompression: folder count capped ${naturalFolderCount} -> ${chunks.length} ` +
        `(maxFoldersPerRun=${maxFoldersPerRun}, maxFoldersPerStep=${maxFoldersPerStep}` +
        `${explicitMaxFolders !== null ? `, maxFolders=${explicitMaxFolders}` : ''}` +
        `${release ? `, remaining-window estimate=${release.folders}` : ''})`,
    )
  }

  const baseNow = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  // v1.5.0 (audit F-03-02): `timeTag.mode='off'` is documented as "no
  // collection/index/filter" (engine/config.js), so the archive path must not
  // compute or write time tags at all in that mode.
  const timeTagEnabled = !(cfg.timeTag && typeof cfg.timeTag === 'object' && cfg.timeTag.mode === 'off')
  const folderCount = chunks.length
  const folderPlans = []
  const eventTimeSourceCounts = {}
  for (let index = 0; index < folderCount; index += 1) {
    const chunk = chunks[index]
    const chunkMessages = chunk.msgs
    // v1.2 R2: prefer the first user message, inherit the turn's user message
    // when the chunk starts mid-turn, and only then fall back to the chunk head.
    const title = titleOf(chunkMessages, remove, chunk.start) || `第${index + 1}段对话`
    const createdAt = baseNow - (folderCount - 1 - index)
    // Keywords describe the conversation content, not rendered role prefixes.
    const text = chunkMessages.map((message) => String((message && message.content) || '')).join('\n')
    const recency = folderCount > 1 ? index / (folderCount - 1) : 0.5
    const importance = computeImportance(chunkMessages, cfg, { recency })
    for (const warning of importance.warnings) {
      if (!plan.warnings.includes(warning)) plan.warnings.push(warning)
    }
    const chars = messagesChars(chunkMessages)
    const tokens = messagesTokens(chunkMessages)
    const keywords = extractKeywords(text, cfg)
    const meta = {
      version: 1,
      id: formatFolderId(createdAt, index + 1),
      createdAt,
      alpha: importance.alpha,
      alphaSource: 'heuristic',
      // Heuristic archive path: deterministic α/keywords, neutral default β, and
      // therefore immediately usable for recall (no model judging needed).
      beta: DEFAULT_BETA,
      betaSource: 'default',
      keywords,
      keywordsSource: 'heuristic',
      scored: true,
      title,
      stats: { messages: chunkMessages.length, chars, tokens },
      signals: importance.signals,
      source: {
        sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
        turn: Number.isFinite(Number(options.turn)) ? Number(options.turn) : 0,
        seqStart: chunk.start,
        seqEnd: Number.isInteger(chunk.end) ? chunk.end : chunk.start + chunkMessages.length - 1,
      },
    }
    // Plan §3.3.2: mechanical event-time collection. The fields are written only
    // when the archived span actually carries message times; otherwise the
    // folder keeps the old (archivedAt-only) shape.
    const eventRange = chunkEventRange(chunkMessages, chunk, eventTimesInput)
    if (eventRange) {
      meta.eventStart = eventRange.start
      meta.eventEnd = eventRange.end
      meta.eventTimeSource = eventRange.source
      eventTimeSourceCounts[eventRange.source] = (eventTimeSourceCounts[eventRange.source] || 0) + 1
    }
    // v1.5.0: the assistant's own utterances are indexed separately so a
    // "你说过/你之前说…" question can recall what the assistant said even when the
    // judge's keywords did not cover it (deterministic, no model call).
    try {
      const assistantKeywords = extractAssistantKeywords(chunkMessages, cfg)
      if (assistantKeywords.length > 0) meta.assistantKeywords = assistantKeywords
    } catch {
      /* best effort */
    }
    // v1.5.0 (audit F-03-02/F-03-03): deterministic time tags — fuzzy expressions
    // ("昨天", "下周二") in the archived messages are converted to absolute
    // half-open intervals at archive time (never by a model). `timeTag.mode='off'`
    // means "no collection", so nothing is computed or written then. The anchor of
    // a message is its own finite `time`, else the folder `createdAt` (DESIGN §1);
    // another message's event-range start must never be used instead.
    if (timeTagEnabled) {
      try {
        const timeTagResult = extractTimeTags(chunkMessages, createdAt, cfg)
        if (Array.isArray(timeTagResult.tags) && timeTagResult.tags.length > 0) {
          meta.timeTags = timeTagResult.tags
          meta.timeTagSource = 'messages'
        }
      } catch {
        /* time tags are best effort; never break an archive */
      }
    }
    folderPlans.push({ id: meta.id, meta, messages: chunkMessages })
  }

  // v1.2 R2: within one archival run identical titles are disambiguated with the
  // folder's 1-based index, e.g. `重复标题（2）`. Unique titles stay untouched.
  const titleCounts = new Map()
  for (const folderPlan of folderPlans) {
    const baseTitle = folderPlan.meta.title
    titleCounts.set(baseTitle, (titleCounts.get(baseTitle) || 0) + 1)
  }
  for (let index = 0; index < folderPlans.length; index += 1) {
    const baseTitle = folderPlans[index].meta.title
    if (titleCounts.get(baseTitle) > 1) folderPlans[index].meta.title = `${baseTitle}（${index + 1}）`
  }

  // Event-time aggregates: per-folder counts feed the telemetry event (§7), the
  // whole *removed span* range is exposed for callers that index the archive.
  plan.eventTime = eventTimeRangeOf(remove)
  if (!plan.eventTime && eventTimesInput !== null && eventTimesInput !== undefined) {
    const removedTimes = []
    for (let index = 0; index < remove.length; index += 1) removedTimes.push(eventTimeAt(eventTimesInput, index))
    plan.eventTime = rangeFromTimes(removedTimes)
  }
  plan.eventTimeSourceCounts = eventTimeSourceCounts

  // O1: "trickle" archive — the release cap trimmed the span to what the window
  // barely needs AND it still produced a single folder (a long session archiving
  // one tiny slice every pre-turn). Telemetry only: archiving behaviour is
  // unchanged; the adapter can surface one INFO/WARN from this flag instead of
  // leaving it at debug level.
  plan.trickleArchive = plan.releaseCapped === true && folderPlans.length === 1
  if (plan.releaseFloor === true && Number.isFinite(plan.removeTokens) && plan.removeTokens < plan.targetTokens) {
    plan.warnings.push(
      `planCompression: the legal cut / folder caps only remove ~${Math.round(plan.removeTokens)} tokens ` +
        `(< release floor ${Math.round(plan.targetTokens)}); the context may stay above ` +
        `releaseTargetPercent=${plan.releaseTargetPercent}% and the next archival will continue`,
    )
  }

  plan.shouldCompress = folderPlans.length > 0
  plan.reason = plan.shouldCompress ? 'ok' : 'nothing-to-remove'
  plan.folders = folderPlans
  return plan
}

function sameFolderContent(existingMeta, plannedMeta) {
  if (!existingMeta || !plannedMeta) return false
  const existingStats = existingMeta.stats || {}
  const plannedStats = plannedMeta.stats || {}
  return (
    existingMeta.createdAt === plannedMeta.createdAt &&
    existingMeta.title === plannedMeta.title &&
    existingStats.messages === plannedStats.messages &&
    existingStats.chars === plannedStats.chars
  )
}

function counterFromFolderId(id) {
  const match = typeof id === 'string' ? /^mem-\d{8}T\d{6}Z-(\d{4})$/.exec(id) : null
  return match ? Number.parseInt(match[1], 10) : 0
}

// ---------------------------------------------------------------------------
// v1.4.0 commit transaction helpers (P1-4): idempotency keys + rollback
// ---------------------------------------------------------------------------

/**
 * Content hash of one planned folder. The archived messages are the real
 * identity of an archive run (a retry gets new folder ids / createdAt values),
 * so this hash makes (sessionId, turn, seqStart, seqEnd, contentHash) stable.
 */
function hashFolderContent(messages) {
  const hash = createHash('sha256')
  for (const message of Array.isArray(messages) ? messages : []) {
    hash.update(String(message && message.role !== undefined ? message.role : ''))
    hash.update('\u0000')
    hash.update(String(message && message.content !== undefined && message.content !== null ? message.content : ''))
    hash.update('\u0001')
  }
  return hash.digest('hex').slice(0, 32)
}

/** Whether the caller opted into the new (contentHash based) idempotency key. */
function idempotencyEnabled(options) {
  return options.idempotencyKey !== undefined && options.idempotencyKey !== null && options.idempotencyKey !== false
}

/**
 * P1-4 idempotency key of one planned folder:
 * `(sessionId, turn, seqStart, seqEnd, contentHash)`. `options.idempotencyKey`
 * may be a string used as a namespace prefix (the adapter commit id). Returns
 * null when the caller did not opt in — the historical `createdAt`/id dedupe
 * then applies unchanged.
 */
function folderIdempotencyKey(meta, messages, options) {
  if (!idempotencyEnabled(options)) return null
  const source = meta && meta.source && typeof meta.source === 'object' ? meta.source : {}
  const sessionId = String(options.sessionId !== undefined ? options.sessionId : source.sessionId !== undefined ? source.sessionId : '')
  const turn = finiteNumberOrNull(options.turn) ?? finiteNumberOrNull(source.turn) ?? 0
  const seqStart = finiteNumberOrNull(source.seqStart) ?? 0
  const seqEnd = finiteNumberOrNull(source.seqEnd) ?? seqStart
  const prefix = typeof options.idempotencyKey === 'string' && options.idempotencyKey ? `${options.idempotencyKey}|` : ''
  return `${prefix}${sessionId}|${turn}|${seqStart}|${seqEnd}|${hashFolderContent(messages)}`
}

/** Collect the idempotency keys of already committed folders **from the index**
 * (P2/D2): `indexEntryFromMeta` copies `meta.idempotencyKey`, so one in-memory
 * pass over `index.folders` is enough — the previous implementation scanned and
 * parsed every `memory/<id>/meta.json` on every commit (O(N) disk reads: ~140ms
 * for the real a46 library, ~0.5s at storage.maxFolders=10000).
 *
 * The caller already loaded the index, so this performs no extra file read. Only
 * when the index itself is unavailable (missing/corrupt and not rebuildable) does
 * it fall back to `readIndex` and finally to scanning folder metas (with a
 * warning) — correctness over speed for that broken-store case. */
function collectFolderIdempotencyKeys(index, memoryDir, cfg, warnings) {
  const keys = new Map()
  const collect = (folders) => {
    for (const folder of folders) {
      const key = folder && typeof folder.idempotencyKey === 'string' ? folder.idempotencyKey : ''
      if (key && typeof folder.id === 'string') keys.set(key, folder.id)
    }
    return keys
  }
  const loadedFolders = index && Array.isArray(index.folders) ? index.folders : null
  if (loadedFolders) {
    collect(loadedFolders)
    // A-02 belt & braces: a folder can be on disk yet absent from the in-memory
    // index (another process committed concurrently, or a journal was lost).
    // Its `meta.json` carries the idempotency key, so scan the metas in that
    // case (slow path, only on an observed index/disk mismatch).
    try {
      if (countFoldersOnDisk(memoryDir) > loadedFolders.length) {
        if (Array.isArray(warnings)) {
          warnings.push('commit: disk has folders missing from index.json; idempotency keys were re-read from folder metas')
        }
        for (const meta of scanFolderMetas(memoryDir)) {
          const key = meta && typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : ''
          if (key && typeof meta.id === 'string') keys.set(key, meta.id)
        }
      }
    } catch {
      /* best effort: the index snapshot is still usable */
    }
    return keys
  }
  const reread = readIndex(memoryDir, cfg)
  if (reread && Array.isArray(reread.folders)) return collect(reread.folders)
  if (Array.isArray(warnings)) {
    warnings.push('commit: index.json is unavailable; idempotency keys were recovered by scanning folder metas (slow path)')
  }
  let metas = []
  try {
    metas = scanFolderMetas(memoryDir)
  } catch {
    return keys
  }
  for (const meta of metas) {
    const key = meta && typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : ''
    if (key && typeof meta.id === 'string') keys.set(key, meta.id)
  }
  return keys
}

/** Journal file id: explicit safe `commitId` or a generated unique one. */
function commitJournalId(options) {
  const explicit = typeof options.commitId === 'string' && /^[A-Za-z0-9._-]+$/.test(options.commitId) ? options.commitId : null
  if (explicit) return explicit
  return `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Best-effort removal of the folders written by a failed commit; returns the
 * ids whose directory was actually removed (also covers the folder whose write
 * threw after creating its directory). */
function rollbackCommittedFolders(memoryDir, ids) {
  const removed = []
  const seen = new Set()
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    seen.add(id)
    try {
      removeFolder(memoryDir, id)
    } catch {
      /* best effort: never mask the original commit error */
    }
    removed.push(id)
  }
  return removed
}

/**
 * Commit a plan: write folders + update index + append telemetry.
 *
 * Transaction (P1-4): folders are written first (`context.json` then the
 * `meta.json` commit marker), `index.json` last. A journal (`.commit-<id>.json`)
 * records the intent; on success it is deleted, on failure the folders written
 * by this call are removed (and `options.removeImages` runs) before the original
 * error is rethrown with `rolledBack=true` — so the index never lists a folder
 * that is missing on disk and the caller's conversation stays untouched.
 *
 * @param {ReturnType<typeof planCompression>} plan
 * @param {{
 *   memoryDir: string,
 *   cfg: object,
 *   sessionId?: string,
 *   turn?: number,
 *   source?: object,
 *   idempotencyKey?: boolean|string,  // enable (contentHash based) idempotency
 *   removeImages?: (info: {folderIds: string[], sessionId: string|null, turn: number|null}) => void,
 *   commitId?: string,                // journal file id (default: generated)
 * }} options `source` is merged into every folder's `meta.source`.
 */
export function commitCompression(plan, options = {}) {
  const cfg = options.cfg && typeof options.cfg === 'object' ? options.cfg : DEFAULT_CONFIG
  const memoryDir = options.memoryDir || resolveMemoryDir(cfg)
  ensureMemoryDir(memoryDir)
  // A-02 (1.4.1): loadIndex now *recovers* crashed commits (journal folderIds +
  // orphan folders are adopted into the index) before any stale journal is
  // dropped, so a killed archive is never written twice. Journals are cleaned
  // up afterwards — only the leftovers that no longer describe missing folders.
  const index = loadIndex(memoryDir, cfg)
  try {
    cleanupCommitJournals(memoryDir)
  } catch {
    /* telemetry/journal cleanup is best effort */
  }
  const planObject = plan && typeof plan === 'object' ? plan : {}
  const warnings = Array.isArray(planObject.warnings) ? planObject.warnings.slice() : []
  const folderPlans = Array.isArray(planObject.folders) ? planObject.folders : []
  // storage.maxFolders is a documented safety cap: refuse the whole archive (the
  // caller then leaves the conversation untouched) instead of writing a partial
  // span, because the surface replacement would otherwise drop unarchived text.
  const maxFolders = Number(cfg?.storage?.maxFolders)
  if (
    Number.isFinite(maxFolders) && maxFolders > 0 && folderPlans.length > 0 &&
    index.folders.length + folderPlans.length > maxFolders
  ) {
    warnings.push(
      `commit: storage.maxFolders=${maxFolders} would be exceeded ` +
        `(${index.folders.length} folders already); refused to archive ${folderPlans.length} new folder(s)`,
    )
    return {
      folders: [],
      removed: [],
      keep: Array.isArray(planObject.keep) ? planObject.keep : [],
      warnings,
      skipped: 0,
      index,
      refused: true,
      reason: 'storage.maxFolders',
    }
  }
  const written = []
  let skipped = 0
  // P2/D2: collect keys from the index already loaded above (no meta scan, no
  // second index read); only a broken index falls back to the slow path.
  // A-01 (1.4.1): this map is the **pre-commit snapshot** used for skip
  // decisions. Keys written by *this* commit are never fed back into it: two
  // chunks of the same plan can legitimately have identical
  // (session, turn, seqStart, seqEnd, contentHash) — e.g. one long tool output
  // split into identical repeated-line chunks — and were silently treated as a
  // retry of each other (archived text loss).
  const existingKeys = idempotencyEnabled(options) ? collectFolderIdempotencyKeys(index, memoryDir, cfg, warnings) : new Map()
  // Plan-order occurrences of every content key, so the idempotency key is
  // unique inside one plan while a retry of the same plan reproduces it.
  const planKeyOccurrences = new Map()
  const journalPath = beginCommitJournal(memoryDir, commitJournalId(options), {
    sessionId: options.sessionId !== undefined ? options.sessionId : null,
    turn: finiteNumberOrNull(options.turn),
    folderIds: folderPlans.map((folderPlan) => (folderPlan && typeof folderPlan.id === 'string' ? folderPlan.id : null)).filter(Boolean),
    messages: Array.isArray(planObject.remove) ? planObject.remove.length : 0,
  })
  let currentId = null
  try {
    for (const folderPlan of folderPlans) {
      if (!folderPlan || !Array.isArray(folderPlan.messages) || !folderPlan.meta) continue
      let id = folderPlan.id
      if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) {
        id = allocateFolderId(memoryDir, cfg, index, folderPlan.meta.createdAt)
      }
      const meta = { ...folderPlan.meta, id }
      if (options.source && typeof options.source === 'object') {
        const source = { ...(meta.source && typeof meta.source === 'object' ? meta.source : {}) }
        for (const [key, value] of Object.entries(options.source)) {
          if (key === 'seqStart' || key === 'seqEnd') continue
          if (value !== undefined) source[key] = value
        }
        if (options.source.seqStart !== undefined) source.seqStart = options.source.seqStart
        if (options.source.seqEnd !== undefined) source.seqEnd = options.source.seqEnd
        meta.source = source
      }

      // P1-4: content-based idempotency first — a retry with a new `now`
      // (different createdAt / folder ids) must still not duplicate folders.
      // A-01 (1.4.1): append the chunk's occurrence index inside this plan, so
      // identical chunks written by *this* plan get distinct keys and are not
      // mistaken for a retry (a retry replays the same order ⇒ same keys).
      const baseIdempotencyKey = folderIdempotencyKey(meta, folderPlan.messages, options)
      let idempotencyKey = baseIdempotencyKey
      if (baseIdempotencyKey) {
        const occurrence = planKeyOccurrences.get(baseIdempotencyKey) ?? 0
        planKeyOccurrences.set(baseIdempotencyKey, occurrence + 1)
        idempotencyKey = `${baseIdempotencyKey}#${occurrence}`
        meta.idempotencyKey = idempotencyKey
      }
      if (idempotencyKey && existingKeys.has(idempotencyKey)) {
        skipped += 1
        const existingId = existingKeys.get(idempotencyKey)
        if (!index.folders.some((folder) => folder.id === existingId)) {
          try {
            index.folders.push(indexEntryFromMeta(readFolder(memoryDir, existingId).meta))
          } catch {
            /* a stale key for a vanished folder: just skip it */
          }
        }
        continue
      }
      // Cross-version continuity: folders archived by 1.4.0 carry the
      // unprefixed key, so the first occurrence also accepts the legacy form.
      if (idempotencyKey && baseIdempotencyKey && existingKeys.has(baseIdempotencyKey)) {
        skipped += 1
        continue
      }

      if (folderExists(memoryDir, id)) {
        let existingMeta = null
        try {
          existingMeta = readFolder(memoryDir, id).meta
        } catch {
          existingMeta = null
        }
        if (existingMeta && sameFolderContent(existingMeta, meta)) {
          skipped += 1
          // Make sure a rebuilt/missing index still lists the folder. The key is
          // NOT added to `existingKeys`: that map is the pre-commit snapshot
          // (A-01), and this folder belongs to the same span being retried.
          if (!index.folders.some((folder) => folder.id === id)) index.folders.push(indexEntryFromMeta(existingMeta))
          continue
        }
        const remapped = allocateFolderId(memoryDir, cfg, index, Number.isFinite(meta.createdAt) ? meta.createdAt : Date.now())
        warnings.push(`commit: folder id ${id} already exists; wrote the same span as ${remapped} instead`)
        id = remapped
        meta.id = id
      }

      currentId = id
      const writtenFolder = writeFolder(memoryDir, { id, meta, messages: folderPlan.messages })
      currentId = null
      // Track the folder before touching the in-memory index: a failure below
      // must still roll back this folder (never leave a disk-only orphan).
      written.push(writtenFolder)
      // A-01: intentionally NOT recorded in `existingKeys` — the next chunk of
      // this very plan must not be skipped because of it.
      index.folders.push(indexEntryFromMeta(writtenFolder.meta))
      index.nextCounter = Math.max(index.nextCounter || 1, counterFromFolderId(id) + 1)
    }

    // Index is the commit point: only after every folder `meta.json` landed.
    const writtenIndex = writeIndex(memoryDir, cfg, index)
    finishCommitJournal(journalPath)

    if (written.length > 0) {
      const removed = Array.isArray(planObject.remove) ? planObject.remove : []
      const removedChars = Number.isFinite(planObject.removeChars) ? planObject.removeChars : messagesChars(removed)
      const removedTokens = Number.isFinite(planObject.removeTokens) ? planObject.removeTokens : messagesTokens(removed)
      appendStats(memoryDir, cfg, {
        type: 'compress',
        time: Date.now(),
        sessionId: options.sessionId !== undefined ? options.sessionId : planObject.sessionId !== undefined ? planObject.sessionId : null,
        usedPercent: planObject.usedPercent,
        windowTokens: planObject.windowTokens !== null && planObject.windowTokens !== undefined ? planObject.windowTokens : null,
        removedChars,
        removedTokens,
        folderIds: written.map((folder) => folder.id),
        keptMessages: Array.isArray(planObject.keep) ? planObject.keep.length : 0,
        // v1.4.0 telemetry (§7): archive robustness observability.
        pendingAtArchive: finiteNumberOrNull(planObject.pendingAtArchive),
        pendingCount: finiteNumberOrNull(planObject.pendingCount),
        smallWindow: planObject.smallWindow === true,
        protectedTurn: planObject.protectedTurn === true,
        foldersPlanned: folderPlans.length,
        foldersCommitted: written.length,
        foldersSkipped: skipped,
        foldersArchived: written.length,
        // P1-6/O1: release cap + trickle (1-folder) archive observability.
        releaseCapped: planObject.releaseCapped === true,
        releaseFloor: planObject.releaseFloor === true,
        releaseTargetPercent: Number.isFinite(planObject.releaseTargetPercent) ? planObject.releaseTargetPercent : null,
        trickleArchive: planObject.trickleArchive === true,
        rollback: false,
        maxFoldersCapped: planObject.maxFoldersCapped === true,
        eventTimeSourceCounts: planObject.eventTimeSourceCounts && typeof planObject.eventTimeSourceCounts === 'object'
          ? planObject.eventTimeSourceCounts
          : {},
      })
    }

    return {
      folders: written,
      removed: Array.isArray(planObject.remove) ? planObject.remove : [],
      keep: Array.isArray(planObject.keep) ? planObject.keep : [],
      warnings,
      skipped,
      index: writtenIndex,
      journal: journalPath,
    }
  } catch (error) {
    // P1-4 rollback: remove the folders this call wrote (the failing folder too —
    // its directory may already exist with a context.json) and drop the journal.
    // The index was not rewritten, so it still matches the pre-commit state.
    const rolledBackIds = rollbackCommittedFolders(
      memoryDir,
      [...written.map((folder) => folder.id), currentId].filter(Boolean),
    )
    if (typeof options.removeImages === 'function') {
      try {
        options.removeImages({
          folderIds: rolledBackIds,
          sessionId: options.sessionId !== undefined ? options.sessionId : null,
          turn: finiteNumberOrNull(options.turn),
        })
      } catch {
        /* image cleanup is best effort */
      }
    }
    finishCommitJournal(journalPath)
    const failure = error instanceof Error ? error : new Error(String(error))
    failure.rolledBack = true
    failure.writtenFolderIds = rolledBackIds
    throw failure
  }
}

/** The exact prefix/grammar of the note produced by {@link buildArchiveNote}. It
 * is anchored at the start but deliberately not at the end (`$`): the compress
 * path may append a `\n\n` appendix with pinned non-conversation context. */
const ARCHIVE_NOTE_RE = /^\[memory\] (\d+) 段更早的对话已归档到 memory\/(?:（关键词：(.+?)）)?。需要时会自动回忆。/

/**
 * Build the single small note that replaces the removed span in the
 * model-visible conversation, e.g.
 * `[memory] 3 段更早的对话已归档到 memory/（关键词：部署、docker、端口）。需要时会自动回忆。`
 *
 * @param {ReturnType<typeof planCompression>} plan
 * @param {{ totalSegments?: number }} [options] `totalSegments` — a positive
 *   finite integer — overrides the `N` in “N 段更早的对话”. The compress path
 *   uses the cumulative segment count when it merged previous dsh-rofm
 *   checkpoints, so the single surviving note keeps counting (v1.2 R3). When
 *   absent/invalid the output is byte-identical to the historical note.
 * @returns {string}
 */
export function buildArchiveNote(plan, options = {}) {
  const folders = plan && Array.isArray(plan.folders) ? plan.folders : []
  if (!folders.length) return ''
  const keywords = []
  for (const folder of folders) {
    const list = folder && folder.meta && Array.isArray(folder.meta.keywords) ? folder.meta.keywords : []
    for (const keyword of list) {
      if (typeof keyword === 'string' && keyword && !keywords.includes(keyword)) keywords.push(keyword)
      if (keywords.length >= 5) break
    }
    if (keywords.length >= 5) break
  }
  const requestedTotal = options && typeof options === 'object' ? options.totalSegments : undefined
  const totalSegments =
    typeof requestedTotal === 'number' && Number.isFinite(requestedTotal) && Number.isInteger(requestedTotal) && requestedTotal > 0
      ? requestedTotal
      : folders.length
  const folderText = `${totalSegments} 段更早的对话`
  if (keywords.length > 0) {
    return `[memory] ${folderText}已归档到 memory/（关键词：${keywords.join('、')}）。需要时会自动回忆。`
  }
  return `[memory] ${folderText}已归档到 memory/。需要时会自动回忆。`
}

/**
 * Parse a checkpoint note produced by {@link buildArchiveNote} (v1.2 R3).
 * Recognizes both the keyword and the plain form, anchored at the START of the
 * text but tolerant of a following `\n\n` appendix. Foreign checkpoints (other
 * compressors) and non-note strings return `null`.
 *
 * @param {unknown} text
 * @returns {{ segments: number, keywords: string[] } | null}
 */
export function parseArchiveNote(text) {
  if (typeof text !== 'string') return null
  const match = ARCHIVE_NOTE_RE.exec(text)
  if (!match) return null
  const segments = Number.parseInt(match[1], 10)
  if (!Number.isFinite(segments) || segments <= 0) return null
  const keywords = typeof match[2] === 'string'
    ? match[2]
        .split('、')
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0)
    : []
  return { segments, keywords }
}

/** Extra helper: normalize messages before planning (used by the adapter/CLI).
 * All other plan options (protectTurn/protectSeq/allowSmallWindow/maxFolders/
 * eventTimes/…) are forwarded unchanged. */
export function planCompressionFromRaw({ messages, usedPercent, cfg, sessionId, now, turn, totalUsedTokens, windowTokens, ...rest } = {}) {
  return planCompression({
    messages: normalizeMessages(messages),
    usedPercent,
    cfg,
    sessionId,
    now,
    turn,
    totalUsedTokens,
    windowTokens,
    ...rest,
  })
}
