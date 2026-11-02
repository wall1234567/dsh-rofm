#!/usr/bin/env node
/**
 * dsh-rofm — memory data-era audit tool (v1.4.0; plan §2.2/§3.4, contract §5.9).
 *
 * Answers one question without touching the store: how much of the archived
 * memory is still waiting for a judgement (`scored:false`), and is that backlog
 * *current real work* or residue from an earlier version / a stress test?
 *
 * The era rules themselves live in `engine/era.js` (one shared truth also used
 * by `lib/plugin.js`, `tools/selfcheck.mjs` and `tools/recall-report.mjs`); this
 * tool only reads the store and renders the numbers:
 *
 *   legacy    — per-folder: `createdAt < 2026-10-27T19:14:00Z` (v1.2.0 tag,
 *               = 2026-10-28 03:14 +08). Pre-1.2.0 sessions archived without the
 *               "this round must be judged" instruction; only marked, never
 *               re-judged (plan §9.3 Q6). An explicit `pendingEra` mark written
 *               by `--apply` wins over the timestamp (engine/era.js).
 *   synthetic — per-session: `fakeWindow && stressBacklog`, where fakeWindow means
 *               the session telemetry recorded `windowTokens < 32000` or
 *               `beforePercent > 500`, and stressBacklog means the session
 *               archived 100+ folders or left 100+ pending. Both signals are
 *               required: the fake window alone would mislabel a legitimate QQ
 *               channel session (qqb-g: 2000-token channel window, 10 folders /
 *               2 pending → current), and volume alone would mislabel a normal
 *               1M-window session (b5eeee7e: 359 folders, real window).
 *   current   — everything else. Its pending folders are the "current real
 *               pending" number (2/369 = 0.54% on the 2026-11-01 snapshot).
 *
 * Default is strictly READ-ONLY: no file is created, modified or deleted.
 * `--apply` writes exactly one optional field (`pendingEra`) into each
 * `index.json` folder entry. It never touches `meta.json`, `scored`, `alpha`,
 * `keywords`, `createdAt`, the index timestamps or any telemetry, and never
 * re-judges anything.
 *
 *   node tools/memory-audit.mjs [--memory <dir>] [--json] [--verbose]
 *                               [--limit N] [--apply] [--help]
 *
 * Output is Chinese (the plugin's user-facing language); identifiers and JSON
 * keys stay ASCII.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LEGACY_ERA_CUTOFF_MS,
  STRESS_MIN_FOLDERS,
  STRESS_MIN_PENDING,
  SYNTHETIC_BEFORE_PERCENT,
  SYNTHETIC_WINDOW_TOKENS,
  classifyFolderEra,
  sessionEra,
  sessionEraSignals,
  summarizeEras,
} from '../engine/era.js'
import { buildEventIndex } from '../engine/event-index.js'
import { invokedAsMain } from './main-module.mjs'

const TOOL_FILE = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(TOOL_FILE), '..')
const DEFAULT_MEMORY_DIR = path.join(REPO_ROOT, 'memory')

/** The v1.2.0 tag boundary, re-exported under the name the reports use. */
export const LEGACY_BOUNDARY_MS = LEGACY_ERA_CUTOFF_MS
export const LEGACY_BOUNDARY_ISO = new Date(LEGACY_ERA_CUTOFF_MS).toISOString()

/**
 * v1.3.0 tag = 2026-10-31 21:46 (+08) = 2026-10-31T13:46:00Z. Sessions whose
 * oldest folder is not older than this are "normal 1.3.0+ sessions" (caliber D,
 * e.g. b5eeee7e 359/359 scored).
 */
export const NORMAL_SESSION_BOUNDARY_MS = Date.parse('2026-10-31T13:46:00Z')
export const NORMAL_SESSION_BOUNDARY_ISO = new Date(NORMAL_SESSION_BOUNDARY_MS).toISOString()

/** The three eras, in report order. */
export const ERAS = Object.freeze(['legacy', 'synthetic', 'current'])

// The era rules are imported from engine/era.js and re-exported here so every
// tool/test can reach them through the audit tool as well (no second truth).
export {
  LEGACY_ERA_CUTOFF_MS,
  STRESS_MIN_FOLDERS,
  STRESS_MIN_PENDING,
  SYNTHETIC_BEFORE_PERCENT,
  SYNTHETIC_WINDOW_TOKENS,
  classifyFolderEra,
  sessionEra,
  sessionEraSignals,
  summarizeEras,
}

const DEFAULT_SAMPLE_LIMIT = 10
/** Cap for the echoed current-pending id list (keeps the JSON bounded). */
const CURRENT_PENDING_LIMIT = 100

