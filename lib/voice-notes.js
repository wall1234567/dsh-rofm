/**
 * QQ voice notes (QQ channel sessions): keep "this was voice" and "this is what was said"
 * together when a channel conversation is archived.
 *
 * `dsh-onebot-qq` renders an inbound voice message as the bare placeholder
 * `[语音]` and (when STT is enabled) delivers the transcript later as its own
 * steer message labeled `（语音转写：…）` (lib/stt.js `transcriptLabel`). The
 * archived copy is what recall later shows, so it must carry both facts:
 *
 *   `（语音转写：帮我记一下周五开会）`  →  `[语音] 帮我记一下周五开会`
 *   `[语音]`（转写失败/关闭）          →  `[语音]（未转写）`
 *
 * The rewrite is a pure string transform: it never adds or drops words, a
 * text without either marker is returned unchanged, and applying it twice to
 * its own output is a no-op (already annotated text is protected first).
 */

/** Full-width parens exactly as `transcriptLabel()` writes them. */
const TRANSCRIPT_RE = /（语音转写：([^）]*)）/g
const PLACEHOLDER = '[语音]'
const UNTRANSCRIBED = '[语音]（未转写）'
/** Marks a freshly delivered transcript while placeholders are rewritten. */
const TRACKED = '\u0000rofm-voice\u0000'
/** Marks an already annotated `[语音] ` prefix (idempotency). */
const ANNOTATED = '\u0000rofm-voice-annotated\u0000'
/** Marks an already annotated `[语音]（未转写）`. */
const UNTRANSCRIBED_SENTINEL = '\u0000rofm-voice-untranscribed\u0000'

/**
 * Rewrite voice markers of one archived message.
 *
 * @param {unknown} text raw message text from the session surface
 * @returns {string|unknown} the annotated text (non-strings pass through)
 */
export function rewriteVoiceNotes(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!text.includes(PLACEHOLDER) && !text.includes('（语音转写：')) return text
  let out = text
  // 1. Protect what a previous run already produced (idempotency).
  out = out.split(UNTRANSCRIBED).join(UNTRANSCRIBED_SENTINEL)
  out = out.split(PLACEHOLDER + ' ').join(ANNOTATED + ' ')
  // 2. A delivered transcript becomes `[语音] <text>`.
  out = out.replace(TRANSCRIPT_RE, (_match, transcript) => {
    const body = String(transcript).trim()
    return body === '' ? UNTRANSCRIBED_SENTINEL : TRACKED + body
  })
  // 3. Anything still bare never got a transcript: say so explicitly.
  out = out.split(PLACEHOLDER).join(UNTRANSCRIBED_SENTINEL)
  // 4. Restore the final shapes.
  out = out.split(TRACKED).join(PLACEHOLDER + ' ')
  out = out.split(ANNOTATED).join(PLACEHOLDER)
  out = out.split(UNTRANSCRIBED_SENTINEL).join(UNTRANSCRIBED)
  return out
}

/** Whether a message text carries a voice marker this module understands. */
export function hasVoiceMarker(text) {
  return typeof text === 'string' && (text.includes(PLACEHOLDER) || text.includes('（语音转写：'))
}
