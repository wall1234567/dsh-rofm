/**
 * v1.5.0 engine query-analysis tests (docs/SPEC.md §6.11, DESIGN-1.5.0 §3.3).
 *
 * The analysis is a pure deterministic pre-pass over the user message:
 * clause splitting, tag mentions, fuzzy times, "you said" quote detection and
 * the adaptive-quota decision. These tests pin the contract without booting a
 * harness:
 *   - `splitClauses` separators / `maxClauses` merge / `minClauseChars` / input types;
 *   - `detectAssistantSaid` phrase table / `enabled=false` / `quoted` / keywords;
 *   - `isComplexQuery` + `effectiveRecallQuota` thresholds and rollback switch;
 *   - `analyzeQuery` result shape, determinism and tag/
 *     time detection with (and without) a tag index.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASSISTANT_SAID_PHRASES,
  adaptiveQuotaConfig,
  analyzeQuery,
  clauseSplitConfig,
  detectAssistantSaid,
  effectiveRecallQuota,
  isComplexQuery,
  splitClauses,
} from '../engine/query-analysis.js'
import { buildTagIndex } from '../engine/tag-index.js'
import { loadConfig } from '../engine/index.js'

/** Packaged defaults (same object the plugin/engine use at runtime). */
const CFG = loadConfig(undefined, {})

/** A fixed `now` so the fuzzy-time assertions never depend on the wall clock. */
const NOW = Date.UTC(2026, 10, 7, 4) // 2026-11-07 12:00 Asia/Shanghai

// ---------------------------------------------------------------------------
// splitClauses
// ---------------------------------------------------------------------------

test('splitClauses: splits on 。！？；!?; and newlines (not on commas)', () => {
  assert.deepEqual(splitClauses('今天部署完成了吗？还有端口是多少！', CFG), ['今天部署完成了吗', '还有端口是多少'])
  assert.deepEqual(splitClauses('端口是多少；部署了吗？好的', CFG), ['端口是多少', '部署了吗', '好的'])
  assert.deepEqual(splitClauses('第一件事\n第二件事\r\n第三件事', CFG), ['第一件事', '第二件事', '第三件事'])
  assert.deepEqual(splitClauses('第一件事。第二件事! 第三件事? 第四件事; 第五件事', CFG), [
    '第一件事',
    '第二件事',
    '第三件事',
    '第四件事',
    '第五件事',
  ])
  // Commas are NOT clause separators (product decision: they are too common
  // inside one sentence and would shred a single question into pieces).
  assert.deepEqual(splitClauses('端口是 8080，部署在下午，负责人是小明', CFG), ['端口是 8080，部署在下午，负责人是小明'])
})

test('splitClauses: single sentence is trimmed; empty / whitespace / non-string -> []', () => {
  assert.deepEqual(splitClauses('  单句没有标点  ', CFG), ['单句没有标点'])
  assert.deepEqual(splitClauses('只有一个句子。', CFG), ['只有一个句子'])
  assert.deepEqual(splitClauses('', CFG), [])
  assert.deepEqual(splitClauses('   \n\t ', CFG), [])
  assert.deepEqual(splitClauses(undefined, CFG), [])
  assert.deepEqual(splitClauses(null, CFG), [])
  assert.deepEqual(splitClauses(42, CFG), [])
  assert.deepEqual(splitClauses({}, CFG), [])
})

test('splitClauses: more than maxClauses merges the tail into the last clause (never loses text)', () => {
  // Default maxClauses = 8.
  const many = '一甲。一乙。一丙。一丁。一戊。一己。一庚。一辛。一壬。一癸。'
  const defaults = splitClauses(many, CFG)
  assert.equal(defaults.length, 8, 'ten clauses are capped at the default 8')
  assert.equal(defaults[7], '一辛；一壬；一癸', 'the tail is merged with the documented separator')
  assert.equal(clauseSplitConfig(CFG).maxClauses, 8)

  const capped = splitClauses(many, { recall: { clauseSplit: { maxClauses: 3 } } })
  assert.equal(capped.length, 3)
  assert.deepEqual(capped.slice(0, 2), ['一甲', '一乙'])
  assert.equal(capped[2], '一丙；一丁；一戊；一己；一庚；一辛；一壬；一癸')
})

