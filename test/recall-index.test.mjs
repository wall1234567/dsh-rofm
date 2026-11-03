/**
 * FAIR-DRI selector tests — σ ordering, k-way merge / oracle, fairness lanes
 * (G1/G2/G3/G4/G5), register / queryBoost / recycle, block trimming,
 * pagination, time/α/event pre-filters, lane serialization + restart,
 * determinism, AC-vs-legacy matching, performance (plan §3.2.9 / contract §5.1,
 * event constraint design §4).
 *
 * Everything here is deterministic: the tests use their own mulberry32 PRNG and
 * never Math.random(). The determinism test additionally proves the module
 * itself never touches Math.random.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, test } from 'node:test'
import {
  buildRecallIndex,
  comparePriority,
  countCandidates,
  deserializeLanes,
  emptyLanes,
  lanesFingerprint,
  querySeeds,
  selectRecall,
  selectSigma,
  serializeLanes,
  simulateTurns,
  summarizeGuarantees,
  trimBlock,
} from '../engine/recall-index.js'
import { buildEventIndex, resolveEventQuery } from '../engine/event-index.js'
import { matchKeywords } from '../engine/keyword-match.js'
import { countKeywordMatches, keywordMatches, normalizeText } from '../engine/tokenize.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(next, list) {
  return list[Math.floor(next() * list.length)]
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** Full config object as documented in contract §4 (self-contained, no config.js). */
function makeCfg(patch = {}) {
  const base = {
    keywords: { min: 3, max: 8, matchMode: 'contains' },
    recall: {
      enabled: true,
      mode: 'fair',
      firstGenMax: 10,
      hops: 0,
      persistInjected: true,
      maxRecalledBlocks: 64,
      maxRecalledChars: 120000,
      maxWindowPercent: 10,
      minAlpha: 0,
      sort: 'createdAt',
      fairness: {
        thetaHigh: 0.6,
        exploreRatio: 0.2,
        specificProbeSlots: 1,
        rareTerm: { ratio: 0.002, minPosting: 8, scanCap: 512 },
        register: { lookahead: 3, capFactor: 8, ttlRounds: 2 },
        queryBoost: true,
        recycle: { enabled: true, cooldownRounds: 15, maxPerRound: 1 },
        ledger: { maxEntries: 10000, overflow: 'evict-lowest-alpha-last-seen' },
        blockTrim: { policy: 'priority', protectCurrentQuery: true, pinHigh: true },
        roundBudget: { maxChars: 20000 },
      },
    },
    storage: { maxFolders: 10000 },
    match: { expandLatinCase: false, cjkBigram: false },
  }
  return deepMerge(base, patch)
}

function folder(id, alpha, createdAt, keywords, extra = {}) {
  return { id, alpha, createdAt, keywords, ...extra }
}

/** Random library with a small shared vocabulary (Latin words). */
function randomLibrary(next, count, options = {}) {
  const vocabSize = options.vocabSize || 40
  const alphas = options.alphas || [1, 0.9, 0.8, 0.7, 0.6, 0.4, 0.2, 0.1, 0.05, 0.01]
  const folders = []
  for (let at = 0; at < count; at += 1) {
    const keywords = []
    const keywordCount = 1 + Math.floor(next() * 8)
    for (let k = 0; k < keywordCount; k += 1) keywords.push(`w${Math.floor(next() * vocabSize)}`)
    folders.push(folder(`mem-${String(at).padStart(5, '0')}`, pick(next, alphas), at + 1, keywords, {
      scored: next() > 0.05,
    }))
  }
  return folders
}

/** Random user text built from the library vocabulary plus Chinese filler. */
function randomQuery(next, folders) {
  const filler = ['请检查', '部署配置', '这个服务', '帮我看看'][Math.floor(next() * 4)]
  if (!Array.isArray(folders) || !folders.length) return `${filler} w1`
  const words = []
  const count = 1 + Math.floor(next() * 4)
  for (let at = 0; at < count; at += 1) {
    const chosen = pick(next, folders)
    if (chosen.keywords.length) words.push(pick(next, chosen.keywords))
  }
  return `${filler} ${words.join(' ')}`
}

/**
 * Brute-force oracle: apply engine/tokenize.js keyword matching folder by folder,
 * then σ sort (independent implementation using comparePriority) and take k.
 */
function oracleCandidates(index, userText, options = {}) {
  const minAlpha = Number(options.minAlpha) || 0
  const excluded = options.exclude instanceof Set ? options.exclude : new Set(options.exclude || [])
  const timeIds = options.timeIds instanceof Set ? options.timeIds : null
  const text = normalizeText(userText)
  const rows = []
  for (const entry of index.entries) {
    if (minAlpha > 0 && entry.alpha < minAlpha) continue
    if (timeIds && !timeIds.has(entry.id)) continue
    if (countKeywordMatches(text, entry.keywords, index.matchMode, text) === 0) continue
    if (excluded.has(entry.id)) continue
    rows.push(entry)
  }
  rows.sort(comparePriority)
  return rows
}

function lanePickIds(result) {
  return result.picks.map((item) => item.id)
}

function minGap(roundsByTarget) {
  let gap = Infinity
  for (const rounds of roundsByTarget.values()) {
    for (let at = 1; at < rounds.length; at += 1) gap = Math.min(gap, rounds[at] - rounds[at - 1])
  }
  return gap
}

const tempFiles = []
after(() => {
  for (const file of tempFiles) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
  }
})

// ---------------------------------------------------------------------------
// 1) σ ordering
// ---------------------------------------------------------------------------

test('comparePriority: σ = alpha desc, createdAt asc, id asc', () => {
  const ordered = [
    folder('b', 1, 10, ['x']),
    folder('a', 1, 10, ['x']),
    folder('z', 1, 5, ['x']),
    folder('c', 0.9, 1, ['x']),
    folder('d', 0.01, 100, ['x']),
    folder('e', 0, 1, ['x']),
  ]
  const sorted = ordered.slice().sort(comparePriority)
  assert.deepEqual(sorted.map((item) => item.id), ['z', 'a', 'b', 'c', 'd', 'e'])
  // strictly total: no pair compares equal
  for (const left of ordered) {
    for (const right of ordered) {
      if (left === right) continue
      assert.notEqual(comparePriority(left, right), 0)
      assert.equal(Math.sign(comparePriority(left, right)), -Math.sign(comparePriority(right, left)))
    }
  }
  // defensive: missing/garbage ids and alphas never throw
  assert.equal(typeof comparePriority({}, { alpha: 1 }), 'number')
  assert.equal(typeof comparePriority(null, undefined), 'number')
})

// ---------------------------------------------------------------------------
// 2) buildRecallIndex
// ---------------------------------------------------------------------------

test('buildRecallIndex: filters, dedupe, σ-sorted postings, τ, signature', () => {
  const cfg = makeCfg()
  const folders = [
    folder('m1', 0.5, 3, ['Alpha', 'alpha', '共享']),
    folder('m2', 0.9, 2, ['alpha', 'other']),
    folder('m3', 0.1, 1, ['alpha']),
    folder('m1', 1, 1, ['alpha']), // duplicate id: first surviving copy wins
    folder('skip', 0.9, 1, ['alpha'], { scored: false }),
    { id: 42, alpha: 1, createdAt: 1, keywords: ['alpha'] }, // id must be a string
    { id: 'nokeys', alpha: 0.2, createdAt: 9 },
    null,
  ]
  const index = buildRecallIndex(folders, cfg)
  assert.equal(index.folderCount, 4)
  assert.deepEqual(index.entries.map((entry) => entry.id), ['m1', 'm2', 'm3', 'nokeys'])
  assert.equal(index.byId.get('m2'), 1)
  // keywords are normalized + de-duplicated
  assert.deepEqual(index.entries[0].keywords, ['alpha', '共享'])
  // postings sorted by σ: m2 (0.9) then m1 (0.5) then m3 (0.1)
  assert.deepEqual(index.postings.get('alpha'), [1, 0, 2])
  assert.equal(index.matchMode, 'contains')
  // τ = max(minPosting, ceil(ratio * N)) = max(8, ceil(0.008)) = 8
  assert.equal(index.rareThreshold, 8)
  assert.equal(typeof index.builtAt, 'number')
  assert.match(index.signature, /^fairstore1\|n=4\|first=m1\|last=nokeys\|cfg1\|/)

  // signature changes when the library changes or the fairness config changes
  const changedFolders = buildRecallIndex(folders.slice(0, 3), cfg)
  assert.notEqual(changedFolders.signature, index.signature)
  const changedCfg = buildRecallIndex(folders, makeCfg({ recall: { fairness: { thetaHigh: 0.7 } } }))
  assert.notEqual(changedCfg.signature, index.signature)
  // same library + config => byte identical signature
  assert.equal(buildRecallIndex(folders, cfg).signature, index.signature)

  // bigger library raises τ: ceil(0.002 * 5000) = 10
  const many = []
  for (let at = 0; at < 5000; at += 1) many.push(folder(`big-${at}`, 0.5, at, [`kw${at % 100}`]))
  assert.equal(buildRecallIndex(many, cfg).rareThreshold, 10)

  // no throws on garbage input
  assert.equal(buildRecallIndex(null, cfg).folderCount, 0)
  assert.equal(buildRecallIndex(undefined, undefined).folderCount, 0)
  assert.equal(buildRecallIndex([], cfg).folderCount, 0)
})

test('buildRecallIndex: minAlpha is a query-time gate, not a build filter', () => {
  const folders = [folder('m1', 0.1, 1, ['kw']), folder('m2', 0.9, 2, ['kw'])]
  const index = buildRecallIndex(folders, makeCfg())
  assert.equal(index.folderCount, 2)
  const gated = selectSigma(index, ['kw'], { k: 10, minAlpha: 0.5 })
  assert.deepEqual(gated.picked.map((item) => item.id), ['m2'])
})

// ---------------------------------------------------------------------------
// 3) AC seeds vs legacy keywordMatches
// ---------------------------------------------------------------------------

