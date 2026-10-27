#!/usr/bin/env node
/**
 * dsh-rofm — independent self-check tool (v1.2.0 R5).
 *
 * Validates the *persisted* plugin state and the v1.2.0 engine contract with its
 * own readers and invariants; it deliberately does not import `lib/plugin.js`, so
 * a broken adapter cannot hide its own damage. The only plugin code it reuses is
 * the zero-dependency engine surface the public API exposes (`engine/config.js`
 * defaults + `planCompression` for the smoke test) and `locateFrames` from the
 * session-log repair tool (frame scanning is container plumbing, not plugin
 * behavior).
 *
 * Checks (every one is PASS / WARN / FAIL; exit code 1 iff at least one FAIL):
 *   1. config        — engine/config.js loads, config.json is valid JSON, the
 *                      v1.2.0 knobs are present and `compress.maxFoldersPerRun`
 *                      is 500.
 *   2. engine        — DEFAULT_CONFIG default is 500; planCompression smoke test
 *                      (folder cap honoured, duplicate titles disambiguated).
 *   3. memory store  — index.json ↔ disk reconciliation both ways, meta.json
 *                      schema (id/createdAt/α/β/scored/keywords/rescorePending),
 *                      unsafe folder ids, images/index.json files exist,
 *                      stats.jsonl lines are valid JSON.
 *   4. recall state  — every recall-state.json is a valid v2 snapshot with safe,
 *                      consistent ids/additions.
 *   5. session logs  — replay `surfaceOp` append/replace from the zstd frames to
 *                      the final surface; at most one dsh-rofm checkpoint note
 *                      (more → WARN, legacy residue from before note merging), N is a positive integer,
 *                      the note appendix must not carry re-injected infrastructure
 *                      (runtime/time/skill context, in-history system copies,
 *                      recall snapshots); foreign checkpoints are counted but
 *                      never fail.
 *   6. test suite    — optional (`--with-tests`): `node --test` exits 0.
 *
 * Legacy data policy: historical shapes that older versions legitimately wrote
 * are reported as WARN, never FAIL. A session whose final surface still carries
 * more than one dsh-rofm note provably predates v1.2.0 (v1.2 merges every old
 * note into the single surviving one), so that session's note appendices are
 * treated as legacy residue (WARN) instead of current-format violations (FAIL).
 *
 * Zero dependencies, ESM, Node >= 20.
 *
 *   node tools/selfcheck.mjs [options]
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TOOL_FILE = fileURLToPath(import.meta.url)
const TOOLS_DIR = path.dirname(TOOL_FILE)
/** Repository / plugin root (the directory that holds `engine/`, `lib/`, `memory/`). */
const REPO_ROOT = path.resolve(TOOLS_DIR, '..')
const ENGINE_DIR = path.join(REPO_ROOT, 'engine')

/** v1.2.0 contract: compression may archive at most this many folders per run. */
const EXPECTED_MAX_FOLDERS_PER_RUN = 500
/** A folder id must be one safe path segment. */
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/
/** DSH canonical folder id (`mem-20261026T131909Z-0001`). */
const CANONICAL_FOLDER_ID_RE = /^mem-\d{8}T\d{6}Z-\d{4}$/
/** The dsh-rofm checkpoint note prefix (v1.0 … v1.2, keyword form optional).
 * Anchored at the start and deliberately not at the end: the note may be
 * followed by the pinned-context appendix. */
const ARCHIVE_NOTE_RE = /^\[memory\] (\d+) 段更早的对话已归档到 memory\//
/** Start of the pinned-context appendix inside a checkpoint note. */
const APPENDIX_MARKER = '[memory] 本次归档区间内还有'
/** Re-injected host infrastructure that must never be copied into a note (R4).
 * Detected as literal markers so the check works without importing plugin code. */
const EXCLUDED_APPENDIX_MARKERS = [
  'Current runtime context',
  'Time sampled',
  'A skill is a reusable set of',
  '## 记忆回忆',
  '<system-reminder>',
  'You are an AI agent powered by DeepSeek Harness',
]
/** Role-scoped message event types and where their message payload lives. */
const MESSAGE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
/** Default number of (newest) session logs inspected when `--max-sessions` is absent. */
const DEFAULT_MAX_SESSIONS = 20
/** Upper bound for the optional `node --test` subprocess. */
const TEST_SUITE_TIMEOUT_MS = 10 * 60 * 1000
/** Hard cap on collected issue records (counts are never capped). */
const ISSUE_RECORD_LIMIT = 200

const USAGE = `dsh-rofm selfcheck (zero dependencies) — independent health check for the v1.2.0
memory plugin. Exits 1 when at least one check fails, 0 otherwise.

Usage:
  node tools/selfcheck.mjs [options]

Options:
  --json                  print one machine-readable JSON object instead of check lines
  --memory-dir <dir>      memory store root to inspect (default: <repo>/memory)
  --sessions-dir <dir>    DSH sessions root (default: $DSH_HOME/sessions,
                          fallback ~/.dsh/sessions)
  --session <id>          only inspect this session id (matches the session header
                          id and/or the session directory name)
  --max-sessions <N>      inspect the N most recently modified session logs
                          (default ${DEFAULT_MAX_SESSIONS}; 0 = all)
  --with-tests            also run \`node --test\` in the repository (slow)
  -h, --help              show this help

Checks: config, engine defaults + planCompression smoke, memory store, recall
state, session-log checkpoint notes, and (with --with-tests) the test suite.
PASS/WARN/FAIL lines are printed as:
  [PASS] <check> — <detail>
and the last line is:
  selfcheck: X passed, Y warnings, Z failed`

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// small generic helpers
// ---------------------------------------------------------------------------

/** Collapse a value to one short single-line display string. */
function oneLine(value, limit = 400) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** Whether a path is an existing directory (never throws). */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Whether a path is an existing regular file (never throws). */
function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/** Whether an id is a safe single path segment (never `.` or `..`). */
function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..' && SAFE_ID_RE.test(id)
}

/** Read one JSON file: { ok, value, error }. */
function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null }
  } catch (error) {
    return { ok: false, value: undefined, error }
  }
}

/** Read and parse `<memoryDir>/index.json`; never throws. */
function readIndexFile(file) {
  return readJsonFile(file)
}

/** The DSH sessions root: `$DSH_HOME/sessions`, falling back to `~/.dsh/sessions`. */
export function defaultSessionsDir(env = process.env, homedir = os.homedir()) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0
    ? env.DSH_HOME.trim()
    : path.join(homedir, '.dsh')
  return path.join(home, 'sessions')
}

/** Bounded issue collector: keeps counts for everything, records for diagnostics. */
class IssueLog {
  constructor(limit = ISSUE_RECORD_LIMIT) {
    this.limit = limit
    this.items = []
    this.total = 0
    this.bySeverity = { FAIL: 0, WARN: 0 }
  }

  add(severity, code, message) {
    this.total += 1
    if (severity === 'FAIL' || severity === 'WARN') this.bySeverity[severity] += 1
    if (this.items.length < this.limit) this.items.push({ severity, code, message })
  }

  fail(code, message) {
    this.add('FAIL', code, message)
  }

  warn(code, message) {
    this.add('WARN', code, message)
  }

  get failed() {
    return this.bySeverity.FAIL
  }

