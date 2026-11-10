/**
 * Adapter contract — `memory_judge` v1.5.0 tag fields (design contract §5.1).
 *
 * v1.4.0 gave one memory exactly one event label and silently merged a similar
 * label into the existing canonical one. v1.5.0 instead:
 *
 *   - lets the judge submit `locations` / `persons` / `events` arrays (the
 *     archive path never calls a model, so this is the only place tags exist);
 *   - keeps the legacy `event` string as a single-event shorthand;
 *   - treats an omitted array as "no change" and an explicit empty array as
 *     "clear" (replacing the whole set);
 *   - no longer merges a similar-but-different event label: the submitted label
 *     is kept and the candidates are returned for the model to approve;
 *   - reports per-batch `tagStats`, `eventStats.candidates` and
 *     `eventMergeCandidates` (old output fields are untouched).
 *
 * The harness mirrors test-adapter/scoring-rubric.test.mjs: a real on-disk
 * memory dir + real `MemoryEngine` behind a fake plugin exposing exactly the
 * adapter methods the tool is allowed to call.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { MemoryEngine, writeFolder } from '../engine/index.js'
import { MemoryJudgeTool } from '../lib/memory-tool.js'

// ---------------------------------------------------------------------------
// hermetic harness (temp memory dir + real engine + fake plugin)
// ---------------------------------------------------------------------------

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-memory-tool-150-'))
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

function writePendingFolder(memoryDir, id, createdAt = 1000) {
  writeFolder(memoryDir, {
    id,
    meta: {
      createdAt,
      scored: false,
      alphaSource: 'pending',
      keywordsSource: 'pending',
      betaSource: 'pending',
    },
    messages: [{ role: 'user', content: `归档内容 ${id}` }],
  })
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

function readMeta(memoryDir, id) {
  return JSON.parse(readFileSync(path.join(memoryDir, id, 'meta.json'), 'utf8'))
}

/**
 * @param {string} dir
 * @param {{ config?: object, pending?: Array<string|{id: string, createdAt?: number}>,
 *   scored?: Array<{id: string, meta?: object, createdAt?: number}> }} [options]
 */
function makeJudgeEnv(dir, options = {}) {
  const memoryDir = path.join(dir, 'memory')
  for (const item of options.pending ?? []) {
    if (typeof item === 'string') writePendingFolder(memoryDir, item)
    else writePendingFolder(memoryDir, item.id, item.createdAt)
  }
  for (const item of options.scored ?? []) writeScoredFolder(memoryDir, item.id, item.meta, item.createdAt)
  const engine = new MemoryEngine({ memoryDir, config: options.config ?? {} })
  engine.load()
  const cfg = {
    ...engine.config,
    memoryDir,
    scoring: { ...engine.config.scoring, judgeTelemetry: true },
  }
  const events = []
  const plugin = {
    currentConfig: () => cfg,
    toolsSessionEnabled: () => true,
    scopedConfig: () => cfg,
    engineFor: () => engine,
    onMemoryTasksChanged: () => {},
    recordJudgeEvent: (_session, event) => events.push(event),
  }
  return { memoryDir, engine, cfg, plugin, events }
}

async function judge(plugin, updates, session = { id: 'session-memory-tool-150' }) {
  return new MemoryJudgeTool(plugin).execute({ updates }, { agent: { session } })
}

// ---------------------------------------------------------------------------
// 1) model-facing schema + rubric text
// ---------------------------------------------------------------------------

