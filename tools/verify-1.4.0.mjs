#!/usr/bin/env node
/**
 * dsh-rofm — one-command release gate (plan §5.5, contract §2/§11.14).
 *
 * Runs every documented gate step in order and prints one PASS/FAIL summary
 * table with the test counts and the failing list:
 *
 *   1. node --test                       (full unit + adapter + e2e suite)
 *   2. node test/simulate.mjs            (legacy engine simulator)
 *   3. node tools/selfcheck.mjs          (installed-store health check)
 *   4. node engine/cli.mjs --help        (CLI loads, exit 0)
 *   5. node tools/memory-audit.mjs --json (read-only era audit)
 *   6. node tools/time-view.mjs --help   (read-only time view CLI)
 *   7. node --test test/e2e-adapter-simulate.test.mjs     (H e2e)
 *   8. node --test test/e2e-real-data-readonly.test.mjs   (real-data-readonly fixture e2e)
 *
 * v1.4.1 hardening (audit T-01/T-03/T-09, gate V-01):
 *   - "0 fail" is not enough: every `node:test` step also checks a minimum test
 *     count and a maximum skipped count, so deleting a test file or skipping
 *     the e2e suites FAILS the gate instead of printing a green PASS;
 *   - the full-suite floor is no longer a hard-coded historical constant: it is
 *     read from `tools/gate-baseline.json` (the recorded release floor) and
 *     cross-checked against a static scan of `test/*.test.mjs` +
 *     `test-adapter/*.test.mjs` (98% of the declared cases). A stale/low floor
 *     can no longer let a 53-test file be deleted while the gate still passes
 *     (V-01). **When tests are added or removed, update
 *     `tools/gate-baseline.json` (`minFullSuiteTests`) in the same change.**
 *   - the node:test output may come from the spec reporter (`ℹ tests 977`, the
 *     default on a TTY-less child on current Node) or from the TAP reporter
 *     (`# tests 977`, e.g. `NODE_OPTIONS=--test-reporter=tap` or older Node),
 *     so a CI setting can no longer turn a fully green suite red;
 *   - the totals count every test once: the two e2e files are already part of
 *     the full-suite step and are NOT added a second time (T-09).
 *
 * Zero dependencies, plain Node. `node` is NOT guaranteed to be on PATH (the
 * build machines only have the DSH runtime's node), so every child process is
 * spawned with `process.execPath` — the interpreter that is running this file.
 * The module is importable (pure parsers/limits are exported for tests) and
 * only runs the gate when executed directly.
 *
 * Usage:
 *   node tools/verify-1.4.0.mjs            # run the whole gate
 *   node tools/verify-1.4.0.mjs --json     # machine-readable result
 *   node tools/verify-1.4.0.mjs --help
 *
 * Exit code: 0 when every step passes, 1 when at least one step fails.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { invokedAsMain } from './main-module.mjs'
import { checkPrivacy } from './privacy-check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const NODE = process.execPath

/** Directory names scanned for the static test-case floor (V-01). */
const TEST_DIRS = ['test', 'test-adapter']

/**
 * Read the recorded release floor from `tools/gate-baseline.json`.
 *
 * V-01: the old hard-coded `minFullSuiteTests: 919` became meaningless once the
 * suite grew to ~990 tests — deleting a 53-test file still left >919 and the
 * gate stayed green. The floor now lives next to the gate and must be bumped in
 * the same change as "tests added/removed" (see the header note).
 *
 * @param {string} [file]
 * @returns {{ok:boolean, value:object|null, error:string|null}}
 */
