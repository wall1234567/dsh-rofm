#!/usr/bin/env node
/**
 * Privacy check for the dsh-rofm repository (v1.4.1 addendum).
 *
 * The published/tracked `config.json` must never carry machine-local settings:
 * the 1.3.0 release shipped `compat.ownerIds` (a real QQ number) and
 * `compat.mediaRoots` (the maintainer's home/QQ paths) in the default config,
 * which is both a privacy leak and confusing for users.
 *
 * Machine-local settings belong in `config.local.json` next to `config.json`:
 * it is git-ignored, merged after config.json (before the profile row config)
 * and never shipped. This check fails when:
 *   1. `config.json` has a non-empty `compat.ownerIds` / `compat.mediaRoots`;
 *   2. `config.local.json` is tracked by git (must be ignored);
 *   3. `.gitignore` does not ignore `config.local.json`.
 *
 * It also scans the tracked text files for the *configured* personal values
 * (owner ids / media roots) so they cannot leak into docs or tests.
 *
 * Zero dependencies; exits 1 on any problem.
 *
 * Usage:
 *   node tools/privacy-check.mjs [--root <dir>] [--json]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const LOCAL_CONFIG = 'config.local.json'
const TRACKED_TEXT_EXT = /\.(?:md|json|js|mjs|cjs|yml|yaml|txt|sh|ps1)$/

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

/**
 * @param {{ root?: string, scanTracked?: boolean }} [options]
 * @returns {{ ok: boolean, problems: string[], warnings: string[], checked: object }}
 */
export function checkPrivacy(options = {}) {
  const root = path.resolve(options.root ?? REPO_ROOT)
  const problems = []
  const warnings = []
  const checked = { root, configExists: false, localExists: false, tracked: [], scannedFiles: 0 }

  const configPath = path.join(root, 'config.json')
  checked.configExists = existsSync(configPath)
  const config = checked.configExists ? readJson(configPath) : undefined
  if (!config) {
    problems.push('config.json is missing or not valid JSON')
  } else {
    const compat = config.compat && typeof config.compat === 'object' ? config.compat : {}
    const ownerIds = Array.isArray(compat.ownerIds) ? compat.ownerIds : []
    const mediaRoots = Array.isArray(compat.mediaRoots) ? compat.mediaRoots : []
    if (ownerIds.length > 0) {
      problems.push(`config.json compat.ownerIds must be empty in the repository (found ${ownerIds.length} value(s)); put personal ids in ${LOCAL_CONFIG}`)
    }
    if (mediaRoots.length > 0) {
      problems.push(`config.json compat.mediaRoots must be empty in the repository (found ${mediaRoots.length} path(s)); put local paths in ${LOCAL_CONFIG}`)
    }
    // Collect the configured personal values (from the local file if present) and
    // make sure they do not appear in any tracked text file.
    const localPath = path.join(root, LOCAL_CONFIG)
    checked.localExists = existsSync(localPath)
    const local = checked.localExists ? readJson(localPath) : undefined
    const localCompat = local && typeof local === 'object' && local.compat && typeof local.compat === 'object' ? local.compat : {}
    const personal = [
      ...(Array.isArray(localCompat.ownerIds) ? localCompat.ownerIds : []),
      ...(Array.isArray(localCompat.mediaRoots) ? localCompat.mediaRoots : []),
    ].filter((value) => typeof value === 'string' && value.length >= 4)
    if (personal.length > 0) {
      const tracked = git(root, ['ls-files', '-z'])
      if (tracked !== undefined) {
        const files = tracked.split('\0').filter(Boolean)
        checked.tracked = files
        for (const file of files) {
          if (file === LOCAL_CONFIG || file === 'config.json') continue
          if (!TRACKED_TEXT_EXT.test(file)) continue
          let text
          try {
            text = readFileSync(path.join(root, file), 'utf8')
          } catch {
            continue
          }
          checked.scannedFiles += 1
          for (const value of personal) {
            if (text.includes(value)) problems.push(`${file}: contains a machine-local value from ${LOCAL_CONFIG} (${JSON.stringify(value.slice(0, 24))}…)`)
          }
        }
      } else {
        warnings.push('git is not available: skipped the tracked-file scan for machine-local values')
      }
    } else if (!checked.localExists) {
      warnings.push(`${LOCAL_CONFIG} is absent: expected on a machine that uses QQ compat (it is optional and git-ignored)`)
    }
  }

  const gitignorePath = path.join(root, '.gitignore')
  if (!existsSync(gitignorePath)) {
    problems.push('.gitignore is missing; it must ignore config.local.json')
  } else {
    const gitignore = readFileSync(gitignorePath, 'utf8')
    if (!/^\s*config\.local\.json\s*$/m.test(gitignore)) {
      problems.push('.gitignore must ignore config.local.json')
    }
  }
  const trackedLocal = git(root, ['ls-files', '--', LOCAL_CONFIG])
  if (typeof trackedLocal === 'string' && trackedLocal.trim().length > 0) {
    problems.push(`${LOCAL_CONFIG} is tracked by git; it must be ignored (git rm --cached ${LOCAL_CONFIG})`)
  }

  return { ok: problems.length === 0, problems, warnings, checked }
}

function main(argv) {
  const args = argv.slice(2)
  const jsonIndex = args.indexOf('--json')
  const rootIndex = args.indexOf('--root')
  const options = {}
  if (rootIndex >= 0 && args[rootIndex + 1] !== undefined) options.root = args[rootIndex + 1]
  const result = checkPrivacy(options)
  if (jsonIndex >= 0) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`privacy-check: ${result.ok ? 'PASS' : 'FAIL'} (root=${result.checked.root})`)
    for (const problem of result.problems) console.log(`[FAIL] ${problem}`)
    for (const warning of result.warnings) console.log(`[WARN] ${warning}`)
    if (result.ok) console.log('tracked config has no machine-local values; config.local.json is ignored')
  }
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv)
}
