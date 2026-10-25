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
