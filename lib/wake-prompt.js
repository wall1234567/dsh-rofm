/**
 * dsh-rofm — Derpyu qq-bridge wake-prompt restoration (v1.5.9).
 *
 * The Derpyu bridge delivers every wake-up as a single `source.kind === "user"`
 * message: persona card + rules + session token + a `【本次消息快照】` JSON packet
 * + trailing instructions. That message is *transport*, not conversation. Before
 * v1.5.9 it was archived verbatim, so the template (and the token) became a
 * memory and was later recalled as if it were something the user had said.
 *
 * This module performs string-only restoration:
 *
 *   - detect the bridge's wake shell/snapshot without comparing the whole text
 *     (a bridge upgrade may add sections; unknown sections are dropped with the
 *     shell, so it keeps working);
 *   - rebuild the conversation lines from `messages` (oldest first) and
 *     `recent` (may include the bot's own "我：…" rows), de-duplicated by
 *     `messageId || seq`;
 *   - redact the bridge's session token, sanitize unpaired surrogates and bound
 *     the result.
 *
 * It never imports DSH and never touches a session: callers decide whether the
 * feature is active (Derpyu detection + `compat.derpyuWakeSanitize`) and apply
 * the returned text only to the archive copy / recall query.
 */

import { safeSlice, toWellFormed } from './message-text.js'

/** The bridge's unique snapshot marker (half-width brackets are NOT accepted). */
export const WAKE_SNAPSHOT_MARKER = '【本次消息快照】'
/** Archive body prefix for a snapshot that carried conversation. */
export const WAKE_SNAPSHOT_PREFIX = '[QQ 唤醒快照]'
/** Archive body for a wake with no conversation rows. */
export const WAKE_EMPTY_TEXT = '[QQ 唤醒：无新消息]'
/** Archive body when the snapshot marker exists but its JSON cannot be parsed. */
export const WAKE_UNPARSEABLE_TEXT = '[QQ 唤醒：快照无法解析，已省略模板]'
/** Upper bound of the restored conversation text, in UTF-16 code units. */
export const WAKE_CONVERSATION_LIMIT = 8000

/**
 * Known section headers of the Derpyu wake shell. Two or more hits (without a
 * snapshot marker) identify a shell wake. The list is deliberately a set of
 * stable prefix fragments: a bridge upgrade can add sections without breaking
 * detection, and the unknown additions are dropped together with the shell.
 */
const WAKE_SHELL_HEADERS = Object.freeze([
  '【角色卡',
  '【角色卡结束】',
  '【你的身份】',
  '【会话令牌】',
  '【沉睡前强制等待】',
  '【此刻状态】',
  '【当前唤醒】',
  '【首回复节奏】',
  '【反AI味】',
  '【参与度参考】',
  '【时间感',
  '【唤醒】',
  '【引导唤醒】',
  '【回复检查】',
  '【主动机会】',
])

/** Wake section whose name is reported as `reasonTitle`. */
const REASON_TITLE_RE = /【(?:主动机会|引导唤醒|当前唤醒|唤醒)】/

/** The bridge's session-token section: `【会话令牌】<hex>`. */
const SESSION_TOKEN_RE = /【会话令牌】[0-9a-fA-F]{16,}/g

/** Message-row fields that carry visible conversation text (text wins). */
const WAKE_TEXT_FIELDS = Object.freeze(['text', 'plain', 'content'])
/** Message-row fields that name the sender. */
const WAKE_SENDER_FIELDS = Object.freeze(['sender', 'nickname', 'name', 'userName', 'user_name'])
/** Optional display time of one row; rendered as `[at] sender：text`. */
const WAKE_AT_FIELDS = Object.freeze(['at'])

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** First non-empty trimmed string among `fields`, or `null`. */
function firstTextField(row, fields) {
  for (const field of fields) {
    const value = row[field]
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text.length > 0) return text
  }
  return null
}

/** Collapse CR/LF inside one message row so one row stays one archive line. */
function normalizeInline(text) {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim()
}

