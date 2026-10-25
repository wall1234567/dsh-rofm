/**
 * Pre-open-source hardening audit — regression tests for defects found in
 * engine/ and tools/ by the engine auditor. Each test was written to fail on the
 * pre-fix tree and documents the documented behaviour it protects
 * (docs/SPEC.md §2 config, §4 α, §5 compression, §6 recall, §9 tools).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cloneConfig, deepMerge, loadConfig, validateConfig } from '../engine/config.js'
import { computeImportance } from '../engine/importance.js'
import { planCompression } from '../engine/compress.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-audit-'))
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

/** Run one of the repo's CLI entry points with the current node binary. */
function runTool(relativePath, args) {
  return spawnSync(process.execPath, [path.join(ROOT, relativePath), ...args], { cwd: ROOT, encoding: 'utf8' })
}

/** Write one memory folder in the documented layout (meta.json + context.json). */
function writeMemoryFolder(memoryDir, id, meta = {}, messages = [{ role: 'user', content: `content of ${id}` }]) {
  const dir = path.join(memoryDir, id)
  fs.mkdirSync(dir, { recursive: true })
  const fullMeta = { version: 1, id, createdAt: 1, alpha: 0.5, beta: 0, scored: true, keywords: [], title: '', ...meta }
  fullMeta.stats = { messages: messages.length, chars: messages.reduce((sum, message) => sum + String(message.content).length, 0), tokens: 1 }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(fullMeta))
  fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify({ version: 1, id, createdAt: fullMeta.createdAt, messages }))
}

// ---------------------------------------------------------------------------
// config: prototype pollution through a `__proto__` key
// ---------------------------------------------------------------------------
// JSON.parse() creates an *own* "__proto__" property. Plain `out[key] = value`
// assignment invokes Object.prototype's __proto__ setter, so the key silently
// disappeared and replaced the prototype of the merged object instead. That
// breaks "unknown keys are preserved" (SPEC §2) and is a prototype-pollution
// sink for config.json / adapter overrides.
test('config: "__proto__" JSON key is preserved as an own key, never as prototype', () => {
  const parsed = JSON.parse('{"__proto__":{"polluted":"yes"},"recall":{"firstGenMax":3}}')

  const merged = deepMerge({}, parsed)
  assert.equal(Object.prototype.hasOwnProperty.call(merged, '__proto__'), true)
  assert.equal(Object.getPrototypeOf(merged), Object.prototype)
  assert.equal(merged.polluted, undefined)
  assert.equal(merged.recall.firstGenMax, 3)

  const cloned = cloneConfig(parsed)
  assert.equal(Object.prototype.hasOwnProperty.call(cloned, '__proto__'), true)
  assert.equal(Object.getPrototypeOf(cloned), Object.prototype)
  assert.equal(cloned.polluted, undefined)

  const cfg = validateConfig(parsed)
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, '__proto__'), true)
  assert.equal(Object.getPrototypeOf(cfg), Object.prototype)
  assert.equal(cfg.polluted, undefined)
  assert.equal(cfg.recall.firstGenMax, 3)
  assert.equal(Object.prototype.polluted, undefined, 'Object.prototype must stay clean')
})

test('config: nested "__proto__" keys never change a merged object prototype', () => {
  const parsed = JSON.parse('{"keywords":{"__proto__":{"polluted":"nested"}},"__proto__":5}')
  const cfg = validateConfig(parsed)
  assert.equal(cfg.polluted, undefined)
  assert.equal(cfg.keywords.polluted, undefined)
  assert.equal(Object.getPrototypeOf(cfg.keywords), Object.prototype)
  // A non-object value must also survive as an own data property.
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, '__proto__'), true)
  assert.equal(cfg.__proto__, 5)
  assert.equal(Object.prototype.polluted, undefined)
})

// ---------------------------------------------------------------------------
// α warning must not accumulate in a long-lived config object
// ---------------------------------------------------------------------------
// computeImportance() reports a high-α warning on cfg.warnings; pushing the same
// string on every call made a long-lived engine config (and every plan copy of
// cfg.warnings) grow without bound.
test('importance: repeated high-alpha computation keeps a single warning', () => {
  const hot = [
    { role: 'user', content: ('must never always should remember important 必须 记住 重要 决定 不要 禁止 配置 参数 接口 版本 修复 错误 注意 约定 ').repeat(4) },
    { role: 'user', content: 'must never always should remember important 必须 记住 重要 决定 不要 禁止 配置 参数 接口 版本'.repeat(4) },
  ]
  const cfg = validateConfig({})
  const first = computeImportance(hot, cfg)
  assert.equal(first.alpha, 0.83)
  assert.equal(first.warnings.length, 1)
  const before = cfg.warnings.length
  for (let index = 0; index < 5; index += 1) computeImportance(hot, cfg)
  assert.equal(cfg.warnings.length, before, 'repeated identical warnings must not accumulate')
  assert.equal(cfg.warnings.filter((warning) => /exceeds importance\.warnAbove/.test(warning)).length, 1)
})

