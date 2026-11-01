/**
 * v1.4.0 config consistency (docs/SPEC.md §2, README §3).
 *
 * There is exactly one default truth: `engine/config.js` `DEFAULT_CONFIG`.
 * The packaged `config.json` overrides only two product values on purpose
 * (`time.mode='constrain'`, `time.timezone='Asia/Shanghai'`), and the README /
 * SPEC tables are the user-facing documentation of those defaults. This test
 * fails the release when any of the three drifts:
 *
 *   1. `DEFAULT_CONFIG` vs the shipped `config.json` (every engine key, with the
 *      two documented product overrides whitelisted);
 *   2. the shipped `config.json` vs the documented values in README §3 and
 *      SPEC §2 (triggerPercent / recall.mode / time.mode / fairness / scoring /
 *      match / compress guards);
 *   3. `package.json` vs `engine/package.json` version, both pinned to 1.4.0;
 *   4. `CHANGELOG.md` has a non-empty `## [1.4.0]` section (the release tool
 *      refuses to run without it).
 *
 * Expected-on-purpose differences are listed explicitly below so a future
 * release cannot silently "fix" one side only.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, loadConfig } from '../engine/config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

const shipped = JSON.parse(read('config.json'))
const pluginPackage = JSON.parse(read('package.json'))
const enginePackage = JSON.parse(read('engine/package.json'))
const readme = read('README.md')
const spec = read('docs/SPEC.md')
const changelog = read('CHANGELOG.md')

/** The version this release ships. */
const EXPECTED_VERSION = '1.4.0'

/**
 * Keys the packaged product config may override relative to `DEFAULT_CONFIG`.
 * Everything else must be byte-identical, otherwise the docs are lying about
 * what a fresh install actually runs.
 */
const PRODUCT_OVERRIDES = Object.freeze({
  'time.mode': 'constrain',
  'time.timezone': 'Asia/Shanghai',
})

/**
 * Keys the packaged product config may omit: their values are the built-in
 * engine defaults and were never part of the shipped `config.json` (the
 * `keywords.stopwords` list is ~200 words of noise in a user-facing config, and
 * `external`/`debug` are dormant engine knobs). Omitting a key means "use the
 * engine default", which is exactly what the documentation says.
 */
const INHERITED_DEFAULTS = Object.freeze([
  'keywords.stopwords',
  'external.enabled',
  'external.nodePath',
  'external.timeoutMs',
  'debug.log',
])

/** Flatten a config object into `group.key[.key] -> value` (arrays are leaves). */
function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) out[prefix] = value
    return out
  }
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key
    flatten(child, name, out)
  }
  return out
}

/** Read a documented default out of a Markdown table row: `| `key` | `value` |`. */
function tableValue(document, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp('^\\|\\s*`' + escaped + '`\\s*\\|\\s*`([^`]+)`\\s*\\|', 'm').exec(document)
  return match ? match[1] : null
}

const engineKeys = flatten(DEFAULT_CONFIG)
const shippedKeys = flatten(shipped)

test('config: DEFAULT_CONFIG and the packaged config.json are the single default truth', () => {
  const mismatches = []
  const missing = []
  for (const [key, expected] of Object.entries(engineKeys)) {
    const own = Object.prototype.hasOwnProperty.call(shippedKeys, key)
    const shippedValue = own ? shippedKeys[key] : undefined
    if (Object.prototype.hasOwnProperty.call(PRODUCT_OVERRIDES, key)) {
      if (shippedValue !== PRODUCT_OVERRIDES[key]) {
        mismatches.push(`${key}: packaged ${JSON.stringify(shippedValue)} != product override ${JSON.stringify(PRODUCT_OVERRIDES[key])}`)
      }
      if (expected === PRODUCT_OVERRIDES[key]) {
        mismatches.push(`${key}: engine default already equals the product override (drop the override or the duplicate)`)
      }
      continue
    }
    if (!own) {
      if (!INHERITED_DEFAULTS.includes(key)) missing.push(`${key}: packaged config.json omits it but it is not an inherited default`)
      continue
    }
    if (JSON.stringify(expected) !== JSON.stringify(shippedValue)) {
      mismatches.push(`${key}: packaged ${JSON.stringify(shippedValue)} != engine default ${JSON.stringify(expected)}`)
    }
  }
  assert.deepEqual(missing, [], 'only the documented INHERITED_DEFAULTS may be omitted from the packaged config.json')
  assert.deepEqual(mismatches, [], 'packaged config.json must match engine/config.js DEFAULT_CONFIG (except the documented time overrides)')

  // Exactly the two documented overrides — no third surprise.
  const overrides = Object.keys(engineKeys).filter(
    (key) => Object.prototype.hasOwnProperty.call(shippedKeys, key) && JSON.stringify(shippedKeys[key]) !== JSON.stringify(engineKeys[key]),
  )
  assert.deepEqual(overrides.sort(), Object.keys(PRODUCT_OVERRIDES).sort(), 'only the documented product overrides may differ')
})

