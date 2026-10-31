/**
 * lib/qq-media.js tests — onebot local-media parsing, validation and staging
 * (compat plan D12).
 *
 * Pure-module coverage: text path extraction (Windows `\`/`/`, Unix, quotes,
 * CJK names, spaces, dedupe, false positives), realpath/media-root/size/type
 * validation (including `..` and symlink escapes), staging copy + `index.json`,
 * listing/taking/cleanup and the never-throw contract.
 *
 * Every test builds its own temporary tree under `os.tmpdir()` and all of it is
 * removed in `after()`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  MEDIA_EXTENSIONS,
  cleanupStaging,
  listStagedMedia,
  parseMediaPaths,
  stageMessageMedia,
  takeStagedMedia,
  validateMediaPath,
} from '../lib/qq-media.js'

const isWindows = process.platform === 'win32'

const tempDirs = []
function tempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-qq-media-'))
  tempDirs.push(directory)
  return directory
}

after(() => {
  for (const directory of tempDirs) {
    try {
      fs.rmSync(directory, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

/** Build one reusable media tree: root/{a.png,b.jpg,big.png,folder.png,note.txt}, outside/c.png. */
function mediaFixture() {
  const base = tempDir()
  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  const pngPath = path.join(root, 'a.png')
  const jpegPath = path.join(root, 'b.jpg')
  const bigPath = path.join(root, 'big.png')
  const outsidePath = path.join(outside, 'c.png')
  fs.writeFileSync(pngPath, PNG_BYTES)
  fs.writeFileSync(jpegPath, JPEG_BYTES)
  fs.writeFileSync(bigPath, Buffer.alloc(64, 0xab))
  fs.writeFileSync(outsidePath, PNG_BYTES)
  fs.mkdirSync(path.join(root, 'folder.png'))
  fs.writeFileSync(path.join(root, 'note.txt'), 'not an image')
  return { base, root, outside, pngPath, jpegPath, bigPath, outsidePath }
}

/** Try to create a symlink; returns false when the OS/user forbids it. */
function trySymlink(target, linkPath, type = 'file') {
  try {
    fs.symlinkSync(target, linkPath, type)
    return true
  } catch {
    return false
  }
}

/** Add a file with a fixed extension under one directory. */
function writeMedia(directory, name, bytes = PNG_BYTES) {
  const filePath = path.join(directory, name)
  fs.writeFileSync(filePath, bytes)
  return filePath
}

/** Read one staged `index.json`. */
function readStagingIndex(memoryDir, messageId) {
  return JSON.parse(fs.readFileSync(path.join(memoryDir, '.staging', messageId, 'index.json'), 'utf8'))
}

// ---------------------------------------------------------------------------
// parseMediaPaths
// ---------------------------------------------------------------------------