test('splitClauses: minClauseChars drops too-short fragments unless that would drop everything', () => {
  // Default minClauseChars = 2: the 1-character fragments are dropped.
  assert.deepEqual(splitClauses('好。嗯。做完了', CFG), ['做完了'])
  // Every fragment too short -> keep the original text instead of returning [].
  assert.deepEqual(splitClauses('好。嗯。', CFG), ['好。嗯。'])
  // A 4-character floor drops the 2-character fragment.
  assert.deepEqual(splitClauses('短句。这是一个较长的句子。', { recall: { clauseSplit: { minClauseChars: 4 } } }), [
    '这是一个较长的句子',
  ])
  assert.equal(clauseSplitConfig(CFG).minClauseChars, 2)
})

test('splitClauses: clauseSplit.enabled=false is the one-switch rollback', () => {
  assert.deepEqual(splitClauses('A 问题？B 问题？', { recall: { clauseSplit: { enabled: false } } }), ['A 问题？B 问题？'])
})

// ---------------------------------------------------------------------------
// detectAssistantSaid
// ---------------------------------------------------------------------------

test('detectAssistantSaid: every built-in quote phrase triggers the assistant-said channel', () => {
  const samples = ['你说过', '你之前说', '你建议', '你答应', '你让我', '你不是说', '你告诉过我']
  for (const phrase of samples) {
    const result = detectAssistantSaid(`${phrase}要早睡`, CFG)
    assert.equal(result.hit, true, `${phrase} must hit`)
    assert.ok(result.phrases.includes(phrase), `${phrase} is reported (${JSON.stringify(result.phrases)})`)
    assert.ok(ASSISTANT_SAID_PHRASES.includes(phrase), `${phrase} is part of the documented table`)
  }
  // A plain message never hits.
  assert.deepEqual(detectAssistantSaid('今天天气不错', CFG), { hit: false, phrases: [], quoted: '', keywords: [] })
})

test('detectAssistantSaid: quoted remainder and keywords are extracted deterministically', () => {
  const result = detectAssistantSaid('你不是说少喝咖啡吗？', CFG)
  assert.equal(result.hit, true)
  assert.deepEqual(result.phrases, ['你不是说'])
  assert.equal(result.quoted, '少喝咖啡吗？', 'the quoted content follows the first phrase')
  assert.ok(Array.isArray(result.keywords) && result.keywords.length > 0, JSON.stringify(result.keywords))

  const multi = detectAssistantSaid('你之前说要早睡，你说过吗', CFG)
  assert.equal(multi.hit, true)
  assert.ok(multi.phrases.includes('你之前说'))
  assert.ok(multi.phrases.includes('你说过'))
  assert.equal(multi.quoted, '要早睡，你说过吗')
})

test('detectAssistantSaid: recall.assistantSaid.enabled=false disables the channel', () => {
  for (const text of ['你说过要早睡', '你之前说端口是 8080', '你不是说少喝咖啡吗']) {
    const result = detectAssistantSaid(text, { recall: { assistantSaid: { enabled: false } } })
    assert.deepEqual(result, { hit: false, phrases: [], quoted: '', keywords: [] }, text)
  }
})

test('detectAssistantSaid: blank/non-string input yields the empty shape and never throws', () => {
  for (const text of ['', '   ', undefined, null, 42, {}]) {
    assert.deepEqual(detectAssistantSaid(text, CFG), { hit: false, phrases: [], quoted: '', keywords: [] })
  }
})

// ---------------------------------------------------------------------------
// isComplexQuery / effectiveRecallQuota
// ---------------------------------------------------------------------------

