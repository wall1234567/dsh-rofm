/**
 * Read the DSH session surface: model-visible messages, per-node token prices
 * and safe replacement bounds.
 *
 * Everything here is read-only except `appendCompactionCheckpoint`, which lives
 * in `compaction.js`. Nothing imports a DSH package.
 */

import { contentToText } from './message-text.js'
import { rewriteVoiceNotes } from './voice-notes.js'
import { estimateTokens, parseArchiveNote } from '../engine/index.js'

/** Removable conversation roles; system prompts and tool-registry notes are pinned. */
const REMOVABLE_ROLES = new Set(['user', 'assistant', 'tool'])
/**
 * User-message source kinds that are real conversation. Everything else with a
 * `user` role is host-synthesized context (runtime-context, skill-catalog,
 * time-context, goal, approvals, ...): it is infrastructure that the host
 * re-injects, not conversation to archive or recall.
 */
const CONVERSATION_USER_SOURCE_KINDS = new Set(['user', 'agent-message', 'team-message', 'user-rpc'])

const balanceCache = new WeakMap()

/** Map seq -> token-meter node for one measurement. */
export function measurementNodeMap(measurement) {
  const map = new Map()
  for (const node of measurement?.nodes ?? []) map.set(node.seq, node)
  return map
}

/**
 * Build removable conversation entries in current surface order.
 * System prompts, developer/tool-registry notes and compaction checkpoints
 * (ours or the host's) are pinned: they never enter the removable prefix.
 *
 * @param {object} session
 * @param {object} measurement token-meter measurement (seq -> price)
 * @param {{ conversationSourceKinds?: string[], voiceNotes?: boolean }} [options] extra `source.kind`
 *   values that count as real conversation. QQ compatibility (v1.3.0) adds
 *   `plugin:dsh-onebot` here: those messages are real user input, but the
 *   built-in set cannot know about a third-party plugin's kind.
 *   `voiceNotes` (QQ channel sessions) rewrites onebot voice markers so the
 *   archived copy keeps both "it was voice" and the transcript — see
 *   `./voice-notes.js`.
 * @returns {{seq:number, role:string, text:string, chars:number, tokens:number, message:object}[]}
 */
export function buildSurfaceEntries(session, measurement, options = {}) {
  const nodes = session.surface?.nodes ?? []
  const prices = measurementNodeMap(measurement)
  const extraKinds = new Set(Array.isArray(options.conversationSourceKinds) ? options.conversationSourceKinds : [])
  const entries = []
  for (const seq of nodes) {
    const event = session.eventAt?.(seq)
    if (event === undefined) continue
    let message
    try {
      message = session.deriveEventMessage(event)
    } catch {
      continue
    }
    if (message === null || typeof message !== 'object') continue
    if (!REMOVABLE_ROLES.has(message.role)) continue
    // A compaction checkpoint is the archive note replacing an already-archived
    // span: not conversation content, so it may not become a recall folder.
    if (message.source?.kind === 'compact-checkpoint') continue
    // Pin host-synthesized "user" context (runtime context, skill catalog, ...):
    // it is not conversation, so it must not become a recall folder.
    if (message.role === 'user' && !CONVERSATION_USER_SOURCE_KINDS.has(message.source?.kind) && !extraKinds.has(message.source?.kind)) continue
    // Store role-free text: the engine's renderer adds the `role:` prefix when
    // building recall blocks, so storing `user: ...` here would render twice.
    // QQ channel sessions annotate onebot voice markers first: `[语音]` plus
    // the delivered `（语音转写：…）` become `[语音] <transcript>` so a recalled
    // memory still says it was spoken while keeping what was said.
    const rawText = contentToText(message.content)
    const text = options.voiceNotes === true ? rewriteVoiceNotes(rawText) : rawText
    if (text.length === 0) continue
    const price = prices.get(seq)
    const tokens = Number.isFinite(price?.tokens) && price.tokens >= 0 ? price.tokens : estimateTokens(text)
    entries.push({
      seq,
      role: message.role,
      text,
      chars: text.length,
      tokens,
      message,
    })
  }
  return entries
}

/**
 * Tool-call/result pairing balance over the current surface, mirroring the
 * host compaction contract: a valid replacement cut never splits one
 * assistant tool-call from its tool result.
 *
 * @returns {{before:(seq:number)=>boolean, after:(seq:number)=>boolean}}
 */
export function toolBalance(session) {
  const nodes = session.surface?.nodes ?? []
  const generation = session.surface?.replaceGeneration ?? 0
  const cached = balanceCache.get(session)
  if (cached !== undefined && cached.generation === generation && cached.nodes.length === nodes.length) {
    return cached.api
  }
  const before = new Array(nodes.length)
  const after = new Array(nodes.length)
  const index = new Map()
  let pending = 0
  for (let i = 0; i < nodes.length; i += 1) {
    const seq = nodes[i]
    before[i] = pending === 0
    index.set(seq, i)
    const event = session.eventAt?.(seq)
    pending += eventDelta(event)
    if (pending < 0) pending = 0
    after[i] = pending === 0
  }
  const api = {
    before(seq) {
      const i = index.get(seq)
      return i === undefined ? false : before[i]
    },
    after(seq) {
      const i = index.get(seq)
      return i === undefined ? false : after[i]
    },
  }
  balanceCache.set(session, { generation, nodes, api })
  return api
}

