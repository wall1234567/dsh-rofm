/**
 * v1.5.0 archive-time fields on the adapter (planCompression) path:
 *   - deterministic time tags (fuzzy time -> absolute intervals);
 *   - deterministic assistant-utterance keywords (the "你说过…" channel);
 *   - the existing event-time interval.
 *
 * The passive archive path has its own coverage in test/passive-archive.test.mjs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { planCompression } from '../engine/compress.js'
import { DEFAULT_CONFIG, validateConfig } from '../engine/config.js'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-07T10:00:00+08:00')

function conversation() {
  const messages = []
  for (let index = 0; index < 12; index += 1) {
    const base = NOW - (12 - index) * HOUR
    messages.push({
      role: 'user',
      content: `第${index}轮：昨天和小明去北京吃火锅，下周二之前完成部署端口配置。${'甲'.repeat(400)}`,
      time: base,
    })
    messages.push({
      role: 'assistant',
      content: `第${index}轮助手：我建议你少喝咖啡，先验证迁移脚本再上线。${'乙'.repeat(400)}`,
      time: base + 1000,
    })
  }
  return messages
}

function cfg() {
  return validateConfig({
    ...DEFAULT_CONFIG,
    compress: { ...DEFAULT_CONFIG.compress, allowSmallWindow: true, triggerPercent: 60 },
  })
}

test('planCompression: meta carries v1.5.0 time tags and assistant keywords', () => {
  const plan = planCompression({
    messages: conversation(),
    usedPercent: 95,
    cfg: cfg(),
    now: NOW,
    windowTokens: 1000,
    protectTurn: false,
  })
  const folders = plan.folderPlans ?? plan.folders ?? []
  assert.ok(plan.shouldCompress !== false && folders.length >= 1, 'the fixture must trigger an archive')
  const meta = folders[0].meta

  // Event interval (v1.4.0) is still written from the message times.
  assert.ok(Number.isFinite(meta.eventStart))
  assert.ok(Number.isFinite(meta.eventEnd))
  assert.equal(meta.eventTimeSource, 'messages')

  // v1.5.0 deterministic time tags.
  assert.ok(Array.isArray(meta.timeTags) && meta.timeTags.length >= 1, JSON.stringify(meta.timeTags))
  assert.equal(meta.timeTagSource, 'messages')
  const labels = meta.timeTags.map((tag) => tag.label)
  assert.ok(labels.includes('昨天'), labels.join(','))
  assert.ok(labels.includes('下周二'), labels.join(','))
  for (const tag of meta.timeTags) {
    assert.equal(typeof tag.label, 'string')
    assert.ok(Number.isFinite(tag.from) && Number.isFinite(tag.to) && tag.to > tag.from)
    assert.ok(['day', 'week', 'month', 'year'].includes(tag.granularity))
  }

  // v1.5.0 assistant-utterance channel keywords (deterministic).
  assert.ok(Array.isArray(meta.assistantKeywords) && meta.assistantKeywords.length > 0, JSON.stringify(meta.assistantKeywords))
  assert.ok(meta.assistantKeywords.every((keyword) => typeof keyword === 'string' && keyword.length > 0))

  // planCompression emits the deterministic heuristic baseline meta; the adapter
  // then rewrites the scoring fields to `pending` before committing (no model call
  // happens inside planCompression either way).
  assert.equal(typeof meta.scored, 'boolean')
  assert.equal(meta.alphaSource, 'heuristic')
})

test('planCompression: no assistant messages -> no assistantKeywords field', () => {
  const messages = conversation().filter((message) => message.role === 'user')
  const plan = planCompression({
    messages,
    usedPercent: 95,
    cfg: cfg(),
    now: NOW,
    windowTokens: 1000,
    protectTurn: false,
  })
  const folders = plan.folderPlans ?? plan.folders ?? []
  if (folders.length === 0) return
  assert.equal(folders[0].meta.assistantKeywords, undefined, 'an all-user chunk has no assistant channel')
})
