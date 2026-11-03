/**
 * v1.4.1 recall regressions (B-01 / B-02 / B-03 / B-05 / B-07 / C-02 / C-05).
 *
 * B-01 — `engine.recall(..., { paginate:true })`: a stable page over a fixed
 *        selection window (`min(candidates, 10000)`) computed from a lane
 *        snapshot; pages are distinct, complete, `hasMore` is exact and the
 *        lane state is never advanced.
 * B-02 — bidirectional matching is wired into the product path: a user token
 *        that appears inside a multi-token folder keyword seeds it.
 * B-03 — `recall.fairness.roundBudget.maxChars` caps one round's injected chars.
 * B-05 — `recall.firstGenMax=0` disables recall in fair/deterministic/legacy.
 * B-07 — the time-ladder telemetry counts candidates on the *chosen* rung.
 * C-02 — pure time browsing returns event-start order (not createdAt order).
 * C-05 — `time.mode='index'` + empty keywords never browses the whole library.
 *
 * Only `os.tmpdir()` is written.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import {
  MemoryEngine,
  formatFolderId,
  loadConfig,
  loadIndex,
  writeFolder,
  writeIndex,
} from '../engine/index.js'

const tempDirs = []
function tempDir(prefix = 'dshr-141-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

const SH_DAY = (day) => Date.UTC(2026, 9, day, 4, 0, 0) // 12:00 Asia/Shanghai

function makeCfg(overrides = {}) {
  return loadConfig(undefined, overrides)
}

let counter = 0
function folderSpec(overrides = {}) {
  counter += 1
  const keywords = overrides.keywords ?? [`kw${counter}`]
  return {
    id: formatFolderId(1700000000000, counter),
    createdAt: counter,
    alpha: 1,
    keywords,
    chars: 100,
    tokens: 50,
    messages: [
      { role: 'user', content: keywords.join(' ') },
      { role: 'assistant', content: '好的，收到。' },
    ],
    ...overrides,
  }
}

function writeSpecs(memoryDir, specs) {
  for (const spec of specs) {
    const messages = spec.messages
    const meta = {
      version: 1,
      id: spec.id,
      createdAt: spec.createdAt,
      alpha: spec.alpha,
      keywords: spec.keywords,
      title: spec.keywords.join(' '),
      stats: { messages: messages.length, chars: spec.chars, tokens: spec.tokens },
      ...(spec.eventStart !== undefined ? { eventStart: spec.eventStart } : {}),
      ...(spec.eventEnd !== undefined ? { eventEnd: spec.eventEnd } : {}),
      ...(spec.eventTimeSource !== undefined ? { eventTimeSource: spec.eventTimeSource } : {}),
    }
    writeFolder(memoryDir, { id: spec.id, meta, messages })
  }
}

function engineWith(specs, overrides = {}, { rebuildIndex = false } = {}) {
  const dir = tempDir()
  writeSpecs(dir, specs)
  if (rebuildIndex) fs.rmSync(path.join(dir, 'index.json'), { force: true })
  const cfg = makeCfg(overrides)
  loadIndex(dir, cfg)
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg })
  engine.load()
  return engine
}

// ---------------------------------------------------------------------------
// B-01 — stable pagination
// ---------------------------------------------------------------------------

test('B-01: paginate returns stable distinct pages that cover every candidate', () => {
  const specs = []
  for (let at = 1; at <= 30; at += 1) specs.push(folderSpec({ keywords: ['部署'], alpha: at <= 10 ? 0.9 : 0.3 }))
  const engine = engineWith(specs, { recall: { firstGenMax: 10 } })
  const seen = []
  let offset = 0
  let pages = 0
  for (;;) {
    const result = engine.recall('部署方案', {}, { paginate: true, limit: 3, offset })
    assert.equal(result.additions.length, Math.min(3, 30 - offset), `offset ${offset} page size`)
    assert.equal(result.page.offset, offset)
    assert.equal(result.page.limit, 3)
    seen.push(...result.additions.map((addition) => addition.id))
    pages += 1
    assert.ok(pages <= 20, 'pagination must terminate')
    if (!result.page.hasMore) break
    offset += 3
  }
  assert.equal(pages, 10, '30 candidates / 3 per page = 10 pages')
  assert.equal(seen.length, 30)
  assert.equal(new Set(seen).size, 30, `0 duplicates / 0 missing, got ${seen.length} slots ${new Set(seen).size} distinct`)
  // offset beyond the total returns an empty page with hasMore=false.
  const beyond = engine.recall('部署方案', {}, { paginate: true, limit: 3, offset: 999 })
  assert.equal(beyond.additions.length, 0)
  assert.equal(beyond.page.hasMore, false)
})

test('B-01: a page is reproducible and does not advance/commit lane state', () => {
  const specs = []
  for (let at = 1; at <= 12; at += 1) specs.push(folderSpec({ keywords: ['部署'], alpha: 0.9 - at / 100 }))
  const engineWithFolders = engineWith(specs, { recall: { firstGenMax: 10 } })
  const lanes = { round: 5 }
  const first = engineWithFolders.recall('部署方案', {}, { paginate: true, limit: 4, offset: 0, lanes })
  const repeat = engineWithFolders.recall('部署方案', {}, { paginate: true, limit: 4, offset: 0, lanes })
  assert.deepEqual(
    repeat.additions.map((addition) => addition.id),
    first.additions.map((addition) => addition.id),
    'same lanes snapshot + same query ⇒ byte-identical page',
  )
  // The passed-in lane state is untouched and no lane state was committed.
  assert.deepEqual(lanes, { round: 5 }, 'paginate must not mutate the caller lane state')
  assert.equal(first.lanes.round, 5, 'the returned lane state is the unchanged snapshot')
  assert.equal(engineWithFolders._lanes, undefined, 'no engine-internal lane state was committed')
  // Page 2 continues the same ordered sequence (no overlap, no gap).
  const second = engineWithFolders.recall('部署方案', {}, { paginate: true, limit: 4, offset: 4, lanes })
  const combined = [...first.additions, ...second.additions].map((addition) => addition.id)
  assert.equal(new Set(combined).size, 8)
  // The ever-surfaced ledger is ignored for page stability; only blockIds are excluded.
  const ledgered = engineWithFolders.recall('部署方案', {}, {
    paginate: true,
    limit: 4,
    offset: 0,
    lanes,
    ledger: new Set([first.additions[0].id]),
  })
  assert.deepEqual(
    ledgered.additions.map((addition) => addition.id),
    first.additions.map((addition) => addition.id),
    'ledger must not shift the page',
  )
  const blocked = engineWithFolders.recall('部署方案', {}, {
    paginate: true,
    limit: 4,
    offset: 0,
    lanes,
    blockIds: new Set([first.additions[0].id]),
  })
  assert.equal(blocked.additions.some((addition) => addition.id === first.additions[0].id), false)

  // The adapter depends on paginate being side-effect free also when the engine
  // already owns lane state from an earlier automatic recall: neither `_lanes`
  // nor `_round` may move.
  const auto = engineWithFolders.recall('部署方案', {}, {})
  assert.ok(engineWithFolders._lanes && typeof engineWithFolders._lanes === 'object')
  const lanesBefore = JSON.stringify(engineWithFolders._lanes)
  const roundBefore = engineWithFolders._round
  engineWithFolders.recall('部署方案', {}, { paginate: true, limit: 4, offset: 0 })
  assert.equal(JSON.stringify(engineWithFolders._lanes), lanesBefore, 'paginate must not write back _lanes')
  assert.equal(engineWithFolders._round, roundBefore, 'paginate must not advance _round')
  // Serialized (recall-state.json) lane objects work as the snapshot input too.
  const serialized = JSON.parse(JSON.stringify(auto.lanes))
  const fromSerializedA = engineWithFolders.recall('部署方案', {}, { paginate: true, limit: 4, offset: 0, lanes: serialized })
  const fromSerializedB = engineWithFolders.recall('部署方案', {}, { paginate: true, limit: 4, offset: 0, lanes: serialized })
  assert.deepEqual(
    fromSerializedB.additions.map((addition) => addition.id),
    fromSerializedA.additions.map((addition) => addition.id),
  )
})

test('B-01: pagination stays exact on a 10,000-candidate library (offset 2500 is not empty)', () => {
  const dir = tempDir('dshr-141-10k-')
  const cfg = makeCfg({ recall: { firstGenMax: 10 } })
  const folders = []
  for (let at = 1; at <= 10000; at += 1) {
    const id = formatFolderId(1700000000000, at)
    const messages = [
      { role: 'user', content: `部署记录 ${at}` },
      { role: 'assistant', content: 'ok' },
    ]
    fs.mkdirSync(path.join(dir, id))
    fs.writeFileSync(
      path.join(dir, id, 'meta.json'),
      JSON.stringify({
        version: 1,
        id,
        createdAt: at,
        alpha: (at % 10) / 10 + 0.05,
        keywords: ['部署'],
        title: '部署',
        stats: { messages: 2, chars: 20, tokens: 6 },
      }),
    )
    fs.writeFileSync(path.join(dir, id, 'context.json'), JSON.stringify({ version: 1, id, createdAt: at, messages }))
    folders.push({ id, createdAt: at, alpha: (at % 10) / 10 + 0.05, keywords: ['部署'], chars: 20, tokens: 6 })
  }
  writeIndex(dir, cfg, { version: 1, nextCounter: 10001, folders })
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg })
  engine.load()
  const page = engine.recall('部署', {}, { paginate: true, limit: 3, offset: 2500 })
  assert.equal(page.additions.length, 3, 'offset far into a 10k window must not return an empty page')
  assert.equal(page.page.offset, 2500)
  assert.equal(page.page.hasMore, true)
  const first = engine.recall('部署', {}, { paginate: true, limit: 3, offset: 0 })
  const again = engine.recall('部署', {}, { paginate: true, limit: 3, offset: 0 })
  assert.deepEqual(
    again.additions.map((addition) => addition.id),
    first.additions.map((addition) => addition.id),
  )
})

// ---------------------------------------------------------------------------
// B-02 — bidirectional match wiring
// ---------------------------------------------------------------------------

test('B-02: a user token inside a multi-token folder keyword seeds that folder (README example)', () => {
  const engine = engineWith(
    [
      folderSpec({ keywords: ['接口网关 8080'], alpha: 0.9 }),
      folderSpec({ keywords: ['完全无关的话题'], alpha: 0.9 }),
    ],
    { recall: { firstGenMax: 10 } },
  )
  const result = engine.recall('帮我看下网关', {}, {})
  assert.ok(result.additions.length >= 1, `expected the 接口网关 8080 memory, got ${JSON.stringify(result.additions.map((a) => a.id))}`)
  assert.deepEqual(result.additions.map((addition) => addition.id), [engine.list()[0].id])
  // "只增不减": the v1.3.0 direction still matches exactly like before.
  const direction1 = engine.recall('接口网关 8080 怎么配', {}, {})
  assert.ok(direction1.additions.some((addition) => addition.id === engine.list()[0].id))
  // The expansion switches stay neutral for this case (no crash / no removal).
  const engineFlags = engineWith([folderSpec({ keywords: ['接口网关 8080'], alpha: 0.9 })], {
    match: { expandLatinCase: true, cjkBigram: true },
    recall: { firstGenMax: 10 },
  })
  assert.ok(engineFlags.recall('帮我看下网关', {}, {}).additions.length >= 1)
})

// ---------------------------------------------------------------------------
// B-03 — per-round character budget
// ---------------------------------------------------------------------------

test('B-03: roundBudget.maxChars drops the lowest-priority tail of one round (10 × 5000 chars ⇒ ≤ 20000)', () => {
  const specs = []
  for (let at = 1; at <= 10; at += 1) {
    specs.push(
      folderSpec({
        keywords: ['部署'],
        alpha: 0.9,
        chars: 5000,
        messages: [
          { role: 'user', content: `部署 ${'x'.repeat(5000)}` },
        ],
      }),
    )
  }
  const engine = engineWith(specs, { recall: { firstGenMax: 10, fairness: { roundBudget: { maxChars: 20000 } } } })
  const result = engine.recall('部署方案', {}, {})
  const injectedChars = result.additions.reduce((sum, addition) => sum + addition.chars, 0)
  assert.equal(result.additions.length, 4, `kept ${result.additions.length} folders (${injectedChars} chars)`)
  assert.equal(injectedChars, 20000, `injected ${injectedChars} chars should be exactly the 20000 budget`)
  assert.equal(result.stats.roundBudgetMaxChars, 20000)
  assert.equal(result.stats.roundBudgetDropped, 6)
  assert.ok(result.warnings.some((warning) => /round char budget/.test(warning)), JSON.stringify(result.warnings))
  // A huge budget keeps the whole round.
  const wide = engineWith(specs, { recall: { firstGenMax: 10, fairness: { roundBudget: { maxChars: 100000 } } } })
  const wideResult = wide.recall('部署方案', {}, {})
  assert.equal(wideResult.stats.roundBudgetDropped, 0)
  assert.equal(wideResult.additions.length, 10)
})

// ---------------------------------------------------------------------------
// B-05 — firstGenMax = 0 disables recall in every mode
// ---------------------------------------------------------------------------

test('B-05: firstGenMax=0 yields 0 picks / empty page / hasMore=false in fair, deterministic and legacy', () => {
  const specs = []
  for (let at = 1; at <= 5; at += 1) specs.push(folderSpec({ keywords: ['部署'], alpha: 0.9 }))
  for (const mode of ['fair', 'deterministic', 'legacy']) {
    const engine = engineWith(specs, { recall: { mode, firstGenMax: 0 } })
    const result = engine.recall('部署方案', {}, {})
    assert.equal(result.additions.length, 0, `${mode}: expected 0 additions`)
    assert.equal(result.page.returned, 0, `${mode}: empty page`)
    assert.equal(result.page.hasMore, false, `${mode}: hasMore=false`)
  }
  // The selector itself already honoured k=0; the engine must not override it.
  const engine = engineWith(specs, { recall: { firstGenMax: 0 } })
  const withLanes = engine.recall('部署方案', {}, { lanes: { round: 7 } })
  assert.equal(withLanes.lanes.round, 7, 'a disabled round must not advance the lane state')
})

// ---------------------------------------------------------------------------
// B-07 — time-ladder telemetry uses the chosen rung
// ---------------------------------------------------------------------------

test('B-07: after the time ladder widens, candidates/matchedFolders count the chosen window', () => {
  const folderFor = (id, start) => ({
    id,
    createdAt: start,
    alpha: 0.9,
    keywords: ['部署'],
    chars: 100,
    tokens: 50,
    eventStart: start,
    eventEnd: start + 1000,
    eventTimeSource: 'messages',
    messages: [{ role: 'user', content: '部署' }],
  })
  const engine = engineWith(
    [folderFor(formatFolderId(1700000000000, 1), SH_DAY(1)), folderFor(formatFolderId(1700000000000, 2), Date.UTC(2026, 10, 20, 4))],
    { time: { mode: 'constrain', timezone: 'Asia/Shanghai' }, recall: { firstGenMax: 10 } },
  )
  // 2026-10-31 (requested day) has no match; the ladder widens to the month and
  // finds the 2026-10-01 folder. The telemetry must agree with what was returned.
  const result = engine.recall('部署', {}, { timeFrom: '2026-10-31' })
  assert.equal(result.additions.length, 1)
  assert.equal(result.timeWindow.widenedTo, 'month')
  assert.equal(result.stats.candidates, 1, `stats.candidates=${result.stats.candidates}`)
  assert.equal(result.stats.matchedFolders, 1, `stats.matchedFolders=${result.stats.matchedFolders}`)
  assert.equal(result.page.candidates, 1, `page.candidates=${result.page.candidates}`)
})

// ---------------------------------------------------------------------------
// C-02 / C-05 — browsing order and mode gating
// ---------------------------------------------------------------------------

test('C-02: pure time browsing returns event-start order, not createdAt order', () => {
  const engine = engineWith([
    // createdAt early, event late
    {
      id: formatFolderId(1700000000000, 1),
      createdAt: 1,
      alpha: 0.9,
      keywords: ['记录'],
      chars: 100,
      tokens: 50,
      eventStart: SH_DAY(31),
      eventEnd: SH_DAY(31) + 1000,
      eventTimeSource: 'messages',
      messages: [{ role: 'user', content: 'late event' }],
    },
    {
      id: formatFolderId(1700000000000, 2),
      createdAt: 2,
      alpha: 0.9,
      keywords: ['记录'],
      chars: 100,
      tokens: 50,
      eventStart: SH_DAY(20),
      eventEnd: SH_DAY(20) + 1000,
      eventTimeSource: 'messages',
      messages: [{ role: 'user', content: 'early event' }],
    },
  ], { time: { mode: 'constrain', timezone: 'Asia/Shanghai' }, recall: { sort: 'createdAt' } })
  const browsed = engine.recall('', {}, { timeFrom: '2026-10' })
  assert.equal(browsed.browse, true)
  const [first, second] = browsed.additions.map((addition) => addition.meta?.eventStart ?? addition.createdAt)
  assert.ok(first < second, `browse order must be event-start ascending, got ${JSON.stringify(browsed.additions.map((a) => a.id))}`)
})

test("C-05: time.mode='index' + empty keywords never browses the whole library", () => {
  const specs = []
  for (let at = 1; at <= 5; at += 1) {
    specs.push(folderSpec({ keywords: ['部署'], alpha: 0.9, createdAt: SH_DAY(31) + at * 1000 }))
  }
  const engine = engineWith(specs, { time: { mode: 'index', timezone: 'Asia/Shanghai' } })
  const result = engine.recall('', {}, { timeFrom: '2026-10-31' })
  assert.notEqual(result.browse, true, 'time.mode=index must not enable browsing')
  assert.equal(result.additions.length, 0, 'no keyword + non-enforced time must not return the library')
  assert.ok(result.warnings.some((warning) => /time\.mode is "index"/.test(warning)), JSON.stringify(result.warnings))
  // A real constrained window still browses (as before).
  const constrained = engineWith(specs, { time: { mode: 'constrain', timezone: 'Asia/Shanghai' } })
  const browsed = constrained.recall('', {}, { timeFrom: '2026-10' })
  assert.equal(browsed.browse, true)
  assert.equal(browsed.additions.length, 5)
})
