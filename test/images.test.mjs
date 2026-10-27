/**
 * lib/images.js tests — image folder helpers (docs/SPEC.md §3, v1.2).
 *
 * Pure-module coverage: placeholder format/parse, content-block walk, image
 * file store/load/remove/list under a temp memory dir, metadata normalization
 * and the recall-side content-block interleaving.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { contentToText } from '../lib/message-text.js'
import {
  IMAGE_EXTENSIONS,
  contentToTextWithImages,
  ensureImageFolder,
  imageExtension,
  imageFilePath,
  imageFolderPath,
  imageFolderSummary,
  imagePlaceholder,
  interleaveImageBlocks,
  listImageFiles,
  loadImageFile,
  normalizeImageMeta,
  parseImagePlaceholders,
  removeImageFiles,
  sanitizeImageName,
  saveImageFile,
} from '../lib/images.js'

const tempDirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshr-images-'))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

const MEDIA_TYPE_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** One DSH image content block with sane defaults. */
function imageBlock(overrides = {}) {
  return {
    type: 'image',
    attachment: {
      attachmentId: 'sha256:default',
      mediaType: 'image/png',
      bytes: PNG_BYTES.length,
      width: 640,
      height: 480,
      ...overrides,
    },
  }
}

/** One valid `meta.images` entry. */
function imageMeta(name, overrides = {}) {
  return {
    name,
    placeholder: imagePlaceholder(name),
    mediaType: MEDIA_TYPE_BY_EXTENSION[path.extname(name).toLowerCase()] ?? 'image/png',
    width: 100,
    height: 80,
    bytes: 1000,
    attachmentId: `sha256:${name.replace(/[^A-Za-z0-9]/g, '')}`,
    ...overrides,
  }
}

/** Fake `ctx.attachments.saveImages` result for one name. */
function resolvedRef(name) {
  return { attachmentId: `sha256:${name}`, mediaType: 'image/png', bytes: 1, width: 2, height: 3, name }
}

/** Rebuild the original text from interleaved blocks (image → placeholder). */
function renderInterleaved(blocks) {
  return blocks
    .map((block) => (block.type === 'image' ? imagePlaceholder(block.attachment.name) : block.text))
    .join('')
}

// ---------------------------------------------------------------------------
// extensions + placeholder format
// ---------------------------------------------------------------------------

test('imageExtension maps supported media types and falls back to .png', () => {
  assert.equal(imageExtension('image/png'), '.png')
  assert.equal(imageExtension('image/jpeg'), '.jpg')
  assert.equal(imageExtension('image/webp'), '.webp')
  assert.equal(imageExtension('image/gif'), '.gif')
  assert.equal(imageExtension('IMAGE/JPEG'), '.jpg')
  assert.equal(imageExtension('image/avif'), '.png')
  assert.equal(imageExtension('text/plain'), '.png')
  assert.equal(imageExtension(undefined), '.png')
  assert.equal(imageExtension(null), '.png')
  assert.equal(IMAGE_EXTENSIONS['image/webp'], '.webp')
  assert.ok(Object.isFrozen(IMAGE_EXTENSIONS))
})

test('imagePlaceholder renders the fixed bracketed format', () => {
  assert.equal(imagePlaceholder('a.png'), '[图片：（a.png）]')
  assert.equal(imagePlaceholder('截图-2026.jpeg'), '[图片：（截图-2026.jpeg）]')
  assert.equal(imagePlaceholder(undefined), '[图片：（）]')
})

test('parseImagePlaceholders finds every placeholder with offsets', () => {
  const first = imagePlaceholder('a.png')
  const second = imagePlaceholder('截图 2026.png')
  const text = `前文 ${first} 中间 ${second} 结尾`
  const entries = parseImagePlaceholders(text)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((entry) => entry.name), ['a.png', '截图 2026.png'])
  assert.equal(entries[0].start, '前文 '.length)
  assert.equal(entries[0].end, entries[0].start + first.length)
  assert.equal(entries[1].start, entries[0].end + ' 中间 '.length)
  assert.equal(entries[1].end, entries[1].start + second.length)
  for (const entry of entries) assert.equal(text.slice(entry.start, entry.end), imagePlaceholder(entry.name))
})