test('config: shipped config.json loads without warnings and keeps triggerPercent=60', () => {
  const cfg = loadConfig(path.join(ROOT, 'config.json'))
  assert.deepEqual(cfg.warnings, [], 'the shipped config.json must be valid without fallback warnings')
  assert.equal(cfg.compress.triggerPercent, 60, 'v1.4.0 unifies the archive trigger at 60%')
  assert.equal(cfg.recall.mode, 'fair', 'fair (FAIR-DRI) is the default recall mode')
  assert.equal(cfg.time.mode, 'constrain', 'the packaged product enables time-constrained recall')
  assert.equal(cfg.time.timezone, 'Asia/Shanghai', 'the packaged product pins the +08 day/month/year boundaries')
  assert.equal(cfg.compress.maxFoldersPerRun, 500)
  assert.equal(cfg.storage.maxFolders, 10000)
})

test('config: every new v1.4.0 key is present in the packaged config.json', () => {
  // compress guards (P0-3 / P1-6 / transaction) — five new keys.
  assert.equal(shipped.compress.protectCurrentTurn, true)
  assert.equal(shipped.compress.allowSmallWindow, false)
  assert.equal(shipped.compress.smallWindowTokens, 20000)
  assert.equal(shipped.compress.hardLimitStop, true)
  assert.equal(shipped.compress.maxFoldersPerStep, 500)
  // recall selector.
  assert.equal(shipped.recall.mode, 'fair')
  assert.equal(shipped.recall.hops, 0)
  assert.equal(shipped.recall.maxWindowPercent, 10)
  assert.equal(shipped.recall.minAlpha, 0)
  assert.equal(shipped.recall.fairness.thetaHigh, 0.6)
  assert.equal(shipped.recall.fairness.exploreRatio, 0.2)
  assert.deepEqual(shipped.recall.fairness.rareTerm, { ratio: 0.002, minPosting: 8, scanCap: 512 })
  assert.deepEqual(shipped.recall.fairness.register, { lookahead: 3, capFactor: 8, ttlRounds: 2 })
  assert.deepEqual(shipped.recall.fairness.recycle, { enabled: true, cooldownRounds: 15, maxPerRound: 1 })
  assert.deepEqual(shipped.recall.fairness.ledger, { maxEntries: 10000, overflow: 'evict-lowest-alpha-last-seen' })
  assert.deepEqual(shipped.recall.fairness.blockTrim, { policy: 'priority', protectCurrentQuery: true, pinHigh: true })
  assert.deepEqual(shipped.recall.fairness.roundBudget, { maxChars: 20000 })
  // time assistance.
  assert.equal(shipped.time.mode, 'constrain')
  assert.equal(shipped.time.timezone, 'Asia/Shanghai')
  assert.equal(shipped.time.minRangeDays, 3)
  assert.equal(shipped.time.maxRangeDays, 366)
  assert.deepEqual(shipped.time.fallback, ['day3', 'month', 'year', 'all'])
  assert.equal(shipped.time.centerDayPriority, true)
  assert.equal(shipped.time.fallbackMinResults, 1)
  assert.equal(shipped.time.windowScanMax, 4096)
  assert.equal(shipped.time.askUserHint, true)
  assert.equal(shipped.time.judgeEventTime, false)
  // scoring pipeline.
  assert.equal(shipped.scoring.includeLegacy, false)
  assert.equal(shipped.scoring.maxPending, 200)
  assert.equal(shipped.scoring.fallback, 'onPressure')
  assert.deepEqual(shipped.scoring.autoHeuristicAfterRounds, { plain: 4, channel: 2 })
  assert.equal(shipped.scoring.taskBudgetPercent, 15)
  assert.equal(shipped.scoring.taskMaxTokens, 12000)
  assert.equal(shipped.scoring.order, 'newest')
  assert.equal(shipped.scoring.warnUniformAlpha, true)
  assert.equal(shipped.scoring.maxItemsPerJudge, 100)
  // keyword matching.
  assert.deepEqual(shipped.match, { expandLatinCase: false, cjkBigram: false })
  // Existing keys that must survive the 1.4.0 rewrite of config.json.
  assert.equal(shipped.enabled, true)
  assert.equal(shipped.storage.perSession, true)
  assert.equal(shipped.storage.dir, 'memory')
  assert.ok(shipped.compat && typeof shipped.compat === 'object', 'the compat block must be preserved')
  assert.ok(shipped.logging && typeof shipped.logging === 'object', 'the logging block must be preserved')
  assert.ok(shipped.test && typeof shipped.test === 'object', 'the test block must be preserved')
})