export function readGateBaseline(file = path.join(HERE, 'gate-baseline.json')) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return { ok: false, value: null, error: `cannot read ${file}: ${error.message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, value: null, error: `${file} is not a JSON object` }
  }
  for (const key of ['minFullSuiteTests', 'minE2eAdapterTests', 'minE2eRealDataTests']) {
    if (!Number.isInteger(parsed[key]) || parsed[key] < 1) {
      return { ok: false, value: null, error: `${file}: ${key} must be a positive integer` }
    }
  }
  for (const key of ['maxFullSuiteSkipped', 'maxE2eAdapterSkipped', 'maxE2eRealDataSkipped']) {
    if (parsed[key] !== undefined && (!Number.isInteger(parsed[key]) || parsed[key] < 0)) {
      return { ok: false, value: null, error: `${file}: ${key} must be a non-negative integer` }
    }
  }
  return { ok: true, value: parsed, error: null }
}

/**
 * Static scan of the declared test cases (V-01 cross-check).
 *
 * Counts `test(...)` / `testIfZstd(...)` / `test.skip(...)` declarations at the
 * start of a line in every test file. It is a conservative floor (loops and
 * helper-generated cases can add a few more), so `deriveGateLimits` only uses
 * 98% of it as a secondary minimum.
 *
 * @param {string} [repoRoot]
 * @returns {{files:number, cases:number, perFile:Record<string,number>}}
 */
export function countStaticTestCases(repoRoot = REPO) {
  const perFile = {}
  let files = 0
  let cases = 0
  for (const dirName of TEST_DIRS) {
    let names
    try {
      names = fs.readdirSync(path.join(repoRoot, dirName))
    } catch {
      continue
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.test.mjs')) continue
      files += 1
      let text = ''
      try {
        text = fs.readFileSync(path.join(repoRoot, dirName, name), 'utf8')
      } catch {
        continue
      }
      const matches = text.match(/^[ \t]*test(?:IfZstd|\.skip|\.only)?\s*\(/gm)
      const count = matches ? matches.length : 0
      if (count > 0) perFile[`${dirName}/${name}`] = count
      cases += count
    }
  }
  return { files, cases, perFile }
}

/**
 * Effective gate limits: the recorded baseline, raised by a conservative
 * static-scan floor when the baseline is stale-low (V-01). Both sources must
 * stay satisfied, so neither a hard-coded constant nor a single deleted file
 * can silently shrink the release suite.
 *
 * @param {object} baseline parsed gate-baseline.json
 * @param {number} staticCases `countStaticTestCases().cases`
 * @returns {object} frozen limits (+ the two informational source numbers)
 */
export function deriveGateLimits(baseline = {}, staticCases = 0) {
  const recorded = Number.isInteger(baseline.minFullSuiteTests) ? baseline.minFullSuiteTests : 0
  const staticFloor = staticCases > 0 ? Math.floor(staticCases * 0.98) : 0
  const intOr = (value, fallback) => (Number.isInteger(value) && value >= 0 ? value : fallback)
  return Object.freeze({
    minFullSuiteTests: Math.max(recorded, staticFloor),
    maxFullSuiteSkipped: intOr(baseline.maxFullSuiteSkipped, 4),
    minE2eAdapterTests: intOr(baseline.minE2eAdapterTests, 12),
    maxE2eAdapterSkipped: 0,
    minE2eRealDataTests: intOr(baseline.minE2eRealDataTests, 8),
    maxE2eRealDataSkipped: 0,
    // Informational: where the full-suite floor came from.
    recordedMinFullSuiteTests: recorded,
    staticTestCases: staticCases,
    staticFloor,
  })
}

const BASELINE = readGateBaseline()
const STATIC = countStaticTestCases()
/** Non-empty when the committed baseline is missing/unreadable (gate must FAIL). */
export const GATE_BASELINE_ERROR = BASELINE.ok ? null : BASELINE.error

/**
 * Minimum size of the release suite and maximum tolerated skips (effective).
 *
 * `maxFullSuiteSkipped` tolerates the two platform symlink/`zstd` skips while
 * still catching a suite that quietly skipped the 8 real-data-readonly cases
 * (V-01 keeps this a small constant: skips are a warning sign, not a target).
 * The e2e steps must run with ZERO skips: a skip is treated as a failure.
 */
export const GATE_LIMITS = deriveGateLimits(BASELINE.value || {}, STATIC.cases)

/** The gate steps, in the documented order (contract §2). */
export const STEPS = Object.freeze([
  {
    id: 'unit-tests',
    title: 'node --test (full suite)',
    args: ['--test'],
    kind: 'node-test',
    expectExit: 0,
    countsInTotals: true,
    minTests: GATE_LIMITS.minFullSuiteTests,
    maxSkipped: GATE_LIMITS.maxFullSuiteSkipped,
  },
  {
    id: 'simulate',
    title: 'node test/simulate.mjs',
    args: ['test/simulate.mjs'],
    expectExit: 0,
  },
  {
    id: 'selfcheck',
    title: 'node tools/selfcheck.mjs',
    args: ['tools/selfcheck.mjs'],
    expectExit: 0,
    // selfcheck exits 0 when 0 checks FAIL; warnings are explainable
    // (QQ compat adds 3 PASS/WARN-only lines on a machine with the plugin).
  },
  {
    id: 'cli-help',
    title: 'node engine/cli.mjs --help',
    args: ['engine/cli.mjs', '--help'],
    expectExit: 0,
  },
  {
    id: 'memory-audit',
    title: 'node tools/memory-audit.mjs --json',
    args: ['tools/memory-audit.mjs', '--json'],
    expectExit: 0,
    validate: (stdout) => {
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch (error) {
        return `stdout is not JSON (${error.message})`
      }
      if (parsed.readOnly !== true) return 'memory-audit is not reporting readOnly=true'
      if (!parsed.buckets || typeof parsed.totals?.folders !== 'number') return 'memory-audit JSON lacks era buckets/totals'
      if (typeof parsed.totals?.stores !== 'number') return 'memory-audit JSON lacks the store counter'
      return null
    },
  },
  {
    id: 'time-view',
    title: 'node tools/time-view.mjs --help',
    args: ['tools/time-view.mjs', '--help'],
    expectExit: 0,
  },
  {
    id: 'e2e-adapter',
    title: 'node --test test/e2e-adapter-simulate.test.mjs',
    args: ['--test', 'test/e2e-adapter-simulate.test.mjs'],
    kind: 'node-test',
    expectExit: 0,
    countsInTotals: false,
    minTests: GATE_LIMITS.minE2eAdapterTests,
    maxSkipped: GATE_LIMITS.maxE2eAdapterSkipped,
  },
  {
    id: 'e2e-real-data',
    title: 'node --test test/e2e-real-data-readonly.test.mjs',
    args: ['--test', 'test/e2e-real-data-readonly.test.mjs'],
    kind: 'node-test',
    expectExit: 0,
    countsInTotals: false,
    minTests: GATE_LIMITS.minE2eRealDataTests,
    maxSkipped: GATE_LIMITS.maxE2eRealDataSkipped,
  },
])

const SUMMARY_KEYS = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo']

/**
 * Extract the `ℹ tests 919` (spec reporter) or `# tests 919` (TAP reporter)
 * summary block node:test prints. Returns null when the output has no such
 * block.
 */
export function parseNodeTestSummary(output) {
  const summary = {}
  const lines = String(output ?? '').split(/\r?\n/)
  for (const line of lines) {
    const match = /^[ℹ#]\s*(tests|pass|fail|skipped|cancelled|todo)\s+(\d+)\s*$/.exec(line.trim())
    if (match) summary[match[1]] = Number(match[2])
  }
  if (summary.tests === undefined) return null
  for (const key of SUMMARY_KEYS) if (summary[key] === undefined) summary[key] = 0
  return summary
}

/**
 * Failing test names from either reporter, de-duplicated:
 *   spec reporter: `✖ name (12.3ms)`
 *   TAP reporter : `not ok 1 - name`
 */
export function parseNodeTestFailures(output) {
  const failures = []
  const seen = new Set()
  const add = (name) => {
    const trimmed = String(name ?? '').trim()
    if (trimmed.length === 0 || seen.has(trimmed)) return
    seen.add(trimmed)
    failures.push(trimmed)
  }
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const text = line.trim()
    const spec = /^✖\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)\s*$/.exec(text)
    if (spec) {
      add(spec[1])
      continue
    }
    const tap = /^not ok\s+\d+\s+-\s+(.+)$/.exec(text)
    if (tap) add(tap[1])
  }
  return failures
}