test('parseImagePlaceholders handles adjacent and edge placeholders', () => {
  const first = imagePlaceholder('a.png')
  const second = imagePlaceholder('b.jpg')
  const adjacent = parseImagePlaceholders(`${first}${second}`)
  assert.deepEqual(
    adjacent.map((entry) => [entry.start, entry.end]),
    [[0, first.length], [first.length, first.length + second.length]],
  )
  assert.deepEqual(parseImagePlaceholders(second), [{ name: 'b.jpg', start: 0, end: second.length }])
})

test('parseImagePlaceholders ignores malformed placeholders', () => {
  assert.deepEqual(parseImagePlaceholders(''), [])
  assert.deepEqual(parseImagePlaceholders(null), [])
  assert.deepEqual(parseImagePlaceholders('普通文本 [图片：（）] 空名'), [])
  assert.deepEqual(parseImagePlaceholders('[图片：（a\nb）]'), [])
  assert.deepEqual(parseImagePlaceholders(`[图片：（${'y'.repeat(201)}）]`), [])
  assert.deepEqual(parseImagePlaceholders('[图片：（z）'), [])
  assert.deepEqual(parseImagePlaceholders('图片：（z）]'), [])
  const good = imagePlaceholder('ok.png')
  assert.deepEqual(parseImagePlaceholders(`${good} [图片：（x]`).map((entry) => entry.name), ['ok.png'])
})

test('placeholder roundtrip preserves names verbatim', () => {
  const names = ['a.png', '截图-2026.jpeg', '图 1.webp', 'mem-20261026T120000Z-0001-3.gif']
  const text = names.map((name) => imagePlaceholder(name)).join('\n')
  assert.deepEqual(parseImagePlaceholders(text).map((entry) => entry.name), names)
})

// ---------------------------------------------------------------------------
// content-block walk
// ---------------------------------------------------------------------------

test('contentToTextWithImages renders non-image blocks exactly like contentToText', () => {
  const content = [
    { type: 'text', text: '第一段' },
    { type: 'tool-call', name: 'memory_judge', arguments: { updates: [] } },
    { type: 'tool-call', name: 'shell', arguments: 'echo hi' },
    { type: 'tool-result' },
    { type: 'tool-addition', toolName: 'memory_recall' },
    { type: 'tool-removal', toolName: 'old_tool' },
    { type: 'file', attachment: { name: 'spec.pdf' } },
    { type: 'reasoning' },
    { type: 'unknown-kind' },
    { type: 'text', text: '最后一段' },
  ]
  const walked = contentToTextWithImages(content)
  assert.equal(walked.text, contentToText(content))
  assert.deepEqual(walked.images, [])
})

test('contentToTextWithImages places placeholders at image positions and collects metadata', () => {
  const content = [
    { type: 'text', text: '看这两张图：' },
    imageBlock({ attachmentId: 'sha256:img-1', mediaType: 'image/png', bytes: 10, width: 640, height: 480 }),
    { type: 'text', text: '和' },
    imageBlock({ attachmentId: 'sha256:img-2', mediaType: 'image/jpeg', bytes: 20, width: 200, height: 100 }),
  ]
  const walked = contentToTextWithImages(content, (index, block) => `mem-x-${index + 1}${imageExtension(block.attachment.mediaType)}`)
  assert.equal(walked.text, '看这两张图：\n[图片：（mem-x-1.png）]\n和\n[图片：（mem-x-2.jpg）]')
  assert.deepEqual(walked.images, [
    {
      name: 'mem-x-1.png',
      placeholder: '[图片：（mem-x-1.png）]',
      mediaType: 'image/png',
      width: 640,
      height: 480,
      bytes: 10,
      attachmentId: 'sha256:img-1',
    },
    {
      name: 'mem-x-2.jpg',
      placeholder: '[图片：（mem-x-2.jpg）]',
      mediaType: 'image/jpeg',
      width: 200,
      height: 100,
      bytes: 20,
      attachmentId: 'sha256:img-2',
    },
  ])
})

