/**
 * dsh-rofm — session-log repair tool tests.
 *
 * The regression this guards: an injected synthetic `user/message` without a
 * message id makes DSH refuse to reload the whole session log, so the GUI shows
 * "历史加载失败" and blocks chat/rename.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decodeJournal,
  encodeJournal,
  locateFrames,
  repairJournalText,
} from '../tools/repair-session-log.mjs'

const HEADER = JSON.stringify({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:/work' })

function userEvent(seq, id) {
  return JSON.stringify({
    type: 'user/message',
    seq,
    time: 1700000000000,
    data: {
      ...(id === undefined ? {} : { id }),
      role: 'user',
      source: { kind: 'rofm-recall', form: 'snapshot', summary: '记忆回忆' },
      content: [{ type: 'text', text: '## 记忆回忆' }],
    },
    surfaceOp: 'append',
  })
}

function journal(...lines) {
  return [HEADER, ...lines].join('\n') + '\n'
}

test('repair: an id-less synthetic user message gains exactly one id', () => {
  const input = journal(userEvent(1, undefined), JSON.stringify({ type: 'turn/start', seq: 2, data: { turn: 1 } }))
  const result = repairJournalText(input, { idFactory: () => 'fixed-id' })
  assert.equal(result.changed, true)
  assert.deepEqual(result.repairs, [{ seq: 1, type: 'user/message', id: 'fixed-id' }])
  assert.deepEqual(result.unrepairable, [])
  const events = result.text.split('\n').filter((line) => line !== '').slice(1).map((line) => JSON.parse(line))
  assert.equal(events[0].data.id, 'fixed-id')
  assert.equal(events[0].data.role, 'user', 'the payload keeps its role')
  assert.equal(events[0].data.source.kind, 'rofm-recall', 'the payload keeps its source kind')
  assert.deepEqual(events[1], { type: 'turn/start', seq: 2, data: { turn: 1 } }, 'other events stay byte-identical')
  assert.equal(result.text.split('\n')[0], HEADER, 'the header line is preserved')
})

test('repair: a journal that already carries ids is left untouched (idempotent)', () => {
  const input = journal(userEvent(1, 'already-there'))
  const first = repairJournalText(input, { idFactory: () => 'new-id' })
  assert.equal(first.changed, false)
  assert.deepEqual(first.repairs, [])
  assert.equal(first.text, input)

  const broken = journal(userEvent(1, undefined))
  const repaired = repairJournalText(broken, { idFactory: () => 'new-id' })
  const again = repairJournalText(repaired.text, { idFactory: () => 'other-id' })
  assert.equal(again.changed, false, 'a repaired journal reports no further repairs')
})

test('repair: message-bearing events use data.message, user/message uses data itself', () => {
  const assistant = JSON.stringify({
    type: 'assistant/message',
    seq: 1,
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [], stream: [] } },
  })
  const result = repairJournalText(journal(assistant), { idFactory: () => 'assistant-id' })
  assert.deepEqual(result.repairs, [{ seq: 1, type: 'assistant/message', id: 'assistant-id' }])
  const message = JSON.parse(result.text.split('\n')[1]).data.message
  assert.equal(message.id, 'assistant-id')
  assert.equal(message.source.model, 'm')
})

test('repair: a message missing role/source/content is reported, not invented', () => {
  const hollow = JSON.stringify({ type: 'user/message', seq: 7, data: { surfaceOp: 'append' } })
  const result = repairJournalText(journal(hollow), { idFactory: () => 'x' })
  assert.equal(result.changed, false)
  assert.deepEqual(result.repairs, [])
  assert.equal(result.unrepairable.length, 1)
  assert.equal(result.unrepairable[0].seq, 7)
  assert.match(result.unrepairable[0].reason, /role\/source\/content/)
})

test('repair: an unparsable event line is reported instead of dropped', () => {
  const result = repairJournalText(journal('{not json'), { idFactory: () => 'x' })
  assert.equal(result.unrepairable.length, 1)
  assert.equal(result.unrepairable[0].type, 'unparsable-line')
  assert.ok(result.text.includes('{not json'), 'the broken line is preserved for a human')
})

test('journal: decode/encode round-trips a multi-frame zstd container', () => {
  const events = []
  for (let seq = 0; seq < 300; seq += 1) events.push(userEvent(seq, `id-${seq}`))
  const text = journal(...events)
  const encoded = encodeJournal(text)
  assert.ok(locateFrames(encoded).length > 2, 'event batches span several frames')
  assert.equal(decodeJournal(encoded), text)
})
