/**
 * Model-facing message previews (v1.4.3).
 *
 * QQ-compat sessions archive the bridge's MCP tool results verbatim: the text
 * is `serializeModelData(...)` JSON, e.g. `qq_get_unread_messages` →
 * `{"ok":true,"key":"private:…","messages":[{"seq":5,"sender":"私聊","text":"…"}]}`
 * and `qq_wait_for_messages` → the same rows under `newMessages`. Truncating
 * that flatten to 160 characters (the pre-v1.4.3 scoring summary) exposed only
 * field names, so the model judged importance blind and scored α 0.1–0.4.
 *
 * `messagePreview` / `conversationPreview` / `messagesToReadableText` re-render
 * archived messages for prompts; stored data is never rewritten.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  conversationPreview,
  conversationalMessagesText,
  isRealConversation,
  messagePreview,
  messageToText,
  messagesToReadableText,
  safeSlice,
  toWellFormed,
  truncate,
} from '../lib/message-text.js'

const QQ_UNREAD = JSON.stringify({
  ok: true,
  key: 'private:765280787',
  unreadCount: 2,
  messages: [
    { seq: 5, messageId: '765280787', sender: '私聊', userId: '765280787', text: '今天好累啊，加班到十点才回来' },
    { seq: 6, messageId: '765280788', sender: '私聊', userId: '765280787', text: '晚上想吃点甜的，你说吃啥好' },
  ],
  readThroughSeq: 6,
})

const QQ_WAIT = JSON.stringify({
  ok: true,
  key: 'private:765280787',
  paused: false,
  arrived: true,
  timeout: false,
  waitedMs: 10000,
  newMessages: [{ seq: 7, messageId: '765280789', sender: '私聊', userId: '765280787', text: '你上次说的那家甜品店叫啥来着' }],
  readThroughSeq: 7,
  unreadCount: 0,
})

const CONFIG_DUMP = JSON.stringify({
  name: 'dsh-rofm',
  version: '1.4.2',
  storage: { dir: 'memory', perSession: true },
  importance: { min: 0.01, max: 1 },
})

test('messagePreview: QQ unread JSON renders its conversation, not field names', () => {
  const preview = messagePreview({ role: 'tool', content: QQ_UNREAD })
  assert.equal(preview.conversational, true)
  assert.equal(preview.text, '私聊：今天好累啊，加班到十点才回来\n私聊：晚上想吃点甜的，你说吃啥好')
  for (const fieldName of ['"seq"', '"messageId"', '"ok"', '"userId"', '"readThroughSeq"']) {
    assert.ok(!preview.text.includes(fieldName), `ids/flags must not leak into the preview: ${preview.text}`)
  }
})

test('messagePreview: QQ wait result with newMessages is readable too', () => {
  const preview = messagePreview({ role: 'tool', content: QQ_WAIT })
  assert.equal(preview.conversational, true)
  assert.equal(preview.text, '私聊：你上次说的那家甜品店叫啥来着')
})

test('messagePreview: JSON content-block arrays become plain text', () => {
  const content = JSON.stringify([
    { type: 'text', text: '我们决定以后统一使用 8080 端口，不要再改了' },
    { type: 'text', text: '收到' },
  ])
  const preview = messagePreview({ role: 'user', content })
  assert.equal(preview.conversational, true)
  assert.equal(preview.text, '我们决定以后统一使用 8080 端口，不要再改了\n收到')
})

test('messagePreview: non-chat JSON keeps the legacy role-prefixed fallback', () => {
  const preview = messagePreview({ role: 'tool', content: CONFIG_DUMP })
  assert.equal(preview.conversational, false)
  assert.equal(preview.text, `tool: ${CONFIG_DUMP}`)
})

test('messagePreview: malformed/truncated JSON never throws and keeps the legacy text', () => {
  const truncated = '{"id":"task-2","revision":1,"subject":"阶段A-1: engine/recall-index.js FAIR-DRI 选择器'
  const preview = messagePreview({ role: 'tool', content: truncated })
  assert.equal(preview.conversational, false)
  assert.equal(preview.text, `tool: ${truncated}`)
  // Whole-string bracket heuristics must not parse arbitrary prose.
  const prose = '{这不是 JSON，只是正文里带括号的一段话}'
  assert.equal(messagePreview({ role: 'user', content: prose }).text, `user: ${prose}`)
})

test('messagePreview: plain tool output and protocol markers are not conversation', () => {
  const tool = messagePreview({ role: 'tool', content: 'docker ps 输出：端口 8080' })
  assert.equal(tool.conversational, false)
  assert.equal(tool.text, 'tool: docker ps 输出：端口 8080')

  const pureCall = messagePreview({ role: 'assistant', content: '[tool-call memory_judge {"updates":[{"id":"mem-1","alpha":5}]}]' })
  assert.equal(pureCall.conversational, false)
  assert.equal(pureCall.text, 'assistant: [tool-call memory_judge {"updates":[{"id":"mem-1","alpha":5}]}]')

  const mixed = messagePreview({
    role: 'assistant',
    content: [{ type: 'text', text: '好的，我记录一下。' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.js"}' }],
  })
  assert.equal(mixed.conversational, true)
  assert.equal(mixed.text, 'assistant: 好的，我记录一下。', 'tool-call markers are stripped from conversation previews')
})

test('messagePreview: sender names are optional and unknown roles stay non-conversational', () => {
  const noSender = messagePreview({ role: 'tool', content: JSON.stringify({ messages: [{ text: '没有 sender 的消息' }] }) })
  assert.equal(noSender.text, '没有 sender 的消息')
  const system = messagePreview({ role: 'system', content: 'SYSTEM PROMPT TEXT' })
  assert.equal(system.conversational, false)
  assert.equal(system.text, 'system: SYSTEM PROMPT TEXT')
})

test('conversationPreview: leading tool JSON no longer hides the conversation (bug repro)', () => {
  const messages = [
    { role: 'tool', content: QQ_UNREAD },
    { role: 'assistant', content: '加班辛苦了，甜的推荐提拉米苏。' },
  ]
  const preview = conversationPreview(messages, 160)
  assert.equal(preview.conversational, true)
  assert.ok(preview.summary.startsWith('私聊：今天好累啊'), preview.summary)
  assert.ok(preview.summary.includes('提拉米苏'), preview.summary)
  assert.ok(!preview.summary.includes('"messageId"'), preview.summary)
  assert.ok(preview.summary.length <= 160)
})

test('conversationPreview: tool-only folders keep the exact legacy flatten', () => {
  const messages = [
    { role: 'tool', content: 'docker ps 输出：端口 8080' },
    { role: 'tool', content: 'docker logs 输出：迁移完成' },
  ]
  const legacy = messages.map((message) => messageToText(message)).join('\n').replace(/\s+/g, ' ').trim()
  const preview = conversationPreview(messages, 160)
  assert.equal(preview.conversational, false)
  assert.equal(preview.summary, legacy.slice(0, 160))
})

test('conversationPreview: bounded, whitespace-flattened, no truncation marker', () => {
  const long = '甲'.repeat(400)
  const preview = conversationPreview([{ role: 'user', content: `第一行\n\n第二行 ${long}` }], 160)
  assert.equal(preview.summary.length, 160)
  assert.ok(!preview.summary.includes('\n'))
  assert.ok(!preview.summary.endsWith('…'))
  const exact = conversationPreview([{ role: 'user', content: '短消息' }], 160)
  assert.equal(exact.summary, 'user: 短消息')
})

test('messagePreview: a wake prompt with an embedded message snapshot shows the messages', () => {
  const snapshot = JSON.stringify({
    messages: [{ seq: 8, messageId: '765280790', sender: '私聊', userId: '765280787', text: '对了，周末有空一起去看电影吗' }],
    now: '20:30',
    unreadCount: 1,
  })
  const wake = `【唤醒】私聊：765280787\n原因：收到新消息\n【当前状态】未读 1 条\n\n【本次消息快照】\n${snapshot}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。`
  const preview = messagePreview({ role: 'user', content: wake })
  assert.equal(preview.conversational, true)
  assert.equal(preview.text, '私聊：对了，周末有空一起去看电影吗')
})

test('messagePreview: braces in ordinary prose are not mistaken for a JSON snapshot', () => {
  const prose = '帮我看看这段代码：function f() { return [1, 2].map((x) => ({ y: x })) } 哪里有问题？'
  const preview = messagePreview({ role: 'user', content: prose })
  assert.equal(preview.text, `user: ${prose}`)
  // JSON without a message row (errors/config) must not hijack a long message.
  const withConfig = `配置如下：${CONFIG_DUMP} 这样写对吗？`
  assert.equal(messagePreview({ role: 'user', content: withConfig }).text, `user: ${withConfig}`)
})

test('conversationPreview: non-JSON messages keep their position (in-place fix)', () => {
  const messages = [
    { role: 'tool', content: 'docker ps 输出：端口 8080' },
    { role: 'assistant', content: '端口 8080 已确认' },
  ]
  const legacy = messages.map((message) => messageToText(message)).join('\n').replace(/\s+/g, ' ').trim()
  assert.equal(conversationPreview(messages, 160).summary, legacy.slice(0, 160))
})

test('conversationPreview: protocol markers are dropped only when a conversation exists', () => {
  const messages = [
    { role: 'assistant', content: '[tool-call read {"file_path":"a.js","limit":200}]' },
    { role: 'tool', content: QQ_UNREAD },
    { role: 'assistant', content: '看完了，明天再说吧' },
  ]
  const summary = conversationPreview(messages, 160).summary
  assert.ok(summary.startsWith('私聊：今天好累啊'), summary)
  assert.ok(!summary.includes('[tool-call'), summary)

  const toolOnly = conversationPreview([{ role: 'assistant', content: '[tool-call read {"file_path":"a.js"}]' }], 160)
  assert.ok(toolOnly.summary.includes('[tool-call read'), 'tool-only folders keep the legacy marker')
})

test('conversationPreview: unparseable JSON leftovers are dropped when conversation exists', () => {
  const truncated = '{"id":"task-2","revision":1,"subject":"阶段A-1: engine/recall-index.js'
  const messages = [
    { role: 'tool', content: truncated },
    { role: 'assistant', content: '好的，我接着做。' },
  ]
  const summary = conversationPreview(messages, 160).summary
  assert.equal(summary, 'assistant: 好的，我接着做。', 'raw JSON field names must not lead the summary')
  // No conversation at all: the legacy flatten is unchanged (nothing to render).
  assert.ok(conversationPreview([{ role: 'tool', content: truncated }], 160).summary.startsWith('tool: {"id"'))
})

test('messagesToReadableText: full readable body for re-review, including tools', () => {
  const text = messagesToReadableText([
    { role: 'tool', content: QQ_WAIT },
    { role: 'assistant', content: '那家叫甜屋，周末去？' },
    { role: 'tool', content: 'docker ps 输出：端口 8080' },
  ])
  assert.equal(text, '私聊：你上次说的那家甜品店叫啥来着\nassistant: 那家叫甜屋，周末去？\ntool: docker ps 输出：端口 8080')
})

test('JSON extraction is bounded and never throws on hostile payloads', () => {
  const deep = { a: { b: { c: { d: { e: { text: '深层消息' } } } } } }
  assert.equal(messagePreview({ role: 'tool', content: JSON.stringify(deep) }).text, '深层消息')

  const huge = { messages: Array.from({ length: 400 }, (_, index) => ({ sender: '群友', text: `第 ${index} 条消息 ${'甲'.repeat(40)}` })) }
  const preview = messagePreview({ role: 'tool', content: JSON.stringify(huge) })
  assert.ok(preview.text.length <= 4000, `preview stays bounded (${preview.text.length})`)
  // Odd inputs must never throw: the summary path runs during prompt assembly.
  for (const content of [null, '', '{', '[1,2,3', 42, { nested: { text: 7 } }]) {
    assert.doesNotThrow(() => messagePreview({ role: 'tool', content }))
  }
})

// ---------------------------------------------------------------------------
// v1.4.4: never serialize an unpaired UTF-16 surrogate into a model request
// ---------------------------------------------------------------------------
//
// A plain `slice()` can split an emoji on a UTF-16 code-unit boundary. The lone
// surrogate that remains is escaped by `JSON.stringify` into an invalid-surrogate
// JSON escape, and the DeepSeek Messages API rejects the whole request with
// `Failed to parse the request body as JSON … unexpected end of hex escape`.
// A pending memory keeps that summary in the system prompt, so the session can
// never complete a turn to score it — it stays stuck on every retry.

const EMOJI = '\u{1F916}' // 🤖 = U+1F916 = high surrogate D83E + low surrogate DD16

/** True when `text` contains an unpaired high or low surrogate. */
function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