test('contentToTextWithImages is deterministic', () => {
  const content = [
    imageBlock({ attachmentId: 'sha256:1' }),
    { type: 'text', text: '中间' },
    imageBlock({ attachmentId: 'sha256:2', mediaType: 'image/webp' }),
  ]
  const nameFor = (index, block) => `same-${index + 1}${imageExtension(block.attachment.mediaType)}`
  assert.deepEqual(contentToTextWithImages(content, nameFor), contentToTextWithImages(content, nameFor))
})

test('contentToTextWithImages skips malformed image blocks safely', () => {
  const content = [
    { type: 'image' },
    { type: 'image', attachment: null },
    { type: 'image', attachment: [] },
    { type: 'image', attachment: { mediaType: 'image/png', width: 1, height: 1, bytes: 1 } },
    { type: 'image', attachment: { attachmentId: 'sha256:x', mediaType: 'text/plain', width: 1 } },
    { type: 'text', text: '安全文本' },
  ]
  const walked = contentToTextWithImages(content, () => 'never.png')
  assert.equal(walked.text, '安全文本')
  assert.deepEqual(walked.images, [])
})

test('contentToTextWithImages handles string and non-array content', () => {
  assert.deepEqual(contentToTextWithImages('裸文本'), { text: '裸文本', images: [] })
  assert.deepEqual(contentToTextWithImages(null), { text: '', images: [] })
  assert.deepEqual(contentToTextWithImages({ type: 'text', text: 'x' }), { text: '', images: [] })
})

test('contentToTextWithImages falls back to generated names', () => {
  const content = [
    imageBlock({ attachmentId: 'sha256:a', mediaType: 'image/png' }),
    imageBlock({ attachmentId: 'sha256:b', mediaType: 'image/jpeg' }),
    imageBlock({ attachmentId: 'sha256:c', mediaType: 'image/gif' }),
  ]
  assert.deepEqual(
    contentToTextWithImages(content).images.map((image) => image.name),
    ['image-1.png', 'image-2.jpg', 'image-3.gif'],
  )
  const unsafe = contentToTextWithImages([imageBlock({ attachmentId: 'sha256:d' })], () => '../evil')
  assert.deepEqual(unsafe.images.map((image) => image.name), ['_evil'])
  assert.equal(unsafe.text, '[图片：（_evil）]')
  const nonString = contentToTextWithImages([imageBlock({ attachmentId: 'sha256:e' })], () => 42)
  assert.deepEqual(nonString.images.map((image) => image.name), ['image-1.png'])
  const throwing = contentToTextWithImages([imageBlock({ attachmentId: 'sha256:f' })], () => {
    throw new Error('boom')
  })
  assert.deepEqual(throwing.images.map((image) => image.name), ['image-1.png'])
  const blank = contentToTextWithImages([imageBlock({ attachmentId: 'sha256:g' })], () => '中文名')
  assert.deepEqual(blank.images.map((image) => image.name), ['image-1.png'])
})

test('contentToTextWithImages deduplicates repeated names deterministically', () => {
  const content = [imageBlock({ attachmentId: 'sha256:a' }), imageBlock({ attachmentId: 'sha256:b' })]
  const walked = contentToTextWithImages(content, () => 'dup.png')
  assert.deepEqual(walked.images.map((image) => image.name), ['dup.png', 'dup-2.png'])
  assert.match(walked.text, /\[图片：（dup\.png）\]\n\[图片：（dup-2\.png）\]/)
})