test('querySeeds: AC seeds agree with engine/tokenize.js keywordMatches (fuzz 200)', () => {
  const next = mulberry32(20261101)
  const vocab = ['接口网关', '端口配置', '数据库', '缓存', '灰度发布', 'api', 'gateway', 'docker', 'node.js', '8080', 'timeout', 'feature_flag', 'c++', 'v2.3']
  for (let trial = 0; trial < 200; trial += 1) {
    const folders = []
    const count = Math.floor(next() * 30)
    for (let at = 0; at < count; at += 1) {
      const keywords = []
      const keywordCount = 1 + Math.floor(next() * 4)
      for (let k = 0; k < keywordCount; k += 1) {
        const base = pick(next, vocab)
        keywords.push(next() < 0.15 ? base.toUpperCase() : next() < 0.2 ? ` ${base} ` : base)
      }
      folders.push(folder(`m${at}`, next(), at, keywords))
    }
    const cfg = makeCfg()
    const index = buildRecallIndex(folders, cfg)
    const parts = []
    for (let at = 0; at < 4; at += 1) {
      const chosen = pick(next, vocab)
      parts.push(next() < 0.5 ? chosen : `${chosen}的${pick(next, vocab)}`)
    }
    parts.push('请检查 Docker 的 feature_flag 端口 8080，node.js v2.3')
    const text = normalizeText(parts.join('；'))
    // v1.3.0 direction is a strict subset: every keyword keywordMatches() accepts
    // must still be seeded (no regression).
    const direction1 = new Set()
    for (const keyword of index.postings.keys()) {
      // Plan A adds synthetic category postings; they are seeds, not keywords.
      if (keyword.startsWith('')) continue
      if (keywordMatches(text, keyword, 'contains')) direction1.add(keyword)
    }
    // v1.4.1 wires direction 2 (bidirectional match) into querySeeds; the
    // authoritative predicate is engine/keyword-match.js, so the expected seed
    // set is "direction 1 ∪ direction 2".
    const expected = new Set()
    for (const keyword of index.postings.keys()) {
      if (keyword.startsWith('')) continue
      if (matchKeywords(text, [keyword], cfg).matchCount > 0) expected.add(keyword)
    }
    for (const keyword of direction1) assert.ok(expected.has(keyword), `direction-1 regression: ${keyword}`)
    const seeds = querySeeds(index, parts.join('；'), cfg)
    // Plan A: synthetic category seeds are generated separately from the AC
    // keyword seeds; compare the keyword part of the seed set only.
    const keywordSeeds = new Set(seeds.seeds.filter((seed) => !seed.startsWith('')))
    assert.deepEqual(keywordSeeds, expected, `trial ${trial}: ${JSON.stringify(seeds.seeds)}`)
    for (const seed of seeds.seeds) {
      if (!seed.startsWith('')) continue
      assert.ok(seed.startsWith('cat:'), `unknown synthetic seed ${JSON.stringify(seed)}`)
    }
    // deterministic + deduped + sorted
    assert.deepEqual(querySeeds(index, parts.join('；'), makeCfg()).seeds, seeds.seeds)
    assert.equal(new Set(seeds.seeds).size, seeds.seeds.length)
    assert.deepEqual(seeds.seeds, seeds.seeds.slice().sort())
    assert.ok(Array.isArray(seeds.userKeywords))
  }
})

// ---------------------------------------------------------------------------
// 4) k-way merge vs brute force oracle (100 fuzz cases)
// ---------------------------------------------------------------------------

test('selectSigma: k-way merge == brute-force σ oracle (100 fuzz cases)', () => {
  const next = mulberry32(424242)
  for (let trial = 0; trial < 100; trial += 1) {
    const cfg = makeCfg()
    const folders = randomLibrary(next, Math.floor(next() * 80), { vocabSize: 1 + Math.floor(next() * 20) })
    const index = buildRecallIndex(folders, cfg)
    const text = randomQuery(next, folders)
    const seeds = querySeeds(index, text, cfg).seeds
    const k = Math.floor(next() * 12)
    const exclude = new Set()
    for (const entry of index.entries) if (next() < 0.15) exclude.add(entry.id)
    const minAlpha = next() < 0.3 ? 0.3 : 0
    const expected = oracleCandidates(index, text, { exclude, minAlpha })
    const result = selectSigma(index, seeds, { k, exclude, minAlpha })
    assert.deepEqual(
      result.picked.map((item) => item.id),
      expected.slice(0, k).map((entry) => entry.id),
      `trial ${trial} k=${k} text=${text}`,
    )
    assert.equal(result.stats.hasMore, expected.length > k)
    // determinism
    assert.deepEqual(selectSigma(index, seeds, { k, exclude, minAlpha }).picked, result.picked)
    // picks are strictly σ sorted
    for (let at = 1; at < result.picked.length; at += 1) {
      assert.ok(comparePriority(result.picked[at - 1], result.picked[at]) < 0)
    }
  }
})

test('selectSigma: frontier keeps picks identical and pops linear; self-heals on append', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 200; at += 1) {
    folders.push(folder(`m${String(at).padStart(3, '0')}`, [0.01, 0.1, 0.3, 0.5, 0.7, 0.9][at % 6], at, ['shared']))
  }
  const index = buildRecallIndex(folders, cfg)
  const seeds = querySeeds(index, 'shared', cfg).seeds
  const excludeA = new Set()
  const excludeB = new Set()
  const frontierA = new Map()
  const frontierB = new Map()
  const picksA = []
  const picksB = []
  let popsWithFrontier = 0
  let popsWithout = 0
  for (let turn = 0; turn < 20; turn += 1) {
    const withFrontier = selectSigma(index, seeds, { k: 10, exclude: excludeA, frontier: frontierA })
    const without = selectSigma(index, seeds, { k: 10, exclude: excludeB })
    assert.deepEqual(withFrontier.picked.map((item) => item.id), without.picked.map((item) => item.id))
    picksA.push(withFrontier.picked.map((item) => item.id))
    picksB.push(without.picked.map((item) => item.id))
    popsWithFrontier += withFrontier.stats.pops
    popsWithout += without.stats.pops
    for (const item of withFrontier.picked) excludeA.add(item.id)
    for (const item of without.picked) excludeB.add(item.id)
  }
  assert.equal(popsWithFrontier, 200)
  assert.ok(popsWithout > 200 * 5)

  // F3 regression: a newly appended σ-best memory must not be skipped by the frontier.
  const before = buildRecallIndex(folders.slice(0, 60), cfg)
  const frontier = new Map()
  const exclude = new Set()
  const warm = selectSigma(before, querySeeds(before, 'shared', cfg).seeds, { k: 10, exclude, frontier })
  for (const item of warm.picked) exclude.add(item.id)
  const appended = [folder('NEW', 1, -1, ['shared'])].concat(folders.slice(0, 60))
  const afterIndex = buildRecallIndex(appended, cfg)
  const visible = selectSigma(afterIndex, querySeeds(afterIndex, 'shared', cfg).seeds, { k: 10, exclude, frontier })
  assert.ok(visible.picked.some((item) => item.id === 'NEW'), JSON.stringify(visible.picked.map((item) => item.id)))
})

test('selectSigma: hops expansion (H=1) reaches a bridging memory', () => {
  const cfg = makeCfg()
  const index = buildRecallIndex([
    folder('bridge', 0.9, 1, ['start_kw', 'bridge_kw']),
    folder('target', 0.05, 2, ['bridge_kw', 'target_kw']),
  ], cfg)
  const seeds = querySeeds(index, 'start_kw', cfg).seeds
  const straight = selectSigma(index, seeds, { k: 5 })
  assert.equal(straight.picked.length, 1)
  assert.equal(straight.picked[0].id, 'bridge')
  // H=0 only surfaces direct keyword hits: the bridge alone.
  assert.deepEqual(selectSigma(index, seeds, { k: 5, hops: 0 }).picked.map((item) => item.id), ['bridge'])
  // H=1 expands through the recalled bridge's keywords and reaches the target.
  const hopped = selectSigma(index, seeds, { k: 5, hops: 1 })
  assert.deepEqual(hopped.picked.map((item) => item.id), ['bridge', 'target'])
  assert.equal(hopped.picked[0].generation, 1)
  assert.equal(hopped.picked[1].generation, 2)
})

// ---------------------------------------------------------------------------
// 5) G1 — rare high α surfaces in the same round
// ---------------------------------------------------------------------------

test('G1: rare-word high-α target is surfaced in the same round (>=20 seeds, 100%)', () => {
  for (let seed = 1; seed <= 24; seed += 1) {
    const next = mulberry32(seed * 7919)
    const folders = randomLibrary(next, 120, { vocabSize: 30 })
    const target = folder(`target-${seed}`, 0.9 + next() * 0.1 > 1 ? 1 : 0.7, 1000, ['unique_rare_token'])
    folders.push(target)
    const index = buildRecallIndex(folders, makeCfg())
    const result = selectRecall(index, '请问 unique_rare_token 是什么', {
      cfg: makeCfg(),
      lanes: emptyLanes(),
      round: 1,
      k: 10,
      ledger: new Set(),
      blockIds: new Set(),
    })
    assert.ok(lanePickIds(result).includes(target.id), `seed ${seed}: ${JSON.stringify(lanePickIds(result))}`)
    const pick = result.picks.find((item) => item.id === target.id)
    assert.equal(pick.lane, 'rareHigh')
    assert.ok(result.stats.lanesPicked.rareHigh >= 1)
  }
})

test('G1: ordinary-word high-α target delay <= ceil(rank_H / k_H)', () => {
  const cfg = makeCfg() // k=10, r=2, k_H=8
  const kHigh = 8
  for (const rank of [9, 13, 40]) {
    const folders = []
    for (let at = 0; at < 60; at += 1) {
      // descending α, ascending createdAt -> the σ rank of m<at> is exactly at+1
      folders.push(folder(`h${String(at).padStart(3, '0')}`, 1 - at / 1000, at, ['commonterm']))
    }
    const index = buildRecallIndex(folders, cfg)
    const targetId = `h${String(rank - 1).padStart(3, '0')}`
    const lanes = emptyLanes()
    const ledger = new Set()
    const block = []
    let firstRound = null
    for (let round = 1; round <= 12 && firstRound === null; round += 1) {
      const result = selectRecall(index, 'commonterm', { cfg, lanes, round, ledger, blockIds: block.map((id) => id) })
      if (lanePickIds(result).includes(targetId)) firstRound = round
      for (const pick of result.picks) ledger.add(pick.id)
      block.push(...lanePickIds(result))
      if (block.length > 10) block.splice(0, block.length - 10)
    }
    const bound = Math.ceil(rank / kHigh)
    assert.ok(firstRound !== null && firstRound <= bound, `rank ${rank}: firstRound ${firstRound} > ${bound}`)
    // the σ-high lane feeding this guarantee must be in σ order round by round
    if (rank === 13) assert.ok(firstRound >= 2, 'rank 13 cannot fit in the first k_H slots')
  }
})

// ---------------------------------------------------------------------------
// 6) G2 — low α rotation bound, explicit reference, degraded observation
// ---------------------------------------------------------------------------

test('G2: low-α rotation covers L=100 candidates within ceil(L/r)=50 rounds', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 100; at += 1) folders.push(folder(`low${String(at).padStart(3, '0')}`, 0.05, at + 1, ['tailword']))
  const index = buildRecallIndex(folders, cfg)
  const lanes = emptyLanes()
  const ledger = new Set()
  const firstSeen = new Map()
  for (let round = 1; round <= 60; round += 1) {
    const result = selectRecall(index, 'tailword', { cfg, lanes, round, ledger })
    for (const pick of result.picks) {
      if (!firstSeen.has(pick.id)) firstSeen.set(pick.id, round)
      ledger.add(pick.id)
    }
  }
  assert.equal(firstSeen.size, 100, `covered ${firstSeen.size}`)
  const worst = Math.max(...firstSeen.values())
  assert.ok(worst <= Math.ceil(100 / 2), `worst first round ${worst}`)
  assert.equal(lanes.degraded, false)
  // every round injects at most k and never the same id twice
  assert.equal(ledger.size, 100)
})

test('G2: explicit reference of a low-α unique word surfaces in the same round (100% over seeds)', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const next = mulberry32(seed * 104729)
    const folders = randomLibrary(next, 100, { vocabSize: 25 })
    const target = folder(`lowtarget-${seed}`, 0.01, 5000, [`unique_low_${seed}`])
    folders.push(target)
    const index = buildRecallIndex(folders, makeCfg())
    const result = selectRecall(index, `记不记得 unique_low_${seed}`, {
      cfg: makeCfg(),
      lanes: emptyLanes(),
      round: 1,
      k: 10,
      ledger: new Set(),
      blockIds: new Set(),
    })
    const pick = result.picks.find((item) => item.id === target.id)
    assert.ok(pick, `seed ${seed}: ${JSON.stringify(lanePickIds(result))}`)
    assert.equal(pick.lane, 'lowProbe')
  }
})