/**
 * Redact the bridge session token wherever it appears in restored text.
 *
 * The placeholder deliberately does NOT repeat the `【会话令牌】` marker: the
 * archive acceptance check greps `context.json` for that literal, and a
 * redaction that leaves the marker behind would make the check ambiguous.
 */
function redactSessionToken(text) {
  return text.replace(SESSION_TOKEN_RE, '[会话令牌已隐藏]')
}

/** Bound and well-form the restored conversation. */
function finalizeConversation(text) {
  let out = toWellFormed(redactSessionToken(text))
  if (out.length > WAKE_CONVERSATION_LIMIT) {
    const suffix = '\n…（截断）'
    out = safeSlice(out, WAKE_CONVERSATION_LIMIT - suffix.length) + suffix
  }
  return out
}

/** Reason-section label (`【唤醒】` / `【主动机会】` / …), or `''`. */
function reasonTitleOf(text) {
  const match = REASON_TITLE_RE.exec(text)
  return match === null ? '' : match[0]
}

/** True when at least one known shell header is present. */
function countShellHeaders(text) {
  let count = 0
  for (const header of WAKE_SHELL_HEADERS) {
    if (text.includes(header)) count += 1
  }
  return count
}

/**
 * Locate the first line after the marker whose first non-space character is
 * `{`. Returns the line and the absolute index of its `{` in `rest`.
 */
function findFirstJsonLine(rest) {
  let offset = 0
  while (offset <= rest.length) {
    const newline = rest.indexOf('\n', offset)
    const end = newline === -1 ? rest.length : newline
    const line = rest.slice(offset, end)
    const trimmed = line.trimStart()
    if (trimmed.startsWith('{')) {
      return { line, start: offset + (line.length - trimmed.length) }
    }
    if (newline === -1) break
    offset = newline + 1
  }
  return null
}

/**
 * Extract the first balanced `{…}` object from `text`, honouring JSON strings
 * and escapes. Returns `null` when the braces never balance (truncated JSON).
 */
function balancedJsonText(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

/** Parse one candidate as a JSON object (never throws). */
function parseObjectText(text) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, value: null }
  try {
    const value = JSON.parse(text)
    return isRecord(value) ? { ok: true, value } : { ok: false, value: null }
  } catch {
    return { ok: false, value: null }
  }
}

/**
 * Parse the snapshot JSON after the marker.
 *
 * Primary path: the first line after the marker that starts with `{` must parse
 * on its own (the bridge normally emits compact one-line JSON). Fallback: brace
 * pairing from that same `{`, which also accepts pretty-printed packets. A
 * truncated packet fails both paths and is reported as `ok:false`.
 */
function parseSnapshotJson(rest) {
  const found = findFirstJsonLine(rest)
  if (found === null) return { ok: false, value: null, raw: '' }
  const direct = parseObjectText(found.line.trim())
  if (direct.ok) return { ok: true, value: direct.value, raw: found.line.trim() }
  const matched = balancedJsonText(rest.slice(found.start))
  if (matched === null) return { ok: false, value: null, raw: '' }
  const fallback = parseObjectText(matched)
  return fallback.ok ? { ok: true, value: fallback.value, raw: matched } : { ok: false, value: null, raw: '' }
}

/**
 * Build one conversation line per packet row, in order: `messages` (unread,
 * oldest first) then `recent` (may contain the bot's own rows). Rows are
 * de-duplicated by `messageId || seq` across both arrays.
 *
 * @param {object} packet parsed snapshot object
 * @returns {string[]}
 */
function conversationLinesOf(packet) {
  const lines = []
  const seen = new Set()
  for (const field of ['messages', 'recent']) {
    const rows = Array.isArray(packet[field]) ? packet[field] : []
    for (const row of rows) {
      if (!isRecord(row)) continue
      const id = row.messageId ?? row.seq
      if (id !== undefined && id !== null) {
        const key = String(id)
        if (key.length > 0) {
          if (seen.has(key)) continue
          seen.add(key)
        }
      }
      const text = firstTextField(row, WAKE_TEXT_FIELDS)
      if (text === null) continue
      const body = normalizeInline(text)
      if (body.length === 0) continue
      const sender = firstTextField(row, WAKE_SENDER_FIELDS)
      const at = firstTextField(row, WAKE_AT_FIELDS)
      let line = sender === null ? body : `${sender}：${body}`
      if (at !== null) line = `[${at}] ${line}`
      lines.push(line)
    }
  }
  return lines
}