test('contentToTextWithImages placeholders parse back to the collected names', () => {
  const content = [
    imageBlock({ attachmentId: 'sha256:a' }),
    { type: 'text', text: '中间' },
    imageBlock({ attachmentId: 'sha256:b', mediaType: 'image/webp' }),
  ]
  const walked = contentToTextWithImages(content, (index, block) => `f-${index + 1}${imageExtension(block.attachment.mediaType)}`)
  assert.deepEqual(parseImagePlaceholders(walked.text).map((entry) => entry.name), walked.images.map((image) => image.name))
})

// ---------------------------------------------------------------------------
// naming / sanitizing
// ---------------------------------------------------------------------------

test('sanitizeImageName keeps safe names and neutralizes path separators', () => {
  assert.equal(sanitizeImageName('a-b_c.1.png'), 'a-b_c.1.png')
  assert.equal(sanitizeImageName('a/b\\c.png'), 'a_b_c.png')
  assert.equal(sanitizeImageName('../evil.png'), '_evil.png')
  assert.equal(sanitizeImageName('../../etc/passwd'), '_.._etc_passwd')
  for (const name of ['a/b\\c.png', '../evil.png', '../../etc/passwd']) {
    const safe = sanitizeImageName(name)
    assert.ok(!safe.includes('/'))
    assert.ok(!safe.includes('\\'))
  }
})

test('sanitizeImageName never returns a traversal or unusable name', () => {
  for (const name of ['.', '..', '...', '', '   ', '////', '中文', undefined, null, 42]) {
    assert.equal(sanitizeImageName(name), '')
  }
  assert.equal(sanitizeImageName('中文 名称.png'), '_.png')
})

test('sanitizeImageName caps the length at 120 chars', () => {
  const long = sanitizeImageName('a'.repeat(200))
  assert.equal(long.length, 120)
  assert.equal(long, 'a'.repeat(120))
  const dotted = sanitizeImageName(`${'b'.repeat(119)}.png`)
  assert.ok(dotted.length <= 120)
  assert.equal(dotted, 'b'.repeat(119))
  assert.equal(sanitizeImageName(`${'c'.repeat(130)}.png`).length, 120)
})

test('sanitizeImageName is idempotent', () => {
  for (const name of ['../a.png', 'a b.png', '中文 2026.png', 'con.png', '..', 'a'.repeat(200)]) {
    const once = sanitizeImageName(name)
    assert.equal(sanitizeImageName(once), once)
  }
})

test('sanitizeImageName protects Windows device names', () => {
  assert.equal(sanitizeImageName('CON'), '_CON')
  assert.equal(sanitizeImageName('nul.png'), '_nul.png')
  assert.equal(sanitizeImageName('com3'), '_com3')
})

// ---------------------------------------------------------------------------
// image folder + files
// ---------------------------------------------------------------------------

test('imageFolderPath and ensureImageFolder create the images folder', () => {
  const memoryDir = path.join(tempDir(), 'nested', 'memory')
  assert.equal(imageFolderPath(memoryDir), path.join(memoryDir, 'images'))
  assert.throws(() => imageFolderPath(42), TypeError)
  assert.equal(ensureImageFolder(memoryDir), path.join(memoryDir, 'images'))
  assert.ok(existsSync(path.join(memoryDir, 'images')))
  assert.equal(ensureImageFolder(memoryDir), path.join(memoryDir, 'images'))
})

test('imageFilePath joins the image folder and rejects unsafe names', () => {
  const memoryDir = path.join(tempDir(), 'memory')
  assert.equal(imageFilePath(memoryDir, 'a.png'), path.join(imageFolderPath(memoryDir), 'a.png'))
  for (const name of ['..', '.', '../a.png', 'a/b.png', 'a\\b.png', '', '.hidden.png', 42, null, 'a'.repeat(121)]) {
    assert.throws(() => imageFilePath(memoryDir, name), /invalid image file name/)
  }
})

