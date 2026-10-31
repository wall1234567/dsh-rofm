/**
 * dsh-rofm — QQ channel compatibility layer (compat).
 *
 * Two QQ plugins are supported, and nothing else:
 *
 *   1. `dsh-onebot-qq` — a Host plugin (OneBot 11 / NapCat). It inserts user
 *      messages with `source.kind === 'plugin:dsh-onebot'` and session ids
 *      shaped `onebot-<chatId>` (a collision/retire suffix `-<base36 ms>` may be
 *      appended, see `lib/chat.js` + `lib/registry.js` of that plugin), so rofm
 *      neither triggers recall nor keeps one memory folder per chat by default.
 *   2. `Derpyu520/qq-bridge` — an external bridge process talking to the DSH Web
 *      API. Its messages already carry `source.kind === 'user'` (the API's
 *      `session/prompt` builds that source), but its session ids are
 *      `qqb-<g|p>-<id>-<32 hex>` and get a **fresh random suffix** whenever the
 *      session is rebuilt (`/reset`, mode switch, preset conflict). Stripping the
 *      suffix yields a stable chat key, so memory survives a rebuild.
 *
 * This module is pure detection/parsing: no plugin state, no DSH imports, no
 * writes. The only file-system access is reading the profile (detection) and it
 * never throws — a missing/broken profile simply means "compat off".
 *
 * Everything here is gated by `compat.qqBots` (default `"auto"`); with no QQ
 * plugin installed the plugin behaviour must stay byte-identical to v1.2.1, so
 * `detect()` returns `enabled:false` and callers keep their original paths.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { expandHomePath } from './paths.js'

/** Session-id modes. `plain` = anything that is not one of the two QQ channels. */
export const COMPAT_MODES = Object.freeze({
  PLAIN: 'plain',
  ONEBOT: 'onebot',
  DERPYU: 'derpyu',
})

/** Accepted `compat.qqBots` values. */
export const QQ_BOTS_VALUES = Object.freeze(['auto', 'off', 'on'])

/** The three rofm model tools that must be whitelisted in Derpyu's preset. */
export const DERPYU_TOOL_NAMES = Object.freeze(['memory_judge', 'memory_recall', 'memory_image'])

/** `source.kind` used by dsh-onebot-qq for normal (and steer) user messages. */
export const ONEBOT_SOURCE_KIND = 'plugin:dsh-onebot'

/** Package names that identify either QQ plugin inside a profile. */
export const ONEBOT_PACKAGE = 'dsh-onebot-qq'
export const DERPYU_PACKAGES = Object.freeze(['qq-agent-presets', 'qq-mode-console'])

/**
 * Built-in `compat` defaults, merged under the user's config.json block.
 *
 * `mediaRoots: []` is deliberate: a local path found in a onebot message is only
 * archived when it resolves inside an explicitly allowed root, so an arbitrary
 * path in a group message can never pull a file into the memory folder.
 */
export const DEFAULT_COMPAT_CONFIG = Object.freeze({
  /** "auto" (detect), "off" (force off), "on" (force on). */
  qqBots: 'auto',
  /** QQ ids treated as the owner; only these bypass the member α gate. */
  ownerIds: Object.freeze([]),
  /** α floor for a recall triggered by a non-owner group member (0 = off). */
  memberMinAlpha: 0.5,
  /** Auto-inject the three rofm tool names into Derpyu's tool whitelist. */
  autoPatchDerpyu: true,
  /** "model" = memory_judge scoring; "heuristic" = degrade for channel sessions. */
  channelScore: 'model',
  /** Allowed roots for local media paths in onebot message text ([] = none). */
  mediaRoots: Object.freeze([]),
  /** Upper bound for one staged image, in bytes. */
  maxImageBytes: 8 * 1024 * 1024,
  /** Unarchived staging entries older than this are cleaned up. */
  stagingTtlMs: 24 * 60 * 60 * 1000,
})

