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
 */

import { DEFAULT_BETA, DEFAULT_CONFIG, resolveMemoryDir } from './config.js'
import { computeImportance } from './importance.js'
import {
  allocateFolderId,
  appendStats,
  ensureMemoryDir,
  folderExists,
  formatFolderId,
  indexEntryFromMeta,
  loadIndex,
  readFolder,
  writeFolder,
  writeIndex,
} from './store.js'
import { estimateTokens, extractKeywords, normalizeMessages, renderMessage } from './tokenize.js'

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
        for (const fragment of splitSentences(message.content, targetChars)) {
          pushMessage({ role: message.role, content: fragment }, start)
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
 * @param {{
 *   messages: any[],
 *   usedPercent: number,
 *   cfg: object,
 *   sessionId?: string,
 *   now?: number,
 *   turn?: number,
 *   totalUsedTokens?: number,
 *   windowTokens?: number,
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
  plan.windowTokens = Number.isFinite(Number(options.windowTokens)) ? Number(options.windowTokens) : null
  plan.usedTokens = Number.isFinite(totalUsedTokens) && totalUsedTokens > 0 ? totalUsedTokens : plan.totalTokens

  if (!compressCfg.enabled) {
    plan.reason = 'below-threshold'
    plan.warnings.push('compress.enabled is false; compression skipped')
    return plan
  }
  if (!Number.isFinite(usedPercent) || !(usedPercent > compressCfg.triggerPercent)) return plan

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

  const targetTokens = plan.usedTokens * (compressCfg.compressPercent / 100)
  plan.targetTokens = roundNumber(targetTokens, 2)
  if (!(targetTokens > 0)) {
    plan.reason = 'nothing-to-remove'
    return plan
  }

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
  const tokenPrefix = new Array(messages.length + 1)
  tokenPrefix[0] = 0
  for (let index = 0; index < messages.length; index += 1) tokenPrefix[index + 1] = tokenPrefix[index] + tokens[index]
  const tokensUpTo = (boundary) => (boundary >= 0 && boundary <= messages.length ? tokenPrefix[boundary] : Infinity)
  const findBoundaryAtOrAfter = () => {
    for (let boundary = cut; boundary <= maxCut; boundary += 1) {
      if (messages[boundary] && messages[boundary].role === 'user') return boundary
    }
    return -1
  }
  const findBoundaryBefore = () => {
    for (let boundary = Math.min(cut, maxCut); boundary >= 1; boundary -= 1) {
      if (messages[boundary] && messages[boundary].role === 'user') return boundary
    }
    return -1
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
  } else if (cut > 0) {
    chosen = Math.min(cut, maxCut)
    plan.warnings.push('planCompression: could not align the cut to a user-turn boundary; remaining history may start inside a turn')
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

  const targetChunkChars = Math.max(1, compressCfg.targetChunkChars)
  const minChunkChars = Math.max(1, compressCfg.minChunkChars)
  const maxFoldersPerRun = Math.max(1, compressCfg.maxFoldersPerRun)
  let chunks = chunkSegments(userTurnSegments(remove), targetChunkChars)
  chunks = mergeTinyChunks(chunks, minChunkChars)
  chunks = capChunks(chunks, maxFoldersPerRun)

  const baseNow = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const folderCount = chunks.length
  const folderPlans = []
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

/**
 * Commit a plan: write folders + update index + append telemetry.
 *
 * @param {ReturnType<typeof planCompression>} plan
 * @param {{
 *   memoryDir: string,
 *   cfg: object,
 *   sessionId?: string,
 *   turn?: number,
 *   source?: object,
 * }} options `source` is merged into every folder's `meta.source`.
 */
export function commitCompression(plan, options = {}) {
  const cfg = options.cfg && typeof options.cfg === 'object' ? options.cfg : DEFAULT_CONFIG
  const memoryDir = options.memoryDir || resolveMemoryDir(cfg)
  ensureMemoryDir(memoryDir)
  const index = loadIndex(memoryDir, cfg)
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

    if (folderExists(memoryDir, id)) {
      let existingMeta = null
      try {
        existingMeta = readFolder(memoryDir, id).meta
      } catch {
        existingMeta = null
      }
      if (existingMeta && sameFolderContent(existingMeta, meta)) {
        skipped += 1
        // Make sure a rebuilt/missing index still lists the folder.
        if (!index.folders.some((folder) => folder.id === id)) index.folders.push(indexEntryFromMeta(existingMeta))
        continue
      }
      const remapped = allocateFolderId(memoryDir, cfg, index, Number.isFinite(meta.createdAt) ? meta.createdAt : Date.now())
      warnings.push(`commit: folder id ${id} already exists; wrote the same span as ${remapped} instead`)
      id = remapped
      meta.id = id
    }

    const writtenFolder = writeFolder(memoryDir, { id, meta, messages: folderPlan.messages })
    index.folders.push(indexEntryFromMeta(writtenFolder.meta))
    index.nextCounter = Math.max(index.nextCounter || 1, counterFromFolderId(id) + 1)
    written.push(writtenFolder)
  }

  const writtenIndex = writeIndex(memoryDir, cfg, index)

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
    })
  }

  return {
    folders: written,
    removed: Array.isArray(planObject.remove) ? planObject.remove : [],
    keep: Array.isArray(planObject.keep) ? planObject.keep : [],
    warnings,
    skipped,
    index: writtenIndex,
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

/** Extra helper: normalize messages before planning (used by the adapter/CLI). */
export function planCompressionFromRaw({ messages, usedPercent, cfg, sessionId, now, turn, totalUsedTokens, windowTokens }) {
  return planCompression({
    messages: normalizeMessages(messages),
    usedPercent,
    cfg,
    sessionId,
    now,
    turn,
    totalUsedTokens,
    windowTokens,
  })
}
