/**
 * v1.5.5 assistant-utterance keyword extraction quality (extractAssistantKeywords).
 *
 * The "你说过…" channel used to index tool-call/JSON junk as if it were the
 * assistant speaking, so a promise/decision said in natural language could be
 * crowded out (or missed entirely). The extractor now:
 *   - reads only real assistant conversation (text content blocks; no tool-call
 *     blocks, protocol markers or JSON-like payloads);
 *   - prioritises each turn's last natural-language reply and round-robins
 *     across turns (every turn gets at least one slot before any turn takes a
 *     second);
 *   - post-filters JSON keys/tokens, `mem-…` ids, pure numbers and lowercase
 *     JSON identifiers.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { extractAssistantKeywords } from '../engine/compress.js'

const cfg = {}
const extract = (messages) => extractAssistantKeywords(messages, cfg)

test('v1.5.5: tool-call blocks are dropped and their text parts kept', () => {
  const keywords = extract([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我们约定下周二去杭州，我订票。' },
        { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      ],
    },
  ])
  assert.ok(keywords.includes('杭州'), JSON.stringify(keywords))
  assert.ok(keywords.includes('约定'), JSON.stringify(keywords))
  for (const junk of ['tool-call', 'call-1', 'read_file', 'path']) {
    assert.equal(keywords.includes(junk), false, `${junk} must not become a keyword: ${JSON.stringify(keywords)}`)
  }
})

test('v1.5.5: protocol markers and JSON-like payloads are not assistant speech', () => {
  assert.deepEqual(extract([{ role: 'assistant', content: '[tool-call memory_judge {"updates":[]}]' }]), [])
  assert.deepEqual(extract([{ role: 'assistant', content: '[tool-added tool-1]' }]), [])
  assert.deepEqual(extract([{ role: 'assistant', content: '[tool-removed tool-1]' }]), [])
  assert.deepEqual(extract([{ role: 'assistant', content: '{"alpha":0.9,"keywords":["docker"],"mem":"mem-1"}' }]), [])
  assert.deepEqual(extract([{ role: 'assistant', content: '[\n{"role":"tool","content":"x"}\n]' }]), [])
  // Tool results are not assistant messages.
  assert.deepEqual(extract([{ role: 'tool', content: 'docker ps 输出：端口 8080' }]), [])
})

test('v1.5.5: pure numbers, mem- ids and JSON keys are post-filtered out', () => {
  const keywords = extract([
    {
      role: 'assistant',
      content: '参数 alpha beta keywords mem-20260101T000000Z-0001 当时是 12345 readthroughseq，后面我们决定改用 Postgres。',
    },
  ])
  assert.ok(keywords.includes('决定'), JSON.stringify(keywords))
  for (const junk of ['alpha', 'beta', 'keywords', 'mem-20260101T000000Z-0001', '12345', 'readthroughseq', '000000z']) {
    assert.equal(keywords.includes(junk), false, `${junk} must be filtered: ${JSON.stringify(keywords)}`)
  }
})

test('v1.5.5: each turn gets a slot before any turn takes a second', () => {
  const keywords = extract([
    { role: 'user', content: '第一问' },
    {
      role: 'assistant',
      content: '关于第一件事我先说明背景：上个月我们讨论过部署流程，涉及网关、端口、数据库迁移和回滚方案，这些都要注意；最终答复是我们决定周五去北京。',
    },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '我们约定周二去杭州。' },
  ])
  // The second turn's reply must not be crowded out by the long first turn.
  assert.ok(keywords.includes('杭州'), JSON.stringify(keywords))
  assert.ok(keywords.includes('约定'), JSON.stringify(keywords))
  assert.ok(keywords.length <= 12, `cap is 12: ${keywords.length}`)
})

test("v1.5.5: the turn's LAST natural-language reply is prioritised", () => {
  const keywords = extract([
    { role: 'user', content: '问' },
    { role: 'assistant', content: '我先查一下资料，稍等。' },
    { role: 'assistant', content: '查完了：我们决定以后都用 Postgres。' },
  ])
  // The final reply's words come before the earlier filler words.
  const lastReplyWords = ['查完', '完了', 'Postgres', '决定', '以后', '都用']
  const firstKeyword = keywords[0]
  assert.ok(lastReplyWords.some((word) => firstKeyword === word || firstKeyword.includes(word)), `last reply must lead: ${JSON.stringify(keywords)}`)
  const filler = ['资料', '稍等', '先查']
  const firstFillerAt = keywords.findIndex((word) => filler.some((item) => word === item || word.includes(item)))
  const firstLastReplyAt = keywords.findIndex((word) => lastReplyWords.some((item) => word === item || word.includes(item)))
  assert.ok(firstLastReplyAt >= 0 && (firstFillerAt === -1 || firstLastReplyAt < firstFillerAt), `last reply before filler: ${JSON.stringify(keywords)}`)
})

test('v1.5.5: assistant said extraction still returns [] for empty/user-only chunks', () => {
  assert.deepEqual(extract([]), [])
  assert.deepEqual(extract([{ role: 'user', content: '咖啡 浓茶' }]), [])
  assert.deepEqual(extract([{ role: 'assistant', content: '' }]), [])
})
