/**
 * dsh-rofm engine — configuration.
 *
 * `DEFAULT_CONFIG` is the documented schema (docs/SPEC.md §2). `loadConfig`
 * deep-merges `DEFAULT_CONFIG <- config.json <- overrides` and validates every
 * knob: invalid values are replaced with their default and a human readable
 * string is appended to `cfg.warnings` (never throws, unknown keys preserved).
 *
 * @typedef {typeof DEFAULT_CONFIG & { warnings: string[] }} MemoryConfig
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Repository / plugin root (the DSH adapter `index.js` lives there). */
export const PLUGIN_ROOT = path.resolve(ENGINE_DIR, '..')

/** Built-in English stopwords (keyword extraction only, never α signals). */
const EN_STOPWORDS = [
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any',
  'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both',
  'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few',
  'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers',
  'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of',
  'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over',
  'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their',
  'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you',
  'your', 'yours', 'yourself', 'yourselves', 'ok', 'okay', 'yeah', 'please', 'thanks',
]

/** Built-in Chinese stopwords / filler words (keyword extraction only). */
const ZH_STOPWORDS = [
  '的', '了', '着', '过', '是', '在', '我', '你', '您', '他', '她', '它', '我们', '你们',
  '他们', '她们', '它们', '这', '那', '这个', '那个', '这些', '那些', '什么', '怎么',
  '怎样', '如何', '为什么', '可以', '需要', '应该', '必须', '一个', '一些', '没有',
  '不是', '就是', '还有', '然后', '因为', '所以', '但是', '如果', '的话', '一下',
  '已经', '现在', '可能', '知道', '觉得', '时候', '问题', '东西', '事情', '这样',
  '那样', '以及', '或者', '而且', '不过', '还是', '只是', '很多', '非常', '真的',
  '嗯', '哦', '啊', '吧', '呢', '吗', '呀', '呗', '把', '被', '给', '让', '从', '到',
  '对', '于', '与', '和', '及', '等', '中', '上', '下', '里', '后', '前', '会', '能',
  '要', '就', '都', '也', '又', '还', '很', '太', '更', '最', '好', '去', '来', '说',
  '做', '用', '请', '帮忙', '帮我', '麻烦', '谢谢', '请问', '一种', '一样', '一直',
  '那么', '这么', '这里', '那里', '看看', '一点', '而是', '并且', '虽然', '然而',
  '于是', '因此', '其中', '其他', '另外', '开始', '目前', '之前', '之后', '以后',
  '以前', '比较', '进行', '通过', '根据', '关于', '对于', '由于', '以便', '同时',
  '曾经', '正在', '继续', '一起', '不同', '相关', '所有', '每个', '任何', '当然',
  '其实', '基本', '一般', '大概', '就是', '这样', '那样', '时候', '现在',
]

/** Built-in zh + en stopword list exposed through `keywords.stopwords`. */
export const BUILTIN_STOPWORDS = Object.freeze([...EN_STOPWORDS, ...ZH_STOPWORDS])

// ---------------------------------------------------------------------------
// β (信赖度 / trust) — fixed constants, deliberately NOT configuration knobs
// ---------------------------------------------------------------------------

/** Lowest β. */
export const BETA_MIN = -10
/** Highest β. */
export const BETA_MAX = 10
/** β used when the model never scored a folder (old folders, heuristic path). */
export const DEFAULT_BETA = 0