test('isComplexQuery: any one of clauses>=2 / chars>=160 / keywords>=8 triggers', () => {
  // adaptiveQuota defaults: 2 clauses, 160 chars, 8 keywords.
  const quotaCfg = adaptiveQuotaConfig(CFG)
  assert.equal(quotaCfg.complexMinClauses, 2)
  assert.equal(quotaCfg.complexMinChars, 160)
  assert.equal(quotaCfg.complexMinKeywords, 8)

  assert.equal(isComplexQuery({ clauses: ['a', 'b'], chars: 5, keywords: [] }, CFG), true, 'two clauses')
  assert.equal(isComplexQuery({ clauses: ['a'], chars: 160, keywords: [] }, CFG), true, '160 chars')
  assert.equal(isComplexQuery({ clauses: ['a'], chars: 10, keywords: Array(8).fill('k') }, CFG), true, '8 keywords')
  assert.equal(isComplexQuery({ clauses: ['a'], chars: 159, keywords: Array(7).fill('k') }, CFG), false, 'all below')
  assert.equal(isComplexQuery(null, CFG), false)
})

test('isComplexQuery: recall.adaptiveQuota.enabled=false always returns false', () => {
  const disabled = { recall: { adaptiveQuota: { enabled: false } } }
  assert.equal(isComplexQuery({ clauses: ['a', 'b', 'c'], chars: 1000, keywords: Array(20).fill('k') }, disabled), false)
})

test('effectiveRecallQuota: base firstGenMax, raised to complexQuota only for complex queries', () => {
  const cfg = { recall: { firstGenMax: 10 } }
  assert.equal(effectiveRecallQuota({ complex: false }, cfg), 10, 'ordinary message keeps firstGenMax')
  assert.equal(effectiveRecallQuota({ complex: true }, cfg), 20, 'complex/large message gets the 20-entry quota')
  assert.equal(effectiveRecallQuota(null, cfg), 10)
  // A higher configured base wins over the complex quota (max, never lower).
  assert.equal(effectiveRecallQuota({ complex: true }, { recall: { firstGenMax: 25 } }), 25)
  // The rollback switch restores firstGenMax for every message.
  assert.equal(
    effectiveRecallQuota({ complex: true }, { recall: { firstGenMax: 10, adaptiveQuota: { enabled: false } } }),
    10,
  )
  // Missing firstGenMax falls back to the documented default 10.
  assert.equal(effectiveRecallQuota({ complex: false }, {}), 10)
})

// ---------------------------------------------------------------------------
// analyzeQuery
// ---------------------------------------------------------------------------

test('analyzeQuery: result shape is complete and JSON-safe', () => {
  const analysis = analyzeQuery({ text: '端口配置是多少', cfg: CFG, now: NOW })
  assert.equal(analysis.text, '端口配置是多少')
  assert.equal(analysis.chars, analysis.text.length)
  assert.deepEqual(analysis.clauses, ['端口配置是多少'])
  assert.ok(Array.isArray(analysis.keywords))
  assert.deepEqual(Object.keys(analysis.tags).sort(), ['event', 'location', 'person'])
  for (const kind of ['location', 'person', 'event']) assert.ok(Array.isArray(analysis.tags[kind]))
  assert.ok(Array.isArray(analysis.timeWindows))
  assert.equal(typeof analysis.assistantSaid, 'object')
  assert.equal(analysis.assistantSaid.hit, false)
  assert.equal(analysis.complex, false)
  assert.equal(analysis.quota, 10, 'ordinary message quota = recall.firstGenMax')
  assert.deepEqual(JSON.parse(JSON.stringify(analysis)), analysis, 'the analysis must be lossless JSON')

  // Two sub-questions make the message complex (adaptive quota 20).
  const complex = analyzeQuery({ text: '端口是多少？部署时间呢？', cfg: CFG, now: NOW })
  assert.deepEqual(complex.clauses, ['端口是多少', '部署时间呢'])
  assert.equal(complex.complex, true)
  assert.equal(complex.quota, 20)
})