test('toWellFormed: replaces unpaired surrogates with U+FFFD and keeps real emoji', () => {
  assert.equal(toWellFormed('abc'), 'abc')
  assert.equal(toWellFormed(`a${EMOJI}b`), `a${EMOJI}b`)
  assert.equal(toWellFormed('a\uD83Eb'), 'a\uFFFDb')
  assert.equal(toWellFormed('a\uDE00b'), 'a\uFFFDb')
  assert.equal(toWellFormed('\uD83E'), '\uFFFD')
  assert.equal(toWellFormed('\uD83E\uDD16'), '\uD83E\uDD16')
})

test('safeSlice: a surrogate pair straddling the limit is dropped whole', () => {
  const text = 'A'.repeat(100) + EMOJI + 'B'.repeat(100)
  assert.equal(safeSlice(text, 101), 'A'.repeat(100))
  assert.equal(safeSlice(text, 102), 'A'.repeat(100) + EMOJI)
  assert.equal(hasLoneSurrogate(safeSlice(text, 101)), false)
  assert.equal(safeSlice('short', 160), 'short')
  assert.equal(safeSlice('short', 0), '')
})

test('conversationPreview: the 160-code-unit cut never splits an emoji', () => {
  // `user: ` is 6 units, so 153 ASCII put the emoji's high surrogate exactly on
  // unit 159: before v1.4.4 `flat.slice(0, 160)` kept a lone D83E at the end.
  const preview = conversationPreview([{ role: 'user', content: 'A'.repeat(153) + EMOJI }], 160)
  assert.equal(preview.summary, `user: ${'A'.repeat(153)}`)
  assert.equal(hasLoneSurrogate(preview.summary), false)
  const BACKSLASH = String.fromCharCode(92)
  assert.equal(JSON.stringify(preview.summary).includes(`${BACKSLASH}ud83e`), false)
})

