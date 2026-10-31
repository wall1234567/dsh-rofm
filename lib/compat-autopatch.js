/**
 * dsh-rofm — Derpyu520/qq-bridge 工具白名单自动补丁（计划 §6 / D6 / D14）。
 *
 * 背景：Derpyu 的两个 QQ preset 都挂载 `qq-tool-restrict`，其 `tools.guard`
 * 执行期白名单只放行 `mcp__snowluma*` 前缀与 `ask_user_question` / `todo_write`。
 * rofm 的三个工具（memory_judge / memory_recall / memory_image）因此"可见但
 * 执行被拒"，归档会永远停在待评分状态、也不会主动回忆。本模块在检测到 Derpyu
 * 之后，把这三个名字幂等地注入
 *   `<profile>/node_modules/qq-agent-presets/qq-tool-restrict.mjs`
 * 的 `SAFE_EXACT` Set 里（link 安装时该文件经 junction 指向用户仓库）。
 *
 * 设计原则——每一步都优先"不写"，而不是"尽力写"：
 *   1. 只改这一个文件，只加三个本地记忆工具名（不引入 shell/文件能力）；
 *   2. 只认一种稳定结构：`const SAFE_EXACT = new Set([` 之后每行一个字符串字面量、
 *      `])` 独占一行。不在这个形状里 → `unsupported`，绝不重建或猜测文件（D6）；
 *   3. 写前先备份 `<file>.bak-rofm-<YYYYMMDDHHmmss>`（同文件最多留 5 份），
 *      再用 tmp + rename 原子替换；任何一步失败原文件保持原样，绝不部分写入；
 *   4. 上游更新（Derpyu 升级）后 hash 变化、三名字缺失 → 在新文件上重新注入（D14），
 *      重复调用幂等（名字已在 Set 里 → already，不再产生备份）；
 *   5. 所有对外函数不抛异常：失败通过返回值 + WARN 日志表达，日志本身失败也不影响流程。
 *
 * 合规边界（计划 §6.10）：仅修改用户本机已安装的 Derpyu 目录中的这一个文件，
 * 不涉及网络、不修改 Derpyu 的其它文件、不提交任何东西。
 */

import { createHash } from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** 需要加入 SAFE_EXACT 的三个 rofm 工具名（顺序即注入顺序，也是自愈判定顺序）。 */
export const AUTO_PATCH_TOOL_NAMES = Object.freeze(['memory_judge', 'memory_recall', 'memory_image'])

/** 目标包名：Derpyu 的 preset bundle（唯一权威实现放在它的包根）。 */
const PACKAGE_NAME = 'qq-agent-presets'
/** 目标文件名：两个 QQ preset 共同引用的白名单实现。 */
const TOOL_RESTRICT_FILE = 'qq-tool-restrict.mjs'
/** 状态文件名：落在调用方传入的 memoryDir 下，供 D14 的更新自愈使用。 */
const STATE_FILE_NAME = '.compat-state.json'
const STATE_VERSION = 1
/** 同文件备份上限（计划 §6.3：保留最近 5 份）。 */
const MAX_BACKUPS = 5
/** 注入行的行尾标记：既能让人看出这行不是上游写的，也方便搜索/手工回滚。 */
const AUTOPATCH_MARKER = '// rofm-autopatch: 自动补丁注入'

/** 依赖声明里要看的四组（计划只要求 dependencies/devDependencies，其余两组是廉价兜底）。 */
const DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/** 识别 SAFE_EXACT 的开头；`export const` 也能命中（\bconst）。 */
const SAFE_EXACT_OPEN_RE = /\bconst\s+SAFE_EXACT\s*=\s*new\s+Set\s*\(\s*\[/
/** Set 的闭合 `])`（允许中间有空白/换行）。 */
const SET_CLOSE_RE = /\]\s*\)/g
/**
 * SAFE_EXACT 内允许的元素行：一个引号字符串 + 可选逗号 + 可选行尾注释。
 * 字符串内部不允许再出现引号（[^'"]*），否则"一行两个元素"会被当成一个带引号
 * 的怪名字而误判可打补丁——宁可判 unsupported，也不猜结构。
 */
