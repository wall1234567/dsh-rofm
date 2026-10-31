/**
 * dsh-rofm — cross-platform importance heuristic tests (v1.3.0).
 *
 * α is computed by the *engine*, which can run on any OS and also standalone
 * (`node engine/cli.mjs`). Before v1.3.0 the "code/path density" signal only
 * recognised Windows drive paths, so the exact same conversation archived on
 * Linux/macOS received a lower α than on Windows — a silent cross-platform
 * behaviour difference. These tests pin the OS-independent contract:
 *
 *   - `C:\work\a.txt` and `/work/a.txt` produce the same `signals.code`;
 *   - POSIX absolute / `./` / `../` / `~/` paths all count as path evidence;
 *   - dates (`2026/10/31`), URLs (`https://…`) and protocol-relative URLs
 *     (`//host/a.png`) are NOT counted as paths.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computeImportance } from '../engine/importance.js'
import { mergeConfigFile } from '../engine/index.js'

const CFG = mergeConfigFile({})

/** Run the heuristic on one user message and return the parsed result. */
function analyse(content) {
  return computeImportance([{ role: 'user', content }], CFG)
}

test('importance: Windows and POSIX absolute paths contribute the same code signal', () => {
  const plain = analyse('好的 收到 继续')
  const windows = analyse('C:\\work\\a.txt 好的 收到 继续')
  const posix = analyse('/work/a.txt 好的 收到 继续')
  assert.equal(plain.signals.code, 0, 'plain prose has no code/path evidence')
  assert.ok(windows.signals.code > 0, 'a Windows absolute path is path evidence')
  assert.equal(posix.signals.code, windows.signals.code, 'the same path on Linux/macOS must score identically')
})

test('importance: POSIX path spellings that count as path evidence', () => {
  for (const content of [
    '/usr/bin/node 启动服务',
    './src/app.js 改一下',
    '../docs/spec.md 看一下',
    '~/proj/a.js 这个文件',
    'PATH=/usr/bin:/bin 报错',
  ]) {
    assert.ok(analyse(content).signals.code > 0, `expected path evidence in: ${content}`)
  }
})

test('importance: dates, URLs and protocol-relative URLs are not paths', () => {
  assert.equal(analyse('2026/10/31 上线 好的').signals.code, 0, 'a date must not count as a POSIX path')
  // One URL counts as URL evidence (0.3), but no extra path evidence is added.
  assert.equal(analyse('https://example.com/a/b/c 看这个').signals.code, 0.3, 'URL must not double count as a path')
  assert.equal(analyse('//example.com/a/b.png 看这个').signals.code, 0, 'protocol-relative URL is not a path')
})

test('importance: a Windows drive path is not also counted as a POSIX path tail', () => {
  const windows = analyse('C:\\work\\a.txt 好的 收到 继续')
  const forward = analyse('C:/work/a.txt 好的 收到 继续')
  // `C:/x` legitimately matches both spellings; the count is OS-independent and
  // at least the backslash form must stay a single path signal.
  assert.equal(windows.signals.code, 0.1)
  assert.ok(forward.signals.code >= windows.signals.code, 'forward-slash drive path stays in the same range')
})