test('truncate: the hard cut never ends on a high surrogate', () => {
  const output = truncate('A'.repeat(399) + EMOJI, 400)
  assert.equal(output, `${'A'.repeat(399)}…[+1]`)
  assert.equal(hasLoneSurrogate(output), false)
})

test('pushPreviewLine: the 4000-unit JSON cap never ends on a high surrogate', () => {
  const json = JSON.stringify({ messages: [{ text: 'A'.repeat(3999) + EMOJI }] })
  const preview = messagePreview({ role: 'tool', content: json })
  assert.ok(preview.text.length <= 4000)
  assert.equal(hasLoneSurrogate(preview.text), false)
})

test('previews replace lone surrogates that already exist in archived data', () => {
  // `JSON.parse` of a `\ud83e` escape (QQ bridge / stored context.json) produces a
  // real lone surrogate; it must not survive into the prompt even with no cut.
  const row = JSON.parse('{"messages":[{"sender":"群友","text":"bad \\ud83e tail"}]}')
  const preview = conversationPreview([{ role: 'tool', content: JSON.stringify(row) }], 160)
  assert.equal(hasLoneSurrogate(preview.summary), false, preview.summary)
  assert.ok(preview.summary.includes('\uFFFD'), preview.summary)
  const readable = messagesToReadableText([{ role: 'user', content: 'x \uD83E y' }])
  assert.equal(hasLoneSurrogate(readable), false)
  assert.ok(readable.includes('\uFFFD'))
})