const USAGE = `dsh-rofm 记忆时代审计工具（零依赖，默认只读）

用法:
  node tools/memory-audit.mjs [选项]

选项:
  --memory <dir>   要审计的记忆根目录（默认：仓库内 memory/）。支持 per-session
                   布局（memory/sessions/<session-id>/ 各带 index.json）与单库
                   布局（<dir>/index.json 直接是该会话的索引）。
  --json           输出一个机器可读 JSON 对象（stdout 只有 JSON，stderr 保留 hint）
  --verbose        附带明细：人类可读模式列出 legacy/synthetic 的前 N 条 folder
                   id；--json 模式附带 samples 数组
  --limit <N>      明细条数上限（默认 ${DEFAULT_SAMPLE_LIMIT}，非负整数）
  --apply          在 index.json 的每个 folder 条目写 pendingEra 标记
                   （'legacy'|'synthetic'|'current'）。只写这一个可选字段：不动
                   meta.json / scored / alpha / keywords / createdAt / 遥测，
                   不重评、不删除任何东西。默认只读，不写任何文件。
                   写真实 memory/ 前请先得到维护者批准。
  -h, --help       显示本帮助并退出 0

时代判定（唯一真相：engine/era.js；计划书 §2.2、§9.2；契约 §5.9）:
  legacy    按 folder 判定：createdAt < ${LEGACY_BOUNDARY_ISO}
            （v1.2.0 tag = 2026-10-28 03:14 +08）→ pre-1.2.0 早期遗留，
            只标记不回补。若 index 里已有 pendingEra 标记，标记优先。
  synthetic 按会话判定：fakeWindow && stressBacklog
            · fakeWindow     = 会话 stats.jsonl 的 compress / compress-applied /
                               archive 事件里 windowTokens < 32000 或
                               beforePercent > 500%；
            · stressBacklog  = folders >= 100 或 pending >= 100。
            两者缺一不可 → 1.2-1.3 压测遗留，只标记不回补。
  current   其余会话。其中 pending 是"当前真实待评分"口径。
            注：QQ 通道的 2000 假窗口属于通道契约而非压测（qqb-g：10 folders /
            2 pending 达不到压测级），所以它计入 current —— 审计输出会写明
            fakeWindow=true / stressBacklog=false，这 2 条 pending 正是当前真实
            待评分。空会话（0 folder）不计入任何桶，但 sessions 计数仍保留。

输出字段（--json，供审计；两个时代视图**不合并**）:
  每个 session 同时给 era 与 dominantEra：
  · era         = 会话级时代（engine/era.js sessionEra）：'synthetic' | 'current'；
  · dominantEra = folder 桶时代（legacy | synthetic | current）——legacy 是
                  folder 级属性（createdAt 或已有 pendingEra 标记），所以
                  pre-1.2.0 会话会出现 era=current + dominantEra=legacy；
  · reasons / inconsistentMarks 保留：已写入的 pendingEra 标记会被信任，
    与"重新判定"不一致的标记数量记在 inconsistentMarks（--apply 可刷新）。
  顶层 buckets 的 folders 是 folder 总数，pending 才是待评分数量，不要混用。
  顶层 events = v1.4.0 事件标签统计：foldersWithEvent（带 event 标签的 folder 数）、
  distinctEvents（不同事件数）、top（前 5 个 {label,count}）；只读，不参与过滤。

口径（与计划书 §2.2 / §9.2 一致，输出会自动计算）:
  A 全库存量 pending 比例（仅描述现状）；
  B 排除 pre-1.2.0 遗留；
  C 排除遗留 + 压测 = 当前真实待评分（本机 2026-11-01 快照 = 2/369 = 0.54%）；
  D 1.3.0 tag 之后正常会话的 pending 比例（b5eeee7e = 0/359 = 0%）。

示例:
  node tools/memory-audit.mjs                       # 人类可读表格（只读）
  node tools/memory-audit.mjs --json                # 机器可读（只读）
  node tools/memory-audit.mjs --verbose --limit 20  # 附带明细（只读）
  node tools/memory-audit.mjs --memory /tmp/mem --apply   # 只对临时数据跑！
`

// ---------------------------------------------------------------------------
// small helpers (never throw on bad files, like the other tools)
// ---------------------------------------------------------------------------