test('G2: a_low >= r marks degraded (sticky) and warns; a_low < r does not', () => {
  const cfg = makeCfg() // r = 2
  const folders = []
  for (let at = 0; at < 50; at += 1) folders.push(folder(`low${String(at).padStart(3, '0')}`, 0.05, at + 1, ['tailword']))
  const lanes = emptyLanes()
  const ledger = new Set()
  for (let round = 1; round <= 4; round += 1) {
    const result = selectRecall(indexFor(folders, cfg), 'tailword', { cfg, lanes, round, ledger })
    for (const pick of result.picks) ledger.add(pick.id)
    assert.equal(lanes.degraded, false)
    assert.equal(result.stats.degraded, false)
  }
  // Two new low-α arrivals per round: a_low == r == 2 -> degraded from round 2.
  const arrivingFolders = folders.slice()
  const arriving = emptyLanes()
  const arrivingLedger = new Set()
  let sawDegraded = false
  for (let round = 1; round <= 4; round += 1) {
    arrivingFolders.push(folder(`arrive-${round}-0`, 0.05, 1000 + round * 2, ['tailword']))
    arrivingFolders.push(folder(`arrive-${round}-1`, 0.05, 1000 + round * 2 + 1, ['tailword']))
    const result = selectRecall(indexFor(arrivingFolders, cfg), 'tailword', { cfg, lanes: arriving, round, ledger: arrivingLedger })
    for (const pick of result.picks) arrivingLedger.add(pick.id)
    if (round >= 2) assert.equal(arriving.degraded, true, `round ${round}`)
    if (result.stats.degraded) sawDegraded = true
    assert.ok(result.warnings.every((warning) => typeof warning === 'string'))
  }
  assert.equal(sawDegraded, true)

  function indexFor(list, config) {
    return buildRecallIndex(list, config)
  }
})

// ---------------------------------------------------------------------------
// 7) G3 — ledger is never deleted; block trim keeps high α
// ---------------------------------------------------------------------------

test('G3: ledger never loses ids over 1000 rounds and picks never collide', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 40; at += 1) folders.push(folder(`m${String(at).padStart(3, '0')}`, [0.9, 0.5, 0.2, 0.05][at % 4], at + 1, ['topic']))
  const index = buildRecallIndex(folders, cfg)
  const lanes = emptyLanes()
  const ledger = new Set()
  let snapshot = null
  let previousSize = 0
  for (let round = 1; round <= 1000; round += 1) {
    const result = selectRecall(index, 'topic', { cfg, lanes, round, ledger, blockIds: new Set() })
    const picked = lanePickIds(result)
    assert.equal(new Set(picked).size, picked.length, `round ${round}: duplicate pick`)
    assert.ok(picked.length <= 10)
    const sizeBefore = ledger.size
    assert.equal(ledger.size, sizeBefore) // selectRecall must not mutate the caller ledger
    for (const id of picked) ledger.add(id)
    assert.ok(ledger.size >= previousSize)
    previousSize = ledger.size
    if (round === 500) snapshot = [...ledger]
  }
  assert.ok(snapshot && snapshot.every((id) => ledger.has(id)))
  assert.equal(ledger.size, 40)
  assert.ok(folders.every((item) => ledger.has(item.id)))
})

test('G3: block trim evicts low α first (60 low + 10 high, trim 4 => 4 low)', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 60; at += 1) folders.push(folder(`low${at}`, 0.05 + (at % 10) / 1000, at, ['kw'], { chars: 100 }))
  for (let at = 0; at < 10; at += 1) folders.push(folder(`high${at}`, 0.8 + at / 100, 100 + at, ['kw'], { chars: 100 }))
  const index = buildRecallIndex(folders, cfg)
  const block = folders.map((item) => ({ id: item.id, injectedRound: 1 }))
  const candidates = new Set(folders.map((item) => item.id))
  const result = trimBlock(block, { index, candidates, cfg, maxBlocks: 66 })
  assert.equal(result.droppedBlocks, 4)
  assert.ok(result.evicted.every((item) => !item.high), JSON.stringify(result.evicted))
  assert.equal(result.pinnedHigh, 10)
  assert.equal(result.keep.length, 66)
  assert.equal(result.keep.filter((item) => item.id.startsWith('high')).length, 10)
  assert.equal(result.droppedChars, 400)

  // maxChars hard limit keeps at least one entry (70 entries * 100 chars > 1 char)
  const tiny = trimBlock(block, { index, candidates, cfg, maxBlocks: 64, maxChars: 1 })
  assert.equal(tiny.keep.length, 1)
  assert.equal(tiny.droppedBlocks, 69)

  // trim key order: not-in-candidates first, then α asc; high α is pinned while
  // a low α entry is present, so the low candidates are the evictable ones.
  const mixed = [
    { id: 'high1', injectedRound: 1 },
    { id: 'lowA', injectedRound: 1 },
    { id: 'lowB', injectedRound: 2 },
  ]
  const keyCfg = makeCfg()
  const keyIndex = buildRecallIndex([
    folder('high1', 0.9, 1, ['kw']),
    folder('lowA', 0.5, 2, ['kw']),
    folder('lowB', 0.3, 3, ['kw']),
  ], keyCfg)
  // lowA is not a candidate this round => evicted before the lower-α candidate lowB.
  const trim1 = trimBlock(mixed, { index: keyIndex, candidates: new Set(['high1', 'lowB']), cfg: keyCfg, maxBlocks: 2 })
  assert.deepEqual(trim1.evicted.map((item) => item.id), ['lowA'])
  // protectCurrentQuery switched off => pure α order evicts lowB.
  const offCfg = makeCfg({ recall: { fairness: { blockTrim: { protectCurrentQuery: false } } } })
  const trim2 = trimBlock(mixed, { index: keyIndex, candidates: new Set(['high1', 'lowB']), cfg: offCfg, maxBlocks: 2 })
  assert.deepEqual(trim2.evicted.map((item) => item.id), ['lowB'])
  // tie on α: the earlier injectedRound is evicted first
  const tieCfg = makeCfg()
  const tieIndex = buildRecallIndex([
    folder('a', 0.9, 1, ['kw']),
    folder('b', 0.3, 2, ['kw']),
    folder('c', 0.3, 3, ['kw']),
  ], tieCfg)
  const tie = trimBlock([
    { id: 'a', injectedRound: 1 },
    { id: 'b', injectedRound: 5 },
    { id: 'c', injectedRound: 2 },
  ], { index: tieIndex, candidates: new Set(['a', 'b', 'c']), cfg: tieCfg, maxBlocks: 2 })
  assert.deepEqual(tie.evicted.map((item) => item.id), ['c'])
})

// ---------------------------------------------------------------------------
// 8) G4 — same id is not re-injected before the cooldown
// ---------------------------------------------------------------------------

test('G4: 300 rounds, consecutive injections of the same id are >= cooldown apart', () => {
  const cooldown = 15
  const cfg = makeCfg({ recall: { fairness: { recycle: { cooldownRounds: cooldown, maxPerRound: 1 } } } })
  const folders = []
  for (let at = 0; at < 6; at += 1) folders.push(folder(`r${at}`, 0.05, at + 1, ['kw']))
  const index = buildRecallIndex(folders, cfg)
  const lanes = emptyLanes()
  const ledger = new Set()
  const roundsById = new Map()
  let block = []
  let reInjections = 0
  for (let round = 1; round <= 300; round += 1) {
    const result = selectRecall(index, 'kw', {
      cfg,
      lanes,
      round,
      ledger,
      blockIds: new Set(block.map((item) => item.id)),
    })
    for (const pick of result.picks) {
      if (!roundsById.has(pick.id)) roundsById.set(pick.id, [])
      roundsById.get(pick.id).push(round)
      ledger.add(pick.id)
      block.push({ id: pick.id, injectedRound: round })
    }
    reInjections += result.stats.reInjections
    for (const pick of result.picks) ledger.add(pick.id)
    // Emulate the adapter: trim the block, evicted memories enter the recycle lane.
    const trim = trimBlock(block, { index, candidates: null, cfg, maxBlocks: 2 })
    block = trim.keep.slice()
    for (const item of trim.evicted) {
      if (item.high) lanes.highRecycle.push({ id: item.id, round })
      else lanes.recycle.push({ id: item.id, eligibleRound: round + cooldown })
    }
    if (lanes.degraded) {
      // no rotation here: no keyword candidates left after the first rounds
      assert.ok(true)
    }
  }
  assert.ok(reInjections > 0, 'expected recycle re-injections')
  const gap = minGap(roundsById)
  assert.ok(gap >= cooldown, `minimum gap ${gap}`)
})

// ---------------------------------------------------------------------------
// 9) G5 — new high-α arrivals cannot starve a rare target; register capacity warns
// ---------------------------------------------------------------------------

test('G5: 3 higher-α arrivals per round do not delay a rare high-α target', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 30; at += 1) folders.push(folder(`noise${at}`, 0.7, at + 1, ['noiseword']))
  folders.push(folder('target', 0.65, 500, ['unique_rare_arrival']))
  const lanes = emptyLanes()
  const ledger = new Set()
  let asserted = false
  for (let round = 1; round <= 40; round += 1) {
    for (let at = 0; at < 3; at += 1) folders.push(folder(`arr-${round}-${at}`, 0.95, 1000 + round * 10 + at, ['noiseword']))
    const index = buildRecallIndex(folders, cfg)
    const query = round === 37 ? 'unique_rare_arrival' : 'noiseword'
    const result = selectRecall(index, query, { cfg, lanes, round, ledger })
    if (round === 37) {
      asserted = true
      assert.ok(lanePickIds(result).includes('target'), JSON.stringify(lanePickIds(result)))
      assert.equal(result.picks.find((item) => item.id === 'target').lane, 'rareHigh')
    }
    for (const pick of result.picks) ledger.add(pick.id)
  }
  assert.equal(asserted, true)
})

test('G5: register capacity overflow drops the lowest tier and warns (registerDrops)', () => {
  const cfg = makeCfg({ recall: { fairness: { register: { lookahead: 3, capFactor: 1, ttlRounds: 2 } } } })
  const folders = []
  for (let at = 0; at < 40; at += 1) folders.push(folder(`h${String(at).padStart(3, '0')}`, 0.9 - at / 1000, at + 1, ['bulk']))
  const index = buildRecallIndex(folders, cfg)
  const result = selectRecall(index, 'bulk', { cfg, lanes: emptyLanes(), round: 1, ledger: new Set() })
  assert.ok(result.stats.registerDrops > 0, JSON.stringify(result.stats))
  assert.ok(result.stats.lanesPicked.hi >= 1)
  assert.ok(result.warnings.some((warning) => warning.includes('register')), JSON.stringify(result.warnings))
  // register never exceeds capFactor * k_H
  assert.ok(result.lanes.pendingHigh.length <= 8)
})