function eventDelta(event) {
  if (event === undefined) return 0
  if (event.type === 'assistant/message') {
    let calls = 0
    for (const block of event.data?.message?.content ?? []) {
      if (block?.type === 'tool-call') calls += 1
    }
    return calls
  }
  if (event.type === 'tool/result') return -1
  return 0
}

/**
 * Whether the session holds an open compaction transaction (start without
 * end). We must not append our own transaction while one is live.
 */
export function hasOpenCompaction(session) {
  const end = session.seq ?? 0
  const limit = Math.min(end, 4000)
  for (let offset = 1; offset <= limit; offset += 1) {
    const event = session.eventAt?.(end - offset)
    if (event === undefined) continue
    if (event.type === 'compaction/end') return false
    if (event.type === 'compaction/start') return true
    if (event.type === 'turn/start') return false
  }
  return false
}

/** Current context window in tokens: explicit config override first, host-reported second. */
export function resolveContextWindow(session, cfg) {
  const configured = Number(cfg?.compress?.contextWindowTokens)
  if (Number.isFinite(configured) && configured > 0) return configured
  const host = session.requestContext?.()?.contextWindow
  return Number.isFinite(host) && host > 0 ? host : 0
}

// ---------------------------------------------------------------------------
// Pinned (non-archived) surface nodes inside a compression span
// ---------------------------------------------------------------------------

/**
 * Host-synthesized `user` context that the host re-injects on every request
 * (runtime snapshot, per-turn time, skill catalog). It must never be copied
 * into the archive note: recording it only bloats the note with text that the
 * next request already carries again.
 */
const REINJECTED_PINNED_KINDS = new Set(['runtime-context', 'time-context', 'skill-catalog'])
/**
 * One-shot host notices that are NOT re-injected: if such a node is shadowed by
 * the checkpoint replacement and not copied into the note, the information is
 * gone from the model's context. They are recorded — but only the ones shadowed
 * by the *current* archive transaction.
 */
export const RECORDED_PINNED_KINDS = new Set(['subagent-settled', 'subagent-error-details', 'tool-jobs', 'user-approval'])
/** Legacy v1.2 history copy of the recall block; the head section re-injects it. */
const LEGACY_REINJECTED_KINDS = new Set(['rofm-recall'])

/**
 * Classify one pinned surface node (a node inside the span that is not an
 * archived conversation entry) by how the archive transaction must treat it.
 *
 * - `ours-checkpoint`: a previous dsh-rofm archive note — merged into the new
 *   note as a cumulative segment count, its text is dropped;
 * - `foreign-checkpoint`: a compaction checkpoint written by another compressor
 *   — never merged nor rewritten; it also stops the merge range from extending
 *   backwards (it is left exactly where it is);
 * - `droppable`: re-injected host infrastructure (runtime/time/skill context,
 *   in-history system-prompt copies) — shadowed silently, never recorded;
 * - `record`: one-shot host notice (subagent/job/approval) — shadowed and
 *   copied into the note so nothing is lost;
 * - `unknown`: anything else — treated as `record` (never lose data silently).
 *
 * @param {object} message derived surface message
 * @returns {'ours-checkpoint'|'foreign-checkpoint'|'droppable'|'record'|'unknown'}
 */
export function classifyPinnedMessage(message) {
  if (message === null || typeof message !== 'object') return 'unknown'
  const kind = message.source?.kind
  if (kind === 'compact-checkpoint') {
    return parseArchiveNote(contentToText(message.content)) === null ? 'foreign-checkpoint' : 'ours-checkpoint'
  }
  if (message.role === 'system' || message.role === 'developer') return 'droppable'
  if (REINJECTED_PINNED_KINDS.has(kind) || LEGACY_REINJECTED_KINDS.has(kind)) return 'droppable'
  if (RECORDED_PINNED_KINDS.has(kind)) return 'record'
  return 'unknown'
}

/**
 * Whether a pinned message's rendered text belongs in the archive-note appendix.
 * Only notices that the host does not re-inject are kept; unknown kinds are kept
 * as well (a new host feature must not lose information until reviewed).
 *
 * @param {object} message derived surface message
 * @returns {boolean}
 */
export function shouldRecordPinned(message) {
  const kind = message?.source?.kind
  if (RECORDED_PINNED_KINDS.has(kind)) return true
  if (message?.role === 'system' || message?.role === 'developer') return false
  if (REINJECTED_PINNED_KINDS.has(kind) || LEGACY_REINJECTED_KINDS.has(kind)) return false
  if (kind === 'compact-checkpoint') return false
  return true
}