test('saveImageFile writes bytes and reports metadata', () => {
  const memoryDir = path.join(tempDir(), 'memory')
  const saved = saveImageFile(memoryDir, 'shot.png', PNG_BYTES)
  assert.equal(saved.name, 'shot.png')
  assert.equal(saved.path, imageFilePath(memoryDir, 'shot.png'))
  assert.equal(saved.bytes, PNG_BYTES.length)
  assert.deepEqual(readFileSync(saved.path), PNG_BYTES)
  assert.deepEqual(readdirSync(imageFolderPath(memoryDir)), ['shot.png'])
  assert.throws(() => saveImageFile(memoryDir, '../escape.png', PNG_BYTES), /invalid image file name/)
})

test('saveImageFile accepts Buffer/Uint8Array/ArrayBuffer/string and overwrites atomically', () => {
  const memoryDir = path.join(tempDir(), 'memory')
  const u8 = new Uint8Array([1, 2, 3, 4])
  assert.deepEqual(saveImageFile(memoryDir, 'u8.png', u8), {
    name: 'u8.png',
    path: imageFilePath(memoryDir, 'u8.png'),
    bytes: 4,
  })
  assert.deepEqual(loadImageFile(memoryDir, 'u8.png'), Buffer.from(u8))
  const arrayBuffer = new Uint8Array([9, 8, 7]).buffer
  assert.equal(saveImageFile(memoryDir, 'ab.png', arrayBuffer).bytes, 3)
  assert.deepEqual(loadImageFile(memoryDir, 'ab.png'), Buffer.from([9, 8, 7]))
  assert.equal(saveImageFile(memoryDir, 'str.png', 'abc').bytes, 3)
  assert.deepEqual(loadImageFile(memoryDir, 'str.png'), Buffer.from('abc'))
  assert.equal(saveImageFile(memoryDir, 'u8.png', JPEG_BYTES).bytes, JPEG_BYTES.length)
  assert.deepEqual(loadImageFile(memoryDir, 'u8.png'), JPEG_BYTES)
  assert.throws(() => saveImageFile(memoryDir, 'bad.png', 42), TypeError)
  assert.throws(() => saveImageFile(memoryDir, 'bad.png', { length: 1 }), TypeError)
  assert.ok(!readdirSync(imageFolderPath(memoryDir)).some((name) => name.endsWith('.tmp')))
  assert.equal(loadImageFile(memoryDir, 'bad.png'), undefined)
})

test('loadImageFile returns stored bytes or undefined', () => {
  const memoryDir = path.join(tempDir(), 'memory')
  saveImageFile(memoryDir, 'kept.png', PNG_BYTES)
  assert.deepEqual(loadImageFile(memoryDir, 'kept.png'), PNG_BYTES)
  assert.equal(loadImageFile(memoryDir, 'missing.png'), undefined)
  assert.equal(loadImageFile(memoryDir, '../kept.png'), undefined)
  assert.equal(loadImageFile(memoryDir, 42), undefined)
  assert.equal(loadImageFile(path.join(tempDir(), 'no-images'), 'anything.png'), undefined)
})

test('removeImageFiles removes safe existing files and returns the count', () => {
  const memoryDir = path.join(tempDir(), 'memory')
  for (const name of ['a.png', 'b.png', 'c.png']) saveImageFile(memoryDir, name, PNG_BYTES)
  writeFileSync(path.join(imageFolderPath(memoryDir), 'notes.txt'), 'stray')
  assert.equal(removeImageFiles(memoryDir, ['a.png', '../evil', 'missing.png', 'b.png']), 2)
  assert.deepEqual(listImageFiles(memoryDir), ['c.png'])
  assert.equal(removeImageFiles(memoryDir, ['c.png', 'c.png']), 1)
  assert.equal(removeImageFiles(memoryDir, ['c.png']), 0)
  assert.equal(removeImageFiles(memoryDir, 'a.png'), 0)
  assert.equal(removeImageFiles(memoryDir, []), 0)
})