  get warned() {
    return this.bySeverity.WARN
  }
}

/** Add one check result to the report. detail must be a single readable line. */
function addCheck(report, name, status, detail, data) {
  report.checks.push({ name, status, detail: oneLine(detail), data: data === undefined ? undefined : data })
}

/** New empty self-check report. */
function newReport() {
  return { checks: [] }
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse the CLI arguments. Throws `UsageError` for malformed input.
 * @param {string[]} argv arguments without the node/script prefix
 */
export function parseArgs(argv) {
  const options = {
    json: false,
    memoryDir: null,
    sessionsDir: null,
    sessionId: null,
    maxSessions: DEFAULT_MAX_SESSIONS,
    withTests: false,
    help: false,
  }
  const args = Array.isArray(argv) ? argv : []
  for (let index = 0; index < args.length; index += 1) {
    const raw = String(args[index])
    let flag = raw
    let inline
    if (raw.startsWith('--')) {
      const equals = raw.indexOf('=')
      if (equals !== -1) {
        flag = raw.slice(0, equals)
        inline = raw.slice(equals + 1)
      }
    }
    const value = () => {
      if (inline !== undefined) return inline
      index += 1
      if (index >= args.length) throw new UsageError(`option ${flag} requires a value`)
      return String(args[index])
    }
    switch (flag) {
      case '--json':
        options.json = true
        break
      case '--with-tests':
        options.withTests = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      case '--memory-dir':
        options.memoryDir = value()
        break
      case '--sessions-dir':
        options.sessionsDir = value()
        break
      case '--session':
        options.sessionId = value()
        break
      case '--max-sessions': {
        const text = value()
        const parsed = Number(text)
        if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`--max-sessions expects a non-negative integer, got ${JSON.stringify(text)}`)
        options.maxSessions = parsed
        break
      }
      default:
        throw new UsageError(`unknown option: ${raw}`)
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// check 1 — configuration
// ---------------------------------------------------------------------------

/**
 * Dynamic import of one engine module (`engine/config.js` / `engine/index.js`),
 * which keeps this tool usable even when the adapter layer is broken.
 * @param {'config.js'|'index.js'} name
 */
async function importEngineModule(name) {
  return import(pathToFileURL(path.join(ENGINE_DIR, name)).href)
}

/** Run the config check: engine/config.js + config.json + v1.2.0 knobs. */
async function checkConfig(report) {
  const configPath = path.join(REPO_ROOT, 'config.json')
  const data = { configPath }
  let configModule
  try {
    configModule = await importEngineModule('config.js')
  } catch (error) {
    addCheck(report, 'config', 'FAIL', `engine/config.js cannot be loaded: ${error.message}`, data)
    return { configModule: null, config: null }
  }
  const { DEFAULT_CONFIG, loadConfig } = configModule
  data.defaultMaxFoldersPerRun = DEFAULT_CONFIG?.compress?.maxFoldersPerRun

  const issues = []
  const warnings = []
  const fileConfig = readJsonFile(configPath)
  if (!fileConfig.ok) {
    if (fileConfig.error && fileConfig.error.code === 'ENOENT') warnings.push(`config.json not found (${configPath}); built-in defaults are used`)
    else issues.push(`config.json is not valid JSON: ${fileConfig.error.message}`)
  }
  const rawConfig = fileConfig.ok && fileConfig.value && typeof fileConfig.value === 'object' ? fileConfig.value : {}
  data.fileMaxFoldersPerRun = rawConfig?.compress?.maxFoldersPerRun
  if (fileConfig.ok && rawConfig?.compress?.maxFoldersPerRun !== EXPECTED_MAX_FOLDERS_PER_RUN) {
    issues.push(`config.json compress.maxFoldersPerRun = ${JSON.stringify(rawConfig?.compress?.maxFoldersPerRun)} (expected ${EXPECTED_MAX_FOLDERS_PER_RUN})`)
  }

  let config = null
  try {
    config = loadConfig(configPath)
  } catch (error) {
    issues.push(`loadConfig(config.json) threw: ${error.message}`)
  }
  if (config) {
    data.maxFoldersPerRun = config.compress?.maxFoldersPerRun
    data.storageMaxFolders = config.storage?.maxFolders
    if (config.compress?.maxFoldersPerRun !== EXPECTED_MAX_FOLDERS_PER_RUN) {
      issues.push(`resolved compress.maxFoldersPerRun = ${JSON.stringify(config.compress?.maxFoldersPerRun)} (expected ${EXPECTED_MAX_FOLDERS_PER_RUN})`)
    }
    if (!(Number.isInteger(config.storage?.maxFolders) && config.storage.maxFolders > 0)) {
      issues.push(`storage.maxFolders must be a positive integer, got ${JSON.stringify(config.storage?.maxFolders)}`)
    }
    const requiredNumbers = [
      ['compress.triggerPercent', config.compress?.triggerPercent],
      ['compress.compressPercent', config.compress?.compressPercent],
      ['compress.targetChunkChars', config.compress?.targetChunkChars],
      ['compress.minChunkChars', config.compress?.minChunkChars],
      ['compress.keepRecentMessages', config.compress?.keepRecentMessages],
      ['recall.firstGenMax', config.recall?.firstGenMax],
      ['recall.maxRecalledBlocks', config.recall?.maxRecalledBlocks],
    ]
    for (const [name, value] of requiredNumbers) {
      if (typeof value !== 'number' || !Number.isFinite(value)) issues.push(`${name} is missing or not a number`)
    }
    if (typeof config.compress?.enabled !== 'boolean') issues.push('compress.enabled is missing or not a boolean')
    if (typeof config.recall?.enabled !== 'boolean') issues.push('recall.enabled is missing or not a boolean')
    if (!Array.isArray(config.recall?.triggerSourceKinds)) issues.push('recall.triggerSourceKinds is missing or not an array')
    if (Array.isArray(config.warnings)) {
      for (const warning of config.warnings) warnings.push(`config validation warning: ${warning}`)
    }
  }

  data.issues = issues
  data.warnings = warnings
  if (issues.length > 0) {
    addCheck(report, 'config', 'FAIL', `${issues[0]}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`, data)
    return { configModule, config }
  }
  if (warnings.length > 0) {
    addCheck(report, 'config', 'WARN', `${oneLine(warnings[0])}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}`, data)
    return { configModule, config }
  }
  addCheck(
    report,
    'config',
    'PASS',
    `engine/config.js + config.json valid; compress.maxFoldersPerRun=${EXPECTED_MAX_FOLDERS_PER_RUN}, storage.maxFolders=${config?.storage?.maxFolders}`,
    data,
  )
  return { configModule, config }
}

// ---------------------------------------------------------------------------
// check 2 — engine defaults + planCompression smoke test
// ---------------------------------------------------------------------------

/** Build `count` user/assistant dialog pairs with the given texts. */
function buildDialogPairs(count, userTextFor, assistantTextFor) {
  const messages = []
  for (let index = 0; index < count; index += 1) {
    messages.push({ role: 'user', content: userTextFor(index) })
    messages.push({ role: 'assistant', content: assistantTextFor(index) })
  }
  return messages
}

/** Validate the folder plans a smoke test produced (no writes). */
function validatePlannedFolders(plan, issues, label) {
  for (const folder of Array.isArray(plan?.folders) ? plan.folders : []) {
    const meta = folder?.meta
    if (!meta || typeof meta !== 'object') {
      issues.push(`${label}: a planned folder has no meta`)
      continue
    }
    if (!isSafeId(meta.id)) issues.push(`${label}: planned folder id ${JSON.stringify(meta.id)} is not a safe path segment`)
    if (typeof meta.title !== 'string' || meta.title.length === 0) issues.push(`${label}: planned folder ${JSON.stringify(meta.id)} has an empty title`)
    if (typeof meta.alpha !== 'number' || meta.alpha < 0.01 || meta.alpha > 1) issues.push(`${label}: planned folder ${JSON.stringify(meta.id)} alpha=${meta.alpha} out of range`)
    if (typeof meta.beta !== 'number' || meta.beta < -10 || meta.beta > 10) issues.push(`${label}: planned folder ${JSON.stringify(meta.id)} beta=${meta.beta} out of range`)
    if (!Array.isArray(meta.keywords)) issues.push(`${label}: planned folder ${JSON.stringify(meta.id)} keywords is not an array`)
  }
}

/** Run the engine-defaults + planCompression smoke check. */
async function checkEngine(report, configModule) {
  const data = {}
  if (!configModule) {
    addCheck(report, 'engine', 'FAIL', 'engine/config.js is not loadable, so engine defaults cannot be verified')
    return
  }
  const { DEFAULT_CONFIG, loadConfig } = configModule
  let planCompression = null
  try {
    planCompression = (await importEngineModule('index.js')).planCompression
  } catch (error) {
    addCheck(report, 'engine', 'FAIL', `engine/index.js cannot be loaded: ${error.message}`, data)
    return
  }
  if (typeof planCompression !== 'function') {
    addCheck(report, 'engine', 'FAIL', 'engine/index.js does not export planCompression', data)
    return
  }

  const issues = []
  data.defaultMaxFoldersPerRun = DEFAULT_CONFIG?.compress?.maxFoldersPerRun
  if (DEFAULT_CONFIG?.compress?.maxFoldersPerRun !== EXPECTED_MAX_FOLDERS_PER_RUN) {
    issues.push(`DEFAULT_CONFIG.compress.maxFoldersPerRun = ${JSON.stringify(DEFAULT_CONFIG?.compress?.maxFoldersPerRun)} (expected ${EXPECTED_MAX_FOLDERS_PER_RUN})`)
  }

  // --- smoke A: the per-run folder cap is honoured. -----------------------
  const capLimit = 3
  const capConfig = loadConfig(null, {
    compress: {
      enabled: true,
      triggerPercent: 50,
      compressPercent: 80,
      minContextTokens: 100,
      minMessagesToCompress: 4,
      minChunkChars: 1,
      targetChunkChars: 100,
      maxFoldersPerRun: capLimit,
      keepRecentMessages: 1,
      maxBoundaryOvershoot: 10,
    },
  })
  const capMessages = buildDialogPairs(
    40,
    (index) => `第${index + 1}轮：继续讨论部署 docker 端口配置与数据库迁移。`,
    () => '这是用于压缩冒烟测试的填充内容。'.repeat(8),
  )
  let capPlan = null
  try {
    capPlan = planCompression({ messages: capMessages, usedPercent: 95, cfg: capConfig })
  } catch (error) {
    issues.push(`planCompression (cap smoke) threw: ${error.message}`)
  }
  data.capFolders = capPlan?.folders?.length ?? 0
  data.capLimit = capLimit
  if (capPlan) {
    if (capPlan.shouldCompress !== true || data.capFolders === 0) {
      issues.push('planCompression cap smoke planned no archive for a clearly oversized context')
    } else if (data.capFolders > capLimit) {
      issues.push(`planCompression planned ${data.capFolders} folders with maxFoldersPerRun=${capLimit}`)
    }
    validatePlannedFolders(capPlan, issues, 'cap smoke')
  }

  // --- smoke B: duplicate titles are disambiguated (§R2). ------------------
  const titleConfig = loadConfig(null, {
    compress: {
      enabled: true,
      triggerPercent: 50,
      compressPercent: 50,
      minContextTokens: 100,
      minMessagesToCompress: 4,
      minChunkChars: 10,
      targetChunkChars: 400,
      maxFoldersPerRun: 100,
      keepRecentMessages: 1,
      maxBoundaryOvershoot: 10,
    },
  })
  const titleMessages = buildDialogPairs(
    10,
    () => '重复标题测试。',
    (index) => `第${index}条回复：` + '这是用于标题去重冒烟测试的填充内容。'.repeat(14),
  )
  let titlePlan = null
  try {
    titlePlan = planCompression({ messages: titleMessages, usedPercent: 90, cfg: titleConfig })
  } catch (error) {
    issues.push(`planCompression (title smoke) threw: ${error.message}`)
  }
  const titleFolders = Array.isArray(titlePlan?.folders) ? titlePlan.folders : []
  data.titleFolders = titleFolders.length
  data.titles = titleFolders.map((folder) => folder?.meta?.title)
  if (titlePlan) {
    if (titleFolders.length < 2) data.titleSmokeSkipped = true
    const titles = titleFolders.map((folder) => folder?.meta?.title)
    const unique = new Set(titles)
    if (titleFolders.length >= 2 && unique.size !== titles.length) {
      const duplicates = titles.filter((title, index) => titles.indexOf(title) !== index)
      issues.push(`planCompression produced ${titles.length - unique.size} duplicate title(s) in one run: ${JSON.stringify(duplicates.slice(0, 3))}`)
    }
    validatePlannedFolders(titlePlan, issues, 'title smoke')
  }

  data.issues = issues
  if (issues.length > 0) {
    addCheck(report, 'engine', 'FAIL', `${issues[0]}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`, data)
    return
  }
  const skipped = data.titleSmokeSkipped ? ' (title smoke planned <2 folders; uniqueness not exercised)' : ''
  addCheck(
    report,
    'engine',
    'PASS',
    `DEFAULT_CONFIG.compress.maxFoldersPerRun=${EXPECTED_MAX_FOLDERS_PER_RUN}; planCompression smoke: ${data.capFolders}/${capLimit} folders (cap honoured), ${data.titleFolders} folders with unique titles${skipped}`,
    data,
  )
}

// ---------------------------------------------------------------------------
// check 3/4 — memory store + recall state
// ---------------------------------------------------------------------------

/**
 * Locate every "store directory" under a memory root. With the default
 * `storage.perSession: true` the real stores are `memory/sessions/<id>/`; a
 * single-store layout (`memory/` itself holds index.json + folders) is supported
 * too. A store is a directory that carries one of the store files or at least
 * one `mem-*` folder. The walk stops at a found store, `images/`, hidden
 * directories and `mem-*` folders.
 */
function findMemoryStores(memoryDir) {
  const stores = []
  const stack = [{ dir: memoryDir, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    const dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    const looksLikeStore =
      fileNames.includes('index.json') ||
      fileNames.includes('stats.jsonl') ||
      fileNames.includes('recall-state.json') ||
      dirNames.some((name) => name.startsWith('mem-'))
    if (looksLikeStore) {
      stores.push(dir)
      continue
    }
    if (depth >= 3) continue
    for (const name of dirNames) {
      if (name === 'images' || name.startsWith('.') || name.startsWith('mem-')) continue
      stack.push({ dir: path.join(dir, name), depth: depth + 1 })
    }
  }
  return stores.sort()
}

/** Validate one `meta.json` object against the documented schema (§R5 check 3). */
function validateFolderMeta(meta, dirName, storeLabel, issues, counts) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    issues.fail('meta-invalid-shape', `${storeLabel}/${dirName}: meta.json is not a JSON object`)
    return
  }
  const label = `${storeLabel}/${dirName}`
  if (typeof meta.id !== 'string' || !isSafeId(meta.id)) {
    issues.fail('meta-id-unsafe', `${label}: meta.id=${JSON.stringify(meta.id)} is not a safe folder id`)
  } else if (meta.id !== dirName) {
    issues.fail('meta-id-mismatch', `${label}: meta.id=${JSON.stringify(meta.id)} does not match the directory name`)
  }
  if (typeof meta.createdAt !== 'number' || !Number.isFinite(meta.createdAt)) {
    issues.fail('meta-created-at', `${label}: createdAt=${JSON.stringify(meta.createdAt)} is not a finite number`)
  }
  if (meta.version !== undefined && meta.version !== 1) {
    issues.warn('meta-version', `${label}: meta.version=${JSON.stringify(meta.version)} is not 1`)
  }
  let scored
  if (typeof meta.scored === 'boolean') {
    scored = meta.scored
  } else if (meta.scored === undefined) {
    // Pre-`scored` folders are already usable for recall (index defaults to true).
    scored = true
    issues.warn('meta-scored-missing', `${label}: scored is missing (legacy folder, treated as scored)`)
  } else {
    issues.fail('meta-scored-type', `${label}: scored=${JSON.stringify(meta.scored)} is not a boolean`)
    scored = meta.scored !== false
  }
  if (scored) {
    counts.scored += 1
    if (typeof meta.alpha !== 'number' || !Number.isFinite(meta.alpha) || meta.alpha < 0.01 || meta.alpha > 1) {
      issues.fail('meta-alpha-range', `${label}: alpha=${JSON.stringify(meta.alpha)} is outside [0.01, 1] for a scored folder`)
    }
    if (meta.beta === undefined) {
      issues.warn('meta-beta-missing', `${label}: beta is missing (legacy folder, treated as 0)`)
    } else if (typeof meta.beta !== 'number' || !Number.isFinite(meta.beta) || meta.beta < -10 || meta.beta > 10) {
      issues.fail('meta-beta-range', `${label}: beta=${JSON.stringify(meta.beta)} is outside [-10, 10]`)
    }
    if (!Array.isArray(meta.keywords)) {
      issues.fail('meta-keywords-type', `${label}: keywords is not an array for a scored folder`)
    } else if (meta.keywords.length < 3 || meta.keywords.length > 8) {
      issues.fail('meta-keywords-count', `${label}: keywords has ${meta.keywords.length} entries (expected 3..8 for a scored folder)`)
    } else if (!meta.keywords.every((keyword) => typeof keyword === 'string')) {
      issues.fail('meta-keywords-entry', `${label}: keywords contains a non-string entry`)
    }
  } else {
    counts.pending += 1
    if (meta.alpha !== 0) issues.warn('meta-alpha-unscored', `${label}: unscored folder has alpha=${JSON.stringify(meta.alpha)} (expected 0)`)
    if (Array.isArray(meta.keywords) && meta.keywords.length > 0) {
      issues.warn('meta-keywords-unscored', `${label}: unscored folder already carries ${meta.keywords.length} keyword(s)`)
    }
  }
  if (meta.rescorePending !== undefined && typeof meta.rescorePending !== 'boolean') {
    issues.fail('meta-rescore-pending-type', `${label}: rescorePending=${JSON.stringify(meta.rescorePending)} is not a boolean`)
  }
  if (meta.stats !== undefined) {
    if (meta.stats === null || typeof meta.stats !== 'object' || Array.isArray(meta.stats)) {
      issues.fail('meta-stats-shape', `${label}: stats is not an object`)
    } else {
      for (const key of ['messages', 'chars', 'tokens']) {
        const value = meta.stats[key]
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
          issues.warn('meta-stats-field', `${label}: stats.${key}=${JSON.stringify(value)} is not a non-negative number`)
        }
      }
    }
  }
  if (meta.images !== undefined && !Array.isArray(meta.images)) {
    issues.warn('meta-images-shape', `${label}: images is not an array`)
  }
}

/** Inspect one store directory (index, folders, images, stats) — pushes issues. */
function inspectStore(storeDir, memoryDir, issues, counts) {
  const storeLabel = path.relative(memoryDir, storeDir) || '.'
  const store = { dir: path.relative(memoryDir, storeDir) || '.', folders: 0, indexEntries: 0, pending: 0 }
  let entries
  try {
    entries = fs.readdirSync(storeDir, { withFileTypes: true })
  } catch (error) {
    issues.fail('store-unreadable', `${storeLabel}: cannot list the store directory (${error.message})`)
    return store
  }
  const dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const folderDirs = []
  for (const name of dirNames) {
    if (name === 'images' || name.startsWith('.')) continue
    const dir = path.join(storeDir, name)
    if (name.startsWith('mem-') || isFile(path.join(dir, 'meta.json'))) folderDirs.push(name)
  }
  folderDirs.sort()

  // --- index.json ---------------------------------------------------------
  const indexPath = path.join(storeDir, 'index.json')
  const indexExists = isFile(indexPath)
  let index = null
  if (indexExists) {
    const parsed = readIndexFile(indexPath)
    if (!parsed.ok) {
      issues.fail('index-invalid-json', `${storeLabel}: index.json is not valid JSON (${parsed.error.message})`)
    } else if (parsed.value === null || typeof parsed.value !== 'object' || !Array.isArray(parsed.value.folders)) {
      issues.fail('index-invalid-shape', `${storeLabel}: index.json has no folders array`)
    } else {
      index = parsed.value
    }
  } else if (folderDirs.length > 0) {
    // The engine rebuilds a missing index from meta.json on read, so this is
    // recoverable legacy state: WARN, never FAIL.
    issues.warn('index-missing', `${storeLabel}: index.json is missing (the engine will rebuild it from ${folderDirs.length} folder(s))`)
  }

  const indexedIds = new Set()
  if (index) {
    for (const entry of index.folders) {
      if (entry === null || typeof entry !== 'object') {
        issues.fail('index-entry-shape', `${storeLabel}: index.json holds a non-object folder entry`)
        continue
      }
      store.indexEntries += 1
      if (!isSafeId(entry.id)) {
        issues.fail('index-entry-id-unsafe', `${storeLabel}: index.json holds unsafe folder id ${JSON.stringify(entry.id)}`)
        continue
      }
      if (indexedIds.has(entry.id)) {
        issues.fail('index-entry-duplicate', `${storeLabel}: index.json lists folder ${entry.id} more than once`)
        continue
      }
      indexedIds.add(entry.id)
      if (!isFile(path.join(storeDir, entry.id, 'meta.json'))) {
        issues.fail('index-entry-missing-folder', `${storeLabel}: index.json lists ${entry.id} but its meta.json is missing on disk`)
      }
    }
  }

  // --- folder directories -------------------------------------------------
  for (const name of folderDirs) {
    store.folders += 1
    const label = `${storeLabel}/${name}`
    if (!isSafeId(name)) {
      issues.fail('folder-dir-id-unsafe', `${label}: folder directory name is not a safe single path segment`)
      continue
    }
    if (!CANONICAL_FOLDER_ID_RE.test(name) && !/^[A-Za-z0-9._-]+$/.test(name)) {
      issues.fail('folder-dir-id-noncanonical', `${label}: folder directory name is not a canonical mem-<stamp>-<NNNN> id`)
    }
    const metaPath = path.join(storeDir, name, 'meta.json')
    if (!isFile(metaPath)) {
      issues.fail('folder-meta-missing', `${label}: meta.json is missing`)
      continue
    }
    const parsed = readJsonFile(metaPath)
    if (!parsed.ok) {
      issues.fail('folder-meta-invalid-json', `${label}: meta.json is not valid JSON (${parsed.error.message})`)
      continue
    }
    const pendingBefore = counts.pending
    validateFolderMeta(parsed.value, name, storeLabel, issues, counts)
    if (counts.pending > pendingBefore) store.pending += 1
    if (index && !indexedIds.has(name)) {
      issues.fail('folder-not-indexed', `${label}: folder exists on disk but is absent from index.json`)
    }
  }

  // --- images/index.json --------------------------------------------------
  const imagesDir = path.join(storeDir, 'images')
  if (isDirectory(imagesDir)) {
    const imageIndexPath = path.join(imagesDir, 'index.json')
    if (!isFile(imageIndexPath)) {
      const imageFiles = (() => {
        try {
          return fs.readdirSync(imagesDir).filter((name) => !name.startsWith('.'))
        } catch {
          return []
        }
      })()
      if (imageFiles.length > 0) issues.warn('images-index-missing', `${storeLabel}: images/ holds ${imageFiles.length} file(s) but images/index.json is missing`)
    } else {
      const parsed = readIndexFile(imageIndexPath)
      if (!parsed.ok) {
        issues.fail('images-index-invalid-json', `${storeLabel}: images/index.json is not valid JSON (${parsed.error.message})`)
      } else {
        const imageEntries = Array.isArray(parsed.value?.images) ? parsed.value.images : null
        if (imageEntries === null) {
          issues.fail('images-index-invalid-shape', `${storeLabel}: images/index.json has no images array`)
        } else {
          for (const entry of imageEntries) {
            if (entry === null || typeof entry !== 'object') {
              issues.fail('images-index-entry-shape', `${storeLabel}: images/index.json holds a non-object entry`)
              continue
            }
            if (!isSafeId(entry.name)) {
              issues.fail('images-index-name-unsafe', `${storeLabel}: images/index.json holds unsafe image name ${JSON.stringify(entry.name)}`)
              continue
            }
            counts.imageFiles += 1
            if (!isFile(path.join(imagesDir, entry.name))) {
              issues.fail('images-index-file-missing', `${storeLabel}: images/index.json lists ${entry.name} but the file is missing`)
            }
            if (entry.folderId !== undefined && (!isSafeId(entry.folderId) || !isDirectory(path.join(storeDir, entry.folderId)))) {
              issues.fail('images-index-folder-missing', `${storeLabel}: image ${entry.name} points at missing folder ${JSON.stringify(entry.folderId)}`)
            }
          }
        }
      }
    }
  }

  // --- stats.jsonl --------------------------------------------------------
  const statsPath = path.join(storeDir, 'stats.jsonl')
  if (isFile(statsPath)) {
    let text = ''
    try {
      text = fs.readFileSync(statsPath, 'utf8')
    } catch (error) {
      issues.fail('stats-unreadable', `${storeLabel}: stats.jsonl cannot be read (${error.message})`)
    }
    if (text) {
      let lineNumber = 0
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length === 0) continue
        lineNumber += 1
        counts.statsLines += 1
        try {
          JSON.parse(line)
        } catch (error) {
          issues.fail('stats-line-invalid-json', `${storeLabel}: stats.jsonl line ${lineNumber} is not valid JSON (${error.message})`)
        }
      }
    }
  }
  return store
}