/** Round to 2 decimals without -0. */
function round2(value) {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Format one percentage for the human table: 74.0%, 0.54%, 100%. */
function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a'
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)}%`
}

/** ISO text of an epoch-ms value ('' when not a finite number). */
function isoText(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : ''
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Read + parse one JSON file: { ok, value, error }. */
function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null }
  } catch (error) {
    return { ok: false, value: undefined, error }
  }
}

/** Read one stats.jsonl as an event array (corrupt lines ignored, never throws). */
function readStatsEvents(file) {
  if (!isFile(file)) return []
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed)
    } catch {
      /* best effort: a corrupt telemetry line must not hide the rest */
    }
  }
  return events
}

/** Plugin version from package.json (best effort). */
function pluginVersion() {
  const parsed = readJsonFile(path.join(REPO_ROOT, 'package.json'))
  return parsed.ok && typeof parsed.value?.version === 'string' ? parsed.value.version : null
}

/** Atomic compact-JSON write (same convention as engine/store.js). */
function writeJsonAtomic(filePath, value) {
  const data = JSON.stringify(value)
  if (data === undefined) throw new TypeError(`value for ${filePath} is not JSON serializable`)
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  try {
    fs.writeFileSync(tmp, data, 'utf8')
    fs.renameSync(tmp, filePath)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw error
  }
  return filePath
}

function emptyCounts() {
  return { folders: 0, scored: 0, pending: 0 }
}

// ---------------------------------------------------------------------------
// era classification wrapper (engine/era.js is the only truth)
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper: classify one store/session by era.
 *
 * `legacy` is a per-folder property, so a session-level result is only
 * `synthetic` or `current`; use `summarizeEras` / `classifyFolderEra` for the
 * per-folder buckets. Accepted descriptor: `{ events, folders, pending }`
 * (`folders` may be an entry array or a count), or a bare stats event array.
 *
 * @param {{events?: object[], statsEvents?: object[], folders?: object[]|number, pending?: number}|object[]} [store]
 * @returns {ReturnType<typeof sessionEra>}
 */
export function classifyEra(store = {}) {
  const input = store && typeof store === 'object' && !Array.isArray(store) ? store : {}
  const events = Array.isArray(store)
    ? store
    : Array.isArray(input.events)
      ? input.events
      : Array.isArray(input.statsEvents)
        ? input.statsEvents
        : []
  let folderCount = 0
  if (Array.isArray(input.folders)) folderCount = input.folders.length
  else if (Number.isFinite(input.folders)) folderCount = Math.max(0, Math.trunc(input.folders))
  let pending = Number.isFinite(input.pending) ? Math.max(0, Math.trunc(input.pending)) : 0
  if (!Number.isFinite(input.pending) && Array.isArray(input.folders)) {
    pending = input.folders.filter((entry) => entry && entry.scored === false).length
  }
  return sessionEra({ folders: folderCount, pending, signals: sessionEraSignals(events) })
}

// ---------------------------------------------------------------------------
// store discovery
// ---------------------------------------------------------------------------

/**
 * Locate every memory store under `memoryDir`.
 *
 * A store is a directory that carries an `index.json`:
 *   - single-store layout: `<memoryDir>/index.json` (also what `--memory`
 *     pointing directly at one session directory produces);
 *   - per-session layout: `<memoryDir>/sessions/<session-id>/index.json`.
 *
 * @param {string} memoryDir
 * @returns {Array<{dir: string, layout: 'single'|'per-session'}>}
 */
export function findStores(memoryDir) {
  const stores = []
  if (!isDirectory(memoryDir)) return stores
  if (isFile(path.join(memoryDir, 'index.json'))) return [{ dir: memoryDir, layout: 'single' }]
  const sessionsRoot = path.join(memoryDir, 'sessions')
  if (!isDirectory(sessionsRoot)) return stores
  let entries = []
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return stores
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(sessionsRoot, entry.name)
    if (isFile(path.join(dir, 'index.json'))) stores.push({ dir, layout: 'per-session' })
  }
  stores.sort((left, right) => (left.dir < right.dir ? -1 : left.dir > right.dir ? 1 : 0))
  return stores
}

// ---------------------------------------------------------------------------
// one store / whole memory audit (read-only)
// ---------------------------------------------------------------------------

/**
 * Audit one store directory (index.json + stats.jsonl) — never writes anything.
 *
 * `era` is the session-level era from engine/era.js (`synthetic`|`current`);
 * `dominantEra` is the folder bucket with the most entries (that is what the
 * human table shows, and what plan §2.2's per-session table means when it labels
 * a whole session "pre-1.2.0 legacy").
 *
 * @param {string} storeDir
 * @param {{layout?: string, sampleLimit?: number}} [options]
 */
export function auditStore(storeDir, options = {}) {
  const sampleLimit = Number.isInteger(options.sampleLimit) && options.sampleLimit > 0 ? options.sampleLimit : 0
  const result = {
    dir: storeDir,
    session: path.basename(storeDir),
    layout: options.layout === 'per-session' ? 'per-session' : 'single',
    indexOk: false,
    indexError: null,
    folders: 0,
    scored: 0,
    pending: 0,
    invalidEntries: 0,
    buckets: { legacy: emptyCounts(), synthetic: emptyCounts(), current: emptyCounts() },
    era: 'current',
    dominantEra: 'current',
    eraReason: '',
    reasons: sessionEra({}).reasons,
    currentPending: [],
    createdAt: { min: null, max: null },
    normalSession: false,
    empty: false,
    mixed: false,
    markedPendingEra: 0,
    inconsistentMarks: 0,
    // event-tag counters of this store (aggregated into `auditMemory().events`).
    eventFolders: 0,
    eventLabels: [],
    samples: sampleLimit > 0 ? { legacy: [], synthetic: [], current: [] } : null,
  }
  const parsedIndex = readJsonFile(path.join(storeDir, 'index.json'))
  if (!parsedIndex.ok) {
    result.indexError =
      parsedIndex.error && parsedIndex.error.code === 'ENOENT'
        ? 'index.json 不存在'
        : `index.json 不是合法 JSON（${parsedIndex.error?.message ?? 'unknown'}）`
    return result
  }
  const index = parsedIndex.value
  if (!index || typeof index !== 'object' || !Array.isArray(index.folders)) {
    result.indexError = 'index.json 没有 folders 数组'
    return result
  }
  result.indexOk = true
  const folders = index.folders.filter((entry) => entry && typeof entry === 'object')

  let pending = 0
  for (const entry of folders) if (entry.scored === false) pending += 1
  const signals = sessionEraSignals(readStatsEvents(path.join(storeDir, 'stats.jsonl')))
  const session = sessionEra({ folders: folders.length, pending, signals })
  const summary = summarizeEras(folders, session)

  result.era = session.era
  result.reasons = session.reasons
  result.folders = summary.total
  result.invalidEntries = folders.length - summary.total
  result.pending = summary.pending.legacy + summary.pending.current + summary.pending.synthetic
  result.scored = summary.total - result.pending
  result.currentPending = Array.isArray(summary.pendingFolders) ? summary.pendingFolders.slice(0, CURRENT_PENDING_LIMIT) : []
  for (const era of ERAS) {
    result.buckets[era].folders = summary.folders[era]
    result.buckets[era].scored = summary.scored[era]
    result.buckets[era].pending = summary.pending[era]
  }

  let minCreatedAt = null
  let maxCreatedAt = null
  for (const entry of folders) {
    const era = classifyFolderEra(entry, session)
    // The fresh (mark-free) classification tells us whether an existing
    // pendingEra mark is stale — classifyFolderEra itself always trusts marks.
    const freshEra = classifyFolderEra({ ...entry, pendingEra: undefined }, session)
    const createdAt = typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : null
    if (createdAt !== null) {
      minCreatedAt = minCreatedAt === null ? createdAt : Math.min(minCreatedAt, createdAt)
      maxCreatedAt = maxCreatedAt === null ? createdAt : Math.max(maxCreatedAt, createdAt)
    }
    if (entry.pendingEra !== undefined) {
      result.markedPendingEra += 1
      if (entry.pendingEra !== freshEra) result.inconsistentMarks += 1
    }
    if (result.samples && result.samples[era].length < sampleLimit) {
      result.samples[era].push({
        id: typeof entry.id === 'string' ? entry.id : null,
        session: result.session,
        createdAt,
        scored: entry.scored !== false,
        era,
      })
    }
  }

  result.createdAt = { min: minCreatedAt, max: maxCreatedAt }
  result.empty = summary.total === 0
  const nonEmptyEras = ERAS.filter((era) => result.buckets[era].folders > 0)
  result.mixed = nonEmptyEras.length > 1
  result.dominantEra = result.empty
    ? session.era
    : nonEmptyEras.reduce(
        (best, era) => (result.buckets[era].folders > result.buckets[best].folders ? era : best),
        nonEmptyEras[0],
      )
  result.eraReason = result.empty
    ? '0 folder'
    : explainStoreEra(session.era, result.dominantEra, result.reasons, result.buckets)
  result.normalSession =
    !result.empty && session.era === 'current' && minCreatedAt !== null && minCreatedAt >= NORMAL_SESSION_BOUNDARY_MS
  // v1.4.0 event constraint: optional `event` label per folder (already mirrored
  // into index.folders by engine/store.js). Audit-only aggregate, never a filter.
  const eventIndex = buildEventIndex(folders, {})
  result.eventFolders = eventIndex.byId.size
  result.eventLabels = eventIndex.labels.map((bucket) => ({ label: bucket.label, key: bucket.key, count: bucket.count }))
  return result
}

/**
 * One readable explanation of a store's era decision (JSON `eraReason`).
 * @param {'synthetic'|'current'} era session era from engine/era.js
 * @param {'legacy'|'synthetic'|'current'} dominantEra largest folder bucket
 * @param {{fakeWindow: boolean, stressBacklog: boolean, folders: number, pending: number}} reasons
 * @param {{legacy: object, synthetic: object, current: object}} buckets
 */
function explainStoreEra(era, dominantEra, reasons, buckets) {
  const sessionText =
    era === 'synthetic'
      ? `sessionEra=synthetic（fakeWindow=true + stressBacklog=true；folders ${reasons.folders} / pending ${reasons.pending}）`
      : `sessionEra=current（fakeWindow=${reasons.fakeWindow}, stressBacklog=${reasons.stressBacklog}；folders ${reasons.folders} / pending ${reasons.pending}）`
  const folderText = `folder 时代：legacy ${buckets.legacy.folders} / synthetic ${buckets.synthetic.folders} / current ${buckets.current.folders}`
  const legacyText =
    dominantEra === 'legacy'
      ? `；多数 folder createdAt < ${LEGACY_BOUNDARY_ISO}（pre-1.2.0 遗留）`
      : ''
  return `${sessionText}；${folderText}${legacyText}`
}

// ---------------------------------------------------------------------------
// whole memory root
// ---------------------------------------------------------------------------

/** Add one counts object into another (in place). */
function addCounts(target, source) {
  target.folders += source.folders
  target.scored += source.scored
  target.pending += source.pending
  return target
}

/** Percentage fields of one counts object (pending% of folders, share of all pending). */
function percentFields(counts, totalFolders, totalPending) {
  return {
    pendingPercent: counts.folders > 0 ? round2((counts.pending / counts.folders) * 100) : 0,
    folderSharePercent: totalFolders > 0 ? round2((counts.folders / totalFolders) * 100) : 0,
    pendingSharePercent: totalPending > 0 ? round2((counts.pending / totalPending) * 100) : 0,
  }
}

/** One documented caliber (A/B/C/D) as a flat object. */
function makeCaliber(id, description, counts, extra = {}) {
  return {
    id,
    description,
    folders: counts.folders,
    scored: counts.scored,
    pending: counts.pending,
    pendingPercent: counts.folders > 0 ? round2((counts.pending / counts.folders) * 100) : 0,
    ...extra,
  }
}

/**
 * Audit a whole memory root (read-only unless `options.apply === true`).
 *
 * Empty session directories (0 folders) are skipped from the `sessions` detail
 * but still counted in `totals.stores` / `totals.sessions` so the layout stays
 * visible (the real store has 15 such leftovers from onebot-* sessions).
 *
 * @param {string} memoryDir
 * @param {{apply?: boolean, sampleLimit?: number}} [options]
 */
export function auditMemory(memoryDir, options = {}) {
  const startedAt = Date.now()
  const sampleLimit = Number.isInteger(options.sampleLimit) && options.sampleLimit > 0 ? options.sampleLimit : 0
  const result = {
    tool: 'dsh-rofm-memory-audit',
    version: pluginVersion(),
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    memoryDir,
    readOnly: options.apply !== true,
    layout: 'none',
    eraRules: 'engine/era.js',
    boundaries: {
      legacyCutoff: LEGACY_BOUNDARY_ISO,
      legacyCutoffMs: LEGACY_BOUNDARY_MS,
      syntheticWindowTokens: SYNTHETIC_WINDOW_TOKENS,
      syntheticBeforePercent: SYNTHETIC_BEFORE_PERCENT,
      stressMinFolders: STRESS_MIN_FOLDERS,
      stressMinPending: STRESS_MIN_PENDING,
      normalSessionsSince: NORMAL_SESSION_BOUNDARY_ISO,
      rule: 'legacy 按 folder（createdAt 或被已有 pendingEra 标记）；synthetic = fakeWindow && stressBacklog；其余 current',
    },
    totals: { folders: 0, scored: 0, pending: 0, pendingPercent: 0, currentPendingPercent: 0, stores: 0, sessions: 0 },
    buckets: { legacy: emptyCounts(), synthetic: emptyCounts(), current: emptyCounts() },
    // v1.4.0 event constraint observability (optional `event` labels; read-only).
    events: { foldersWithEvent: 0, distinctEvents: 0, top: [] },
    calibers: {},
    sessions: [],
    currentPending: [],
    warnings: [],
    sampleLimit,
    samples: sampleLimit > 0 ? { legacy: [], synthetic: [], current: [] } : null,
    apply: null,
  }
  if (isFile(path.join(memoryDir, 'index.json'))) result.layout = 'single'
  else if (isDirectory(path.join(memoryDir, 'sessions'))) result.layout = 'per-session'
  /** v1.4.0 event labels merged across stores: normalised key → { label, count }. */
  const eventTotals = new Map()
  let eventFolders = 0

  if (!isDirectory(memoryDir)) {
    result.warnings.push(`memory 目录不存在：${memoryDir}（没有已归档记忆，按 0 计）`)
  } else {
    const stores = findStores(memoryDir)
    result.totals.stores = stores.length
    if (stores.length === 0) {
      result.warnings.push(`没有在 ${memoryDir} 下找到带 index.json 的 store（尚未归档任何记忆）`)
    }
    for (const store of stores) {
      const audit = auditStore(store.dir, { layout: store.layout, sampleLimit })
      const dirLabel = (path.relative(memoryDir, store.dir) || '.').split(path.sep).join('/')
      if (!audit.indexOk) {
        result.warnings.push(`${dirLabel}: ${audit.indexError}，该 store 未计入统计`)
        continue
      }
      // Empty leftovers (0 folders) never enter a bucket; they are not reported
      // as sessions either, only through the totals.stores counter.
      if (audit.empty) continue
      result.totals.sessions += 1
      result.sessions.push({
        session: audit.session,
        dir: dirLabel,
        layout: store.layout,
        era: audit.era,
        dominantEra: audit.dominantEra,
        eraReason: audit.eraReason,
        folders: audit.folders,
        scored: audit.scored,
        pending: audit.pending,
        buckets: audit.buckets,
        reasons: {
          fakeWindow: audit.reasons.fakeWindow,
          tinyWindow: audit.reasons.tinyWindow,
          overWindow: audit.reasons.overWindow,
          windowTokens: audit.reasons.windowTokens,
          maxBeforePercent: audit.reasons.maxBeforePercent,
          folders: audit.reasons.folders,
          pending: audit.reasons.pending,
          stressBacklog: audit.reasons.stressBacklog,
        },
        currentPending: audit.currentPending,
        mixed: audit.mixed,
        createdAt: audit.createdAt,
        normalSession: audit.normalSession,
        markedPendingEra: audit.markedPendingEra,
        inconsistentMarks: audit.inconsistentMarks,
        invalidEntries: audit.invalidEntries,
      })
      result.totals.folders += audit.folders
      result.totals.scored += audit.scored
      result.totals.pending += audit.pending
      for (const era of ERAS) addCounts(result.buckets[era], audit.buckets[era])
      if (audit.invalidEntries > 0) {
        result.warnings.push(`${dirLabel}: ${audit.invalidEntries} 个 index 条目缺少合法 id，未计入统计`)
      }
      if (audit.inconsistentMarks > 0) {
        result.warnings.push(`${dirLabel}: ${audit.inconsistentMarks} 个 folder 的 pendingEra 标记与当前判定不一致（可 --apply 刷新）`)
      }
      if (result.samples && audit.samples) {
        for (const era of ERAS) {
          for (const sample of audit.samples[era]) {
            if (result.samples[era].length < sampleLimit) result.samples[era].push({ ...sample, session: audit.session })
          }
        }
      }
      eventFolders += audit.eventFolders
      for (const bucket of audit.eventLabels) {
        const existing = eventTotals.get(bucket.key)
        if (existing) existing.count += bucket.count
        else eventTotals.set(bucket.key, { label: bucket.label, count: bucket.count })
      }
    }
  }

  // v1.4.0 event tag summary: folders carrying an optional event label, the
  // distinct event count and the top 5 events (by folder count). Read-only.
  const topEvents = [...eventTotals.values()]
    .sort((left, right) => right.count - left.count || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0))
    .slice(0, 5)
    .map((event) => ({ label: event.label, count: event.count }))
  result.events = { foldersWithEvent: eventFolders, distinctEvents: eventTotals.size, top: topEvents }

  // Human order: legacy folders first, then synthetic, then current; biggest first.
  const eraRank = { legacy: 0, synthetic: 1, current: 2 }
  result.sessions.sort(
    (left, right) =>
      (eraRank[left.dominantEra] ?? 3) - (eraRank[right.dominantEra] ?? 3) ||
      right.folders - left.folders ||
      (left.session < right.session ? -1 : left.session > right.session ? 1 : 0),
  )

  const totalFolders = result.totals.folders
  const totalPending = result.totals.pending
  result.totals.pendingPercent = totalFolders > 0 ? round2((totalPending / totalFolders) * 100) : 0
  result.totals.currentPendingPercent =
    result.buckets.current.folders > 0 ? round2((result.buckets.current.pending / result.buckets.current.folders) * 100) : 0
  for (const era of ERAS) {
    const counts = result.buckets[era]
    Object.assign(counts, percentFields(counts, totalFolders, totalPending))
  }
  // Caliber A = whole stock; B = exclude pre-1.2.0 legacy; C = current real
  // pending (exclude legacy + stress test); D = normal sessions since v1.3.0.
  const excludeLegacy = {
    folders: totalFolders - result.buckets.legacy.folders,
    scored: result.totals.scored - result.buckets.legacy.scored,
    pending: totalPending - result.buckets.legacy.pending,
  }
  const normalSessions = result.sessions.filter((session) => session.normalSession === true)
  const normalCounts = { folders: 0, scored: 0, pending: 0 }
  for (const session of normalSessions) addCounts(normalCounts, session)
  // The "current real pending" ids: every pending folder whose per-folder era is
  // current (on the documented snapshot that is qqb-g's two folders).
  result.currentPending = result.sessions
    .flatMap((session) => session.currentPending)
    .slice(0, CURRENT_PENDING_LIMIT)
  result.calibers = {
    A: makeCaliber('A', '全库存量（仅描述现状）', result.totals),
    B: makeCaliber('B', '排除 pre-1.2.0 遗留', excludeLegacy),
    C: makeCaliber('C', '排除遗留 + 压测（当前真实待评分）', result.buckets.current),
    D: makeCaliber('D', '1.3.0 tag 之后正常会话', normalCounts, { sessions: normalSessions.map((session) => session.session) }),
  }

  if (options.apply === true) result.apply = applyAllPendingEra(memoryDir)
  result.durationMs = Date.now() - startedAt
  return result
}

// ---------------------------------------------------------------------------
// --apply: write pendingEra into index.json (the only write path)
// ---------------------------------------------------------------------------

/**
 * Write the computed `pendingEra` into one `index.json`, changing nothing else.
 *
 * The folder order, every other field, `updatedAt` and `nextCounter` are kept
 * identical; only `pendingEra` is added/updated where the freshly computed era
 * differs (classification ignores an existing mark here, so stale marks are
 * corrected). `meta.json`, `scored`, α/β, keywords, `createdAt` and telemetry
 * are never touched, so nothing is re-judged and no recall/score state changes.
 *
 * @param {string} storeDir
 * @returns {{dir: string, ok: boolean, changed: number, checked: number, indexPath: string, error?: string}}
 */
export function applyPendingEra(storeDir) {
  const indexPath = path.join(storeDir, 'index.json')
  const parsed = readJsonFile(indexPath)
  if (!parsed.ok) {
    return {
      dir: storeDir,
      ok: false,
      changed: 0,
      checked: 0,
      indexPath,
      error:
        parsed.error && parsed.error.code === 'ENOENT'
          ? 'index.json 不存在'
          : `index.json 不可读（${parsed.error?.message ?? 'unknown'}）`,
    }
  }
  const index = parsed.value
  if (!index || typeof index !== 'object' || !Array.isArray(index.folders)) {
    return { dir: storeDir, ok: false, changed: 0, checked: 0, indexPath, error: 'index.json 没有 folders 数组' }
  }
  const folders = index.folders.filter((entry) => entry && typeof entry === 'object')
  let pending = 0
  for (const entry of folders) if (entry.scored === false) pending += 1
  const session = sessionEra({
    folders: folders.length,
    pending,
    signals: sessionEraSignals(readStatsEvents(path.join(storeDir, 'stats.jsonl'))),
  })
  let changed = 0
  let checked = 0
  for (const entry of folders) {
    checked += 1
    const era = classifyFolderEra({ ...entry, pendingEra: undefined }, session)
    if (entry.pendingEra !== era) {
      entry.pendingEra = era
      changed += 1
    }
  }
  if (changed === 0) return { dir: storeDir, ok: true, changed: 0, checked, indexPath }
  try {
    writeJsonAtomic(indexPath, index)
  } catch (error) {
    return { dir: storeDir, ok: false, changed: 0, checked, indexPath, error: `写入失败：${error.message}` }
  }
  return { dir: storeDir, ok: true, changed, checked, indexPath }
}

/** Apply `pendingEra` to every store found under `memoryDir`. */
export function applyAllPendingEra(memoryDir) {
  const stores = findStores(memoryDir)
  const summary = { requested: true, stores: [], filesWritten: 0, entriesMarked: 0, entriesChecked: 0, errors: [] }
  for (const store of stores) {
    const outcome = applyPendingEra(store.dir)
    const dirLabel = (path.relative(memoryDir, store.dir) || '.').split(path.sep).join('/')
    if (!outcome.ok) {
      summary.errors.push(`${dirLabel}: ${outcome.error}`)
      summary.stores.push({ session: path.basename(store.dir), dir: dirLabel, ok: false, error: outcome.error, changed: 0, checked: outcome.checked })
      continue
    }
    if (outcome.changed > 0) summary.filesWritten += 1
    summary.entriesMarked += outcome.changed
    summary.entriesChecked += outcome.checked
    summary.stores.push({ session: path.basename(store.dir), dir: dirLabel, ok: true, changed: outcome.changed, checked: outcome.checked })
  }
  return summary
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** One aligned era row of the human table. */
function formatEraRow(label, counts) {
  return (
    `${label.padEnd(11)}` +
    `${String(counts.folders).padStart(9)}` +
    `${String(counts.scored).padStart(9)}` +
    `${String(counts.pending).padStart(9)}` +
    `${formatPercent(counts.pendingPercent).padStart(10)}` +
    `${formatPercent(counts.pendingSharePercent).padStart(10)}`
  )
}

/** One caliber line ("A: 2769/3742 = 74.0% 全库存量（仅描述现状）"). */
function formatCaliberLine(caliber) {
  const percent = caliber.folders > 0 ? formatPercent(caliber.pendingPercent) : 'n/a'
  const sessions = Array.isArray(caliber.sessions) && caliber.sessions.length > 0 ? `（${caliber.sessions.join(', ')}）` : ''
  return `  ${caliber.id}: ${caliber.pending}/${caliber.folders} = ${percent}  ${caliber.description}${sessions}`
}

/** Note column of the session table (always says WHY the era was chosen). */
function sessionNote(session) {
  const reasons = session.reasons || {}
  const sessionPart =
    session.era === 'synthetic'
      ? 'sessionEra=synthetic（fakeWindow=true + stressBacklog=true）'
      : `sessionEra=current（fakeWindow=${reasons.fakeWindow}, stressBacklog=${reasons.stressBacklog}）`
  const folderPart = `folder 时代=${session.dominantEra}${session.mixed ? '（混合）' : ''}`
  if (session.dominantEra === 'legacy') {
    return `${folderPart}，createdAt < ${LEGACY_BOUNDARY_ISO}（pre-1.2.0 遗留）；${sessionPart}`
  }
  const pendingPart = session.pending > 0 ? `pending ${session.pending}（当前真实待评分）` : 'pending 0'
  return `${sessionPart}；${folderPart}，${pendingPart}`
}

/**
 * Render the human-readable report (fixed-width ASCII tables, Chinese labels).
 * @param {ReturnType<typeof auditMemory>} result
 */
export function formatHuman(result) {
  const lines = []
  lines.push('=== dsh-rofm 记忆时代审计（memory audit）===')
  lines.push(`memory dir  : ${result.memoryDir}`)
  lines.push(`layout      : ${result.layout}（${result.totals.stores} 个 store / ${result.totals.sessions} 个非空会话）`)
  lines.push(`read-only   : ${result.readOnly ? '是（未写任何文件）' : '否（--apply 已写 index.json 的 pendingEra）'}`)
  lines.push(`era rules   : engine/era.js（唯一真相）；legacy 按 folder createdAt < ${LEGACY_BOUNDARY_ISO}`)
  lines.push(
    `synthetic   : fakeWindow（windowTokens<${SYNTHETIC_WINDOW_TOKENS} 或 beforePercent>${SYNTHETIC_BEFORE_PERCENT}%）` +
      ` && stressBacklog（folders>=${STRESS_MIN_FOLDERS} 或 pending>=${STRESS_MIN_PENDING}）`,
  )
  lines.push('')
  lines.push('era'.padEnd(11) + 'folders'.padStart(9) + 'scored'.padStart(9) + 'pending'.padStart(9) + 'pending%'.padStart(10) + 'share%'.padStart(10))
  for (const era of ERAS) lines.push(formatEraRow(era, result.buckets[era]))
  lines.push(formatEraRow('total', { ...result.totals, pendingSharePercent: result.totals.pending > 0 ? 100 : 0 }))
  lines.push('')
  lines.push('口径（计划书 §2.2 / §9.2；folders 桶是 folder 总数，pending 才是待评分数）:')
  for (const id of ['A', 'B', 'C', 'D']) lines.push(formatCaliberLine(result.calibers[id]))
  lines.push('')
  const shownSessions = result.sessions
  if (shownSessions.length > 0) {
    const sessionWidth = Math.min(53, Math.max(25, ...shownSessions.map((session) => String(session.session).length + 1)))
    lines.push('sessions:')
    lines.push(
      '  ' + 'session'.padEnd(sessionWidth) + 'folder-era'.padEnd(12) + 'folders'.padStart(8) + 'scored'.padStart(8) + 'pending'.padStart(9) + '  note',
    )
    for (const session of shownSessions) {
      lines.push(
        '  ' +
          String(session.session).padEnd(sessionWidth) +
          String(session.dominantEra).padEnd(12) +
          String(session.folders).padStart(8) +
          String(session.scored).padStart(8) +
          String(session.pending).padStart(9) +
          `  ${sessionNote(session)}`,
      )
    }
  } else {
    lines.push('sessions: （没有带 folder 的会话）')
  }
  if (result.samples) {
    lines.push('')
    lines.push(`明细（--verbose，每类最多 ${result.sampleLimit ?? 'N'} 条）:`)
    for (const era of ['legacy', 'synthetic']) {
      const samples = result.samples[era]
      lines.push(`  ${era}:${samples.length === 0 ? ' （无）' : ''}`)
      for (const sample of samples) {
        lines.push(`    ${String(sample.id)}  createdAt=${isoText(sample.createdAt)}  ${sample.scored ? 'scored' : 'pending'}  ${sample.session}`)
      }
    }
    if (result.currentPending.length > 0) {
      lines.push(`  current pending ids: ${result.currentPending.join(', ')}`)
    }
  }
  lines.push('')
  if (result.apply === null) {
    lines.push('--apply     : 未启用（默认只读，不写任何文件）')
  } else if (result.apply.errors.length > 0) {
    lines.push(`--apply     : ${result.apply.filesWritten} 个 index.json 写入，${result.apply.entriesMarked} 条 entry 标记；${result.apply.errors.length} 个错误`)
    for (const error of result.apply.errors) lines.push(`  ! ${error}`)
  } else {
    lines.push(`--apply     : ${result.apply.filesWritten} 个 index.json 写入，${result.apply.entriesMarked} 条 entry 标记（检查 ${result.apply.entriesChecked} 条，只写 pendingEra）`)
  }
  if (result.warnings.length > 0) {
    lines.push('')
    lines.push(`warnings (${result.warnings.length}):`)
    for (const warning of result.warnings) lines.push(`  ! ${warning}`)
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

class UsageError extends Error {}

/**
 * Parse CLI arguments. Throws `UsageError` for malformed input.
 * @param {string[]} argv arguments after the script path
 */
export function parseArgs(argv) {
  const options = { memoryDir: null, json: false, verbose: false, apply: false, limit: DEFAULT_SAMPLE_LIMIT, help: false }
  const args = Array.isArray(argv) ? argv : []
  for (let index = 0; index < args.length; index += 1) {
    const raw = String(args[index])
    if (raw === '-h' || raw === '--help') {
      options.help = true
      continue
    }
    if (raw === '--json') {
      options.json = true
      continue
    }
    if (raw === '--verbose') {
      options.verbose = true
      continue
    }
    if (raw === '--apply') {
      options.apply = true
      continue
    }
    const equals = raw.indexOf('=')
    const flag = raw.startsWith('--') && equals >= 0 ? raw.slice(0, equals) : raw
    const inline = raw.startsWith('--') && equals >= 0 ? raw.slice(equals + 1) : undefined
    const value = () => {
      if (inline !== undefined) return inline
      index += 1
      if (index >= args.length) throw new UsageError(`option ${flag} requires a value`)
      return String(args[index])
    }
    if (flag === '--memory') {
      options.memoryDir = value()
      continue
    }
    if (flag === '--limit') {
      const text = value()
      const parsed = Number(text)
      if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`--limit expects a non-negative integer, got ${JSON.stringify(text)}`)
      options.limit = parsed
      continue
    }
    throw new UsageError(`unknown option: ${raw}`)
  }
  return options
}

/**
 * CLI entry point.
 * @param {string[]} [argv] arguments after the script path
 * @returns {number} process exit code (0 = success, 1 = usage/write error)
 */
export function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\n\n${USAGE}`)
      return 1
    }
    throw error
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const memoryDir = typeof options.memoryDir === 'string' ? path.resolve(process.cwd(), options.memoryDir) : DEFAULT_MEMORY_DIR
  const result = auditMemory(memoryDir, {
    apply: options.apply,
    sampleLimit: options.verbose ? options.limit : 0,
  })
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    process.stdout.write(formatHuman(result))
    if (result.totals.stores === 0) {
      process.stderr.write(`hint: ${memoryDir} 下没有可审计的 store（运行 engine/仿真产生记忆后再试）\n`)
    }
  }
  if (result.apply && result.apply.errors.length > 0) return 1
  return 0
}

const invokedDirectly = invokedAsMain(import.meta.url)

if (invokedDirectly) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`memory-audit: unexpected failure: ${error && error.stack ? error.stack : error}\n`)
    process.exitCode = 1
  }
}