test('listImageFiles lists stored images sorted and ignores strays', () => {
  const memoryDir = path.join(tempDir(), 'memory')
  saveImageFile(memoryDir, 'zzz.png', PNG_BYTES)
  saveImageFile(memoryDir, 'aaa.jpg', JPEG_BYTES)
  saveImageFile(memoryDir, 'mmm.webp', PNG_BYTES)
  const folder = imageFolderPath(memoryDir)
  writeFileSync(path.join(folder, 'notes.txt'), 'stray')
  writeFileSync(path.join(folder, '.hidden.png'), 'stray')
  mkdirSync(path.join(folder, 'sub.png'))
  assert.deepEqual(listImageFiles(memoryDir), ['aaa.jpg', 'mmm.webp', 'zzz.png'])
  assert.deepEqual(listImageFiles(path.join(tempDir(), 'missing')), [])
  assert.deepEqual(listImageFiles(42), [])
})

// ---------------------------------------------------------------------------
// metadata normalization
// ---------------------------------------------------------------------------

test('normalizeImageMeta canonicalizes valid entries', () => {
  const normalized = normalizeImageMeta([
    {
      name: ' shot 1.png ',
      placeholder: 'WRONG',
      mediaType: 'IMAGE/PNG',
      width: '640',
      height: 480.9,
      bytes: 1024,
      attachmentId: ' sha256:abc ',
      extra: 'ignored',
    },
  ])
  assert.deepEqual(normalized, [
    {
      name: 'shot_1.png',
      placeholder: '[图片：（shot_1.png）]',
      mediaType: 'image/png',
      width: 640,
      height: 480,
      bytes: 1024,
      attachmentId: 'sha256:abc',
    },
  ])
})

test('normalizeImageMeta drops malformed entries and dedupes by name', () => {
  const normalized = normalizeImageMeta([
    null,
    'nope',
    {},
    { name: 'a.png', mediaType: 'image/png', attachmentId: 'sha256:a', width: 1 },
    { name: 'a.png', mediaType: 'image/png', attachmentId: 'sha256:other', width: 999 },
    { name: '../b.png', mediaType: 'image/jpeg', attachmentId: 'sha256:b' },
    { name: 'bad', mediaType: 'text/plain', attachmentId: 'sha256:c' },
    { name: 'c.jpg', attachmentId: 'sha256:c' },
    { name: 'd.png', mediaType: 'image/png' },
    { name: '..', mediaType: 'image/png', attachmentId: 'sha256:dot' },
    { name: 'e.png', mediaType: 'image/png', attachmentId: 'sha256:e', width: -5, height: NaN, bytes: '12' },
    { name: '中文', mediaType: 'image/png', attachmentId: 'sha256:cn' },
  ])
  assert.deepEqual(normalized.map((image) => image.name), ['a.png', '_b.png', 'c.jpg', 'e.png'])
  assert.equal(normalized[0].width, 1)
  assert.equal(normalized[0].attachmentId, 'sha256:a')
  assert.equal(normalized[1].mediaType, 'image/jpeg')
  assert.equal(normalized[2].mediaType, 'image/jpeg')
  assert.deepEqual(
    { width: normalized[3].width, height: normalized[3].height, bytes: normalized[3].bytes },
    { width: 0, height: 0, bytes: 12 },
  )
  assert.ok(normalized.every((image) => image.placeholder === imagePlaceholder(image.name)))
})

test('normalizeImageMeta returns [] for non-array input', () => {
  assert.deepEqual(normalizeImageMeta(undefined), [])
  assert.deepEqual(normalizeImageMeta({ name: 'a.png' }), [])
  assert.deepEqual(normalizeImageMeta([]), [])
})

test('normalizeImageMeta is stable for contentToTextWithImages output', () => {
  const content = [
    imageBlock({ attachmentId: 'sha256:a' }),
    { type: 'text', text: '中间' },
    imageBlock({ attachmentId: 'sha256:b', mediaType: 'image/webp' }),
  ]
  const walked = contentToTextWithImages(content, (index, block) => `mem-${index + 1}${imageExtension(block.attachment.mediaType)}`)
  assert.deepEqual(normalizeImageMeta(walked.images), walked.images)
})

