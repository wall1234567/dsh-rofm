/**
 * End-to-end simulation test — spawns `node test/simulate.mjs` and checks the
 * required test-phase report (docs/SPEC.md §10.8).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SIMULATE = path.join(REPO_ROOT, 'test', 'simulate.mjs')

test('simulate.mjs: exits 0 and prints the percentage report', () => {
  const run = spawnSync(process.execPath, [SIMULATE], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000 })
  assert.equal(run.status, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`)
  assert.match(run.stdout, /=== dsh-rofm simulation ===/)
  assert.match(run.stdout, /=== memory recall report ===/)
  assert.match(run.stdout, /chars added back\s+:\s+\d+/)
  assert.match(run.stdout, /context added back\s+:\s+\d+\.\d+ %/)
  assert.ok(Number.parseFloat(/context added back\s+:\s+([\d.]+) %/.exec(run.stdout)[1]) > 0)
  assert.match(run.stdout, /folders added\s+:\s+\d+/)
  assert.match(run.stdout, /## 记忆回忆/)
})
