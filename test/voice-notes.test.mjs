/**
 * Voice-note rewriting tests (QQ channel sessions).
 *
 * `dsh-onebot-qq` ships `[语音]` in the message body and delivers the STT
 * transcript later as `（语音转写：…）`; archiving must keep both facts.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { hasVoiceMarker, rewriteVoiceNotes } from '../lib/voice-notes.js'
import { buildSurfaceEntries } from '../lib/surface.js'

test('voice-notes: a delivered transcript becomes [语音] + text', () => {
  assert.equal(
    rewriteVoiceNotes('（语音转写：帮我记一下周五开会）'),
    '[语音] 帮我记一下周五开会',
  )
})

test('voice-notes: a bare placeholder is marked as untranscribed', () => {
  assert.equal(rewriteVoiceNotes('[语音]'), '[语音]（未转写）')
})

test('voice-notes: transcript and placeholder in one text are both annotated', () => {
  const text = '先听这个[语音]再说（语音转写：第二个语音的内容）'
  assert.equal(
    rewriteVoiceNotes(text),
    '先听这个[语音]（未转写）再说[语音] 第二个语音的内容',
  )
})

test('voice-notes: placeholder inside the onebot user_message wrapper', () => {
  const text = '[17:20 [观戏走天地.逍遥](1021831192)][@我] <user_message qq="1021831192" nickname="x">\n[语音]\n</user_message>'
  assert.equal(
    rewriteVoiceNotes(text),
    '[17:20 [观戏走天地.逍遥](1021831192)][@我] <user_message qq="1021831192" nickname="x">\n[语音]（未转写）\n</user_message>',
  )
})

test('voice-notes: multiple transcripts are each annotated', () => {
  assert.equal(
    rewriteVoiceNotes('（语音转写：一）（语音转写：二）'),
    '[语音] 一[语音] 二',
  )
})

test('voice-notes: an empty transcript degrades to the untranscribed marker', () => {
  assert.equal(rewriteVoiceNotes('（语音转写：）'), '[语音]（未转写）')
  assert.equal(rewriteVoiceNotes('（语音转写：   ）'), '[语音]（未转写）')
})

test('voice-notes: text without markers is returned unchanged', () => {
  const plain = '普通文字，没有语音标记。[图片：（x.png）]'
  assert.equal(rewriteVoiceNotes(plain), plain)
})

test('voice-notes: non-string input passes through untouched', () => {
  for (const value of [undefined, null, 0, 42, {}, [], true]) {
    assert.equal(rewriteVoiceNotes(value), value)
  }
  assert.equal(rewriteVoiceNotes(''), '')
})

test('voice-notes: rewriting its own output is a no-op (idempotent)', () => {
  const inputs = [
    '[语音]',
    '[语音] 你好',
    '（语音转写：你好）',
    '[语音]（未转写）',
    '前缀[语音]中间（语音转写：话）后缀',
  ]
  for (const input of inputs) {
    const once = rewriteVoiceNotes(input)
    assert.equal(rewriteVoiceNotes(once), once, `not idempotent for ${JSON.stringify(input)}`)
  }
})

test('voice-notes: hasVoiceMarker detects both marker shapes', () => {
  assert.equal(hasVoiceMarker('[语音]'), true)
  assert.equal(hasVoiceMarker('（语音转写：x）'), true)
  assert.equal(hasVoiceMarker('普通文字'), false)
  assert.equal(hasVoiceMarker(undefined), false)
})

/** Minimal session surface: one message per node, no token measurement. */
function fakeSession(texts) {
  const messages = texts.map((content) => ({ role: 'user', content, source: { kind: 'user' } }))
  return {
    surface: { nodes: messages.map((_m, index) => index + 1) },
    eventAt: (seq) => ({ type: 'user/message', data: { message: messages[seq - 1] } }),
    deriveEventMessage: (event) => event.data.message,
  }
}

test('voice-notes: buildSurfaceEntries annotates only when voiceNotes is on', () => {
  const session = fakeSession(['[语音]', '（语音转写：周五开会）', '普通文字'])
  const annotated = buildSurfaceEntries(session, undefined, { voiceNotes: true })
  assert.deepEqual(annotated.map((entry) => entry.text), [
    '[语音]（未转写）',
    '[语音] 周五开会',
    '普通文字',
  ])
  assert.deepEqual(annotated.map((entry) => entry.chars), [9, 9, 4])

  const raw = buildSurfaceEntries(session, undefined, {})
  assert.deepEqual(raw.map((entry) => entry.text), ['[语音]', '（语音转写：周五开会）', '普通文字'])
})
