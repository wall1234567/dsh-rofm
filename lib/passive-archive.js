/**
 * dsh-rofm — passive archiving (plan D7).
 *
 * dsh-rofm normally archives its own span before the host compressor fires
 * (rofm triggers at 60% of the window, the preset/host compressor at 80%). When
 * another compressor wins the race — or rofm skipped the pass for a safety
 * reason — this module is the safety net: it listens to the host's
 * `compaction/summary` / `compaction/prune` events, recovers the conversation
 * those events shadowed and stores it in the same per-chat memory folder
 * (`<memoryDir>/mem-…`) while leaving the foreign checkpoint completely alone.
 *
 * Design constraints (plan D7/D5):
 *   - never write or modify a checkpoint (this module never appends a session
 *     event at all);
 *   - one compaction event produces at most one memory folder;
 *   - a per-memory-dir watermark (`.passive-watermark.json`) remembers which
 *     message seqs were already archived, so replaying an event, retrying or a
 *     session rebuild never duplicates content;
 *   - rofm's own compaction transactions are recognized (their summary is an
 *     archive note, not model output) and skipped: that span is already in
 *     memory, so archiving it again would duplicate it;
 *   - scoring follows `host.scoringModeFor`: `model` writes a pending folder
 *     (the current model rates it via `memory_judge`), anything else writes an
 *     already-scored folder via `heuristic-score.js` (the D8 fallback path);
 *   - `storage.maxFolders` is refused, not partially written;
 *   - every failure is contained: `handle()` logs and returns a result, it
 *     never throws (the host event listener must survive any archive problem).
 *
 * `handle()` only receives already-shaped data; it depends on exactly the small
 * host surface documented in {@link PassiveArchiver} (config, per-session
 * config, chat key, optional scoring mode, logger), so it can be tested with a
 * minimal fake session/host and wired by the plugin without importing DSH.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  appendStats,
  atomicWriteJson,
  commitCompression,
  contentToText,
  estimateTokens,
  parseArchiveNote,
  renderMessage,
} from '../engine/index.js'
import { scoreHeuristic } from './heuristic-score.js'

/** Watermark file inside the (per chat) memory dir. */
const WATERMARK_FILE = '.passive-watermark.json'
const WATERMARK_VERSION = 1
/** Compaction event types whose shadowed span we recover. */
const SUPPORTED_EVENT_TYPES = new Set(['compaction/summary', 'compaction/prune'])
/** Only real conversation roles are archived (checkpoints/system/tool are not). */
const ARCHIVABLE_ROLES = new Set(['user', 'assistant'])
/** Source kind of a compaction checkpoint message (ours or foreign). */
const CHECKPOINT_SOURCE_KIND = 'compact-checkpoint'
/** `meta.source.kind` of a passively archived folder. */
const PASSIVE_SOURCE_KIND = 'passive-archive'
/**
 * Longest folder title, in Unicode code points.
 *
 * Must match the active-archive path (`engine/compress.js` `normalizeTitle`,
 * limited to 24 code points) and docs/SPEC.md §9 R2: titles are display-only and
 * the two archival paths must not disagree about their shape.
 */
const MAX_TITLE_CHARS = 24

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Non-negative integer (event seq) or `null`. */
function seqOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** Finite number or `fallback`. */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function errorMessage(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message) return error.message
  try {
    const text = String(error)
    return text.length > 0 ? text : 'unknown error'
  } catch {
    return 'unknown error'
  }
}

/** Deduplicated non-negative integer seq list (keeps event order). */
function normalizeSeqList(value) {
  const out = []
  const seen = new Set()
  for (const seq of Array.isArray(value) ? value : []) {
    if (!Number.isInteger(seq) || seq < 0 || seen.has(seq)) continue
    seen.add(seq)
    out.push(seq)
  }
  return out
}

