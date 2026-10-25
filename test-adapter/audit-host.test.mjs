/**
 * Pre-open-source hardening audit — DSH adapter-side regressions.
 *
 * `lib/config-store.js` merges parsed JSON (config.json + the profile patch row)
 * over the adapter defaults. `JSON.parse` turns a `"__proto__"` member into an
 * *own* property, so the naive `out[key] = value` assignment used to invoke
 * Object.prototype's `__proto__` setter: the key vanished and the merged object's
 * prototype was replaced instead (prototype pollution of the live config). The
 * engine-side `deepMerge` was fixed the same way (test/audit-engine.test.mjs);
 * this file pins the adapter-side fix and end-to-end ConfigStore behaviour.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { ADAPTER_DEFAULTS, ConfigStore, deepMerge } from '../lib/config-store.js'

const pollutionPayload = () => JSON.parse('{"__proto__":{"polluted":"yes"},"recall":{"maxRecalledBlocks":7},"xUnknown":42}')

test('adapter config: deepMerge keeps a JSON "__proto__" key as data, never as prototype', () => {
  const merged = deepMerge(ADAPTER_DEFAULTS, pollutionPayload())

  assert.equal(Object.getPrototypeOf(merged), Object.prototype, 'merged object prototype must stay Object.prototype')
  assert.equal(merged.polluted, undefined, 'no inherited pollution must leak through the prototype')
  assert.equal(Object.prototype.polluted, undefined, 'Object.prototype must stay clean')
  assert.equal(Object.prototype.hasOwnProperty.call(merged, '__proto__'), true, 'unknown keys are preserved as own data keys')
  assert.deepEqual(merged.__proto__, { polluted: 'yes' })
  // Normal merge behaviour is unchanged.
  assert.equal(merged.recall.maxRecalledBlocks, 7)
  assert.equal(merged.recall.persistInjected, ADAPTER_DEFAULTS.recall.persistInjected)
  assert.equal(merged.xUnknown, 42)
})

test('adapter config: deepMerge is prototype-safe at every nesting level', () => {
  const payload = JSON.parse('{"compress":{"__proto__":{"nested":"yes"},"triggerPercent":42},"__proto__":5}')
  const merged = deepMerge({ compress: { triggerPercent: 60, enabled: true } }, payload)

  assert.equal(Object.getPrototypeOf(merged), Object.prototype)
  assert.equal(Object.getPrototypeOf(merged.compress), Object.prototype)
  assert.equal(merged.nested, undefined)
  assert.equal(merged.compress.nested, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(merged, '__proto__'), true)
  assert.equal(merged.__proto__, 5)
  assert.equal(merged.compress.triggerPercent, 42)
  assert.equal(Object.prototype.nested, undefined)
})

test('adapter config: ConfigStore never lets a polluted config.json reach the live config', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-config-'))
  try {
    // A real config.json on disk that contains a `__proto__` member.
    writeFileSync(
      path.join(dir, 'config.json'),
      '{"__proto__":{"polluted":"yes"},"logging":{"verbose":true},"myCustomKey":"kept"}',
    )
    const store = new ConfigStore(dir, {})
    const cfg = store.get()

    assert.equal(Object.getPrototypeOf(cfg), Object.prototype)
    assert.equal(cfg.polluted, undefined)
    assert.equal(Object.prototype.polluted, undefined)
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, '__proto__'), true)
    assert.equal(cfg.enabled, true, 'defaults still apply')
    assert.equal(cfg.logging.verbose, true, 'file config still applies')
    assert.equal(cfg.myCustomKey, 'kept', 'unknown keys are preserved (forward compatible)')
    // A reload must stay safe as well (same parsed JSON path).
    const reloaded = store.reload()
    assert.equal(Object.getPrototypeOf(reloaded), Object.prototype)
    assert.equal(reloaded.polluted, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
