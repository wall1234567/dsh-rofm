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
export { planCompression, commitCompression, buildArchiveNote } from './compress.js'

// recall
export { recall, buildRecallBlock, formatBeta, RECALL_BLOCK_PREAMBLE } from './recall.js'

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
} from './store.js'

// report math (extra convenience exports, used by tools/recall-report.mjs)
export { summarizeStats, formatReport, roundNumber } from './stats.js'