/** Deduplicated non-empty string id list. */
function normalizeIdList(value) {
  const out = []
  const seen = new Set()
  for (const id of Array.isArray(value) ? value : []) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

// ---------------------------------------------------------------------------
// host helpers (the host object is supplied by the plugin; every access is
// tolerant so a partially wired host only degrades, never throws)
// ---------------------------------------------------------------------------

function hostConfig(host) {
  try {
    if (isRecord(host) && typeof host.currentConfig === 'function') {
      const cfg = host.currentConfig()
      if (isRecord(cfg)) return cfg
    }
  } catch {
    /* an exploding config store must not break the event listener */
  }
  return null
}

function hostScopedConfig(host, cfg, session) {
  try {
    if (isRecord(host) && typeof host.scopedConfig === 'function') {
      const scoped = host.scopedConfig(cfg, session)
      if (isRecord(scoped)) return scoped
    }
  } catch {
    /* fall back to the unscoped config (its memoryDir may still be valid) */
  }
  return cfg
}

function hostChatKey(host, session) {
  try {
    if (isRecord(host) && typeof host.chatKeyFor === 'function') {
      const key = host.chatKeyFor(session)
      if (typeof key === 'string' && key.length > 0) return key
    }
  } catch {
    /* telemetry-only value */
  }
  return undefined
}

/**
 * `model` → the caller must wait for the model (`memory_judge`); any other
 * answer, a missing hook or a throwing hook → the heuristic fallback (D8).
 */
function hostScoringMode(host, session, cfg) {
  try {
    if (isRecord(host) && typeof host.scoringModeFor === 'function') {
      const mode = host.scoringModeFor(session, cfg)
      if (mode === 'model') return 'model'
      if (mode === 'heuristic') return 'heuristic'
    }
  } catch {
    /* a broken scorer must not disable passive archiving */
  }
  return 'heuristic'
}

function hostLog(host, level, message) {
  try {
    if (isRecord(host) && typeof host.log === 'function') host.log(level, message)
  } catch {
    /* logging must never break archiving */
  }
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

/**
 * Read the raw event data + derive the original message at one seq.
 * @returns {{ event: object, message: object } | null}
 */
function derivedMessageAt(session, seq) {
  try {
    if (!isRecord(session)) return null
    if (typeof session.eventAt !== 'function' || typeof session.deriveEventMessage !== 'function') return null
    const sourceEvent = session.eventAt(seq)
    if (sourceEvent === null || typeof sourceEvent !== 'object') return null
    const message = session.deriveEventMessage(sourceEvent)
    if (message === null || typeof message !== 'object') return null
    return { event: sourceEvent, message }
  } catch {
    return null
  }
}

/** A compaction checkpoint is not conversation, whichever compressor wrote it. */
function isCheckpointMessage(message) {
  const source = isRecord(message?.source) ? message.source : null
  return source !== null && source.kind === CHECKPOINT_SOURCE_KIND
}

/** Whether this summary is a dsh-rofm archive note (our own active archive). */
function isRofmArchiveSummary(event) {
  try {
    const data = isRecord(event) && isRecord(event.data) ? event.data : {}
    const summary = Array.isArray(data.summary) ? data.summary : []
    for (const block of summary) {
      if (!isRecord(block) || typeof block.text !== 'string' || block.text.length === 0) continue
      if (parseArchiveNote(block.text) !== null) return true
    }
  } catch {
    /* not a recognizable summary */
  }
  return false
}

/**
 * Internal extraction: public messages plus the seq each one came from.
 * @returns {{
 *   entries: { seq: number, role: 'user'|'assistant', content: string, time?: number }[],
 *   shadowedSeqs: number[], startSeq: number|null, endSeq: number|null, shadowedTokenCount: number,
 * }}
 */
function extractEntries(session, event) {
  /** @type {ReturnType<typeof extractEntries>} */
  const empty = { entries: [], shadowedSeqs: [], startSeq: null, endSeq: null, shadowedTokenCount: 0 }
  try {
    if (!isRecord(event) || !SUPPORTED_EVENT_TYPES.has(event.type)) return empty
    const data = isRecord(event.data) ? event.data : {}
    const shadowedSeqs = normalizeSeqList(data.shadowedSeqs)
    const range = isRecord(data.shadowedRange) ? data.shadowedRange : {}
    const startSeq = seqOrNull(range.start) ?? (shadowedSeqs.length > 0 ? shadowedSeqs[0] : null)
    const endSeq = seqOrNull(range.end) ?? (shadowedSeqs.length > 0 ? shadowedSeqs[shadowedSeqs.length - 1] : null)
    const shadowedTokenCount = finiteOr(data.shadowedTokenCount, 0)

    const entries = []
    for (const seq of shadowedSeqs) {
      const derived = derivedMessageAt(session, seq)
      if (derived === null) continue
      const { event: sourceEvent, message } = derived
      if (!ARCHIVABLE_ROLES.has(message.role)) continue
      if (isCheckpointMessage(message)) continue
      let content = ''
      try {
        content = contentToText(message.content)
      } catch {
        content = ''
      }
      if (typeof content !== 'string') content = ''
      content = content.trim()
      if (content.length === 0) continue
      const entry = { seq, role: message.role, content }
      if (typeof sourceEvent.time === 'number' && Number.isFinite(sourceEvent.time)) entry.time = sourceEvent.time
      entries.push(entry)
    }
    return { entries, shadowedSeqs, startSeq, endSeq, shadowedTokenCount }
  } catch {
    return empty
  }
}

/**
 * Extract the conversation messages shadowed by one compaction event (D7).
 *
 * Only `compaction/summary` and `compaction/prune` are recognized. For every
 * seq in `event.data.shadowedSeqs` the original event is re-derived from the
 * session (`session.eventAt(seq)` + `session.deriveEventMessage`) and kept only
 * when it is a real conversation message: role `user`/`assistant`, non-empty
 * text, and not a compaction checkpoint. System/tool/developer messages are
 * dropped. The returned messages are normalized (`content` is a string,
 * `time` present when the event carries one) and never throw.
 *
 * @param {unknown} session DSH session (only `eventAt`/`deriveEventMessage` used)
 * @param {unknown} event session event (`{ type, seq, time, data }`)
 * @returns {{
 *   messages: { role: 'user'|'assistant', content: string, time?: number }[],
 *   shadowedSeqs: number[],
 *   startSeq: number|null,
 *   endSeq: number|null,
 *   shadowedTokenCount: number,
 * }}
 */
export function extractShadowedMessages(session, event) {
  const extracted = extractEntries(session, event)
  const messages = []
  for (const entry of extracted.entries) {
    const message = { role: entry.role, content: entry.content }
    if (typeof entry.time === 'number' && Number.isFinite(entry.time)) message.time = entry.time
    messages.push(message)
  }
  return {
    messages,
    shadowedSeqs: extracted.shadowedSeqs.slice(),
    startSeq: extracted.startSeq,
    endSeq: extracted.endSeq,
    shadowedTokenCount: extracted.shadowedTokenCount,
  }
}

// ---------------------------------------------------------------------------
// folder building
// ---------------------------------------------------------------------------

/** Message shape written to `context.json` (public extraction fields). */
function storedMessage(entry) {
  const message = { role: entry.role, content: entry.content }
  if (typeof entry.time === 'number' && Number.isFinite(entry.time)) message.time = entry.time
  return message
}

/** `meta.stats` of one folder, same definition as the engine compression path. */
function folderStats(messages) {
  let chars = 0
  let tokens = 0
  for (const message of messages) {
    const rendered = renderMessage(message)
    chars += rendered.length
    tokens += estimateTokens(rendered)
  }
  return { messages: messages.length, chars, tokens }
}

/** Title: the first 24 code points of the archived body (whitespace collapsed). */
function folderTitle(messages) {
  const parts = []
  for (const message of messages) {
    const text = typeof message.content === 'string' ? message.content : contentToText(message.content)
    if (typeof text === 'string' && text.length > 0) parts.push(text)
  }
  const body = parts.join('\n').replace(/\s+/g, ' ').trim()
  return [...body].slice(0, MAX_TITLE_CHARS).join('')
}

/**
 * Base meta shared by both scoring paths; the required D7 fields live here.
 * @param {{ messages: object[], compactionSeq: number|null, startSeq: number|null,
 *           endSeq: number|null, scoreMode: 'model'|'heuristic', now: number }} input
 */
function buildFolderMetaBase(input) {
  return {
    createdAt: input.now,
    title: folderTitle(input.messages),
    stats: folderStats(input.messages),
    source: {
      kind: PASSIVE_SOURCE_KIND,
      compactionSeq: input.compactionSeq,
      seqStart: input.startSeq,
      seqEnd: input.endSeq,
    },
    scoreMode: input.scoreMode,
  }
}

/** Pending folder: the current model scores it through `memory_judge` (D8). */
function buildPendingMeta(input) {
  return {
    ...buildFolderMetaBase(input),
    alpha: 0,
    beta: 0,
    keywords: [],
    scored: false,
    alphaSource: 'pending',
    keywordsSource: 'pending',
    betaSource: 'pending',
    pendingSince: input.now,
  }
}

/** Already-scored folder: deterministic D8 fallback values. */
function buildHeuristicMeta(input, cfg) {
  const score = scoreHeuristic(input.messages, cfg)
  return {
    meta: {
      ...buildFolderMetaBase(input),
      alpha: score.alpha,
      beta: score.beta,
      keywords: score.keywords,
      scored: true,
      alphaSource: score.metaExtra.alphaSource,
      keywordsSource: score.metaExtra.keywordsSource,
      betaSource: score.metaExtra.betaSource,
      signals: { ...score.signals },
    },
    warnings: score.warnings,
  }
}

// ---------------------------------------------------------------------------
// watermark
// ---------------------------------------------------------------------------

function emptyWatermark() {
  return { version: WATERMARK_VERSION, archivedSeqs: [], folderIds: [], updatedAt: 0 }
}

function watermarkPath(memoryDir) {
  return path.join(memoryDir, WATERMARK_FILE)
}

/** Read the watermark; a missing/corrupt file degrades to an empty watermark. */
function readWatermark(memoryDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(watermarkPath(memoryDir), 'utf8'))
    if (!isRecord(parsed)) return emptyWatermark()
    return {
      version: WATERMARK_VERSION,
      archivedSeqs: normalizeSeqList(parsed.archivedSeqs),
      folderIds: normalizeIdList(parsed.folderIds),
      updatedAt: finiteOr(parsed.updatedAt, 0),
    }
  } catch {
    return emptyWatermark()
  }
}

