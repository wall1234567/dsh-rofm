/**
 * Audit regression tests — dsh-rofm 1.5.0 `memory_judge` event-label fixes.
 *
 * Covers the three slice-01 findings (D:/Deepseek/rofm-audit-1.5/findings/01-judge-tags.md):
 *
 *   F-01-01  a wrong-typed `events` / `event` value must be treated as "not
 *            provided" (keep the old labels, add a warning) instead of silently
 *            clearing the memory; only a legal empty array / placeholder clears.
 *   F-01-02  a plain rewrite to a brand-new label (or a pure reorder of the same
 *            set) must not be counted/rendered as a merge; `merged` is reserved
 *            for reusing an existing canonical label / an approved merge.
 *   F-01-03  clearing a memory that never had an event label is a no-op: no
 *            `cleared` count, no synthetic `eventAt`, no event-field rewrite.
 *
 * The audit proved these defects black-box through the real tool + real on-disk
 * memory dir, so these regressions are black-box too: every case goes through the
 * registered `memory_judge` ToolDefinition (`definition().execute`) and asserts
 * the persisted `meta.json` / `index.json`, never an intermediate function.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { MemoryEngine, writeFolder } from '../engine/index.js'
import { MemoryJudgeTool } from '../lib/memory-tool.js'

// ---------------------------------------------------------------------------
// hermetic harness: temp memory dir + real MemoryEngine + real memory_judge
// ---------------------------------------------------------------------------

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-audit-judge-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  let result
  try {
    result = fn(dir)
  } catch (error) {
    cleanup()
    throw error
  }
  if (result && typeof result.then === 'function') return result.finally(cleanup)
  cleanup()
  return result
}

function writeScoredFolder(memoryDir, id, meta = {}, createdAt = 1000) {
  writeFolder(memoryDir, {
    id,
    meta: {
      createdAt,
      scored: true,
      alpha: 0.5,
      beta: 1,
      keywords: ['部署', 'docker', '端口'],
      ...meta,
    },
    messages: [{ role: 'user', content: `归档内容 ${id}` }],
  })
}

function makeJudgeEnv(dir, options = {}) {
  const memoryDir = path.join(dir, 'memory')
  for (const item of options.pending ?? []) {
    writeFolder(memoryDir, {
      id: item,
      meta: { createdAt: 1000, scored: false, alphaSource: 'pending', keywordsSource: 'pending', betaSource: 'pending' },
      messages: [{ role: 'user', content: `归档内容 ${item}` }],
    })
  }
  for (const item of options.scored ?? []) writeScoredFolder(memoryDir, item.id, item.meta)
  const engine = new MemoryEngine({ memoryDir, config: options.config ?? {} })
  engine.load()
  const cfg = {
    ...engine.config,
    memoryDir,
    scoring: { ...engine.config.scoring, judgeTelemetry: true },
  }
  const plugin = {
    currentConfig: () => cfg,
    toolsSessionEnabled: () => true,
    scopedConfig: () => cfg,
    engineFor: () => engine,
    onMemoryTasksChanged: () => {},
    recordJudgeEvent: () => {},
  }
  return { memoryDir, engine, cfg, plugin }
}

function readMeta(memoryDir, id) {
  return JSON.parse(readFileSync(path.join(memoryDir, id, 'meta.json'), 'utf8'))
}

function readIndexEntry(memoryDir, id) {
  const index = JSON.parse(readFileSync(path.join(memoryDir, 'index.json'), 'utf8'))
  return (Array.isArray(index.folders) ? index.folders : []).find((entry) => entry.id === id) ?? null
}

/** Run one real `memory_judge` tool call and return `{value, rendered, tool}`. */
async function judge(plugin, updates, session = { id: 'session-audit-fix-judge' }) {
  const tool = new MemoryJudgeTool(plugin).definition()
  const value = await tool.execute({ updates }, { agent: { session } })
  const rendered = tool.output.render(null, value)[0].text
  return { value, rendered, tool }
}

const EMPTY_EVENT_STATS = { assigned: 0, merged: 0, cleared: 0, candidates: 0 }

// ---------------------------------------------------------------------------
// F-01-01: wrong-typed events/event is "not provided" (labels kept + warning)
// ---------------------------------------------------------------------------