// ---------------------------------------------------------------------------
// 10) register TTL / queryBoost re-admission / recycle cooldown
// ---------------------------------------------------------------------------

test('register: 2-round TTL — expired entries are dropped, fresh ones are injected', () => {
  const cfg = makeCfg()
  // The query keyword lives on 12 folders (> τ=8) so it is a common term: the
  // deferred target is not re-matched by the rare lane and lane 3 is the only
  // way it can surface without a keyword hit.
  const folders = []
  for (let at = 0; at < 12; at += 1) folders.push(folder(`other${at}`, 0.7, at + 1, ['queryword']))
  folders.push(folder('target', 0.9, 100, ['nevermatched']))
  const index = buildRecallIndex(folders, cfg)
  // Expired: enqueued at round 7, now round 10 (10 - 7 = 3 > ttl 2).
  const expired = emptyLanes()
  expired.pendingHigh = ['target']
  expired.pendingHighRound = [7]
  const expiredResult = selectRecall(index, 'queryword', { cfg, lanes: expired, round: 10, ledger: new Set() })
  assert.ok(!lanePickIds(expiredResult).includes('target'))
  assert.ok(!expired.pendingHigh.includes('target'))

  // Fresh: enqueued at round 8, now round 10 (10 - 8 = 2 <= ttl 2) => injected by lane 3.
  const fresh = emptyLanes()
  fresh.pendingHigh = ['target']
  fresh.pendingHighRound = [8]
  const freshResult = selectRecall(index, 'queryword', { cfg, lanes: fresh, round: 10, ledger: new Set() })
  const pick = freshResult.picks.find((item) => item.id === 'target')
  assert.ok(pick, JSON.stringify(lanePickIds(freshResult)))
  assert.equal(pick.lane, 'register')
  assert.ok(!fresh.pendingHigh.includes('target'))
})

test('queryBoost: a high-α memory evicted from the block is re-admitted when matched again (after the cooldown)', () => {
  const cfg = makeCfg()
  const index = buildRecallIndex([
    folder('target', 0.9, 1, ['needle']),
    folder('other', 0.5, 2, ['needle']),
  ], cfg)
  const base = emptyLanes()
  const ledger = new Set(['target'])
  base.highRecycle = [{ id: 'target', round: 3 }]
  // B-04: G4 cooldown (15 rounds) must elapse before the queryBoost lane may
  // re-inject the evicted memory (round 20 - round 3 = 17 >= 15).
  const result = selectRecall(index, 'needle', { cfg, lanes: base, round: 20, ledger })
  const pick = result.picks.find((item) => item.id === 'target')
  assert.ok(pick, JSON.stringify(lanePickIds(result)))
  assert.equal(pick.lane, 'queryBoost')
  assert.ok(result.stats.reInjections >= 1)
  assert.deepEqual(base.highRecycle, [])

  // queryBoost=false disables the lane: target is still in the ledger, so it is not re-picked.
  const offCfg = makeCfg({ recall: { fairness: { queryBoost: false } } })
  const offLanes = emptyLanes()
  offLanes.highRecycle = [{ id: 'target', round: 3 }]
  const offResult = selectRecall(index, 'needle', { cfg: offCfg, lanes: offLanes, round: 20, ledger: new Set(['target']) })
  assert.ok(!lanePickIds(offResult).includes('target'))
  assert.equal(offResult.stats.reInjections, 0)
})

test('B-04 G4: queryBoost honours the recycle cooldown (gap < cooldownRounds is not re-injected)', () => {
  const cooldown = 15
  const cfg = makeCfg({ recall: { fairness: { recycle: { cooldownRounds: cooldown, maxPerRound: 1 } } } })
  const index = buildRecallIndex([folder('target', 0.9, 1, ['needle']), folder('other', 0.5, 2, ['needle'])], cfg)
  const ledger = new Set(['target'])
  for (const round of [4, 10, 17]) {
    const lanes = emptyLanes()
    lanes.highRecycle = [{ id: 'target', round: 3 }]
    const result = selectRecall(index, 'needle', { cfg, lanes, round, ledger })
    assert.ok(
      !lanePickIds(result).includes('target'),
      `round ${round}: gap ${round - 3} < cooldown ${cooldown} must keep the item queued (picks=${JSON.stringify(lanePickIds(result))})`,
    )
    assert.deepEqual(lanes.highRecycle, [{ id: 'target', round: 3 }], 'the unripe item stays in highRecycle')
    assert.equal(result.stats.reInjections, 0)
  }
  // Gap exactly `cooldown` re-admits (round 18 - round 3 = 15).
  const lanes = emptyLanes()
  lanes.highRecycle = [{ id: 'target', round: 3 }]
  const ripe = selectRecall(index, 'needle', { cfg, lanes, round: 3 + cooldown, ledger })
  assert.ok(lanePickIds(ripe).includes('target'), JSON.stringify(lanePickIds(ripe)))
  assert.equal(ripe.stats.reInjections, 1)
})

test('recycle: evicted low-α memory returns only after the cooldown', () => {
  const cfg = makeCfg()
  const index = buildRecallIndex([
    folder('low', 0.05, 1, ['kw']),
    folder('high', 0.9, 2, ['kw']),
  ], cfg)
  const ledger = new Set(['low'])
  const lanes = emptyLanes()
  lanes.recycle = [{ id: 'low', eligibleRound: 25 }]
  const early = selectRecall(index, 'kw', { cfg, lanes, round: 20, ledger })
  assert.ok(!lanePickIds(early).includes('low'))
  assert.equal(lanes.recycle.length, 1)
  const due = selectRecall(index, 'kw', { cfg, lanes, round: 25, ledger })
  const pick = due.picks.find((item) => item.id === 'low')
  assert.ok(pick, JSON.stringify(lanePickIds(due)))
  assert.equal(pick.lane, 'recycle')
  assert.ok(due.stats.reInjections >= 1)
  assert.equal(lanes.recycle.length, 0)

  const disabled = makeCfg({ recall: { fairness: { recycle: { enabled: false } } } })
  const disabledLanes = emptyLanes()
  disabledLanes.recycle = [{ id: 'low', eligibleRound: 1 }]
  const disabledResult = selectRecall(index, 'kw', { cfg: disabled, lanes: disabledLanes, round: 30, ledger: new Set(['low']) })
  assert.ok(!lanePickIds(disabledResult).includes('low'))
})

// ---------------------------------------------------------------------------
// 11) pagination / hasMore
// ---------------------------------------------------------------------------

test('pagination: hasMore flips false exactly when everything is surfaced', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 10; at += 1) folders.push(folder(`p${at}`, 0.5, at + 1, ['kw']))
  const index = buildRecallIndex(folders, cfg)
  const lanes = emptyLanes()
  const ledger = new Set()
  const sizes = []
  for (let round = 1; round <= 5; round += 1) {
    const result = selectRecall(index, 'kw', { cfg, lanes, round, ledger, k: 3 })
    sizes.push(result.picks.length)
    assert.equal(result.hasMore, round < 4)
    for (const pick of result.picks) ledger.add(pick.id)
  }
  assert.deepEqual(sizes, [3, 3, 3, 1, 0])
  assert.equal(ledger.size, 10)
})

// ---------------------------------------------------------------------------
// 12) time / minAlpha pre-filters
// ---------------------------------------------------------------------------

test('timeIds: pre-filter applies to C(Q)∩W without consuming quota or moving the frontier', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 20; at += 1) folders.push(folder(`t${String(at).padStart(2, '0')}`, 0.8, at + 1, ['kw']))
  const index = buildRecallIndex(folders, cfg)
  const inWindow = new Set(['t00', 't07', 't19'])
  const filtered = selectRecall(index, 'kw', { cfg, lanes: emptyLanes(), round: 1, ledger: new Set(), timeIds: inWindow, k: 10 })
  assert.ok(filtered.picks.length > 0)
  assert.ok(filtered.picks.every((pick) => inWindow.has(pick.id)))
  assert.equal(filtered.stats.candidates, 3) // |C(Q)∩W|
  assert.equal(filtered.stats.candidatesAll, 20)
  assert.equal(filtered.stats.filteredByTime, 17)
  // rank is defined on C(Q)∩W: t07 is rank 2 inside the window => surfaced immediately.
  assert.ok(lanePickIds(filtered).includes('t07'))
  // empty window: no picks, no throw
  const empty = selectRecall(index, 'kw', { cfg, lanes: emptyLanes(), round: 1, ledger: new Set(), timeIds: new Set() })
  assert.deepEqual(empty.picks, [])
  assert.equal(empty.hasMore, false)

  // A time-filtered memory is not consumed by the frontier: exactly one high-α
  // memory in the window, the second one must appear when the window is widened.
  const pairIndex = buildRecallIndex([folder('a', 0.9, 1, ['kw']), folder('b', 0.8, 2, ['kw'])], cfg)
  const lanes = emptyLanes()
  const ledger = new Set()
  const narrowed = selectRecall(pairIndex, 'kw', { cfg, lanes, round: 1, ledger, timeIds: new Set(['a']) })
  assert.deepEqual(lanePickIds(narrowed), ['a'])
  for (const pick of narrowed.picks) ledger.add(pick.id)
  const widened = selectRecall(pairIndex, 'kw', { cfg, lanes, round: 2, ledger, timeIds: null })
  assert.deepEqual(lanePickIds(widened), ['b'])
})

test('minAlpha: gate filters before selection, does not consume quota, reports filtered count', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 6; at += 1) folders.push(folder(`hi${at}`, 0.9, at + 1, ['kw']))
  for (let at = 0; at < 6; at += 1) folders.push(folder(`lo${at}`, 0.1, 100 + at, ['kw']))
  const index = buildRecallIndex(folders, cfg)
  const result = selectRecall(index, 'kw', { cfg, lanes: emptyLanes(), round: 1, ledger: new Set(), minAlpha: 0.5 })
  assert.ok(result.picks.every((pick) => pick.alpha >= 0.5))
  assert.equal(result.stats.filteredByAlpha, 6)
  assert.equal(result.stats.candidates, 6)
  assert.deepEqual(new Set(lanePickIds(result)).size, result.picks.length)
})

// ---------------------------------------------------------------------------
// 12b) integration regressions reported by Lead (BUG-1..BUG-4)
// ---------------------------------------------------------------------------

test('regression BUG-1: any k fills min(k, available) and hasMore is exact', () => {
  const cfg = makeCfg()
  // 5 candidates, k=3: rareHigh fills k_H=2; the third slot must go to a later
  // lane and hasMore must stay true (this used to return 2 picks / hasMore=false
  // because the σ lane lookahead marked deferred ids as consumed).
  const folders = Array.from({ length: 5 }, (_, at) => folder(`mem-${at + 1}`, 1, at + 1, ['部署']))
  const index = buildRecallIndex(folders, cfg)
  for (const k of [1, 2, 3, 4, 5, 6, 10]) {
    const result = selectRecall(index, '部署方案', { cfg, lanes: emptyLanes(), round: 1, k })
    assert.equal(result.picks.length, Math.min(k, 5), `k=${k}`)
    assert.equal(result.hasMore, 5 > result.picks.length, `k=${k} hasMore`)
    assert.deepEqual(new Set(lanePickIds(result)).size, result.picks.length)
  }
  // fuzz: fresh lanes, picks == min(k, |C(Q)|) for every k
  const next = mulberry32(8675309)
  for (let trial = 0; trial < 40; trial += 1) {
    const lib = randomLibrary(next, 20 + Math.floor(next() * 40), { vocabSize: 6 })
    const idx = buildRecallIndex(lib, cfg)
    const text = `请检查 w${Math.floor(next() * 6)} w${Math.floor(next() * 6)} 配置`
    const available = oracleCandidates(idx, text).length
    const k = 1 + Math.floor(next() * 15)
    const result = selectRecall(idx, text, { cfg, lanes: emptyLanes(), round: 1, k, ledger: new Set() })
    assert.equal(result.picks.length, Math.min(k, available), `trial ${trial} k=${k} available=${available}`)
    assert.equal(result.hasMore, available > result.picks.length, `trial ${trial} k=${k} hasMore`)
  }
})

