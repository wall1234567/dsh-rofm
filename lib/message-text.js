/**
 * Convert DSH/minimal message content into plain text for memory storage,
 * keyword extraction and char statistics.
 *
 * This module deliberately knows nothing about Cordis: it only reads the
 * message shape that DSH derives from its session surface.
 */

/** Maximum characters kept for one tool-call argument blob in memory text. */
const TOOL_ARG_LIMIT = 400

/** Shorten one string for display/storage without throwing on odd input. */
export function truncate(value, limit) {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…[+${text.length - limit}]`
}

/**
 * Render one content-block array (or plain string) to readable text.
 * Reasoning blocks are omitted: they are hidden model output, not conversation
 * the user or the memory should replay. Images/files become compact markers so
 * keywords still see their names.
 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`[tool-call ${block.name ?? 'unknown'} ${truncate(block.arguments, TOOL_ARG_LIMIT)}]`)
        break
      case 'tool-result':
        break
      case 'tool-addition':
        parts.push(`[tool-added ${block.toolName ?? 'unknown'}]`)
        break
      case 'tool-removal':
        parts.push(`[tool-removed ${block.toolName ?? 'unknown'}]`)
        break
      case 'image':
        parts.push('[image]')
        break
      case 'file':
        parts.push(`[file ${block.attachment?.name ?? ''}]`)
        break
      case 'reasoning':
        break
      default:
        break
    }
  }
  return parts.join('\n').trim()
}

/** Render one derived message as a plain text block, prefixed by its role. */
export function messageToText(message) {
  if (message === null || typeof message !== 'object') return ''
  const text = contentToText(message.content).trim()
  const role = message.role ?? 'unknown'
  if (role === 'tool') {
    const callId = message.toolCallId ? ` ${message.toolCallId}` : ''
    return `tool${callId}: ${text}`
  }
  if (role === 'assistant') return `assistant: ${text}`
  if (role === 'user') return `user: ${text}`
  if (role === 'developer') return `developer: ${text}`
  if (role === 'system') return `system: ${text}`
  return `${role}: ${text}`
}

// ---------------------------------------------------------------------------
// Model-facing previews (v1.4.3)
// ---------------------------------------------------------------------------
//
// Archiving is lossless: it stores whatever text the DSH surface carried. In a
// QQ-compat session that text is often a *raw JSON tool result* — the bridge's
// MCP tools answer with `serializeModelData(...)`:
//
//   qq_get_unread_messages → {"ok":true,"key":"private:…","messages":[
//     {"seq":5,"messageId":"…","sender":"私聊","userId":"…","text":"真实聊天内容"},…]}
//   qq_wait_for_messages    → {"ok":true,…,"newMessages":[ … same message rows … ]}
//
// Truncating that to 160 characters shows only JSON field names, so the model
// scoring a pending memory cannot see the conversation and under-scores it
// (observed live: α 0.1–0.4, median 0.3). The helpers below re-render archived
// messages for prompts only — stored data and `messageToText` are untouched.

/** Max characters of JSON-extracted text kept for one message. */
const JSON_PREVIEW_CHAR_LIMIT = 4000

/** Max object/array nodes visited while sniffing one JSON payload. */
const JSON_PREVIEW_NODE_LIMIT = 500

/** Fields of a JSON object that carry visible conversation text. */
const JSON_CHAT_TEXT_FIELDS = ['text', 'plain', 'content']

/** Fields that name who sent one JSON message row (QQ bridge shape). */
const JSON_SENDER_FIELDS = ['sender', 'nickname', 'name', 'author', 'from', 'userName', 'user_name']

/** Structural fields kept when a JSON payload has no conversation text (errors/hints). */
const JSON_NOTE_FIELDS = ['error', 'hint', 'note', 'message', 'reason', 'title', 'subject', 'summary', 'description', 'body', 'question', 'answer']

/** Parse one whole text as JSON only when it is exactly an object/array. */
function parseWholeJsonText(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length < 2) return null
  const head = trimmed[0]
  const tail = trimmed[trimmed.length - 1]
  if (!((head === '{' && tail === '}') || (head === '[' && tail === ']'))) return null
  try {
    return { value: JSON.parse(trimmed) }
  } catch {
    return null
  }
}

/** First non-empty trimmed string value of `fields` in a JSON object. */
function firstTextField(object, fields) {
  for (const field of fields) {
    const value = object[field]
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text.length > 0) return text
  }
  return null
}

/** Append one extracted line, bounded and without consecutive duplicates. */
function pushPreviewLine(state, line) {
  if (state.chars >= JSON_PREVIEW_CHAR_LIMIT) return
  const text = String(line ?? '').trim()
  if (text.length === 0) return
  if (state.lines.length > 0 && state.lines[state.lines.length - 1] === text) return
  const remaining = JSON_PREVIEW_CHAR_LIMIT - state.chars
  const bounded = text.length <= remaining ? text : text.slice(0, remaining)
  state.lines.push(bounded)
  state.chars += bounded.length + 1
}

/**
 * Walk one parsed JSON payload and collect its model-readable lines.
 *
 * Chat message rows (an object with a `text`/`plain`/`content` string) become
 * one line each, prefixed by their sender when available; ids, seq numbers and
 * flags are dropped. Unknown payloads recurse in insertion order, so nested
 * `messages` / `newMessages` arrays and merged-forward rows are still found.
 * Structural strings (error/hint/…) survive as bare lines when the payload has
 * no conversation text, so a failed tool result stays informative.
 */
function collectJsonPreviewLines(value, state) {
  if (state.nodes >= JSON_PREVIEW_NODE_LIMIT || state.chars >= JSON_PREVIEW_CHAR_LIMIT) return
  if (Array.isArray(value)) {
    for (const item of value) collectJsonPreviewLines(item, state)
    return
  }
  if (value === null || typeof value !== 'object') return
  state.nodes += 1
  const chatText = firstTextField(value, JSON_CHAT_TEXT_FIELDS)
  if (chatText !== null) {
    // A real chat/message row: this is what proves the payload carries a
    // conversation (an arbitrary JSON object with a `text`-like key is not).
    state.chatRows += 1
    const sender = firstTextField(value, JSON_SENDER_FIELDS)
    pushPreviewLine(state, sender === null ? chatText : `${sender}：${chatText}`)
  } else {
    const note = firstTextField(value, JSON_NOTE_FIELDS)
    if (note !== null) pushPreviewLine(state, note)
  }
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') collectJsonPreviewLines(child, state)
  }
}

/** Fresh bounded state for one JSON walk. */
function newJsonWalkState() {
  return { lines: [], chars: 0, nodes: 0, chatRows: 0 }
}

/**
 * Chat lines embedded in a longer message, e.g. the QQ bridge's wake prompt:
 * `【唤醒】…【本次消息快照】\n{"messages":[{"sender":"…","text":"…"}]}\n以上消息…`.
 * Returns null unless the bracketed span parses as JSON *and* contains at least
 * one real message row, so prose/code that merely contains braces is untouched.
 */
function embeddedJsonLines(text) {
  const start = text.search(/[{[]/)
  if (start < 0) return null
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const state = newJsonWalkState()
  collectJsonPreviewLines(parsed, state)
  if (state.chatRows === 0 || state.lines.length === 0) return null
  return state.lines
}

/** Readable lines of one message text: whole JSON payload or embedded snapshot. */
function jsonTextLines(text) {
  const parsed = parseWholeJsonText(text)
  if (parsed !== null) {
    const state = newJsonWalkState()
    collectJsonPreviewLines(parsed.value, state)
    return state.lines.length > 0 ? state.lines : null
  }
  return embeddedJsonLines(text)
}

/** Remove tool-protocol marker lines (`[tool-call …]` etc.) from one message. */
function stripToolProtocolLines(text) {
  if (!text.includes('[tool-')) return text
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(
        trimmed.startsWith('[tool-call ') ||
        trimmed.startsWith('[tool-result') ||
        trimmed.startsWith('[tool-added ') ||
        trimmed.startsWith('[tool-removed ')
      )
    })
    .join('\n')
    .trim()
}

/**
 * Render one archived message for a model-facing preview/recap.
 *
 * @param {object} message archived message (`{role, content}`)
 * @returns {{ role: string, text: string, conversational: boolean, protocolOnly: boolean, jsonLike: boolean }}
 *   `text` is the readable rendering; `conversational` is false for pure tool
 *   output / structural system messages; `protocolOnly` marks the legacy
 *   `[tool-call …]` renderer (dropped from the summary once the folder really has
 *   conversation, kept for review fallbacks); `jsonLike` marks a payload that
 *   stays raw JSON (unparseable/truncated) — also dropped from the summary when
 *   the folder has readable conversation instead.
 */
export function messagePreview(message) {
  const blank = { role: 'unknown', text: '', conversational: false, protocolOnly: false, jsonLike: false }
  if (message === null || typeof message !== 'object') return blank
  const role = typeof message.role === 'string' && message.role.length > 0 ? message.role : 'unknown'
  const raw = contentToText(message.content).trim()
  if (raw.length === 0) return { ...blank, role }
  const readable = stripToolProtocolLines(raw)
  if (readable.length === 0) {
    // A pure tool-call/protocol message: keep the legacy marker only for the
    // tool-only fallback, never as "conversation".
    return { role, text: `${role}: ${raw}`, conversational: false, protocolOnly: true, jsonLike: false }
  }
  const jsonLines = jsonTextLines(readable)
  if (jsonLines !== null) return { role, text: jsonLines.join('\n'), conversational: true, protocolOnly: false, jsonLike: false }
  const text = `${role}: ${readable}`
  return {
    role,
    text,
    conversational: role === 'user' || role === 'assistant',
    protocolOnly: false,
    jsonLike: /^[[{]/.test(readable),
  }
}

/**
 * Bounded one-line preview of one archived folder for the scoring list.
 *
 * The rendering is in-place: every message keeps its position and the preview is
 * the same all-messages flatten as before, except that (1) JSON payloads are
 * humanized by {@link messagePreview} and (2) when the folder really has readable
 * conversation, pure `[tool-call …]` markers and raw-JSON leftovers (truncated /
 * unparseable payloads whose text is still field names) are dropped — they are
 * exactly the noise this fix targets. A folder with no conversation at all keeps
 * the legacy byte-identical flatten; plain tool text keeps its position (this is
 * a "summary shows JSON, not conversation" fix, not a re-ranking of the summary).
 *
 * @param {object[]} messages archived messages
 * @param {number} [limit] max characters (default 160)
 * @returns {{ summary: string, conversational: boolean }}
 */
export function conversationPreview(messages, limit = 160) {
  const entries = (Array.isArray(messages) ? messages : [])
    .map((message) => messagePreview(message))
    .filter((entry) => entry.text.length > 0)
  const hasConversation = entries.some((entry) => entry.conversational)
  const source = hasConversation ? entries.filter((entry) => !entry.protocolOnly && !entry.jsonLike) : entries
  const flat = source.map((entry) => entry.text).join('\n').replace(/\s+/g, ' ').trim()
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 160
  if (flat.length <= max) return { summary: flat, conversational: hasConversation }
  // Same contract as the pre-1.4.3 `text.slice(0, 160)`: a hard character cut
  // with no marker, so an unchanged folder keeps a byte-identical summary.
  return { summary: flat.slice(0, max), conversational: hasConversation }
}

/**
 * Full readable text of one archived folder (re-review "原文" and cross-chat
 * snippets): same rendering as {@link messagePreview}, joined by newlines and
 * never truncated here (callers bound it to their own budget).
 *
 * @param {object[]} messages archived messages
 * @returns {string}
 */
export function messagesToReadableText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => messagePreview(message).text)
    .filter((text) => typeof text === 'string' && text.trim().length > 0)
    .join('\n')
    .trim()
}

/** Total characters of one derived message's conversation text. */
export function messageChars(message) {
  return contentToText(message?.content).length
}

/** Sum characters over a message array. */
export function messagesChars(messages) {
  let total = 0
  for (const message of messages ?? []) total += messageChars(message)
  return total
}

/** Whether a message is a real human input (not runtime context / checkpoint / tool). */
export function isRealUserMessage(message) {
  if (message === null || typeof message !== 'object') return false
  if (message.role !== 'user') return false
  const kind = message.source?.kind
  return kind === 'user'
}
