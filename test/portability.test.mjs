/**
 * dsh-rofm — cross-platform portability tests (v1.3.0).
 *
 * The plugin must run identically on Windows, Linux and macOS. CI now runs the
 * whole suite on all three, but these tests add checks that a *single* host OS
 * cannot express on its own:
 *
 *   1. static checks: every relative `import`/`export … from` resolves with the
 *      exact on-disk case (Windows would pass even when Linux/macOS cannot),
 *      runtime modules only import `node:` builtins, and no runtime module
 *      builds a `file://` URL or branches on `process.platform` outside the two
 *      reviewed helpers;
 *   2. `~` expansion (`lib/paths.js`) and its adapter wiring (`storage.dir`,
 *      `compat.mediaRoots`) so one `config.json` is portable;
 *   3. POSIX / Windows / macOS path-rule simulation for the security-critical
 *      media-root containment check (`validateMediaPath` with injected
 *      `pathImpl` + `platform`), which a Windows-only run could not cover;
 *   4. real-file-system behaviour that macOS/Linux users hit: a memory directory
 *      reached through a symlink/junction (macOS `/var` → `/private/var`), paths
 *      containing spaces / CJK / `#`, and LF-only output files.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isHomeRelativePath, expandHomePath } from '../lib/paths.js'
import { ConfigStore } from '../lib/config-store.js'
import { normalizeCompatConfig } from '../lib/compat.js'
import { validateMediaPath } from '../lib/qq-media.js'
import {
  ensureImageFolder,
  saveImageFile,
  loadImageFile,
  imageFileInfo,
  listImageFiles,
  upsertImageIndexEntries,
} from '../lib/images.js'
import { stageMessageMedia, takeStagedMedia } from '../lib/qq-media.js'
import {
  ensureMemoryDir,
  writeFolder,
  readFolder,
  appendStats,
  readStats,
  mergeConfigFile,
} from '../engine/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

// ---------------------------------------------------------------------------
// 1. static portability checks
// ---------------------------------------------------------------------------

/** Recursively list `.js`/`.mjs` source files under one directory. */
function listSources(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'memory' || entry.name === '.git') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) out.push(full)
    }
  }
  return out.sort()
}

/**
 * Case-exact path stat: walk every path segment against the directory listing,
 * so `lib/Images.js` is reported missing even on a case-insensitive Windows/macOS
 * volume (where Linux would fail at import time).
 * @param {string} absolutePath
 * @returns {fs.Stats | undefined}
 */
function exactCaseStat(absolutePath) {
  const parsed = path.parse(absolutePath)
  let current = parsed.root
  const segments = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (const segment of segments) {
    let entries
    try {
      entries = fs.readdirSync(current)
    } catch {
      return undefined
    }
    if (!entries.includes(segment)) return undefined
    current = path.join(current, segment)
  }
  try {
    return fs.statSync(current)
  } catch {
    return undefined
  }
}

/** Whether `absolutePath` exists (file or directory) with the exact on-disk case. */
function exactCaseExists(absolutePath) {
  return exactCaseStat(absolutePath) !== undefined
}

/** Resolve one relative import specifier to the *file* Node would load. */
function resolveRelativeSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    path.join(base, 'index.js'),
    path.join(base, 'index.mjs'),
  ]
  for (const candidate of candidates) {
    const stat = exactCaseStat(candidate)
    // ESM relative imports need an explicit file target; a directory alone is not enough.
    if (stat !== undefined && stat.isFile()) return candidate
  }
  return undefined
}