/** Default value restored when a knob is invalid (per field, for warnings). */
const COMPAT_FIELD_DEFAULTS = DEFAULT_COMPAT_CONFIG

/** Session id of dsh-onebot-qq: `onebot-<chatId>[-<base36 ms>]`. */
export const ONEBOT_SESSION_RE = /^onebot-(.+)$/
/** Session id of Derpyu520/qq-bridge, from `encodeSelfKey` (`qq-self-key.mjs`). */
export const DERPYU_SESSION_RE = /^qqb-[gp]-\d+(?:-[a-f0-9]{32})?$/

/** Plausible epoch-ms window for an appended onebot collision suffix (2000..2100). */
const EPOCH_MIN_MS = 946684800000
const EPOCH_MAX_MS = 4102444800000
/** `Date.now().toString(36)` is 7–11 chars in any realistic epoch. */
const BASE36_SUFFIX_RE = /-([0-9a-z]{7,11})$/

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
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

function mtimeMsOf(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

/**
 * Validate + normalize the user-provided `compat` block.
 *
 * A missing block yields the built-in defaults **without warnings** (that is the
 * v1.2.1 compatible path); an invalid field is replaced by its default and
 * reported through the returned `warnings` array, which the config store appends
 * to `cfg.warnings` (surfaced in the host log on activation).
 *
 * `mediaRoots` entries follow the same portable rules as `storage.dir`: a
 * leading `~/` (or `~\`) expands to the user's home directory on every OS, an
 * absolute path is accepted as-is, a relative one resolves against the process
 * cwd (kept for backwards compatibility with the v1.3.0 behaviour).
 *
 * @param {unknown} raw
 * @param {{ homeDir?: string }} [options] test/caller override for `~` expansion
 * @returns {{ compat: ReturnType<typeof compatDefaults>, warnings: string[] }}
 */
export function normalizeCompatConfig(raw, options = {}) {
  const warnings = []
  const input = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    warnings.push('compat: expected an object; using defaults')
  }
  const compat = { ...compatDefaults(), ownerIds: [], mediaRoots: [] }

  if (input.qqBots !== undefined) {
    if (QQ_BOTS_VALUES.includes(input.qqBots)) compat.qqBots = input.qqBots
    else warnings.push(`compat.qqBots: expected one of ${QQ_BOTS_VALUES.join(', ')}; using "${COMPAT_FIELD_DEFAULTS.qqBots}"`)
  }

  if (input.ownerIds !== undefined) {
    if (Array.isArray(input.ownerIds)) {
      const ids = []
      let invalid = 0
      for (const item of input.ownerIds) {
        if (typeof item === 'string' && item.trim().length > 0) ids.push(item.trim())
        else if (isFiniteNumber(item)) ids.push(String(Math.trunc(item)))
        else invalid += 1
      }
      compat.ownerIds = [...new Set(ids)]
      // Duplicates are harmless (deduplicated silently); only a wrong *type*
      // is a configuration mistake worth surfacing.
      if (invalid > 0) {
        warnings.push('compat.ownerIds: expected an array of non-empty strings / numbers; invalid entries were dropped')
      }
    } else {
      warnings.push('compat.ownerIds: expected an array of strings; using []')
    }
  }

  compat.memberMinAlpha = boundedNumber(warnings, 'compat.memberMinAlpha', input.memberMinAlpha, COMPAT_FIELD_DEFAULTS.memberMinAlpha, 0, 1)
  compat.maxImageBytes = boundedNumber(warnings, 'compat.maxImageBytes', input.maxImageBytes, COMPAT_FIELD_DEFAULTS.maxImageBytes, 1, Number.MAX_SAFE_INTEGER, true)
  compat.stagingTtlMs = boundedNumber(warnings, 'compat.stagingTtlMs', input.stagingTtlMs, COMPAT_FIELD_DEFAULTS.stagingTtlMs, 0, Number.MAX_SAFE_INTEGER, true)

  if (input.autoPatchDerpyu !== undefined) {
    if (typeof input.autoPatchDerpyu === 'boolean') compat.autoPatchDerpyu = input.autoPatchDerpyu
    else warnings.push('compat.autoPatchDerpyu: expected a boolean; using true')
  }

  if (input.channelScore !== undefined) {
    if (input.channelScore === 'model' || input.channelScore === 'heuristic') compat.channelScore = input.channelScore
    else warnings.push('compat.channelScore: expected "model" or "heuristic"; using "model"')
  }

  if (input.mediaRoots !== undefined) {
    if (Array.isArray(input.mediaRoots)) {
      const roots = []
      for (const item of input.mediaRoots) {
        if (typeof item !== 'string' || item.trim().length === 0) continue
        const value = item.trim()
        // Portable `~/…` roots (all OSes) before the absolute/relative rules;
        // `expandHomePath` leaves `~user` and non-tilde values untouched.
        const expanded = expandHomePath(value, options)
        const root = typeof expanded === 'string' && expanded.length > 0 ? expanded : value
        roots.push(isAbsolute(root) ? root : resolve(root))
      }
      compat.mediaRoots = [...new Set(roots)]
    } else {
      warnings.push('compat.mediaRoots: expected an array of paths; using []')
    }
  }

  return { compat, warnings }
}

