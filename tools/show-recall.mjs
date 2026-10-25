#!/usr/bin/env node
/**
 * Show where recalled context lives and what would be / was injected.
 *
 * Usage:
 *   node tools/show-recall.mjs                     # list sessions + folder/pending counts
 *   node tools/show-recall.mjs --session <id>      # one session: folders + rendered recall block
 *   node tools/show-recall.mjs --session <id> --live
 *       # also extract the block that actually reached the model from the
 *       # DSH session log (latest system message containing "## 记忆回忆")
 *   node tools/show-recall.mjs --dir <session-memory-dir> [--live --session <id>]
 *   node tools/show-recall.mjs --json              # machine-readable
 *
 * Every memory folder is listed with its α, β (trust), `scored` and
 * `rescorePending` flags; unscored ("pending") folders are called out and never
 * appear in the rendered recall block (they cannot be recalled before the
 * current model rates them through `memory_judge`). A `recall-state.json` is
 * summarised as either the v2 snapshot (version, block length, per-folder β +
 * message count — the block itself is not reprinted) or the legacy v1 id list.
 *
 * Zero dependencies. `--live` needs Node >= 22.15 (zlib zstd); everything else
 * is plain JSON/JSONL reads.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRecallBlock, formatBeta, indexEntryFromMeta, readFolder, readIndex, scanFolderMetas } from '../engine/index.js'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const json = args.includes('--json')
const live = args.includes('--live')
function arg(name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  // Never swallow the next flag as a value: `--session --json` means the
  // session id is missing, not that the id is "--json".
  return value === undefined || value.startsWith('--') ? undefined : value
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  const events = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed)
    } catch {
      /* corrupt telemetry line: skip like engine readStats() does */
    }
  }
  return events
}
function memoryRoot() {
  try {
    const config = readJson(path.join(PLUGIN_DIR, 'config.json'))
    const dir = String(config?.storage?.dir || 'memory')
    return path.isAbsolute(dir) ? dir : path.resolve(PLUGIN_DIR, dir)
  } catch {
    // Missing/corrupt config.json: fall back to the documented default dir.
    return path.resolve(PLUGIN_DIR, 'memory')
  }
}
/**
 * The session's index; a corrupt/missing index is rebuilt in memory from
 * meta.json files exactly like the engine does (persistence is disposable),
 * without writing anything from this read-only inspection tool.
 */
