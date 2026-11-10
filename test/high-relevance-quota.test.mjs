/**
 * v1.5.5 high-relevance guaranteed quota (保底配额) — engine-level tests.
 *
 * A folder matching several distinct query keywords must keep a guaranteed slot
 * even when the FAIR-DRI ranking would push it out of a small round quota (a
 * low-α folder matching 3 query terms used to lose to single-keyword high-α
 * folders). The guarantee appends free slots first, then replaces the
 * lowest-priority unprotected tail pick. Paginated calls are excluded.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { MemoryEngine, loadConfig, writeFolder } from '../engine/index.js'

const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-highrel-'))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/** Build a fresh fair-mode engine over the fixture folders. */
function makeEngine(specs, extraOverrides = {}) {
  const dir = tempDir()
  for (const spec of specs) {
    const messages = Array.isArray(spec.messages)
      ? spec.messages
      : [{ role: 'user', content: spec.text ?? (spec.keywords ?? ['内容']).join(' ') }]
    const meta = {
      version: 1,
      createdAt: spec.createdAt ?? 1_700_000_000_000,
      alpha: spec.alpha ?? 0.9,
      beta: spec.beta ?? 3,
      keywords: spec.keywords ?? ['docker'],
      title: (spec.keywords ?? ['docker']).join(' '),
      stats: { messages: messages.length, chars: 50, tokens: 20 },
    }
    writeFolder(dir, { id: spec.id, meta, messages })
  }
  const cfg = loadConfig(undefined, {
    storage: { dir },
    recall: {
      mode: 'fair',
      firstGenMax: 2,
      fairness: { roundBudget: { maxChars: 1_000_000 } },
      ...(extraOverrides.recall ?? {}),
    },
  })
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg, rng: () => 0 })
  engine.load()
  return { engine, cfg, dir }
}

/** The fixture: two high-α single-keyword folders + one low-α multi-keyword folder. */
function fixtures() {
  return [
    { id: 'mem-20260101T000000Z-0001', alpha: 0.95, keywords: ['docker'] },
    { id: 'mem-20260101T000001Z-0002', alpha: 0.95, keywords: ['端口'] },
    // Matches three distinct query keywords (docker / 端口 / 部署) but low α:
    // the FAIR-DRI ranking alone would never spend one of the two slots on it
    // (the single-keyword low-α rotation pick is the even-lower-α folder below).
    { id: 'mem-20260101T000002Z-0003', alpha: 0.05, keywords: ['docker', '端口', '部署'] },
    { id: 'mem-20260101T000000Z-0000', alpha: 0.01, keywords: ['docker'] },
  ]
}

const QUERY = 'docker 端口 部署 怎么配置'

test('v1.5.5: a multi-keyword (high-relevance) folder gets a guaranteed slot', () => {
  // Quota 1: the FAIR-DRI ranking fills the only slot with a high-α
  // single-keyword folder; the guarantee must replace it with the low-α folder
  // that matches three query keywords.
  const { engine } = makeEngine(fixtures(), { recall: { firstGenMax: 1 } })
  const result = engine.recall(QUERY, { chars: 1000, tokens: 300, windowTokens: 100000 })
  const ids = result.additions.map((addition) => addition.id)
  assert.deepEqual(ids, ['mem-20260101T000002Z-0003'], `high-relevance folder is guaranteed: ${JSON.stringify(ids)}`)
  assert.equal(ids.length, 1, 'the quota is still respected (one tail pick was replaced)')
  assert.equal(result.stats.highRelevanceEnabled, true)
  assert.ok(result.stats.highRelevanceCandidates >= 1, 'multi-keyword candidate counted')
  assert.ok(result.stats.highRelevancePicks >= 1, 'guaranteed slot reported in telemetry')
  assert.equal(result.stats.highRelevanceReserveSlots, 2)
  assert.equal(result.stats.highRelevanceMinMatches, 2)
  assert.equal(result.stats.highRelevanceReplaced, 1, 'the full quota replaced exactly one tail pick')
})