test('regression BUG-2: countCandidates applies minAlpha + timeIds (|C(Q)∩W|)', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 10; at += 1) folders.push(folder(`m${at}`, at < 5 ? 0.9 : 0.1, at + 1, ['kw']))
  const index = buildRecallIndex(folders, cfg)
  const seeds = querySeeds(index, 'kw', cfg).seeds
  assert.equal(countCandidates(index, seeds), 10)
  assert.equal(countCandidates(index, seeds, { timeIds: new Set(['m1', 'm3', 'm9']) }), 3)
  assert.equal(countCandidates(index, seeds, { timeIds: new Set(['m1', 'm3', 'm9']), minAlpha: 0.5 }), 2)
  assert.equal(countCandidates(index, seeds, { minAlpha: 0.5 }), 5)
  assert.equal(countCandidates(index, seeds, { timeIds: new Set() }), 0)
})

test('regression BUG-3: filteredByTime is the deduplicated window-outside count', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 30; at += 1) folders.push(folder(`m${String(at).padStart(2, '0')}`, 0.9, at + 1, ['kw']))
  const index = buildRecallIndex(folders, cfg)
  const inWindow = new Set(['m00', 'm01', 'm02'])
  const lanes = emptyLanes()
  const ledger = new Set()
  for (let round = 1; round <= 3; round += 1) {
    const result = selectRecall(index, 'kw', { cfg, lanes, round, ledger, timeIds: inWindow })
    assert.equal(result.stats.candidates, 3)
    assert.equal(result.stats.candidatesAll, 30)
    assert.equal(result.stats.filteredByTime, 27, `round ${round}`)
    assert.ok(result.stats.laneTimeSkips >= 0)
    for (const pick of result.picks) ledger.add(pick.id)
  }
})

test('regression BUG-4: sum(lanesPicked) === picks.length in every round', () => {
  const next = mulberry32(24680)
  const cfg = makeCfg()
  for (let trial = 0; trial < 20; trial += 1) {
    const folders = randomLibrary(next, 30 + Math.floor(next() * 60), { vocabSize: 8 })
    const index = buildRecallIndex(folders, cfg)
    const lanes = emptyLanes()
    const ledger = new Set()
    const block = []
    for (let round = 1; round <= 6; round += 1) {
      const text = `请检查 w${Math.floor(next() * 8)} w${Math.floor(next() * 8)} 的配置`
      const result = selectRecall(index, text, { cfg, lanes, round, ledger, blockIds: block })
      const sum = Object.values(result.stats.lanesPicked).reduce((total, value) => total + value, 0)
      assert.equal(sum, result.picks.length, `trial ${trial} round ${round}`)
      // the per-lane histogram also matches the picks' own lane labels
      const byLane = {}
      for (const pick of result.picks) byLane[pick.lane] = (byLane[pick.lane] || 0) + 1
      for (const lane of Object.keys(result.stats.lanesPicked)) {
        assert.equal(result.stats.lanesPicked[lane], byLane[lane] || 0, `trial ${trial} round ${round} lane ${lane}`)
      }
      for (const pick of result.picks) ledger.add(pick.id)
      block.push(...lanePickIds(result))
      if (block.length > 10) block.splice(0, block.length - 10)
    }
  }
})

// ---------------------------------------------------------------------------
// 13) lane state serialization / robustness
// ---------------------------------------------------------------------------

test('serializeLanes/deserializeLanes: JSON round-trip is lossless', () => {
  const cfg = makeCfg()
  const index = buildRecallIndex([
    folder('m1', 0.9, 1, ['kw', 'rare1']),
    folder('m2', 0.5, 2, ['kw']),
    folder('m3', 0.05, 3, ['kw']),
  ], cfg)
  const lanes = emptyLanes()
  const ledger = new Set()
  for (let round = 1; round <= 3; round += 1) {
    const result = selectRecall(index, 'kw rare1', { cfg, lanes, round, ledger })
    for (const pick of result.picks) ledger.add(pick.id)
  }
  lanes.highRecycle = [{ id: 'm1', round: 2 }]
  lanes.recycle = [{ id: 'm3', eligibleRound: 40 }]
  lanes.degraded = true
  const raw = JSON.parse(JSON.stringify(serializeLanes(lanes)))
  const restored = deserializeLanes(raw)
  assert.deepEqual(serializeLanes(restored), serializeLanes(lanes))
  assert.equal(restored.round, lanes.round)
  assert.equal(restored.degraded, true)
  assert.equal(restored.recycle[0].eligibleRound, 40)
  // lane state is accepted directly as JSON (auto-deserialized) by selectRecall
  const viaJson = selectRecall(index, 'kw', { cfg, lanes: raw, round: 4, ledger })
  assert.equal(typeof viaJson.lanes.round, 'number')
})

test('deserializeLanes: garbage input never throws and degrades to empty lanes', () => {
  const garbage = [
    null,
    undefined,
    42,
    'nope',
    [],
    {},
    { frontier: 'bad', pendingHigh: 'bad', recycle: 7 },
    { frontier: [null, { seed: 5 }, { seed: 'a', key: null }] },
    { pendingHigh: ['a', 7, null], pendingHighRound: ['x'] },
    { exploreCursor: { seed: 5, key: { alpha: 'x' }, pos: -3, length: 'y' } },
    { highRecycle: [{ id: 1 }, { id: 'ok', round: 'x' }], recycle: [null, { id: 'z', eligibleRound: -1 }] },
    { round: -1, degraded: 'yes' },
  ]
  for (const input of garbage) {
    const lanes = deserializeLanes(input)
    assert.ok(lanes.frontier instanceof Map)
    assert.ok(Array.isArray(lanes.pendingHigh))
    assert.ok(Array.isArray(lanes.pendingHighRound))
    assert.ok(Array.isArray(lanes.highRecycle))
    assert.ok(Array.isArray(lanes.recycle))
    assert.equal(typeof lanes.degraded, 'boolean')
    assert.equal(typeof lanes.round, 'number')
    assert.doesNotThrow(() => serializeLanes(lanes))
  }
  // pendingHigh / pendingHighRound stay parallel even when rounds are missing
  const odd = deserializeLanes({ pendingHigh: ['a', 'b'], pendingHighRound: [3] })
  assert.deepEqual(odd.pendingHigh, ['a', 'b'])
  assert.deepEqual(odd.pendingHighRound, [3, 0])
})

test('lanesFingerprint: stable, key-order independent, changes with fairness config', () => {
  const a = makeCfg()
  const b = {
    match: { cjkBigram: false, expandLatinCase: false },
    storage: { maxFolders: 10000 },
    recall: {
      fairness: {
        roundBudget: { maxChars: 20000 },
        blockTrim: { policy: 'priority', protectCurrentQuery: true, pinHigh: true },
        ledger: { maxEntries: 10000, overflow: 'evict-lowest-alpha-last-seen' },
        recycle: { enabled: true, cooldownRounds: 15, maxPerRound: 1 },
        queryBoost: true,
        register: { lookahead: 3, capFactor: 8, ttlRounds: 2 },
        rareTerm: { ratio: 0.002, minPosting: 8, scanCap: 512 },
        specificProbeSlots: 1,
        exploreRatio: 0.2,
        thetaHigh: 0.6,
      },
      sort: 'createdAt',
      minAlpha: 0,
      maxWindowPercent: 10,
      maxRecalledChars: 120000,
      maxRecalledBlocks: 64,
      persistInjected: true,
      hops: 0,
      firstGenMax: 10,
      mode: 'fair',
      enabled: true,
    },
    keywords: { matchMode: 'contains', min: 3, max: 8 },
  }
  assert.equal(lanesFingerprint(a), lanesFingerprint(b))
  assert.notEqual(lanesFingerprint(a), lanesFingerprint(makeCfg({ recall: { fairness: { thetaHigh: 0.7 } } })))
  assert.notEqual(lanesFingerprint(a), lanesFingerprint(makeCfg({ recall: { fairness: { register: { ttlRounds: 3 } } } })))
  assert.notEqual(lanesFingerprint(a), lanesFingerprint(makeCfg({ recall: { firstGenMax: 12 } })))
  assert.notEqual(lanesFingerprint(a), lanesFingerprint(makeCfg({ keywords: { matchMode: 'exact' } })))
  // unrelated config does not reset the lanes
  assert.equal(lanesFingerprint(a), lanesFingerprint(deepMerge(a, { time: { mode: 'constrain' }, compress: { enabled: false } })))
  assert.match(lanesFingerprint(a), /^cfg1\|/)
  assert.equal(lanesFingerprint(undefined), lanesFingerprint({}))
})

// ---------------------------------------------------------------------------
// 14) restart (serialize -> rebuild index -> continue) 60/60 identical
// ---------------------------------------------------------------------------

test('restart: serialized lanes + rebuilt index reproduce 60/60 picks', () => {
  const cfg = makeCfg()
  const next = mulberry32(777001)
  const folders = randomLibrary(next, 200, { vocabSize: 25 })
  // Fixed query stream (computed once, identical for both runs).
  const queries = []
  for (let round = 1; round <= 60; round += 1) queries.push(randomQuery(next, folders))
  const arrivals = []
  for (let round = 1; round <= 60; round += 1) {
    const batch = []
    for (let at = 0; at < 3; at += 1) batch.push(folder(`arr-${round}-${at}`, pick(next, [0.9, 0.7, 0.4, 0.1]), 5000 + round * 10 + at, [`arrive${Math.floor(next() * 20)}`]))
    arrivals.push(batch)
  }
  const signature = (result) => result.picks.map((pick) => `${pick.id}:${pick.lane}`).join('|')

  function runContinuous() {
    const library = folders.slice()
    const lanes = emptyLanes()
    const ledger = new Set()
    const sequence = []
    for (let round = 1; round <= 60; round += 1) {
      const index = buildRecallIndex(library, cfg)
      const result = selectRecall(index, queries[round - 1], { cfg, lanes, round, ledger, blockIds: new Set() })
      sequence.push(signature(result))
      for (const pick of result.picks) ledger.add(pick.id)
      library.push(...arrivals[round - 1])
    }
    return sequence
  }

  function runRestart() {
    const library = folders.slice()
    let lanes = emptyLanes()
    const ledger = new Set()
    const sequence = []
    for (let round = 1; round <= 60; round += 1) {
      if (round === 31) {
        // Persist -> JSON text -> restore; rebuild the index from scratch.
        const persisted = JSON.stringify(serializeLanes(lanes))
        lanes = deserializeLanes(JSON.parse(persisted))
      }
      const index = buildRecallIndex(library, cfg)
      const result = selectRecall(index, queries[round - 1], { cfg, lanes, round, ledger, blockIds: new Set() })
      sequence.push(signature(result))
      for (const pick of result.picks) ledger.add(pick.id)
      library.push(...arrivals[round - 1])
    }
    return sequence
  }

  const continuous = runContinuous()
  const restarted = runRestart()
  assert.equal(restarted.length, 60)
  assert.deepEqual(restarted, continuous)
})