test('memory_judge 1.5.0: update schema adds locations/persons/events and keeps the old contract', () => {
  const def = new MemoryJudgeTool({}).definition()
  assert.equal(def.name, 'memory_judge')
  assert.deepEqual(def.parameters.required, ['updates'])
  const item = def.parameters.properties.updates.items
  assert.deepEqual(item.required, ['id'], 'required fields are unchanged')
  for (const field of ['locations', 'persons', 'events']) {
    assert.equal(item.properties[field].type, 'array', `${field} is an array`)
    assert.deepEqual(item.properties[field].items, { type: 'string' }, `${field} holds strings`)
    assert.ok(item.properties[field].description.length > 20, `${field} has a rubric description`)
  }
  // Legacy single-event field is kept.
  assert.equal(item.properties.event.type, 'string')
  assert.match(item.properties.event.description, /事件/)
  // Old fields still exist with their old types.
  for (const field of ['id', 'alpha', 'beta', 'keywords', 'keep', 'reason']) {
    assert.ok(item.properties[field], `${field} is still accepted`)
  }

  // Output schema: new fields added next to the old ones.
  const output = def.output.schema.properties
  for (const field of ['updated', 'kept', 'rejected', 'warnings', 'eventStats']) {
    assert.ok(output[field], `${field} output field is preserved`)
  }
  assert.equal(output.eventStats.properties.candidates.type, 'number')
  assert.equal(output.tagStats.properties.locations.type, 'number')
  assert.equal(output.tagStats.properties.persons.type, 'number')
  assert.equal(output.tagStats.properties.events.type, 'number')
  assert.equal(output.eventMergeCandidates.type, 'array')
  const candidateProps = output.eventMergeCandidates.items.properties
  assert.equal(candidateProps.submitted.type, 'string')
  assert.equal(candidateProps.existing.type, 'string')
  assert.equal(candidateProps.score.type, 'number')

  // The old renderer contract for a value without the new fields is unchanged.
  assert.deepEqual(def.output.render({}, { updated: ['mem-1'], kept: [], rejected: [] }), [
    { type: 'text', text: '已更新 1 条（mem-1）。' },
  ])
})

test('memory_judge 1.5.0: description and parameter rubrics teach the new tag rules', () => {
  const def = new MemoryJudgeTool({}).definition()
  const { description } = def
  const props = def.parameters.properties.updates.items.properties
  for (const phrase of [
    'locations 表示原文里明确出现的地点',
    '「家」「小明的家」',
    'persons 表示原文里明确出现的人物',
    'events 表示这条记忆所属的事件集合',
    '同一事件请始终复用已有标签',
    '时间标签（今天/昨天/下周二/三天后…）由系统按归档原文自动换算，不要提交',
    'keywords 必须覆盖本条原文里的人物名、地点名和事件名',
    'events 与 event 同时提交时 events 优先',
  ]) {
    assert.ok(description.includes(phrase), `description must mention: ${phrase}`)
  }
  assert.ok(props.locations.description.includes('明确出现的地点'))
  assert.ok(props.locations.description.includes('家'))
  assert.ok(props.persons.description.includes('明确出现的人物'))
  assert.ok(props.events.description.includes('可多个'))
  assert.ok(props.events.description.includes('复用已有标签'))
  assert.ok(props.keywords.description.includes('人物名/地点名/事件名'))
  assert.ok(props.event.description.includes('旧版单事件字段'))
})

// ---------------------------------------------------------------------------
// 2) locations / persons / events land on disk (normalized, deduped, capped)
// ---------------------------------------------------------------------------