/** Atomic (tmp + rename) watermark write. Throws on I/O failure; caller logs. */
function writeWatermark(memoryDir, watermark) {
  atomicWriteJson(watermarkPath(memoryDir), watermark)
}

// ---------------------------------------------------------------------------
// archiver
// ---------------------------------------------------------------------------

/**
 * Passive archiver (D7). The plugin constructs one instance and forwards every
 * `session/event`; only compaction events cause work.
 *
 * Required host surface (nothing else is touched):
 *   currentConfig()                    → engine/adapter config
 *   scopedConfig(cfg, session)         → cfg with per-chat `memoryDir`
 *   chatKeyFor(session)                → stable per-chat key (telemetry)
 *   log(level, message)                → host logger
 * Optional:
 *   scoringModeFor(session, cfg)       → 'model' | 'heuristic' (default 'heuristic')
 */
export class PassiveArchiver {
  /** @param {{ currentConfig?: Function, scopedConfig?: Function, chatKeyFor?: Function,
   *             scoringModeFor?: Function, log?: Function }} host */
  constructor(host) {
    this.host = isRecord(host) ? host : {}
  }

  /**
   * Recover and archive the span shadowed by one compaction event.
   *
   * Never throws; failures are reported through the returned `skipped`/`reason`
   * fields and a `warn` log line.
   *
   * @param {unknown} session DSH session
   * @param {unknown} event session event from `session/event`
   * @returns {{ archived: number, folderIds: string[], skipped?: string, reason?: string }}
   *   `archived` is the number of conversation messages written to the new
   *   folder (0 when skipped); `folderIds` are the created memory folder ids.
   */
  handle(session, event) {
    /** @type {{ archived: number, folderIds: string[], skipped?: string, reason?: string }} */
    const result = { archived: 0, folderIds: [] }
    const host = this.host
    try {
      // Cheap first: the listener sees every session event.
      if (!isRecord(event) || !SUPPORTED_EVENT_TYPES.has(event.type)) {
        result.skipped = 'unsupported-event'
        return result
      }
      // Our own active archive already stored this span in memory folders.
      if (isRofmArchiveSummary(event)) {
        result.skipped = 'rofm-archive-note'
        return result
      }

      const extracted = extractEntries(session, event)
      if (extracted.entries.length === 0) {
        result.skipped = 'no-shadowed-conversation'
        return result
      }

      const cfg = hostConfig(host)
      if (cfg === null) {
        result.skipped = 'no-config'
        return result
      }
      const scopedCfg = hostScopedConfig(host, cfg, session)
      const memoryDir = typeof scopedCfg.memoryDir === 'string' && scopedCfg.memoryDir.length > 0 ? scopedCfg.memoryDir : ''
      if (memoryDir.length === 0) {
        result.skipped = 'no-memory-dir'
        return result
      }

      // Watermark dedupe: replay/retry/session-rebuild archives each seq once.
      const watermark = readWatermark(memoryDir)
      const archivedSeqs = new Set(watermark.archivedSeqs)
      const freshEntries = extracted.entries.filter((entry) => !archivedSeqs.has(entry.seq))
      if (freshEntries.length === 0) {
        result.skipped = 'already-archived'
        return result
      }

      const now = Date.now()
      const chatKey = hostChatKey(host, session)
      // One compaction event = at most one folder.
      const folderMessages = freshEntries.map(storedMessage)
      const compactionSeq = seqOrNull(event.seq) ?? seqOrNull(event.data?.seq)
      const scoreMode = hostScoringMode(host, session, cfg)
      const metaInput = {
        messages: folderMessages,
        compactionSeq,
        startSeq: extracted.startSeq,
        endSeq: extracted.endSeq,
        scoreMode,
        now,
      }

      let meta
      if (scoreMode === 'model') {
        meta = buildPendingMeta(metaInput)
      } else {
        const scored = buildHeuristicMeta(metaInput, cfg)
        for (const warning of scored.warnings) hostLog(host, 'warn', `passive-archive: ${warning}`)
        meta = scored.meta
      }

      // Commit through the engine so index.json and telemetry stay consistent.
      // `storage.maxFolders` is enforced there: the whole folder is refused.
      let committed = null
      try {
        committed = commitCompression(
          { folders: [{ meta, messages: folderMessages }], warnings: [] },
          { memoryDir, cfg: scopedCfg, sessionId: chatKey },
        )
      } catch (error) {
        hostLog(host, 'warn', `passive-archive: folder commit failed: ${errorMessage(error)}`)
        committed = null
      }
      if (committed !== null && committed.refused === true) {
        result.skipped = 'storage.maxFolders'
        result.reason = 'storage.maxFolders'
        hostLog(host, 'warn', 'passive-archive: skipped: storage.maxFolders would be exceeded')
        return result
      }
      const written = committed !== null && Array.isArray(committed.folders) ? committed.folders : []
      const folderIds = []
      for (const folder of written) {
        const id = folder && typeof folder.id === 'string' ? folder.id : ''
        if (id.length > 0 && !folderIds.includes(id)) folderIds.push(id)
      }
      if (folderIds.length === 0) {
        result.skipped = 'commit-failed'
        return result
      }

      // The folder exists now: remember its seqs so the event cannot double-archive.
      let watermarkWritten = false
      try {
        writeWatermark(memoryDir, {
          version: WATERMARK_VERSION,
          archivedSeqs: normalizeSeqList([...watermark.archivedSeqs, ...freshEntries.map((entry) => entry.seq)]),
          folderIds: normalizeIdList([...watermark.folderIds, ...folderIds]),
          updatedAt: now,
        })
        watermarkWritten = true
      } catch (error) {
        // Worst case the same event is archived again later; never lose the folder.
        hostLog(host, 'warn', `passive-archive: watermark write failed: ${errorMessage(error)}`)
      }

      // Best-effort telemetry; a telemetry failure is not an archive failure.
      try {
        appendStats(memoryDir, scopedCfg, {
          type: 'passive-archive',
          time: now,
          sessionId: chatKey,
          compactionSeq,
          seqStart: extracted.startSeq,
          seqEnd: extracted.endSeq,
          shadowedSeqCount: extracted.shadowedSeqs.length,
          archivedMessages: folderMessages.length,
          folderIds,
          scoreMode,
          watermarkWritten,
        })
      } catch {
        /* telemetry must never break archiving */
      }

      result.archived = folderMessages.length
      result.folderIds = folderIds
      hostLog(
        host,
        'info',
        `passive-archive: archived ${folderMessages.length} message(s) from compaction seq ${compactionSeq ?? '?'} ` +
          `(${extracted.shadowedSeqs.length} shadowed) -> ${folderIds.join(', ')}${watermarkWritten ? '' : ' (watermark write failed)'}`,
      )
      return result
    } catch (error) {
      // The host event listener must never see an exception from archiving.
      result.archived = 0
      result.folderIds = []
      result.skipped = 'error'
      result.reason = errorMessage(error)
      hostLog(host, 'warn', `passive-archive: unexpected failure: ${errorMessage(error)}`)
      return result
    }
  }
}