/**
 * Full memory-store inspection: every store found under `memoryDir`.
 * @returns {{memoryDir:string, exists:boolean, stores:object[], issues:IssueLog, counts:object}}
 */
function inspectMemory(memoryDir) {
  const issues = new IssueLog()
  const counts = { stores: 0, folders: 0, indexEntries: 0, pending: 0, scored: 0, statsLines: 0, imageFiles: 0 }
  const result = { memoryDir, exists: isDirectory(memoryDir), stores: [], issues, counts }
  if (!result.exists) return result
  let storeDirs = []
  try {
    storeDirs = findMemoryStores(memoryDir)
  } catch (error) {
    issues.fail('memory-scan', `cannot scan ${memoryDir}: ${error.message}`)
    return result
  }
  for (const storeDir of storeDirs) {
    const store = inspectStore(storeDir, memoryDir, issues, counts)
    result.stores.push(store)
    counts.stores += 1
    counts.folders += store.folders
    counts.indexEntries += store.indexEntries
  }
  return result
}

/** Convert an IssueLog into a check status + concise detail. */
function severityStatus(issues) {
  if (issues.failed > 0) return 'FAIL'
  if (issues.warned > 0) return 'WARN'
  return 'PASS'
}

/** Summarize the first issues of a log into one detail line. */
function summarizeIssues(issues, limit = 3) {
  const parts = issues.items.slice(0, limit).map((item) => `${item.code}: ${item.message}`)
  const hidden = issues.total - parts.length
  return `${parts.join('; ')}${hidden > 0 ? ` (+${hidden} more)` : ''}`
}