// ---------------------------------------------------------------------------
// recall-side interleaving
// ---------------------------------------------------------------------------

test('interleaveImageBlocks inserts image blocks at placeholder positions and preserves text', () => {
  const first = imagePlaceholder('a.png')
  const second = imagePlaceholder('b.jpg')
  const text = `开头\n${first} 中间 ${second}\n结尾`
  const images = [imageMeta('a.png'), imageMeta('b.jpg')]
  const blocks = interleaveImageBlocks(text, images, (name) => resolvedRef(name))
  assert.equal(blocks.length, 5)
  assert.deepEqual(blocks[0], { type: 'text', text: '开头\n' })
  assert.deepEqual(blocks[1], { type: 'image', attachment: resolvedRef('a.png') })
  assert.deepEqual(blocks[2], { type: 'text', text: ' 中间 ' })
  assert.deepEqual(blocks[3], { type: 'image', attachment: resolvedRef('b.jpg') })
  assert.deepEqual(blocks[4], { type: 'text', text: '\n结尾' })
  assert.equal(renderInterleaved(blocks), text)
})

test('interleaveImageBlocks keeps unresolved placeholders as text', () => {
  const first = imagePlaceholder('a.png')
  const second = imagePlaceholder('b.jpg')
  const text = `前 ${first} 中 ${second} 后`
  const images = [imageMeta('a.png'), imageMeta('b.jpg')]
  const blocks = interleaveImageBlocks(text, images, (name) => (name === 'a.png' ? resolvedRef(name) : undefined))
  assert.equal(blocks.filter((block) => block.type === 'image').length, 1)
  assert.equal(renderInterleaved(blocks), text)
  const textOnly = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
  assert.ok(textOnly.includes(second))
})

test('interleaveImageBlocks handles adjacent and edge placeholders', () => {
  const first = imagePlaceholder('a.png')
  const second = imagePlaceholder('b.jpg')
  const images = [imageMeta('a.png'), imageMeta('b.jpg')]
  const resolve = (name) => resolvedRef(name)
  const adjacent = interleaveImageBlocks(`${first}${second}`, images, resolve)
  assert.deepEqual(adjacent.map((block) => block.type), ['image', 'image'])
  assert.equal(renderInterleaved(adjacent), `${first}${second}`)
  assert.deepEqual(interleaveImageBlocks(`head${first}`, images, resolve).map((block) => block.type), ['text', 'image'])
  assert.deepEqual(interleaveImageBlocks(`${first}tail`, images, resolve).map((block) => block.type), ['image', 'text'])
  assert.deepEqual(interleaveImageBlocks(first, images, resolve).map((block) => block.type), ['image'])
})

test('interleaveImageBlocks keeps placeholders whose metadata is absent', () => {
  const first = imagePlaceholder('a.png')
  const second = imagePlaceholder('unknown.png')
  const text = `${first} ${second}`
  const blocks = interleaveImageBlocks(text, [imageMeta('a.png')], (name) => resolvedRef(name))
  assert.equal(blocks.filter((block) => block.type === 'image').length, 1)
  assert.equal(renderInterleaved(blocks), text)
  assert.deepEqual(interleaveImageBlocks(text, [], (name) => resolvedRef(name)), [{ type: 'text', text }])
})

test('interleaveImageBlocks handles empty text and missing resolver', () => {
  const text = `前 ${imagePlaceholder('a.png')} 后`
  assert.deepEqual(interleaveImageBlocks('', [imageMeta('a.png')], (name) => resolvedRef(name)), [])
  assert.deepEqual(interleaveImageBlocks(null, [imageMeta('a.png')], (name) => resolvedRef(name)), [])
  assert.deepEqual(interleaveImageBlocks(text, [imageMeta('a.png')]), [{ type: 'text', text }])
  assert.deepEqual(interleaveImageBlocks(text, [imageMeta('a.png')], 'not a function'), [{ type: 'text', text }])
})

