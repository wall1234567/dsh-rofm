/**
 * dsh-rofm engine — telemetry math and report formatting.
 *
 * `summarizeStats(events)` is the single source of truth for the numbers shown
 * by `engine/report()` and by `tools/recall-report.mjs`; keeping it here makes
 * the report math unit-testable (docs/SPEC.md §9).
 */

/** Round to a fixed number of decimals without -0. */
export function roundNumber(value, digits = 2) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const factor = 10 ** digits
  const rounded = Math.round((number + Number.EPSILON) * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

/**
 * Aggregate `stats.jsonl` events into the test-phase report numbers.
 *
 * Percentages are averages of the per-event percentages (of the *current*
 * context / window at recall time), matching the "(of current context, average
 * per event)" note; when no per-event percentage exists the aggregate ratio is
 * used as a fallback.
 *
 * @param {object[]} events
 */
export function summarizeStats(events) {
  const list = Array.isArray(events) ? events : []
  const summary = {
    recallEvents: 0,
    contextCharsSum: 0,
    charsAdded: 0,
    addedTokens: 0,
    windowTokensSum: 0,
    attempts: 0,
    foldersAdded: 0,
    byGeneration: {},
    compressionEvents: 0,
    charsMovedToMemory: 0,
    avgRecallLatencyMs: 0,
    contextAddedPercent: null,
    windowTokensAddedPercent: null,
  }

  let contextPercentSum = 0
  let contextPercentCount = 0
  let windowPercentSum = 0
  let windowPercentCount = 0
  let latencySum = 0
  let latencyCount = 0

  for (const event of list) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'recall') {
      summary.recallEvents += 1
      if (Number.isFinite(event.contextChars)) summary.contextCharsSum += event.contextChars
      if (Number.isFinite(event.addedChars)) summary.charsAdded += event.addedChars
      if (Number.isFinite(event.addedTokens)) summary.addedTokens += event.addedTokens
      if (Number.isFinite(event.windowTokens)) summary.windowTokensSum += event.windowTokens
      if (Number.isFinite(event.attempts)) summary.attempts += event.attempts
      if (Number.isFinite(event.addedFolders)) summary.foldersAdded += event.addedFolders
      if (Number.isFinite(event.latencyMs)) {
        latencySum += event.latencyMs
        latencyCount += 1
      }
      if (Number.isFinite(event.addedPercentOfContext)) {
        contextPercentSum += event.addedPercentOfContext
        contextPercentCount += 1
      }
      if (Number.isFinite(event.addedPercentOfWindow)) {
        windowPercentSum += event.addedPercentOfWindow
        windowPercentCount += 1
      }
      const byGeneration = event.byGeneration
      if (byGeneration && typeof byGeneration === 'object') {
        for (const [generation, count] of Object.entries(byGeneration)) {
          if (!Number.isFinite(count)) continue
          const key = String(Number.parseInt(generation, 10))
          if (key === 'NaN') continue
          summary.byGeneration[key] = (summary.byGeneration[key] || 0) + count
        }
      }
    } else if (event.type === 'compress') {
      summary.compressionEvents += 1
      if (Number.isFinite(event.removedChars)) summary.charsMovedToMemory += event.removedChars
    }
  }

  if (contextPercentCount > 0) {
    summary.contextAddedPercent = roundNumber(contextPercentSum / contextPercentCount)
  } else if (summary.contextCharsSum > 0) {
    summary.contextAddedPercent = roundNumber((summary.charsAdded / summary.contextCharsSum) * 100)
  }

  if (windowPercentCount > 0) {
    summary.windowTokensAddedPercent = roundNumber(windowPercentSum / windowPercentCount)
  } else if (summary.windowTokensSum > 0) {
    summary.windowTokensAddedPercent = roundNumber((summary.addedTokens / summary.windowTokensSum) * 100)
  }

  summary.avgRecallLatencyMs = latencyCount > 0 ? roundNumber(latencySum / latencyCount) : 0
  return summary
}

const percentText = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(2))
const msText = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '0.00')

/**
 * Render the human-readable report printed by `engine report` and
 * `tools/recall-report.mjs` (format fixed by docs/SPEC.md §9).
 * @param {ReturnType<typeof summarizeStats>} summary
 */
export function formatReport(summary) {
  const s = summary && typeof summary === 'object' ? summary : summarizeStats([])
  const generations = Object.keys(s.byGeneration || {})
    .map((generation) => Number.parseInt(generation, 10))
    .filter((generation) => Number.isFinite(generation))
    .sort((a, b) => a - b)
    .map((generation) => `gen${generation}=${s.byGeneration[String(generation)]}`)
    .join(', ')
  const foldersLine = s.foldersAdded > 0
    ? `folders added          : ${s.foldersAdded} (${generations})`
    : 'folders added          : 0'
  const lines = [
    '=== memory recall report ===',
    `recall events          : ${s.recallEvents || 0}`,
    `context chars (sum)    : ${s.contextCharsSum || 0}`,
    `chars added back       : ${s.charsAdded || 0}`,
    `context added back     : ${percentText(s.contextAddedPercent)} %`,
    '  (of current context, average per event)',
    `window tokens added    : ${percentText(s.windowTokensAddedPercent)} %`,
    foldersLine,
    `compression events     : ${s.compressionEvents || 0}, chars moved to memory: ${s.charsMovedToMemory || 0}`,
    `avg recall latency     : ${msText(s.avgRecallLatencyMs)} ms`,
  ]
  return lines.join('\n') + '\n'
}