/** A fresh mutable copy of {@link DEFAULT_COMPAT_CONFIG}. */
export function compatDefaults() {
  return {
    qqBots: DEFAULT_COMPAT_CONFIG.qqBots,
    ownerIds: [],
    memberMinAlpha: DEFAULT_COMPAT_CONFIG.memberMinAlpha,
    autoPatchDerpyu: DEFAULT_COMPAT_CONFIG.autoPatchDerpyu,
    channelScore: DEFAULT_COMPAT_CONFIG.channelScore,
    mediaRoots: [],
    maxImageBytes: DEFAULT_COMPAT_CONFIG.maxImageBytes,
    stagingTtlMs: DEFAULT_COMPAT_CONFIG.stagingTtlMs,
  }
}

function boundedNumber(warnings, label, value, fallback, min, max, integer = false) {
  if (value === undefined) return fallback
  const numeric = Number(value)
  if (!isFiniteNumber(numeric) || (integer && !Number.isInteger(numeric)) || numeric < min || numeric > max) {
    warnings.push(`${label}: expected ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]; using ${fallback}`)
    return fallback
  }
  return numeric
}

// ---------------------------------------------------------------------------
// profile discovery
// ---------------------------------------------------------------------------

/**
 * Candidate profile directories, most specific first:
 *   1. `DSH_PROFILE_DIR` (absolute path of the active profile);
 *   2. `$DSH_HOME/profiles/$DSH_PROFILE`;
 *   3. `~/.dsh/profiles/desktop` (the documented fallback).
 *
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string }} [options]
 * @returns {string[]} unique absolute candidates
 */
export function profileDirCandidates(options = {}) {
  const env = isPlainObject(options.env) ? options.env : process.env
  const homeDir = typeof options.homeDir === 'string' && options.homeDir.length > 0 ? options.homeDir : os.homedir()
  const out = []
  const push = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) return
    const resolved = isAbsolute(value.trim()) ? value.trim() : resolve(value.trim())
    if (!out.includes(resolved)) out.push(resolved)
  }
  push(env.DSH_PROFILE_DIR)
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0 ? env.DSH_HOME.trim() : join(homeDir, '.dsh')
  const profileName = typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim().length > 0 ? env.DSH_PROFILE.trim() : 'desktop'
  push(join(dshHome, 'profiles', profileName))
  push(join(homeDir, '.dsh', 'profiles', 'desktop'))
  return out
}

/** First existing profile directory, or `undefined`. */
export function resolveProfileDir(options = {}) {
  for (const candidate of profileDirCandidates(options)) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

function packageDependencyNames(pkg) {
  const names = new Set()
  if (!isPlainObject(pkg)) return names
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const table = pkg[group]
    if (!isPlainObject(table)) continue
    for (const name of Object.keys(table)) names.add(name)
  }
  return names
}

