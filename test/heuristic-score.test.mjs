/**
 * Heuristic scoring fallback tests (plan D8).
 *
 * The fallback must be a drop-in replacement for model scoring when
 * `memory_judge` cannot reach the model: deterministic α/keywords/β with the
 * documented `meta` source flags, no model call, and no pollution of the
 * long-lived adapter config's `warnings` array.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_CONFIG, computeImportance, loadConfig } from '../engine/index.js'
import { applyHeuristicMeta, scoreHeuristic } from '../lib/heuristic-score.js'

/** Natural conversation with decision words and technical keywords. */
const CONVERSATION = [
  { role: 'user', content: '部署 docker 时端口 8080 被占用，必须改成 9090' },
  { role: 'assistant', content: '好的，修改 docker-compose.yml 的端口映射，并记录 must 使用 9090。' },
]

/** Text that saturates the α `code` signal (fences + URL + version + path). */
const CODE_MESSAGES = [
  { role: 'user', content: '```js\nconst a = 1\n```\nhttps://example.com/config v1.2.3 C:\\work\\a.txt' },
]

/** Weight α entirely on the code signal so the warnAbove branch is reachable. */
const HIGH_CODE_WEIGHTS = {
  importance: { weights: { keywords: 0, decisions: 0, userDensity: 0, code: 1, recency: 0 } },
}

const EMPTY_SIGNALS = { keywords: 0, decisions: 0, userDensity: 0, code: 0, recency: 0 }

test('heuristic: deterministic result with the documented shape and meta flags', () => {
  const cfg = loadConfig(undefined, {})
  const first = scoreHeuristic(CONVERSATION, cfg)
  const second = scoreHeuristic(CONVERSATION, cfg)
  assert.deepEqual(first, second, 'same input must produce byte-identical output')

  assert.equal(typeof first.alpha, 'number')
  assert.ok(first.alpha >= cfg.importance.min && first.alpha <= cfg.importance.max)
  assert.equal(first.beta, 0)
  assert.ok(Array.isArray(first.keywords))
  assert.ok(
    first.keywords.length >= cfg.keywords.min && first.keywords.length <= cfg.keywords.max,
    `expected ${cfg.keywords.min}..${cfg.keywords.max} keywords, got ${first.keywords.length}`,
  )
  assert.deepEqual(Object.keys(first.signals).sort(), ['code', 'decisions', 'keywords', 'recency', 'userDensity'])
  assert.ok(Array.isArray(first.warnings))
  assert.deepEqual(first.metaExtra, {
    scored: true,
    alphaSource: 'heuristic',
    keywordsSource: 'heuristic',
    betaSource: 'default',
  })
  assert.ok(first.keywords.includes('docker-compose.yml'), 'technical tokens are extracted')
})

test('heuristic: keyword count respects keywords.min/max bounds', () => {
  const two = loadConfig(undefined, { keywords: { min: 1, max: 2 } })
  const twoKeywords = scoreHeuristic(CONVERSATION, two).keywords
  assert.ok(twoKeywords.length >= 1 && twoKeywords.length <= 2, `got ${twoKeywords.length}`)

  const single = loadConfig(undefined, { keywords: { min: 1, max: 1 } })
  assert.equal(scoreHeuristic(CONVERSATION, single).keywords.length, 1)
})

test('heuristic: keywords are cleaned strings without duplicates', () => {
  const result = scoreHeuristic(CONVERSATION, loadConfig(undefined, {}))
  for (const keyword of result.keywords) {
    assert.equal(typeof keyword, 'string')
    assert.equal(keyword, keyword.trim(), 'no surrounding whitespace')
    assert.ok(keyword.length > 0, 'no empty keyword')
  }
  const lowered = result.keywords.map((keyword) => keyword.toLowerCase())
  assert.equal(new Set(lowered).size, lowered.length, 'keywords are unique (case-insensitive)')
})

test('heuristic: α reuses computeImportance without polluting the caller config warnings', () => {
  const cfg = loadConfig(undefined, HIGH_CODE_WEIGHTS)
  const warningsBefore = cfg.warnings.slice()
  const result = scoreHeuristic(CODE_MESSAGES, cfg)

  const reference = computeImportance(CODE_MESSAGES, loadConfig(undefined, HIGH_CODE_WEIGHTS))
  assert.equal(result.alpha, reference.alpha)
  assert.deepEqual(result.signals, reference.signals)
  assert.deepEqual(result.warnings, reference.warnings, 'the per-pass warnings are reported')
  assert.ok(result.warnings.some((warning) => warning.includes('warnAbove')))
  assert.deepEqual(cfg.warnings, warningsBefore, 'the caller config is never mutated')
})

