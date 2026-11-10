/**
 * Adapter recall-render contract (I6 regression, docs/SPEC.md §6.7).
 *
 * The injected recall block has two renderers: `engine/recall.js buildRecallBlock()`
 * (the source of truth, used whenever it returns text) and the adapter's local
 * fallback `lib/plugin.js renderRecallBlockFallback()` (used only when the engine
 * renderer throws or returns nothing). An older snapshot let them drift — the
 * fallback's trust preamble never reached the injected text because the engine
 * version always returned a non-empty block. These tests pin byte-identical
 * output so the fallback can never silently diverge again.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderRecallBlockFallback } from '../lib/plugin.js'
import { RECALL_BLOCK_PREAMBLE, RECALL_BLOCK_TIME_RULE, buildRecallBlock, loadConfig } from '../engine/index.js'

const cfg = loadConfig(undefined, {})

const T1 = Date.UTC(2026, 9, 25, 7, 16)
const T2 = T1 + 60_000
const T3 = T2 + 60_000
const T4 = T3 + 60_000

/**
 * Recall additions already ordered by createdAt ascending, mirroring what
 * `renderRecallBlock()` passes to the fallback (meta from the folder plan plus
 * the per-addition alpha/beta/generation/chars the recall path records).
 *
 * Message contents deliberately have no leading/trailing whitespace and no
 * toolCallId: `renderMessage()` and `messageToText()` render those differently by
 * design, and the recall path only ever feeds plain derived messages here.
 */
const additions = [
  {
    id: 'mem-20261025T071600Z-0001',
    // α lives only on the addition (not in meta): both renderers must read it there.
    alpha: 0.92,
    beta: 3,
    meta: { title: '部署方案已确认', createdAt: T1, keywords: ['部署', 'docker', '端口', '参数'] },
    messages: [
      { role: 'user', content: '以后都用 8080 端口部署，不要改。' },
      { role: 'assistant', content: '已记录：8080 端口，部署方案已确认。' },
    ],
  },
  {
    id: 'mem-20261025T071700Z-0002',
    // β field missing everywhere -> both renderers treat it as 0 (β=0.0);
    // no keywords -> the keyword segment is omitted.
    alpha: 0.4,
    meta: { title: '一次普通讨论', createdAt: T2, keywords: [] },
    messages: [{ role: 'tool', content: 'HTTP/1.1 200 OK' }],
  },
  {
    id: 'mem-20261025T071800Z-0003',
    // createdAt only on meta (not on the addition); negative β; generation from meta.
    alpha: 0.3,
    beta: -2.5,
    meta: { title: '否定与更正', createdAt: T3, keywords: ['玩笑'], generation: 2 },
    messages: [
      { role: 'user', content: '刚才说的只是玩笑，别当真。' },
      { role: 'assistant', content: '明白，已更正。' },
      { role: 'tool', content: 'recorded' },
    ],
  },
  {
    id: 'mem-20261025T071900Z-0004',
    // Eight keywords: both renderers must join them in the same order/separator.
    alpha: 0.2,
    meta: {
      title: '长期偏好',
      createdAt: T4,
      keywords: ['偏好', '长期', '风格', '深色', '主题', '记住', '配置', '约定'],
    },
    messages: [{ role: 'assistant', content: '已按长期偏好记录。' }],
  },
]

test('recall renderer: adapter fallback is byte-identical to the engine renderer', () => {
  const engineBlock = buildRecallBlock(additions, cfg)
  const fallbackBlock = renderRecallBlockFallback(additions)
  assert.ok(engineBlock.length > 0, 'fixture must produce a non-empty recall block')
  assert.equal(fallbackBlock, engineBlock, 'the two recall renderers must never drift')
  // Each addition on its own, so a regression that only affects one entry shape
  // (addition-only α, meta-only createdAt, missing β, no keywords, …) is caught.
  for (const [index, addition] of additions.entries()) {
    assert.equal(
      renderRecallBlockFallback([addition]),
      buildRecallBlock([addition], cfg),
      `renderers diverged for the single-addition case #${index + 1}`,
    )
  }
})