test('F-01-01: a wrong-typed events value keeps the existing event labels (no clear, no warningless loss)', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      scored: [
        {
          id: 'mem-evt',
          meta: {
            events: ['日本旅行', '项目A'],
            event: '日本旅行',
            eventSource: 'llm',
            eventAt: 1000,
            locations: ['北京'],
          },
        },
      ],
    })

    const { value, rendered } = await judge(plugin, [{ id: 'mem-evt', events: 123 }])

    // Model-visible contract: the update still succeeds, but is not a clear and
    // carries an explicit warning about the ignored field.
    assert.deepEqual(value.updated, ['mem-evt'])
    assert.deepEqual(value.rejected, [])
    assert.ok(
      value.warnings.some((warning) => warning.includes('events') && warning.includes('未提供')),
      `a warning about the ignored events field must be returned (got ${JSON.stringify(value.warnings)})`,
    )
    assert.deepEqual(value.eventStats, EMPTY_EVENT_STATS, 'a wrong-typed field may not count as cleared/assigned')
    assert.ok(rendered.includes('注意：'), rendered)
    assert.ok(!rendered.includes('清空 1 条'), `the summary must not claim a clear: ${rendered}`)

    // Persisted meta.json: every event field survives untouched.
    const meta = readMeta(memoryDir, 'mem-evt')
    assert.deepEqual(meta.events, ['日本旅行', '项目A'])
    assert.equal(meta.event, '日本旅行')
    assert.equal(meta.eventSource, 'llm')
    assert.equal(meta.eventAt, 1000, 'eventAt must not be rewritten by an ignored field')
    assert.deepEqual(meta.locations, ['北京'], 'unrelated tags stay untouched')

    // Persisted index.json mirrors the untouched meta.
    const entry = readIndexEntry(memoryDir, 'mem-evt')
    assert.deepEqual(entry.events, ['日本旅行', '项目A'])
    assert.equal(entry.event, '日本旅行')
    assert.equal(entry.eventSource, 'llm')
    assert.equal(entry.eventAt, 1000)
  })
})

test('F-01-01: a wrong-typed event value (object / number, events absent) keeps legacy labels too', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      scored: [{ id: 'mem-legacy', meta: { event: '旧事件', eventSource: 'llm', eventAt: 2000 } }],
    })

    const objectTyped = await judge(plugin, [{ id: 'mem-legacy', event: { label: 'x' } }])
    assert.deepEqual(objectTyped.value.eventStats, EMPTY_EVENT_STATS)
    assert.ok(
      objectTyped.value.warnings.some((warning) => warning.includes('event') && warning.includes('未提供')),
      JSON.stringify(objectTyped.value.warnings),
    )
    let meta = readMeta(memoryDir, 'mem-legacy')
    assert.equal(meta.event, '旧事件')
    assert.equal(meta.eventSource, 'llm')
    assert.equal(meta.eventAt, 2000)
    assert.equal(meta.events, undefined, 'no events array is synthesized')

    const numberTyped = await judge(plugin, [{ id: 'mem-legacy', event: 123 }])
    assert.deepEqual(numberTyped.value.eventStats, EMPTY_EVENT_STATS)
    meta = readMeta(memoryDir, 'mem-legacy')
    assert.equal(meta.event, '旧事件')
    assert.equal(meta.eventSource, 'llm')
    assert.equal(meta.eventAt, 2000)
    const entry = readIndexEntry(memoryDir, 'mem-legacy')
    assert.equal(entry.event, '旧事件')
    assert.equal(entry.eventSource, 'llm')
    assert.equal(entry.eventAt, 2000)
  })
})