/** Run the memory-store integrity check (index ↔ disk, meta schema, images, stats). */
function checkMemoryStore(report, memory) {
  const data = {
    memoryDir: memory.memoryDir,
    exists: memory.exists,
    counts: memory.counts,
    stores: memory.stores,
    issues: memory.issues.items,
    issueTotal: memory.issues.total,
  }
  if (!memory.exists) {
    addCheck(report, 'memory store', 'WARN', `memory dir not found: ${memory.memoryDir} (nothing archived yet)`, data)
    return
  }
  if (memory.counts.stores === 0) {
    addCheck(report, 'memory store', 'PASS', `no memory stores under ${memory.memoryDir} (nothing archived yet)`, data)
    return
  }
  const status = severityStatus(memory.issues)
  const counts = memory.counts
  const summary =
    `${counts.stores} store(s), ${counts.folders} folder(s), ${counts.indexEntries} index entr(y/ies); ` +
    `${counts.pending} pending (unscored), ${counts.scored} scored; ${counts.statsLines} stats line(s), ${counts.imageFiles} archived image(s)`
  if (status === 'FAIL') addCheck(report, 'memory store', 'FAIL', `${memory.issues.failed} problem(s): ${summarizeIssues(memory.issues)}; ${summary}`, data)
  else if (status === 'WARN') addCheck(report, 'memory store', 'WARN', `${memory.issues.warned} warning(s): ${summarizeIssues(memory.issues)}; ${summary}`, data)
  else addCheck(report, 'memory store', 'PASS', `index and disk agree; meta/keywords/stats valid; ${summary}`, data)
}