// ---------------------------------------------------------------------------
// v1.5.4: only a JSON payload that really carries chat rows is conversation
// ---------------------------------------------------------------------------

test('v1.5.4: conversationalMessagesText keeps QQ chat JSON and drops generic tool JSON', () => {
  const messages = [
    { role: 'tool', content: QQ_UNREAD },
    { role: 'tool', content: JSON.stringify({ error: 'timeout', code: 500 }) },
    { role: 'user', content: '好的，我记下了。' },
  ]
  const text = conversationalMessagesText(messages)
  assert.ok(text.includes('私聊：今天好累啊，加班到十点才回来'), text)
  assert.ok(text.includes('user: 好的，我记下了。'), text)
  assert.equal(text.includes('timeout'), false, 'generic tool JSON is process data, not dialogue')
})

test('v1.5.4: messagePreview marks JSON payloads with/without chat rows', () => {
  const chat = messagePreview({ role: 'tool', content: QQ_UNREAD })
  assert.equal(chat.conversational, true, 'legacy conversational flag is unchanged')
  assert.equal(chat.jsonPayload, true)
  assert.equal(chat.jsonChat, true)
  assert.equal(isRealConversation(chat), true)

  const note = messagePreview({ role: 'tool', content: JSON.stringify({ error: 'timeout', code: 500 }) })
  assert.equal(note.jsonPayload, true)
  assert.equal(note.jsonChat, false)
  assert.equal(isRealConversation(note), false, 'note-only JSON is not real conversation')

  const plain = messagePreview({ role: 'user', content: '普通对话' })
  assert.equal(plain.jsonPayload, false)
  assert.equal(isRealConversation(plain), true)
  const tool = messagePreview({ role: 'tool', content: 'docker ps 输出：端口 8080' })
  assert.equal(isRealConversation(tool), false)
})