/**
 * Anti-false-green limit checks for one `node:test` step (pure, unit tested).
 *
 * @param {{minTests?:number, maxSkipped?:number}} step
 * @param {{tests:number, pass:number, fail:number, skipped:number, cancelled:number, todo:number}} summary
 * @returns {string[]} problems (empty = within limits)
 */
export function applyNodeTestLimits(step, summary) {
  const problems = []
  if (!summary || typeof summary !== 'object') return ['no node:test summary']
  if (summary.fail > 0) problems.push(`${summary.fail} failing test(s)`)
  if (Number.isInteger(step?.minTests) && summary.tests < step.minTests) {
    problems.push(
      `expected at least ${step.minTests} test(s), got ${summary.tests} ` +
        '(a test file was removed, excluded or the suite silently shrank)',
    )
  }
  if (Number.isInteger(step?.maxSkipped) && summary.skipped > step.maxSkipped) {
    problems.push(
      `expected at most ${step.maxSkipped} skipped test(s), got ${summary.skipped} ` +
        '(tests were skipped instead of run)',
    )
  }
  const accounted = (summary.pass || 0) + (summary.fail || 0) + (summary.skipped || 0) + (summary.cancelled || 0) + (summary.todo || 0)
  if (accounted !== summary.tests) {
    problems.push(`summary is inconsistent: pass+fail+skipped+cancelled+todo=${accounted} but tests=${summary.tests}`)
  }
  return problems
}

