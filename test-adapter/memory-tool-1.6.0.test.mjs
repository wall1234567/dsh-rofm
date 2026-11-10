/**
 * Adapter contract — `memory_judge` v1.6.0 pronoun resolution for `persons`.
 *
 * v1.5.0 made the judge the only entry point that gives a memory its `persons`
 * labels, but its description only accepted "原文里明确出现的人物". A memory
 * whose archived text says 「他/她」 therefore kept an empty persons list, and the
 * person hard filter (a recall `persons` filter) then excluded it forever — even
 * though the model reading the archived conversation knows exactly who it is.
 *
 * v1.6.0 keeps the field contract untouched and changes only what the model is
 * told about producing the labels:
 *
 *   - a pronoun in the source text must be resolved against its visible context
 *     (this memory's text, the rest of the submitted batch, adjacent clues);
 *   - a *determined* referent is written as the explicit name/称呼 (e.g.「周岑」),
 *     never as the pronoun itself;
 *   - an *undetermined* referent must stay unlabelled (never guess);
 *   - several称呼 of one person all count as that person's labels and are all
 *     written when the text uses them;
 *   - the old caps (最多 8 个) and the "不推断关系" rule stay in force.
 *
 * The harness mirrors test-adapter/memory-tool-1.5.0.test.mjs: a real on-disk
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-memory-tool-160-'))
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

function readMeta(memoryDir, id) {
  return JSON.parse(readFileSync(path.join(memoryDir, id, 'meta.json'), 'utf8'))
}

/**
 * @param {string} dir
 * @param {{ config?: object, pending?: Array<string|{id: string, createdAt?: number}> }} [options]
 */