/**
 * Scan one profile directory for the two supported QQ plugins.
 *
 * Detection is intentionally generous (three independent signals per plugin, as
 * decided in D1): a false negative would silently break the channel, while a
 * false positive only adds the onebot trigger kind and — for a *detected*
 * Derpyu — attempts the tool-whitelist patch, which itself is fail-safe.
 *
 * @param {string|undefined} profileDir
 * @returns {{ onebot: {detected: boolean, evidence: string[]}, derpyu: {detected: boolean, evidence: string[]} }}
 */
export function scanProfile(profileDir) {
  const result = { onebot: { detected: false, evidence: [] }, derpyu: { detected: false, evidence: [] } }
  if (typeof profileDir !== 'string' || profileDir.length === 0) return result
  const pkg = readJsonSafe(join(profileDir, 'package.json'))
  const deps = packageDependencyNames(pkg)
  const patchText = readTextSafe(join(profileDir, 'cordis.patch.yml')) ?? readTextSafe(join(profileDir, 'cordis.yml')) ?? ''
  const bundles = isPlainObject(pkg) && isPlainObject(pkg.dsh) && isPlainObject(pkg.dsh.profile) && Array.isArray(pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : []

  if (deps.has(ONEBOT_PACKAGE)) result.onebot.evidence.push(`package.json dependency: ${ONEBOT_PACKAGE}`)
  if (existsSync(join(profileDir, 'node_modules', ONEBOT_PACKAGE))) result.onebot.evidence.push(`node_modules/${ONEBOT_PACKAGE}`)
  if (patchText.includes(ONEBOT_PACKAGE)) result.onebot.evidence.push('patch references dsh-onebot-qq')

  for (const name of DERPYU_PACKAGES) {
    if (deps.has(name)) result.derpyu.evidence.push(`package.json dependency: ${name}`)
    if (bundles.includes(name)) result.derpyu.evidence.push(`dsh.profile.bundles: ${name}`)
    if (existsSync(join(profileDir, 'node_modules', name))) result.derpyu.evidence.push(`node_modules/${name}`)
  }
  if (patchText.includes('mcp-snowluma')) result.derpyu.evidence.push('patch references mcp-snowluma')
  if (patchText.includes('preset-qq-chat')) result.derpyu.evidence.push('patch references preset-qq-chat')

  result.onebot.detected = result.onebot.evidence.length > 0
  result.derpyu.detected = result.derpyu.evidence.length > 0
  return result
}

/**
 * One detection result.
 * @typedef {{
 *   enabled: boolean,
 *   qqBots: 'auto'|'off'|'on',
 *   profileDir?: string,
 *   onebot: { detected: boolean, evidence: string[] },
 *   derpyu: { detected: boolean, evidence: string[] },
 *   reasons: string[],
 *   warnings: string[],
 *   cacheKey: string,
 * }} CompatDetection
 */

/**
 * Detect whether either QQ plugin is installed, honouring `compat.qqBots`.
 *
 * Never throws: an unreadable/missing profile is reported through `warnings`
 * and yields `enabled:false` (except with the explicit `"on"` override).
 *
 * @param {{ profileDir?: string, qqBots?: string, env?: object, homeDir?: string }} [options]
 * @returns {CompatDetection}
 */
export function detectQqCompat(options = {}) {
  const qqBots = QQ_BOTS_VALUES.includes(options.qqBots) ? options.qqBots : DEFAULT_COMPAT_CONFIG.qqBots
  const warnings = []
  const reasons = []
  let profileDir = typeof options.profileDir === 'string' && options.profileDir.length > 0
    ? options.profileDir
    : resolveProfileDir({ env: options.env, homeDir: options.homeDir })
  if (qqBots === 'off') {
    const empty = { onebot: { detected: false, evidence: [] }, derpyu: { detected: false, evidence: [] } }
    return { enabled: false, qqBots, profileDir, ...empty, reasons: ['compat.qqBots=off'], warnings, cacheKey: 'off' }
  }
  if (profileDir === undefined) {
    warnings.push('compat: no DSH profile directory found; QQ channel compatibility stays off (set DSH_PROFILE_DIR or compat.qqBots="on")')
    const empty = { onebot: { detected: false, evidence: [] }, derpyu: { detected: false, evidence: [] } }
    return {
      enabled: qqBots === 'on',
      qqBots,
      profileDir: undefined,
      ...empty,
      reasons: ['profile not found'],
      warnings,
      cacheKey: 'no-profile',
    }
  }
  const scan = scanProfile(profileDir)
  const detected = scan.onebot.detected || scan.derpyu.detected
  const enabled = qqBots === 'on' ? true : detected
  if (scan.onebot.detected) reasons.push('dsh-onebot-qq')
  if (scan.derpyu.detected) reasons.push('derpyu-qq-bridge')
  if (qqBots === 'on' && !detected) reasons.push('forced by compat.qqBots=on')
  if (enabled && reasons.length === 0) reasons.push('forced')
  return {
    enabled,
    qqBots,
    profileDir,
    onebot: scan.onebot,
    derpyu: scan.derpyu,
    reasons,
    warnings,
    cacheKey: 'scanned',
  }
}

/**
 * Cached detector: re-scans the profile only when the configured mode or one of
 * the scanned files' mtime changed (D1: "配置热加载时按 profile 文件 mtime
 * 轻量重检"). Cheap enough to call on every config read.
 */
export class CompatDetector {
  /**
   * @param {{ env?: object, homeDir?: string, profileDirs?: string[] }} [options]
   *   `profileDirs` is an explicit override for tests (skips environment
   *   discovery and uses the directories verbatim).
   */
  constructor(options = {}) {
    this.env = options.env
    this.homeDir = options.homeDir
    this.profileDirs = Array.isArray(options.profileDirs) ? options.profileDirs.slice() : undefined
    this.cached = undefined
  }

  /** Candidate directories (explicit override wins over environment discovery). */
  candidates() {
    if (this.profileDirs !== undefined) return this.profileDirs.slice()
    return profileDirCandidates({ env: this.env, homeDir: this.homeDir })
  }

  /** Cheap change signal: mode + candidates + the mtimes of the scanned files. */
  signature(qqBots) {
    const parts = [String(qqBots)]
    for (const dir of this.candidates()) {
      parts.push(dir)
      for (const file of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
        parts.push(String(mtimeMsOf(join(dir, file))))
      }
    }
    return parts.join('|')
  }

  /**
   * Detect, reusing the previous result while the signature is unchanged.
   * @param {string} [qqBots]
   * @returns {CompatDetection}
   */
  detect(qqBots = DEFAULT_COMPAT_CONFIG.qqBots) {
    const mode = QQ_BOTS_VALUES.includes(qqBots) ? qqBots : DEFAULT_COMPAT_CONFIG.qqBots
    const signature = this.signature(mode)
    if (this.cached !== undefined && this.cached.signature === signature) return this.cached.detection
    let detection
    if (this.profileDirs !== undefined) {
      // Explicit directories: use the first existing one only, and do not fall
      // back to the environment (tests must stay hermetic).
      let profileDir
      for (const dir of this.profileDirs) {
        if (existsSync(dir)) {
          profileDir = dir
          break
        }
      }
      detection = detectQqCompat({ profileDir, qqBots: mode })
    } else {
      detection = detectQqCompat({ qqBots: mode, env: this.env, homeDir: this.homeDir })
    }
    this.cached = { signature, detection }
    return detection
  }
}

// ---------------------------------------------------------------------------
// session id → chat key
// ---------------------------------------------------------------------------

/**
 * Strip an appended onebot collision/retire suffix (`-<base36 ms>`).
 *
 * Only a suffix that parses as a plausible epoch millisecond value is removed,
 * so a chat id that legitimately ends in `-<base36 chars>` (or a 6-digit number)
 * is left alone.
 *
 * @param {string} value
 * @returns {{ base: string, suffix: string }}
 */
export function stripOnebotSuffix(value) {
  const text = typeof value === 'string' ? value : ''
  const match = BASE36_SUFFIX_RE.exec(text)
  if (!match) return { base: text, suffix: '' }
  const parsed = Number.parseInt(match[1], 36)
  if (!Number.isFinite(parsed) || parsed < EPOCH_MIN_MS || parsed >= EPOCH_MAX_MS) return { base: text, suffix: '' }
  const base = text.slice(0, text.length - match[0].length)
  if (base.length === 0) return { base: text, suffix: '' }
  return { base, suffix: match[1] }
}

/**
 * Map one session id to its channel mode and stable chat key.
 *
 * The chat key is what names the per-session memory folder
 * (`memory/sessions/<chatKey>/`), so a rebuilt Derpyu session (new random hex
 * suffix) or a retired onebot session (`-<timestamp>`) keeps using the same
 * memory folder. Plain sessions keep their id verbatim.
 *
 * @param {unknown} sessionId
 * @returns {{ mode: 'plain'|'onebot'|'derpyu', sessionId: string, chatKey: string, suffix: string }}
 */
export function parseSessionChatKey(sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (raw.length === 0) return { mode: COMPAT_MODES.PLAIN, sessionId: raw, chatKey: '', suffix: '' }

  const onebot = ONEBOT_SESSION_RE.exec(raw)
  if (onebot) {
    const { base, suffix } = stripOnebotSuffix(onebot[1])
    // Keep the `onebot-` namespace in the folder name: a chat id such as
    // "123456" must never collide with a WebUI session that happens to use it.
    return { mode: COMPAT_MODES.ONEBOT, sessionId: raw, chatKey: `onebot-${base}`, suffix }
  }

  if (DERPYU_SESSION_RE.test(raw)) {
    const hex = /-([a-f0-9]{32})$/.exec(raw)
    const suffix = hex ? hex[1] : ''
    const chatKey = hex ? raw.slice(0, raw.length - hex[0].length) : raw
    return { mode: COMPAT_MODES.DERPYU, sessionId: raw, chatKey, suffix }
  }

  return { mode: COMPAT_MODES.PLAIN, sessionId: raw, chatKey: raw, suffix: '' }
}

// ---------------------------------------------------------------------------
// onebot group-member identity
// ---------------------------------------------------------------------------

/** `<user_message qq="123" nickname="Nick">…</user_message>` (dsh-onebot-qq). */
const STRUCTURED_SENDER_RE = /<user_message\b[^>]*\bqq="([^"]+)"[^>]*>/i
const STRUCTURED_NICK_RE = /<user_message\b[^>]*\bnickname="([^"]*)"[^>]*>/i
/** Group prefix `[HH:MM nick(uid)]` (dsh-onebot-qq group formatting). */
const PREFIX_SENDER_RE = /\[(\d{1,2}:\d{2})\s+([^\]]*?)\((\d+)\)\]/

