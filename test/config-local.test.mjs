/**
 * v1.4.1 privacy: `config.local.json` merge layer.
 *
 * Precedence must be: DEFAULT_CONFIG ← config.json ← config.local.json ← row config.
 * The local file is optional, git-ignored and used for machine-local settings
 * (QQ owner ids, media roots, …) that must never appear in tracked config.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { ConfigStore } from '../lib/config-store.js'

function makeDir(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshr-local-cfg-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return dir
}

test('config.local.json overrides config.json but not the profile row config', () => {
  const dir = makeDir({
    'config.json': {
      logging: { verbose: false },
      compat: { ownerIds: [], mediaRoots: [] },
      recall: { firstGenMax: 10 },
    },
    'config.local.json': {
      logging: { verbose: true },
      compat: { ownerIds: ['123456789'], mediaRoots: ['C:/Users/example/media'] },
      recall: { firstGenMax: 7 },
    },
  })
  try {
    const rowOnly = new ConfigStore(dir, { recall: { firstGenMax: 3 } })
    const cfg = rowOnly.get()
    // row config wins over the local file (highest precedence)
    assert.equal(cfg.recall.firstGenMax, 3)
    // local wins over config.json
    assert.equal(cfg.logging.verbose, true)
    assert.deepEqual(cfg.compat.ownerIds, ['123456789'])
    // mediaRoots are normalized the same way as storage.dir: absolute stays as-is,
    // relative resolves against the process cwd. `C:/...` is only absolute on
    // Windows, so POSIX runners (CI) see it resolved like any other relative path.
    const expectedMediaRoots = process.platform === 'win32'
      ? ['C:/Users/example/media']
      : [path.resolve('C:/Users/example/media')]
    assert.deepEqual(cfg.compat.mediaRoots, expectedMediaRoots)
    assert.equal(cfg.enabled, true, 'defaults still apply')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config.local.json alone can carry local settings (config.json keeps defaults)', () => {
  const dir = makeDir({
    'config.json': { compat: { ownerIds: [], mediaRoots: [] } },
    'config.local.json': { compat: { ownerIds: ['123456789'] } },
  })
  try {
    const cfg = new ConfigStore(dir, {}).get()
    assert.deepEqual(cfg.compat.ownerIds, ['123456789'])
    assert.deepEqual(cfg.compat.mediaRoots, [], 'mediaRoots falls back to the tracked config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a broken config.local.json is ignored with a warning (config.json still applies)', () => {
  const dir = makeDir({
    'config.json': { logging: { verbose: false }, compat: { ownerIds: [], mediaRoots: [] } },
    'config.local.json': '{ not json',
  })
  try {
    const cfg = new ConfigStore(dir, {}).get()
    assert.equal(cfg.logging.verbose, false, 'tracked config still applies')
    assert.ok(
      Array.isArray(cfg.warnings) && cfg.warnings.some((warning) => warning.includes('config.local.json')),
      `expected a config.local.json warning, got ${JSON.stringify(cfg.warnings)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing config.local.json is not an error', () => {
  const dir = makeDir({ 'config.json': { compat: { ownerIds: [], mediaRoots: [] } } })
  try {
    const cfg = new ConfigStore(dir, {}).get()
    assert.equal(cfg.enabled, true)
    assert.deepEqual(cfg.compat.ownerIds, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