test('analyzeQuery: same input + same now is deterministic (deepEqual)', () => {
  const input = {
    text: '北京的项目，你之前说端口 8080。昨天部署完成了吗？',
    cfg: CFG,
    now: NOW,
  }
  const first = analyzeQuery(input)
  const second = analyzeQuery(input)
  assert.deepEqual(first, second)
})

test('analyzeQuery: detects tag mentions against the tag index, and never throws without one', () => {
  const tagIndex = buildTagIndex(
    [
      { id: 'mem-a', createdAt: 1, locations: ['北京'], persons: ['小明'], events: ['日本旅行'] },
      { id: 'mem-b', createdAt: 2, locations: ['上海'], persons: ['小红'], events: ['大阪旅行'] },
    ],
    CFG,
  )
  const detected = analyzeQuery({ text: '北京的小明问我日本旅行的事', cfg: CFG, now: NOW, tagIndex })
  assert.deepEqual(detected.tags.location, ['北京'])
  assert.deepEqual(detected.tags.person, ['小明'])
  assert.deepEqual(detected.tags.event, ['日本旅行'])

  // No/invalid tagIndex is a normal state (old index, disabled cache): empty tags.
  for (const tagIndexValue of [undefined, null, 'nope', 42]) {
    const analysis = analyzeQuery({ text: '北京的小明', cfg: CFG, now: NOW, tagIndex: tagIndexValue })
    assert.deepEqual(analysis.tags, { location: [], person: [], event: [] })
  }
})

test('analyzeQuery: fuzzy time expressions become absolute windows; timeTag.mode=off disables them', () => {
  const analysis = analyzeQuery({ text: '昨天做了什么', cfg: CFG, now: NOW })
  assert.equal(analysis.timeWindows.length, 1)
  assert.equal(analysis.timeWindows[0].label, '昨天')
  assert.ok(Number.isFinite(analysis.timeWindows[0].from))
  assert.ok(analysis.timeWindows[0].to > analysis.timeWindows[0].from)

  const off = analyzeQuery({ text: '昨天做了什么', cfg: { timeTag: { mode: 'off' } }, now: NOW })
  assert.deepEqual(off.timeWindows, [])
})

test('analyzeQuery: quote detection and the adaptive quota are wired together', () => {
  const quote = analyzeQuery({ text: '你之前说端口是 8080，对吗？', cfg: CFG, now: NOW })
  assert.equal(quote.assistantSaid.hit, true)
  assert.ok(quote.assistantSaid.phrases.includes('你之前说'))

  // A long multi-question message is complex and gets the 20-entry quota.
  const longText = `${'端口配置'.repeat(20)}？${'部署时间'.repeat(20)}？${'数据库迁移'.repeat(10)}？`
  assert.ok(longText.length >= 160, `fixture must be long enough (${longText.length})`)
  const complex = analyzeQuery({ text: longText, cfg: CFG, now: NOW })
  assert.equal(complex.complex, true)
  assert.ok(complex.clauses.length >= 2)
  assert.equal(complex.quota, 20)

  // The rollback switch restores the non-adaptive quota.
  const rollback = analyzeQuery({
    text: longText,
    cfg: { recall: { firstGenMax: 10, adaptiveQuota: { enabled: false } } },
    now: NOW,
  })
  assert.equal(rollback.complex, false)
  assert.equal(rollback.quota, 10)
})

test('analyzeQuery: garbage input degrades to the empty analysis instead of throwing', () => {
  for (const input of [undefined, null, {}, { text: 42 }, { text: null }]) {
    const analysis = analyzeQuery(input)
    assert.equal(analysis.text, '')
    assert.deepEqual(analysis.clauses, [])
    assert.deepEqual(analysis.tags, { location: [], person: [], event: [] })
    assert.deepEqual(analysis.timeWindows, [])
    assert.equal(analysis.assistantSaid.hit, false)
    assert.equal(typeof analysis.quota, 'number')
    assert.deepEqual(JSON.parse(JSON.stringify(analysis)), analysis)
  }
})
