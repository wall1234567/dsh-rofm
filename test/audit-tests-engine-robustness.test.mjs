/**
 * Audit (task-3): resilience holes not covered by the existing store tests.
 *
 * Existing coverage only feeds `index.json` JSON *syntax* errors. Real
 * corruption also takes the form of valid JSON with the wrong shape, folders
 * whose `context.json` is missing/corrupt, and duplicate ids — the plugin must
 * still load, list, recall and report without throwing, and a single broken
 * folder must never hide healthy memories from recall.
 *
 * Also covers empty/oversize message inputs and tokenizer inputs the existing
 * tests do not touch (punctuation/emoji-only, mixed CJK+latin without spaces).
 *
 * Black-box: imports only `engine/index.js` (docs/SPEC.md §7 public API).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import {
  MemoryEngine,
  ensureMemoryDir,
  estimateTokens,
  extractKeywords,
  listFolders,
  loadConfig,
  readIndex,
  writeFolder,
  writeIndex,
} from '../engine/index.js'

const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-audit-engine-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

const cfg = loadConfig()

// ---------------------------------------------------------------------------
// Store: valid JSON with the wrong shape must be normalized, never crash.
// ---------------------------------------------------------------------------
test('store: a structurally-corrupt index.json (valid JSON, wrong shape) is normalized in memory', () => {
  const shapes = ['[]', 'null', '"text"', '42', '{"folders":null}', '{"folders":[null,"x",42,{"id":"../evil"},{"id":"ok"}]}', '{"version":[]}']
  for (const shape of shapes) {
    const dir = tempDir()
    ensureMemoryDir(dir)
    fs.writeFileSync(path.join(dir, 'index.json'), shape, 'utf8')
    const engine = new MemoryEngine({ memoryDir: dir, config: cfg })
    assert.doesNotThrow(() => engine.load(), `load() must survive index.json = ${shape}`)
    const folders = engine.list()
    assert.ok(Array.isArray(folders), 'list() must return an array')
    for (const folder of folders) {
      assert.equal(typeof folder.id, 'string', 'normalized entries always carry a string id')
      assert.ok(!folder.id.includes('/') && !folder.id.includes('\\'), 'unsafe ids are dropped')
    }
    // The public read path agrees with the engine and never throws.
    const index = readIndex(dir, cfg)
    assert.ok(Array.isArray(index?.folders), `readIndex() must normalize index.json = ${shape}`)
    assert.ok(Array.isArray(listFolders(dir, cfg)))
    // Recall still runs against an unusable index.
    const result = engine.recall('部署 docker', { contextChars: 1000, windowTokens: 128000 })
    assert.deepEqual(result.additions, [])
    // Report aggregation is resilient too.
    assert.equal(typeof engine.report(), 'object')
  }
})

// ---------------------------------------------------------------------------
// Store: one broken folder must not hide healthy memories from recall.
// ---------------------------------------------------------------------------
test('store: corrupt/missing context.json folders never block recall of healthy folders', () => {
  const dir = tempDir()
  ensureMemoryDir(dir)
  const good = writeFolder(dir, {
    id: 'mem-good',
    meta: { createdAt: 1, alpha: 0.9, beta: 0, keywords: ['部署', 'docker'], title: 'good' },
    messages: [{ role: 'user', content: '部署 docker 端口 8080 的配置' }],
  })
  // (a) folder whose meta is readable but context.json is corrupt JSON.
  fs.mkdirSync(path.join(dir, 'mem-bad-context'))
  fs.writeFileSync(
    path.join(dir, 'mem-bad-context', 'meta.json'),
    JSON.stringify({ version: 1, id: 'mem-bad-context', createdAt: 2, alpha: 0.9, beta: 0, keywords: ['部署'], title: 'bad' }),
  )
  fs.writeFileSync(path.join(dir, 'mem-bad-context', 'context.json'), '{corrupt', 'utf8')
  // (b) folder with meta but no context.json at all.
  fs.mkdirSync(path.join(dir, 'mem-missing-context'))
  fs.writeFileSync(
    path.join(dir, 'mem-missing-context', 'meta.json'),
    JSON.stringify({ version: 1, id: 'mem-missing-context', createdAt: 3, alpha: 0.9, beta: 0, keywords: ['部署'], title: 'missing' }),
  )
  // (c) a folder directory whose name would escape the memory dir.
  fs.mkdirSync(path.join(dir, '..escape'))
  writeIndex(dir, cfg, {
    version: 1,
    folders: [
      { id: 'mem-good', createdAt: 1, alpha: 0.9, beta: 0, keywords: ['部署', 'docker'], title: 'good' },
      { id: 'mem-bad-context', createdAt: 2, alpha: 0.9, beta: 0, keywords: ['部署'], title: 'bad' },
      { id: 'mem-missing-context', createdAt: 3, alpha: 0.9, beta: 0, keywords: ['部署'], title: 'missing' },
    ],
  })
  const seeded = loadConfig(undefined, { recall: { seed: 7, probabilityScale: 1000 } })
  const engine = new MemoryEngine({ memoryDir: dir, config: seeded })
  engine.load()
  const result = engine.recall('部署 docker 端口 8080 配置', { contextChars: 10000, windowTokens: 128000 })
  assert.deepEqual(result.additions.map((addition) => addition.id), ['mem-good'], 'only the healthy folder may be recalled')
  assert.ok(Array.isArray(result.additions[0].messages) && result.additions[0].messages.length > 0)
  // The broken folders stay visible as metadata (they exist on disk) but recall skips them.
  assert.ok(engine.list().some((folder) => folder.id === 'mem-good'))
  const report = engine.report()
  assert.equal(report.recallEvents, 1)
  assert.equal(report.foldersAdded, 1)
  assert.equal(good.id, 'mem-good')
})

test('store: duplicate index ids collapse deterministically instead of double-recall', () => {
  const dir = tempDir()
  ensureMemoryDir(dir)
  writeFolder(dir, {
    id: 'mem-dup',
    meta: { createdAt: 1, alpha: 0.9, beta: 0, keywords: ['部署'], title: 'dup' },
    messages: [{ role: 'user', content: '部署 docker 端口' }],
  })
  writeIndex(dir, cfg, {
    version: 1,
    folders: [
      { id: 'mem-dup', createdAt: 1, alpha: 0.9, beta: 0, keywords: ['部署'], title: 'dup' },
      { id: 'mem-dup', createdAt: 2, alpha: 0.1, beta: 0, keywords: ['other'], title: 'dup2' },
    ],
  })
  const seeded = loadConfig(undefined, { recall: { seed: 7, probabilityScale: 1000 } })
  const index = readIndex(dir, cfg)
  assert.equal(index.folders.length, 1, 'duplicate ids must collapse to one entry')
  const engine = new MemoryEngine({ memoryDir: dir, config: seeded })
  engine.load()
  const additions = engine.recall('部署 docker 端口', { contextChars: 10000, windowTokens: 128000 }).additions
  assert.equal(additions.filter((addition) => addition.id === 'mem-dup').length, 1)
})

// ---------------------------------------------------------------------------
// Engine: empty / oversize user text must be a quiet no-op, not a crash.
// ---------------------------------------------------------------------------
test('engine: empty, whitespace-only and oversize recall inputs are safe', () => {
  const dir = tempDir()
  ensureMemoryDir(dir)
  writeFolder(dir, { id: 'mem-a', meta: { createdAt: 1, alpha: 0.9, beta: 0, keywords: ['部署'], title: 'a' }, messages: [{ role: 'user', content: '部署 docker' }] })
  writeIndex(dir, cfg, { version: 1, folders: [{ id: 'mem-a', createdAt: 1, alpha: 0.9, beta: 0, keywords: ['部署'], title: 'a' }] })
  const engine = new MemoryEngine({ memoryDir: dir, config: cfg })
  engine.load()
  for (const text of ['', '   ', '\n\t', '\u0000']) {
    const result = engine.recall(text, { contextChars: 1000, windowTokens: 128000 })
    assert.deepEqual(result.additions, [], `recall(${JSON.stringify(text)}) adds nothing`)
    assert.equal(result.stats.matchedFolders, 0)
  }
  // Oversize text is bounded work: it must complete quickly and never throw.
  const huge = '部署 docker 端口配置 '.repeat(20_000) // ~600k chars
  const started = Date.now()
  const result = engine.recall(huge, { contextChars: 1_000_000, windowTokens: 128_000 })
  assert.ok(Date.now() - started < 5000, 'oversize recall must stay bounded')
  assert.ok(Array.isArray(result.additions))
  assert.ok(result.stats.userKeywords.length <= cfg.keywords.max)
})

test('engine: estimateTokens follows the documented formula for mixed CJK/latin/emoji text', () => {
  // SPEC §1: estimateTokens(text) = ceil(latinChars/4 + cjkChars/1.6 + 4).
  assert.equal(estimateTokens(''), 4)
  assert.equal(estimateTokens('abcd'), 5) // 4/4+0+4
  assert.equal(estimateTokens('你好'), 6) // 0+2/1.6+4 -> ceil(5.25)=6
  // An astral emoji is one non-whitespace non-CJK code point → ceil(1/4+4)=5.
  assert.equal(estimateTokens('😀'), 5)
  // Mixed CJK+latin adds monotonically.
  assert.ok(estimateTokens('部署 docker 端口 8080') > estimateTokens('部署'))
  assert.ok(estimateTokens('装'.repeat(10_000)) > 0)
  // Deterministic (no locale/tz influence).
  assert.equal(estimateTokens('部署 docker 端口 8080'), estimateTokens('部署 docker 端口 8080'))
})

test('tokenizer: punctuation/emoji-only text yields no keywords; mixed CJK+latin yields both', () => {
  const punctuationOnly = '，。！？…—、；：""\'\'（）【】《》'
  assert.deepEqual(extractKeywords(punctuationOnly, cfg), [])
  assert.deepEqual(extractKeywords('   \n\t  ', cfg), [])
  assert.deepEqual(extractKeywords('😀😀😀😀🎉🎉', cfg), [], 'emoji carries no keyword evidence')
  // No-space CJK+latin still yields the latin technical token and a CJK term.
  const mixed = extractKeywords('部署docker端口8080方案', cfg)
  assert.ok(mixed.includes('docker'), JSON.stringify(mixed))
  assert.ok(mixed.some((keyword) => /[\u4e00-\u9fff]/.test(keyword)), JSON.stringify(mixed))
  // Repetition does not exceed the configured cap and stays deterministic.
  const repeated = extractKeywords('部署 docker 端口 '.repeat(500), cfg)
  assert.ok(repeated.length <= cfg.keywords.max)
  assert.deepEqual(extractKeywords('部署 docker 端口 '.repeat(500), cfg), repeated)
})