test('content walk + interleave roundtrip preserves order and text', () => {
  const content = [
    { type: 'text', text: '第一段' },
    imageBlock({ attachmentId: 'sha256:a', mediaType: 'image/png' }),
    { type: 'text', text: '第二段' },
    imageBlock({ attachmentId: 'sha256:b', mediaType: 'image/jpeg' }),
    { type: 'text', text: '第三段' },
    imageBlock({ attachmentId: 'sha256:c', mediaType: 'image/gif' }),
  ]
  const walked = contentToTextWithImages(content, (index, block) => `mem-${index + 1}${imageExtension(block.attachment.mediaType)}`)
  const blocks = interleaveImageBlocks(walked.text, normalizeImageMeta(walked.images), (name) => resolvedRef(name))
  assert.equal(renderInterleaved(blocks), walked.text)
  assert.deepEqual(
    blocks.filter((block) => block.type === 'image').map((block) => block.attachment.name),
    walked.images.map((image) => image.name),
  )
  const textOnly = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
  assert.equal(textOnly, '第一段\n\n第二段\n\n第三段\n')
})

// ---------------------------------------------------------------------------
// end-to-end: archive walk -> save -> load -> interleave (contract §I4)
// ---------------------------------------------------------------------------

test('image folder roundtrip: walk -> save -> load -> interleave', () => {
  const memoryDir = path.join(tempDir(), 'memory')
  const content = [
    { type: 'text', text: '图一：' },
    imageBlock({ attachmentId: 'sha256:round-1', mediaType: 'image/png', bytes: PNG_BYTES.length }),
    { type: 'text', text: '图二：' },
    imageBlock({ attachmentId: 'sha256:round-2', mediaType: 'image/jpeg', bytes: JPEG_BYTES.length }),
  ]
  const walked = contentToTextWithImages(
    content,
    (index, block) => `mem-round-${index + 1}${imageExtension(block.attachment.mediaType)}`,
  )
  const meta = normalizeImageMeta(walked.images)
  const bytesByName = {
    'mem-round-1.png': PNG_BYTES,
    'mem-round-2.jpg': JPEG_BYTES,
  }
  for (const image of meta) saveImageFile(memoryDir, image.name, bytesByName[image.name])
  assert.deepEqual(listImageFiles(memoryDir), ['mem-round-1.png', 'mem-round-2.jpg'])

  const refs = new Map()
  for (const image of meta) {
    const bytes = loadImageFile(memoryDir, image.name)
    assert.notEqual(bytes, undefined)
    refs.set(image.name, { ...image, data: bytes })
  }
  const blocks = interleaveImageBlocks(walked.text, meta, (name) => refs.get(name))
  assert.equal(blocks.filter((block) => block.type === 'image').length, 2)
  assert.equal(renderInterleaved(blocks), walked.text)
  assert.deepEqual(
    blocks.filter((block) => block.type === 'image').map((block) => block.attachment.name),
    meta.map((image) => image.name),
  )
})

// ---------------------------------------------------------------------------
// telemetry summary
// ---------------------------------------------------------------------------

test('imageFolderSummary aggregates normalized images', () => {
  const images = [
    imageMeta('a.png', { bytes: 10 }),
    imageMeta('b.png', { bytes: 20 }),
    imageMeta('c.jpg', { bytes: 5 }),
  ]
  assert.deepEqual(imageFolderSummary(images), {
    count: 3,
    totalBytes: 35,
    byMediaType: { 'image/jpeg': 1, 'image/png': 2 },
  })
  assert.deepEqual(imageFolderSummary([]), { count: 0, totalBytes: 0, byMediaType: {} })
  assert.deepEqual(imageFolderSummary(undefined), { count: 0, totalBytes: 0, byMediaType: {} })
  assert.deepEqual(
    imageFolderSummary([...images, { name: 'bad', mediaType: 'text/plain', attachmentId: 'sha256:x' }]),
    { count: 3, totalBytes: 35, byMediaType: { 'image/jpeg': 1, 'image/png': 2 } },
  )
})