test('heuristic: keywords see every message of the folder, not just the first', () => {
  const messages = [
    { role: 'user', content: '第一个话题：数据库索引' },
    { role: 'assistant', content: '好的，讨论 postgres 的 btree 索引' },
  ]
  const keywords = scoreHeuristic(messages, loadConfig(undefined, {})).keywords
  assert.ok(keywords.includes('postgres') || keywords.includes('btree'), `got ${JSON.stringify(keywords)}`)
})

test('heuristic: bad messages degrade to the configured α floor without throwing', () => {
  const cfg = loadConfig(undefined, { importance: { min: 0.05 } })
  for (const bad of [null, undefined, 'nope', 42, {}, true]) {
    const result = scoreHeuristic(bad, cfg)
    assert.equal(result.alpha, 0.05, `bad input ${String(bad)} must use importance.min`)
    assert.deepEqual(result.keywords, [])
    assert.equal(result.beta, 0)
    assert.deepEqual(result.signals, EMPTY_SIGNALS)
    assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0, 'the degradation is reported')
    assert.equal(result.metaExtra.alphaSource, 'heuristic')
  }
  assert.equal(scoreHeuristic(null, undefined).alpha, DEFAULT_CONFIG.importance.min)
})

test('heuristic: an empty message list still yields a usable alpha', () => {
  const cfg = loadConfig(undefined, {})
  const result = scoreHeuristic([], cfg)
  assert.ok(Number.isFinite(result.alpha))
  assert.ok(result.alpha >= cfg.importance.min && result.alpha <= cfg.importance.max)
  assert.deepEqual(result.keywords, [])
})

test('heuristic: malformed config falls back to the documented defaults', () => {
  const result = scoreHeuristic(CONVERSATION, {
    importance: { min: 'bad', max: null },
    keywords: { min: -1, max: 0 },
  })
  assert.ok(Number.isFinite(result.alpha))
  assert.ok(result.alpha >= DEFAULT_CONFIG.importance.min && result.alpha <= DEFAULT_CONFIG.importance.max)
  assert.ok(result.keywords.length <= DEFAULT_CONFIG.keywords.max)
})

test('heuristic: applyHeuristicMeta scores a copy and never mutates the input meta', () => {
  const cfg = loadConfig(undefined, {})
  const meta = {
    id: 'mem-20261030T000000Z-0001',
    title: '旧标题',
    alpha: 0,
    beta: 0,
    keywords: [],
    scored: false,
    alphaSource: 'pending',
    keywordsSource: 'pending',
    betaSource: 'pending',
    pendingSince: 123,
    custom: 'kept',
  }
  const snapshot = structuredClone(meta)
  const next = applyHeuristicMeta(meta, CONVERSATION, cfg)
  const expected = scoreHeuristic(CONVERSATION, cfg)

  assert.notEqual(next, meta, 'a new object is returned')
  assert.deepEqual(meta, snapshot, 'the input meta is untouched')
  assert.equal(next.id, meta.id)
  assert.equal(next.title, meta.title)
  assert.equal(next.custom, 'kept')
  assert.equal(next.scored, true)
  assert.equal(next.alphaSource, 'heuristic')
  assert.equal(next.keywordsSource, 'heuristic')
  assert.equal(next.betaSource, 'default')
  assert.equal(next.beta, 0)
  assert.equal(next.pendingSince, undefined, 'a scored folder is no longer pending')
  assert.equal(next.alpha, expected.alpha)
  assert.deepEqual(next.keywords, expected.keywords)
  assert.deepEqual(next.signals, expected.signals)
})

test('heuristic: applyHeuristicMeta tolerates missing meta and missing config', () => {
  for (const meta of [undefined, null, 'not-a-meta']) {
    const next = applyHeuristicMeta(meta, CONVERSATION)
    assert.equal(typeof next, 'object')
    assert.equal(next.scored, true)
    assert.equal(next.alphaSource, 'heuristic')
    assert.equal(next.beta, 0)
    assert.ok(Array.isArray(next.keywords))
  }
  const empty = applyHeuristicMeta(undefined, [])
  assert.ok(Number.isFinite(empty.alpha))
})
