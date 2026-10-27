/**
 * Adapter rubric contract — the `memory_judge` tool definition (docs/SPEC.md §4.2).
 *
 * α/β/keywords are judged by the *current* session model, so the registered tool
 * definition is the model-facing contract for the rubric. I1 (α判断增加用户喜好):
 * the α clause must tell the model to weigh the user's explicitly expressed
 * likes/dislikes/habits and long-term preferences, while chit-chat and procedural
 * logs stay low. These tests pin the definition text; no update is executed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MemoryJudgeTool } from '../lib/memory-tool.js'

// definition() only reads the stored plugin instance (the constructor does
// nothing else), so an empty stub is enough: no DSH service / engine context is
// needed and no execute() path is touched.
const definition = () => new MemoryJudgeTool({}).definition()

test('memory_judge: registered name, required arguments and output wiring', () => {
  const def = definition()
  assert.equal(def.name, 'memory_judge')
  assert.deepEqual(def.parameters.required, ['updates'])
  assert.equal(def.parameters.properties.updates.type, 'array')
  assert.deepEqual(def.parameters.properties.updates.items.required, ['id'])
  assert.equal(def.timeoutMs, 5000)
  assert.equal(def.isConcurrencySafe(), false)
  assert.equal(typeof def.execute, 'function')
  assert.deepEqual(def.output.render({}, { updated: ['mem-1'], kept: [], rejected: [] }), [
    { type: 'text', text: '已更新 1 条（mem-1）。' },
  ])
})

test('memory_judge: α rubric weighs user preferences, β/keywords rubric intact', () => {
  const { description } = definition()
  // α semantics: importance decides how often the memory is recalled automatically.
  assert.ok(description.includes('α（0.01~1）决定该记忆以后被自动回忆的概率'), 'α semantics missing')
  // I1: explicit user preferences/flavours must raise α.
  for (const phrase of ['用户明确表达的喜好', '厌恶', '习惯', '长期偏好', '应给较高 α', '闲聊', '过程性日志']) {
    assert.ok(description.includes(phrase), `description must mention ${phrase}`)
  }
  for (const example of ['「我喜欢…」', '「以后都…」', '「不要…」']) {
    assert.ok(description.includes(example), `description must keep the preference example ${example}`)
  }
  // The β / keywords / keep clauses are unchanged by the α edit.
  assert.ok(description.includes('β（-10~10）是这条记忆能否当事实或指令使用的信赖度'))
  assert.ok(description.includes('可信的事实/决定/约定为正分'))
  assert.ok(description.includes('新归档的待评分记忆需要同时给出 3~8 个关键词'))
  assert.ok(description.includes('keep=true 表示保持原值'))
})

test('memory_judge: alpha parameter carries the preference rule; other parameters unchanged', () => {
  const props = definition().parameters.properties.updates.items.properties
  // Short form of the same I1 rule lives on the parameter itself.
  assert.ok(props.alpha.description.includes('重要度 0.01~1'))
  assert.ok(props.alpha.description.includes('用户明确表达的喜好'))
  assert.ok(props.alpha.description.includes('长期偏好'))
  assert.ok(props.alpha.description.includes('较高值'))
  assert.ok(props.alpha.description.includes('省略表示不修改'))
  // beta / keywords / keep / reason / id descriptions are untouched.
  assert.equal(props.beta.description, '信赖度 -10~10；省略表示不修改')
  assert.equal(props.keywords.description, '3~8 个关键词；待评分新记忆必填，复核已有记忆可省略')
  assert.equal(props.keep.description, 'true 表示保持现有 α/β 不变（复核时无需修改可用）')
  assert.equal(props.reason.description, '一句话理由（可选）')
  assert.equal(props.id.description, '记忆文件夹 id，例如 mem-20261025T071640Z-0001')
})