function makeJudgeEnv(dir, options = {}) {
  const memoryDir = path.join(dir, 'memory')
  for (const item of options.pending ?? []) {
    if (typeof item === 'string') writePendingFolder(memoryDir, item)
    else writePendingFolder(memoryDir, item.id, item.createdAt)
  }
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

async function judge(plugin, updates, session = { id: 'session-memory-tool-160' }) {
  return new MemoryJudgeTool(plugin).execute({ updates }, { agent: { session } })
}

/** ToolDefinition without any plugin state (schema/description are static). */
function toolDefinition() {
  return new MemoryJudgeTool({}).definition()
}

// ---------------------------------------------------------------------------
// 1) the model-facing TOOL_DESCRIPTION teaches pronoun resolution
// ---------------------------------------------------------------------------

test('memory_judge 1.6.0: TOOL_DESCRIPTION teaches pronoun resolution for persons', () => {
  const def = toolDefinition()
  assert.equal(def.name, 'memory_judge')
  const text = def.description
  // The new rule, sentence by sentence: resolve first, then either write the
  // explicit name or leave the label empty — never record the pronoun.
  for (const phrase of [
    '指代规则',
    '原文出现「他/她/TA/它/那个人/对方/某人/这位」这类人称代词时',
    '必须先结合本条记忆原文、同批提交的其他记忆和相邻上下文线索判断代词指谁',
    '能确定指代就写明确的人名/称呼（如「周岑」），不要写「他」',
    '不能确定就不要猜，留空或省略',
    '同一人可能有多个称呼（如「周岑」「小周」）：原文出现几个称呼就都写上',
    '代词消解出来的人名也要写进 keywords（否则以后按人名检索找不到这条记忆）',
  ]) {
    assert.ok(text.includes(phrase), `description must mention: ${phrase}`)
  }
  // v1.5.0 constraints are not weakened: explicit-name base rule, no relation
  // inference and the per-memory cap all stay in the description.
  assert.ok(text.includes('persons 表示原文里明确出现的人物（可多个，最多 8 个）'), 'the old persons definition stays')
  assert.ok(text.includes('只写明确的人名或称呼，不要推断关系'), 'the no-relation-inference rule stays')
  assert.ok(text.includes('最多 8 个'), 'the per-memory cap stays')
  // No "同一人全库同一叫法" requirement remains: several称呼 of one person are
  // all valid labels (the v1.5.0 wording lived only in lib/plugin.js).
  assert.ok(!text.includes('全库同一叫法'), 'no library-wide single-称呼 requirement')
})

// ---------------------------------------------------------------------------
// 2) the persons parameter description carries the same rule
// ---------------------------------------------------------------------------

test('memory_judge 1.6.0: the persons parameter description carries the pronoun rule', () => {
  const item = toolDefinition().parameters.properties.updates.items
  const persons = item.properties.persons
  assert.equal(persons.type, 'array', 'persons is still an array')
  assert.deepEqual(persons.items, { type: 'string' }, 'persons still holds strings')
  for (const phrase of [
    '原文里明确出现的人物',
    '最多 8 个',
    '人称代词',
    '同批提交的其他记忆',
    '判断代词指谁',
    '能确定就写明确的人名/称呼（如「周岑」）',
    '不要写「他」',
    '不能确定就不要猜',
    '同一人的多个称呼（如「周岑」「小周」）都写上',
    '省略=本次不修改',
    '空数组=清空',
  ]) {
    assert.ok(persons.description.includes(phrase), `persons.description must mention: ${phrase}`)
  }
  // The keywords field must also cover the pronoun-resolved names: the name is not
  // in the source text, so tag-only coverage would still fail a name search.
  const keywords = item.properties.keywords
  assert.ok(
    keywords.description.includes('代词消解出来的人名也要写进 keywords（否则以后按人名检索找不到这条记忆）'),
    'keywords.description covers pronoun-resolved names',
  )
  assert.ok(keywords.description.includes('关键词必须覆盖原文里的人物名/地点名/事件名'), 'the v1.5.0 keyword-coverage rule stays')
  // Sibling tag fields keep their own rules (the pronoun rule changes nothing else).
  assert.ok(item.properties.locations.description.includes('不要自行推断'), 'locations still forbids guessing')
  assert.ok(item.properties.events.description.includes('与 event 同时提交时 events 优先'), 'events precedence stays')
})

// ---------------------------------------------------------------------------
// 3) a resolved person and their several称呼 land on disk; omission = no change
// ---------------------------------------------------------------------------

test('memory_judge 1.6.0: a resolved person (and their several称呼) is written to meta.persons', async () => {
  await withTempDir(async (dir) => {
    const { memoryDir, plugin } = makeJudgeEnv(dir, { pending: ['mem-pronoun'] })
    // The model resolved「他」to 周岑 and also saw the「小周」称呼 in the text.
    const result = await judge(plugin, [
      {
        id: 'mem-pronoun',
        alpha: 0.6,
        beta: 2,
        keywords: ['周岑', '小周', '周末', '跑步'],
        persons: ['周岑', '小周'],
      },
    ])
    assert.deepEqual(result.updated, ['mem-pronoun'])
    assert.deepEqual(result.rejected, [])
    const meta = readMeta(memoryDir, 'mem-pronoun')
    assert.deepEqual(meta.persons, ['周岑', '小周'], 'a determined referent is stored under its explicit names, never as a pronoun')
    assert.equal(result.tagStats.persons, 2)
    const rendered = toolDefinition().output.render(null, result)[0].text
    assert.ok(rendered.includes('标签写入：人物 2 个'), rendered)

    // An update that omits persons never invents or clears labels.
    await judge(plugin, [{ id: 'mem-pronoun', beta: 2 }])
    assert.deepEqual(readMeta(memoryDir, 'mem-pronoun').persons, ['周岑', '小周'])
  })
})

// ---------------------------------------------------------------------------
// 4) the existing missing-tag reminder tells the model to resolve pronouns first
// ---------------------------------------------------------------------------

test('memory_judge 1.6.0: the missing-tag reminder adds the pronoun-resolution step', async () => {
  await withTempDir(async (dir) => {
    const { plugin } = makeJudgeEnv(dir, { pending: ['mem-untagged'] })
    // A new memory without events still gets the v1.5.0 reminder; v1.6.0 adds
    // "if the text only has a pronoun, resolve it before leaving persons empty".
    const result = await judge(plugin, [
      { id: 'mem-untagged', alpha: 0.3, beta: 0, keywords: ['天气', '闲聊', '周末'] },
    ])
    assert.deepEqual(result.updated, ['mem-untagged'])
    const hint = result.warnings.find((warning) => warning.includes('没有事件标签'))
    assert.ok(hint, 'the untagged-new-memory reminder is still emitted')
    for (const phrase of [
      '建议补上 locations/persons',
      '原文只有「他/她」等代词时',
      '先判断代词指谁',
      '能确定就写明确的人名/称呼（不要写「他」）',
      '不确定就不要猜',
    ]) {
      assert.ok(hint.includes(phrase), `reminder must mention: ${phrase} (got: ${hint})`)
    }
    // The reminder reaches the model through output.render as well.
    const rendered = toolDefinition().output.render(null, result)[0].text
    assert.ok(rendered.includes('先判断代词指谁'), rendered)
  })
})