// ---------------------------------------------------------------------------
// compress: oversized-message slicing must not split a UTF-16 surrogate pair
// ---------------------------------------------------------------------------
// A message bigger than targetChunkChars is split by raw content.slice(offset,
// offset+targetChars). When targetChars lands between the two code units of an
// astral character (emoji, supplementary CJK), each folder keeps half a
// surrogate: the archived text renders as mojibake in the recall block.
test('compress: huge-message slicing never splits a surrogate pair', () => {
  const emoji = '\u{1F600}' // one code point, two UTF-16 code units
  const huge = 'a'.repeat(249) + emoji + 'b'.repeat(600)
  const messages = [
    { role: 'user', content: huge, tokens: 500 },
    { role: 'assistant', content: 'ok', tokens: 5 },
    { role: 'user', content: 'u2', tokens: 5 },
    { role: 'assistant', content: 'ok2', tokens: 5 },
  ]
  const cfg = loadConfig(undefined, {
    compress: { compressPercent: 90, targetChunkChars: 250, minChunkChars: 50, keepRecentMessages: 2 },
  })
  const plan = planCompression({ messages, usedPercent: 80, cfg, totalUsedTokens: 3000, windowTokens: 5000 })
  assert.equal(plan.shouldCompress, true)
  const fragments = plan.folders.flatMap((folder) => folder.messages.map((message) => String(message.content)))
  assert.equal(fragments.join(''), huge + 'ok', 'fragments preserve the original text in order')
  for (const fragment of fragments) {
    const first = fragment.charCodeAt(0)
    const last = fragment.charCodeAt(fragment.length - 1)
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), `fragment starts with a lone low surrogate: ${JSON.stringify(fragment.slice(0, 2))}`)
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `fragment ends with a lone high surrogate: ${JSON.stringify(fragment.slice(-2))}`)
  }
  assert.ok(new Set(fragments.map((fragment) => [...fragment].length)).size > 1, 'the message really was split')
})

// ---------------------------------------------------------------------------
// CLI: a flag that needs a value must be invalid input (exit 1), not `true`
// ---------------------------------------------------------------------------
// parseArgs() used to fall back to a boolean `true` when the value was missing,
// so `--seed` became Number(true) === 1 and `--used-percent` became 1; SPEC §8
// requires exit code 1 on invalid input.
test('engine/cli.mjs: flags that need a value exit 1 instead of coercing booleans', () => {
  for (const args of [
    ['recall', '--text', 'hi', '--seed'],
    ['list', '--dir'],
    ['compress', '--input', 'missing.json', '--used-percent'],
  ]) {
    const result = runTool('engine/cli.mjs', args)
    assert.equal(result.status, 1, `expected exit 1 for "${args.join(' ')}" (stdout=${result.stdout})`)
    assert.match(result.stderr, /requires a value/)
  }
  for (const seed of ['abc', '-1', '1.5']) {
    const result = runTool('engine/cli.mjs', ['recall', '--text', 'hi', '--seed', seed])
    assert.equal(result.status, 1, `--seed ${seed} must be invalid input`)
  }
  assert.equal(runTool('engine/cli.mjs', ['--help']).status, 0)
})

// ---------------------------------------------------------------------------
// tools/show-recall.mjs: corrupt JSON must be surfaced, never crash with a stack
// ---------------------------------------------------------------------------
test('tools/show-recall: corrupt index.json is rebuilt from meta.json instead of crashing', () => {
  const dir = tempDir()
  const id = 'mem-20261025T000000Z-0001'
  writeMemoryFolder(dir, id, { createdAt: 1, alpha: 0.5, beta: 2, keywords: ['部署'], title: 't' })
  fs.writeFileSync(path.join(dir, 'index.json'), '{not json')
  fs.writeFileSync(
    path.join(dir, 'stats.jsonl'),
    'not-json\n' + JSON.stringify({ type: 'recall', time: 1, addedFolders: 1, added: [{ id, beta: 2 }] }) + '\n',
  )
  const result = runTool('tools/show-recall.mjs', ['--dir', dir, '--json'])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.folders.length, 1)
  assert.equal(output.folders[0].id, id)
  assert.equal(output.folders[0].corrupt, false)
  assert.equal(output.recalls.length, 1, 'corrupt telemetry lines are skipped like the engine does')
})

test('tools/show-recall: folder with missing context.json is listed as corrupt, not crashed on', () => {
  const dir = tempDir()
  const id = 'mem-20261025T000000Z-0002'
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  fs.writeFileSync(path.join(dir, id, 'meta.json'), JSON.stringify({ version: 1, id, createdAt: 1, alpha: 0.5, keywords: ['k'] }))
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({ version: 1, folders: [{ id, createdAt: 1, alpha: 0.5, keywords: ['k'], scored: true }] }),
  )
  const result = runTool('tools/show-recall.mjs', ['--dir', dir, '--json'])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.folders.length, 1)
  assert.equal(output.folders[0].corrupt, true)
  assert.equal(output.wouldInject, '')
})

