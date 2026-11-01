/**
 * dsh-rofm engine — public API (docs/SPEC.md §7).
 *
 * Everything here is synchronous, zero-dependency and free of DSH imports. The
 * DSH adapter (`index.js` in the repository root, owned by the plugin) is a thin
 * wrapper around `MemoryEngine`.
 */

// config
export {
  DEFAULT_CONFIG,
  BUILTIN_STOPWORDS,
  PLUGIN_ROOT,
  BETA_MIN,
  BETA_MAX,
  DEFAULT_BETA,
  normalizeBeta,
  loadConfig,
  validateConfig,
  resolveMemoryDir,
  mergeConfigFile,
  mergeConfig,
  deepMerge,
  cloneConfig,
  defaultConfigPath,
} from './config.js'

// tokenization / message model
export {
  estimateTokens,
  estimateMessagesTokens,
  normalizeMessages,
  renderMessage,
  extractKeywords,
  extractKeywordsDetailed,
  tokenize,
  normalizeText,
  matchesKeyword,
  keywordMatches,
  countKeywordMatches,
  sharedKeywordCount,
  normalizeKeywordScore,
  contentToText,
} from './tokenize.js'

// α
export { computeImportance, alphaForFolder, DECISION_MARKERS } from './importance.js'

// probability primitives
export { erf, recallProbability, createRng } from './recall.js'

// compression
export { planCompression, commitCompression, buildArchiveNote, parseArchiveNote, eventTimeRangeOf } from './compress.js'

// recall
export { recall, loadRecallAdditions, buildRecallBlock, formatBeta, RECALL_BLOCK_PREAMBLE } from './recall.js'

// v1.4.0 deterministic recall selector (FAIR-DRI, docs/SPEC.md §6.2)
export {
  buildRecallIndex,
  querySeeds,
  countCandidates,
  selectRecall,
  selectSigma,
  comparePriority,
  emptyLanes,
  serializeLanes,
  deserializeLanes,
  lanesFingerprint,
  trimBlock,
  simulateTurns,
  summarizeGuarantees,
} from './recall-index.js'

// v1.4.0 keyword matching (bidirectional, docs/SPEC.md §6.6)
export { matchKeywords, hasMatch } from './keyword-match.js'

// v1.4.0 time assistance (in-memory index only, docs/SPEC.md §6.8)
export {
  TIME_DEFAULTS,
  detectGranularity,
  normalizeTimeQuery,
  folderTimeRange,
  buildTimeIndex,
  queryTimeIndex,
  timeFallbackLadder,
  timeConstraintEnabled,
  zonedDayStart,
  zonedMonthStart,
  zonedYearStart,
  dayKey,
  addZonedDays,
  formatWindow,
  validateTimezone,
} from './time-index.js'

// engine facade
export { MemoryEngine } from './engine.js'

// persistence
export {
  readIndex,
  loadIndex,
  rebuildIndex,
  writeIndex,
  refreshIndex,
  listFolders,
  readFolder,
  writeFolder,
  ensureMemoryDir,
  appendStats,
  readStats,
  folderExists,
  folderDir,
  allocateFolderId,
  formatFolderId,
  folderStamp,
  memoryPaths,
  atomicWriteJson,
  indexEntryFromMeta,
  scanFolderMetas,
  // v1.4.0: optional index fields + commit transaction helpers
  PENDING_ERAS,
  SCORE_MODES,
  ARCHIVE_SOURCES,
  EVENT_TIME_SOURCES,
  removeFolder,
  beginCommitJournal,
  finishCommitJournal,
  cleanupCommitJournals,
} from './store.js'

// report math (extra convenience exports, used by tools/recall-report.mjs)
export { summarizeStats, formatReport, roundNumber } from './stats.js'

// v1.4.0 data-era classification (legacy / synthetic / current pending buckets).
// Single truth shared by lib/plugin.js, tools/memory-audit.mjs,
// tools/selfcheck.mjs and tools/recall-report.mjs.
export {
  LEGACY_ERA_CUTOFF_MS,
  SYNTHETIC_WINDOW_TOKENS,
  SYNTHETIC_BEFORE_PERCENT,
  STRESS_MIN_FOLDERS,
  STRESS_MIN_PENDING,
  sessionEraSignals,
  sessionEra,
  classifyFolderEra,
  summarizeEras,
} from './era.js'
