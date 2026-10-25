/**
 * Durable compaction transaction for the memory archive.
 *
 * The host represents "this span of conversation is gone, here is a small
 * checkpoint instead" with exactly one compaction bracket:
 *
 *   compaction/start  ->  compaction/summary  ->  user/message(checkpoint, replace)  ->  compaction/end
 *
 * Reusing the host's own representation (instead of inventing an event type)
 * keeps replay, token accounting, UI and future host compaction working: the
 * replacement message is model-visible while the original user transcript stays
 * in the log for the human. No model/LLM is involved; the summary is the
 * deterministic archive note produced by the engine.
 */

import { randomUUID } from 'node:crypto'

/**
 * Errors thrown *after* the surface replacement already landed. Kept out-of-band
 * (WeakSet) because a thrown value may be a frozen object where attaching a
 * property silently fails. The plugin consults `archiveCommitted()` to decide
 * whether deleting the just-written memory folders would lose data.
 */
const committedReplacementErrors = new WeakSet()

/** Whether this error happened after the model-visible surface was replaced. */
export function archiveCommitted(error) {
  return error !== null && typeof error === 'object' && committedReplacementErrors.has(error)
}

/** Create the checkpoint user message that replaces a compacted span. */
function checkpointMessage(note, compactionId) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: note }],
    source: { kind: 'compact-checkpoint', compactionId },
  }
}

/**
 * Append one complete compaction transaction that replaces the inclusive
 * surface span `startSeq..endSeq` with one small archive note.
 *
 * The transaction is appended synchronously, without yielding: the host token
 * meter arms a shadow price on `compaction/summary` and consumes it on the
 * immediately following replacement event, and the compaction invariant (when
 * that companion plugin is active) requires a matching start/end bracket inside
 * the currently open turn.
 *
 * @param {object} session DSH Session
 * @param {{turn:number|null, note:string, startSeq:number, endSeq:number,
 *          shadowedSeqs:number[], shadowedTokenCount:number}} input
 */
export function appendCompactionCheckpoint(session, input) {
  const { turn, note, startSeq, endSeq, shadowedSeqs, shadowedTokenCount } = input
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) {
    throw new Error('dsh-rofm: empty compaction span')
  }
  if (shadowedSeqs[0] !== startSeq || shadowedSeqs[shadowedSeqs.length - 1] !== endSeq) {
    throw new Error('dsh-rofm: compaction span edges do not match shadowed seqs')
  }
  const compactionId = randomUUID()
  const lifecycle = { compactionId, turn }
  const startEvent = session.append('compaction/start', lifecycle)
  let replacementCommitted = false
  try {
    const summaryEvent = session.append('compaction/summary', {
      ...lifecycle,
      summary: [{ type: 'text', text: note }],
      shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
    })
    const checkpointEvent = session.append('user/message', checkpointMessage(note, compactionId), {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    replacementCommitted = true
    const endEvent = session.append('compaction/end', lifecycle)
    return {
      compactionId,
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      checkpointSeq: checkpointEvent.seq,
      endSeq: endEvent.seq,
    }
  } catch (error) {
    // The caller must not delete the folders once the model-visible surface has
    // already been replaced: they are the only archive of the removed span.
    if (replacementCommitted && error !== null && typeof error === 'object') {
      committedReplacementErrors.add(error)
    }
    // Never leave an unmatched compaction/start behind: it is the host's
    // durable "compaction in progress" lock.
    try {
      session.append('compaction/end', {
        ...lifecycle,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: 'MEMORY_RECALL_COMPRESS_FAILED',
        },
      })
    } catch {
      // The host rejected the close event too; the error below is the one that
      // matters, and the next host boot repairs the stale bracket.
    }
    throw error
  }
}