test('F-01-01: a legal empty array / placeholder still clears an existing event set', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      scored: [
        { id: 'mem-clear', meta: { events: ['日本旅行'], event: '日本旅行', eventSource: 'llm', eventAt: 1000 } },
        { id: 'mem-clear-legacy', meta: { event: '日本旅行', eventSource: 'llm', eventAt: 1000 } },
      ],
    })

    const empty = await judge(plugin, [{ id: 'mem-clear', events: [] }])
    assert.deepEqual(empty.value.eventStats, { assigned: 0, merged: 0, cleared: 1, candidates: 0 })
    assert.ok(empty.rendered.includes('清空 1 条'), empty.rendered)
    let meta = readMeta(memoryDir, 'mem-clear')
    assert.equal(meta.event, undefined)
    assert.equal(meta.events, undefined)
    assert.equal(meta.eventSource, undefined)
    assert.ok(Number(meta.eventAt) > 1000, 'a real clear keeps its operation timestamp')
    const clearEntry = readIndexEntry(memoryDir, 'mem-clear')
    assert.equal(clearEntry.event, undefined)
    assert.deepEqual(clearEntry.events, undefined)

    // The documented placeholder path stays a real clear as well.
    const placeholder = await judge(plugin, [{ id: 'mem-clear-legacy', event: '空' }])
    assert.equal(placeholder.value.eventStats.cleared, 1)
    meta = readMeta(memoryDir, 'mem-clear-legacy')
    assert.equal(meta.event, undefined)
    assert.ok(Number(meta.eventAt) > 1000)
  })
})

// ---------------------------------------------------------------------------
// F-01-02: a plain rewrite is an assignment, never a "merge"
// ---------------------------------------------------------------------------

test('F-01-02: rewriting to brand-new labels is counted/rendered as an assignment, not as a merge', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      scored: [{ id: 'mem-relabel', meta: { events: ['旧项目'], event: '旧项目', eventSource: 'llm', eventAt: 1000 } }],
    })

    const { value, rendered } = await judge(plugin, [{ id: 'mem-relabel', events: ['完全不同的新标签'] }])

    assert.deepEqual(
      value.eventStats,
      { assigned: 1, merged: 0, cleared: 0, candidates: 0 },
      'an unrelated rewrite is an assignment, not a merge',
    )
    assert.equal(value.eventMergeCandidates, undefined)
    assert.ok(!rendered.includes('归并'), `the summary must not claim a merge: ${rendered}`)
    assert.ok(rendered.includes('打标 1 条'), rendered)

    const meta = readMeta(memoryDir, 'mem-relabel')
    assert.deepEqual(meta.events, ['完全不同的新标签'])
    assert.equal(meta.event, '完全不同的新标签')
    assert.equal(meta.eventSource, 'llm')
    const entry = readIndexEntry(memoryDir, 'mem-relabel')
    assert.deepEqual(entry.events, ['完全不同的新标签'])
    assert.equal(entry.event, '完全不同的新标签')
  })
})

test('F-01-02: a pure reorder of the same event set is a complete no-op', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      scored: [
        { id: 'mem-order', meta: { events: ['项目甲', '项目乙'], event: '项目甲', eventSource: 'llm', eventAt: 1000 } },
      ],
    })

    const reordered = await judge(plugin, [{ id: 'mem-order', events: ['项目乙', '项目甲'] }])
    assert.deepEqual(reordered.value.eventStats, EMPTY_EVENT_STATS, 'a reorder is neither an assignment nor a merge')
    assert.ok(!reordered.rendered.includes('归并'), reordered.rendered)
    assert.ok(!reordered.rendered.includes('打标'), reordered.rendered)
    assert.ok(!reordered.rendered.includes('清空'), reordered.rendered)

    let meta = readMeta(memoryDir, 'mem-order')
    assert.deepEqual(meta.events, ['项目甲', '项目乙'], 'the stored order is kept (no rewrite)')
    assert.equal(meta.event, '项目甲', 'the event mirror must not drift')
    assert.equal(meta.eventAt, 1000, 'eventAt must not be rewritten')
    let entry = readIndexEntry(memoryDir, 'mem-order')
    assert.deepEqual(entry.events, ['项目甲', '项目乙'])
    assert.equal(entry.event, '项目甲')
    assert.equal(entry.eventAt, 1000)

    // Re-submitting the identical order is a no-op too.
    const identical = await judge(plugin, [{ id: 'mem-order', events: ['项目甲', '项目乙'] }])
    assert.deepEqual(identical.value.eventStats, EMPTY_EVENT_STATS)
    meta = readMeta(memoryDir, 'mem-order')
    assert.deepEqual(meta.events, ['项目甲', '项目乙'])
    assert.equal(meta.eventAt, 1000)
  })
})