test('tools/show-recall: a missing --session value does not swallow the next flag', () => {
  const result = runTool('tools/show-recall.mjs', ['--session', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.ok(Array.isArray(output.sessions), 'falls back to session listing instead of treating --json as a session id')
  assert.equal(typeof output.memoryRoot, 'string')
})

// ---------------------------------------------------------------------------
// tools/recall-report.mjs: only numeric β counts toward the trust aggregate
// ---------------------------------------------------------------------------
test('tools/recall-report: non-numeric β (JSON null) is ignored in betaStats', () => {
  const dir = tempDir()
  const event = { type: 'recall', time: 1, addedFolders: 3, added: [{ id: 'a', beta: null }, { id: 'b', beta: 3 }, { id: 'c' }] }
  fs.writeFileSync(path.join(dir, 'stats.jsonl'), JSON.stringify(event) + '\n')
  const result = runTool('tools/recall-report.mjs', ['--dir', dir, '--json'])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.betaStats.n, 1)
  assert.equal(output.betaStats.mean, 3)
  assert.equal(output.betaStats.between0And7, 1)
})

// ---------------------------------------------------------------------------
// CLI: compress must honour the documented contextWindowTokens fallback
// ---------------------------------------------------------------------------
// SPEC §2: `compress.contextWindowTokens` is the window used by the CLI when the
// host does not report one; the adapter's resolveContextWindow() already treats
// a positive value as an explicit override. The CLI used to ignore it entirely.
test('engine/cli.mjs: compress falls back to compress.contextWindowTokens', () => {
  const dir = tempDir()
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ compress: { contextWindowTokens: 128000 } }))
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `第${index}轮 docker 端口 ` + 'x'.repeat(180),
  }))
  const conversationPath = path.join(dir, 'conversation.json')
  fs.writeFileSync(conversationPath, JSON.stringify({ messages, usedPercent: 80 }))

  const fromConfig = runTool('engine/cli.mjs', ['compress', '--input', conversationPath, '--config', configPath, '--dir', path.join(dir, 'mem-a')])
  assert.equal(fromConfig.status, 0, fromConfig.stderr)
  const configOutput = JSON.parse(fromConfig.stdout)
  assert.equal(configOutput.usedTokens, Math.round((128000 * 80) / 100), 'config window fills the missing host window')
  assert.equal(configOutput.shouldCompress, true)
  assert.ok(configOutput.folderCount >= 1)

  // conversation.json's own (host-reported) window still takes precedence
  const hostConversation = path.join(dir, 'conversation-host.json')
  fs.writeFileSync(hostConversation, JSON.stringify({ messages, usedPercent: 80, contextWindowTokens: 64000 }))
  const fromHost = runTool('engine/cli.mjs', ['compress', '--input', hostConversation, '--config', configPath, '--dir', path.join(dir, 'mem-b')])
  assert.equal(fromHost.status, 0, fromHost.stderr)
  assert.equal(JSON.parse(fromHost.stdout).usedTokens, Math.round((64000 * 80) / 100), 'host window wins over the config fallback')
})

// ---------------------------------------------------------------------------
// tools/show-recall.mjs: corrupt legacy root index must not crash the listing
// ---------------------------------------------------------------------------
// Listing mode reads the legacy 0.1.x flat `memory/index.json` only to count
// root folders; a corrupt file used to throw an uncaught SyntaxError.
test('tools/show-recall: corrupt legacy root index.json does not crash session listing', () => {
  const fixture = tempDir()
  fs.cpSync(path.join(ROOT, 'engine'), path.join(fixture, 'engine'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'tools'), path.join(fixture, 'tools'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'config.json'), path.join(fixture, 'config.json'))
  const memoryDir = path.join(fixture, 'memory')
  const legacyId = 'mem-20261025T000000Z-0009'
  fs.mkdirSync(path.join(memoryDir, legacyId), { recursive: true })
  fs.writeFileSync(path.join(memoryDir, legacyId, 'meta.json'), JSON.stringify({ version: 1, id: legacyId, createdAt: 9, alpha: 0.5, keywords: ['k'] }))
  fs.writeFileSync(path.join(memoryDir, legacyId, 'context.json'), JSON.stringify({ version: 1, id: legacyId, messages: [] }))
  fs.writeFileSync(path.join(memoryDir, 'index.json'), '{corrupt')

  const result = spawnSync(process.execPath, [path.join(fixture, 'tools', 'show-recall.mjs'), '--json'], { cwd: fixture, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(typeof output.memoryRoot, 'string')
  assert.equal(output.legacyFolders, 1, 'legacy folders are counted via the meta.json rebuild fallback')
  assert.deepEqual(output.sessions, [])
})




