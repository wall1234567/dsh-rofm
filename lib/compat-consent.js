/**
 * dsh-rofm — Derpyu520/qq-bridge 工具白名单注入的「用户授权」门禁（v1.5.7）。
 *
 * 背景：`lib/compat-autopatch.js` 会在检测到 Derpyu 后把 rofm 的四个工具名
 * 注入 `<profile>/node_modules/qq-agent-presets/qq-tool-restrict.mjs`。这是
 * **修改第三方插件文件**，而 qq-bridge 的白名单机制会让 rofm 在 QQ 渠道
 * "工具可见但执行被拒"（归档永远停在待评分、也不会主动回忆）。v1.5.7 起：
 *
 *   1. 第一次检测到需要注入的 Derpyu 时，先通过 Web GUI 弹一个系统提示窗
 *      请求授权（客户端半身 `client.js` + `ctx.connection.fetch` 路由）；
 *   2. 用户选「允许」→ 写入 allowed 决定，随后才执行白名单注入；
 *   3. 用户选「不允许」→ 写入 denied 决定，把 `enabled:false` 写进本机
 *      `config.local.json`，并在当前进程里立刻停用 rofm（默认关闭）。
 *
 * 设计原则：
 *   - 本模块是**纯状态/文件**逻辑，不 import DSH，不抛异常（失败用返回值）；
 *   - 决定只认「第一次」：`.compat-consent.json` 一旦写入就不再弹窗；
 *   - 配置 `compat.derpyuConsent: 'allow'` 是显式覆盖（同意），`'ask'`（默认）
 *     才是弹窗；默认 `enabled:false` 时插件在 start() 早退，根本不会检测；
 *   - 无 GUI / 无人回答时保持 pending，**绝不**在未授权的情况下写第三方文件。
 *
 * @module lib/compat-consent
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'

/** 状态文件版本（升级时用于识别旧记录）。 */
export const CONSENT_VERSION = 1
/** 状态文件名：落在调用方传入的 memoryDir 下，与 `.compat-state.json` 并列。 */
export const CONSENT_FILE_NAME = '.compat-consent.json'
/** 浏览器半身与宿主半身共用的同源接口路径（必须一致）。 */
export const CONSENT_ROUTE = '/api/rofm/derpyu-consent'
/** 允许的 `compat.derpyuConsent` 配置值：`ask` = 弹窗（默认），`allow` = 直接同意。 */
export const CONSENT_MODES = Object.freeze(['ask', 'allow'])
/** 配置缺省值（与 `DEFAULT_COMPAT_CONFIG.derpyuConsent` 一致）。 */
export const DEFAULT_CONSENT_MODE = 'ask'
/** 持久化的决定值。 */
export const CONSENT_DECISIONS = Object.freeze({ ALLOWED: 'allowed', DENIED: 'denied' })
/** 客户端 POST 的请求值。 */
export const CONSENT_ACTIONS = Object.freeze({ ALLOW: 'allow', DENY: 'deny' })
/** 本机私有配置（被 .gitignore 忽略）——deny 时写 enabled:false 的地方。 */
export const LOCAL_CONFIG_FILE = 'config.local.json'

/**
 * 拒绝后 rofm 是怎么被关掉的：
 *   - `bundle`：把 rofm 的设定开关（bundle）关掉；用户之后在设置里重新打开
 *     rofm 即视为「自行开启」→ 自动按允许处理并注入白名单（v1.5.7-final）；
 *   - `hard`：找不到插件管理服务时的回退：写 config.local.json `enabled:false`，
 *     只能删状态文件或显式 `derpyuConsent:"allow"` 重新开启。
 */
export const CONSENT_CLOSED_VALUES = Object.freeze(['bundle', 'hard'])

/**
 * 弹窗主文案（用户 v1.5.7 指定原文，中文必须逐字保留；英文只是非中文界面的兜底）。
 * `client.js` 不内嵌这段文字，而是从 GET 响应里取，保证只有一个真相。
 */