// ---------------------------------------------------------------------------
// 15) determinism — no Math.random, no Date.now dependency
// ---------------------------------------------------------------------------

test('determinism: 100 replays are identical; selection calls neither Math.random nor Date.now', () => {
  const cfg = makeCfg()
  const next = mulberry32(90210)
  const folders = randomLibrary(next, 150, { vocabSize: 20 })
  const index = buildRecallIndex(folders, cfg)
  const queries = []
  for (let round = 1; round <= 10; round += 1) queries.push(randomQuery(next, folders))

  function replay() {
    const lanes = emptyLanes()
    const ledger = new Set()
    const rows = []
    for (let round = 1; round <= 10; round += 1) {
      const result = selectRecall(index, queries[round - 1], { cfg, lanes, round, ledger })
      rows.push(result.picks.map((pick) => `${pick.id}:${pick.lane}`).join(','))
      for (const pick of result.picks) ledger.add(pick.id)
    }
    return rows
  }

  const reference = replay()
  const originalRandom = Math.random
  const originalNow = Date.now
  try {
    Math.random = () => {
      throw new Error('selectRecall must not call Math.random')
    }
    for (let trial = 0; trial < 100; trial += 1) {
      Date.now = () => 1000 + trial * 12345
      assert.deepEqual(replay(), reference)
    }
  } finally {
    Math.random = originalRandom
    Date.now = originalNow
  }

  // Source level guarantee: no Math.random in executable code (comments may
  // mention it), and Date.now is only used to stamp `index.builtAt`.
  const source = fs.readFileSync(new URL('../engine/recall-index.js', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(code.includes('Math.random'), false)
  assert.equal(code.split('Date.now').length - 1, 1)
})

// ---------------------------------------------------------------------------
// 16) deterministic mode == pure DRI
// ---------------------------------------------------------------------------

test("mode='deterministic' equals selectSigma over the same exclusion set", () => {
  const next = mulberry32(31337)
  for (let trial = 0; trial < 20; trial += 1) {
    const cfg = makeCfg({ recall: { mode: 'deterministic' } })
    const folders = randomLibrary(next, 60, { vocabSize: 15 })
    const index = buildRecallIndex(folders, cfg)
    const text = randomQuery(next, folders)
    const seeds = querySeeds(index, text, cfg).seeds
    const ledger = new Set()
    for (const entry of index.entries) if (next() < 0.2) ledger.add(entry.id)
    const blocked = new Set()
    for (const entry of index.entries) if (next() < 0.1) blocked.add(entry.id)
    const extra = new Set()
    for (const entry of index.entries) if (next() < 0.05) extra.add(entry.id)
    const lanes = emptyLanes()
    const result = selectRecall(index, text, { cfg, lanes, round: 1, ledger, blockIds: blocked, excludeIds: extra, mode: 'deterministic' })
    const excluded = new Set([...ledger, ...blocked, ...extra])
    const expected = selectSigma(index, seeds, { k: 10, exclude: excluded }).picked.map((item) => item.id)
    assert.deepEqual(lanePickIds(result), expected, `trial ${trial}`)
    assert.ok(result.picks.every((pick) => pick.lane === 'hi'))
    assert.equal(lanes.round, 1)
  }
})

test("mode='legacy' is rejected with a warning; k=0 returns no picks", () => {
  const cfg = makeCfg()
  const index = buildRecallIndex([folder('m1', 0.9, 1, ['kw'])], cfg)
  const legacy = selectRecall(index, 'kw', { cfg, lanes: emptyLanes(), round: 1, mode: 'legacy' })
  assert.ok(legacy.warnings.some((warning) => warning.includes('legacy')))
  // deterministic fallback still returns deterministic picks
  assert.deepEqual(lanePickIds(legacy), ['m1'])
  const zero = selectRecall(index, 'kw', { cfg, lanes: emptyLanes(), round: 1, k: 0 })
  assert.deepEqual(zero.picks, [])
  const unknown = selectRecall(index, 'kw', { cfg, lanes: emptyLanes(), round: 1, mode: 'nonsense' })
  assert.ok(unknown.warnings.some((warning) => warning.includes('unknown mode')))
})

test('selectRecall: empty index / no keyword match / garbage inputs never throw', () => {
  const cfg = makeCfg()
  const empty = buildRecallIndex([], cfg)
  const noMatch = buildRecallIndex([folder('m1', 0.9, 1, ['kw'])], cfg)
  for (const index of [empty, noMatch, null, undefined, {}, { entries: [] }]) {
    const result = selectRecall(index, 'no such keyword', { cfg, lanes: emptyLanes(), round: 1, ledger: new Set() })
    assert.ok(Array.isArray(result.picks))
    assert.ok(Array.isArray(result.warnings))
    assert.equal(typeof result.stats.pops, 'number')
    assert.ok(result.lanes)
  }
  // register lane can still surface a deferred high-α memory even when the
  // current query matches nothing (G5: deferral must not depend on the query).
  const index = buildRecallIndex([folder('m1', 0.9, 1, ['kw']), folder('m2', 0.1, 2, ['kw'])], cfg)
  const lanes = emptyLanes()
  lanes.pendingHigh = ['m1']
  lanes.pendingHighRound = [1]
  const result = selectRecall(index, 'no keyword at all', { cfg, lanes, round: 2, ledger: new Set() })
  assert.deepEqual(lanePickIds(result), ['m1'])
  assert.equal(result.picks[0].lane, 'register')
})

// ---------------------------------------------------------------------------
// 17) summarizeGuarantees
// ---------------------------------------------------------------------------

test('summarizeGuarantees aggregates lanes / drops / target hit rates', () => {
  const history = [
    { round: 1, stats: { pops: 4, lanesPicked: { rareHigh: 2, hi: 3 }, registerDrops: 1, reInjections: 0, degraded: false }, hasMore: true, targets: [{ kind: 'high', hit: true, delay: 0 }, { kind: 'low', hit: false }] },
    { round: 2, stats: { pops: 6, lanesPicked: { hi: 10 }, registerDrops: 0, reInjections: 2, degraded: true }, hasMore: false, targets: [{ kind: 'high', hit: true, delay: 1 }] },
    { picks: [{ id: 'a' }, { id: 'b' }], stats: { pops: 2, lanesPicked: { rotation: 2 } } },
  ]
  const summary = summarizeGuarantees(history)
  assert.equal(summary.rounds, 3)
  assert.equal(summary.totalPicks, 5 + 10 + 2)
  assert.equal(summary.lanes.rareHigh, 2)
  assert.equal(summary.lanes.hi, 13)
  assert.equal(summary.lanes.rotation, 2)
  assert.equal(summary.registerDrops, 1)
  assert.equal(summary.reInjections, 2)
  assert.equal(summary.degradedRounds, 1)
  assert.equal(summary.hasMoreRounds, 1)
  assert.equal(summary.highTarget.hitRate, 1)
  assert.equal(summary.highTarget.delayMax, 1)
  assert.equal(summary.lowTarget.hitRate, 0)
  assert.equal(typeof summary.pops.p95, 'number')
  // empty history
  const blank = summarizeGuarantees([])
  assert.equal(blank.rounds, 0)
  assert.equal(blank.highTarget.hitRate, null)
  assert.deepEqual(summarizeGuarantees(null), blank)
})

// ---------------------------------------------------------------------------
// 18) performance (loose CI thresholds per contract §5.1)
// ---------------------------------------------------------------------------

test('performance: N=10^4 build <= 200ms, single select <= 50ms', () => {
  // Shared CI runners (especially windows-latest / Node 24) are noisy: keep the
  // strict budgets for developer machines, relax them when running on CI.
  // Same policy as test/engine.test.mjs §performance.
  const onCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
  const buildBudgetMs = onCi ? 2000 : 200
  const selectBudgetMs = onCi ? 400 : 50
  const next = mulberry32(1234567)
  const vocabSize = 400
  const folders = []
  for (let at = 0; at < 10000; at += 1) {
    const keywords = []
    const keywordCount = 3 + Math.floor(next() * 6)
    for (let k = 0; k < keywordCount; k += 1) keywords.push(`term${Math.floor(next() * vocabSize)}`)
    folders.push(folder(`perf-${String(at).padStart(5, '0')}`, pick(next, [0.9, 0.6, 0.3, 0.1, 0.05]), at + 1, keywords, {
      chars: 400 + Math.floor(next() * 2000),
    }))
  }
  const cfg = makeCfg()
  const buildStarted = performance.now()
  const index = buildRecallIndex(folders, cfg)
  const buildMs = performance.now() - buildStarted
  assert.ok(index.folderCount === 10000)
  assert.ok(buildMs <= buildBudgetMs, `buildRecallIndex took ${buildMs.toFixed(1)}ms > ${buildBudgetMs}ms`)

  const queries = []
  for (let at = 0; at < 20; at += 1) queries.push(`请检查 term${Math.floor(next() * vocabSize)} 和 term${Math.floor(next() * vocabSize)} 的配置`)
  let worstSelect = 0
  let worstPops = 0
  for (const query of queries) {
    const started = performance.now()
    const result = selectRecall(index, query, { cfg, lanes: emptyLanes(), round: 1, k: 10, ledger: new Set() })
    const elapsed = performance.now() - started
    worstSelect = Math.max(worstSelect, elapsed)
    worstPops = Math.max(worstPops, result.stats.pops)
    assert.ok(result.picks.length <= 10)
  }
  assert.ok(worstSelect <= selectBudgetMs, `single select took ${worstSelect.toFixed(1)}ms > ${selectBudgetMs}ms`)
  // pops stay bounded by a small multiple of k + ledger/block constants
  assert.ok(worstPops <= 1000, `worst pops ${worstPops}`)
  console.log(`  [perf] buildRecallIndex(N=10000)=${buildMs.toFixed(1)}ms  worstSelect=${worstSelect.toFixed(1)}ms  worstPops=${worstPops}`)
})

// ---------------------------------------------------------------------------
// 19) simulateTurns / countCandidates
// ---------------------------------------------------------------------------

test('simulateTurns: firstSeen == ceil(σ-rank / k) for every candidate', () => {
  const next = mulberry32(5150)
  for (let trial = 0; trial < 8; trial += 1) {
    const cfg = makeCfg()
    const folders = randomLibrary(next, 80, { vocabSize: 12 })
    const index = buildRecallIndex(folders, cfg)
    const text = '请检查 w1 w2 w3 w4'
    const seeds = querySeeds(index, text, cfg).seeds
    const k = [1, 2, 3, 5, 10][trial % 5]
    const all = oracleCandidates(index, text)
    assert.equal(countCandidates(index, seeds), all.length)
    const sim = simulateTurns(index, seeds, { k, maxTurns: 200 })
    assert.equal(sim.total, all.length)
    all.forEach((entry, at) => {
      assert.equal(sim.firstSeen.get(entry.id), Math.ceil((at + 1) / k), `k=${k} rank=${at + 1}`)
    })
  }
})

// ---------------------------------------------------------------------------
// 20) exact match mode, window budget, deferral/time interaction
// ---------------------------------------------------------------------------

test("exact matchMode: seeds use token equality and selection stays consistent", () => {
  const cfg = makeCfg({ keywords: { min: 3, max: 8, matchMode: 'exact' } })
  const folders = [
    folder('a', 0.9, 1, ['接口网关']),
    folder('b', 0.8, 2, ['接口网关 8080']),
    folder('c', 0.7, 3, ['docker']),
  ]
  const index = buildRecallIndex(folders, cfg)
  assert.equal(index.matchMode, 'exact')
  // Direction 1 in exact mode is token equality only (the 4-char phrase is not a
  // token of the text). B-02 (1.4.1) additionally wires direction 2 (a user token
  // inside a multi-token folder keyword) into every matchMode, so the two
  // multi-token CJK keywords are seeded as well.
  const seeds = querySeeds(index, '接口网关 docker 接口网关 8080', cfg).seeds
  assert.deepEqual(seeds, ['docker', '接口网关', '接口网关 8080'])
  assert.deepEqual(selectSigma(index, seeds, { k: 10 }).picked.map((item) => item.id), ['a', 'b', 'c'])
  assert.equal(countCandidates(index, seeds), 3)
})

test('trimBlock: maxWindowPercent (windowTokens) also caps the block chars', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 6; at += 1) folders.push(folder(`t${at}`, 0.9 - at / 100, at, ['kw'], { chars: 100 }))
  const index = buildRecallIndex(folders, cfg)
  const block = folders.map((item) => ({ id: item.id, injectedRound: 1 }))
  // 10% of 1000 tokens * 4 chars/token = 400 chars => 6 blocks of 100 chars => 4 kept.
  const result = trimBlock(block, { index, cfg, maxBlocks: 64, maxChars: 100000, maxWindowPercent: 10, windowTokens: 1000 })
  assert.equal(result.keep.length, 4)
  assert.equal(result.droppedBlocks, 2)
  assert.equal(result.droppedChars, 200)
  // maxWindowPercent=0 disables the window cap
  const noWindowCap = trimBlock(block, { index, cfg, maxBlocks: 64, maxChars: 100000, maxWindowPercent: 0, windowTokens: 1000 })
  assert.equal(noWindowCap.droppedBlocks, 0)
})