test('v1.5.5: highRelevance.enabled=false makes the guarantee inert', () => {
  const { engine } = makeEngine(fixtures(), { recall: { highRelevance: { enabled: false } } })
  const result = engine.recall(QUERY, { chars: 1000, tokens: 300, windowTokens: 100000 })
  assert.equal(result.stats.highRelevanceEnabled, false)
  assert.equal(result.stats.highRelevancePicks, 0, 'no guaranteed picks when disabled')
  assert.equal(result.stats.highRelevanceReplaced, 0, 'no pick was evicted for relevance')
})

test('v1.5.5: minMatches raises the relevance bar (matchCount 2 is not guaranteed at 3)', () => {
  const middle = { id: 'mem-20260101T000003Z-0004', alpha: 0.05, keywords: ['docker', '端口'] }
  const { engine } = makeEngine([...fixtures(), middle], {
    recall: { highRelevance: { minMatches: 3, reserveSlots: 1 } },
  })
  const result = engine.recall(QUERY, { chars: 1000, tokens: 300, windowTokens: 100000 })
  const ids = result.additions.map((addition) => addition.id)
  assert.equal(ids.includes('mem-20260101T000003Z-0004'), false, 'matchCount 2 < minMatches 3')
  assert.ok(ids.includes('mem-20260101T000002Z-0003'), 'matchCount 3 is still guaranteed')
})

test('v1.5.5: reserveSlots is a hard cap on guaranteed high-relevance picks', () => {
  const specs = [
    { id: 'mem-20260101T000000Z-0001', alpha: 0.95, keywords: ['docker'] },
    { id: 'mem-20260101T000001Z-0002', alpha: 0.95, keywords: ['端口'] },
    { id: 'mem-20260101T000003Z-0003', alpha: 0.95, keywords: ['部署'] },
    { id: 'mem-20260101T000005Z-0005', alpha: 0.95, keywords: ['配置'] },
    { id: 'mem-20260101T000002Z-0006', alpha: 0.05, keywords: ['docker', '端口', '部署'] },
    { id: 'mem-20260101T000004Z-0007', alpha: 0.04, keywords: ['docker', '端口', '配置'] },
  ]
  const { engine } = makeEngine(specs, {
    recall: { firstGenMax: 4, highRelevance: { minMatches: 2, reserveSlots: 1 }, fairness: { exploreRatio: 0, specificProbeSlots: 0 } },
  })
  const result = engine.recall(QUERY, { chars: 1000, tokens: 300, windowTokens: 100000 })
  const highIds = ['mem-20260101T000002Z-0006', 'mem-20260101T000004Z-0007']
  const guaranteed = result.additions.filter((addition) => highIds.includes(addition.id)).length
  assert.equal(guaranteed, 1, `reserveSlots=1 keeps exactly one high-relevance pick: ${JSON.stringify(result.additions.map((a) => a.id))}`)
  assert.equal(result.additions.length, 4, 'quota stays 4')
})

test('v1.5.5: deterministic (research) mode keeps the pure sigma oracle — no guarantee', () => {
  const { engine } = makeEngine(fixtures(), { recall: { mode: 'deterministic', firstGenMax: 1 } })
  const result = engine.recall(QUERY, { chars: 1000, tokens: 300, windowTokens: 100000 })
  assert.equal(result.stats.highRelevancePicks, 0, 'the deterministic oracle never applies the guarantee')
  assert.deepEqual(result.additions.map((addition) => addition.id), ['mem-20260101T000000Z-0001'])
})

test('v1.5.5: a single-keyword query has no high-relevance guarantee (needs >= 2 matches)', () => {
  const { engine } = makeEngine(fixtures())
  const result = engine.recall('docker 是什么', { chars: 1000, tokens: 300, windowTokens: 100000 })
  assert.equal(result.stats.highRelevancePicks, 0)
  assert.ok(result.additions.length > 0)
})

test('v1.5.5: the guarantee never re-injects a folder already in the block', () => {
  const { engine } = makeEngine(fixtures())
  const first = engine.recall(QUERY, { chars: 1000, tokens: 300, windowTokens: 100000 })
  const firstIds = first.additions.map((addition) => addition.id)
  const second = engine.recall(QUERY, { chars: 1000, tokens: 300, windowTokens: 100000 }, {
    excludeIds: firstIds,
    blockIds: firstIds,
  })
  for (const id of second.additions.map((addition) => addition.id)) {
    assert.equal(firstIds.includes(id), false, `excluded id re-injected: ${id}`)
  }
})