test('config: shipped recall.mu/sigma/seed/maxGeneration are the legacy-only keys', () => {
  // Still documented as legacy-path knobs; fair/deterministic must not read them.
  assert.equal(shipped.recall.mu, 5)
  assert.equal(shipped.recall.sigma, 3)
  assert.equal(shipped.recall.maxGeneration, 0)
  assert.equal(shipped.recall.probabilityScale, 1)
  assert.equal(shipped.recall.seed, 0)
  assert.equal(shipped.recall.sort, 'createdAt')
})

test('docs: README config table documents the shipped values', () => {
  const expected = {
    'compress.triggerPercent': '60',
    'compress.allowSmallWindow': 'false',
    'compress.smallWindowTokens': '20000',
    'compress.hardLimitStop': 'true',
    'compress.maxFoldersPerStep': '500',
    'recall.mode': 'fair',
    'recall.fairness.thetaHigh': '0.6',
    'time.mode': 'constrain',
    'time.timezone': 'Asia/Shanghai',
    'time.minRangeDays': '3',
    'time.fallback': '["day3", "month", "year", "all"]',
    'scoring.maxPending': '200',
    'scoring.fallback': 'onPressure',
    'scoring.taskBudgetPercent': '15',
    'match.expandLatinCase': 'false',
  }
  const missing = []
  for (const [key, value] of Object.entries(expected)) {
    const documented = tableValue(readme, key)
    if (documented === null) missing.push(`${key}: no README §3 table row found`)
    else if (documented !== value) missing.push(`${key}: README says ${JSON.stringify(documented)}, engine ships ${JSON.stringify(value)}`)
  }
  assert.deepEqual(missing, [], 'README §3 must document the values engine/config.js actually ships')
  // The two product overrides must be explained (they differ from DEFAULT_CONFIG).
  assert.match(readme, /engine 默认[^\n]*index/, 'README must mention the engine time.mode default (index)')
  assert.match(readme, /Asia\/Shanghai/, 'README must mention the packaged timezone')
})

test('docs: SPEC §2 DEFAULT_CONFIG block documents the engine defaults', () => {
  assert.match(spec, /triggerPercent:\s*60/, 'SPEC §2 must document triggerPercent: 60')
  assert.match(spec, /mode:\s*'fair'/, "SPEC §2 must document recall.mode: 'fair'")
  assert.match(spec, /mode:\s*'index'/, "SPEC §2 must document the engine time.mode default 'index'")
  assert.match(spec, /timezone:\s*''/, "SPEC §2 must document the engine time.timezone default ''")
  assert.match(spec, /minRangeDays:\s*3/, 'SPEC §2 must document time.minRangeDays: 3')
  assert.match(spec, /thetaHigh:\s*0\.6/, 'SPEC §2 must document recall.fairness.thetaHigh: 0.6')
  assert.match(spec, /maxPending:\s*200/, 'SPEC §2 must document scoring.maxPending: 200')
  assert.match(spec, /taskBudgetPercent:\s*15/, 'SPEC §2 must document scoring.taskBudgetPercent: 15')
  // The packaged product override must be stated, not left implicit.
  assert.match(spec, /time\.mode='constrain'/, 'SPEC must document the packaged time.mode override')
  assert.match(spec, /Asia\/Shanghai/, 'SPEC must document the packaged timezone')
  assert.match(spec, /expandLatinCase:\s*false/, 'SPEC §2 must document match.expandLatinCase: false')
  assert.match(spec, /cjkBigram:\s*false/, 'SPEC §2 must document match.cjkBigram: false')
})

test('docs: CHANGELOG has a non-empty section for the current version', () => {
  const escaped = EXPECTED_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp('^## \\[' + escaped + '\\][^\n]*', 'm').exec(changelog)
  assert.ok(heading, `CHANGELOG.md must have a "## [${EXPECTED_VERSION}]" section (tools/release.mjs refuses to run without it)`)
  const rest = changelog.slice(heading.index + heading[0].length)
  const nextHeading = /^## /m.exec(rest)
  const body = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim()
  assert.ok(body.length > 200, 'the 1.4.0 changelog section must describe the release, not be a placeholder')
  for (const phrase of ['确定性召回', '时间辅助', '遗留数据', '回滚']) {
    assert.ok(body.includes(phrase), `the 1.4.0 changelog section must mention ${phrase}`)
  }
})

test('versions: package.json and engine/package.json agree and equal 1.4.0', () => {
  assert.equal(pluginPackage.version, EXPECTED_VERSION, 'package.json version must be 1.4.0')
  assert.equal(enginePackage.version, EXPECTED_VERSION, 'engine/package.json version must follow the plugin release')
  assert.equal(enginePackage.version, pluginPackage.version, 'the two manifests must never drift apart')
  assert.match(pluginPackage.version, /^\d+\.\d+\.\d+$/)
})