/** Aggregate the per-step rows into the unique-case totals (T-09). */
export function summarizeTotals(rows) {
  const list = Array.isArray(rows) ? rows : []
  const counted = list.filter((row) => row.countsInTotals !== false && row.summary)
  const all = list.filter((row) => row.summary)
  const sum = (rowsWithSummary, key) => rowsWithSummary.reduce((total, row) => total + (row.summary?.[key] ?? 0), 0)
  return {
    nodeTestCases: sum(counted, 'tests'),
    nodeTestPass: sum(counted, 'pass'),
    nodeTestFail: sum(counted, 'fail'),
    nodeTestSkipped: sum(counted, 'skipped'),
    // The same e2e tests are re-run as standalone steps; keep that number
    // separate so nobody mistakes it for additional coverage.
    nodeTestCasesSummed: sum(all, 'tests'),
    nodeTestSteps: all.length,
  }
}

/** Best-effort gate version from package.json. */
function gateVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '1.4.0'
  } catch {
    return '1.4.0'
  }
}

/** Run one step and decide PASS/FAIL (exit code + reporter summary + limits). */
export function runStep(step) {
  const startedAt = Date.now()
  const result = spawnSync(NODE, step.args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 15 * 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    // Selfcheck must stay hermetic on every machine; the gate never writes the
    // real store (memory-audit defaults to read-only, no --apply here).
    env: { ...process.env, DSH_ROFM_VERIFY: '1' },
  })
  const durationMs = Date.now() - startedAt
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const combined = `${stdout}\n${stderr}`
  const row = {
    id: step.id,
    title: step.title,
    command: [path.basename(NODE), ...step.args].join(' '),
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs,
    countsInTotals: step.countsInTotals !== false,
    summary: step.kind === 'node-test' ? parseNodeTestSummary(combined) : null,
    failures: step.kind === 'node-test' ? parseNodeTestFailures(combined) : [],
    status: 'PASS',
    notes: [],
  }
  if (result.error) {
    row.status = 'FAIL'
    row.notes.push(`spawn error: ${result.error.message}`)
  } else if (result.status !== step.expectExit) {
    row.status = 'FAIL'
    row.notes.push(`expected exit ${step.expectExit}, got ${result.status}`)
  }
  // The floor/skip limits are reported even when the step already failed on its
  // exit code: "a test file was deleted" must stay visible in the failure list.
  if (step.kind === 'node-test' && !result.error) {
    const summary = row.summary
    if (!summary) {
      row.status = 'FAIL'
      row.notes.push('could not parse the node:test summary (tests/pass/fail) from the spec or TAP reporter')
    } else {
      // 0-fail alone is not a gate: enforce the floor/skip limits too (F-01).
      const problems = applyNodeTestLimits(step, summary)
      if (problems.length > 0) {
        row.status = 'FAIL'
        row.notes.push(...problems)
      }
    }
  }
  if (row.status === 'PASS' && typeof step.validate === 'function') {
    const problem = step.validate(stdout)
    if (problem) {
      row.status = 'FAIL'
      row.notes.push(problem)
    }
  }
  // Keep a short tail for diagnostics without dumping the whole suite output.
  const tail = combined.trim().split(/\r?\n/).slice(-6).join('\n')
  row.outputTail = tail
  row.stderr = stderr.slice(0, 4000)
  return row
}