/**
 * Parse the sender identity out of a onebot message body.
 *
 * Group messages carry the identity inside the text (the plugin has no structured
 * sender field), in one of two formats. Private/WebUI messages carry neither and
 * are treated as "the user" by the caller.
 *
 * @param {unknown} text
 * @returns {{ ownerId: string|undefined, nickname: string, source: 'structured'|'prefix'|'none', restricted: boolean }}
 */
export function parseOwnerIdentity(text) {
  const none = { ownerId: undefined, nickname: '', source: 'none', restricted: false }
  if (typeof text !== 'string' || text.length === 0) return none
  const restricted = text.includes('[受限用户:仅问答]') || text.includes('[受限用户：仅问答]')
  const structured = STRUCTURED_SENDER_RE.exec(text)
  if (structured) {
    const nick = STRUCTURED_NICK_RE.exec(text)
    return { ownerId: structured[1].trim(), nickname: nick ? nick[1].trim() : '', source: 'structured', restricted }
  }
  const prefix = PREFIX_SENDER_RE.exec(text)
  if (prefix) return { ownerId: prefix[3].trim(), nickname: prefix[2].trim(), source: 'prefix', restricted }
  return { ...none, restricted }
}

/**
 * Recall gate for one inbox message (D4).
 *
 * Only onebot group traffic is gated: a message whose parsed sender is not in
 * `compat.ownerIds` recalls with `minAlpha = compat.memberMinAlpha`. Messages
 * without a sender marker (private chat / WebUI) and owner messages are ungated.
 *
 * @param {{
 *   mode: string,
 *   text?: string,
 *   compat?: object,
 * }} options
 * @returns {{ minAlpha: number, gated: boolean, ownerId?: string, nickname?: string, restricted?: boolean }}
 */