/** Validate one recall-state.json payload; returns issues as {severity,code,message}[]. */
function validateRecallState(state, label) {
  const issues = []
  const fail = (code, message) => issues.push({ severity: 'FAIL', code, message })
  const warn = (code, message) => issues.push({ severity: 'WARN', code, message })
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    fail('recall-state-shape', `${label}: recall-state.json is not a JSON object`)
    return issues
  }
  if (state.version === 1) {
    warn('recall-state-v1', `${label}: legacy v1 recall state (no restorable block; next injection upgrades it)`)
    return issues
  }
  if (state.version !== 2) fail('recall-state-version', `${label}: version=${JSON.stringify(state.version)} (expected 2)`)
  if (typeof state.block !== 'string') fail('recall-state-block', `${label}: block is not a string`)
  if (state.sessionId !== undefined && typeof state.sessionId !== 'string') warn('recall-state-session', `${label}: sessionId is not a string`)
  if (typeof state.updatedAt !== 'number' || !Number.isFinite(state.updatedAt)) warn('recall-state-updated-at', `${label}: updatedAt is not a finite number`)
  const ids = Array.isArray(state.ids) ? state.ids : null
  const additions = Array.isArray(state.additions) ? state.additions : null
  if (ids === null) fail('recall-state-ids', `${label}: ids is not an array`)
  if (additions === null) fail('recall-state-additions', `${label}: additions is not an array`)
  if (ids !== null && additions !== null) {
    const idSet = new Set()
    for (const entry of ids) {
      if (entry === null || typeof entry !== 'object' || !isSafeId(entry.id)) {
        fail('recall-state-id-unsafe', `${label}: ids holds an unsafe id ${JSON.stringify(entry?.id)}`)
        continue
      }
      if (idSet.has(entry.id)) fail('recall-state-id-duplicate', `${label}: duplicate id ${entry.id} in ids`)
      idSet.add(entry.id)
    }
    const additionSet = new Set()
    for (const entry of additions) {
      if (entry === null || typeof entry !== 'object') {
        fail('recall-state-addition-shape', `${label}: additions holds a non-object entry`)
        continue
      }
      if (!isSafeId(entry.id)) {
        fail('recall-state-addition-id-unsafe', `${label}: additions holds an unsafe id ${JSON.stringify(entry.id)}`)
        continue
      }
      if (additionSet.has(entry.id)) fail('recall-state-addition-duplicate', `${label}: duplicate id ${entry.id} in additions`)
      additionSet.add(entry.id)
      if (!Array.isArray(entry.messages)) fail('recall-state-addition-messages', `${label}: addition ${entry.id} has no messages array`)
      for (const key of ['alpha', 'chars', 'tokens', 'createdAt']) {
        if (typeof entry[key] !== 'number' || !Number.isFinite(entry[key])) {
          fail('recall-state-addition-field', `${label}: addition ${entry.id} has non-finite ${key}=${JSON.stringify(entry[key])}`)
        }
      }
      if (entry.beta !== undefined && (typeof entry.beta !== 'number' || !Number.isFinite(entry.beta) || entry.beta < -10 || entry.beta > 10)) {
        fail('recall-state-addition-beta', `${label}: addition ${entry.id} has beta=${JSON.stringify(entry.beta)} outside [-10, 10]`)
      }
    }
    const missingInIds = [...additionSet].filter((id) => !idSet.has(id))
    const missingInAdditions = [...idSet].filter((id) => !additionSet.has(id))
    if (missingInIds.length > 0 || missingInAdditions.length > 0) {
      fail('recall-state-ids-mismatch', `${label}: ids and additions disagree (${missingInIds.length} only in additions, ${missingInAdditions.length} only in ids)`)
    }
  }
  return issues
}