/**
 * Normalize a β value: a finite number is clamped to [BETA_MIN, BETA_MAX] and
 * rounded to one decimal; anything else (undefined, NaN, ±Infinity, strings…)
 * falls back to DEFAULT_BETA. Never returns `-0`.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeBeta(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BETA
  const clamped = Math.min(BETA_MAX, Math.max(BETA_MIN, value))
  const rounded = Math.round((clamped + Number.EPSILON) * 10) / 10
  return Object.is(rounded, -0) ? 0 : rounded
}

export const DEFAULT_CONFIG = {
  compress: {
    enabled: true,
    triggerPercent: 60, // compress when the model context is above 60% of window
    compressPercent: 20, // remove the earliest 20% of the *used* context
    contextWindowTokens: 0, // 0 = host-provided; > 0 overrides the window (adapter resolveContextWindow, CLI fallback)
    minContextTokens: 512, // never compress a tiny context
    minMessagesToCompress: 4,
    minChunkChars: 200, // a recall folder smaller than this is merged forward
    targetChunkChars: 1200, // split the removed span into folders of ~this size
    maxFoldersPerRun: 500, // safety cap per archival run
    keepRecentMessages: 2, // never remove the newest N messages
    // Turn-boundary alignment may remove more than compressPercent. If the next
    // user boundary would overshoot the target by more than this factor, fall
    // back to the previous boundary (remove less), so one archival cannot
    // accidentally delete half of the context.
    maxBoundaryOvershoot: 1.25,
  },
  importance: {
    min: 0.01, // α lower bound
    max: 1, // α upper bound
    warnAbove: 0.8, // warn when α goes above this
    weights: {
      // each signal is in [0,1]; weights are normalised before use
      keywords: 0.3,
      decisions: 0.25,
      userDensity: 0.2,
      code: 0.1,
      recency: 0.15,
    },
  },
  keywords: {
    min: 3,
    max: 8,
    stopwords: [...BUILTIN_STOPWORDS],
    extraStopwords: [],
    matchMode: 'contains', // 'contains' | 'exact'
  },
  recall: {
    enabled: true,
    firstGenMax: 10, // gen-1 folders added back (successes), <= 10
    mu: 5, // p(n) = (1-erf((n-μ)/(σ√2))) / (1-erf((1-μ)/(σ√2)))
    sigma: 3,
    maxGeneration: 0, // 0 = unlimited
    probabilityScale: 1, // multiplier applied to every probability
    seed: 0, // 0 = non-deterministic; >0 = seeded PRNG (tests)
    sort: 'createdAt', // order of recalled context in the prompt
  },
  storage: {
    dir: 'memory', // relative to the plugin root
    indexFile: 'index.json',
    statsFile: 'stats.jsonl',
    maxFolders: 10000, // safety cap: refuse to create more
  },
  external: {
    enabled: false, // the plugin may call the engine out-of-process
    nodePath: '', // optional explicit node executable
    timeoutMs: 1500,
  },
  debug: { log: false },
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const isInteger = (v) => isFiniteNumber(v) && Number.isInteger(v)
const MAX_UINT32 = 0xffffffff

function fmt(value) {
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return '[function]'
  try {
    const s = JSON.stringify(value)
    return s === undefined ? String(value) : s
  } catch {
    return String(value)
  }
}

function replaceValue(warnings, label, value, fallback, requirement) {
  warnings.push(`${label}: expected ${requirement}; got ${fmt(value)}, using ${fmt(fallback)}`)
  return fallback
}

function numberField(warnings, label, value, fallback, opts = {}) {
  const { min = -Infinity, max = Infinity, integer = false, gt } = opts
  if (isFiniteNumber(value) && (!integer || Number.isInteger(value)) && (gt === undefined ? value >= min : value > gt) && value <= max) {
    return value
  }
  const kind = integer ? 'integer' : 'number'
  const requirement = gt === undefined
    ? `${kind} in [${min}, ${max}]`
    : `${kind} > ${gt}${max !== Infinity ? ` and <= ${max}` : ''}`
  return replaceValue(warnings, label, value, fallback, requirement)
}

function percentField(warnings, label, value, fallback) {
  if (isFiniteNumber(value) && value > 0 && value <= 100) return value
  return replaceValue(warnings, label, value, fallback, 'percentage in (0, 100]')
}

function booleanField(warnings, label, value, fallback) {
  if (typeof value === 'boolean') return value
  return replaceValue(warnings, label, value, fallback, 'boolean')
}

function enumField(warnings, label, value, allowed, fallback) {
  if (allowed.includes(value)) return value
  return replaceValue(warnings, label, value, fallback, `one of ${allowed.map((v) => fmt(v)).join(', ')}`)
}

function nonEmptyStringField(warnings, label, value, fallback) {
  if (typeof value === 'string' && value.trim()) return value
  return replaceValue(warnings, label, value, fallback, 'non-empty string')
}

function stringArrayField(warnings, label, value, fallback) {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.slice()
  return replaceValue(warnings, label, value, fallback, 'array of strings')
}

/**
 * Assign an own data property. A plain `target[key] = value` for a JSON key
 * named `__proto__` would invoke Object.prototype's setter and replace the
 * object prototype instead of storing the key (prototype pollution); unknown
 * config keys must be preserved (docs/SPEC.md §2), so define it as data.
 */
function setOwnProperty(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
  } else {
    target[key] = value
  }
}