/** All `import … from 'x'`, `export … from 'x'` and bare `import 'x'` specifiers. */
function extractSpecifiers(text) {
  const specifiers = []
  // A module specifier never contains whitespace/commas; the strict character
  // class keeps stopword arrays such as `'for', 'from', 'further',` from matching.
  for (const match of text.matchAll(/\bfrom\s*(['"])([^'"\s]+)\1/g)) specifiers.push(match[2])
  for (const match of text.matchAll(/(?:^|\n)\s*import\s*(['"])([^'"\s]+)\1/g)) specifiers.push(match[2])
  return specifiers
}

test('static: every relative import resolves with the exact on-disk case', () => {
  const files = listSources(REPO_ROOT)
  assert.ok(files.length > 20, `expected the repository sources, found ${files.length} files`)
  const problems = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const specifier of extractSpecifiers(text)) {
      if (!specifier.startsWith('.')) continue
      if (resolveRelativeSpecifier(file, specifier) === undefined) {
        problems.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`)
      }
    }
  }
  assert.deepEqual(problems, [], 'case-exact import resolution must hold on case-sensitive file systems (Linux)')
})

test('static: runtime modules only import node: builtins (zero dependencies)', () => {
  const runtimeDirs = ['lib', 'engine', 'tools'].map((dir) => path.join(REPO_ROOT, dir))
  const files = [path.join(REPO_ROOT, 'index.js'), ...runtimeDirs.flatMap((dir) => listSources(dir))]
  const problems = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const specifier of extractSpecifiers(text)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
      problems.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`)
    }
  }
  assert.deepEqual(problems, [], 'the shipped plugin must stay zero-dependency')
})

test('static: no runtime module builds a file:// URL or compares process.platform inline', () => {
  const files = [path.join(REPO_ROOT, 'index.js'), ...['lib', 'engine', 'tools'].flatMap((dir) => listSources(path.join(REPO_ROOT, dir)))]
  const forbidden = []
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/')
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
      if (/new URL\(\s*[`'"]file:\/\//.test(line)) forbidden.push(`${relative}:${index + 1} file:// URL literal`)
      if (/['"`]file:\/\/['"`]\s*\+/.test(line)) forbidden.push(`${relative}:${index + 1} file:// string concat`)
      // Path comparisons are centralised: only the two reviewed helpers may branch on the host OS.
      const branch = /process\.platform\s*(?:===|!==|==|!=)/.test(line)
      if (branch && relative !== 'lib/compat-autopatch.js') forbidden.push(`${relative}:${index + 1} inline process.platform branch`)
      if (branch && relative === 'lib/compat-autopatch.js' && !/win32|darwin/.test(line)) forbidden.push(`${relative}:${index + 1} unexpected platform branch`)
    })
  }
  assert.deepEqual(forbidden, [], 'use pathToFileURL()/node:path instead of hand-built file URLs and inline platform branches')
})

test('static: package.json entry points and shipped files exist with the exact case', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  const required = [pkg.main, ...Object.values(pkg.exports ?? {}).filter((value) => typeof value === 'string')]
  for (const entry of required) {
    if (entry.includes('*')) continue // pattern exports (locale/*.json) are checked below
    assert.ok(exactCaseExists(path.resolve(REPO_ROOT, entry)), `package.json entry must exist exactly: ${entry}`)
  }
  for (const entry of pkg.files ?? []) {
    if (entry.includes('*')) {
      const [dirPart, pattern] = entry.split('/')
      const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      const directory = path.join(REPO_ROOT, dirPart)
      assert.ok(fs.existsSync(directory), `shipped directory must exist exactly: ${dirPart}`)
      assert.ok(fs.readdirSync(directory).some((name) => regex.test(name)), `shipped pattern must match a file: ${entry}`)
      continue
    }
    assert.ok(exactCaseExists(path.resolve(REPO_ROOT, entry)), `package.json files entry must exist exactly: ${entry}`)
  }
})

// ---------------------------------------------------------------------------
// 2. `~` expansion
// ---------------------------------------------------------------------------

test('paths: expandHomePath expands a leading ~ for every accepted spelling', () => {
  assert.equal(expandHomePath('relative/dir'), 'relative/dir')
  assert.equal(expandHomePath('/abs/dir'), '/abs/dir')
  assert.equal(expandHomePath('~user/dir'), '~user/dir', 'shell-user expansion is not ours')
  assert.equal(expandHomePath('~user'), '~user')
  assert.equal(expandHomePath(''), '')
  assert.equal(expandHomePath(undefined), undefined)
  assert.equal(expandHomePath(42), 42)
  assert.equal(expandHomePath('~', { homeDir: '/home/u', pathImpl: path.posix }), '/home/u')
  assert.equal(expandHomePath('~/a/b', { homeDir: '/home/u', pathImpl: path.posix }), '/home/u/a/b')
  assert.equal(
    expandHomePath('~\\a\\b', { homeDir: 'C:\\Users\\u', pathImpl: path.win32 }),
    path.win32.join('C:\\Users\\u', 'a', 'b'),
  )
  // A Windows-style `~\…` written on one OS still resolves on the other.
  assert.equal(expandHomePath('~\\Pictures', { homeDir: '/home/u', pathImpl: path.posix }), '/home/u/Pictures')
  assert.equal(isHomeRelativePath('~'), true)
  assert.equal(isHomeRelativePath('~/x'), true)
  assert.equal(isHomeRelativePath('~\\x'), true)
  assert.equal(isHomeRelativePath('~user/x'), false)
  assert.equal(isHomeRelativePath('/x'), false)
  assert.equal(isHomeRelativePath(undefined), false)
})

test('paths: ConfigStore resolves storage.dir portable forms (~ / absolute / relative)', () => {
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-paths-config-'))
  try {
    const write = (storage) => fs.writeFileSync(path.join(pluginDir, 'config.json'), JSON.stringify({ storage }), 'utf8')
    write({ dir: 'memory' })
    assert.equal(new ConfigStore(pluginDir).get().memoryDir, path.join(pluginDir, 'memory'), 'relative dirs stay plugin-relative')
    write({ dir: path.join(pluginDir, 'absolute-memory') })
    assert.equal(new ConfigStore(pluginDir).get().memoryDir, path.join(pluginDir, 'absolute-memory'), 'absolute dirs are kept')
    write({ dir: '~/rofm-portable-memory-dir' })
    assert.equal(new ConfigStore(pluginDir).get().memoryDir, path.join(os.homedir(), 'rofm-portable-memory-dir'), '~ expands to the home dir')
    write({})
    assert.equal(new ConfigStore(pluginDir).get().memoryDir, path.join(pluginDir, 'memory'), 'missing dir falls back to memory/')
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('paths: compat.mediaRoots expands ~ but leaves ~user alone', () => {
  const { compat, warnings } = normalizeCompatConfig({ mediaRoots: ['~/Pictures/QQ', '~user/x', 'C:/media', '/srv/media'] })
  assert.deepEqual(warnings, [])
  assert.equal(compat.mediaRoots[0], path.join(os.homedir(), 'Pictures', 'QQ'))
  assert.ok(compat.mediaRoots[1].includes('~user'), '~user must not be rewritten to the home dir')
  // `C:/media` is absolute on Windows only. On POSIX it is a plain relative path,
  // so the adapter must resolve it against the process cwd instead of treating it
  // as absolute — the old assertion hard-coded Windows semantics and made the
  // whole engine suite red on the UTC Linux/macOS CI runners.
  const driveRoot = process.platform === 'win32' ? 'C:/media' : path.resolve('C:/media')
  assert.equal(compat.mediaRoots[2], driveRoot)
  // A POSIX-absolute root is absolute (and therefore kept verbatim) everywhere.
  assert.equal(compat.mediaRoots[3], '/srv/media')
})

// ---------------------------------------------------------------------------
// 3. path-rule simulation: POSIX / Windows / macOS containment
// ---------------------------------------------------------------------------

/**
 * Fake `node:fs` for `validateMediaPath`: exact lookup, `ENOENT` otherwise.
 * @param {Record<string, string>} realPaths candidate → realpath
 * @param {number} [size]
 */
function fakeFs(realPaths, size = 2048) {
  return {
    realpathSync(value) {
      const hit = realPaths[String(value)]
      if (typeof hit !== 'string') {
        const error = new Error(`ENOENT: ${value}`)
        error.code = 'ENOENT'
        throw error
      }
      return hit
    },
    statSync() {
      return { isFile: () => true, size }
    },
  }
}

test('portability: POSIX (Linux) media-root containment rules', () => {
  const pathImpl = path.posix
  const platform = 'linux'
  const ok = validateMediaPath('/srv/media/photo.png', {
    mediaRoots: ['/srv/media'],
    platform,
    pathImpl,
    fsImpl: fakeFs({ '/srv/media': '/srv/media', '/srv/media/photo.png': '/srv/media/photo.png' }),
  })
  assert.equal(ok.ok, true, `nested POSIX path must be accepted: ${ok.reason ?? ''}`)
  const nested = validateMediaPath('/srv/media/sub/a.jpg', {
    mediaRoots: ['/srv/media'],
    platform,
    pathImpl,
    fsImpl: fakeFs({ '/srv/media': '/srv/media', '/srv/media/sub/a.jpg': '/srv/media/sub/a.jpg' }),
  })
  assert.equal(nested.ok, true)
  const outside = validateMediaPath('/srv/other/a.png', {
    mediaRoots: ['/srv/media'],
    platform,
    pathImpl,
    fsImpl: fakeFs({ '/srv/media': '/srv/media', '/srv/other/a.png': '/srv/other/a.png' }),
  })
  assert.equal(outside.ok, false)
  assert.equal(outside.reason, 'outside-media-roots')
  const escape = validateMediaPath('/srv/media/../secret.png', {
    mediaRoots: ['/srv/media'],
    platform,
    pathImpl,
    fsImpl: fakeFs({ '/srv/media': '/srv/media', '/srv/media/../secret.png': '/srv/secret.png' }),
  })
  assert.equal(escape.ok, false, '.. escape must be rejected after realpath')
  const caseDiff = validateMediaPath('/srv/media/A.png', {
    mediaRoots: ['/srv/Media'],
    platform,
    pathImpl,
    fsImpl: fakeFs({ '/srv/Media': '/srv/Media', '/srv/media/A.png': '/srv/media/A.png' }),
  })
  assert.equal(caseDiff.ok, false, 'Linux is case-sensitive: a differently-cased root is another directory')
})

test('portability: macOS realpath case canonicalisation keeps containment working', () => {
  // macOS APFS is case-insensitive but realpathSync returns the on-disk spelling,
  // so both sides compare equal even when the user typed a different case.
  const ok = validateMediaPath('/Users/x/photos/a.png', {
    mediaRoots: ['/Users/x/Photos'],
    platform: 'darwin',
    pathImpl: path.posix,
    fsImpl: fakeFs({
      '/Users/x/Photos': '/Users/x/Photos',
      '/Users/x/photos/a.png': '/Users/x/Photos/a.png',
    }),
  })
  assert.equal(ok.ok, true, 'realpath-canonicalised casing must stay inside the root')
  assert.equal(ok.realPath, '/Users/x/Photos/a.png')
})

test('portability: Windows media-root containment rules are case/separator insensitive', () => {
  const pathImpl = path.win32
  const platform = 'win32'
  const ok = validateMediaPath('C:/Media/A.PNG', {
    mediaRoots: ['C:\\Media'],
    platform,
    pathImpl,
    fsImpl: fakeFs({ 'C:\\Media': 'C:\\Media', 'C:/Media/A.PNG': 'C:\\Media\\A.PNG' }),
  })
  assert.equal(ok.ok, true, `Windows separators/case must compare equal: ${ok.reason ?? ''}`)
  const folder = validateMediaPath('c:\\media\\sub\\b.png', {
    mediaRoots: ['C:\\Media'],
    platform,
    pathImpl,
    fsImpl: fakeFs({ 'C:\\Media': 'C:\\Media', 'c:\\media\\sub\\b.png': 'C:\\Media\\sub\\b.png' }),
  })
  assert.equal(folder.ok, true)
  const drive = validateMediaPath('D:\\Media\\a.png', {
    mediaRoots: ['C:\\Media'],
    platform,
    pathImpl,
    fsImpl: fakeFs({ 'C:\\Media': 'C:\\Media', 'D:\\Media\\a.png': 'D:\\Media\\a.png' }),
  })
  assert.equal(drive.ok, false, 'a different drive is never inside the root')
  assert.equal(drive.reason, 'outside-media-roots')
  const escape = validateMediaPath('C:\\Media\\..\\evil.png', {
    mediaRoots: ['C:\\Media'],
    platform,
    pathImpl,
    fsImpl: fakeFs({ 'C:\\Media': 'C:\\Media', 'C:\\Media\\..\\evil.png': 'C:\\evil.png' }),
  })
  assert.equal(escape.ok, false, '.. escape must be rejected after realpath')
})

// ---------------------------------------------------------------------------
// 4. real filesystem behaviour (macOS/Linux style paths)
// ---------------------------------------------------------------------------

/** Create a directory symlink/junction; returns false when the OS forbids it. */
function makeDirLink(target, linkPath) {
  const attempts = ['junction', 'dir']
  for (const type of attempts) {
    try {
      fs.symlinkSync(target, linkPath, type)
      return true
    } catch {
      /* try the next flavour */
    }
  }
  return false
}

/** Assert a UTF-8 file was written with LF only (POSIX hosts and Node expect LF). */
function assertLfOnly(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  assert.equal(text.includes('\r'), false, `${filePath} must be written with LF line endings`)
}

test('portability: a memory dir reached through a symlink/junction works end to end', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-portable-link-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const realDir = path.join(tmp, 'real-memory')
  fs.mkdirSync(realDir, { recursive: true })
  const linkedDir = path.join(tmp, 'linked-memory')
  if (!makeDirLink(realDir, linkedDir)) {
    t.skip('this user cannot create directory symlinks/junctions')
    return
  }

  // images.js goes through the link and lands in the real directory
  ensureImageFolder(linkedDir)
  saveImageFile(linkedDir, 'a.png', Buffer.from([1, 2, 3]))
  assert.deepEqual(loadImageFile(linkedDir, 'a.png'), Buffer.from([1, 2, 3]))
  assert.equal(listImageFiles(linkedDir).length, 1)
  assert.equal(imageFileInfo(linkedDir, 'a.png').exists, true)
  assert.ok(fs.existsSync(path.join(realDir, 'images', 'a.png')), 'image bytes must land in the real directory')

  // engine store goes through the link as well
  const cfg = mergeConfigFile({})
  ensureMemoryDir(linkedDir)
  const folderId = 'mem-20260101T000000Z-0001'
  writeFolder(linkedDir, {
    id: folderId,
    meta: { createdAt: 1, alpha: 0.5, beta: 0, keywords: ['a', 'b', 'c'], scored: true, title: 't' },
    messages: [{ role: 'user', content: '透过符号链接写入' }],
  })
  assert.ok(fs.existsSync(path.join(realDir, folderId, 'meta.json')), 'folders must land in the real directory')
  assert.equal(readFolder(linkedDir, folderId).messages[0].content, '透过符号链接写入')
  assert.equal(appendStats(linkedDir, cfg, { type: 'portable' }), true)
  assert.equal(readStats(linkedDir, cfg).length, 1)
  assertLfOnly(path.join(realDir, 'stats.jsonl'))
  assertLfOnly(path.join(realDir, folderId, 'meta.json'))

  // qq-media staging (realpath containment) works through a symlinked memory root
  const mediaRoot = path.join(tmp, 'incoming')
  fs.mkdirSync(mediaRoot, { recursive: true })
  const mediaFile = path.join(mediaRoot, 'pic.png')
  fs.writeFileSync(mediaFile, Buffer.from([9, 9, 9]))
  const staged = stageMessageMedia({
    memoryDir: linkedDir,
    messageId: 'msg-1',
    text: `[图片:${mediaFile}]`,
    mediaRoots: [mediaRoot],
  })
  assert.equal(staged.staged.length, 1, `staging through a symlinked memory dir: ${JSON.stringify(staged.reasons ?? [])}`)
  assert.ok(fs.existsSync(path.join(realDir, '.staging')), 'staging must land in the real directory')
  assertLfOnly(path.join(realDir, '.staging', 'msg-1', 'index.json'))
  assert.equal(takeStagedMedia(linkedDir, 'msg-1').length, 1)
})

test('portability: spaces, CJK and # in paths work for config, images and the engine', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-portable-chars-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const pluginDir = path.join(tmp, '插件 目录 #1')
  fs.mkdirSync(pluginDir, { recursive: true })
  const memoryDir = path.join(pluginDir, '记忆 根 #2')
  fs.writeFileSync(path.join(pluginDir, 'config.json'), JSON.stringify({ storage: { dir: '记忆 根 #2' } }), 'utf8')

  const cfg = new ConfigStore(pluginDir).get()
  assert.equal(cfg.memoryDir, memoryDir, 'a relative CJK/space/# memory dir must resolve verbatim')

  ensureImageFolder(memoryDir)
  saveImageFile(memoryDir, 'b.png', Buffer.from([4, 5]))
  assert.deepEqual(loadImageFile(memoryDir, 'b.png'), Buffer.from([4, 5]))
  upsertImageIndexEntries(memoryDir, [{ name: 'b.png', folderId: 'mem-20260101T000000Z-0002', mediaType: 'image/png' }])

  const folderId = 'mem-20260101T000000Z-0002'
  writeFolder(memoryDir, {
    id: folderId,
    meta: { createdAt: 1, alpha: 0.5, beta: 0, keywords: ['a', 'b', 'c'], scored: true, title: 't' },
    messages: [{ role: 'user', content: '路径里带空格和 #' }],
  })
  assert.equal(readFolder(memoryDir, folderId).messages[0].content, '路径里带空格和 #')
  assertLfOnly(path.join(memoryDir, folderId, 'context.json'))
  assertLfOnly(path.join(memoryDir, folderId, 'meta.json'))
  assertLfOnly(path.join(memoryDir, 'images', 'index.json'))
})