/** Run the recall-state check for every store found by the memory scan. */
function checkRecallState(report, memory) {
  const issues = new IssueLog()
  const states = []
  if (memory.exists) {
    for (const store of memory.stores) {
      const file = path.join(memory.memoryDir, store.dir, 'recall-state.json')
      if (!isFile(file)) continue
      const parsed = readJsonFile(file)
      const label = store.dir === '.' ? 'recall-state.json' : `${store.dir}/recall-state.json`
      if (!parsed.ok) {
        issues.fail('recall-state-invalid-json', `${label}: not valid JSON (${parsed.error.message})`)
        continue
      }
      const stateIssues = validateRecallState(parsed.value, label)
      const entry = {
        store: store.dir,
        version: parsed.value?.version,
        ids: Array.isArray(parsed.value?.ids) ? parsed.value.ids.length : null,
        additions: Array.isArray(parsed.value?.additions) ? parsed.value.additions.length : null,
      }
      states.push(entry)
      for (const issue of stateIssues) {
        if (issue.severity === 'FAIL') issues.fail(issue.code, issue.message)
        else issues.warn(issue.code, issue.message)
      }
    }
  }
  const data = { memoryDir: memory.memoryDir, states, issues: issues.items, issueTotal: issues.total }
  if (issues.total === 0) {
    addCheck(
      report,
      'recall state',
      'PASS',
      states.length === 0 ? 'no recall-state.json found (no recall block injected yet)' : `${states.length} recall-state.json file(s) valid (v2 snapshot)`,
      data,
    )
    return
  }
  const status = severityStatus(issues)
  const detail = `${issues.total} issue(s): ${summarizeIssues(issues)}`
  addCheck(report, 'recall state', status, status === 'FAIL' ? detail : `${issues.warned} warning(s): ${summarizeIssues(issues)}`, data)
}

// ---------------------------------------------------------------------------
// check 5 — session-log checkpoint notes
// ---------------------------------------------------------------------------

/** Message payload of one surface-eligible session event. */
function eventMessage(event) {
  if (!event || typeof event !== 'object') return null
  switch (event.type) {
    case 'user/message':
      return event.data ?? null
    case 'assistant/message':
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
      return event.data?.message ?? null
    default:
      return null
  }
}

/** Plain text of a message content value (text blocks only, in order). */
function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/** The note appendix: text after the fixed appendix marker, or '' when absent. */
function noteAppendix(noteText) {
  const at = noteText.indexOf(APPENDIX_MARKER)
  return at === -1 ? '' : noteText.slice(at + APPENDIX_MARKER.length)
}

/** Recursively collect session log files (`session*.jsonl[.zstd]`) under root. */
function findSessionLogs(root) {
  const logs = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (/^session.*\.jsonl(\.zstd)?$/.test(entry.name)) logs.push(full)
    }
  }
  return logs.sort()
}

let repairToolsPromise = null
/** Lazy import of the repair tool (only `locateFrames` is used: frame plumbing). */
async function loadFrameLocator() {
  if (repairToolsPromise === null) {
    repairToolsPromise = import(pathToFileURL(path.join(TOOLS_DIR, 'repair-session-log.mjs')).href)
  }
  return repairToolsPromise
}

