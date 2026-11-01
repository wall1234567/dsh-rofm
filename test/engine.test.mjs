/**
 * Engine tests — config, tokenizer/message model, α, store, cached engine,
 * performance (docs/SPEC.md §10.1-3, §10.6-7).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  BETA_MAX,
  BETA_MIN,
  DEFAULT_BETA,
  DEFAULT_CONFIG,
  MemoryEngine,
  PLUGIN_ROOT,
  alphaForFolder,
  appendStats,
  atomicWriteJson,
  computeImportance,
  ensureMemoryDir,
  estimateMessagesTokens,
  estimateTokens,
  extractKeywords,
  extractKeywordsDetailed,
  formatFolderId,
  keywordMatches,
  listFolders,
  loadConfig,
  loadIndex,
  matchesKeyword,
  mergeConfigFile,
  memoryPaths,
  normalizeBeta,
  normalizeMessages,
  readFolder,
  readIndex,
  readStats,
  rebuildIndex,
  refreshIndex,
  renderMessage,
  resolveMemoryDir,
  tokenize,
  validateConfig,
  writeFolder,
  writeIndex,
  folderExists,
  indexEntryFromMeta,
  planCompression,
  // v1.4.0
  PENDING_ERAS,
  SCORE_MODES,
  ARCHIVE_SOURCES,
  EVENT_TIME_SOURCES,
  beginCommitJournal,
  cleanupCommitJournals,
  finishCommitJournal,
  removeFolder,
  // v1.4.0 data eras
  LEGACY_ERA_CUTOFF_MS,
  classifyFolderEra,
  sessionEra,
  sessionEraSignals,
  summarizeEras,
} from '../engine/index.js'

const tempDirs = []
function tempDir(prefix = 'dshr-engine-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function writeFolderDirect(memoryDir, spec) {
  const messages = spec.messages || []
  const meta = {
    version: 1,
    id: spec.id,
    createdAt: spec.createdAt,
    alpha: spec.alpha ?? 0.5,
    keywords: spec.keywords || [],
    title: spec.title || 'test folder',
    stats: {
      messages: messages.length,
      chars: spec.chars ?? messages.reduce((sum, message) => sum + renderMessage(message).length, 0),
      tokens: spec.tokens ?? 10,
    },
    signals: {},
    source: { sessionId: 'test', turn: 0, seqStart: 0, seqEnd: 0 },
  }
  return writeFolder(memoryDir, { id: spec.id, meta, messages })
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test('config: documented defaults are present and valid', () => {
  const cfg = loadConfig()
  assert.deepEqual(cfg.warnings, [])
  assert.equal(cfg.compress.enabled, true)
  assert.equal(cfg.compress.triggerPercent, 60)
  assert.equal(cfg.compress.compressPercent, 20)
  assert.equal(cfg.compress.minChunkChars, 200)
  assert.equal(cfg.compress.targetChunkChars, 1200)
  // v1.2 R1: one archival run may list up to 100 pending + 100 re-review folders,
  // so the engine cap is 500 folders per run (config.json ships the same value).
  assert.equal(cfg.compress.maxFoldersPerRun, 500)
  assert.equal(DEFAULT_CONFIG.compress.maxFoldersPerRun, 500)
  assert.equal(cfg.importance.min, 0.01)
  assert.equal(cfg.importance.max, 1)
  assert.equal(cfg.importance.warnAbove, 0.8)
  assert.equal(cfg.keywords.matchMode, 'contains')
  assert.ok(cfg.keywords.stopwords.length > 50)
  assert.equal(cfg.recall.firstGenMax, 10)
  assert.equal(cfg.recall.mu, 5)
  assert.equal(cfg.recall.sigma, 3)
  assert.equal(cfg.recall.sort, 'createdAt')
  assert.equal(cfg.storage.dir, 'memory')
  // defaults object itself is untouched by validation/merging
  assert.equal(DEFAULT_CONFIG.recall.seed, 0)
  assert.deepEqual(Object.keys(cfg.importance.weights).sort(), ['code', 'decisions', 'keywords', 'recency', 'userDensity'])
})

test('config: maxFoldersPerRun ships 500 and validation still accepts 500', () => {
  // v1.2 R1: the engine default and the shipped config.json are both 500.
  assert.equal(DEFAULT_CONFIG.compress.maxFoldersPerRun, 500)
  assert.equal(loadConfig().compress.maxFoldersPerRun, 500)
  const shipped = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'config.json'), 'utf8'))
  assert.equal(shipped.compress.maxFoldersPerRun, 500)
  // The documented integer >= 1 validation accepts the new cap without warnings.
  const accepted = loadConfig(undefined, { compress: { maxFoldersPerRun: 500 } })
  assert.deepEqual(accepted.warnings, [])
  assert.equal(accepted.compress.maxFoldersPerRun, 500)
  assert.equal(accepted.storage.maxFolders, 10000)
  // The nested engine package version tracks the plugin release (read it from
  // package.json instead of hardcoding, so a version bump does not require a
  // test edit — it only has to keep both manifests in sync).
  const pluginPackage = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
  const enginePackage = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'engine', 'package.json'), 'utf8'))
  assert.equal(enginePackage.version, pluginPackage.version)
  assert.match(enginePackage.version, /^\d+\.\d+\.\d+$/)
})

test('config: config.json + overrides deep merge, unknown keys preserved', () => {
  const dir = tempDir()
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ compress: { triggerPercent: 70 }, recall: { mu: 4 }, custom: { future: true }, keywords: { extraStopwords: ['foo'] } }))
  const cfg = loadConfig(configPath, { compress: { compressPercent: 25 }, keywords: { min: 2 } })
  assert.deepEqual(cfg.warnings, [])
  assert.equal(cfg.compress.triggerPercent, 70)
  assert.equal(cfg.compress.compressPercent, 25)
  assert.equal(cfg.compress.minMessagesToCompress, 4)
  assert.equal(cfg.recall.mu, 4)
  assert.equal(cfg.recall.sigma, 3)
  assert.equal(cfg.custom.future, true)
  assert.deepEqual(cfg.keywords.extraStopwords, ['foo'])
  assert.equal(cfg.keywords.min, 2)
  // optional file: a missing path is reported but never throws
  const missing = loadConfig(path.join(dir, 'nope.json'))
  assert.equal(missing.warnings.length, 1)
  assert.match(missing.warnings[0], /not found/)
})

test('config: invalid values are clamped/replaced with warnings', () => {
  const cfg = loadConfig(undefined, {
    compress: { triggerPercent: 150, compressPercent: -3, minChunkChars: 0, targetChunkChars: 10, minMessagesToCompress: 0 },
    importance: { min: 2, max: -1, warnAbove: 4, weights: { keywords: -1 } },
    keywords: { min: 9, max: 2, matchMode: 'fuzzy', stopwords: 'nope' },
    recall: { mu: 0, sigma: -1, firstGenMax: -2, seed: -5, sort: 'random', probabilityScale: -1 },
    storage: { dir: '' },
    external: { timeoutMs: 0 },
  })
  assert.ok(cfg.warnings.length >= 15, `expected many warnings, got ${cfg.warnings.length}`)
  assert.equal(cfg.compress.triggerPercent, 60)
  assert.equal(cfg.compress.compressPercent, 20)
  assert.equal(cfg.compress.minChunkChars, 200)
  assert.equal(cfg.compress.targetChunkChars, 200) // raised to minChunkChars
  assert.equal(cfg.compress.minMessagesToCompress, 4)
  assert.equal(cfg.importance.min, 0.01)
  assert.equal(cfg.importance.max, 1)
  assert.equal(cfg.importance.warnAbove, 0.8)
  assert.equal(cfg.keywords.max, 9) // raised to keywords.min
  assert.equal(cfg.keywords.matchMode, 'contains')
  assert.ok(Array.isArray(cfg.keywords.stopwords))
  assert.equal(cfg.recall.mu, 5)
  assert.equal(cfg.recall.sigma, 3)
  assert.equal(cfg.recall.firstGenMax, 10)
  assert.equal(cfg.recall.seed, 0)
  assert.equal(cfg.recall.sort, 'createdAt')
  assert.equal(cfg.recall.probabilityScale, 1)
  assert.equal(cfg.storage.dir, 'memory')
  assert.equal(cfg.external.timeoutMs, 1500)
})

test('config: alpha bounds stay inside [0.01, 1]', () => {
  assert.equal(loadConfig(undefined, { importance: { min: 0.001 } }).importance.min, 0.01)
  assert.equal(loadConfig(undefined, { importance: { max: 3 } }).importance.max, 1)
  const swapped = loadConfig(undefined, { importance: { min: 0.9, max: 0.3 } })
  assert.equal(swapped.importance.min, 0.01)
  assert.equal(swapped.importance.max, 1)
  const ok = loadConfig(undefined, { importance: { min: 0.5, max: 0.6 } })
  assert.equal(ok.importance.min, 0.5)
  assert.equal(ok.importance.max, 0.6)
})

test('config: β constants and normalizeBeta clamp/round/fallback (never -0)', () => {
  assert.equal(BETA_MIN, -10)
  assert.equal(BETA_MAX, 10)
  assert.equal(DEFAULT_BETA, 0)
  assert.equal(normalizeBeta(3.14159), 3.1)
  assert.equal(normalizeBeta(-37), -10)
  assert.equal(normalizeBeta(42), 10)
  assert.equal(normalizeBeta(10), 10)
  assert.equal(normalizeBeta(-10), -10)
  assert.equal(normalizeBeta(0), 0)
  assert.equal(normalizeBeta(2.04), 2)
  assert.equal(normalizeBeta('x'), 0)
  assert.equal(normalizeBeta(undefined), 0)
  assert.equal(normalizeBeta(null), 0)
  assert.equal(normalizeBeta(NaN), 0)
  assert.equal(normalizeBeta(Infinity), 0)
  assert.equal(normalizeBeta(-Infinity), 0)
  assert.ok(!Object.is(normalizeBeta(-0), -0), 'normalizeBeta(-0) must never return -0')
  assert.equal(normalizeBeta(-0), 0)
  assert.ok(!Object.is(normalizeBeta(-0.04), -0))
  // β is a fixed constant range, not a configuration knob
  const cfg = loadConfig()
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'beta'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.importance, 'beta'), false)
  assert.deepEqual(cfg.warnings, [])
})

test('config: validateConfig/mergeConfigFile preserve unknown keys and warn', () => {
  const validated = validateConfig({ custom: { a: 1 } })
  assert.deepEqual(validated.custom, { a: 1 })
  assert.deepEqual(validated.warnings, [])
  const merged = mergeConfigFile({ compress: { triggerPercent: 55 } }, { recall: { firstGenMax: 3 } })
  assert.equal(merged.compress.triggerPercent, 55)
  assert.equal(merged.recall.firstGenMax, 3)
  assert.equal(merged.compress.compressPercent, 20)
})

test('config: resolveMemoryDir resolves relative to plugin root or given base', () => {
  const cfg = loadConfig()
  const resolved = resolveMemoryDir(cfg)
  assert.equal(path.basename(resolved), 'memory')
  assert.ok(path.isAbsolute(resolved))
  const abs = path.join(os.tmpdir(), 'dshr-memory-abs')
  const cfgAbs = loadConfig(undefined, { storage: { dir: abs } })
  assert.equal(resolveMemoryDir(cfgAbs), path.resolve(abs))
  const base = tempDir()
  assert.equal(resolveMemoryDir(cfg, base), path.join(path.resolve(base), 'memory'))
})

// ---------------------------------------------------------------------------
// message model / token estimates
// ---------------------------------------------------------------------------

test('messages: normalize DSH content blocks, render, token estimates', () => {
  const normalized = normalizeMessages([
    { role: 'user', content: '你好' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool-call', name: 'bash' },
        { type: 'image' },
        { type: 'file', name: 'a.txt' },
      ],
      time: 123,
      name: 'assistant',
    },
    { role: 'tool', content: 'done' },
    { role: 'developer', content: [{ type: 'text', text: 'rules' }] },
    { role: 'user', content: undefined },
  ])
  assert.equal(normalized.length, 5)
  assert.equal(normalized[0].role, 'user')
  assert.equal(normalized[0].content, '你好')
  assert.equal(normalized[1].content, 'hello\n[tool-call: bash]\n[image]\n[file: a.txt]')
  assert.equal(normalized[1].time, 123)
  assert.equal(normalized[2].role, 'tool')
  assert.equal(normalized[3].role, 'developer')
  assert.equal(normalized[3].content, 'rules')
  assert.equal(normalized[4].content, '')
  assert.equal(renderMessage(normalized[0]), 'user: 你好')
  assert.equal(renderMessage({ role: 'assistant', content: 'hi' }), 'assistant: hi')
  assert.equal(renderMessage({ role: 'tool', content: [{ type: 'text', text: 'ok' }] }), 'tool: ok')

  // documented fallback formula: ceil(latin/4 + cjk/1.6 + 4)
  assert.equal(estimateTokens(''), 4)
  assert.equal(estimateTokens('abcd'), 5)
  assert.equal(estimateTokens('你好'), 6)
  assert.equal(estimateTokens('abcd你好'), Math.ceil(4 / 4 + 2 / 1.6 + 4))
  assert.equal(estimateMessagesTokens(normalized), normalized.reduce((sum, message) => sum + estimateTokens(renderMessage(message)), 0))
  assert.deepEqual(normalizeMessages(null), [])
})

// ---------------------------------------------------------------------------
// keyword extraction / matching
// ---------------------------------------------------------------------------

test('keywords: Chinese sentence yields 部署/docker/端口 within [min,max]', () => {
  const cfg = loadConfig()
  const text = '部署 docker 服务时，端口配置必须注意。部署 docker 前请检查端口，端口冲突会导致启动失败。'
  const keywords = extractKeywords(text, cfg)
  assert.ok(keywords.length >= cfg.keywords.min, `got ${keywords.length}: ${keywords}`)
  assert.ok(keywords.length <= cfg.keywords.max, `got ${keywords.length}: ${keywords}`)
  assert.ok(keywords.includes('部署'), keywords.join(','))
  assert.ok(keywords.includes('docker'), keywords.join(','))
  assert.ok(keywords.includes('端口'), keywords.join(','))
  assert.ok(!keywords.includes('的'))
  assert.ok(!keywords.includes('必须'))
  // every keyword is unique
  assert.equal(new Set(keywords).size, keywords.length)
  // max override
  assert.ok(extractKeywords(text, cfg, { max: 2 }).length <= 2)
  // detailed scores are normalized evidence
  const detailed = extractKeywordsDetailed(text, cfg)
  for (const entry of detailed) {
    assert.equal(typeof entry.score, 'number')
    assert.ok(entry.normalized >= 0 && entry.normalized <= 1)
    assert.ok(entry.count >= 1)
  }
})

test('keywords: stopwords excluded, latin technical tokens preserved', () => {
  const cfg = loadConfig()
  const keywords = extractKeywords('这个 那个 然后 我们 你们 的 了 是 在 docker api_key node.js v2.0', cfg)
  assert.ok(keywords.includes('docker'), keywords.join(','))
  assert.ok(keywords.includes('api_key'), keywords.join(','))
  assert.ok(keywords.includes('node.js'), keywords.join(','))
  assert.ok(!keywords.includes('这个'))
  assert.ok(!keywords.includes('我们'))
  assert.ok(!keywords.includes('然后'))
  const custom = loadConfig(undefined, { keywords: { stopwords: ['部署'], extraStopwords: ['docker'] } })
  const filtered = extractKeywords('部署 docker 端口配置方案', custom)
  assert.ok(filtered.includes('端口'))
  assert.ok(!filtered.includes('部署'))
  assert.ok(!filtered.includes('docker'))
})

test('keywords: tokenize returns Latin tokens and CJK 2-3 grams', () => {
  const tokens = tokenize('部署 docker 端口配置')
  assert.ok(tokens.includes('部署'))
  assert.ok(tokens.includes('docker'))
  assert.ok(tokens.includes('端口'))
  assert.ok(!tokens.includes('端'), 'single CJK chars are not tokens of a multi-char run')
  assert.ok(tokens.includes('配置'))
  // trigram evidence
  assert.ok(tokens.includes('端口配'))
})

test('keywords: matching supports contains/exact semantics', () => {
  // CJK contains = substring
  assert.equal(matchesKeyword('要部署 docker 到服务器', '部署'), true)
  assert.equal(matchesKeyword('要部署 docker 到服务器', '部署方案'), false)
  // Latin contains = word-boundary match (never substring)
  assert.equal(matchesKeyword('要部署 docker 到服务器', 'docker'), true)
  assert.equal(matchesKeyword('dockerd 守护进程', 'docker'), false)
  assert.equal(matchesKeyword('docker-compose 部署', 'docker'), true)
  // exact = token equality
  assert.equal(matchesKeyword('docker-compose 部署', 'docker', 'exact'), false)
  assert.equal(matchesKeyword('docker 部署', 'docker', 'exact'), true)
  assert.equal(matchesKeyword('请用 node.js 运行', 'node.js', 'exact'), true)
  // normalization is case-insensitive
  assert.equal(matchesKeyword('deploy DOCKER now', 'Docker'), true)
  // 4-character CJK keyword is not a single token in exact mode
  assert.equal(matchesKeyword('端口配置方案', '端口配置', 'contains'), true)
  assert.equal(matchesKeyword('端口配置方案', '端口配置', 'exact'), false)
})

// ---------------------------------------------------------------------------
// importance / α
// ---------------------------------------------------------------------------

const importanceMessages = [
  { role: 'user', content: '必须记住：部署 docker 端口 8080 配置，不要改动生产参数，这个方案很重要。' },
  { role: 'assistant', content: '```bash\ncurl http://localhost:8080/api/health\n```\n版本 v1.4.2，配置已确认，注意防火墙规则。' },
]

test('importance: deterministic alpha in [0.01,1] with signals in [0,1]', () => {
  const cfg = loadConfig()
  const first = computeImportance(importanceMessages, cfg)
  const second = computeImportance(importanceMessages, cfg)
  assert.equal(first.alpha, second.alpha)
  assert.deepEqual(first.signals, second.signals)
  assert.ok(first.alpha >= 0.01 && first.alpha <= 1)
  assert.equal(first.alpha, alphaForFolder(importanceMessages, cfg))
  assert.equal(Math.round(first.alpha * 100), first.alpha * 100)
  for (const value of Object.values(first.signals)) {
    assert.ok(value >= 0 && value <= 1, `signal out of range: ${value}`)
  }
  // code-heavy content raises the code signal above zero
  assert.ok(first.signals.code > 0)
  assert.ok(first.signals.userDensity > 0)
})

test('importance: recency affects alpha when splitting one span', () => {
  const cfg = loadConfig()
  const early = computeImportance(importanceMessages, cfg, { recency: 0 })
  const late = computeImportance(importanceMessages, cfg, { recency: 1 })
  assert.equal(early.signals.recency, 0)
  assert.equal(late.signals.recency, 1)
  assert.ok(late.alpha >= early.alpha)
  // index/folderCount form: 0 for first, 1 for last
  assert.equal(computeImportance(importanceMessages, cfg, { index: 0, folderCount: 3 }).signals.recency, 0)
  assert.equal(computeImportance(importanceMessages, cfg, { index: 2, folderCount: 3 }).signals.recency, 1)
})

test('importance: high alpha triggers the documented warning', () => {
  const cfg = loadConfig(undefined, { importance: { min: 0.9, max: 1, warnAbove: 0.8 } })
  const result = computeImportance(importanceMessages, cfg)
  assert.ok(result.alpha > 0.8, `alpha=${result.alpha}`)
  assert.ok(result.alpha <= 1)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /exceeds importance\.warnAbove/)
  assert.ok(cfg.warnings.some((warning) => /exceeds importance\.warnAbove/.test(warning)))
})

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

test('store: empty load creates index; rebuild scans meta.json files', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  ensureMemoryDir(dir)
  const empty = loadIndex(dir, cfg)
  assert.deepEqual(empty.folders, [])
  assert.ok(fs.existsSync(memoryPaths(dir, cfg).indexPath))

  writeFolderDirect(dir, { id: 'mem-20260101T000000Z-0001', createdAt: 100, messages: [{ role: 'user', content: 'a' }], keywords: ['a'] })
  writeFolderDirect(dir, { id: 'mem-20260101T000001Z-0002', createdAt: 200, messages: [{ role: 'user', content: 'b' }], keywords: ['b'] })
  fs.rmSync(memoryPaths(dir, cfg).indexPath, { force: true })
  const rebuilt = loadIndex(dir, cfg)
  assert.equal(rebuilt.folders.length, 2)
  assert.deepEqual(rebuilt.folders.map((folder) => folder.id), ['mem-20260101T000000Z-0001', 'mem-20260101T000001Z-0002'])
  assert.equal(rebuilt.folders[0].createdAt, 100)
  assert.equal(rebuilt.folders[0].alpha, 0.5)
  assert.equal(rebuilt.folders[0].messageCount, 1)
})

test('store: corrupt index is rebuilt and corrupt meta folders are ignored', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  ensureMemoryDir(dir)
  writeFolderDirect(dir, { id: 'mem-20260101T000000Z-0001', createdAt: 10, messages: [{ role: 'user', content: 'x' }] })
  fs.mkdirSync(path.join(dir, 'mem-broken-9999'))
  fs.writeFileSync(path.join(dir, 'mem-broken-9999', 'meta.json'), '{not json')
  const { indexPath } = memoryPaths(dir, cfg)
  fs.writeFileSync(indexPath, '{"folders": [broken')
  const index = loadIndex(dir, cfg)
  assert.equal(index.folders.length, 1)
  assert.equal(readIndex(dir, cfg).folders.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).folders.length, 1)
})

test('store: atomic json writes leave no temp files and replace content', () => {
  const dir = tempDir()
  const file = path.join(dir, 'a.json')
  atomicWriteJson(file, { n: 1 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 1 })
  atomicWriteJson(file, { n: 2 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2 })
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [])
  // invalid folder ids never escape the memory dir
  assert.throws(() => writeFolder(dir, { id: '../escape', meta: {}, messages: [] }))
})

test('store: refreshIndex reloads only when the index mtime changes', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  ensureMemoryDir(dir)
  const first = loadIndex(dir, cfg)
  const { indexPath } = memoryPaths(dir, cfg)
  const mtime = fs.statSync(indexPath).mtimeMs
  const cache = { index: first, mtimeMs: mtime }
  const unchanged = refreshIndex(dir, cfg, cache)
  assert.equal(unchanged.reloaded, false)
  assert.equal(unchanged.index, first)

  writeFolderDirect(dir, { id: 'mem-20260101T000000Z-0001', createdAt: 1, messages: [{ role: 'user', content: 'new' }] })
  fs.rmSync(memoryPaths(dir, cfg).indexPath, { force: true })
  writeIndex(dir, cfg, loadIndex(dir, cfg))
  const bumped = mtime + 5000
  fs.utimesSync(indexPath, new Date(bumped), new Date(bumped))
  const refreshed = refreshIndex(dir, cfg, { index: first, mtimeMs: mtime })
  assert.equal(refreshed.reloaded, true)
  assert.equal(refreshed.index.folders.length, 1)
})

test('store: readFolder, folderExists, unique id formatting', () => {
  const dir = tempDir()
  writeFolderDirect(dir, {
    id: 'mem-20260101T120000Z-0007',
    createdAt: 1234,
    keywords: ['部署'],
    messages: [{ role: 'user', content: 'hi', time: 11 }, { role: 'assistant', content: 'yo' }],
  })
  assert.equal(folderExists(dir, 'mem-20260101T120000Z-0007'), true)
  assert.equal(folderExists(dir, 'mem-missing'), false)
  const folder = readFolder(dir, 'mem-20260101T120000Z-0007')
  assert.equal(folder.meta.createdAt, 1234)
  assert.deepEqual(folder.meta.keywords, ['部署'])
  assert.equal(folder.messages.length, 2)
  assert.equal(folder.context.messages.length, 2)
  assert.equal(folder.meta.stats.messages, 2)
  assert.equal(formatFolderId(Date.UTC(2026, 9, 23, 11, 0, 0), 1), 'mem-20261023T110000Z-0001')
  assert.equal(formatFolderId(Date.UTC(2026, 9, 23, 11, 0, 0), 42), 'mem-20261023T110000Z-0042')
})

test('store: appendStats/readStats are resilient, adds time, skips corrupt lines', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  assert.equal(appendStats(dir, cfg, { type: 'recall', addedChars: 10 }), true)
  const { statsPath } = memoryPaths(dir, cfg)
  fs.appendFileSync(statsPath, 'this is not json\n')
  assert.equal(appendStats(dir, cfg, { type: 'compress', removedChars: 5 }), true)
  const events = readStats(dir, cfg)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'recall')
  assert.equal(events[0].addedChars, 10)
  assert.ok(Number.isFinite(events[0].time))
  // telemetry failures must never throw
  const fileAsDir = path.join(tempDir(), 'not-a-dir')
  fs.writeFileSync(fileAsDir, 'x')
  assert.equal(appendStats(fileAsDir, cfg, { type: 'recall' }), false)
  assert.deepEqual(readStats(fileAsDir, cfg), [])
})

test('store: indexEntryFromMeta keeps the documented fields', () => {
  const entry = indexEntryFromMeta({
    id: 'mem-20260101T000000Z-0001',
    createdAt: 5,
    alpha: 0.42,
    keywords: ['部署', 'docker'],
    title: 't',
    stats: { messages: 3, chars: 100, tokens: 30 },
  })
  assert.deepEqual(entry, {
    id: 'mem-20260101T000000Z-0001',
    createdAt: 5,
    alpha: 0.42,
    beta: 0,
    scored: true,
    rescorePending: false,
    keywords: ['部署', 'docker'],
    title: 't',
    chars: 100,
    tokens: 30,
    messageCount: 3,
  })
})

test('store: index β survives rebuild/writeIndex round-trip; old folders default to 0', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  const scoredId = formatFolderId(1700000000000, 1)
  const oldId = formatFolderId(1700000000000, 2)
  writeFolderDirect(dir, { id: oldId, createdAt: 6, messages: [{ role: 'user', content: 'old' }] })
  writeFolder(dir, {
    id: scoredId,
    meta: {
      version: 1,
      id: scoredId,
      createdAt: 5,
      alpha: 0.42,
      beta: -2.5,
      betaSource: 'llm',
      keywords: ['部署'],
      title: 't',
      stats: { messages: 1, chars: 10, tokens: 3 },
      signals: {},
      source: {},
    },
    messages: [{ role: 'user', content: '旧部署' }],
  })
  fs.rmSync(path.join(dir, 'index.json'), { force: true })
  const rebuilt = loadIndex(dir, cfg)
  assert.equal(rebuilt.folders.find((folder) => folder.id === scoredId).beta, -2.5)
  assert.equal(rebuilt.folders.find((folder) => folder.id === oldId).beta, 0)
  // writeIndex re-normalizes but keeps β (round-trip through loadIndex)
  const written = writeIndex(dir, cfg, {
    version: 1,
    folders: rebuilt.folders.map((folder) => (folder.id === scoredId ? { ...folder, beta: 7.77 } : folder)),
    nextCounter: 3,
  })
  assert.equal(written.folders.find((folder) => folder.id === scoredId).beta, 7.8)
  assert.equal(readIndex(dir, cfg).folders.find((folder) => folder.id === scoredId).beta, 7.8)
  assert.equal(loadIndex(dir, cfg).folders.find((folder) => folder.id === scoredId).beta, 7.8)
  // legacy meta without β is read as 0 and is NOT migrated on disk
  assert.equal('beta' in readFolder(dir, oldId).meta, false)
  // out-of-range / garbage values are clamped or defaulted by the index builder
  assert.equal(indexEntryFromMeta({ id: 'mem-x', alpha: 0.5, beta: 42 }).beta, 10)
  assert.equal(indexEntryFromMeta({ id: 'mem-x', alpha: 0.5, beta: -42 }).beta, -10)
  assert.equal(indexEntryFromMeta({ id: 'mem-x', alpha: 0.5, beta: 'nope' }).beta, 0)
  assert.equal(indexEntryFromMeta({ id: 'mem-x', alpha: 0.5 }).beta, 0)
})

test('store: indexEntryFromMeta defaults scored=true / rescorePending=false, keeps explicit flags', () => {
  const legacy = indexEntryFromMeta({ id: 'mem-x', alpha: 0.5 })
  assert.equal(legacy.scored, true)
  assert.equal(legacy.rescorePending, false)
  assert.equal(indexEntryFromMeta({ id: 'mem-y', scored: false }).scored, false)
  assert.equal(indexEntryFromMeta({ id: 'mem-z', scored: true, rescorePending: true }).rescorePending, true)
  // only a strict `false` marks a folder unscored / only a strict `true` pending
  assert.equal(indexEntryFromMeta({ id: 'mem-w', scored: 'false' }).scored, true)
  assert.equal(indexEntryFromMeta({ id: 'mem-v', rescorePending: 'true' }).rescorePending, false)
})

test('store: scored / rescorePending survive rebuild and writeIndex round-trip', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  const pendingId = formatFolderId(1700000000000, 1)
  const rescoreId = formatFolderId(1700000000000, 2)
  const legacyId = formatFolderId(1700000000000, 3)
  const metaFor = (id, createdAt, extra) => ({
    version: 1,
    id,
    createdAt,
    alpha: 0.5,
    beta: 1.2,
    keywords: ['部署'],
    title: 't',
    stats: { messages: 1, chars: 5, tokens: 3 },
    signals: {},
    source: {},
    ...extra,
  })
  writeFolder(dir, {
    id: pendingId,
    meta: metaFor(pendingId, 1, { alpha: 0, beta: 0, keywords: [], scored: false, alphaSource: 'pending', keywordsSource: 'pending', betaSource: 'pending' }),
    messages: [{ role: 'user', content: 'pending' }],
  })
  writeFolder(dir, { id: rescoreId, meta: metaFor(rescoreId, 2, { rescorePending: true }), messages: [{ role: 'user', content: 'rescore' }] })
  writeFolderDirect(dir, { id: legacyId, createdAt: 3, messages: [{ role: 'user', content: 'legacy' }] })
  fs.rmSync(path.join(dir, 'index.json'), { force: true })
  const rebuilt = loadIndex(dir, cfg)
  assert.equal(rebuilt.folders.find((folder) => folder.id === pendingId).scored, false)
  assert.equal(rebuilt.folders.find((folder) => folder.id === rescoreId).rescorePending, true)
  assert.equal(rebuilt.folders.find((folder) => folder.id === legacyId).scored, true)
  // writeIndex / readIndex / loadIndex all keep the flags
  const written = writeIndex(dir, cfg, { version: 1, folders: rebuilt.folders, nextCounter: 4 })
  for (const index of [written, readIndex(dir, cfg), loadIndex(dir, cfg)]) {
    assert.equal(index.folders.find((folder) => folder.id === pendingId).scored, false)
    assert.equal(index.folders.find((folder) => folder.id === rescoreId).rescorePending, true)
    assert.equal(index.folders.find((folder) => folder.id === legacyId).scored, true)
  }
  // once the model judged it, a meta rewrite flips scored through the rebuild
  writeFolder(dir, {
    id: pendingId,
    meta: metaFor(pendingId, 1, { alpha: 0.7, beta: 2.5, keywords: ['a', 'b', 'c'], scored: true, alphaSource: 'llm', keywordsSource: 'llm', betaSource: 'llm' }),
    messages: [{ role: 'user', content: 'pending' }],
  })
  fs.rmSync(path.join(dir, 'index.json'), { force: true })
  assert.equal(loadIndex(dir, cfg).folders.find((folder) => folder.id === pendingId).scored, true)
  // legacy folders are read as scored and never migrated on disk
  assert.equal('scored' in readFolder(dir, legacyId).meta, false)
  assert.equal('rescorePending' in readFolder(dir, legacyId).meta, false)
})

// ---------------------------------------------------------------------------
// MemoryEngine facade
// ---------------------------------------------------------------------------

test('engine: load/list/recall telemetry/report/setConfig', () => {
  const dir = tempDir()
  const cfg = loadConfig(undefined, { compress: { minContextTokens: 0 } })
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg })
  engine.load()
  assert.equal(engine.loaded, true)
  assert.deepEqual(engine.list(), [])
  engine.recall('完全不相关的一句话', { chars: 1000, windowTokens: 2000 })
  const report = engine.report()
  assert.equal(report.recallEvents, 1)
  assert.equal(report.contextCharsSum, 1000)
  assert.match(report.text, /=== memory recall report ===/)
  assert.match(report.text, /recall events          : 1/)
  assert.deepEqual(engine.report().byGeneration, {})
  // setConfig deep merges and reloads
  const updated = engine.setConfig({ recall: { firstGenMax: 3 } })
  assert.equal(updated.recall.firstGenMax, 3)
  assert.equal(updated.recall.mu, 5)
  assert.equal(engine.config.recall.firstGenMax, 3)
  // compress into the same engine then recall through it
  const messages = []
  for (let index = 0; index < 16; index += 1) {
    messages.push({ role: 'user', content: `第 ${index} 轮：部署 docker 端口 8080 的配置和方案。` })
    messages.push({ role: 'assistant', content: `好的，第 ${index} 轮部署方案：端口 8080，参数必须正确。` })
  }
  const result = engine.compress(messages, 80, { sessionId: 'unit', totalUsedTokens: 4000 })
  assert.equal(result.committed, true)
  assert.ok(result.folders.length > 0)
  assert.ok(engine.list().length > 0)
  const recalled = engine.recall('部署 docker 端口 8080 方案', { chars: 4000, windowTokens: 128000 })
  assert.ok(recalled.stats.matchedFolders > 0)
  const afterReport = engine.report()
  assert.equal(afterReport.recallEvents, 2)
  assert.ok(afterReport.compressionEvents >= 1)
  assert.ok(afterReport.text.includes('compression events'))
})

test('engine: recall forwards excludeIds and records excludedFolders in telemetry', () => {
  const dir = tempDir()
  const cfg = loadConfig(undefined, { recall: { probabilityScale: 1000, mode: 'legacy' } })
  const oldId = formatFolderId(1700000000000, 1)
  const newId = formatFolderId(1700000000000, 2)
  writeFolderDirect(dir, { id: oldId, createdAt: 1, alpha: 1, keywords: ['部署'], messages: [{ role: 'user', content: '旧部署' }] })
  writeFolderDirect(dir, { id: newId, createdAt: 2, alpha: 1, keywords: ['部署'], messages: [{ role: 'user', content: '新部署' }] })
  fs.rmSync(path.join(dir, 'index.json'), { force: true })
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg })
  engine.load()
  const result = engine.recall('部署', { chars: 100, windowTokens: 1000 }, { excludeIds: [oldId] })
  assert.equal(result.stats.matchedFolders, 2)
  assert.equal(result.stats.excludedFolders, 1)
  assert.equal(result.stats.attempts, 1)
  assert.deepEqual(result.additions.map((addition) => addition.id), [newId])
  const recallEvent = readStats(dir, cfg)
    .filter((event) => event.type === 'recall')
    .at(-1)
  assert.equal(recallEvent.excludedFolders, 1)
})

test('engine: recall telemetry records β for every added folder', () => {
  const dir = tempDir()
  const cfg = loadConfig(undefined, { recall: { probabilityScale: 1000, mode: 'legacy' } })
  const scoredId = formatFolderId(1700000000000, 1)
  const oldId = formatFolderId(1700000000000, 2)
  writeFolder(dir, {
    id: scoredId,
    meta: {
      version: 1,
      id: scoredId,
      createdAt: 1,
      alpha: 1,
      beta: 3.4,
      betaSource: 'llm',
      keywords: ['部署'],
      title: 'scored',
      stats: { messages: 1, chars: 5, tokens: 3 },
      signals: {},
      source: {},
    },
    messages: [{ role: 'user', content: '新部署' }],
  })
  writeFolderDirect(dir, { id: oldId, createdAt: 2, alpha: 1, keywords: ['部署'], messages: [{ role: 'user', content: '旧部署' }] })
  fs.rmSync(path.join(dir, 'index.json'), { force: true })
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg })
  engine.load()
  const result = engine.recall('部署', { chars: 100, windowTokens: 1000 })
  assert.equal(result.additions.length, 2)
  const recallEvent = readStats(dir, cfg)
    .filter((event) => event.type === 'recall')
    .at(-1)
  assert.equal(recallEvent.added.length, 2)
  const byId = new Map(recallEvent.added.map((entry) => [entry.id, entry]))
  assert.equal(byId.get(scoredId).beta, 3.4)
  assert.equal(byId.get(oldId).beta, 0)
  for (const entry of recallEvent.added) assert.ok(Number.isFinite(entry.beta), `telemetry beta must be finite: ${entry.beta}`)
})

// ---------------------------------------------------------------------------
// performance (§10.7)
// ---------------------------------------------------------------------------

test('performance: 1000 folders recall < 50ms cold and < 20ms warm', () => {
  // Shared CI runners (especially windows-latest) are noisy: keep the strict
  // budgets for developer machines, relax them when GITHUB_ACTIONS/CI is set.
  const onCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
  const coldBudgetMs = onCi ? 1000 : 50
  const warmBudgetMs = onCi ? 200 : 20
  const dir = tempDir()
  const cfg = loadConfig(undefined, { recall: { probabilityScale: 0, seed: 1, mode: 'legacy' } })
  const folders = []
  for (let index = 0; index < 1000; index += 1) {
    folders.push({
      id: formatFolderId(1700000000000, index + 1),
      createdAt: index,
      alpha: 0.5,
      keywords: index % 2 === 0 ? ['deploy', 'docker', 'ports'] : ['部署', 'docker', '端口'],
      chars: 1000,
      tokens: 300,
      messageCount: 4,
      title: `folder ${index}`,
    })
  }
  writeIndex(dir, cfg, { version: 1, folders, nextCounter: 1001 })
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg })
  const coldStart = performance.now()
  engine.load()
  const first = engine.recall('deploy docker 端口 配置', { chars: 10000, windowTokens: 128000 })
  const coldMs = performance.now() - coldStart
  assert.equal(first.stats.matchedFolders, 1000)
  assert.equal(first.stats.addedFolders, 0)
  assert.ok(coldMs < coldBudgetMs, `cold recall took ${coldMs.toFixed(2)}ms (budget ${coldBudgetMs}ms)`)
  const iterations = 25
  const warmStart = performance.now()
  for (let index = 0; index < iterations; index += 1) engine.recall('deploy docker 端口 配置', { chars: 10000, windowTokens: 128000 })
  const warmMs = (performance.now() - warmStart) / iterations
  assert.ok(warmMs < warmBudgetMs, `warm recall averaged ${warmMs.toFixed(2)}ms (budget ${warmBudgetMs}ms)`)
})

test('performance: planCompression on a long conversation stays fast', () => {
  // Same CI-noise relaxation as the recall performance test above.
  const onCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
  const budgetMs = onCi ? 2000 : 100
  const cfg = loadConfig()
  const messages = []
  for (let index = 0; index < 200; index += 1) {
    messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `第 ${index} 条消息：部署 docker 端口配置参数方案，注意版本和回滚。` })
  }
  const start = performance.now()
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 20000 })
  const elapsed = performance.now() - start
  assert.equal(plan.shouldCompress, true)
  assert.ok(elapsed < budgetMs, `planCompression took ${elapsed.toFixed(2)}ms (budget ${budgetMs}ms)`)
})

test('store: index drops "." / ".." / path-like folder ids that can never be loaded', () => {
  const dir = tempDir()
  const cfg = loadConfig()
  ensureMemoryDir(dir)
  const { indexPath } = memoryPaths(dir, cfg)
  const entry = (id, createdAt) => ({ id, createdAt, alpha: 0.5, keywords: ['k'], chars: 1, tokens: 1, messageCount: 1, title: 'x' })
  atomicWriteJson(indexPath, {
    version: 1,
    updatedAt: Date.now(),
    nextCounter: 1,
    folders: [entry('..', 1), entry('.', 2), entry('../../etc', 3), entry('ok-id', 4)],
  })
  assert.deepEqual(readIndex(dir, cfg).folders.map((folder) => folder.id), ['ok-id'], 'read drops unsafe ids')
  const written = writeIndex(dir, cfg, { folders: [entry('..', 1), entry('.', 2), entry('ok-id', 3)] })
  assert.deepEqual(written.folders.map((folder) => folder.id), ['ok-id'], 'write drops unsafe ids')
  assert.deepEqual(
    JSON.parse(fs.readFileSync(indexPath, 'utf8')).folders.map((folder) => folder.id),
    ['ok-id'],
    'on-disk index never advertises unsafe ids',
  )
})

// ---------------------------------------------------------------------------
// config: v1.4.0 schema
// ---------------------------------------------------------------------------

test('config: v1.4.0 defaults — recall fair lanes, time, scoring, match, compress guard', () => {
  const cfg = loadConfig()
  // deterministic recall is the default; legacy stays a rollback switch
  assert.equal(cfg.recall.mode, 'fair')
  assert.equal(cfg.recall.fairness.thetaHigh, 0.6)
  assert.equal(cfg.recall.fairness.exploreRatio, 0.2)
  assert.equal(cfg.recall.fairness.specificProbeSlots, 1)
  assert.equal(cfg.recall.fairness.rareTerm.minPosting, 8)
  assert.equal(cfg.recall.fairness.register.ttlRounds, 2)
  assert.equal(cfg.recall.fairness.recycle.cooldownRounds, 15)
  assert.equal(cfg.recall.fairness.blockTrim.policy, 'priority')
  assert.equal(cfg.recall.fairness.roundBudget.maxChars, 20000)
  assert.equal(cfg.recall.maxWindowPercent, 10)
  assert.equal(cfg.recall.minAlpha, 0)
  assert.equal(cfg.recall.hops, 0)
  // probability knobs are still documented (legacy mode only)
  assert.equal(cfg.recall.mu, 5)
  assert.equal(cfg.recall.seed, 0)
  // time: engine default is index-only, packaged config turns constrain on
  assert.equal(cfg.time.mode, 'index')
  assert.equal(cfg.time.timezone, '')
  assert.equal(cfg.time.minRangeDays, 3)
  assert.equal(cfg.time.maxRangeDays, 366)
  assert.equal(cfg.time.centerDayPriority, true)
  assert.deepEqual(cfg.time.fallback, ['day3', 'month', 'year', 'all'])
  assert.equal(cfg.time.judgeEventTime, false)
  // scoring pipeline
  assert.equal(cfg.scoring.includeLegacy, false)
  assert.equal(cfg.scoring.maxPending, 200)
  assert.equal(cfg.scoring.fallback, 'onPressure')
  assert.deepEqual(cfg.scoring.autoHeuristicAfterRounds, { plain: 4, channel: 2 })
  assert.equal(cfg.scoring.taskBudgetPercent, 15)
  assert.equal(cfg.scoring.taskMaxTokens, 12000)
  assert.equal(cfg.scoring.order, 'newest')
  assert.equal(cfg.scoring.maxItemsPerJudge, 100)
  // keyword matching switches default off (no regression)
  assert.deepEqual(cfg.match, { expandLatinCase: false, cjkBigram: false })
  // archival guards
  assert.equal(cfg.compress.protectCurrentTurn, true)
  assert.equal(cfg.compress.allowSmallWindow, false)
  assert.equal(cfg.compress.smallWindowTokens, 20000)
  assert.equal(cfg.compress.hardLimitStop, true)
  assert.equal(cfg.compress.maxFoldersPerStep, 500)
  // Q1: triggerPercent is 60 everywhere
  assert.equal(cfg.compress.triggerPercent, 60)
  assert.equal(DEFAULT_CONFIG.compress.triggerPercent, 60)
})

test('config: a 1.3.0 config file (no v1.4.0 keys) loads with zero warnings', () => {
  // Backward compatibility: an old config.json must not be "upgraded" loudly.
  const legacyConfig = {
    enabled: true,
    compress: { enabled: true, triggerPercent: 80, compressPercent: 20 },
    importance: { min: 0.01, max: 1, warnAbove: 0.8 },
    keywords: { min: 3, max: 8, extraStopwords: [], matchMode: 'contains' },
    recall: {
      enabled: true,
      firstGenMax: 10,
      mu: 5,
      sigma: 3,
      maxGeneration: 0,
      probabilityScale: 1,
      seed: 0,
      sort: 'createdAt',
      maxRecalledBlocks: 64,
      maxRecalledChars: 120000,
      persistInjected: true,
      triggerSourceKinds: ['user'],
    },
    storage: { dir: 'memory', perSession: true, indexFile: 'index.json', statsFile: 'stats.jsonl', maxFolders: 10000 },
    compat: { qqBots: 'auto' },
    logging: { enabled: true, verbose: false },
    test: { dryRun: false },
  }
  const dir = tempDir()
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify(legacyConfig))
  const cfg = loadConfig(configPath)
  assert.deepEqual(cfg.warnings, [], 'no warning for an old config file')
  assert.equal(cfg.compress.triggerPercent, 80, 'an explicit old value is preserved')
  assert.equal(cfg.recall.mode, 'fair', 'new key falls back to the v1.4.0 default')
  assert.equal(cfg.time.mode, 'index')
  assert.equal(cfg.scoring.order, 'newest')
  // adapter-only keys are preserved by the engine merge
  assert.deepEqual(cfg.recall.triggerSourceKinds, ['user'])
  assert.equal(cfg.storage.perSession, true)
})

test('config: v1.4.0 invalid values are replaced with warnings (never throw)', () => {
  const cfg = loadConfig(undefined, {
    recall: {
      mode: 'nope',
      hops: -1,
      maxWindowPercent: 0,
      minAlpha: 2,
      fairness: {
        thetaHigh: 5,
        exploreRatio: -1,
        specificProbeSlots: 'x',
        rareTerm: { ratio: -1, minPosting: 0, scanCap: 0 },
        register: { lookahead: 0, capFactor: 0, ttlRounds: 0 },
        queryBoost: 'yes',
        recycle: { enabled: 'no', cooldownRounds: -5, maxPerRound: 99 },
        ledger: { maxEntries: 0, overflow: 'nope' },
        blockTrim: { policy: 'magic', protectCurrentQuery: 'no', pinHigh: 1 },
        roundBudget: { maxChars: -1 },
      },
    },
    time: { mode: 'always', timezone: 'Not/AZone', minRangeDays: 0, maxRangeDays: 0, fallback: ['day3', 'bogus'], windowScanMax: 0 },
    scoring: { includeLegacy: 'no', maxPending: -1, fallback: 'sometimes', autoHeuristicAfterRounds: { plain: -1, channel: 'x' }, taskBudgetPercent: 0, order: 'random', maxItemsPerJudge: 0 },
    match: { expandLatinCase: 'no', cjkBigram: 1 },
    compress: { protectCurrentTurn: 'no', allowSmallWindow: 'no', smallWindowTokens: -1, hardLimitStop: 'no', maxFoldersPerStep: 0 },
  })
  assert.ok(cfg.warnings.length >= 25, `expected many warnings, got ${cfg.warnings.length}`)
  assert.equal(cfg.recall.mode, 'fair')
  assert.equal(cfg.recall.hops, 0)
  assert.equal(cfg.recall.maxWindowPercent, 10)
  assert.equal(cfg.recall.minAlpha, 0)
  assert.equal(cfg.recall.fairness.thetaHigh, 0.6)
  assert.equal(cfg.recall.fairness.exploreRatio, 0.2)
  assert.equal(cfg.recall.fairness.specificProbeSlots, 1)
  assert.deepEqual(cfg.recall.fairness.rareTerm, { ratio: 0.002, minPosting: 8, scanCap: 512 })
  assert.deepEqual(cfg.recall.fairness.register, { lookahead: 3, capFactor: 8, ttlRounds: 2 })
  assert.equal(cfg.recall.fairness.queryBoost, true)
  assert.deepEqual(cfg.recall.fairness.recycle, { enabled: true, cooldownRounds: 15, maxPerRound: 1 })
  assert.deepEqual(cfg.recall.fairness.ledger, { maxEntries: 10000, overflow: 'evict-lowest-alpha-last-seen' })
  assert.equal(cfg.recall.fairness.blockTrim.policy, 'priority')
  assert.equal(cfg.recall.fairness.roundBudget.maxChars, 20000)
  assert.equal(cfg.time.mode, 'index')
  assert.equal(cfg.time.timezone, '')
  assert.equal(cfg.time.minRangeDays, 3, 'invalid minRangeDays falls back to the default 3')
  assert.equal(cfg.time.maxRangeDays, 366, 'invalid maxRangeDays falls back to the default 366')
  assert.deepEqual(cfg.time.fallback, ['day3'], 'unknown fallback entries are dropped, known ones kept')
  assert.equal(cfg.time.windowScanMax, 4096)
  // maxRangeDays is raised to minRangeDays when a hand-edited config inverts them
  const inverted = loadConfig(undefined, { time: { minRangeDays: 5, maxRangeDays: 2 } })
  assert.equal(inverted.time.minRangeDays, 5)
  assert.equal(inverted.time.maxRangeDays, 5)
  assert.ok(inverted.warnings.some((warning) => warning.includes('time.maxRangeDays')), 'inverted range warns')
  assert.equal(cfg.scoring.includeLegacy, false)
  assert.equal(cfg.scoring.maxPending, 200)
  assert.equal(cfg.scoring.fallback, 'onPressure')
  assert.deepEqual(cfg.scoring.autoHeuristicAfterRounds, { plain: 4, channel: 2 })
  assert.equal(cfg.scoring.taskBudgetPercent, 15)
  assert.equal(cfg.scoring.order, 'newest')
  assert.equal(cfg.scoring.maxItemsPerJudge, 100)
  assert.equal(cfg.match.expandLatinCase, false)
  assert.equal(cfg.match.cjkBigram, false)
  assert.equal(cfg.compress.protectCurrentTurn, true)
  assert.equal(cfg.compress.allowSmallWindow, false)
  assert.equal(cfg.compress.smallWindowTokens, 20000)
  assert.equal(cfg.compress.hardLimitStop, true)
  assert.equal(cfg.compress.maxFoldersPerStep, 500)
  // invalid sub-objects fall back whole
  const broken = validateConfig({ recall: { fairness: 'nope' }, time: { fallback: 'nope' }, scoring: { autoHeuristicAfterRounds: 'nope' } })
  assert.equal(broken.recall.fairness.thetaHigh, 0.6)
  assert.deepEqual(broken.time.fallback, ['day3', 'month', 'year', 'all'])
  assert.deepEqual(broken.scoring.autoHeuristicAfterRounds, { plain: 4, channel: 2 })
})


test('config: valid IANA time zones are accepted, host-local empty string stays', () => {
  const tokyo = loadConfig(undefined, { time: { timezone: 'Asia/Tokyo' } })
  assert.deepEqual(tokyo.warnings, [])
  assert.equal(tokyo.time.timezone, 'Asia/Tokyo')
  const local = loadConfig(undefined, { time: { timezone: '  ' } })
  assert.deepEqual(local.warnings, [])
  assert.equal(local.time.timezone, '')
  const utc = loadConfig(undefined, { time: { timezone: 'UTC' } })
  assert.equal(utc.time.timezone, 'UTC')
})

// ---------------------------------------------------------------------------
// store: v1.4.0 optional index fields + commit helpers
// ---------------------------------------------------------------------------

test('store: v1.4.0 optional index fields are copied explicitly and only when valid', () => {
  assert.deepEqual(PENDING_ERAS, ['legacy', 'current', 'synthetic'])
  assert.deepEqual(SCORE_MODES, ['model', 'heuristic'])
  assert.deepEqual(ARCHIVE_SOURCES, ['adapter', 'passive'])
  assert.deepEqual(EVENT_TIME_SOURCES, ['messages', 'judge', 'archive'])
  const full = indexEntryFromMeta({
    id: 'mem-20260101T000000Z-0001',
    createdAt: 5,
    alpha: 0.4,
    keywords: ['部署'],
    pendingEra: 'legacy',
    scoreMode: 'model',
    archivedFrom: 'passive',
    archivedByVersion: '1.4.0',
    eventStart: 1000,
    eventEnd: 2000,
    eventTimeSource: 'messages',
    pendingSince: 900,
  })
  assert.equal(full.pendingEra, 'legacy')
  assert.equal(full.scoreMode, 'model')
  assert.equal(full.archivedFrom, 'passive')
  assert.equal(full.archivedByVersion, '1.4.0')
  assert.equal(full.eventStart, 1000)
  assert.equal(full.eventEnd, 2000)
  assert.equal(full.eventTimeSource, 'messages')
  assert.equal(full.pendingSince, 900)
  // invalid values are dropped instead of poisoning the index
  const invalid = indexEntryFromMeta({
    id: 'mem-20260101T000000Z-0002',
    createdAt: 5,
    pendingEra: 'future',
    scoreMode: 'guess',
    archivedFrom: 'robot',
    eventTimeSource: 'guess',
    eventStart: 'yesterday',
    eventEnd: NaN,
    pendingSince: Infinity,
    archivedByVersion: '',
  })
  for (const field of ['pendingEra', 'scoreMode', 'archivedFrom', 'eventTimeSource', 'eventStart', 'eventEnd', 'pendingSince', 'archivedByVersion']) {
    assert.equal(field in invalid, false, `${field} must not be invented`)
  }
  // old folders (no fields) produce exactly the v1.3.0 entry shape
  const plain = indexEntryFromMeta({ id: 'mem-20260101T000000Z-0003', createdAt: 1, alpha: 0.5 })
  assert.deepEqual(Object.keys(plain).sort(), ['alpha', 'beta', 'chars', 'createdAt', 'id', 'keywords', 'messageCount', 'rescorePending', 'scored', 'title', 'tokens'])
})

test('store: v1.4.0 optional index fields survive writeIndex/readIndex round-trip', () => {
  const cfg = loadConfig()
  const dir = tempDir()
  ensureMemoryDir(dir)
  const id = formatFolderId(1700000000000, 1)
  const written = writeIndex(dir, cfg, {
    version: 1,
    nextCounter: 2,
    folders: [{
      id,
      createdAt: 5,
      alpha: 0.4,
      keywords: ['部署'],
      pendingEra: 'synthetic',
      scoreMode: 'heuristic',
      archivedFrom: 'adapter',
      archivedByVersion: '1.4.0',
      eventStart: 1000,
      eventEnd: 2000,
      eventTimeSource: 'messages',
      pendingSince: 900,
    }],
  })
  const saved = written.folders[0]
  assert.equal(saved.pendingEra, 'synthetic')
  assert.equal(saved.eventTimeSource, 'messages')
  assert.equal(saved.pendingSince, 900)
  const read = readIndex(dir, cfg).folders[0]
  assert.equal(read.pendingEra, 'synthetic')
  assert.equal(read.scoreMode, 'heuristic')
  assert.equal(read.archivedFrom, 'adapter')
  assert.equal(read.archivedByVersion, '1.4.0')
  assert.equal(read.eventStart, 1000)
  assert.equal(read.eventEnd, 2000)
  assert.equal(read.eventTimeSource, 'messages')
  assert.equal(read.pendingSince, 900)
  // a rebuild from meta.json keeps them too (meta is allowed to carry them)
  writeFolder(dir, { id, meta: { createdAt: 5, alpha: 0.4, pendingEra: 'legacy', eventStart: 42, eventEnd: 43 }, messages: [{ role: 'user', content: 'x' }] })
  fs.rmSync(path.join(dir, 'index.json'), { force: true })
  const rebuilt = loadIndex(dir, cfg).folders[0]
  assert.equal(rebuilt.pendingEra, 'legacy')
  assert.equal(rebuilt.eventStart, 42)
  assert.equal(rebuilt.eventEnd, 43)
})

test('store: commit journal helpers and removeFolder are safe with bad ids and stale files', () => {
  const dir = tempDir()
  ensureMemoryDir(dir)
  const id = formatFolderId(1700000000000, 7)
  writeFolder(dir, { id, meta: { createdAt: 1 }, messages: [{ role: 'user', content: 'x' }] })
  assert.equal(folderExists(dir, id), true)
  // journal life cycle
  const journal = beginCommitJournal(dir, id, { sessionId: 's', folders: 1 })
  assert.equal(typeof journal, 'string')
  assert.equal(fs.existsSync(journal), true)
  assert.equal(finishCommitJournal(journal), true)
  assert.equal(fs.existsSync(journal), false)
  // a missing/garbage journal path is ignored
  assert.equal(finishCommitJournal(null), false)
  assert.equal(finishCommitJournal(''), false)
  // unsafe ids never touch the filesystem
  assert.equal(beginCommitJournal(dir, '..', {}), null)
  assert.equal(removeFolder(dir, '..'), false)
  // stale journal cleanup: a small maxAge keeps the fresh one, a future clock removes it
  const fresh = beginCommitJournal(dir, id, {})
  assert.deepEqual(cleanupCommitJournals(dir, { maxAgeMs: 60_000 }), [])
  assert.equal(fs.existsSync(fresh), true)
  const removed = cleanupCommitJournals(dir, { maxAgeMs: 0, now: Date.now() + 60_000 })
  assert.deepEqual(removed, [fresh])
  assert.equal(fs.existsSync(fresh), false)
  // removeFolder deletes the folder but never escapes the memory dir
  assert.equal(removeFolder(dir, id), true)
  assert.equal(folderExists(dir, id), false)
  // cleanup never deletes memory folders
  writeFolder(dir, { id, meta: { createdAt: 1 }, messages: [] })
  beginCommitJournal(dir, id, {})
  cleanupCommitJournals(dir, { maxAgeMs: 0, now: Date.now() + 60_000 })
  assert.equal(folderExists(dir, id), true)
})

// ---------------------------------------------------------------------------
// data era classification (v1.4.0, docs/SPEC.md §4.1) — single truth shared by
// plugin task filtering, memory-audit, selfcheck and recall-report.
// ---------------------------------------------------------------------------

test('era: signals detect a fake window from compress telemetry', () => {
  assert.equal(LEGACY_ERA_CUTOFF_MS, Date.parse('2026-10-27T19:14:00Z'))
  const fake = sessionEraSignals([
    { type: 'compress', windowTokens: 2000, beforePercent: 1375 },
    { type: 'recall', windowTokens: 999999 },
  ])
  assert.equal(fake.fakeWindow, true)
  assert.equal(fake.tinyWindow, true)
  assert.equal(fake.overWindow, true)
  assert.equal(fake.windowTokens, 2000, 'the smallest recorded window wins')
  assert.equal(fake.maxBeforePercent, 1375)
  const real = sessionEraSignals([{ type: 'compress', windowTokens: 1000000, beforePercent: 71 }])
  assert.equal(real.fakeWindow, false)
  assert.equal(real.windowTokens, 1000000)
  // non-window events are ignored; garbage never throws
  assert.deepEqual(sessionEraSignals([{ type: 'recall' }, null, 'x']), {
    fakeWindow: false, tinyWindow: false, overWindow: false, windowTokens: null, maxBeforePercent: null,
  })
  assert.equal(sessionEraSignals(undefined).fakeWindow, false)
})

test('era: synthetic requires fake window AND stress-level volume; qqb-g stays current', () => {
  const fake = sessionEraSignals([{ type: 'compress', windowTokens: 2000, beforePercent: 1375 }])
  // a46df597: pressure test — fake window + 2780 folders / 2180 pending
  const pressure = sessionEra({ folders: 2780, pending: 2180, signals: fake })
  assert.equal(pressure.era, 'synthetic')
  assert.equal(pressure.reasons.stressBacklog, true)
  assert.equal(pressure.reasons.fakeWindow, true)
  // qqb-g-1134030529: channel test — fake window but only 10 folders / 2 pending
  const channel = sessionEra({ folders: 10, pending: 2, signals: fake })
  assert.equal(channel.era, 'current', 'a small channel session is not a pressure test')
  assert.equal(channel.reasons.fakeWindow, true)
  assert.equal(channel.reasons.stressBacklog, false)
  // a real window never becomes synthetic, however big the backlog
  const realWindow = sessionEra({ folders: 5000, pending: 4000, signals: sessionEraSignals([{ type: 'compress', windowTokens: 1000000 }]) })
  assert.equal(realWindow.era, 'current')
  // both stress thresholds work independently
  assert.equal(sessionEra({ folders: 100, pending: 0, signals: fake }).era, 'synthetic')
  assert.equal(sessionEra({ folders: 10, pending: 100, signals: fake }).era, 'synthetic')
  assert.equal(sessionEra({ folders: 99, pending: 99, signals: fake }).era, 'current')
})

test('era: per-folder legacy boundary beats the session era; explicit markers win', () => {
  const cutoff = LEGACY_ERA_CUTOFF_MS
  const syntheticSession = { era: 'synthetic' }
  const currentSession = { era: 'current' }
  assert.equal(classifyFolderEra({ createdAt: cutoff - 1 }, currentSession), 'legacy')
  assert.equal(classifyFolderEra({ createdAt: cutoff }, currentSession), 'current', 'the boundary itself is current')
  assert.equal(classifyFolderEra({ createdAt: cutoff - 1 }, syntheticSession), 'legacy', 'legacy wins over synthetic')
  assert.equal(classifyFolderEra({ createdAt: cutoff + 1 }, syntheticSession), 'synthetic')
  assert.equal(classifyFolderEra({ createdAt: cutoff + 1 }, currentSession), 'current')
  // createdAt 0 / missing / garbage falls through to the session era
  assert.equal(classifyFolderEra({ createdAt: 0 }, currentSession), 'current')
  assert.equal(classifyFolderEra({}, syntheticSession), 'synthetic')
  assert.equal(classifyFolderEra(null, currentSession), 'current')
  // an explicit pendingEra marker (memory-audit --apply) always wins
  assert.equal(classifyFolderEra({ createdAt: cutoff + 1, pendingEra: 'legacy' }, currentSession), 'legacy')
  assert.equal(classifyFolderEra({ createdAt: cutoff - 1, pendingEra: 'synthetic' }, currentSession), 'synthetic')
  assert.equal(classifyFolderEra({ createdAt: cutoff - 1, pendingEra: 'nonsense' }, currentSession), 'legacy', 'unknown marker is ignored')
})

test('era: summarizeEras reproduces the documented 74.0% / 0.54% buckets', () => {
  const cutoff = LEGACY_ERA_CUTOFF_MS
  const folders = []
  // legacy: 593 folders, 6 scored / 587 pending
  for (let i = 0; i < 593; i += 1) folders.push({ id: `legacy-${i}`, createdAt: cutoff - 1000 - i, scored: i < 6 })
  // synthetic: a46df597 shape — 2780 folders, 600 scored / 2180 pending
  const syntheticSession = { era: 'synthetic' }
  const synthetic = []
  for (let i = 0; i < 2780; i += 1) synthetic.push({ id: `syn-${i}`, createdAt: cutoff + 1000 + i, scored: i < 600 })
  // current: b5eeee7e 359/359 + qqb-g 10/8 (2 pending)
  const current = []
  for (let i = 0; i < 359; i += 1) current.push({ id: `b5-${i}`, createdAt: cutoff + 2000 + i, scored: true })
  for (let i = 0; i < 10; i += 1) current.push({ id: `qq-${i}`, createdAt: cutoff + 5000 + i, scored: i >= 2 })

  const legacy = summarizeEras(folders, { era: 'current' })
  assert.equal(legacy.total, 593)
  assert.equal(legacy.scored.legacy, 6)
  assert.equal(legacy.pending.legacy, 587)

  const syntheticSummary = summarizeEras(synthetic, syntheticSession)
  assert.equal(syntheticSummary.pending.synthetic, 2180)
  assert.equal(syntheticSummary.folders.synthetic, 2780)

  const currentSummary = summarizeEras(current, { era: 'current' })
  assert.equal(currentSummary.total, 369)
  assert.equal(currentSummary.scored.current, 367)
  assert.equal(currentSummary.pending.current, 2)
  assert.equal(currentSummary.currentPendingPercent, 0.54)
  assert.deepEqual(currentSummary.pendingFolders, ['qq-0', 'qq-1'])

  // combined store: 74.0% overall, current-only 0.54% (era is classified per
  // store, so the combined numbers are the sum of the three store summaries)
  const all = {
    total: legacy.total + syntheticSummary.total + currentSummary.total,
    pending: {
      legacy: legacy.pending.legacy,
      synthetic: syntheticSummary.pending.synthetic,
      current: currentSummary.pending.current,
    },
    scored: {
      legacy: legacy.scored.legacy,
      synthetic: syntheticSummary.scored.synthetic,
      current: currentSummary.scored.current,
    },
  }
  assert.equal(all.total, 3742)
  assert.equal(all.pending.legacy, 587)
  assert.equal(all.pending.synthetic, 2180)
  assert.equal(all.pending.current, 2)
  assert.equal(all.pending.legacy + all.pending.current + all.pending.synthetic, 2769)
  assert.equal(Math.round(((all.pending.legacy + all.pending.current + all.pending.synthetic) / all.total) * 1000) / 10, 74)
  assert.equal(all.scored.legacy + all.scored.synthetic + all.scored.current, 973)
})
