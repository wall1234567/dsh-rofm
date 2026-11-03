/**
 * Privacy regression tests (v1.4.1 addendum).
 *
 * Pins the policy that ended the 1.3.0 leak: the tracked `config.json` must not
 * contain machine-local values (QQ owner ids / media roots); those live in a
 * git-ignored `config.local.json`. Also pins the repository itself as clean.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { checkPrivacy } from '../tools/privacy-check.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function makeRoot(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshr-privacy-'))
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return dir
}

const GITIGNORE = 'memory/*\nconfig.local.json\nconfig.local.json.*\n'
const SANITIZED_CONFIG = {
  enabled: true,
  compat: { ownerIds: [], mediaRoots: [] },
}
const LOCAL_CONFIG = {
  compat: { ownerIds: ['123456789'], mediaRoots: ['C:/Users/example/Pictures/QQ'] },
}

test('privacy-check passes for a sanitized config with an ignored local override', () => {
  const root = makeRoot({
    'config.json': SANITIZED_CONFIG,
    '.gitignore': GITIGNORE,
    'config.local.json': LOCAL_CONFIG,
  })
  try {
    const result = checkPrivacy({ root })
    assert.equal(result.ok, true, result.problems.join('; '))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('privacy-check fails when tracked config.json carries owner ids / media roots', () => {
  const root = makeRoot({
    'config.json': { compat: { ownerIds: ['123456789'], mediaRoots: ['C:/Users/example/media'] } },
    '.gitignore': GITIGNORE,
  })
  try {
    const result = checkPrivacy({ root })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((problem) => problem.includes('ownerIds')), result.problems.join('; '))
    assert.ok(result.problems.some((problem) => problem.includes('mediaRoots')), result.problems.join('; '))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('privacy-check fails when .gitignore does not ignore config.local.json', () => {
  const root = makeRoot({
    'config.json': SANITIZED_CONFIG,
    '.gitignore': 'memory/*\n',
  })
  try {
    const result = checkPrivacy({ root })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((problem) => problem.includes('config.local.json')), result.problems.join('; '))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the dsh-rofm repository tracked config is clean', () => {
  const result = checkPrivacy({ root: REPO_ROOT })
  assert.equal(result.ok, true, result.problems.join('; '))
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'))
  assert.deepEqual(config.compat.ownerIds, [], 'tracked config.json ownerIds must stay empty')
  assert.deepEqual(config.compat.mediaRoots, [], 'tracked config.json mediaRoots must stay empty')
})