/** Decompress one `.jsonl.zstd` container (concatenated frames) or read plain JSONL. */
async function decodeSessionLog(file) {
  const raw = fs.readFileSync(file)
  if (!file.endsWith('.zstd')) return raw.toString('utf8')
  const { locateFrames } = await loadFrameLocator()
  const frames = locateFrames(raw)
  const parts = []
  for (const frame of frames) {
    if (frame.type !== 'zstd') continue
    parts.push(zlib.zstdDecompressSync(raw.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Read just the header line of a session log (fast path for --session). */
async function readSessionHeader(file) {
  try {
    if (!file.endsWith('.zstd')) {
      const text = fs.readFileSync(file, 'utf8')
      const first = text.split('\n').find((line) => line.trim().length > 0)
      return first ? JSON.parse(first) : null
    }
    const raw = fs.readFileSync(file)
    const { locateFrames } = await loadFrameLocator()
    const frames = locateFrames(raw)
    const firstZstd = frames.find((frame) => frame.type === 'zstd')
    if (firstZstd === undefined) return null
    const text = zlib.zstdDecompressSync(raw.subarray(firstZstd.start, firstZstd.end)).toString('utf8')
    const first = text.split('\n').find((line) => line.trim().length > 0)
    return first ? JSON.parse(first) : null
  } catch {
    return null
  }
}

/**
 * Replay one decoded session log to its final surface and collect dsh-rofm
 * checkpoint notes from it.
 * @returns {{sessionId:string|null, eventCount:number, badLines:number, surfaceNodes:number,
 *   replayIssues:{seq:number|null, reason:string}[], notes:object[],
 *   foreignCheckpoints:number, noteCount:number}}
 */
function analyzeSessionLog(file, text) {
  const result = {
    file,
    sessionId: null,
    eventCount: 0,
    badLines: 0,
    surfaceNodes: 0,
    replayIssues: [],
    notes: [],
    foreignCheckpoints: 0,
    noteCount: 0,
  }
  const lines = text.split('\n')
  let headerSeen = false
  const events = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      result.badLines += 1
      continue
    }
    if (!headerSeen) {
      headerSeen = true
      const header = parsed !== null && typeof parsed === 'object' ? parsed : {}
      result.sessionId = typeof header.id === 'string' && header.id.length > 0 ? header.id : null
      continue
    }
    result.eventCount += 1
    events.push(parsed)
  }
  const bySeq = new Map()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const seq = Number.isSafeInteger(event?.seq) && event.seq >= 0 ? event.seq : index
    bySeq.set(seq, event)
  }
  // Replay the host surface fold: append pushes a node, replace swaps an
  // inclusive surface span for the new node.
  const nodes = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const op = event?.surfaceOp
    if (op === undefined) continue
    const seq = Number.isSafeInteger(event?.seq) && event.seq >= 0 ? event.seq : index
    if (op === 'append') {
      nodes.push(seq)
      continue
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace' || !Number.isSafeInteger(op.startSeq) || !Number.isSafeInteger(op.endSeq)) {
      result.replayIssues.push({ seq, reason: 'invalid surfaceOp value' })
      continue
    }
    const startIndex = nodes.indexOf(op.startSeq)
    const endIndex = nodes.indexOf(op.endSeq)
    if (startIndex === -1 || endIndex < startIndex) {
      result.replayIssues.push({ seq, reason: `replace range ${op.startSeq}..${op.endSeq} does not match the current surface` })
      continue
    }
    nodes.splice(startIndex, endIndex - startIndex + 1, seq)
  }
  result.surfaceNodes = nodes.length
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (!event) {
      result.replayIssues.push({ seq, reason: 'surface node has no event in the log' })
      continue
    }
    const message = eventMessage(event)
    if (!message || message.source?.kind !== 'compact-checkpoint') continue
    const noteText = messageText(message.content)
    const match = ARCHIVE_NOTE_RE.exec(noteText)
    if (!match) {
      // A checkpoint written by another compressor: counted, never judged.
      result.foreignCheckpoints += 1
      continue
    }
    const appendix = noteAppendix(noteText)
    result.notes.push({
      seq,
      segments: Number.parseInt(match[1], 10),
      chars: noteText.length,
      hasAppendix: appendix.length > 0,
      markers: EXCLUDED_APPENDIX_MARKERS.filter((marker) => appendix.includes(marker)),
    })
    result.noteCount += 1
  }
  return result
}

/** Candidate session ids of one log (header id, directory name, ±`session-`). */
function sessionIdCandidates(headerId, file) {
  const candidates = new Set()
  const folder = path.basename(path.dirname(file))
  for (const raw of [headerId, folder]) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
    candidates.add(raw)
    candidates.add(bare)
    candidates.add(`session-${bare}`)
  }
  return candidates
}

/** Run the session-log checkpoint-note check (own surfaceOp replay, own note parser). */
async function checkSessionLogs(report, options) {
  const sessionsDir = options.sessionsDir
  const data = {
    sessionsDir,
    sessionId: options.sessionId,
    maxSessions: options.maxSessions,
    totalLogs: 0,
    scanned: 0,
    notes: 0,
    sessionsWithNotes: 0,
    foreignCheckpoints: 0,
    sessions: [],
    issues: [],
  }
  const issues = new IssueLog()
  if (!isDirectory(sessionsDir)) {
    addCheck(report, 'session logs', 'WARN', `sessions dir not found: ${sessionsDir} (nothing to verify)`, data)
    return
  }
  let logs = findSessionLogs(sessionsDir)
  data.totalLogs = logs.length
  if (logs.length === 0) {
    addCheck(report, 'session logs', 'WARN', `no session logs found under ${sessionsDir}`, data)
    return
  }
  logs = logs.filter((file) => isFile(file))
  logs.sort((left, right) => {
    let leftTime = 0
    let rightTime = 0
    try {
      leftTime = fs.statSync(left).mtimeMs
    } catch {
      leftTime = 0
    }
    try {
      rightTime = fs.statSync(right).mtimeMs
    } catch {
      rightTime = 0
    }
    return rightTime - leftTime
  })

  let selected = logs
  if (options.sessionId) {
    const wanted = options.sessionId
    selected = []
    for (const file of logs) {
      const header = await readSessionHeader(file)
      const candidates = sessionIdCandidates(header?.id, file)
      if (candidates.has(wanted)) selected.push(file)
    }
    if (selected.length === 0) {
      issues.warn('session-not-found', `session ${JSON.stringify(wanted)} not found among ${logs.length} log(s)`)
    }
  } else if (options.maxSessions > 0) {
    selected = logs.slice(0, options.maxSessions)
  }

  for (const file of selected) {
    data.scanned += 1
    let text
    try {
      text = await decodeSessionLog(file)
    } catch (error) {
      issues.warn('session-log-decode', `${path.basename(path.dirname(file))}: cannot decode session log (${error.message})`)
      continue
    }
    let analysis
    try {
      analysis = analyzeSessionLog(file, text)
    } catch (error) {
      issues.warn('session-log-analyze', `${path.basename(path.dirname(file))}: cannot replay session log (${error.message})`)
      continue
    }
    const label = analysis.sessionId ?? path.basename(path.dirname(file))
    data.notes += analysis.noteCount
    data.foreignCheckpoints += analysis.foreignCheckpoints
    if (analysis.noteCount > 0) data.sessionsWithNotes += 1
    if (analysis.badLines > 0) {
      issues.warn('session-log-bad-line', `${label}: ${analysis.badLines} unparsable event line(s) ignored`)
    }
    for (const replayIssue of analysis.replayIssues) {
      issues.warn('session-log-replay', `${label}: surface replays diverge at seq ${replayIssue.seq} (${replayIssue.reason})`)
    }
    // One note after the latest archive is the v1.2.0 invariant; more than one
    // is pre-1.2.0 residue (the merge landed in 1.2.0), so it is a WARN.
    const legacySession = analysis.noteCount > 1
    if (legacySession) {
      issues.warn(
        'session-log-multiple-notes',
        `${label}: ${analysis.noteCount} dsh-rofm checkpoint notes remain on the final surface (seqs ${analysis.notes.map((note) => note.seq).join(', ')}) — legacy from before note merging`,
      )
    }
    for (const note of analysis.notes) {
      if (!Number.isInteger(note.segments) || note.segments < 1) {
        issues.fail('session-log-note-segments', `${label}: checkpoint note at seq ${note.seq} has non-positive segment count ${JSON.stringify(note.segments)}`)
        continue
      }
      if (note.markers.length === 0) continue
      if (legacySession) {
        // A session that still carries several notes provably predates the R3
        // merge: its appendix content is historical, not a current violation.
        issues.warn(
          'session-log-legacy-appendix',
          `${label}: legacy checkpoint note at seq ${note.seq} has re-injected context in its appendix (${note.markers.join(', ')})`,
        )
      } else {
        issues.fail(
          'session-log-appendix-excluded',
          `${label}: checkpoint note at seq ${note.seq} copied re-injected infrastructure into its appendix (${note.markers.join(', ')})`,
        )
      }
    }
    data.sessions.push({
      file: path.relative(sessionsDir, file),
      sessionId: analysis.sessionId,
      events: analysis.eventCount,
      surfaceNodes: analysis.surfaceNodes,
      notes: analysis.notes,
      foreignCheckpoints: analysis.foreignCheckpoints,
    })
  }

  data.issues = issues.items
  data.issueTotal = issues.total
  const capped =
    !options.sessionId && options.maxSessions > 0 && logs.length > options.maxSessions
      ? `${data.scanned} of ${logs.length} log(s) scanned (newest first; use --max-sessions 0 for all)`
      : `${data.scanned} log(s) scanned`
  const summary =
    `${capped}; ${data.notes} dsh-rofm checkpoint note(s) in ${data.sessionsWithNotes} session(s); ` +
    `${data.foreignCheckpoints} foreign checkpoint(s) ignored`
  if (issues.failed > 0) {
    addCheck(report, 'session logs', 'FAIL', `${issues.failed} problem(s): ${summarizeIssues(issues)}; ${summary}`, data)
  } else if (issues.warned > 0) {
    addCheck(report, 'session logs', 'WARN', `${issues.warned} legacy warning(s): ${summarizeIssues(issues)}; ${summary}`, data)
  } else {
    addCheck(report, 'session logs', 'PASS', summary, data)
  }
}