function formatCounts(row) {
  if (!row.summary) return '-'
  const s = row.summary
  return `${s.tests} tests / ${s.pass} pass / ${s.fail} fail / ${s.skipped} skip`
}

function printHuman(rows, version) {
  const idWidth = Math.max(...rows.map((row) => row.id.length), 3)
  const statusWidth = 4
  console.log('')
  console.log(`dsh-rofm ${version} gate`)
  console.log(`repo: ${REPO}`)
  console.log(`node: ${NODE} (${process.version})`)
  console.log(
    `baseline: recorded ${GATE_LIMITS.recordedMinFullSuiteTests}, static ${GATE_LIMITS.staticTestCases} declared ` +
      `-> full-suite floor ${GATE_LIMITS.minFullSuiteTests} (update tools/gate-baseline.json when tests change)`,
  )
  console.log('')
  console.log(`${'#'.padStart(2)}  ${'STEP'.padEnd(idWidth)}  ${'STATUS'.padEnd(statusWidth)}  ${'EXIT'.padEnd(4)}  ${'TIME'.padStart(7)}  CASES`)
  console.log('-'.repeat(110))
  rows.forEach((row, index) => {
    const counts = row.id === 'unit-tests' || row.id.startsWith('e2e') ? formatCounts(row) : '-'
    console.log(
      `${String(index + 1).padStart(2)}  ${row.id.padEnd(idWidth)}  ${row.status.padEnd(statusWidth)}  ${String(row.exitCode).padEnd(4)}  ${`${(row.durationMs / 1000).toFixed(1)}s`.padStart(7)}  ${counts}`,
    )
  })
  console.log('-'.repeat(110))
  const failed = rows.filter((row) => row.status === 'FAIL')
  const passed = rows.filter((row) => row.status === 'PASS')
  const totals = summarizeTotals(rows)
  console.log(
    `steps: ${passed.length}/${rows.length} PASS` +
      (failed.length > 0 ? `, ${failed.length} FAIL` : '') +
      ` · node:test cases: ${totals.nodeTestCases} unique (${totals.nodeTestCasesSummed} summed with e2e re-runs) / ${totals.nodeTestPass} pass / ${totals.nodeTestFail} fail / ${totals.nodeTestSkipped} skip`,
  )
  if (failed.length > 0) {
    console.log('')
    console.log('FAILURE LIST')
    for (const row of failed) {
      console.log(`- ${row.id} [${row.command}]`)
      for (const note of row.notes) console.log(`    note: ${note}`)
      for (const failure of row.failures) console.log(`    test: ${failure}`)
      if (row.outputTail) console.log(`    tail: ${row.outputTail.replace(/\n/g, '\n          ')}`)
    }
  }
  console.log('')
  console.log(failed.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
  console.log('')
}

function printHelp(version) {
  console.log(`dsh-rofm ${version} one-command gate (zero dependencies)`)
  console.log('')
  console.log('Usage:')
  console.log('  node tools/verify-1.4.0.mjs [--json] [--help]')
  console.log('')
  console.log('Runs, in order:')
  for (const step of STEPS) console.log(`  ${step.title}`)
  console.log('')
  console.log('The gate is more than "0 failing tests": each node:test step must')
  console.log(`also meet its minimum test count (full suite: ${GATE_LIMITS.minFullSuiteTests},`)
  console.log(`e2e-adapter: ${GATE_LIMITS.minE2eAdapterTests}, e2e-real-data: ${GATE_LIMITS.minE2eRealDataTests})`)
  console.log('and its maximum skipped count (e2e steps: 0), so deleting or')
  console.log('skipping tests fails the gate.')
  console.log('')
  console.log('The full-suite floor comes from tools/gate-baseline.json and is')
  console.log('cross-checked against 98% of the statically declared cases in')
  console.log('test/*.test.mjs + test-adapter/*.test.mjs (both must be satisfied).')
  console.log('When tests are added or removed, update minFullSuiteTests in that file.')
  console.log('node:test spec and TAP reporter output are both understood.')
  console.log('')
  console.log('Exit code: 0 when every step passes, 1 otherwise.')
  console.log('Every child process is spawned with process.execPath, so the script')
  console.log('works on machines where `node` is not on PATH (contract §2).')
}

/**
 * CLI entry point. Returns the process exit code (0 = PASS, 1 = FAIL, 2 = usage).
 * Exported so tests can drive it without spawning a child (importing this module
 * must not run the gate — see the invokedAsMain guard at the bottom).
 */
export function main(argv = process.argv.slice(2)) {
  const version = gateVersion()
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(version)
    return 0
  }
  const jsonMode = argv.includes('--json')
  for (const arg of argv) {
    if (arg === '--json' || arg === '--help' || arg === '-h') continue
    console.error(`unknown argument: ${arg}`)
    console.error('run with --help for usage')
    return 2
  }
  // V-01: a missing/corrupt tools/gate-baseline.json must FAIL the gate, never
  // silently fall back to a weaker historical floor.
  if (GATE_BASELINE_ERROR !== null) {
    if (jsonMode) {
      console.log(JSON.stringify({ tool: 'dsh-rofm-verify-1.4.0', version, repo: REPO, result: 'FAIL', baselineError: GATE_BASELINE_ERROR }, null, 2))
    } else {
      console.error(`gate baseline error: ${GATE_BASELINE_ERROR}`)
      console.error('Fix tools/gate-baseline.json (run `node --test` and record its `tests` count).')
    }
    return 1
  }

  // v1.4.1 privacy preflight: the tracked config must never carry machine-local
  // values (QQ owner ids / media roots). Personal settings live in the
  // git-ignored config.local.json. This runs before any step so a release made
  // from a dirty personal config fails immediately (see tools/privacy-check.mjs).
  const privacy = checkPrivacy()
  if (!privacy.ok) {
    if (jsonMode) {
      console.log(
        JSON.stringify(
          { tool: 'dsh-rofm-verify-1.4.0', version, repo: REPO, result: 'FAIL', privacy: { ok: false, problems: privacy.problems, warnings: privacy.warnings } },
          null,
          2,
        ),
      )
    } else {
      console.error('privacy preflight FAILED:')
      for (const problem of privacy.problems) console.error(`  [FAIL] ${problem}`)
      console.error('Move machine-local values to the git-ignored config.local.json (see docs/PUBLISHING.md).')
    }
    return 1
  }
  if (!jsonMode) console.error('[PASS] privacy — tracked config has no machine-local values')

  const rows = []
  for (const step of STEPS) {
    const row = runStep(step)
    rows.push(row)
    if (!jsonMode) {
      const counts = row.id === 'unit-tests' || row.id.startsWith('e2e') ? ` (${formatCounts(row)})` : ''
      console.error(`[${row.status}] ${row.title}${counts}`)
    }
  }

  const failed = rows.filter((row) => row.status === 'FAIL')
  const totals = summarizeTotals(rows)
  if (jsonMode) {
    const report = {
      tool: 'dsh-rofm-verify-1.4.0',
      version,
      repo: REPO,
      node: { path: NODE, version: process.version },
      result: failed.length === 0 ? 'PASS' : 'FAIL',
      privacy: { ok: true, warnings: privacy.warnings },
      limits: GATE_LIMITS,
      baseline: {
        file: 'tools/gate-baseline.json',
        recordedMinFullSuiteTests: GATE_LIMITS.recordedMinFullSuiteTests,
        staticTestCases: GATE_LIMITS.staticTestCases,
        staticFloor: GATE_LIMITS.staticFloor,
        effectiveMinFullSuiteTests: GATE_LIMITS.minFullSuiteTests,
      },
      steps: rows.map((row) => ({
        id: row.id,
        title: row.title,
        command: row.command,
        status: row.status,
        exitCode: row.exitCode,
        durationMs: row.durationMs,
        countsInTotals: row.countsInTotals,
        summary: row.summary,
        failures: row.failures,
        notes: row.notes,
        stderr: row.stderr,
      })),
      totals: {
        steps: rows.length,
        passed: rows.length - failed.length,
        failed: failed.length,
        ...totals,
      },
    }
    console.log(JSON.stringify(report, null, 2))
  } else {
    printHuman(rows, version)
  }
  return failed.length === 0 ? 0 : 1
}

if (invokedAsMain(import.meta.url)) {
  process.exitCode = main()
}