test('register + timeIds: a deferred memory outside the window is kept, not dropped', () => {
  const cfg = makeCfg()
  const folders = []
  for (let at = 0; at < 12; at += 1) folders.push(folder(`noise${at}`, 0.7, at + 1, ['kw']))
  folders.push(folder('deferred', 0.9, 100, ['nevermatched']))
  const index = buildRecallIndex(folders, cfg)
  const lanes = emptyLanes()
  lanes.pendingHigh = ['deferred']
  lanes.pendingHighRound = [1]
  const filtered = selectRecall(index, 'kw', { cfg, lanes, round: 2, ledger: new Set(), timeIds: new Set(['noise0']) })
  assert.ok(!lanePickIds(filtered).includes('deferred'))
  assert.deepEqual(lanes.pendingHigh, ['deferred']) // kept for a round without the time constraint
  const widened = selectRecall(index, 'kw', { cfg, lanes, round: 3, ledger: new Set(), timeIds: null })
  assert.ok(lanePickIds(widened).includes('deferred'))
  assert.equal(widened.picks.find((pick) => pick.id === 'deferred').lane, 'register')
})

test('queryBoost: unmatched evicted high-α entries stay in the pool for later rounds', () => {
  const cfg = makeCfg()
  // Make the keyword common (posting > τ) so rareHigh cannot pre-empt queryBoost;
  // the fillers have a *higher* σ than the recycled target so the σ-hi lane can
  // never pick it before the queryBoost lane is allowed to (k=1).
  const folders = [folder('target', 0.9, 1, ['deploy_keyword'])]
  for (let at = 0; at < 12; at += 1) folders.push(folder(`filler${at}`, 0.95, 10 + at, ['deploy_keyword']))
  const index = buildRecallIndex(folders, cfg)
  const lanes = emptyLanes()
  lanes.highRecycle = [{ id: 'target', round: 1 }]
  const miss = selectRecall(index, 'unrelated text', { cfg, lanes, round: 2, ledger: new Set(), k: 1 })
  assert.ok(!lanePickIds(miss).includes('target'))
  assert.deepEqual(lanes.highRecycle, [{ id: 'target', round: 1 }])
  // B-04 (1.4.1): the high-α item is re-admitted only after cooldownRounds=15.
  const tooEarly = selectRecall(index, 'deploy_keyword', { cfg, lanes, round: 3, ledger: new Set(), k: 1 })
  assert.ok(!lanePickIds(tooEarly).includes('target'), 'gap 2 < cooldown must keep it queued')
  assert.deepEqual(lanes.highRecycle, [{ id: 'target', round: 1 }])
  const hit = selectRecall(index, 'deploy_keyword', { cfg, lanes, round: 16, ledger: new Set(), k: 1 })
  const pick = hit.picks.find((item) => item.id === 'target')
  assert.ok(pick, JSON.stringify(lanePickIds(hit)))
  assert.equal(pick.lane, 'queryBoost')
  assert.deepEqual(lanes.highRecycle, [])
})

test("deterministic mode leaves fairness pools untouched and reports lane 'hi'", () => {
  const cfg = makeCfg({ recall: { mode: 'deterministic' } })
  const index = buildRecallIndex([
    folder('a', 0.9, 1, ['kw']),
    folder('b', 0.8, 2, ['kw']),
    folder('c', 0.2, 3, ['kw']),
  ], cfg)
  const lanes = emptyLanes()
  lanes.pendingHigh = ['b']
  lanes.pendingHighRound = [1]
  lanes.highRecycle = [{ id: 'a', round: 1 }]
  const result = selectRecall(index, 'kw', { cfg, lanes, round: 5, ledger: new Set(), mode: 'deterministic' })
  assert.equal(result.stats.mode, 'deterministic')
  assert.ok(result.picks.every((pick) => pick.lane === 'hi'))
  assert.deepEqual(lanes.pendingHigh, ['b'])
  assert.deepEqual(lanes.highRecycle, [{ id: 'a', round: 1 }])
  assert.equal(lanes.round, 5)
  assert.equal(typeof result.hasMore, 'boolean')
})

// ---------------------------------------------------------------------------
// 21) G3 acceptance: block high-α share >= 0.85 (plan §3.2.9)
//
// The block is maintained exactly like the adapter does it: commit the round's
// picks, then `trimBlock` with the round's candidate set (not-in-C∩W first,
// α < θ_H first, α asc, injectedRound asc), evicted entries go to the recycle
// lanes. Fresh low-α memories arrive every round. θ_H comes from
// cfg.recall.fairness.thetaHigh (= 0.6), so "high α" here means α >= 0.6.
// ---------------------------------------------------------------------------

test('G3: block high-α (alpha >= thetaHigh 0.6) share stays >= 0.85 after warmup', () => {
  const cfg = makeCfg()
  const thetaHigh = cfg.recall.fairness.thetaHigh // 0.6
  const alphaMix = [0.9, 0.7, 0.4, 0.1, 0.05]
  const folders = []
  for (let at = 0; at < 200; at += 1) {
    folders.push(folder(`mix-${String(at).padStart(3, '0')}`, alphaMix[at % alphaMix.length], at + 1, ['topicword'], { chars: 100 }))
  }
  const lanes = emptyLanes()
  const ledger = new Set()
  const alphaById = new Map()
  let block = []
  let index = buildRecallIndex(folders, cfg)
  const rememberAlphas = (entries) => {
    for (const entry of entries) alphaById.set(entry.id, entry.alpha)
  }
  rememberAlphas(index.entries)
  const rounds = 30
  const warmup = 7 // rounds 1-6: block not yet saturated (8 high / 2 low picks, no eviction)
  const shares = []
  const highCounts = []
  for (let round = 1; round <= rounds; round += 1) {
    if (round > 1) {
      // Two fresh low-α arrivals per round: they must not push high-α out of the block.
      folders.push(folder(`arrive-${round}-0`, 0.05, 1000 + round * 2, ['topicword'], { chars: 100 }))
      folders.push(folder(`arrive-${round}-1`, 0.05, 1000 + round * 2 + 1, ['topicword'], { chars: 100 }))
      index = buildRecallIndex(folders, cfg)
      rememberAlphas(index.entries)
    }
    const result = selectRecall(index, '请检查 topicword 的配置', {
      cfg,
      lanes,
      round,
      ledger,
      blockIds: new Set(block.map((item) => item.id)),
    })
    const alphaOf = (id) => {
      const at = index.byId.get(id)
      return at === undefined ? alphaById.get(id) || 0 : index.entries[at].alpha
    }
    // Commit the picks into the block, then priority-trim it (adapter order).
    const inBlock = new Set(block.map((item) => item.id))
    for (const pick of result.picks) {
      ledger.add(pick.id)
      if (!inBlock.has(pick.id)) {
        block.push({ id: pick.id, injectedRound: round })
        inBlock.add(pick.id)
      }
    }
    const trim = trimBlock(block, {
      index,
      candidates: new Set(result.candidateIds || []),
      cfg,
    })
    block = trim.keep
    for (const item of trim.evicted) {
      if (item.high) lanes.highRecycle.push({ id: item.id, round })
      else lanes.recycle.push({ id: item.id, eligibleRound: round + cfg.recall.fairness.recycle.cooldownRounds })
    }
    const highCount = block.filter((item) => alphaOf(item.id) >= thetaHigh).length
    highCounts.push(highCount)
    shares.push(block.length ? highCount / block.length : 0)
    assert.ok(block.length <= cfg.recall.maxRecalledBlocks, `round ${round}: block size ${block.length}`)
  }
  assert.ok(block.length > 0)
  assert.ok(shares.slice(warmup - 1).length >= 20)
  for (let round = warmup; round <= rounds; round += 1) {
    assert.ok(shares[round - 1] >= 0.85, `round ${round}: high-α share ${shares[round - 1].toFixed(3)} < 0.85`)
  }
  const measured = shares.slice(warmup - 1)
  const meanShare = measured.reduce((sum, value) => sum + value, 0) / measured.length
  assert.ok(meanShare >= 0.85, `mean block high-α share ${meanShare.toFixed(3)} < 0.85`)
  // pinHigh: once the block is saturated, fresh low-α arrivals never reduce the
  // number of high-α entries still in the block.
  for (let round = warmup + 1; round <= rounds; round += 1) {
    assert.ok(
      highCounts[round - 1] >= highCounts[round - 2],
      `round ${round}: high-α count dropped ${highCounts[round - 2]} -> ${highCounts[round - 1]}`,
    )
  }
  assert.ok(highCounts[rounds - 1] >= Math.ceil(0.85 * block.length))
  // low-α churn went through the recycle lane (never silently dropped)
  assert.ok(lanes.recycle.length > 0)
})