export function resolveRecallGate(options = {}) {
  const out = { minAlpha: 0, gated: false }
  if (options.mode !== COMPAT_MODES.ONEBOT) return out
  const identity = parseOwnerIdentity(options.text)
  out.ownerId = identity.ownerId
  out.nickname = identity.nickname
  out.restricted = identity.restricted
  if (identity.ownerId === undefined) return out
  const compat = isPlainObject(options.compat) ? options.compat : DEFAULT_COMPAT_CONFIG
  const ownerIds = Array.isArray(compat.ownerIds) ? compat.ownerIds : []
  if (ownerIds.includes(identity.ownerId)) return out
  const threshold = Number(compat.memberMinAlpha)
  if (!Number.isFinite(threshold) || threshold <= 0) return out
  out.minAlpha = Math.min(1, Math.max(0, threshold))
  out.gated = true
  return out
}

// ---------------------------------------------------------------------------
// trigger kinds / scoring mode
// ---------------------------------------------------------------------------

/**
 * Merge the onebot source kind into `recall.triggerSourceKinds` when compat is
 * enabled (C1). Plain sessions are unaffected: their messages are `user`.
 *
 * @param {string[]|undefined} configured
 * @param {{ enabled?: boolean }} detection
 * @returns {string[]}
 */
export function mergeTriggerSourceKinds(configured, detection) {
  const base = Array.isArray(configured) && configured.length > 0 ? configured.slice() : ['user']
  if (detection?.enabled !== true) return base
  if (base.includes(ONEBOT_SOURCE_KIND)) return base
  return [...base, ONEBOT_SOURCE_KIND]
}