/** Deep clone plain objects / arrays (used to protect DEFAULT_CONFIG). */
export function cloneConfig(value) {
  if (Array.isArray(value)) return value.map((v) => cloneConfig(v))
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) setOwnProperty(out, k, cloneConfig(v))
    return out
  }
  return value
}

/**
 * Deep merge plain objects. Arrays are replaced (not concatenated) and unknown
 * keys are preserved, which keeps forward compatibility easy.
 */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__') {
      // Own key, never the prototype setter (see setOwnProperty).
      setOwnProperty(out, key, isPlainObject(value) ? deepMerge({}, value) : Array.isArray(value) ? value.slice() : value)
      continue
    }
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else if (Array.isArray(value)) out[key] = value.slice()
    else out[key] = value
  }
  return out
}

/** Merge a partial (`patch`) into an already validated config. */
export function mergeConfig(base, patch) {
  return deepMerge(cloneConfig(base), patch)
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/**
 * Validate an already merged config object. Returns a *new* object with the
 * defaults filled in, every value clamped/replaced and a fresh `warnings` array.
 * @param {object} [input]
 * @returns {MemoryConfig}
 */
export function validateConfig(input) {
  const warnings = []
  const cfg = deepMerge(cloneConfig(DEFAULT_CONFIG), isPlainObject(input) ? input : {})
  for (const group of ['compress', 'importance', 'keywords', 'recall', 'storage', 'external', 'debug']) {
    if (!isPlainObject(cfg[group])) {
      warnings.push(`${group}: expected an object; using defaults`)
      cfg[group] = cloneConfig(DEFAULT_CONFIG[group])
    }
  }
  const c = cfg.compress
  const imp = cfg.importance
  const kw = cfg.keywords
  const rec = cfg.recall
  const st = cfg.storage
  const ex = cfg.external

  // --- compress -----------------------------------------------------------
  c.enabled = booleanField(warnings, 'compress.enabled', c.enabled, DEFAULT_CONFIG.compress.enabled)
  c.triggerPercent = percentField(warnings, 'compress.triggerPercent', c.triggerPercent, DEFAULT_CONFIG.compress.triggerPercent)
  c.compressPercent = percentField(warnings, 'compress.compressPercent', c.compressPercent, DEFAULT_CONFIG.compress.compressPercent)
  c.contextWindowTokens = numberField(warnings, 'compress.contextWindowTokens', c.contextWindowTokens, DEFAULT_CONFIG.compress.contextWindowTokens, { min: 0, integer: true })
  c.minContextTokens = numberField(warnings, 'compress.minContextTokens', c.minContextTokens, DEFAULT_CONFIG.compress.minContextTokens, { min: 0, integer: true })
  c.minMessagesToCompress = numberField(warnings, 'compress.minMessagesToCompress', c.minMessagesToCompress, DEFAULT_CONFIG.compress.minMessagesToCompress, { min: 1, integer: true })
  c.minChunkChars = numberField(warnings, 'compress.minChunkChars', c.minChunkChars, DEFAULT_CONFIG.compress.minChunkChars, { min: 1, integer: true })
  c.targetChunkChars = numberField(warnings, 'compress.targetChunkChars', c.targetChunkChars, DEFAULT_CONFIG.compress.targetChunkChars, { min: 1, integer: true })
  if (c.targetChunkChars < c.minChunkChars) {
    warnings.push(`compress.targetChunkChars: must be >= compress.minChunkChars (${c.minChunkChars}); raised to ${c.minChunkChars}`)
    c.targetChunkChars = c.minChunkChars
  }
  c.maxFoldersPerRun = numberField(warnings, 'compress.maxFoldersPerRun', c.maxFoldersPerRun, DEFAULT_CONFIG.compress.maxFoldersPerRun, { min: 1, integer: true })
  c.keepRecentMessages = numberField(warnings, 'compress.keepRecentMessages', c.keepRecentMessages, DEFAULT_CONFIG.compress.keepRecentMessages, { min: 0, integer: true })
  c.maxBoundaryOvershoot = numberField(warnings, 'compress.maxBoundaryOvershoot', c.maxBoundaryOvershoot, DEFAULT_CONFIG.compress.maxBoundaryOvershoot, { min: 1, max: 10 })

  // --- importance ---------------------------------------------------------
  imp.min = numberField(warnings, 'importance.min', imp.min, DEFAULT_CONFIG.importance.min, { min: 0.01, max: 1 })
  imp.max = numberField(warnings, 'importance.max', imp.max, DEFAULT_CONFIG.importance.max, { min: 0.01, max: 1 })
  if (imp.min > imp.max) {
    warnings.push(`importance.min: must be <= importance.max (got min=${fmt(imp.min)}, max=${fmt(imp.max)}); using defaults`)
    imp.min = DEFAULT_CONFIG.importance.min
    imp.max = DEFAULT_CONFIG.importance.max
  }
  imp.warnAbove = numberField(warnings, 'importance.warnAbove', imp.warnAbove, DEFAULT_CONFIG.importance.warnAbove, { min: 0, max: 1 })
  if (!isPlainObject(imp.weights)) {
    imp.weights = cloneConfig(DEFAULT_CONFIG.importance.weights)
    warnings.push('importance.weights: expected an object of numbers; using defaults')
  } else {
    for (const key of Object.keys(DEFAULT_CONFIG.importance.weights)) {
      imp.weights[key] = numberField(warnings, `importance.weights.${key}`, imp.weights[key], DEFAULT_CONFIG.importance.weights[key], { min: 0 })
    }
    const sum = Object.values(DEFAULT_CONFIG.importance.weights).reduce((acc, _v, i) => acc + imp.weights[Object.keys(DEFAULT_CONFIG.importance.weights)[i]], 0)
    if (!(sum > 0)) {
      imp.weights = cloneConfig(DEFAULT_CONFIG.importance.weights)
      warnings.push('importance.weights: all weights are zero; using defaults')
    }
  }

  // --- keywords -----------------------------------------------------------
  kw.min = numberField(warnings, 'keywords.min', kw.min, DEFAULT_CONFIG.keywords.min, { min: 1, integer: true })
  kw.max = numberField(warnings, 'keywords.max', kw.max, DEFAULT_CONFIG.keywords.max, { min: 1, integer: true })
  if (kw.max < kw.min) {
    warnings.push(`keywords.max: must be >= keywords.min (${kw.min}); raised to ${kw.min}`)
    kw.max = kw.min
  }
  kw.stopwords = stringArrayField(warnings, 'keywords.stopwords', kw.stopwords, [...BUILTIN_STOPWORDS])
  kw.extraStopwords = stringArrayField(warnings, 'keywords.extraStopwords', kw.extraStopwords, [])
  kw.matchMode = enumField(warnings, 'keywords.matchMode', kw.matchMode, ['contains', 'exact'], DEFAULT_CONFIG.keywords.matchMode)

  // --- recall -------------------------------------------------------------
  rec.enabled = booleanField(warnings, 'recall.enabled', rec.enabled, DEFAULT_CONFIG.recall.enabled)
  rec.firstGenMax = numberField(warnings, 'recall.firstGenMax', rec.firstGenMax, DEFAULT_CONFIG.recall.firstGenMax, { min: 0, integer: true })
  rec.mu = numberField(warnings, 'recall.mu', rec.mu, DEFAULT_CONFIG.recall.mu, { gt: 0 })
  rec.sigma = numberField(warnings, 'recall.sigma', rec.sigma, DEFAULT_CONFIG.recall.sigma, { gt: 0 })
  rec.maxGeneration = numberField(warnings, 'recall.maxGeneration', rec.maxGeneration, DEFAULT_CONFIG.recall.maxGeneration, { min: 0, integer: true })
  rec.probabilityScale = numberField(warnings, 'recall.probabilityScale', rec.probabilityScale, DEFAULT_CONFIG.recall.probabilityScale, { min: 0 })
  rec.seed = numberField(warnings, 'recall.seed', rec.seed, DEFAULT_CONFIG.recall.seed, { min: 0, max: MAX_UINT32, integer: true })
  rec.sort = enumField(warnings, 'recall.sort', rec.sort, ['createdAt', 'alpha', 'generation'], DEFAULT_CONFIG.recall.sort)

  // --- storage ------------------------------------------------------------
  st.dir = nonEmptyStringField(warnings, 'storage.dir', st.dir, DEFAULT_CONFIG.storage.dir)
  st.indexFile = nonEmptyStringField(warnings, 'storage.indexFile', st.indexFile, DEFAULT_CONFIG.storage.indexFile)
  st.statsFile = nonEmptyStringField(warnings, 'storage.statsFile', st.statsFile, DEFAULT_CONFIG.storage.statsFile)
  st.maxFolders = numberField(warnings, 'storage.maxFolders', st.maxFolders, DEFAULT_CONFIG.storage.maxFolders, { min: 1, integer: true })

  // --- external / debug ---------------------------------------------------
  ex.enabled = booleanField(warnings, 'external.enabled', ex.enabled, DEFAULT_CONFIG.external.enabled)
  ex.nodePath = typeof ex.nodePath === 'string' ? ex.nodePath : replaceValue(warnings, 'external.nodePath', ex.nodePath, '', 'string')
  ex.timeoutMs = numberField(warnings, 'external.timeoutMs', ex.timeoutMs, DEFAULT_CONFIG.external.timeoutMs, { gt: 0 })
  if (!isPlainObject(cfg.debug)) {
    warnings.push('debug: expected an object; using defaults')
    cfg.debug = { ...DEFAULT_CONFIG.debug }
  }
  cfg.debug.log = booleanField(warnings, 'debug.log', cfg.debug.log, DEFAULT_CONFIG.debug.log)

  cfg.warnings = warnings
  return cfg
}

/** Default location of the shared config file (optional). */
export function defaultConfigPath() {
  return path.join(PLUGIN_ROOT, 'config.json')
}

/**
 * Load `DEFAULT_CONFIG <- config.json <- overrides`, validate and return it.
 * The config file is optional. Only an explicitly passed `configPath` is read
 * (callers that want the shared file use `defaultConfigPath()`).
 *
 * @param {string|undefined|null} [configPath]
 * @param {object} [overrides]
 * @returns {MemoryConfig}
 */
export function loadConfig(configPath, overrides) {
  const fileWarnings = []
  let fileConfig = {}
  if (configPath) {
    try {
      const text = fs.readFileSync(configPath, 'utf8')
      const parsed = JSON.parse(text)
      if (isPlainObject(parsed)) fileConfig = parsed
      else fileWarnings.push(`config: ${configPath} does not contain a JSON object; ignored`)
    } catch (err) {
      const code = err && err.code ? err.code : 'error'
      if (code === 'ENOENT') fileWarnings.push(`config: ${configPath} not found; using defaults`)
      else fileWarnings.push(`config: cannot read ${configPath} (${code}: ${err && err.message ? err.message : err}); using defaults`)
    }
  }
  const merged = deepMerge(deepMerge(cloneConfig(DEFAULT_CONFIG), fileConfig), isPlainObject(overrides) ? overrides : {})
  const cfg = validateConfig(merged)
  cfg.warnings = [...fileWarnings, ...cfg.warnings]
  return cfg
}

/**
 * Adapter helper: deep-merge a config file (path or already parsed object) and
 * optional overrides into `DEFAULT_CONFIG`, returning a validated config with
 * `warnings`. `loadConfig` is the same thing for a path-only call.
 *
 * @param {string|object|undefined|null} fileConfigOrPath
 * @param {object} [overrides]
 * @returns {MemoryConfig}
 */
export function mergeConfigFile(fileConfigOrPath, overrides) {
  let fileConfig = {}
  if (typeof fileConfigOrPath === 'string') {
    try {
      const parsed = JSON.parse(fs.readFileSync(fileConfigOrPath, 'utf8'))
      if (isPlainObject(parsed)) fileConfig = parsed
    } catch {
      /* optional config file: silently fall back to defaults */
    }
  } else if (isPlainObject(fileConfigOrPath)) {
    fileConfig = fileConfigOrPath
  }
  const merged = deepMerge(deepMerge(cloneConfig(DEFAULT_CONFIG), fileConfig), isPlainObject(overrides) ? overrides : {})
  return validateConfig(merged)
}

/**
 * Resolve `storage.dir` to an absolute path (relative paths are relative to the
 * plugin root, i.e. the parent directory of `engine/`).
 * @param {object} [cfg]
 * @param {string} [baseDir]
 * @returns {string}
 */
export function resolveMemoryDir(cfg, baseDir) {
  const storage = (cfg && cfg.storage) || DEFAULT_CONFIG.storage
  const dir = typeof storage.dir === 'string' && storage.dir ? storage.dir : DEFAULT_CONFIG.storage.dir
  if (path.isAbsolute(dir)) return path.resolve(dir)
  return path.resolve(baseDir || PLUGIN_ROOT, dir)
}
