/**
 * Plan A (v1.4.1 addendum): deterministic category layer for generic high-α words.
 *
 * rofm recall is lexical. A high-α preference memory may carry the keyword
 * 「偏好」 while the user asks 「我的喜好是什么」 — no literal overlap. The
 * category layer bridges a closed synonym lexicon without embeddings:
 *   - build: folders with alpha >= alphaMin whose keywords/title contain any word
 *     of a class get a synthetic posting for that class (σ-sorted like any other
 *     posting, so all lanes/merge/trim code keeps working);
 *   - query: a query containing any word of the class seeds that synthetic
 *     posting.
 * Only high-α entries participate, so generic words cannot flood low-α memories.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildRecallIndex,
  emptyLanes,
  lanesFingerprint,
  loadConfig,
  querySeeds,
  selectRecall,
} from '../engine/index.js'

const NOW = 1_800_000_000_000
const CATEGORY_SEED_PREFIX = '\u0002cat:'

function folder(id, { alpha = 0.9, keywords = [], title = '', createdAt } = {}) {
  return {
    id,
    alpha,
    beta: 0,
    scored: true,
    createdAt: createdAt ?? NOW,
    keywords,
    title,
    chars: 100,
    tokens: 30,
    messageCount: 1,
  }
}

function cfgWith(overrides) {
  return loadConfig(undefined, overrides || {})
}

function pickIds(index, query, cfg, options = {}) {
  const result = selectRecall(index, query, {
    cfg,
    lanes: emptyLanes(),
    round: 1,
    mode: 'fair',
    k: 10,
    ...options,
  })
  return { ids: result.picks.map((pick) => pick.id), result }
}

test('query 「我的喜好是什么」 finds a high-α memory whose keyword is 「偏好」', () => {
  const cfg = cfgWith()
  const folders = [
    folder('mem-pref', { alpha: 0.9, keywords: ['偏好', '美式咖啡', '不加糖'], title: '咖啡偏好' }),
    folder('mem-other', { alpha: 0.92, keywords: ['docker', '部署', '端口'], title: '部署参数' }),
  ]
  const index = buildRecallIndex(folders, cfg)
  const seeds = querySeeds(index, '我的喜好是什么', cfg).seeds
  assert.ok(seeds.includes(`${CATEGORY_SEED_PREFIX}preference`), 'generic query seeds the preference class')

  const { ids } = pickIds(index, '我的喜好是什么', cfg)
  assert.ok(ids.includes('mem-pref'), `synonym bridge recalls the preference (got ${ids.join(',')})`)
  assert.equal(ids.includes('mem-other'), false, 'unrelated memories are not pulled in')
})

test('query 「我们约定了什么」 finds a high-α memory whose keyword is 「承诺」', () => {
  const cfg = cfgWith()
  const index = buildRecallIndex([
    folder('mem-agree', { alpha: 0.8, keywords: ['承诺', '端口', '9090'], title: '端口约定' }),
    folder('mem-noise', { alpha: 0.8, keywords: ['天气', '下雨', '雨伞'], title: '天气' }),
  ], cfg)
  const { ids } = pickIds(index, '我们约定了什么端口？', cfg)
  assert.ok(ids.includes('mem-agree'))
  assert.equal(ids.includes('mem-noise'), false)
})

test('synonym direction works both ways (keyword 喜好, query 偏好)', () => {
  const cfg = cfgWith()
  const index = buildRecallIndex([
    folder('mem-pref', { alpha: 0.85, keywords: ['喜好', '咖啡', '早餐'], title: '喜好' }),
  ], cfg)
  const { ids } = pickIds(index, '跟我说说我的偏好', cfg)
  assert.deepEqual(ids, ['mem-pref'])
})

test('category matching is limited to α >= categoryMatch.alphaMin', () => {
  const cfg = cfgWith()
  const index = buildRecallIndex([
    folder('mem-high', { alpha: 0.9, keywords: ['偏好', '咖啡', '不加糖'], title: '高 α 偏好' }),
    folder('mem-low', { alpha: 0.3, keywords: ['偏好', '闲聊', '次要'], title: '低 α 偏好' }),
    folder('mem-mid', { alpha: 0.59, keywords: ['偏好', '半重要', '中性'], title: '半重要' }),
  ], cfg)
  const { ids } = pickIds(index, '我的喜好是什么', cfg)
  assert.ok(ids.includes('mem-high'))
  assert.equal(ids.includes('mem-low'), false, 'low-α memories stay out of the generic layer')
  assert.equal(ids.includes('mem-mid'), false, 'α below alphaMin (0.6) stays out')
})

test('a custom alphaMin changes the gate', () => {
  const cfg = cfgWith({ recall: { categoryMatch: { alphaMin: 0.95 } } })
  const index = buildRecallIndex([
    folder('mem-a', { alpha: 0.9, keywords: ['偏好', '咖啡', '不加糖'], title: '偏好' }),
  ], cfg)
  assert.deepEqual(pickIds(index, '我的喜好是什么', cfg).ids, [])
  assert.equal(querySeeds(index, '我的喜好是什么', cfg).seeds.includes(`${CATEGORY_SEED_PREFIX}preference`), false)
})

test('the folder title may carry the category word (legacy memories)', () => {
  const cfg = cfgWith()
  const index = buildRecallIndex([
    folder('mem-title', { alpha: 0.9, keywords: ['咖啡', '早餐', '不加糖'], title: '我的喜好清单' }),
  ], cfg)
  assert.deepEqual(pickIds(index, '我的喜好是什么', cfg).ids, ['mem-title'])
})

test('disabled categoryMatch restores pure lexical matching', () => {
  const cfg = cfgWith({ recall: { categoryMatch: { enabled: false } } })
  const index = buildRecallIndex([
    folder('mem-pref', { alpha: 0.9, keywords: ['偏好', '咖啡', '不加糖'], title: '偏好' }),
  ], cfg)
  assert.deepEqual(pickIds(index, '我的喜好是什么', cfg).ids, [])
  assert.equal(querySeeds(index, '我的喜好是什么', cfg).seeds.some((seed) => seed.startsWith(CATEGORY_SEED_PREFIX)), false)
})

test('queries without a category word behave exactly as before', () => {
  const cfg = cfgWith()
  const index = buildRecallIndex([
    folder('mem-docker', { alpha: 0.9, keywords: ['docker', '部署', '端口'], title: '部署' }),
    folder('mem-pref', { alpha: 0.9, keywords: ['偏好', '咖啡', '不加糖'], title: '偏好' }),
  ], cfg)
  const seeds = querySeeds(index, 'docker 部署怎么弄', cfg).seeds
  assert.equal(seeds.some((seed) => seed.startsWith(CATEGORY_SEED_PREFIX)), false)
  const { ids } = pickIds(index, 'docker 部署怎么弄', cfg)
  assert.ok(ids.includes('mem-docker'))
  assert.equal(ids.includes('mem-pref'), false)
})

test('category seeds do not leak from literal marker text in the user query', () => {
  const cfg = cfgWith()
  const index = buildRecallIndex([
    folder('mem-pref', { alpha: 0.9, keywords: ['偏好', '咖啡', '不加糖'], title: '偏好' }),
  ], cfg)
  const seeds = querySeeds(index, `${CATEGORY_SEED_PREFIX}preference`, cfg).seeds
  assert.deepEqual(seeds, [])
})

test('the layer is deterministic: two identical calls return the same ids in the same order', () => {
  const cfg = cfgWith()
  const index = buildRecallIndex([
    folder('mem-a', { alpha: 0.9, keywords: ['偏好', '咖啡', '不加糖'], title: 'a', createdAt: NOW - 3 }),
    folder('mem-b', { alpha: 0.85, keywords: ['喜好', '茶', '口味'], title: 'b', createdAt: NOW - 2 }),
    folder('mem-c', { alpha: 0.7, keywords: ['约定', '端口', '规则'], title: 'c', createdAt: NOW - 1 }),
  ], cfg)
  const first = pickIds(index, '我的喜好和约定', cfg).ids
  const second = pickIds(index, '我的喜好和约定', cfg).ids
  assert.deepEqual(first, second)
  assert.deepEqual(first.slice().sort(), ['mem-a', 'mem-b', 'mem-c'].filter((id) => first.includes(id)).sort())
})

test('the category layer reports its seeds in telemetry', () => {
  const cfg = cfgWith()
  const index = buildRecallIndex([
    folder('mem-a', { alpha: 0.9, keywords: ['偏好', '咖啡', '不加糖'], title: '偏好' }),
  ], cfg)
  const result = selectRecall(index, '我的喜好是什么', { cfg, lanes: emptyLanes(), round: 1, mode: 'fair', k: 10 })
  assert.deepEqual(result.stats.categorySeeds, ['preference'])
})

test('lanesFingerprint changes when the category lexicon/gate changes (cache invalidation)', () => {
  const base = cfgWith()
  const changed = cfgWith({ recall: { categoryMatch: { alphaMin: 0.7 } } })
  assert.notEqual(lanesFingerprint(base), lanesFingerprint(changed))
  const disabled = cfgWith({ recall: { categoryMatch: { enabled: false } } })
  assert.notEqual(lanesFingerprint(base), lanesFingerprint(disabled))
})