export const CONSENT_PROMPT = Object.freeze({
  zh: '由于qq-bridge的白名单机制会使rofm在QQ渠道失效且有恶劣影响，故请求您允许rofm将工具添加进白名单中，如您不允许，为防止恶劣后果，rofm会默认关闭，您后续可自行开启。',
  en: "qq-bridge's allow-list makes rofm fail on the QQ channel, with serious consequences. rofm therefore asks your permission to add its tools to that allow-list. If you do not allow it, rofm closes itself by default to prevent those consequences; you can re-enable it later.",
})

/** 弹窗标题。 */
export const CONSENT_TITLE = Object.freeze({
  zh: 'dsh-rofm：QQ 渠道白名单授权',
  en: 'dsh-rofm: QQ channel allow-list permission',
})

/** 两个按钮的文案。 */
export const CONSENT_ALLOW_LABEL = Object.freeze({ zh: '允许', en: 'Allow' })
export const CONSENT_DENY_LABEL = Object.freeze({ zh: '不允许', en: "Don't allow" })

/** 允许后的结果提示（客户端显示）。 */
export const CONSENT_ALLOWED_NOTICE = Object.freeze({
  zh: '已允许：rofm 会继续工作，并把四个工具名注入 qq-tool-restrict 白名单。',
  en: 'Allowed: rofm keeps working and injects its four tool names into the qq-tool-restrict allow-list.',
})

/** 拒绝后的结果提示（客户端显示）。 */
export const CONSENT_DENIED_NOTICE = Object.freeze({
  zh: '已按您的选择关闭 rofm（rofm 的设置开关已关闭）；之后在设置里重新打开 rofm 即可恢复使用（含白名单注入）。',
  en: 'rofm is now closed as you chose (its Settings switch is off); turning rofm back on in Settings restores it, including the allow-list injection.',
})

/** 白名单目标文件的展示用相对路径（目标绝对路径由检测结果提供）。 */
export const CONSENT_TARGET_HINT = 'qq-agent-presets/qq-tool-restrict.mjs'

/**
 * 需要注入的工具名（与 `compat-autopatch.js` 的 `AUTO_PATCH_TOOL_NAMES` 一致）。
 * 这里只用于提示文案，真正的注入列表以 `compat-autopatch.js` 为准。
 */
export const CONSENT_TOOL_NAMES = Object.freeze(['memory_judge', 'memory_recall', 'memory_image', 'memory_group_recall'])

/**
 * 弹窗里「这次要改什么」的说明文案（目标路径已知时带出）。
 * @param {{ targetFile?: string }} [options]
 * @returns {{ zh: string, en: string }}
 */
export function consentDetail({ targetFile } = {}) {
  const target =
    typeof targetFile === 'string' && targetFile.trim().length > 0 ? targetFile.trim() : CONSENT_TARGET_HINT
  return {
    zh: `将把 ${CONSENT_TOOL_NAMES.join(' / ')} 注入 ${target} 的 SAFE_EXACT 白名单（只改这一个文件，写前备份、原子替换）。`,
    en: `It will add ${CONSENT_TOOL_NAMES.join(' / ')} to SAFE_EXACT in ${target} (only that one file, backed up before the atomic write).`,
  }
}

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

/**
 * `.compat-consent.json` 的机器级状态目录：`$DSH_HOME/rofm/`（默认 `~/.dsh/rofm/`）。
 *
 * v1.5.7-final 起授权决定**不再放在插件目录的 `memory/`**：naive 安装（npm 包
 * 被 DSH 更新/重装替换）或改 `storage.dir` 都会让插件目录里的状态丢失，
 * 从而在每次更新后重新弹窗，违背「只问一次」。DSH_HOME 是机器级目录，
 * 与插件安装方式、profile、memory 路径都无关。
 *
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string }} [options]
 * @returns {string}
 */