test('MEDIA_EXTENSIONS is the frozen image whitelist', () => {
  assert.deepEqual([...MEDIA_EXTENSIONS], ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
  assert.ok(Object.isFrozen(MEDIA_EXTENSIONS))
})

test('parseMediaPaths extracts a Windows drive path from a onebot annotation', () => {
  const filePath = String.raw`C:\Users\蒲公英\AppData\Roaming\media\onebot\media_1730000000_ab12cd34.jpg`
  const text = `<user_message qq="10001" nickname="小明">[图片:${filePath}] 看看这张图</user_message>`
  assert.deepEqual(parseMediaPaths(text), [filePath])
})

test('parseMediaPaths accepts Windows forward-slash drive paths', () => {
  assert.deepEqual(parseMediaPaths('图片 [图片:C:/Users/xx/media/a.png]'), ['C:/Users/xx/media/a.png'])
})

test('parseMediaPaths accepts Unix absolute paths', () => {
  const text = '[图片:/home/user/pics/cat.png] and /var/tmp/img/dog.webp'
  assert.deepEqual(parseMediaPaths(text), ['/home/user/pics/cat.png', '/var/tmp/img/dog.webp'])
})

test('parseMediaPaths unwraps quotes, parentheses, full-width brackets and angle brackets', () => {
  assert.deepEqual(parseMediaPaths('"C:\\pics\\a.png"'), [String.raw`C:\pics\a.png`])
  assert.deepEqual(parseMediaPaths("'/unix/b.jpg'"), ['/unix/b.jpg'])
  assert.deepEqual(parseMediaPaths('（/home/u/c.gif）'), ['/home/u/c.gif'])
  assert.deepEqual(parseMediaPaths('【C:\\d\\e.webp】'), [String.raw`C:\d\e.webp`])
  assert.deepEqual(parseMediaPaths('「/opt/f.bmp」'), ['/opt/f.bmp'])
  assert.deepEqual(parseMediaPaths('[图片:/srv/g.webp]'), ['/srv/g.webp'])
})

test('parseMediaPaths keeps spaces inside paths and preserves appearance order', () => {
  const first = String.raw`C:\Program Files\QQ\media\media_1.jpg`
  const second = '/home/user/my pics/第二张.png'
  const text = `甲[图片:${first}] 乙[图片:${second}]`
  assert.deepEqual(parseMediaPaths(text), [first, second])
})

test('parseMediaPaths does not split a dotted directory name into an extension', () => {
  assert.deepEqual(parseMediaPaths(String.raw`[图片:C:\imgs.png\photo.jpg]`), [String.raw`C:\imgs.png\photo.jpg`])
})

test('parseMediaPaths de-duplicates exact and Windows separator/case variants', () => {
  const p1 = String.raw`C:\dir\dup.png`
  const p2 = 'C:/dir/dup.png'
  const p3 = String.raw`C:\DIR\dup.PNG`
  assert.deepEqual(parseMediaPaths(`${p1} ${p1} ${p2} ${p3}`), [p1])
  assert.deepEqual(parseMediaPaths('/unix/same.png /unix/same.png'), ['/unix/same.png'])
})

test('parseMediaPaths accepts every whitelisted extension (case-insensitive)', () => {
  for (const extension of MEDIA_EXTENSIONS) {
    const lower = `C:\\media\\file${extension}`
    const upper = `C:\\media\\file${extension.toUpperCase()}`
    assert.deepEqual(parseMediaPaths(`[图片:${lower}]`), [lower])
    assert.deepEqual(parseMediaPaths(`[图片:${upper}]`), [upper])
  }
})

test('parseMediaPaths ignores URLs, relative paths, markers and non-image files', () => {
  const text = [
    'https://example.com/pic.png',
    'http://127.0.0.1:53678/api/1.png',
    'http://host//double.png',
    'relative/path/photo.png',
    './local/a.jpg',
    String.raw`C:\tmp\not-image.txt`,
    String.raw`D:\media\clip.mp4`,
    '[图片] [语音] [视频:/x/y.mp4]',
    '版本 1.2.3 / 2.0.1',
    'foo.png',
  ].join(' ')
  assert.deepEqual(parseMediaPaths(text), [])
})

test('parseMediaPaths returns [] for non-string input and never throws', () => {
  for (const value of [undefined, null, 0, 42, [], {}, true, () => {}]) {
    assert.deepEqual(parseMediaPaths(value), [])
    assert.deepEqual(parseMediaPaths(value, { unexpected: true }), [])
  }
  assert.deepEqual(parseMediaPaths(''), [])
})

// ---------------------------------------------------------------------------
// validateMediaPath
// ---------------------------------------------------------------------------

test('validateMediaPath accepts a regular image under a media root', () => {
  const { root, pngPath } = mediaFixture()
  const result = validateMediaPath(pngPath, { mediaRoots: [root] })
  assert.equal(result.ok, true)
  assert.equal(result.realPath, fs.realpathSync(pngPath))
  assert.equal(result.ext, '.png')
  assert.equal(result.bytes, PNG_BYTES.byteLength)
  assert.equal(result.reason, undefined)
})

test('validateMediaPath strips wrapping quotes from a caller-supplied candidate', () => {
  const { root, pngPath } = mediaFixture()
  assert.equal(validateMediaPath(`"${pngPath}"`, { mediaRoots: [root] }).ok, true)
  assert.equal(validateMediaPath(`[${pngPath}]`, { mediaRoots: [root] }).ok, true)
})

test('validateMediaPath accepts forward-slash separators on Windows', { skip: !isWindows }, () => {
  const { root, pngPath } = mediaFixture()
  const forward = pngPath.replace(/\\/g, '/')
  const result = validateMediaPath(forward, { mediaRoots: [root] })
  assert.equal(result.ok, true)
  assert.equal(result.ext, '.png')
})

test('validateMediaPath compares media roots case-insensitively on Windows', { skip: !isWindows }, () => {
  const { root, pngPath } = mediaFixture()
  assert.equal(validateMediaPath(pngPath, { mediaRoots: [root.toUpperCase()] }).ok, true)
})

test('validateMediaPath rejects a file outside every media root', () => {
  const { root, outsidePath } = mediaFixture()
  const result = validateMediaPath(outsidePath, { mediaRoots: [root] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'outside-media-roots')
})

test('validateMediaPath rejects a .. escape out of the media root', () => {
  const { root, outsidePath } = mediaFixture()
  const escaped = path.join(root, '..', 'outside', 'c.png')
  // Sanity: the string really reaches the outside file once resolved.
  assert.equal(fs.realpathSync(escaped), fs.realpathSync(outsidePath))
  const result = validateMediaPath(escaped, { mediaRoots: [root] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'outside-media-roots')
})

test('validateMediaPath follows symlinks: outside link rejected, inside link accepted', (t) => {
  const { root, outsidePath, pngPath } = mediaFixture()
  const escapeLink = path.join(root, 'escape.png')
  const insideLink = path.join(root, 'inside-link.png')
  if (!trySymlink(outsidePath, escapeLink) || !trySymlink(pngPath, insideLink)) {
    t.skip('symlinks are not available for this user')
    return
  }
  const escaped = validateMediaPath(escapeLink, { mediaRoots: [root] })
  assert.equal(escaped.ok, false)
  assert.equal(escaped.reason, 'outside-media-roots')
  const inside = validateMediaPath(insideLink, { mediaRoots: [root] })
  assert.equal(inside.ok, true)
  assert.equal(inside.realPath, fs.realpathSync(pngPath))
})

test('validateMediaPath rejects directories even with an image extension', () => {
  const { root } = mediaFixture()
  const result = validateMediaPath(path.join(root, 'folder.png'), { mediaRoots: [root] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-a-file')
})

test('validateMediaPath reports missing files as not-found', () => {
  const { root } = mediaFixture()
  assert.deepEqual(validateMediaPath(path.join(root, 'missing.png'), { mediaRoots: [root] }), {
    ok: false,
    reason: 'not-found',
  })
})

test('validateMediaPath enforces maxBytes (reject larger, accept equal)', () => {
  const { root, bigPath } = mediaFixture()
  const tooLarge = validateMediaPath(bigPath, { mediaRoots: [root], maxBytes: 16 })
  assert.equal(tooLarge.ok, false)
  assert.equal(tooLarge.reason, 'too-large')
  assert.equal(tooLarge.bytes, 64)
  const exactPath = writeMedia(root, 'exact.png', Buffer.alloc(16, 0xcd))
  assert.equal(validateMediaPath(exactPath, { mediaRoots: [root], maxBytes: 16 }).ok, true)
})

test('validateMediaPath rejects extensions outside the whitelist', () => {
  const { root } = mediaFixture()
  const result = validateMediaPath(path.join(root, 'note.txt'), { mediaRoots: [root] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'extension-not-allowed')
  assert.equal(result.ext, '.txt')
})

test('validateMediaPath rejects everything when mediaRoots is empty', () => {
  const { pngPath } = mediaFixture()
  for (const mediaRoots of [[], undefined, null, '', '   ', 42]) {
    const result = validateMediaPath(pngPath, { mediaRoots })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no-media-roots')
  }
})

test('validateMediaPath rejects relative/non-string candidates as invalid-candidate', () => {
  const { root } = mediaFixture()
  for (const candidate of [undefined, null, 0, {}, [], '', '   ', 'relative/a.png', './a.png', 'C:relative/a.png']) {
    const result = validateMediaPath(candidate, { mediaRoots: [root] })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid-candidate')
  }
})

test('validateMediaPath tolerates a missing root as long as one root contains the file', () => {
  const { root, base, pngPath } = mediaFixture()
  const missingRoot = path.join(base, 'does-not-exist')
  assert.equal(validateMediaPath(pngPath, { mediaRoots: [missingRoot, root] }).ok, true)
  assert.equal(validateMediaPath(pngPath, { mediaRoots: [missingRoot] }).ok, false)
})

test('validateMediaPath honors an injected fsImpl (no real files needed)', () => {
  const fakeFs = {
    realpathSync(target) {
      if (target === '/fake/root' || String(target).endsWith('cat.png')) return target
      const error = new Error('missing')
      error.code = 'ENOENT'
      throw error
    },
    statSync() {
      return { isFile: () => true, size: 12 }
    },
  }
  const result = validateMediaPath('/fake/root/cat.png', { mediaRoots: ['/fake/root'], fsImpl: fakeFs })
  assert.equal(result.ok, true)
  assert.equal(result.realPath, '/fake/root/cat.png')
  assert.equal(result.ext, '.png')
  assert.equal(result.bytes, 12)
})

test('validateMediaPath never throws for garbage options or candidates', () => {
  const { pngPath } = mediaFixture()
  const results = [
    validateMediaPath(pngPath),
    validateMediaPath(pngPath, null),
    validateMediaPath(pngPath, 'not-an-object'),
    validateMediaPath(pngPath, { mediaRoots: 42, maxBytes: 'huge', fsImpl: 'nope' }),
    validateMediaPath({ toString: () => { throw new Error('boom') } }, { mediaRoots: [] }),
    validateMediaPath(Symbol('x'), { mediaRoots: [] }),
  ]
  for (const result of results) assert.equal(result.ok, false)
})

// ---------------------------------------------------------------------------
// stageMessageMedia
// ---------------------------------------------------------------------------

test('stageMessageMedia copies validated images into .staging/<messageId>/', () => {
  const { root, pngPath, jpegPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  const text = `<user_message qq="42" nickname="nick">[图片:${pngPath}] 还有 [图片:${jpegPath}]</user_message>`
  const result = stageMessageMedia({ memoryDir, messageId: 'msg-1', text, mediaRoots: [root] })
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.reasons, [])
  assert.equal(result.staged.length, 2)
  assert.deepEqual(
    result.staged.map((entry) => ({ name: entry.name, mediaType: entry.mediaType, bytes: entry.bytes })),
    [
      { name: '1.png', mediaType: 'image/png', bytes: PNG_BYTES.byteLength },
      { name: '2.jpg', mediaType: 'image/jpeg', bytes: JPEG_BYTES.byteLength },
    ],
  )
  const stagingDir = path.join(memoryDir, '.staging', 'msg-1')
  for (const [index, entry] of result.staged.entries()) {
    assert.equal(entry.path, path.join(stagingDir, entry.name))
    assert.ok(entry.path.startsWith(path.join(memoryDir, '.staging') + path.sep))
    assert.equal(fs.existsSync(entry.path), true)
    const source = index === 0 ? PNG_BYTES : JPEG_BYTES
    assert.deepEqual(fs.readFileSync(entry.path), source)
  }
})

test('stageMessageMedia writes a complete index.json', () => {
  const { root, pngPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  stageMessageMedia({ memoryDir, messageId: 'msg-index', text: `[图片:${pngPath}]`, mediaRoots: [root] })
  const index = readStagingIndex(memoryDir, 'msg-index')
  assert.equal(index.version, 1)
  assert.equal(index.messageId, 'msg-index')
  assert.ok(Number.isFinite(index.createdAt) && index.createdAt > 0 && index.createdAt <= Date.now())
  assert.equal(index.files.length, 1)
  assert.equal(index.files[0].name, '1.png')
  assert.equal(index.files[0].mediaType, 'image/png')
  assert.equal(index.files[0].bytes, PNG_BYTES.byteLength)
  assert.equal(index.files[0].path, path.join(memoryDir, '.staging', 'msg-index', '1.png'))
})

test('stageMessageMedia counts rejected candidates and reports reasons', () => {
  const { root, outsidePath, bigPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  const text = `[图片:${outsidePath}] [图片:${bigPath}] [图片:/definitely/not/a/file.png]`
  const result = stageMessageMedia({ memoryDir, messageId: 'msg-skip', text, mediaRoots: [root], maxBytes: 16 })
  assert.deepEqual(result.staged, [])
  assert.equal(result.skipped, 3)
  assert.equal(result.reasons.length, 3)
  assert.ok(result.reasons.some((reason) => reason.startsWith('outside-media-roots:')))
  assert.ok(result.reasons.some((reason) => reason.startsWith('too-large:')))
  assert.ok(result.reasons.some((reason) => reason.startsWith('not-found:')))
  assert.equal(fs.existsSync(path.join(memoryDir, '.staging')), false)
})

test('stageMessageMedia stages only the valid candidates of a mixed message', () => {
  const { root, pngPath, outsidePath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  const result = stageMessageMedia({
    memoryDir,
    messageId: 'msg-mixed',
    text: `[图片:${outsidePath}] [图片:${pngPath}]`,
    mediaRoots: [root],
  })
  assert.equal(result.staged.length, 1)
  assert.equal(result.staged[0].name, '1.png')
  assert.equal(result.skipped, 1)
})

test('stageMessageMedia refuses to stage when mediaRoots is empty', () => {
  const { pngPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  const result = stageMessageMedia({ memoryDir, messageId: 'msg-noroot', text: `[图片:${pngPath}]` })
  assert.deepEqual(result.staged, [])
  assert.equal(result.skipped, 1)
  assert.ok(result.reasons[0].startsWith('no-media-roots'))
})

test('stageMessageMedia rebuilds an existing staging directory for the same message id', () => {
  const { root, pngPath, jpegPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  stageMessageMedia({
    memoryDir,
    messageId: 'msg-rebuild',
    text: `[图片:${pngPath}] [图片:${jpegPath}]`,
    mediaRoots: [root],
  })
  assert.deepEqual(fs.readdirSync(path.join(memoryDir, '.staging', 'msg-rebuild')).sort(), ['1.png', '2.jpg', 'index.json'])
  const rebuilt = stageMessageMedia({ memoryDir, messageId: 'msg-rebuild', text: `[图片:${pngPath}]`, mediaRoots: [root] })
  assert.equal(rebuilt.staged.length, 1)
  assert.deepEqual(fs.readdirSync(path.join(memoryDir, '.staging', 'msg-rebuild')).sort(), ['1.png', 'index.json'])
  assert.equal(readStagingIndex(memoryDir, 'msg-rebuild').files.length, 1)
})

test('stageMessageMedia keeps different message ids in separate staging directories', () => {
  const { root, pngPath, jpegPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  stageMessageMedia({ memoryDir, messageId: 'chat-a', text: `[图片:${pngPath}]`, mediaRoots: [root] })
  stageMessageMedia({ memoryDir, messageId: 'chat-b', text: `[图片:${jpegPath}]`, mediaRoots: [root] })
  const listed = listStagedMedia(memoryDir, ['chat-a', 'chat-b'])
  assert.equal(listed.size, 2)
  assert.equal(listed.get('chat-a')[0].name, '1.png')
  assert.equal(listed.get('chat-b')[0].name, '1.jpg')
})

test('stageMessageMedia de-duplicates a repeated path into one staged file', () => {
  const { root, pngPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  const result = stageMessageMedia({
    memoryDir,
    messageId: 'msg-dupe',
    text: `[图片:${pngPath}] 同一张 [图片:${pngPath}]`,
    mediaRoots: [root],
  })
  assert.equal(result.staged.length, 1)
  assert.equal(result.skipped, 0)
})

test('stageMessageMedia sanitizes unsafe message ids into one path segment', () => {
  const { root, pngPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  const result = stageMessageMedia({
    memoryDir,
    messageId: '../escape\\..',
    text: `[图片:${pngPath}]`,
    mediaRoots: [root],
  })
  assert.equal(result.staged.length, 1)
  assert.equal(result.skipped, 0)
  const stagingRoot = path.join(memoryDir, '.staging')
  const directories = fs.readdirSync(stagingRoot)
  assert.equal(directories.length, 1)
  assert.ok(!directories[0].includes('..'))
  assert.ok(!directories[0].includes('/') && !directories[0].includes('\\'))
  assert.ok(result.staged[0].path.startsWith(stagingRoot + path.sep))
  // index.json keeps the original id for auditing
  assert.equal(readStagingIndex(memoryDir, directories[0]).messageId, '../escape\\..')
  // the sanitizer is shared with list/take, so the same id finds the staged data again
  assert.equal(listStagedMedia(memoryDir, ['../escape\\..']).get('../escape\\..').length, 1)
  assert.equal(takeStagedMedia(memoryDir, '../escape\\..').length, 1)
})

test('stageMessageMedia maps a pathological message id to msg/', () => {
  const { root, pngPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  const result = stageMessageMedia({ memoryDir, messageId: '...', text: `[图片:${pngPath}]`, mediaRoots: [root] })
  assert.equal(result.staged.length, 1)
  assert.equal(result.staged[0].path, path.join(memoryDir, '.staging', 'msg', '1.png'))
})

test('stageMessageMedia degrades to an empty result for bad input and creates nothing', () => {
  const { root, pngPath } = mediaFixture()
  for (const options of [undefined, null, {}, { text: 42 }, { memoryDir: '', text: `[图片:${pngPath}]` }]) {
    const result = stageMessageMedia(options)
    assert.deepEqual(result.staged, [])
    assert.equal(result.skipped, 0)
    assert.deepEqual(result.reasons, ['invalid-memory-dir'])
  }
  const memoryDir = path.join(tempDir(), 'memory')
  assert.deepEqual(stageMessageMedia({ memoryDir, text: '[图片] [语音] no media here', mediaRoots: [root] }), {
    staged: [],
    skipped: 0,
    reasons: [],
  })
  assert.equal(fs.existsSync(path.join(memoryDir, '.staging')), false)
})

test('stageMessageMedia refuses a symlinked .staging root', (t) => {
  const { root, pngPath, base } = mediaFixture()
  const memoryDir = path.join(base, 'memory-linked')
  fs.mkdirSync(memoryDir)
  const outsideStaging = path.join(base, 'outside-staging')
  fs.mkdirSync(outsideStaging)
  if (!trySymlink(outsideStaging, path.join(memoryDir, '.staging'), 'dir')) {
    t.skip('directory symlinks are not available for this user')
    return
  }
  const result = stageMessageMedia({ memoryDir, messageId: 'msg-link', text: `[图片:${pngPath}]`, mediaRoots: [root] })
  assert.deepEqual(result.staged, [])
  assert.ok(result.reasons.includes('staging-root-symlink'))
  assert.deepEqual(fs.readdirSync(outsideStaging), [])
})

test('stageMessageMedia keeps working when the logger throws or is unusual', () => {
  const { root, pngPath, outsidePath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  const throwing = stageMessageMedia({
    memoryDir,
    messageId: 'msg-log',
    text: `[图片:${outsidePath}] [图片:${pngPath}]`,
    mediaRoots: [root],
    logger: () => {
      throw new Error('logger exploded')
    },
  })
  assert.equal(throwing.staged.length, 1)
  const calls = []
  const objectLogger = { warn: (message) => calls.push(['warn', message]), debug: (message) => calls.push(['debug', message]) }
  const objectResult = stageMessageMedia({
    memoryDir,
    messageId: 'msg-log-2',
    text: `[图片:${outsidePath}] [图片:${pngPath}]`,
    mediaRoots: [root],
    logger: objectLogger,
  })
  assert.equal(objectResult.staged.length, 1)
  assert.ok(calls.length >= 1)
  assert.equal(stageMessageMedia({ memoryDir, messageId: 'msg-log-3', text: 42, logger: 'nope' }).staged.length, 0)
})

// ---------------------------------------------------------------------------
// listStagedMedia / takeStagedMedia
// ---------------------------------------------------------------------------

test('listStagedMedia reads several message ids without consuming them', () => {
  const { root, pngPath, jpegPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  stageMessageMedia({
    memoryDir,
    messageId: 'id-a',
    text: `[图片:${jpegPath}] [图片:${pngPath}]`,
    mediaRoots: [root],
  })
  stageMessageMedia({ memoryDir, messageId: 'id-b', text: `[图片:${pngPath}]`, mediaRoots: [root] })
  const listed = listStagedMedia(memoryDir, ['id-a', 'id-b', 'id-missing'])
  assert.deepEqual([...listed.keys()], ['id-a', 'id-b'])
  assert.deepEqual(listed.get('id-a').map((entry) => entry.name), ['1.jpg', '2.png'])
  assert.deepEqual(listed.get('id-b').map((entry) => entry.name), ['1.png'])
  assert.equal(listed.get('id-a')[0].mediaType, 'image/jpeg')
  assert.ok(Number.isInteger(listed.get('id-a')[0].bytes))
  // listing does not consume anything
  assert.equal(fs.existsSync(path.join(memoryDir, '.staging', 'id-a', '1.jpg')), true)
})

test('listStagedMedia accepts a single id and returns an empty map for bad input', () => {
  const { root, pngPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  stageMessageMedia({ memoryDir, messageId: 'solo', text: `[图片:${pngPath}]`, mediaRoots: [root] })
  assert.deepEqual([...listStagedMedia(memoryDir, 'solo').keys()], ['solo'])
  assert.equal(listStagedMedia(memoryDir, []).size, 0)
  assert.equal(listStagedMedia(undefined, ['solo']).size, 0)
  assert.equal(listStagedMedia('', ['solo']).size, 0)
  assert.equal(listStagedMedia(memoryDir, [42, null, {}]).size, 0)
})

test('listStagedMedia falls back to scanning when index.json is missing or corrupt', () => {
  const memoryDir = path.join(tempDir(), 'memory')
  const stagingRoot = path.join(memoryDir, '.staging')
  const brokenDir = path.join(stagingRoot, 'broken')
  fs.mkdirSync(brokenDir, { recursive: true })
  fs.writeFileSync(path.join(brokenDir, '1.png'), PNG_BYTES)
  fs.writeFileSync(path.join(brokenDir, 'index.json'), '{ this is not json')
  fs.writeFileSync(path.join(brokenDir, 'notes.txt'), 'ignored')
  const listed = listStagedMedia(memoryDir, ['broken'])
  assert.equal(listed.size, 1)
  const entries = listed.get('broken')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, '1.png')
  assert.equal(entries[0].mediaType, 'image/png')
  assert.equal(entries[0].bytes, PNG_BYTES.byteLength)
  assert.equal(entries[0].path, path.join(brokenDir, '1.png'))
  // no index at all → same fallback
  const bareDir = path.join(stagingRoot, 'bare')
  fs.mkdirSync(bareDir)
  fs.writeFileSync(path.join(bareDir, '3.webp'), PNG_BYTES)
  const bare = listStagedMedia(memoryDir, ['bare']).get('bare')
  assert.equal(bare.length, 1)
  assert.equal(bare[0].name, '3.webp')
})

test('takeStagedMedia returns the bytes, then removes the staging directory', () => {
  const { root, pngPath, jpegPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  stageMessageMedia({
    memoryDir,
    messageId: 'claim-me',
    text: `[图片:${pngPath}] [图片:${jpegPath}]`,
    mediaRoots: [root],
  })
  const taken = takeStagedMedia(memoryDir, 'claim-me')
  assert.equal(taken.length, 2)
  assert.deepEqual(taken.map((entry) => entry.name), ['1.png', '2.jpg'])
  assert.deepEqual(taken.map((entry) => entry.mediaType), ['image/png', 'image/jpeg'])
  assert.ok(Buffer.isBuffer(taken[0].data))
  assert.deepEqual(taken[0].data, PNG_BYTES)
  assert.deepEqual(taken[1].data, JPEG_BYTES)
  assert.equal(taken[0].bytes, PNG_BYTES.byteLength)
  assert.equal(fs.existsSync(path.join(memoryDir, '.staging', 'claim-me')), false)
  assert.deepEqual(takeStagedMedia(memoryDir, 'claim-me'), [])
  assert.equal(listStagedMedia(memoryDir, ['claim-me']).size, 0)
})

test('takeStagedMedia returns [] for unknown ids and bad input without throwing', () => {
  const memoryDir = path.join(tempDir(), 'memory')
  fs.mkdirSync(path.join(memoryDir, '.staging', 'empty'), { recursive: true })
  assert.deepEqual(takeStagedMedia(memoryDir, 'nope'), [])
  assert.deepEqual(takeStagedMedia(memoryDir, undefined), [])
  assert.deepEqual(takeStagedMedia(undefined, 'nope'), [])
  assert.deepEqual(takeStagedMedia(memoryDir, Symbol('x')), [])
  assert.deepEqual(takeStagedMedia(memoryDir, 'empty'), [])
  assert.equal(fs.existsSync(path.join(memoryDir, '.staging', 'empty')), false)
})

// ---------------------------------------------------------------------------
// cleanupStaging
// ---------------------------------------------------------------------------

test('cleanupStaging removes only staging directories older than ttlMs', () => {
  const { root, pngPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  const now = Date.now()
  stageMessageMedia({ memoryDir, messageId: 'old', text: `[图片:${pngPath}]`, mediaRoots: [root] })
  stageMessageMedia({ memoryDir, messageId: 'fresh', text: `[图片:${pngPath}]`, mediaRoots: [root] })
  const oldIndexPath = path.join(memoryDir, '.staging', 'old', 'index.json')
  const oldIndex = JSON.parse(fs.readFileSync(oldIndexPath, 'utf8'))
  oldIndex.createdAt = now - 60_000
  fs.writeFileSync(oldIndexPath, JSON.stringify(oldIndex))
  const freshIndexPath = path.join(memoryDir, '.staging', 'fresh', 'index.json')
  const freshIndex = JSON.parse(fs.readFileSync(freshIndexPath, 'utf8'))
  freshIndex.createdAt = now
  fs.writeFileSync(freshIndexPath, JSON.stringify(freshIndex))
  assert.equal(cleanupStaging({ memoryDir, ttlMs: 1000, now }), 1)
  assert.equal(fs.existsSync(path.join(memoryDir, '.staging', 'old')), false)
  assert.equal(fs.existsSync(path.join(memoryDir, '.staging', 'fresh')), true)
})

test('cleanupStaging uses the directory mtime when index.json is missing', () => {
  const memoryDir = path.join(tempDir(), 'memory')
  const stagingRoot = path.join(memoryDir, '.staging')
  const oldDir = path.join(stagingRoot, 'no-index-old')
  const newDir = path.join(stagingRoot, 'no-index-new')
  fs.mkdirSync(oldDir, { recursive: true })
  fs.mkdirSync(newDir, { recursive: true })
  fs.writeFileSync(path.join(oldDir, '1.png'), PNG_BYTES)
  const now = Date.now()
  const oldDate = new Date(now - 120_000)
  fs.utimesSync(oldDir, oldDate, oldDate)
  fs.writeFileSync(path.join(stagingRoot, 'stray.txt'), 'left over')
  const strayDate = new Date(now - 120_000)
  fs.utimesSync(path.join(stagingRoot, 'stray.txt'), strayDate, strayDate)
  assert.equal(cleanupStaging({ memoryDir, ttlMs: 60_000, now }), 2)
  assert.equal(fs.existsSync(oldDir), false)
  assert.equal(fs.existsSync(newDir), true)
  assert.equal(fs.existsSync(path.join(stagingRoot, 'stray.txt')), false)
})

test('cleanupStaging keeps entries exactly at the ttl boundary', () => {
  const { root, pngPath } = mediaFixture()
  const memoryDir = path.join(tempDir(), 'memory')
  const now = Date.now()
  stageMessageMedia({ memoryDir, messageId: 'boundary', text: `[图片:${pngPath}]`, mediaRoots: [root] })
  const indexPath = path.join(memoryDir, '.staging', 'boundary', 'index.json')
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  index.createdAt = now - 1000
  fs.writeFileSync(indexPath, JSON.stringify(index))
  assert.equal(cleanupStaging({ memoryDir, ttlMs: 1000, now }), 0)
  assert.equal(fs.existsSync(path.join(memoryDir, '.staging', 'boundary')), true)
})

test('cleanupStaging never throws and returns 0 for unusable input or empty staging', () => {
  for (const options of [undefined, null, {}, { memoryDir: '' }, { memoryDir: 42 }, { memoryDir: path.join(tempDir(), 'missing') }]) {
    assert.equal(cleanupStaging(options), 0)
  }
  const memoryDir = path.join(tempDir(), 'memory')
  fs.mkdirSync(path.join(memoryDir, '.staging'), { recursive: true })
  assert.equal(cleanupStaging({ memoryDir }), 0)
})