const ELEMENT_LINE_RE = /^(['"])([^'"]*)\1\s*,?\s*(?:\/\/.*)?$/
/** 工具名白名单：注入的文件是 JS 源码，名字必须能安全地放进单引号里。 */
const SAFE_TOOL_NAME_RE = /^[A-Za-z0-9_.:-]+$/

/** 原子写的临时文件计数：同一进程内多次调用也要拿到不同的 tmp 名。 */
let tmpCounter = 0

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** sha256(text)，hex 小写。状态文件用它对账"上游是否更新过"。 */
function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 路径比较的平台口径：Windows 大小写不敏感，POSIX 敏感（避免误合并两个不同文件）。 */
const CASE_INSENSITIVE_FS = process.platform === 'win32'
function normalizePathKey(value) {
  return CASE_INSENSITIVE_FS ? value.toLowerCase() : value
}

/**
 * 两个路径是否指向同一个文件。
 * 先比字符串，再比 realpath——link 安装时同一个文件可能被不同路径（profile
 * node_modules 路径 / 用户仓库路径）引用，状态记录不能因此重复。
 */
function sameFilePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a === b) return true
  try {
    return normalizePathKey(realpathSync(a)) === normalizePathKey(realpathSync(b))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// logger
// ---------------------------------------------------------------------------

/**
 * 统一的日志出口。
 *
 * `logger` 兼容两种形态（兼容计划里"logger 可为 {warn,info} 或函数"的约定）：
 *   - 对象：调用 `logger.warn(line)` / `logger.info(line)`；
 *   - 函数：参数个数 >= 2 时按 `(level, line)` 调用（与 RofmPlugin.log 同签名），
 *     否则按 `(line)` 调用——这样直接塞一个 `this.log.bind(this)` 或
 *     `console.warn` 都不会出错。
 * 日志永远不参与控制流：任何异常都就地吞掉。
 */
function logLine(logger, level, message) {
  const line = `compat-autopatch: ${message}`
  try {
    if (typeof logger === 'function') {
      if (logger.length >= 2) logger(level, line)
      else logger(line)
      return
    }
    if (isPlainObject(logger)) {
      const sink = level === 'warn' ? logger.warn : logger.info
      if (typeof sink === 'function') sink.call(logger, line)
    }
  } catch {
    // 日志失败不能影响补丁流程（也不能影响调用方的启动）。
  }
}

// ---------------------------------------------------------------------------
// 目标文件定位
// ---------------------------------------------------------------------------

/**
 * 把 package.json 里 `qq-agent-presets` 的依赖值解析成包目录。
 *
 * 只处理本地安装形态（计划 §6.1）：`link:`（Derpyu 的 setup-dsh.mjs 实际写法，
 * 例如 `link:C:/Users/x/.dsh/plugins/qq-agent-presets`）与 `file:`。
 * 版本号 / `workspace:*` 等交给 node_modules 兜底——**不猜路径**。
 *
 * @returns {string|undefined} 绝对包目录；无法解析时为 undefined
 */
function resolveDependencySpec(profileRoot, spec) {
  const raw = typeof spec === 'string' ? spec.trim() : ''
  if (raw === '') return undefined
  let target
  if (raw.startsWith('link:')) target = raw.slice('link:'.length).trim()
  else if (raw.startsWith('file:')) target = raw.slice('file:'.length).trim()
  else return undefined
  if (target.startsWith('file://')) target = target.slice('file://'.length)
  if (target === '') return undefined
  return isAbsolute(target) ? resolve(target) : resolve(profileRoot, target)
}

/** 若 `packageDir/qq-tool-restrict.mjs` 是普通文件，返回定位结果。 */
function toolRestrictAt(packageDir, source) {
  if (typeof packageDir !== 'string' || packageDir === '') return undefined
  const filePath = join(packageDir, TOOL_RESTRICT_FILE)
  try {
    if (!statSync(filePath).isFile()) return undefined
  } catch {
    return undefined
  }
  return { filePath, packageDir, source }
}

/**
 * 定位 Derpyu 的 `qq-tool-restrict.mjs`（计划 §6.1）。
 *
 * 顺序：
 *   1. profile `package.json` 的依赖声明（link:/file: 需解析成包目录）；
 *   2. `<profile>/node_modules/qq-agent-presets/qq-tool-restrict.mjs` 直查
 *      （与 pnpm/junction 物化形态一致；Derpyu setup 会建这条 junction）。
 *
 * 找不到返回 undefined（调用方按 no-target 处理，WARN 不写）。
 *
 * @param {{ profileDir?: string }} [options]
 * @returns {{ filePath: string, packageDir: string, source: 'package.json'|'node_modules' }|undefined}
 */
export function locateToolRestrictFile({ profileDir } = {}) {
  try {
    if (typeof profileDir !== 'string' || profileDir.trim() === '') return undefined
    const profileRoot = resolve(profileDir.trim())

    const pkg = readJsonSafe(join(profileRoot, 'package.json'))
    if (isPlainObject(pkg)) {
      for (const group of DEPENDENCY_GROUPS) {
        const table = isPlainObject(pkg[group]) ? pkg[group] : undefined
        if (table === undefined || !Object.prototype.hasOwnProperty.call(table, PACKAGE_NAME)) continue
        const packageDir = resolveDependencySpec(profileRoot, table[PACKAGE_NAME])
        const found = toolRestrictAt(packageDir, 'package.json')
        if (found !== undefined) return found
      }
    }

    const direct = toolRestrictAt(join(profileRoot, 'node_modules', PACKAGE_NAME), 'node_modules')
    if (direct !== undefined) return direct
    return undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 纯函数：识别 + 生成补丁文本
// ---------------------------------------------------------------------------

/** 规范化工具名列表：去重、去空白、非法名字报错由 patchText 单独处理。 */
function normalizeNames(names) {
  const source = Array.isArray(names) ? names : AUTO_PATCH_TOOL_NAMES
  const out = []
  for (const name of source) {
    if (typeof name !== 'string') continue
    const value = name.trim()
    if (value === '' || out.includes(value)) continue
    out.push(value)
  }
  return out
}

/**
 * 解析 SAFE_EXACT 的 Set 内部文本。
 *
 * 只接受"每行一个字符串字面量"的简单列表（允许空行与行尾注释，允许最后一个
 * 元素没有逗号）。任何别的表达式都返回 unsupported——注入是整行插入，遇到
 * 连结构形状都变了的上游文件，正确做法是 WARN 后不写（D6 的"不猜"）。
 *
 * @param {string} inner `[` 与 `])` 之间的原文
 * @returns {{ names: string[], firstElementOffset: number } | { unsupported: string }}
 */
function parseSetInner(inner) {
  const names = []
  let firstElementOffset
  let offset = 0
  const lines = inner.split('\n')
  for (const raw of lines) {
    const start = offset
    offset += raw.length + 1 // +1：被 split 吃掉的 '\n'
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('//')) continue
    const match = ELEMENT_LINE_RE.exec(trimmed)
    if (match === null) return { unsupported: 'SAFE_EXACT 内存在无法识别的表达式（只支持每行一个字符串字面量）' }
    const name = match[2]
    if (name.length === 0) return { unsupported: 'SAFE_EXACT 内存在空字符串元素' }
    if (firstElementOffset === undefined) firstElementOffset = start + line.indexOf(trimmed)
    names.push(name)
  }
  return { names, firstElementOffset }
}

/**
 * 纯函数：判断一段文本需不需要打补丁，并（在需要时）生成打补丁后的文本。
 *
 * 不接触文件系统、不抛异常，可直接单测。识别口径（计划 §6.2）：
 *   - 必须存在 `const SAFE_EXACT = new Set([` … `])`；
 *   - Set 内每行一个字符串字面量（见 {@link parseSetInner}）；
 *   - 三名字都已在其中 → `already`；缺哪个补哪个（可重复识别、幂等）。
 *
 * 注入位置：Set 第一个元素所在行的下一行，用该行缩进与文件自身的换行符；
 * 每行带 {@link AUTOPATCH_MARKER} 行尾注释，便于人工识别和按文档回滚。
 *
 * @param {string} text 目标文件原文
 * @param {string[]} [names] 要注入的工具名（默认 {@link AUTO_PATCH_TOOL_NAMES}）
 * @returns {{ status: 'already'|'patchable'|'unsupported', text?: string, reason?: string }}
 */
export function patchText(text, names = AUTO_PATCH_TOOL_NAMES) {
  try {
    if (typeof text !== 'string') return { status: 'unsupported', reason: '目标文件内容不是字符串' }
    const wanted = normalizeNames(names)
    if (wanted.length === 0) return { status: 'already' }
    for (const name of wanted) {
      if (!SAFE_TOOL_NAME_RE.test(name)) return { status: 'unsupported', reason: `工具名不是合法的标识符字符串：${name}` }
    }

    const open = SAFE_EXACT_OPEN_RE.exec(text)
    if (open === null) return { status: 'unsupported', reason: '未找到 `const SAFE_EXACT = new Set([` 结构' }
    SET_CLOSE_RE.lastIndex = open.index + open[0].length
    const close = SET_CLOSE_RE.exec(text)
    if (close === null) return { status: 'unsupported', reason: 'SAFE_EXACT 的 Set 没有闭合（缺少 `])`）' }

    const inner = text.slice(open.index + open[0].length, close.index)
    const parsed = parseSetInner(inner)
    if (parsed.unsupported !== undefined) return { status: 'unsupported', reason: parsed.unsupported }

    const present = new Set(parsed.names)
    if (wanted.every((name) => present.has(name))) return { status: 'already' }
    if (parsed.firstElementOffset === undefined) {
      return { status: 'unsupported', reason: 'SAFE_EXACT 为空，无法确定插入位置' }
    }

    // 闭合括号必须独占一行：整行插入要求 `])` 不在有内容的行上。
    // 单行写法（`new Set(['a', 'b'])`）属于"结构不同"，按计划不重建、不猜。
    const closeLineStart = text.lastIndexOf('\n', close.index) + 1
    if (text.slice(closeLineStart, close.index).trim() !== '') {
      return { status: 'unsupported', reason: 'SAFE_EXACT 的 `])` 与元素同处一行，无法安全整行插入' }
    }

    // 第一个元素所在物理行的行尾；插入点在该行换行符之后。
    const firstElementStart = open.index + open[0].length + parsed.firstElementOffset
    const lineStart = text.lastIndexOf('\n', firstElementStart) + 1
    const lineEnd = text.indexOf('\n', firstElementStart)
    if (lineEnd === -1) return { status: 'unsupported', reason: 'SAFE_EXACT 首个元素所在行没有换行结尾' }
    // 缩进取该行行首到元素之间的空白（元素本身已由 parseSetInner 校验过）。
    const indent = text.slice(lineStart, firstElementStart)
    // 换行符跟随目标文件自己（CRLF 文件不能被写出混合行尾）。
    const eol = text[lineEnd - 1] === '\r' ? '\r\n' : '\n'

    const block = wanted
      .filter((name) => !present.has(name))
      .map((name) => `${indent}'${name}', ${AUTOPATCH_MARKER}${eol}`)
      .join('')
    const patched = text.slice(0, lineEnd + 1) + block + text.slice(lineEnd + 1)
    return { status: 'patchable', text: patched }
  } catch (error) {
    return { status: 'unsupported', reason: `解析异常：${errorMessage(error)}` }
  }
}

// ---------------------------------------------------------------------------
// 备份 / 原子写
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 备份时间戳 `YYYYMMDDHHmmss`（本地时间，方便用户按文件系统时间对账）。 */
function backupStamp(date) {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  )
}

/** 把 now 参数归一化成 Date：支持 Date / epoch ms / ISO 字符串，非法值用当前时间。 */
function normalizeNow(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now)
  if (typeof now === 'string' && now.trim() !== '') {
    const parsed = new Date(now)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

/** 备份文件名的排序键：先按 14 位时间戳，再按同秒冲突的 `-N` 后缀。 */
function backupOrder(name) {
  const match = /-(\d{14})(?:-(\d+))?$/.exec(name)
  if (match === null) return { stamp: 0, seq: 0 }
  return { stamp: Number(match[1]), seq: match[2] === undefined ? 0 : Number(match[2]) }
}

/** 列出某文件的全部 rofm 备份，按时间从旧到新排序。 */
function listBackups(filePath) {
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}.bak-rofm-`
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => {
        const left = backupOrder(a)
        const right = backupOrder(b)
        return left.stamp - right.stamp || left.seq - right.seq
      })
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

/** 备份数量上限：只保留最近 MAX_BACKUPS 份；清理失败只 WARN，不影响补丁。 */
function pruneBackups(filePath, logger) {
  try {
    const backups = listBackups(filePath)
    const stale = backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))
    for (const path of stale) {
      try {
        unlinkSync(path)
      } catch (error) {
        logLine(logger, 'warn', `清理旧备份失败（不影响本次补丁）：${path}（${errorMessage(error)}）`)
      }
    }
  } catch {
    // 清理是尽力而为：补丁本身已经成功，不能因为删旧备份失败就回退。
  }
}

/**
 * 写前备份：`<file>.bak-rofm-<YYYYMMDDHHmmss>`。
 * 同一秒内多次打补丁（上游连续更新）会撞名，用 `-2`、`-3`… 后缀区分，
 * 排序逻辑见 {@link backupOrder}。
 *
 * @returns {{ backupPath: string } | { error: Error }}
 */
function createBackup(filePath, nowDate, logger) {
  const stamp = backupStamp(nowDate)
  const base = `${filePath}.bak-rofm-${stamp}`
  let backupPath = base
  try {
    for (let attempt = 2; existsSync(backupPath) && attempt < 100; attempt += 1) backupPath = `${base}-${attempt}`
    copyFileSync(filePath, backupPath)
  } catch (error) {
    return { error }
  }
  pruneBackups(filePath, logger)
  return { backupPath }
}

/** tmp + rename 原子替换；失败时清理 tmp 并返回错误（目标文件保持原样）。 */
function atomicWriteFile(filePath, text) {
  const dir = dirname(filePath)
  tmpCounter += 1
  const tmpPath = join(dir, `.${basename(filePath)}.rofm-tmp-${process.pid}-${tmpCounter.toString(36)}`)
  try {
    writeFileSync(tmpPath, text, 'utf8')
    renameSync(tmpPath, filePath)
    return undefined
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // tmp 可能根本没写出来；清理失败也不能掩盖真正的写错误。
    }
    return error
  }
}

/**
 * 只读保护：在写之前就明确失败，而不是依赖 rename 的平台差异。
 *
 * 两个口径都查：
 *   - 文件 mode 没有写位（chmod 0o444 / Windows 只读属性）→ 视为只读。
 *     这一条让行为在 Windows / POSIX（包括 root）上一致且可预测；
 *   - 实际 access(W_OK)（文件与目录）——ACL/占用等情况由它兜底。
 *
 * @returns {string|undefined} 不可写原因；可写时为 undefined
 */
function checkWritable(filePath) {
  try {
    const mode = statSync(filePath).mode
    if ((mode & 0o222) === 0) return '目标文件为只读'
  } catch (error) {
    return `无法读取文件属性：${errorMessage(error)}`
  }
  try {
    accessSync(filePath, fsConstants.W_OK)
  } catch (error) {
    return `目标文件不可写：${errorMessage(error)}`
  }
  try {
    accessSync(dirname(filePath), fsConstants.W_OK)
  } catch (error) {
    return `目标文件所在目录不可写：${errorMessage(error)}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 状态文件（<memoryDir>/.compat-state.json，D14）
// ---------------------------------------------------------------------------

function stateFilePath(memoryDir) {
  if (typeof memoryDir !== 'string' || memoryDir.trim() === '') return undefined
  return join(memoryDir.trim(), STATE_FILE_NAME)
}

/**
 * 读取自动补丁状态。缺失 / JSON 损坏 / 形状不对一律返回 `{}`，绝不抛。
 *
 * @param {string} memoryDir rofm 的 memory 目录
 * @returns {{ version: number, patches: object[] } | {}}
 */
export function readAutopatchState(memoryDir) {
  try {
    const file = stateFilePath(memoryDir)
    if (file === undefined) return {}
    const raw = readTextSafe(file)
    if (raw === undefined) return {}
    let parsed
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    } catch {
      return {}
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.patches)) return {}
    const patches = parsed.patches.filter((entry) => isPlainObject(entry)).map((entry) => ({ ...entry }))
    return { version: Number.isInteger(parsed.version) ? parsed.version : STATE_VERSION, patches }
  } catch {
    return {}
  }
}

/** 原子写状态文件；失败返回 false（调用方只 WARN，不把已成功的补丁判失败）。 */
function writeAutopatchState(file, state) {
  const dir = dirname(file)
  tmpCounter += 1
  const tmpPath = join(dir, `.${STATE_FILE_NAME}.rofm-tmp-${process.pid}-${tmpCounter.toString(36)}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, file)
    return true
  } catch {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 同上：清理失败不改变"状态没写成"这个事实。
    }
    return false
  }
}

/** 找某个目标文件上一次的补丁记录（link 安装的两种路径按 realpath 视为同一文件）。 */
function findPatchRecord(state, filePath) {
  const patches = Array.isArray(state?.patches) ? state.patches : []
  return patches.find((entry) => entry?.target === PACKAGE_NAME && sameFilePath(entry.filePath, filePath))
}

/** 更新（或追加）一条补丁记录；保留其它文件/其它 profile 的记录。 */
function upsertPatchRecord(state, record) {
  const patches = Array.isArray(state?.patches) ? state.patches.slice() : []
  const index = patches.findIndex((entry) => entry?.target === PACKAGE_NAME && sameFilePath(entry.filePath, record.filePath))
  if (index >= 0) patches[index] = record
  else patches.push(record)
  return { version: STATE_VERSION, patches }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 确保 Derpyu 的工具白名单包含 rofm 三工具（计划 §6 / D6 / D14）。
 *
 * 调用时机由接线方决定（rofm 启动、配置热加载、每次检测到 Derpyu）；
 * 本函数每次都会重新读取目标文件，因此天然幂等、也能自愈上游更新：
 *   - 三名字已在 SAFE_EXACT 里 → `already`（不备份、不写）；
 *   - 缺失且结构可识别 → 备份 + 原子注入 → `patched`；
 *   - 上游更新导致内容变化 → 在**新文件**上重新备份 + 注入（返回 `reason:'upstream-updated'`）；
 *   - 结构不识别 / 只读 / 读失败 / 备份或写失败 → `failed`，原文件保持原样；
 *   - `enabled=false` 或 compat 未启用 → `disabled`（完全不碰第三方文件）；
 *   - 未检测到 Derpyu / 找不到目标文件 → `no-target`（WARN 不写）。
 *
 * 永不抛异常（包括 logger 自己抛）。返回值：
 *   `{ status, filePath?, backupPath?, reason?, statePath? }`
 *
 * @param {{
 *   memoryDir?: string,
 *   profileDir?: string,
 *   detection?: { enabled?: boolean, profileDir?: string, derpyu?: { detected?: boolean } },
 *   enabled?: boolean,
 *   now?: Date|number|string,
 *   logger?: { warn?: Function, info?: Function } | Function,
 * }} [options]
 * @returns {{ status: 'disabled'|'no-target'|'already'|'patched'|'failed',
 *             filePath?: string, backupPath?: string, reason?: string, statePath?: string }}
 */
export function ensureAutopatch({ memoryDir, profileDir, detection, enabled = true, now, logger } = {}) {
  const statePath = stateFilePath(memoryDir)
  const warn = (message) => logLine(logger, 'warn', message)
  const info = (message) => logLine(logger, 'info', message)
  try {
    if (enabled === false) {
      info('自动补丁已关闭（compat.autoPatchDerpyu=false），不修改 Derpyu 文件')
      return { status: 'disabled', reason: 'autoPatch disabled', statePath }
    }
    // 只有"compat 已启用且确实检测到 Derpyu"才允许碰第三方文件。
    // detection 缺失同样按未确认处理：模块绝不在没证据的机器上改别人的包。
    if (!isPlainObject(detection) || detection.enabled === false) {
      info('compat 未启用，跳过自动补丁')
      return { status: 'disabled', reason: 'compat disabled', statePath }
    }
    if (detection.derpyu?.detected !== true) {
      return { status: 'no-target', reason: 'derpyu not detected', statePath }
    }

    const resolvedProfileDir =
      typeof profileDir === 'string' && profileDir.trim() !== ''
        ? profileDir.trim()
        : typeof detection.profileDir === 'string' && detection.profileDir.trim() !== ''
          ? detection.profileDir
          : undefined
    const located = locateToolRestrictFile({ profileDir: resolvedProfileDir })
    if (located === undefined) {
      warn('未找到 qq-agent-presets/qq-tool-restrict.mjs（profile 依赖与 node_modules 均无），跳过自动补丁')
      return { status: 'no-target', reason: 'target file not found', statePath }
    }
    const filePath = located.filePath

    const text = readTextSafe(filePath)
    if (text === undefined) {
      warn(`读取目标文件失败，跳过自动补丁：${filePath}`)
      return { status: 'failed', filePath, reason: 'target file unreadable', statePath }
    }

    const preview = patchText(text)
    if (preview.status === 'already') {
      info(`白名单已包含 ${AUTO_PATCH_TOOL_NAMES.join(' / ')}，无需补丁`)
      return { status: 'already', filePath, statePath }
    }
    if (preview.status !== 'patchable') {
      warn(`qq-tool-restrict.mjs 结构无法识别，跳过自动补丁（${preview.reason ?? 'unknown'}）：${filePath}`)
      return { status: 'failed', filePath, reason: `unsupported: ${preview.reason ?? 'unknown'}`, statePath }
    }

    // 只读保护放在备份之前：不能连备份都写不进去才发现只读。
    const readOnlyReason = checkWritable(filePath)
    if (readOnlyReason !== undefined) {
      warn(`目标文件不可写，跳过自动补丁（${readOnlyReason}）：${filePath}`)
      return { status: 'failed', filePath, reason: readOnlyReason, statePath }
    }

    const beforeHash = hashText(text)
    const previousState = readAutopatchState(memoryDir)
    const previousRecord = findPatchRecord(previousState, filePath)
    // 记录里的 afterHash 是上一次"我们写出来的文件"的 hash；现在不一致且三名字又缺失，
    // 说明 Derpyu 被更新/覆盖过 → 这是 D14 的更新自愈场景（仅用于日志与 reason）。
    const upstreamUpdated = previousRecord !== undefined && previousRecord.afterHash !== beforeHash
    const nowDate = normalizeNow(now)

    const backup = createBackup(filePath, nowDate, logger)
    if (backup.error !== undefined) {
      warn(`备份目标文件失败，未做任何写入：${errorMessage(backup.error)}`)
      return { status: 'failed', filePath, reason: `backup failed: ${errorMessage(backup.error)}`, statePath }
    }
    const backupPath = backup.backupPath

    const writeError = atomicWriteFile(filePath, preview.text)
    if (writeError !== undefined) {
      warn(`写入补丁失败（原文件保持原样，备份在 ${backupPath}）：${errorMessage(writeError)}`)
      return { status: 'failed', filePath, backupPath, reason: `write failed: ${errorMessage(writeError)}`, statePath }
    }

    // 状态记录放最后：文件已经改成功，记录失败只意味着下次启动重新评估（幂等，无副作用）。
    const afterHash = hashText(preview.text)
    if (statePath !== undefined) {
      const record = {
        target: PACKAGE_NAME,
        filePath,
        beforeHash,
        afterHash,
        patchedAt: nowDate.toISOString(),
        backupPath,
      }
      if (!writeAutopatchState(statePath, upsertPatchRecord(previousState, record))) {
        warn(`补丁状态写入失败（下次启动会重新评估，不影响已生效的补丁）：${statePath}`)
      }
    }
    info(`已向 qq-tool-restrict.mjs 注入 ${AUTO_PATCH_TOOL_NAMES.join(' / ')}（备份：${backupPath}）`)
    return {
      status: 'patched',
      filePath,
      backupPath,
      statePath,
      ...(upstreamUpdated ? { reason: 'upstream-updated' } : {}),
    }
  } catch (error) {
    // 最后一道防线：任何未预期异常都只回 failed，绝不把异常抛给插件启动流程。
    logLine(logger, 'warn', `自动补丁异常，已跳过：${errorMessage(error)}`)
    return { status: 'failed', reason: `unexpected: ${errorMessage(error)}`, statePath }
  }
}