/**
 * Identify one message as a Derpyu wake prompt.
 *
 * @param {unknown} content message text
 * @returns {{
 *   kind: 'none'|'wake-snapshot'|'wake-shell',
 *   conversation: string,
 *   snapshotChars: number,
 *   reasonTitle: string,
 *   parsed: boolean,
 * }}
 *   `conversation` is the restored, cleaned conversation ('' for `none` and for
 *   a shell wake); `snapshotChars` is the parsed JSON length (0 when absent);
 *   `parsed` is false only for a snapshot whose JSON could not be parsed.
 */
export function classifyWakePrompt(content) {
  const text = typeof content === 'string' ? content : ''
  if (text.includes(WAKE_SNAPSHOT_MARKER)) {
    const markerIndex = text.indexOf(WAKE_SNAPSHOT_MARKER)
    const rest = text.slice(markerIndex + WAKE_SNAPSHOT_MARKER.length)
    const snapshot = parseSnapshotJson(rest)
    const conversation = snapshot.ok ? finalizeConversation(conversationLinesOf(snapshot.value).join('\n')) : ''
    return {
      kind: 'wake-snapshot',
      conversation,
      snapshotChars: snapshot.raw.length,
      reasonTitle: reasonTitleOf(text),
      parsed: snapshot.ok,
    }
  }
  if (countShellHeaders(text) >= 2) {
    return {
      kind: 'wake-shell',
      conversation: '',
      snapshotChars: 0,
      reasonTitle: reasonTitleOf(text),
      parsed: true,
    }
  }
  return { kind: 'none', conversation: '', snapshotChars: 0, reasonTitle: '', parsed: true }
}

/**
 * Produce the archive copy of one message.
 *
 * Only the *archive copy* is changed: the caller keeps the live session message
 * untouched. A non-wake message is returned verbatim.
 *
 * @param {unknown} content message text
 * @returns {{ kind: string, text: string, templateChars: number, parseFailed: boolean }}
 *   `templateChars` is the original length (0 when `kind === 'none'`).
 */
export function sanitizeWakeForArchive(content) {
  const original = typeof content === 'string' ? content : ''
  const wake = classifyWakePrompt(original)
  if (wake.kind === 'none') {
    return { kind: 'none', text: original, templateChars: 0, parseFailed: false }
  }
  if (wake.kind === 'wake-snapshot' && wake.parsed === false) {
    return { kind: wake.kind, text: WAKE_UNPARSEABLE_TEXT, templateChars: original.length, parseFailed: true }
  }
  if (wake.conversation.length === 0) {
    return { kind: wake.kind, text: WAKE_EMPTY_TEXT, templateChars: original.length, parseFailed: false }
  }
  return {
    kind: wake.kind,
    text: `${WAKE_SNAPSHOT_PREFIX}\n${wake.conversation}`,
    templateChars: original.length,
    parseFailed: false,
  }
}

/**
 * Produce the recall query for one message.
 *
 * The automatic recall path must search for the *conversation* carried by the
 * wake prompt, never for the template's own section names (which would keep
 * matching memory folders that contain the old templates and create a
 * self-reinforcing recall loop). An empty `query` means "this wake carried no
 * new conversation": the caller should skip automatic recall for this round.
 *
 * @param {unknown} content message text
 * @returns {{ kind: string, query: string, parsed: boolean }}
 *   `kind === 'none'` returns the original text as the query (a safe no-op).
 */
export function wakeToRecallQuery(content) {
  const original = typeof content === 'string' ? content : ''
  const wake = classifyWakePrompt(original)
  if (wake.kind === 'none') return { kind: 'none', query: original, parsed: true }
  return { kind: wake.kind, query: wake.conversation, parsed: wake.parsed }
}