test('memory_judge 1.5.0: locations/persons/events are normalized, deduped and truncated per folder', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, { pending: ['mem-pending-1'] })
    const result = await judge(plugin, [
      {
        id: 'mem-pending-1',
        alpha: 0.5,
        beta: 2,
        keywords: ['部署', 'docker', '端口'],
        // 11 entries -> normalizeTagLabel + dedupe, then cap at location.maxPerFolder=8.
        // 「我家」->「家」 and 「小明的家」->「小明家」 exercise the location home rule.
        locations: ['北京', '上海', '广州', '公司', '我家', '小明的家', '咖啡店', '图书馆', '机场', '车站', '北京'],
        // cap at person.maxPerFolder=8.
        persons: ['小明', '小红', '小刚', '小美', '小强', '小丽', '小华', '小军', '小芳', '小杰', '小明'],
        // cap at event.maxPerFolder=4; all five labels are dissimilar.
        events: ['日本旅行', '登录重构项目', '方案评审', '数据库迁移', '年会筹备'],
      },
    ])

    assert.deepEqual(result.updated, ['mem-pending-1'])
    assert.deepEqual(result.rejected, [])
    const meta = readMeta(memoryDir, 'mem-pending-1')
    assert.deepEqual(meta.locations, ['北京', '上海', '广州', '公司', '家', '小明家', '咖啡店', '图书馆'])
    assert.deepEqual(meta.persons, ['小明', '小红', '小刚', '小美', '小强', '小丽', '小华', '小军'])
    assert.deepEqual(meta.events, ['日本旅行', '登录重构项目', '方案评审', '数据库迁移'])
    // v1.5.0 keeps writing the legacy mirror fields for old readers.
    assert.equal(meta.event, '日本旅行')
    assert.equal(meta.eventSource, 'llm')
    assert.ok(Number.isFinite(meta.eventAt))

    // tagStats counts what was actually written (after truncation).
    assert.deepEqual(result.tagStats, { locations: 8, persons: 8, events: 4 })
    // eventStats counts updates by outcome (one update == one assigned bucket).
    assert.deepEqual(result.eventStats, { assigned: 1, merged: 0, cleared: 0, candidates: 0 })
    assert.equal(result.eventMergeCandidates, undefined, 'no candidates for five distinct new labels')
  })
})

test('memory_judge 1.5.0: the judge writes multi-event sets and the event mirror', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, { pending: ['mem-multi'] })
    const result = await judge(plugin, [
      { id: 'mem-multi', alpha: 0.7, beta: 3, keywords: ['部署', 'docker', '端口'], events: ['日本旅行', '登录重构项目'] },
    ])
    assert.deepEqual(result.updated, ['mem-multi'])
    const meta = readMeta(memoryDir, 'mem-multi')
    assert.deepEqual(meta.events, ['日本旅行', '登录重构项目'])
    assert.equal(meta.event, '日本旅行', 'event mirrors events[0] for old readers')
    assert.equal(meta.eventSource, 'llm')
    assert.equal(result.tagStats.events, 2)
    assert.equal(result.eventStats.assigned, 1, 'the update is reported as one assigned bucket')

    const rendered = new MemoryJudgeTool(plugin).definition().output.render(null, result)[0].text
    assert.ok(rendered.includes('事件标签：打标 1 条'), rendered)
    assert.ok(rendered.includes('标签写入：事件 2 个'), rendered)
  })
})

// ---------------------------------------------------------------------------
// 3) clearing an event set
// ---------------------------------------------------------------------------

test('memory_judge 1.5.0: an explicit empty events array clears meta.event/meta.events/eventSource', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      scored: [
        { id: 'mem-clear', meta: { events: ['日本旅行'], event: '日本旅行', eventSource: 'llm', eventAt: 1000 } },
        { id: 'mem-clear-legacy', meta: { event: '日本旅行', eventSource: 'llm', eventAt: 1000 } },
      ],
    })
    const result = await judge(plugin, [{ id: 'mem-clear', events: [] }])
    assert.deepEqual(result.updated, ['mem-clear'])
    const meta = readMeta(memoryDir, 'mem-clear')
    assert.equal(meta.event, undefined, 'clearing deletes the mirror field')
    assert.equal(meta.events, undefined, 'clearing deletes the event set')
    assert.equal(meta.eventSource, undefined, 'clearing removes the provenance too')
    assert.ok(Number(meta.eventAt) > 1000, 'the clear is timestamped')
    assert.deepEqual(result.eventStats, { assigned: 0, merged: 0, cleared: 1, candidates: 0 })
    assert.deepEqual(result.tagStats, { locations: 0, persons: 0, events: 0 })

    // The documented legacy placeholder clears through the same code path.
    const legacy = await judge(plugin, [{ id: 'mem-clear-legacy', event: '空' }])
    assert.deepEqual(legacy.updated, ['mem-clear-legacy'])
    assert.equal(legacy.eventStats.cleared, 1)
    assert.equal(readMeta(memoryDir, 'mem-clear-legacy').event, undefined)
  })
})

// ---------------------------------------------------------------------------
// 4) no silent merge: candidates are returned and the new label is kept
// ---------------------------------------------------------------------------