export function consentStateDir(options = {}) {
  const env = options !== null && typeof options === 'object' && options.env !== undefined ? options.env : process.env
  const explicitHome = options !== null && typeof options === 'object' && typeof options.homeDir === 'string' ? options.homeDir : ''
  let homeDir = explicitHome
  if (homeDir.length === 0) {
    try {
      homeDir = os.homedir()
    } catch {
      homeDir = ''
    }
  }
  const dshHome = env !== null && typeof env === 'object' && typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0
    ? env.DSH_HOME.trim()
    : homeDir.length > 0
      ? join(homeDir, '.dsh')
      : ''
  return dshHome.length > 0 ? join(dshHome, 'rofm') : ''
}

/**
 * 机器级授权状态文件路径；家目录解析失败时返回空串（写失败会降级为「下次再问」）。
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string }} [options]
 * @returns {string}
 */
export function consentFilePath(options = {}) {
  const dir = consentStateDir(options)
  return dir.length > 0 ? join(dir, CONSENT_FILE_NAME) : ''
}

/**
 * v1.5.7 早期构建的安装级状态路径（`<memoryDir>/.compat-consent.json`）。
 * 只用于**迁移**旧决定，避免升级后重复弹窗；新写入一律走 {@link consentFilePath}。
 * @param {unknown} memoryDir
 * @returns {string|undefined}
 */
export function legacyConsentFilePath(memoryDir) {
  return typeof memoryDir === 'string' && memoryDir.trim().length > 0 ? join(memoryDir, CONSENT_FILE_NAME) : undefined
}

/** 合法决定值判断。 */
function isDecision(value) {
  return value === CONSENT_DECISIONS.ALLOWED || value === CONSENT_DECISIONS.DENIED
}

/**
 * 校验并规范化一条状态记录；非法记录视为「没有决定」（会再次弹窗）。
 * @param {unknown} raw
 * @returns {{ version: number, decision: 'allowed'|'denied', at: number }|undefined}
 */
export function normalizeConsentRecord(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  if (!isDecision(raw.decision)) return undefined
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) && raw.at > 0 ? raw.at : Date.now()
  const record = { version: CONSENT_VERSION, decision: raw.decision, at }
  if (CONSENT_CLOSED_VALUES.includes(raw.closed)) record.closed = raw.closed
  return record
}

/**
 * 读取已持久化的授权决定（机器级状态文件优先，随后尝试迁移候选路径）。
 * 文件不存在/损坏/路径不可用都返回 undefined；**绝不抛异常**。
 *
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string, legacyPaths?: string[] }} [options]
 * @returns {{ version: number, decision: 'allowed'|'denied', at: number, path: string }|undefined}
 */
export function readConsent(options = {}) {
  const files = []
  const primary = consentFilePath(options)
  if (primary.length > 0) files.push(primary)
  for (const legacy of Array.isArray(options?.legacyPaths) ? options.legacyPaths : []) {
    if (typeof legacy === 'string' && legacy.length > 0 && !files.includes(legacy)) files.push(legacy)
  }
  for (const file of files) {
    try {
      const record = normalizeConsentRecord(JSON.parse(readFileSync(file, 'utf8')))
      if (record !== undefined) return { ...record, path: file }
    } catch {
      // 下一个候选；全失败 = 还没有决定。
    }
  }
  return undefined
}