/**
 * Whether a session id looks like one of the two channel sessions.
 * @param {string} mode result of {@link parseSessionChatKey}
 */
export function isChannelMode(mode) {
  return mode === COMPAT_MODES.ONEBOT || mode === COMPAT_MODES.DERPYU
}

/**
 * Decide how archiving scores a channel session (D8).
 *
 * `model` means folders land as "pending" and the current model scores them via
 * `memory_judge`; `heuristic` means the archive path fills α/keywords itself.
 * Derpyu degrades automatically when the tool-whitelist patch did not take
 * effect, because `memory_judge` would be rejected by that preset's guard.
 *
 * @param {{ mode: string, compat?: object, autopatchApplied?: boolean }} options
 * @returns {'model'|'heuristic'}
 */
export function resolveChannelScore(options = {}) {
  const compat = isPlainObject(options.compat) ? options.compat : DEFAULT_COMPAT_CONFIG
  if (!isChannelMode(options.mode)) return 'model'
  if (compat.channelScore === 'heuristic') return 'heuristic'
  if (options.mode === COMPAT_MODES.DERPYU && options.autopatchApplied !== true) return 'heuristic'
  return 'model'
}

/**
 * One human-readable log line for the activation log.
 * @param {CompatDetection} detection
 * @returns {string|undefined}
 */
export function detectionLogLine(detection) {
  if (!detection?.enabled) return undefined
  return `compat enabled (${detection.reasons.join(', ')})`
}