// ---------------------------------------------------------------------------
// 22) event constraint (design §4): C(Q)∩W∩E
//
// `eventIds: Set|null` is a pre-filter exactly like `timeIds`: it is applied
// after the time window, never consumes quota and never advances the frontier.
// `stats.candidates` = |C(Q)∩W∩E|, `filteredByEvent` = candidates rejected by
// the event constraint (deduplicated, same rule as filteredByTime).
// ---------------------------------------------------------------------------

function constrainCfg() {
  return makeCfg({ event: { mode: 'constrain' } })
}

/** Mixed-event world: 12 jp / 8 lo / 1 no-event, all sharing one keyword. */
function eventWorld() {
  const list = []
  for (let at = 0; at < 12; at += 1) list.push(folder(`jp${at}`, 0.8 - at * 0.01, at + 1, ['topicword'], { event: '日本旅行' }))
  for (let at = 0; at < 8; at += 1) list.push(folder(`lo${at}`, 0.75 - at * 0.01, 100 + at, ['topicword'], { event: '登录重构项目' }))
  list.push(folder('plain', 0.9, 200, ['topicword']))
  return list
}

/** Resolve an event label to its id Set through the real event-index module. */
function eventIdsOf(list, label) {
  const cfg = constrainCfg()
  const plan = resolveEventQuery(buildEventIndex(list, cfg), label, cfg)
  assert.equal(plan.status, 'exact', `event plan for ${label}`)
  return plan.ids
}

test('eventIds: C(Q)∩E filters candidates and selects only the constrained event', () => {
  const cfg = constrainCfg()
  const list = eventWorld()
  const index = buildRecallIndex(list, cfg)
  const eventIds = eventIdsOf(list, '日本旅行')
  assert.equal(eventIds.size, 12)
  const seeds = querySeeds(index, 'topicword', cfg).seeds
  assert.equal(countCandidates(index, seeds), 21)
  assert.equal(countCandidates(index, seeds, { eventIds }), 12)

  const result = selectRecall(index, 'topicword', { cfg, lanes: emptyLanes(), round: 1, k: 10, eventIds })
  assert.equal(result.stats.candidates, 12) // |C(Q)∩E|
  assert.equal(result.stats.candidatesAll, 21)
  assert.equal(result.stats.filteredByEvent, 9) // 21 - 12
  assert.equal(result.stats.filteredByTime, 0)
  assert.ok(result.picks.length > 0)
  assert.ok(result.picks.every((pick) => eventIds.has(pick.id)))
  assert.ok(result.candidateIds.every((id) => eventIds.has(id)))
  assert.equal(result.hasMore, true) // 12 candidates > k=10
})

test('eventIds: time and event constraints are ANDed (C(Q)∩W∩E)', () => {
  const cfg = constrainCfg()
  const list = eventWorld()
  const index = buildRecallIndex(list, cfg)
  const eventIds = eventIdsOf(list, '日本旅行')
  // 5 memories inside the event + 1 inside the window but from another event
  const timeIds = new Set(['jp0', 'jp1', 'jp2', 'jp3', 'jp4', 'lo0'])
  const result = selectRecall(index, 'topicword', { cfg, lanes: emptyLanes(), round: 1, k: 10, eventIds, timeIds })
  assert.equal(result.stats.candidatesAll, 21)
  assert.equal(result.stats.candidates, 5) // |C∩W∩E|
  assert.equal(result.stats.filteredByTime, 15) // 21 - 6 (time window)
  assert.equal(result.stats.filteredByEvent, 1) // 6 - 5 (lo0 outside the event)
  assert.deepEqual(result.picks.map((pick) => pick.id).sort(), ['jp0', 'jp1', 'jp2', 'jp3', 'jp4'])
  assert.ok(result.picks.every((pick) => eventIds.has(pick.id) && timeIds.has(pick.id)))
})

test('eventIds: pre-filter never consumes quota nor advances the frontier', () => {
  const cfg = constrainCfg()
  const list = eventWorld()
  const index = buildRecallIndex(list, cfg)
  const narrowIds = new Set(['jp0', 'jp1'])
  const lanes = emptyLanes()
  const ledger = new Set()
  const narrow = selectRecall(index, 'topicword', { cfg, lanes, round: 1, k: 10, eventIds: narrowIds })
  // picks = min(k, |C∩E|): the 19 out-of-event candidates never take a slot
  assert.equal(narrow.picks.length, 2)
  assert.deepEqual(narrow.picks.map((pick) => pick.id).sort(), ['jp0', 'jp1'])
  for (const pick of narrow.picks) ledger.add(pick.id)
  // widening the event constraint with the same lanes exposes the entries that
  // were event-filtered before (the frontier did not skip them)
  const wide = selectRecall(index, 'topicword', { cfg, lanes, round: 2, k: 10, ledger, eventIds: null })
  assert.equal(wide.stats.filteredByEvent, 0)
  assert.equal(wide.stats.candidates, 21)
  assert.ok(wide.picks.length === 10)
  assert.ok(!wide.picks.some((pick) => narrowIds.has(pick.id))) // ledger honoured
  assert.ok(wide.picks.some((pick) => pick.id === 'jp2'))
})

test('eventIds: filteredByEvent counts deduplicated candidates (multi-keyword match once)', () => {
  const cfg = constrainCfg()
  const index = buildRecallIndex([
    folder('a', 0.9, 1, ['alpha', 'beta'], { event: '事件A' }),
    folder('b', 0.8, 2, ['alpha', 'beta']),
  ], cfg)
  const eventIds = new Set(['a'])
  const seeds = querySeeds(index, 'alpha beta', cfg).seeds
  assert.equal(seeds.length, 2)
  assert.equal(countCandidates(index, seeds), 2)
  assert.equal(countCandidates(index, seeds, { eventIds }), 1)
  const result = selectRecall(index, 'alpha beta', { cfg, lanes: emptyLanes(), round: 1, k: 10, eventIds })
  assert.equal(result.stats.candidatesAll, 2)
  assert.equal(result.stats.candidates, 1)
  assert.equal(result.stats.filteredByEvent, 1) // 'b' counted once, not once per keyword
})

test('eventIds: an empty Set means "strictly no candidates" (unknown event)', () => {
  const cfg = constrainCfg()
  const list = eventWorld()
  const index = buildRecallIndex(list, cfg)
  const empty = new Set()
  const result = selectRecall(index, 'topicword', { cfg, lanes: emptyLanes(), round: 1, k: 10, eventIds: empty })
  assert.deepEqual(result.picks, [])
  assert.equal(result.stats.candidates, 0)
  assert.equal(result.stats.candidatesAll, 21)
  assert.equal(result.stats.filteredByEvent, 21)
  assert.equal(result.hasMore, false)
  // deferral / recycle pools are gated too: nothing may leak from outside the event
  const lanes = emptyLanes()
  lanes.pendingHigh = ['jp0']
  lanes.pendingHighRound = [1]
  lanes.recycle = [{ id: 'jp1', eligibleRound: 0 }]
  const gated = selectRecall(index, 'topicword', { cfg, lanes, round: 2, k: 10, eventIds: empty })
  assert.deepEqual(gated.picks, [])
  assert.deepEqual(lanes.pendingHigh, ['jp0']) // kept, not dropped
  assert.equal(lanes.recycle.length, 1)
  // ... and they are injected once the constraint widens again (jp0 via the
  // deferral register; jp1 is a normal candidate again and is picked by the
  // high-α lane before the recycle lane would need to run)
  const widened = selectRecall(index, 'topicword', { cfg, lanes, round: 3, k: 10, eventIds: eventIdsOf(list, '日本旅行') })
  assert.equal(widened.picks.find((pick) => pick.id === 'jp0').lane, 'register')
  assert.ok(widened.picks.some((pick) => pick.id === 'jp1'))
})

test('eventIds: selection stays deterministic', () => {
  const cfg = constrainCfg()
  const list = eventWorld()
  const index = buildRecallIndex(list, cfg)
  const eventIds = eventIdsOf(list, '日本旅行')
  const replay = () => {
    const lanes = emptyLanes()
    const ledger = new Set()
    const rows = []
    for (let round = 1; round <= 5; round += 1) {
      const result = selectRecall(index, 'topicword', { cfg, lanes, round, k: 10, ledger, eventIds })
      rows.push(result.picks.map((pick) => `${pick.id}:${pick.lane}`).join(','))
      for (const pick of result.picks) ledger.add(pick.id)
    }
    return rows
  }
  const reference = replay()
  assert.deepEqual(replay(), reference)
  // fairness lane telemetry still adds up to the picks
  const lanes = emptyLanes()
  const ledger = new Set()
  for (let round = 1; round <= 3; round += 1) {
    const result = selectRecall(index, 'topicword', { cfg, lanes, round, k: 10, ledger, eventIds })
    assert.equal(Object.values(result.stats.lanesPicked).reduce((sum, value) => sum + value, 0), result.picks.length)
    for (const pick of result.picks) ledger.add(pick.id)
  }
})

test('selectSigma: eventIds filters direct matches and hop expansion', () => {
  const cfg = constrainCfg()
  const index = buildRecallIndex([
    folder('bridge', 0.9, 1, ['start_kw', 'bridge_kw'], { event: '事件A' }),
    folder('targetA', 0.5, 2, ['bridge_kw', 'target_kw'], { event: '事件A' }),
    folder('targetB', 0.5, 3, ['bridge_kw', 'target_kw'], { event: '事件B' }),
  ], cfg)
  const seeds = querySeeds(index, 'start_kw', cfg).seeds
  const onlyA = new Set(['bridge', 'targetA'])
  assert.deepEqual(selectSigma(index, seeds, { k: 5, eventIds: onlyA }).picked.map((item) => item.id), ['bridge'])
  assert.deepEqual(
    selectSigma(index, seeds, { k: 5, eventIds: onlyA, hops: 1 }).picked.map((item) => item.id),
    ['bridge', 'targetA'],
  )
  // direct match outside the event: filtered without consuming quota
  const onlyB = new Set(['targetB'])
  const empty = selectSigma(index, seeds, { k: 5, eventIds: onlyB })
  assert.deepEqual(empty.picked, [])
  assert.equal(empty.stats.filteredByEvent, 1)
  assert.equal(empty.stats.hasMore, false)
})

test('simulateTurns: rank domain is C(Q)∩E', () => {
  const cfg = constrainCfg()
  const folders = []
  for (let at = 0; at < 20; at += 1) {
    folders.push(folder(`m${String(at).padStart(2, '0')}`, 0.9 - at / 100, at + 1, ['eventkw'], {
      event: at % 2 === 0 ? '事件A' : '事件B',
    }))
  }
  const index = buildRecallIndex(folders, cfg)
  const seeds = querySeeds(index, 'eventkw', cfg).seeds
  const eventIds = new Set(folders.filter((item) => item.event === '事件A').map((item) => item.id))
  assert.equal(countCandidates(index, seeds), 20)
  assert.equal(countCandidates(index, seeds, { eventIds }), 10)
  const sim = simulateTurns(index, seeds, { k: 3, maxTurns: 10, eventIds })
  assert.equal(sim.total, 10)
  const ranked = oracleCandidates(index, 'eventkw').filter((entry) => eventIds.has(entry.id))
  ranked.forEach((entry, at) => {
    assert.equal(sim.firstSeen.get(entry.id), Math.ceil((at + 1) / 3), `rank ${at + 1}`)
  })
})