// ---------------------------------------------------------------------------
// check 6 — optional test suite
// ---------------------------------------------------------------------------

/** Run `node --test` in the repository (only with `--with-tests`). */
function checkTestSuite(report) {
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, ['--test'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: TEST_SUITE_TIMEOUT_MS,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  })
  const durationMs = Date.now() - startedAt
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const passedMatch = /^(?:# |ℹ )pass (\d+)/m.exec(output)
  const failedMatch = /^(?:# |ℹ )fail (\d+)/m.exec(output)
  const data = {
    durationMs,
    passed: passedMatch ? Number(passedMatch[1]) : null,
    failed: failedMatch ? Number(failedMatch[1]) : null,
    exitCode: result.status,
  }
  if (result.error && result.error.code === 'ETIMEDOUT') {
    addCheck(report, 'test suite', 'FAIL', `node --test did not finish within ${Math.round(TEST_SUITE_TIMEOUT_MS / 1000)}s`, data)
    return
  }
  if (result.error) {
    addCheck(report, 'test suite', 'FAIL', `node --test could not be started: ${result.error.message}`, data)
    return
  }
  if (result.status === 0) {
    const counts = data.passed === null ? '' : ` (${data.passed} passed, ${data.failed ?? 0} failed)`
    addCheck(report, 'test suite', 'PASS', `node --test passed${counts} in ${(durationMs / 1000).toFixed(1)}s`, data)
    return
  }
  const tail = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-6)
    .join(' | ')
  addCheck(report, 'test suite', 'FAIL', `node --test exited with code ${result.status}${data.failed === null ? '' : ` (${data.failed} failing)`}: ${oneLine(tail, 500)}`, data)
}

// ---------------------------------------------------------------------------
// orchestration + rendering
// ---------------------------------------------------------------------------

/** Read the plugin version (best effort). */
function pluginVersion() {
  const parsed = readJsonFile(path.join(REPO_ROOT, 'package.json'))
  return parsed.ok && typeof parsed.value?.version === 'string' ? parsed.value.version : null
}

/**
 * Run every check and return the machine-readable result object.
 * @param {{json?:boolean, memoryDir?:string|null, sessionsDir?:string|null,
 *   sessionId?:string|null, maxSessions?:number, withTests?:boolean}} [options]
 */
export async function runSelfCheck(options = {}) {
  const memoryDir = path.resolve(options.memoryDir ?? path.join(REPO_ROOT, 'memory'))
  const sessionsDir = path.resolve(options.sessionsDir ?? defaultSessionsDir())
  const startedAt = Date.now()
  const report = newReport()
  const configResult = await checkConfig(report)
  await checkEngine(report, configResult.configModule)
  const memory = inspectMemory(memoryDir)
  checkMemoryStore(report, memory)
  checkRecallState(report, memory)
  await checkSessionLogs(report, {
    sessionsDir,
    sessionId: options.sessionId ?? null,
    maxSessions: Number.isInteger(options.maxSessions) ? options.maxSessions : DEFAULT_MAX_SESSIONS,
  })
  if (options.withTests === true) checkTestSuite(report)
  const summary = { passed: 0, warnings: 0, failed: 0 }
  for (const check of report.checks) {
    if (check.status === 'PASS') summary.passed += 1
    else if (check.status === 'WARN') summary.warnings += 1
    else summary.failed += 1
  }
  const exitCode = summary.failed > 0 ? 1 : 0
  const result = {
    tool: 'dsh-rofm-selfcheck',
    version: pluginVersion(),
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    repoRoot: REPO_ROOT,
    memoryDir,
    sessionsDir,
    checks: report.checks,
    summary,
    exitCode,
  }
  return result
}

/** Render the human-readable check lines. */
function renderHuman(result) {
  const lines = result.checks.map((check) => `[${check.status}] ${check.name} — ${check.detail}`)
  lines.push(`selfcheck: ${result.summary.passed} passed, ${result.summary.warnings} warnings, ${result.summary.failed} failed`)
  return lines
}

/**
 * CLI entry point.
 * @param {string[]} [argv] arguments after the script path
 * @returns {Promise<number>} process exit code (0 = no FAIL, 1 = FAIL, 2 = usage)
 */
export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`selfcheck: ${error.message}`)
      console.error('Run `node tools/selfcheck.mjs --help` for usage.')
      return 2
    }
    throw error
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const result = await runSelfCheck(options)
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const line of renderHuman(result)) console.log(line)
  }
  return result.exitCode
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`selfcheck: unexpected failure: ${error && error.stack ? error.stack : error}`)
      process.exitCode = 1
    },
  )
}