test('F-01-02: a real approved merge (canonical re-submission) is still counted as merged', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      scored: [
        { id: 'mem-canon', meta: { events: ['日本旅行'], event: '日本旅行', eventSource: 'llm', eventAt: 1000 } },
        { id: 'mem-approve', meta: { events: ['日本旅行计划'], event: '日本旅行计划', eventSource: 'llm', eventAt: 1000 } },
      ],
    })

    const { value, rendered } = await judge(plugin, [{ id: 'mem-approve', events: ['日本旅行'] }])
    assert.deepEqual(
      value.eventStats,
      { assigned: 0, merged: 1, cleared: 0, candidates: 0 },
      're-submitting an existing canonical label is the documented approval merge',
    )
    assert.ok(rendered.includes('归并 1 条'), rendered)
    const meta = readMeta(memoryDir, 'mem-approve')
    assert.deepEqual(meta.events, ['日本旅行'])
    assert.equal(meta.event, '日本旅行')
    const entry = readIndexEntry(memoryDir, 'mem-approve')
    assert.deepEqual(entry.events, ['日本旅行'])
  })
})

test('F-01-02: rollback mode (mergeRequiresApproval=false) still silently merges and counts merged', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      config: { event: { mergeRequiresApproval: false } },
      scored: [{ id: 'mem-seed', meta: { events: ['日本旅行'], event: '日本旅行', eventSource: 'llm', eventAt: 1000 } }],
      pending: ['mem-rb'],
    })

    const { value } = await judge(plugin, [
      { id: 'mem-rb', alpha: 0.8, beta: 2, keywords: ['部署', 'docker', '端口'], events: ['日本旅行计划'] },
    ])
    assert.deepEqual(value.eventStats, { assigned: 0, merged: 1, cleared: 0, candidates: 0 })
    assert.ok(value.warnings.some((warning) => warning.startsWith('event-merged:')), JSON.stringify(value.warnings))
    assert.deepEqual(readMeta(memoryDir, 'mem-rb').events, ['日本旅行'])
  })
})

// ---------------------------------------------------------------------------
// F-01-03: clearing an event-less memory is a no-op
// ---------------------------------------------------------------------------

test('F-01-03: events:[] on a memory that never had an event label is a no-op', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      scored: [
        { id: 'mem-none', meta: {} },
        // A folder that was cleared in the past only keeps the timestamp: still
        // "no current event label", so another clear is a no-op too.
        { id: 'mem-stale', meta: { eventAt: 555 } },
      ],
    })

    const none = await judge(plugin, [{ id: 'mem-none', events: [] }])
    assert.deepEqual(none.value.eventStats, EMPTY_EVENT_STATS, 'nothing was cleared')
    assert.ok(!none.rendered.includes('清空'), none.rendered)
    let meta = readMeta(memoryDir, 'mem-none')
    assert.equal(meta.event, undefined)
    assert.equal(meta.events, undefined)
    assert.equal(meta.eventSource, undefined)
    assert.equal(meta.eventAt, undefined, 'a no-op clear must not synthesize eventAt')
    let entry = readIndexEntry(memoryDir, 'mem-none')
    assert.equal(entry.event, undefined)
    assert.deepEqual(entry.events, undefined)
    assert.equal(entry.eventAt, undefined)

    const stale = await judge(plugin, [{ id: 'mem-stale', events: [] }])
    assert.deepEqual(stale.value.eventStats, EMPTY_EVENT_STATS)
    meta = readMeta(memoryDir, 'mem-stale')
    assert.equal(meta.eventAt, 555, 'the old eventAt is kept, not rewritten')
    entry = readIndexEntry(memoryDir, 'mem-stale')
    assert.equal(entry.eventAt, 555)

    // The no-op clear is still a successful judge update when other fields change.
    const withBeta = await judge(plugin, [{ id: 'mem-none', beta: -1, events: [] }])
    assert.deepEqual(withBeta.value.updated, ['mem-none'])
    assert.equal(readMeta(memoryDir, 'mem-none').beta, -1)
    assert.equal(readMeta(memoryDir, 'mem-none').eventAt, undefined)
  })
})
