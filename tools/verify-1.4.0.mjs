#!/usr/bin/env node
/**
 * dsh-rofm 1.4.0 — one-command gate (plan §5.5, contract §2/§11.14).
 *
 * Runs every documented gate step in order and prints one PASS/FAIL summary
 * table with the test counts and the failing list:
 *
 *   1. node --test                       (full unit + adapter + e2e suite)
 *   2. node test/simulate.mjs            (legacy engine simulator)
 *   3. node tools/selfcheck.mjs          (installed-store health check)
 *   4. node engine/cli.mjs --help        (CLI loads, exit 0)
 *   5. node tools/memory-audit.mjs --json (v1.4.0 read-only era audit)
 *   6. node tools/time-view.mjs --help   (read-only time view CLI)
 *   7. node --test test/e2e-adapter-simulate.test.mjs     (H e2e)
 *   8. node --test test/e2e-real-data-readonly.test.mjs   (H real-data read-only)
 *
 * Zero dependencies, plain Node. `node` is NOT guaranteed to be on PATH (the
 * build machines only have the DSH runtime's node), so every child process is
 * spawned with `process.execPath` — the interpreter that is running this file.
 *
 * Usage:
 *   node tools/verify-1.4.0.mjs            # run the whole gate
 *   node tools/verify-1.4.0.mjs --json     # machine-readable result
 *   node tools/verify-1.4.0.mjs --help
 *
 * Exit code: 0 when every step passes, 1 when at least one step fails.
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const NODE = process.execPath

/** The gate steps, in the documented order (contract §2). */
const STEPS = [
  {
    id: 'unit-tests',
    title: 'node --test (full suite)',
    args: ['--test'],
    kind: 'node-test',
    expectExit: 0,
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
  },
  {
    id: 'e2e-real-data',
    title: 'node --test test/e2e-real-data-readonly.test.mjs',
    args: ['--test', 'test/e2e-real-data-readonly.test.mjs'],
    kind: 'node-test',
    expectExit: 0,
  },
]

const SUMMARY_KEYS = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo']

/**
 * Extract the `ℹ tests 821` style summary block node:test prints on stdout
 * (the spec reporter). Returns null when the output has no such block.
 */
export function parseNodeTestSummary(output) {
  const summary = {}
  const lines = String(output ?? '').split(/\r?\n/)
  for (const line of lines) {
    const match = /^[ℹi]\s*(tests|pass|fail|skipped|cancelled|todo)\s+(\d+)\s*$/.exec(line.trim())
    if (match) summary[match[1]] = Number(match[2])
  }
  if (summary.tests === undefined) return null
  for (const key of SUMMARY_KEYS) if (summary[key] === undefined) summary[key] = 0
  return summary
}

/** Failing test names from a node:test run (the `✖ name` lines, de-duplicated). */
export function parseNodeTestFailures(output) {
  const failures = []
  const seen = new Set()
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^✖\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)\s*$/.exec(line.trim())
    if (!match) continue
    const name = match[1]
    if (seen.has(name)) continue
    seen.add(name)
    failures.push(name)
  }
  return failures
}

function runStep(step) {
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
  if (row.status === 'PASS' && step.kind === 'node-test') {
    const summary = row.summary
    if (!summary) {
      row.status = 'FAIL'
      row.notes.push('could not parse the node:test summary (tests/pass/fail)')
    } else if (summary.fail > 0) {
      row.status = 'FAIL'
      row.notes.push(`${summary.fail} failing test(s)`)
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

function printHuman(rows) {
  const idWidth = Math.max(...rows.map((row) => row.id.length), 3)
  const statusWidth = 4
  console.log('')
  console.log('dsh-rofm 1.4.0 gate')
  console.log(`repo: ${REPO}`)
  console.log(`node: ${NODE} (${process.version})`)
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
  const totalTests = rows.reduce((sum, row) => sum + (row.summary?.tests ?? 0), 0)
  const totalPass = rows.reduce((sum, row) => sum + (row.summary?.pass ?? 0), 0)
  const totalFail = rows.reduce((sum, row) => sum + (row.summary?.fail ?? 0), 0)
  console.log(
    `steps: ${passed.length}/${rows.length} PASS` +
      (failed.length > 0 ? `, ${failed.length} FAIL` : '') +
      ` · node:test cases: ${totalTests} / ${totalPass} pass / ${totalFail} fail`,
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

function printHelp() {
  console.log('dsh-rofm 1.4.0 one-command gate (zero dependencies)')
  console.log('')
  console.log('Usage:')
  console.log('  node tools/verify-1.4.0.mjs [--json] [--help]')
  console.log('')
  console.log('Runs, in order:')
  for (const step of STEPS) console.log(`  ${step.title}`)
  console.log('')
  console.log('Exit code: 0 when every step passes, 1 otherwise.')
  console.log('Every child process is spawned with process.execPath, so the script')
  console.log('works on machines where `node` is not on PATH (contract §2).')
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  printHelp()
  process.exit(0)
}
const jsonMode = args.includes('--json')
for (const arg of args) {
  if (arg === '--json' || arg === '--help' || arg === '-h') continue
  console.error(`unknown argument: ${arg}`)
  console.error('run with --help for usage')
  process.exit(2)
}

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
if (jsonMode) {
  const report = {
    tool: 'dsh-rofm-verify-1.4.0',
    version: '1.4.0',
    repo: REPO,
    node: { path: NODE, version: process.version },
    result: failed.length === 0 ? 'PASS' : 'FAIL',
    steps: rows.map((row) => ({
      id: row.id,
      title: row.title,
      command: row.command,
      status: row.status,
      exitCode: row.exitCode,
      durationMs: row.durationMs,
      summary: row.summary,
      failures: row.failures,
      notes: row.notes,
      stderr: row.stderr,
    })),
    totals: {
      steps: rows.length,
      passed: rows.length - failed.length,
      failed: failed.length,
      nodeTestCases: rows.reduce((sum, row) => sum + (row.summary?.tests ?? 0), 0),
      nodeTestPass: rows.reduce((sum, row) => sum + (row.summary?.pass ?? 0), 0),
      nodeTestFail: rows.reduce((sum, row) => sum + (row.summary?.fail ?? 0), 0),
    },
  }
  console.log(JSON.stringify(report, null, 2))
} else {
  printHuman(rows)
}

process.exit(failed.length === 0 ? 0 : 1)