/**
 * 原子写入一条授权决定到机器级状态文件（tmp + rename，先 mkdir）。
 * @param {'allowed'|'denied'} decision
 * @param {{ at?: number, now?: () => number, env?: Record<string, string|undefined>, homeDir?: string }} [options]
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
export function writeConsent(decision, options = {}) {
  const file = consentFilePath(options)
  if (file.length === 0) return { ok: false, error: 'cannot resolve the DSH home directory for the consent state' }
  if (!isDecision(decision)) return { ok: false, error: `invalid consent decision: ${String(decision)}` }
  const now = typeof options.now === 'function' ? options.now : Date.now
  const at = typeof options.at === 'number' && Number.isFinite(options.at) ? options.at : now()
  const record = { version: CONSENT_VERSION, decision, at }
  if (CONSENT_CLOSED_VALUES.includes(options.closed)) record.closed = options.closed
  const body = `${JSON.stringify(record, null, 2)}\n`
  const tmp = `${file}.tmp-${process.pid}-${at}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, file)
    return { ok: true, path: file }
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // 清理失败不影响"写失败"这个结论。
    }
    return { ok: false, path: file, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// 门禁判断
// ---------------------------------------------------------------------------

/** 读取 `compat.derpyuConsent`；非法值回退默认（normalizeCompatConfig 已校验）。 */
export function consentModeOf(compat) {
  if (typeof compat === 'object' && compat !== null && CONSENT_MODES.includes(compat.derpyuConsent)) {
    return compat.derpyuConsent
  }
  return DEFAULT_CONSENT_MODE
}

/**
 * 计算一次检测下的授权状态。纯函数、无 IO。
 *
 * - `prompt`：需要弹窗（检测到 Derpyu + 自动补丁开启 + 未决定 + 配置是 ask）；
 * - `patchAllowed`：可以注入白名单（配置 allow 或已持久化 allowed）；
 * - `denied`：已持久化 denied（此时绝不注入；调用方决定是否已停用整个插件）；
 * - `detected`：本次检测到 Derpyu。
 *
 * @param {{
 *   detection?: { derpyu?: { detected?: boolean } },
 *   compat?: Record<string, unknown>,
 *   record?: { decision?: string }|undefined,
 * }} [input]
 * @returns {{ detected: boolean, patchEnabled: boolean, mode: 'ask'|'allow',
 *   decision: 'allowed'|'denied'|undefined, prompt: boolean,
 *   patchAllowed: boolean, denied: boolean }}
 */
export function describeConsentState({ detection, compat, record } = {}) {
  const detected = detection?.derpyu?.detected === true
  const patchEnabled = !(compat !== null && typeof compat === 'object' && compat.autoPatchDerpyu === false)
  const mode = consentModeOf(compat)
  const decision = isDecision(record?.decision) ? record.decision : undefined
  const forcedAllow = mode === 'allow'
  const prompt = detected && patchEnabled && !forcedAllow && decision === undefined
  const patchAllowed = detected && patchEnabled && (forcedAllow || decision === CONSENT_DECISIONS.ALLOWED)
  return {
    detected,
    patchEnabled,
    mode,
    decision,
    prompt,
    patchAllowed,
    denied: decision === CONSENT_DECISIONS.DENIED,
  }
}

/**
 * 把浏览器 POST 的请求体规范化为 `allow` / `deny`；非法返回 undefined。
 * @param {unknown} body 已解析的 JSON
 * @returns {'allow'|'deny'|undefined}
 */
export function normalizeConsentAction(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const action = body.decision
  if (action === CONSENT_ACTIONS.ALLOW || action === CONSENT_ACTIONS.DENY) return action
  return undefined
}

/**
 * 浏览器 GET 响应体（客户端半身据此决定是否弹窗）。
 *
 * @param {{
 *   state: ReturnType<typeof describeConsentState>,
 *   pluginVersion?: string,
 *   targetFile?: string,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function consentPayload({ state, pluginVersion, targetFile } = {}) {
  const detail = consentDetail({ targetFile })
  return {
    ok: true,
    pending: state?.prompt === true,
    detected: state?.detected === true,
    decision: state?.decision ?? null,
    patchAllowed: state?.patchAllowed === true,
    patchEnabled: state?.patchEnabled === true,
    consentMode: state?.mode ?? DEFAULT_CONSENT_MODE,
    pluginVersion: typeof pluginVersion === 'string' ? pluginVersion : 'unknown',
    title: { zh: CONSENT_TITLE.zh, en: CONSENT_TITLE.en },
    message: { zh: CONSENT_PROMPT.zh, en: CONSENT_PROMPT.en },
    detail,
    allowLabel: { zh: CONSENT_ALLOW_LABEL.zh, en: CONSENT_ALLOW_LABEL.en },
    denyLabel: { zh: CONSENT_DENY_LABEL.zh, en: CONSENT_DENY_LABEL.en },
    allowedNotice: { zh: CONSENT_ALLOWED_NOTICE.zh, en: CONSENT_ALLOWED_NOTICE.en },
    deniedNotice: { zh: CONSENT_DENIED_NOTICE.zh, en: CONSENT_DENIED_NOTICE.en },
    targetFile: typeof targetFile === 'string' && targetFile.trim().length > 0 ? targetFile.trim() : null,
  }
}

// ---------------------------------------------------------------------------
// 拒绝后关闭 rofm
// ---------------------------------------------------------------------------

/**
 * `config.local.json` 的绝对路径。
 * @param {unknown} pluginDir
 * @returns {string|undefined}
 */