test('memory_judge 1.5.0: a similar event label is NOT merged; candidates are returned', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin, engine } = makeJudgeEnv(dir, {
      scored: [{ id: 'mem-seed-trip', meta: { events: ['日本旅行'], event: '日本旅行', eventSource: 'llm', eventAt: 1000 } }],
      pending: ['mem-new-a2'],
    })
    const result = await judge(plugin, [
      { id: 'mem-new-a2', alpha: 0.9, beta: 3, keywords: ['部署', 'docker', '端口'], events: ['日本旅行计划'] },
    ])
    assert.deepEqual(result.updated, ['mem-new-a2'])
    const meta = readMeta(memoryDir, 'mem-new-a2')
    assert.deepEqual(meta.events, ['日本旅行计划'], 'the submitted label is kept as its own canonical label')
    assert.equal(meta.event, '日本旅行计划')
    assert.deepEqual(readMeta(memoryDir, 'mem-seed-trip').events, ['日本旅行'], 'the existing label is untouched')

    assert.deepEqual(result.eventStats, { assigned: 1, merged: 0, cleared: 0, candidates: 1 })
    assert.ok(Array.isArray(result.eventMergeCandidates), 'the candidates are surfaced to the model')
    assert.equal(result.eventMergeCandidates.length, 1)
    const candidate = result.eventMergeCandidates[0]
    assert.equal(candidate.submitted, '日本旅行计划')
    assert.equal(candidate.existing, '日本旅行')
    assert.ok(Math.abs(candidate.score - 2 * 7 / 18) < 1e-9, `Dice score (got ${candidate.score})`)
    assert.ok(
      result.warnings.some((warning) => warning.startsWith('event-candidate:') && warning.includes('尚未归并')),
      'the model is told the merge needs its approval',
    )
    const rendered = new MemoryJudgeTool(plugin).definition().output.render(null, result)[0].text
    assert.ok(rendered.includes('待确认归并 1 条'), rendered)
    assert.ok(rendered.includes('标签写入：事件 1 个'), rendered)

    // Both labels are canonical events in the derived index.
    const eventIndex = engine.eventIndex()
    assert.deepEqual(eventIndex.labels.map((entry) => entry.label), ['日本旅行', '日本旅行计划'])
  })
})

test('memory_judge 1.5.0: re-submitting the existing label approves the merge and is counted as merged', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      scored: [{ id: 'mem-seed-trip', meta: { events: ['日本旅行'], event: '日本旅行', eventSource: 'llm', eventAt: 1000 } }],
      pending: ['mem-approve'],
    })
    // First pass creates the near-duplicate label; nothing is merged.
    const first = await judge(plugin, [
      { id: 'mem-approve', alpha: 0.8, beta: 2, keywords: ['部署', 'docker', '端口'], events: ['日本旅行计划'] },
    ])
    assert.equal(first.eventStats.candidates, 1)
    assert.equal(readMeta(memoryDir, 'mem-approve').event, '日本旅行计划')
    // Second pass re-submits the existing canonical label: the folder's kept
    // near-duplicate label is replaced — the model-approved merge.
    const second = await judge(plugin, [{ id: 'mem-approve', events: ['日本旅行'] }])
    assert.deepEqual(second.updated, ['mem-approve'])
    const meta = readMeta(memoryDir, 'mem-approve')
    assert.deepEqual(meta.events, ['日本旅行'], 'the approved label replaces the kept candidate label')
    assert.equal(meta.event, '日本旅行')
    assert.deepEqual(second.eventStats, { assigned: 0, merged: 1, cleared: 0, candidates: 0 })
    assert.equal(second.eventMergeCandidates, undefined, 'an exact hit produces no new candidates')
  })
})

