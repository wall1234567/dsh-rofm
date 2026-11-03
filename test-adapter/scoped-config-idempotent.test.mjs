/**
 * v1.4.1 regression: `scopedConfig()` must be idempotent.
 *
 * Live-data finding (2026-11-02, session-7bc15160): a stray
 * `memory/sessions/<id>/sessions/<id>/index.json` (empty index) appeared next to
 * the real store. Root cause: `restoreRecallState` computes a per-session
 * `scoped` config and passes it to `restoreSnapshot`/`restoreFromIds`, which call
 * `engineFor(session, cfg)`; `engineFor` scopes *again*, producing
 * `<sessionDir>/sessions/<id>/` and an empty `index.json` there.
 *
 * The fix marks an already-scoped config with a private symbol, so double
 * scoping is a no-op. This test pins both the idempotency and the absence of the
 * stray directory when the restore path runs.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { RofmPlugin } from '../lib/plugin.js'

const tempDirs = []
function tempDir(prefix = 'dshr-scoped-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function makeContext() {
  return {
    logger: { info() {}, warn() {}, debug() {} },
    get() { return undefined },
    on() { return () => {} },
    effect(callback) { return callback() },
  }
}

function makePlugin(memoryRoot) {
  const plugin = new RofmPlugin(makeContext(), {
    enabled: true,
    storage: { dir: memoryRoot, perSession: true },
    recall: { enabled: true, mode: 'fair' },
    compress: { enabled: false },
    logging: { enabled: false },
    compat: { qqBots: 'off' },
  })
  return plugin
}

test('scopedConfig is idempotent: scoping a scoped config returns the same object', () => {
  const root = tempDir()
  const plugin = makePlugin(root)
  const cfg = plugin.currentConfig()
  const session = { id: 'session-x' }
  const once = plugin.scopedConfig(cfg, session)
  const twice = plugin.scopedConfig(once, session)
  assert.equal(once.memoryDir, path.join(root, 'sessions', 'session-x'))
  assert.equal(twice, once, 'a second scoping must be a no-op (identity)')
  assert.equal(twice.memoryDir, once.memoryDir)
  // The internal marker must not leak into JSON-serialized config.
  assert.equal(JSON.stringify(once).includes('dsh-rofm:scoped-config'), false)
})

test('engineFor with an already-scoped config does not create a nested sessions/ store', () => {
  const root = tempDir()
  const plugin = makePlugin(root)
  const cfg = plugin.currentConfig()
  const session = { id: 'session-nested' }
  const scoped = plugin.scopedConfig(cfg, session)
  const engine = plugin.engineFor(session, scoped)
  assert.ok(engine, 'engine created')
  assert.equal(engine.memoryDir, scoped.memoryDir, 'engine memoryDir is the session store, not a nested one')
  assert.equal(existsSync(path.join(scoped.memoryDir, 'sessions')), false, 'no nested sessions/ directory')
})

test('restoreRecallState snapshot path does not create a nested store', () => {
  const root = tempDir()
  const plugin = makePlugin(root)
  const cfg = plugin.currentConfig()
  const scoped = plugin.scopedConfig(cfg, { id: 'session-restore' })
  mkdirSync(scoped.memoryDir, { recursive: true })
  // v2 snapshot with one addition: enough for restoreSnapshot to run (and to
  // reach the engineFor(session, scoped) call that used to double-scope).
  writeFileSync(path.join(scoped.memoryDir, 'recall-state.json'), JSON.stringify({
    version: 2,
    sessionId: 'session-restore',
    block: '## 记忆回忆\n\nPERSISTED BLOCK\n',
    ids: [{ id: 'mem-20260101T000000Z-0001', generation: 1 }],
    additions: [{
      id: 'mem-20260101T000000Z-0001',
      generation: 1,
      alpha: 0.5,
      beta: 0,
      probability: 0.5,
      chars: 10,
      tokens: 5,
      createdAt: 1700000000000,
      keywords: ['k1', 'k2', 'k3'],
      title: 't',
      messages: [{ role: 'user', content: 'hello' }],
    }],
  }))
  const session = { id: 'session-restore' }
  plugin.restoreRecallState(session, cfg)
  assert.equal(existsSync(path.join(scoped.memoryDir, 'sessions')), false, 'restore must not create a nested sessions/ store')
  const entries = readdirSync(scoped.memoryDir).filter((name) => name === 'sessions')
  assert.deepEqual(entries, [], 'no nested sessions entry')
  // The persisted block is exposed through the recall section.
  const pluginState = plugin.sessions.get(session)
  assert.ok(pluginState && typeof pluginState.text === 'string' && pluginState.text.length > 0, 'recall block restored')
})