export function localConfigPath(pluginDir) {
  return typeof pluginDir === 'string' && pluginDir.trim().length > 0 ? join(pluginDir, LOCAL_CONFIG_FILE) : undefined
}

/** Read `config.local.json` as a plain object; `{}` when the file is absent. */
function readLocalConfigObject(file) {
  if (!existsSync(file)) return { ok: true, current: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'config.local.json is not a JSON object' }
    }
    return { ok: true, current: parsed }
  } catch (error) {
    return { ok: false, error: `config.local.json is not readable JSON: ${errorMessage(error)}` }
  }
}

/** Atomic write of `config.local.json` (tmp + rename); never leaves a partial file. */
function writeLocalConfigObject(file, next, now) {
  const tmp = `${file}.tmp-${process.pid}-${now()}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return { ok: true, path: file }
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // 清理失败不影响"写失败"这个结论。
    }
    return { ok: false, path: file, error: errorMessage(error) }
  }
}

/**
 * 把 `enabled:false` 写进本机私有配置（`config.local.json`），保留其它键。
 *
 * **回退路径**：只有在无法自动关闭 rofm 的设定开关（bundle）时才调用；
 * 正常拒绝现在走 {@link clearLocalDisable}（设置开关关闭，重新打开=允许）。
 * 文件损坏（不是合法 JSON 对象）时**不覆盖**用户文件，只返回失败原因。
 *
 * @param {unknown} pluginDir 插件根目录
 * @param {{ now?: () => number }} [options]
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
export function writeLocalDisable(pluginDir, options = {}) {
  const file = localConfigPath(pluginDir)
  if (file === undefined) return { ok: false, error: 'pluginDir is not a usable path' }
  const read = readLocalConfigObject(file)
  if (!read.ok) return { ok: false, path: file, error: read.error }
  const now = typeof options.now === 'function' ? options.now : Date.now
  return writeLocalConfigObject(file, { ...read.current, enabled: false }, now)
}

/**
 * 清掉 `config.local.json` 里的 `enabled` 键（恢复默认 true），保留其它键。
 *
 * 用户拒绝后如果 rofm 曾被回退为 `enabled:false` 硬关闭，而之后又把 rofm
 * 重新启用，需要清掉这个键；正常 bundle 关闭路径不会写它。
 *
 * @param {unknown} pluginDir 插件根目录
 * @param {{ now?: () => number }} [options]
 * @returns {{ ok: boolean, path?: string, changed?: boolean, error?: string }}
 */
export function clearLocalDisable(pluginDir, options = {}) {
  const file = localConfigPath(pluginDir)
  if (file === undefined) return { ok: false, error: 'pluginDir is not a usable path' }
  const read = readLocalConfigObject(file)
  if (!read.ok) return { ok: false, path: file, error: read.error }
  if (!Object.prototype.hasOwnProperty.call(read.current, 'enabled')) {
    return { ok: true, path: file, changed: false }
  }
  const now = typeof options.now === 'function' ? options.now : Date.now
  const next = { ...read.current }
  delete next.enabled
  const written = writeLocalConfigObject(file, next, now)
  return written.ok ? { ...written, changed: true } : written
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
