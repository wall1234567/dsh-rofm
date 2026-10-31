/**
 * dsh-rofm — main-module detection tests (v1.3.0).
 *
 * The CLI tools (`tools/repair-session-log.mjs`, `tools/selfcheck.mjs`) only run
 * their `main()` when the module URL equals the script Node was asked to run.
 * The old hand-rolled comparison built a `file://` URL by string concatenation,
 * which silently failed on paths containing `#`, `?`, `%`, spaces or non-ASCII
 * characters — all of them common on Linux/macOS — and on symlinked invocations
 * (macOS `/tmp` → `/private/tmp`, a `link:` plugin install). These tests pin the
 * replacement (`tools/main-module.mjs`) both as a pure function and end to end
 * by executing a copied tool from a hostile path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { canonicalScriptPath, invokedAsMain, isMainModule } from '../tools/main-module.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = path.resolve(HERE, '..', 'tools')

/** Create a temp dir with a script inside; returns { tmp, script, url }. */
function fixtureScript(dirName = 'script.mjs') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-main-module-'))
  const script = path.join(tmp, dirName)
  fs.writeFileSync(script, '// fixture\n', 'utf8')
  return { tmp, script, url: pathToFileURL(script).href }
}

test('isMainModule: matches URL/path for spaces, #, %, ? and CJK directory names', () => {
  const dirNames = ['run #1', 'with space', '100% done', '中文 目录']
  // `?` is not a legal file-name character on Windows, so only POSIX hosts can
  // exercise it with a real file; the pure comparison itself has no such limit.
  if (process.platform !== 'win32') dirNames.push('what?')
  for (const dirName of dirNames) {
    const { tmp } = fixtureScript()
    try {
      const script = path.join(tmp, dirName, 'tool.mjs')
      fs.mkdirSync(path.dirname(script), { recursive: true })
      fs.writeFileSync(script, '// fixture\n', 'utf8')
      const url = pathToFileURL(script).href
      assert.equal(isMainModule(url, script), true, `must match: ${script}`)
      assert.equal(isMainModule(url, `${script}.other`), false)
      assert.equal(isMainModule(url, path.join(tmp, 'elsewhere.mjs')), false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  // Percent-decoding of `?`/`#` in a non-existent path is still a pure match.
  assert.equal(
    isMainModule(pathToFileURL('/tmp/rofm #1/what?/tool.mjs').href, '/tmp/rofm #1/what?/tool.mjs', 'linux'),
    true,
  )
})

test('isMainModule: empty/garbage input is a safe false', () => {
  assert.equal(isMainModule('', '/x/y.mjs'), false)
  assert.equal(isMainModule('not a url', '/x/y.mjs'), false)
  assert.equal(isMainModule('file:///x/y.mjs', ''), false)
  assert.equal(isMainModule(undefined, '/x/y.mjs'), false)
})

test('isMainModule: case folding follows the injected platform', () => {
  const { tmp, script, url } = fixtureScript('MixedCase.mjs')
  try {
    const swapped = path.join(tmp, 'mixedcase.mjs')
    assert.equal(isMainModule(url, script, 'linux'), true, 'the exact path always matches')
    assert.equal(isMainModule(url, swapped, 'linux'), false, 'Linux is case-sensitive')
    assert.equal(isMainModule(url, swapped, 'win32'), true, 'Windows folding')
    assert.equal(isMainModule(url, swapped, 'darwin'), true, 'macOS APFS folding')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('invokedAsMain: resolves a symlinked/junctioned entry path to the real module', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-main-link-'))
  try {
    const realDir = path.join(tmp, 'real-plugin')
    fs.mkdirSync(realDir, { recursive: true })
    const realScript = path.join(realDir, 'tool.mjs')
    fs.writeFileSync(realScript, '// fixture\n', 'utf8')
    const aliasDir = path.join(tmp, 'linked-plugin')
    // Link the *directory*: Windows junctions need a directory target (they work
    // without admin rights), and macOS/Linux `link:` installs are symlinked
    // directories too — exactly the real-world case this comparison must survive.
    let linked = false
    for (const type of ['junction', 'dir']) {
      try {
        fs.symlinkSync(realDir, aliasDir, type)
        // A directory junction/symlink must resolve; a dangling link cannot.
        if (fs.realpathSync(aliasDir) === fs.realpathSync(realDir)) linked = true
        break
      } catch {
        /* try the next flavour */
      }
    }
    if (!linked) {
      t.skip('this user cannot create directory symlinks/junctions')
      return
    }
    const moduleUrl = pathToFileURL(fs.realpathSync(realScript)).href
    assert.equal(invokedAsMain(moduleUrl, [process.execPath, path.join(aliasDir, 'tool.mjs')]), true, 'the alias must be canonicalised')
    assert.equal(invokedAsMain(moduleUrl, [process.execPath, path.join(tmp, 'missing.mjs')]), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('e2e: the repair tool runs its CLI from a path with spaces/#/CJK', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-main-e2e-'))
  try {
    const toolDir = path.join(tmp, 'run #1 中文 目录')
    fs.mkdirSync(toolDir, { recursive: true })
    for (const file of ['repair-session-log.mjs', 'main-module.mjs']) {
      fs.copyFileSync(path.join(TOOLS_DIR, file), path.join(toolDir, file))
    }
    const tool = path.join(toolDir, 'repair-session-log.mjs')
    const result = spawnSync(process.execPath, [tool, '--help'], { encoding: 'utf8' })
    assert.equal(result.status, 0, `repair tool must start from a hostile path: ${result.stderr}`)
    assert.match(result.stdout, /Usage:/, 'main() must run (the old file:// URL comparison failed here)')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('e2e: canonicalScriptPath falls back to the absolute path for missing entries', () => {
  const missing = path.join(os.tmpdir(), 'dshr-does-not-exist-script.mjs')
  assert.equal(canonicalScriptPath(missing), path.resolve(missing))
  assert.equal(canonicalScriptPath(''), '')
  assert.equal(canonicalScriptPath(undefined), '')
})