test('memory_judge 1.5.0: rollback mode (mergeRequiresApproval=false) still merges silently and counts merged', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      config: { event: { mergeRequiresApproval: false } },
      scored: [{ id: 'mem-seed-trip', meta: { events: ['日本旅行'], event: '日本旅行', eventSource: 'llm', eventAt: 1000 } }],
      pending: ['mem-rollback'],
    })
    const result = await judge(plugin, [
      { id: 'mem-rollback', alpha: 0.8, beta: 2, keywords: ['部署', 'docker', '端口'], events: ['日本旅行计划'] },
    ])
    const meta = readMeta(memoryDir, 'mem-rollback')
    assert.deepEqual(meta.events, ['日本旅行'], 'the old rollback behaviour merges into the canonical label')
    assert.equal(meta.event, '日本旅行')
    assert.deepEqual(result.eventStats, { assigned: 0, merged: 1, cleared: 0, candidates: 0 })
    assert.equal(result.eventMergeCandidates, undefined)
    assert.ok(result.warnings.some((warning) => warning.startsWith('event-merged:')))
  })
})

// ---------------------------------------------------------------------------
// 5) legacy `event` string compatibility
// ---------------------------------------------------------------------------

test('memory_judge 1.5.0: the legacy event string still works and both fields prefer events', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, { pending: ['mem-legacy-event', 'mem-both-fields'] })
    const legacy = await judge(plugin, [
      { id: 'mem-legacy-event', alpha: 0.6, beta: 1, keywords: ['部署', 'docker', '端口'], event: '登录重构项目' },
    ])
    assert.deepEqual(legacy.updated, ['mem-legacy-event'])
    const legacyMeta = readMeta(memoryDir, 'mem-legacy-event')
    assert.deepEqual(legacyMeta.events, ['登录重构项目'], 'event string is applied as [event]')
    assert.equal(legacyMeta.event, '登录重构项目')
    assert.deepEqual(legacy.eventStats, { assigned: 1, merged: 0, cleared: 0, candidates: 0 })

    // Both submitted: events wins (documented precedence) and no crash.
    const both = await judge(plugin, [
      {
        id: 'mem-both-fields',
        alpha: 0.4,
        beta: 1,
        keywords: ['部署', 'docker', '端口'],
        event: '旧标签',
        events: ['旅行笔记', '评审记录'],
      },
    ])
    const bothMeta = readMeta(memoryDir, 'mem-both-fields')
    assert.deepEqual(bothMeta.events, ['旅行笔记', '评审记录'], 'events wins over the legacy string')
    assert.equal(bothMeta.event, '旅行笔记')
    assert.equal(both.eventStats.assigned, 1)
  })
})

// ---------------------------------------------------------------------------
// 6) omission / partial clear semantics + batch output shape
// ---------------------------------------------------------------------------

test('memory_judge 1.5.0: an omitted tag field is untouched, an empty array clears only that kind', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, {
      scored: [
        {
          id: 'mem-tagged',
          meta: {
            locations: ['北京'],
            persons: ['小明'],
            events: ['日本旅行'],
            event: '日本旅行',
            eventSource: 'llm',
            eventAt: 1000,
          },
        },
      ],
    })
    // Omitted fields: a partial α/β review leaves every tag alone.
    const partial = await judge(plugin, [{ id: 'mem-tagged', beta: -2 }])
    assert.deepEqual(partial.updated, ['mem-tagged'])
    let meta = readMeta(memoryDir, 'mem-tagged')
    assert.deepEqual(meta.locations, ['北京'])
    assert.deepEqual(meta.persons, ['小明'])
    assert.deepEqual(meta.events, ['日本旅行'])
    assert.deepEqual(partial.tagStats, { locations: 0, persons: 0, events: 0 })
    assert.deepEqual(partial.eventStats, { assigned: 0, merged: 0, cleared: 0, candidates: 0 })
    assert.equal(partial.eventMergeCandidates, undefined)

    // An empty locations array clears only locations.
    await judge(plugin, [{ id: 'mem-tagged', locations: [] }])
    meta = readMeta(memoryDir, 'mem-tagged')
    assert.equal(meta.locations, undefined)
    assert.deepEqual(meta.persons, ['小明'], 'other kinds are untouched')
    assert.deepEqual(meta.events, ['日本旅行'])
  })
})