function loadIndexFor(dir) {
  const index = readIndex(dir)
  if (index) return index
  return { version: 1, folders: scanFolderMetas(dir).map((meta) => indexEntryFromMeta(meta)) }
}
function listSessions(root) {
  const sessionsDir = path.join(root, 'sessions')
  if (!fs.existsSync(sessionsDir)) return []
  return fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(sessionsDir, entry.name)
      const indexFolders = loadIndexFor(dir).folders
      return {
        id: entry.name,
        dir,
        folders: indexFolders.length,
        // Memory-scoring work queue: archived-but-unscored new folders and
        // recalled folders whose copy was re-archived (awaiting re-review).
        pending: indexFolders.filter((folder) => folder && folder.scored === false).length,
        rescore: indexFolders.filter((folder) => folder && folder.rescorePending === true).length,
      }
    })
}
function loadSession(dir) {
  if (!fs.existsSync(dir)) return undefined
  const index = loadIndexFor(dir)
  const folders = (index.folders ?? []).map((folder) => {
    // A folder listed in the index whose meta/context is missing or corrupt must
    // not abort the whole inspection: surface it as corrupt (the same state the
    // engine skips with a warning during recall).
    let loaded
    try {
      loaded = readFolder(dir, folder.id)
    } catch {
      loaded = undefined
    }
    const meta = loaded?.meta ?? {}
    const messages = loaded?.messages ?? []
    const stats = meta.stats ?? {}
    // β lives in meta.json (model judged); the index entry is the fallback for
    // folders whose meta was hand-edited. Legacy folders without β read as 0.
    const beta = Number.isFinite(Number(meta.beta))
      ? Number(meta.beta)
      : Number.isFinite(Number(folder.beta))
        ? Number(folder.beta)
        : 0
    // `scored !== false` mirrors the engine: legacy folders (no field) count as
    // scored; only an explicit false means "archived, waiting for memory_judge".
    const scored = folder.scored !== false && meta.scored !== false
    const rescorePending = folder.rescorePending === true || meta.rescorePending === true
    return {
      id: folder.id,
      createdAt: Number(meta.createdAt ?? folder.createdAt),
      alpha: Number(meta.alpha ?? folder.alpha),
      beta,
      scored,
      rescorePending,
      pending: scored === false,
      corrupt: loaded === undefined,
      sources: {
        alpha: meta.alphaSource ?? folder.alphaSource ?? null,
        keywords: meta.keywordsSource ?? folder.keywordsSource ?? null,
        beta: meta.betaSource ?? folder.betaSource ?? null,
      },
      pendingSince: Number.isFinite(Number(meta.pendingSince)) ? Number(meta.pendingSince) : null,
      judgedAt: Number.isFinite(Number(meta.judgedAt)) ? Number(meta.judgedAt) : null,
      keywords: meta.keywords ?? folder.keywords ?? [],
      title: meta.title ?? folder.title ?? '',
      chars: Number(stats.chars ?? folder.chars ?? 0),
      tokens: Number(stats.tokens ?? folder.tokens ?? 0),
      messages,
      meta: { alpha: meta.alpha, beta, keywords: meta.keywords, createdAt: meta.createdAt, messages, stats },
    }
  })
  const stateFile = path.join(dir, 'recall-state.json')
  let recallState = null
  if (fs.existsSync(stateFile)) {
    try {
      recallState = readJson(stateFile)
    } catch {
      recallState = null
    }
  }
  const stats = readJsonl(path.join(dir, 'stats.jsonl'))
  const recalls = stats.filter((event) => event.type === 'recall' && (event.addedFolders ?? 0) > 0)
  return { index, folders, recallState, recalls, stats }
}

function renderMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block && block.type === 'text' ? block.text : '')).join('\n')
}