test('recall renderer: heading, verbatim preamble, entry titles and newline contract', () => {
  const block = renderRecallBlockFallback(additions)
  assert.ok(
    block.startsWith(`## 记忆回忆（按创建时间从早到晚）\n\n${RECALL_BLOCK_PREAMBLE}\n\n`),
    'heading + verbatim RECALL_BLOCK_PREAMBLE must open the block',
  )
  // Entry 1: addition-only α=0.92, β=+3.0, generation defaults to 1, keywords joined with 、
  assert.match(block, /### 回忆 1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · α=\d\.\d\d · β=([+-]\d+\.\d|0\.0) · 第1代/)
  assert.match(block, /### 回忆 1 · [^\n]* · α=0\.92 · β=\+3\.0 · 第1代 · 关键词：部署、docker、端口、参数/)
  // Entry 2 has no keywords -> the ` · 关键词：…` segment is omitted entirely.
  const entryLines = block.split('\n').filter((line) => line.startsWith('### 回忆 '))
  assert.equal(entryLines.length, additions.length)
  assert.ok(!entryLines[1].includes('关键词：'), `no-keyword entry must omit the segment: ${entryLines[1]}`)
  // Entry 3: meta-only createdAt, negative β and generation from meta.
  assert.match(entryLines[2], /### 回忆 3 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · α=0\.30 · β=-2\.5 · 第2代 · 关键词：玩笑/)
  // Entry 4: all eight keywords, same order and separator as the engine.
  assert.match(entryLines[3], /关键词：偏好、长期、风格、深色、主题、记住、配置、约定$/)
  // Trailing-newline contract: one final newline, no trailing whitespace/blank lines.
  assert.ok(block.endsWith('\n'), 'recall block must end with a single newline')
  assert.equal(block, block.trimEnd() + '\n')
  assert.equal(block.at(-2) === '\n' || block.trimEnd() === block.slice(0, -1).trimEnd(), true)
})

test('recall renderer: empty list renders empty string and β tokens match the engine', () => {
  assert.equal(renderRecallBlockFallback([]), '')
  assert.equal(renderRecallBlockFallback(undefined), '')
  assert.equal(buildRecallBlock([], cfg), '')
  const block = renderRecallBlockFallback(additions)
  for (const token of ['β=+3.0', 'β=0.0', 'β=-2.5']) {
    assert.ok(block.includes(token), `fallback output must carry the engine β token ${token}`)
  }
  // Same β tokens as the engine text, entry for entry.
  assert.equal(block, buildRecallBlock(additions, cfg))
})

// ---------------------------------------------------------------------------
// v1.5.4: computable form (归档于 X（事件时间 Y）) must not drift either
// ---------------------------------------------------------------------------

/** Fixed-zone computable config: all expected dates below are Asia/Shanghai. */
const computableCfg = loadConfig(undefined, {
  recall: { computeDates: true },
  time: { timezone: 'Asia/Shanghai' },
})

const at = (iso) => Date.parse(iso)

/**
 * Three computable fixtures: (1) meta event interval + a relative phrase
 * anchored at the message's own time; (2) no meta event fields, event time
 * derived from the archived messages' `time`; (3) no event time at all.
 */
const computableAdditions = [
  {
    id: 'mem-20260419T131000Z-0001',
    alpha: 0.9,
    beta: 3,
    meta: {
      createdAt: at('2026-04-19T13:10:00Z'),
      keywords: ['部署'],
      eventStart: at('2026-04-15T01:00:00Z'),
      eventEnd: at('2026-04-15T10:00:00Z'),
    },
    messages: [
      { role: 'user', content: '明天上线，记得检查端口。', time: at('2026-05-27T04:00:00Z') },
      { role: 'assistant', content: '收到。' },
    ],
  },
  {
    id: 'mem-20260419T131001Z-0002',
    alpha: 0.4,
    meta: { createdAt: at('2026-04-19T13:10:01Z'), keywords: [] },
    messages: [
      { role: 'user', content: '第一句。', time: at('2026-04-15T01:00:00Z') },
      { role: 'assistant', content: '第二句。', time: at('2026-04-16T10:00:00Z') },
    ],
  },
  {
    id: 'mem-20260419T131002Z-0003',
    alpha: 0.2,
    beta: -1,
    meta: { createdAt: at('2026-04-19T13:10:02Z'), keywords: ['旧记忆'] },
    messages: [{ role: 'user', content: '没有时间短语。' }],
  },
]

test('v1.5.4 recall renderer: computable fallback is byte-identical to the engine', () => {
  const engineBlock = buildRecallBlock(computableAdditions, computableCfg)
  const fallbackBlock = renderRecallBlockFallback(computableAdditions, computableCfg)
  assert.equal(fallbackBlock, engineBlock, 'the two renderers must not drift in the computable form')
  // Same title caliber as the engine: archive time labelled + event time in parentheses.
  assert.match(fallbackBlock, /### 回忆 1 · 归档于 2026-04-19 周日 21:10（事件时间 2026-04-15 周三） · α=0\.90/)
  assert.match(fallbackBlock, /### 回忆 2 · 归档于 2026-04-19 周日 21:10（事件时间 2026-04-15 周三 ~ 2026-04-16 周四）/)
  assert.match(fallbackBlock, /### 回忆 3 · 归档于 2026-04-19 周日 21:10 · α=0\.20/)
  assert.ok(!fallbackBlock.includes('（事件时间）'), 'no empty parenthetical')
  // The time-caliber rule is part of the computable preamble.
  assert.ok(fallbackBlock.includes(`${RECALL_BLOCK_PREAMBLE}\n${RECALL_BLOCK_TIME_RULE}`))
  // Per-message annotations use the message's own time (2026-05-27 -> 明天 = 05-28).
  assert.ok(fallbackBlock.includes('明天(2026-05-28)上线'), fallbackBlock)
  // Each addition rendered on its own must match too (entry-shape regressions).
  for (const [index, addition] of computableAdditions.entries()) {
    assert.equal(
      renderRecallBlockFallback([addition], computableCfg),
      buildRecallBlock([addition], computableCfg),
      `computable renderers diverged for the single-addition case #${index + 1}`,
    )
  }
  // Legacy callers (no cfg) still get the legacy block, unchanged.
  assert.equal(renderRecallBlockFallback(computableAdditions), buildRecallBlock(computableAdditions, cfg))
})