/** Find the latest system message containing the recall block in a DSH session log. */
function liveBlock(sessionId) {
  try {
    const zlib = zlibModule
    if (!zlib || typeof zlib.zstdDecompressSync !== 'function') {
      return { error: 'this Node lacks zlib zstd support (need >= 22.15); use --json? or inspect the log manually' }
    }
    const root = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
    if (!fs.existsSync(root)) return { error: `no sessions dir at ${root}` }
    let file
    for (const workspace of fs.readdirSync(root)) {
      const candidate = path.join(root, workspace, sessionId, 'session.v4.jsonl.zstd')
      if (fs.existsSync(candidate)) { file = candidate; break }
    }
    if (!file) return { error: `no session log for ${sessionId} under ${root}` }
    const buffer = fs.readFileSync(file)
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const offsets = []
    let cursor = 0
    while (true) {
      const at = buffer.indexOf(magic, cursor)
      if (at < 0) break
      offsets.push(at)
      cursor = at + 4
    }
    const parts = []
    for (let index = 0; index < offsets.length; index += 1) {
      const start = offsets[index]
      const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
      try { parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')) } catch { /* ignore frame */ }
    }
    const events = parts.join('').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    let found = null
    for (const event of events) {
      if (event.type !== 'system/message') continue
      const text = renderMessage(event.data?.message)
      const index = text.indexOf('## 记忆回忆')
      if (index >= 0) found = { seq: event.seq, time: event.time, block: text.slice(index) }
    }
    return { file, found }
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}
function awaitImportZlib() {
  return zlibModule
}
import * as zlibModule from 'node:zlib'

// ---------------------------------------------------------------------------
if (!json) console.log(`插件目录: ${PLUGIN_DIR}\n记忆根目录: ${memoryRoot()}`)

// no session selector: list sessions
const requestedSession = arg('--session')
const requestedDir = arg('--dir')
if (!requestedSession && !requestedDir) {
  const root = memoryRoot()
  const sessions = listSessions(root)
  // Legacy 0.1.x flat layout: count the root folders through the same
  // rebuild-from-meta fallback as sessions, so a corrupt root index.json cannot
  // crash the inspection tool.
  const legacy = fs.existsSync(root) ? loadIndexFor(root).folders.length : 0
  const output = { memoryRoot: root, sessions, legacyFolders: legacy }
  if (json) {
    console.log(JSON.stringify(output, null, 2))
  } else {
    console.log('\n会话列表（回忆文件夹在 memory/sessions/<session-id>/）：')
    if (sessions.length === 0) console.log('  (还没有任何会话归档)')
    for (const session of sessions) {
      console.log(
        `  - ${session.id}  folders=${session.folders}  pending=${session.pending}  rescore=${session.rescore}  dir=${session.dir}`,
      )
    }
    if (legacy > 0) console.log(`\n旧版(0.1.x)全局回忆文件夹: ${legacy} 个，位于 ${root}/index.json（新版本不再读取）`)
    console.log('\n查看某个会话： node tools/show-recall.mjs --session <session-id> [--live]')
    console.log('pending = 归档后尚未被当前模型经 memory_judge 评分；rescore = 回忆块再归档后待复核 α/β。')
  }
  process.exit(0)
}

const dir = requestedDir
  ? path.resolve(requestedDir)
  : path.join(memoryRoot(), 'sessions', requestedSession)
const session = loadSession(dir)
if (!session) {
  console.error(`找不到会话记忆目录: ${dir}`)
  console.error('可用命令：node tools/show-recall.mjs （先列出会话）')
  process.exit(1)
}
// Only scored folders with readable content can ever be injected: pending
// folders are archived but still waiting for the current model to call
// `memory_judge`, and corrupt folders are skipped by the engine during recall.
const recallable = session.folders.filter((folder) => folder.scored !== false && folder.corrupt !== true)
const rendered = buildRecallBlock(recallable.map((folder) => ({
  id: folder.id,
  generation: 1,
  alpha: folder.alpha,
  beta: folder.beta,
  meta: folder.meta,
  messages: folder.messages,
  chars: folder.chars,
  tokens: folder.tokens,
})))
const result = {
  dir,
  sessionId: requestedSession ?? path.basename(dir),
  folders: session.folders.map((folder) => ({
    id: folder.id,
    createdAt: folder.createdAt,
    alpha: folder.alpha,
    beta: folder.beta,
    scored: folder.scored,
    rescorePending: folder.rescorePending,
    pending: folder.pending,
    corrupt: folder.corrupt === true,
    sources: folder.sources,
    pendingSince: folder.pendingSince,
    judgedAt: folder.judgedAt,
    keywords: folder.keywords,
    title: folder.title,
    chars: folder.chars,
    contextFile: path.join(dir, folder.id, 'context.json'),
    metaFile: path.join(dir, folder.id, 'meta.json'),
  })),
  summary: {
    folders: session.folders.length,
    scored: session.folders.filter((folder) => folder.scored !== false).length,
    pending: session.folders.filter((folder) => folder.pending).length,
    rescorePending: session.folders.filter((folder) => folder.rescorePending).length,
    corrupt: session.folders.filter((folder) => folder.corrupt === true).length,
    recallable: recallable.length,
  },
  recallState: session.recallState,
  recalls: session.recalls,
  wouldInject: rendered,
}
if (live) {
  result.live = liveBlock(requestedSession ?? path.basename(dir))
}
if (json) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

console.log(
  `\n会话: ${result.sessionId}\n目录: ${dir}\n回忆文件夹: ${result.summary.folders} 个` +
    `（已评分 ${result.summary.scored} / 待评分 ${result.summary.pending} / 待复核 ${result.summary.rescorePending}）\n`,
)
for (const folder of result.folders) {
  const flags = []
  if (folder.pending) flags.push('待评分')
  if (folder.rescorePending) flags.push('待复核')
  if (folder.corrupt) flags.push('原文缺失/损坏')
  const flagText = flags.length > 0 ? `  [${flags.join('、')}]` : ''
  console.log(`- ${folder.id}  α=${folder.alpha}  β=${formatBeta(folder.beta)}  ${folder.chars} 字${flagText}`)
  console.log(`  关键词: ${folder.keywords.join('、') || '(尚未评分)'}`)
  const judged = folder.judgedAt ? `  judgedAt=${new Date(folder.judgedAt).toISOString()}` : ''
  const pendingSince = folder.pending && folder.pendingSince ? `  pendingSince=${new Date(folder.pendingSince).toISOString()}` : ''
  console.log(
    `  sources: α=${folder.sources.alpha ?? 'n/a'} keywords=${folder.sources.keywords ?? 'n/a'} β=${folder.sources.beta ?? 'n/a'}${judged}${pendingSince}`,
  )
  console.log(`  原文: ${folder.contextFile}`)
}
if (result.summary.pending > 0) {
  console.log(
    `\n⚠️ 有 ${result.summary.pending} 个待评分文件夹：需当前会话模型在“记忆评分任务”区块后调用 memory_judge 提交 α/β/关键词，之后才会参与回忆。`,
  )
}
if (result.summary.rescorePending > 0) {
  console.log(
    `\n⚠️ 有 ${result.summary.rescorePending} 个待复核文件夹：它们的回忆已被再归档移出注入块，需当前模型用 memory_judge 复核 α/β（或 keep=true）。`,
  )
}
if (result.recallState) {
  const state = result.recallState
  const updatedAt = Number(state.updatedAt)
  const updatedText = Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : 'n/a'
  if (state.version === 2) {
    // v2 snapshot: the injected block plus the content of every memorised
    // folder. Print a summary only (the full block is printed below as
    // `wouldInject` / `--live`), never the whole snapshot twice.
    const additions = Array.isArray(state.additions) ? state.additions : []
    const blockChars = typeof state.block === 'string' ? state.block.length : 0
    console.log(`\n已注入回忆快照（recall-state.json v2）: version=2  block=${blockChars} 字  additions=${additions.length} 条  updatedAt=${updatedText}`)
    for (const entry of additions) {
      const messages = Array.isArray(entry.messages) ? entry.messages.length : 0
      console.log(`  - ${entry.id}  第${entry.generation ?? 1}代  α=${entry.alpha}  β=${formatBeta(entry.beta)}  ${entry.chars ?? 0} 字  messages=${messages}  keywords=${(entry.keywords ?? []).join('、') || 'n/a'}`)
    }
  } else {
    console.log(`\n已注入过的回忆 id（recall-state.json v1）: ${state.ids?.map((entry) => entry.id).join(', ') || '(空)'}`)
  }
}
if (result.recalls.length > 0) {
  console.log('\n最近回忆遥测（stats.jsonl）:')
  for (const event of result.recalls.slice(-5)) {
    console.log(`  ${new Date(event.time).toISOString()}  matched=${event.matchedFolders} added=${event.addedFolders}  addedChars=${event.addedChars}  gen=${JSON.stringify(event.byGeneration)}  latency=${event.latencyMs}ms`)
  }
}
console.log('\n================ 会被注入模型上下文的回忆块 ================')
console.log(result.wouldInject || '(空)')
if (live) {
  console.log('\n================ DSH 会话日志里实际出现过的回忆块（最近一次） ================')
  if (result.live.error) {
    console.log(`(无法提取: ${result.live.error})`)
  } else if (!result.live.found) {
    console.log('(该会话日志里还没有包含“## 记忆回忆”的 system 消息)')
  } else {
    console.log(`来源: ${result.live.file}  seq=${result.live.found.seq}  time=${new Date(result.live.found.time).toISOString()}\n`)
    console.log(result.live.found.block)
  }
}
