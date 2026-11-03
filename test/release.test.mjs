/**
 * dsh-rofm - tests for the maintainer release tool (tools/release.mjs).
 *
 * Pure helpers are covered (version math, CHANGELOG section extraction, GitHub
 * remote parsing, CLI parsing, the browser opener lookup, the npm 2FA URL check
 * and the "npm pack --dry-run" content guard), plus the v1.4.1 resume-safety
 * checks (F-02: tag/HEAD/worktree version integrity, backed by real temp git
 * repositories) and the read-only preflight fetch (T-11). The full release
 * steps (git push / npm publish / GitHub Release) are exercised by actually
 * cutting a release, not here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  EOTP_HOOK_SOURCE,
  PACKAGE_NAME,
  REPO_ROOT,
  ReleaseError,
  USAGE,
  assertTagMatchesVersion,
  buildReleaseBody,
  buildReleaseName,
  bumpVersion,
  evaluateResumeVersionIntegrity,
  extractChangelogSection,
  extractOtpUrls,
  fetchArgs,
  formatVersion,
  installSystemCertificates,
  isCertificateError,
  nodeOptionsForRequire,
  openCommandFor,
  parseCliArgs,
  parseGitHubRemote,
  parseVersion,
  readPackageVersionAtRef,
  releaseCommitMessage,
  resolveTargetVersion,
  shellCommandFor,
  shellQuote,
  tagName,
  validatePackOutput,
  versionGreater,
} from '../tools/release.mjs'

const SAMPLE_CHANGELOG = [
  '# Changelog',
  '',
  'All notable changes.',
  '',
  '## [Unreleased]',
  '',
  '- work in progress',
  '',
  '## [1.2.0] — 2026-01-01',
  '',
  'The 1.2.0 notes.',
  '',
  '### Added',
  '',
  '- a feature',
  '',
  '### Fixed',
  '',
  '- a bug',
  '',
  '## [1.1.0] — 2025-12-01',
  '',
  'Older notes.',
  '',
].join('\n')

test('release: parseVersion accepts strict x.y.z only', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepEqual(parseVersion(' 10.20.30 '), { major: 10, minor: 20, patch: 30 })
  assert.deepEqual(parseVersion('0.0.0'), { major: 0, minor: 0, patch: 0 })
  for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta', '', 'one.two.three', null, undefined, 42]) {
    assert.equal(parseVersion(bad), null, 'expected null for ' + String(bad))
  }
})

test('release: formatVersion round-trips parseVersion', () => {
  for (const version of ['0.0.1', '1.2.3', '12.34.56']) {
    assert.equal(formatVersion(parseVersion(version)), version)
  }
})

test('release: bumpVersion bumps the expected component', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4')
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0')
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0')
  assert.equal(bumpVersion('0.0.0', 'patch'), '0.0.1')
  assert.throws(() => bumpVersion('1.2.3', 'huge'), ReleaseError)
  assert.throws(() => bumpVersion('1.2', 'patch'), ReleaseError)
})

test('release: versionGreater compares numerically', () => {
  assert.equal(versionGreater('1.10.0', '1.9.9'), true)
  assert.equal(versionGreater('2.0.0', '1.99.99'), true)
  assert.equal(versionGreater('1.2.3', '1.2.3'), false)
  assert.equal(versionGreater('1.2.2', '1.2.3'), false)
  assert.equal(versionGreater('bad', '1.2.3'), false)
})

test('release: tagName prefixes the version', () => {
  assert.equal(tagName('1.2.3'), 'v1.2.3')
})

test('release: resolveTargetVersion handles bump / explicit / resume', () => {
  assert.deepEqual(resolveTargetVersion('1.2.3', { bump: 'minor', version: null, resume: false }), { version: '1.3.0', mode: 'release' })
  assert.deepEqual(resolveTargetVersion('1.2.3', { bump: null, version: '2.0.0', resume: false }), { version: '2.0.0', mode: 'release' })
  assert.deepEqual(resolveTargetVersion('1.2.3', { bump: null, version: null, resume: true }), { version: '1.2.3', mode: 'resume' })
  assert.throws(() => resolveTargetVersion('1.2.3', { bump: null, version: '1.2.3', resume: false }), ReleaseError)
  assert.throws(() => resolveTargetVersion('1.2.3', { bump: null, version: '1.0.0', resume: false }), ReleaseError)
  assert.throws(() => resolveTargetVersion('1.2.3', { bump: null, version: '1.2', resume: false }), ReleaseError)
  assert.throws(() => resolveTargetVersion('not-semver', { bump: null, version: null, resume: true }), ReleaseError)
})

test('release: extractChangelogSection slices exactly one version section', () => {
  const section = extractChangelogSection(SAMPLE_CHANGELOG, '1.2.0')
  assert.ok(section, 'section must be found')
  assert.equal(section.heading, '## [1.2.0] — 2026-01-01')
  assert.ok(section.body.startsWith('The 1.2.0 notes.'))
  assert.ok(section.body.includes('### Fixed'))
  assert.ok(!section.body.includes('Older notes.'), 'must stop at the next version heading')
  assert.ok(!section.body.includes('Unreleased'), 'must not include earlier sections')
  assert.equal(extractChangelogSection(SAMPLE_CHANGELOG, '9.9.9'), null)
  assert.equal(extractChangelogSection(SAMPLE_CHANGELOG, '1.2'), null, 'partial version must not match')
  assert.equal(extractChangelogSection('', '1.2.0'), null)
  assert.equal(extractChangelogSection(null, '1.2.0'), null)
  assert.equal(extractChangelogSection(SAMPLE_CHANGELOG, null), null)
})

test('release: the extracted section matches the real repository CHANGELOG', () => {
  const changelog = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  const section = extractChangelogSection(changelog, pkg.version)
  assert.ok(section, 'the current package.json version needs a CHANGELOG section, otherwise the release tool refuses to run')
  assert.ok(section.body.length > 0)
  assert.ok(!section.body.includes('## ['), 'section body must not contain another version heading')
})

test('release: buildReleaseBody / buildReleaseName / releaseCommitMessage', () => {
  assert.equal(buildReleaseBody('1.2.0', '  notes  '), '# ' + PACKAGE_NAME + ' 1.2.0\n\nnotes\n')
  assert.equal(buildReleaseBody('1.2.0', ''), '# ' + PACKAGE_NAME + ' 1.2.0\n\n\n')
  assert.equal(buildReleaseName('1.2.0', ''), PACKAGE_NAME + ' 1.2.0')
  assert.equal(buildReleaseName('1.2.0', ' QQ channel '), PACKAGE_NAME + ' 1.2.0 \u2014 QQ channel')
  assert.equal(releaseCommitMessage('1.2.0', ''), 'release: ' + PACKAGE_NAME + ' 1.2.0')
  assert.equal(releaseCommitMessage('1.2.0', ' QQ channel '), 'release: ' + PACKAGE_NAME + ' 1.2.0 \u2014 QQ channel')
})

test('release: parseGitHubRemote understands the usual remote spellings', () => {
  const expected = { owner: 'wall1234567', repo: 'dsh-rofm' }
  const urls = [
    'https://github.com/wall1234567/dsh-rofm.git',
    'https://github.com/wall1234567/dsh-rofm',
    'https://github.com/wall1234567/dsh-rofm/',
    'git@github.com:wall1234567/dsh-rofm.git',
    'ssh://git@github.com/wall1234567/dsh-rofm.git',
    'github.com/wall1234567/dsh-rofm',
  ]
  for (const url of urls) assert.deepEqual(parseGitHubRemote(url), expected, 'failed for ' + url)
  for (const bad of ['https://gitlab.com/o/r.git', 'https://github.com/only-owner', '', null, 42]) {
    assert.equal(parseGitHubRemote(bad), null, 'expected null for ' + String(bad))
  }
})

test('release: parseCliArgs normalizes flags and rejects bad combinations', () => {
  const base = parseCliArgs(['--bump', 'patch', '--yes'])
  assert.equal(base.bump, 'patch')
  assert.equal(base.yes, true)
  assert.equal(base.dryRun, false)
  assert.equal(base.version, null)
  assert.equal(base.resume, false)

  const everything = parseCliArgs([
    '--version', '2.0.0', '--title', 'hello', '--dry-run', '--skip-tests', '--skip-npm',
    '--skip-github', '--skip-push', '--no-browser', '--otp', '123456', '--allow-dirty',
  ])
  assert.equal(everything.version, '2.0.0')
  assert.equal(everything.title, 'hello')
  assert.equal(everything.dryRun, true)
  assert.equal(everything.skipTests, true)
  assert.equal(everything.skipNpm, true)
  assert.equal(everything.skipGithub, true)
  assert.equal(everything.skipPush, true)
  assert.equal(everything.noBrowser, true)
  assert.equal(everything.otp, '123456')
  assert.equal(everything.allowDirty, true)

  assert.equal(parseCliArgs(['--resume']).resume, true)
  assert.equal(parseCliArgs(['--resume']).help, false, 'help flag defaults to false')
  assert.equal(parseCliArgs(['--help']).help, true)
  assert.throws(() => parseCliArgs([]), ReleaseError)
  assert.throws(() => parseCliArgs(['--bump']), ReleaseError)
  assert.throws(() => parseCliArgs(['--bump', 'patch', '--resume']), ReleaseError)
  assert.throws(() => parseCliArgs(['--bump', 'huge']), ReleaseError)
  assert.throws(() => parseCliArgs(['--version', '1.2']), ReleaseError)
  assert.throws(() => parseCliArgs(['--nope']), ReleaseError)
})

test('release: USAGE documents the supported modes and safety flags', () => {
  for (const flag of ['--bump', '--version', '--resume', '--dry-run', '--yes', '--skip-npm', '--skip-github', '--otp', 'NPM_CLI', 'GITHUB_TOKEN']) {
    assert.ok(USAGE.includes(flag), 'USAGE must mention ' + flag)
  }
})

test('release: openCommandFor picks the platform browser opener', () => {
  const windows = openCommandFor('https://example.com/x', 'win32')
  assert.equal(windows.args.includes('start'), true)
  assert.equal(windows.args[windows.args.length - 1], 'https://example.com/x')
  assert.deepEqual(openCommandFor('https://example.com/x', 'darwin'), { command: 'open', args: ['https://example.com/x'] })
  assert.deepEqual(openCommandFor('https://example.com/x', 'linux'), { command: 'xdg-open', args: ['https://example.com/x'] })
  assert.equal(openCommandFor('https://example.com/x', 'freebsd').command, 'xdg-open')
})

test('release: shellQuote / shellCommandFor keep simple arguments intact', () => {
  assert.equal(shellQuote('publish'), 'publish')
  assert.equal(shellQuote('--otp=123abc'), '--otp=123abc')
  assert.equal(shellQuote('dsh-rofm@1.3.0'), 'dsh-rofm@1.3.0')
  assert.equal(shellQuote('two words'), '"two words"')
  assert.equal(shellQuote('a"b'), '"a\\"b"')
  const windows = shellCommandFor(['npm', 'publish'], 'win32')
  assert.equal(windows.args[0], '/d')
  assert.ok(windows.args[windows.args.length - 1].includes('npm publish'))
  const posix = shellCommandFor(['npm', 'publish'], 'linux')
  assert.deepEqual(posix.args, ['-c', 'npm publish'])
})

test('release: nodeOptionsForRequire quotes paths containing spaces', () => {
  assert.equal(nodeOptionsForRequire('D:/tmp/hook.cjs'), '--require D:/tmp/hook.cjs')
  assert.equal(nodeOptionsForRequire('C:/with space/hook.cjs'), '--require "C:/with space/hook.cjs"')
})

test('release: validatePackOutput guards the published tarball content', () => {
  const clean = 'npm notice 138B memory/.gitkeep\nnpm notice 1.6kB package.json\nnpm notice total files: 45'
  assert.deepEqual(validatePackOutput(clean), [])
  assert.deepEqual(validatePackOutput(''), ['memory/.gitkeep is missing from the npm tarball'])
  assert.deepEqual(
    validatePackOutput('npm notice 138B memory/.gitkeep\nnpm notice 1kB memory/.compat-state.json'),
    ['runtime memory data is inside the npm tarball'],
  )
  assert.deepEqual(
    validatePackOutput('npm notice 138B memory/.gitkeep\nnpm notice 1kB memory/sessions/abc/index.json'),
    ['runtime memory data is inside the npm tarball'],
  )
  assert.deepEqual(
    validatePackOutput('npm notice 138B memory/.gitkeep\nnpm notice 2kB test/engine.test.mjs'),
    ['test files are inside the npm tarball'],
  )
})

test('release: extractOtpUrls only accepts https auth/done URL pairs', () => {
  const ok = extractOtpUrls({ authUrl: 'https://www.npmjs.com/auth/cli/abc', doneUrl: 'https://registry.npmjs.org/-/v1/done?authId=abc' })
  assert.deepEqual(ok, { authUrl: 'https://www.npmjs.com/auth/cli/abc', doneUrl: 'https://registry.npmjs.org/-/v1/done?authId=abc' })
  assert.equal(extractOtpUrls({ authUrl: 'http://insecure', doneUrl: 'https://registry.npmjs.org/-/v1/done?authId=abc' }), null)
  assert.equal(extractOtpUrls({ authUrl: 'https://a', doneUrl: 'not-a-url' }), null)
  assert.equal(extractOtpUrls({ authUrl: 'https://a' }), null)
  assert.equal(extractOtpUrls(null), null)
  assert.equal(extractOtpUrls('https://a'), null)
})

test('release: package.json wires the release tool and ships the tools directory', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.release, 'node tools/release.mjs')
  assert.equal(pkg.scripts['release:status'], 'node tools/release.mjs --resume --dry-run')
  assert.ok(pkg.files.includes('tools'), 'tools/ must stay in the npm tarball for maintainers')
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'tools', 'release.mjs')))
})


test('release: installSystemCertificates merges the OS store when Node supports it', () => {
  const calls = []
  const fakeTls = {
    getCACertificates: (kind) => (kind === 'system' ? ['system-a', 'system-b'] : ['extra-a']),
    setDefaultCACertificates: (certificates) => { calls.push(certificates) },
  }
  assert.equal(installSystemCertificates(fakeTls), true)
  assert.deepEqual(calls, [['system-a', 'system-b', 'extra-a']])
  assert.equal(installSystemCertificates({}), false, 'old Node without the tls helpers')
  assert.equal(installSystemCertificates(null), false)
  assert.equal(installSystemCertificates({ getCACertificates: () => [], setDefaultCACertificates: () => {} }), false, 'empty system store')
  assert.equal(installSystemCertificates({ getCACertificates: () => { throw new Error('boom') }, setDefaultCACertificates: () => {} }), false, 'must never throw')
})

test('release: isCertificateError recognizes TLS trust failures only', () => {
  for (const error of [
    { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    { code: 'SELF_SIGNED_CERT_IN_CHAIN' },
    { message: 'unable to verify the first certificate' },
    { message: 'certificate has expired' },
  ]) assert.equal(isCertificateError(error), true, JSON.stringify(error))
  for (const error of [null, undefined, {}, { code: 'ETIMEDOUT' }, { message: 'socket hang up' }]) {
    assert.equal(isCertificateError(error), false, String(error))
  }
})

test('release: the embedded npm EOTP hook is valid JavaScript and preloads cleanly', () => {
  assert.ok(EOTP_HOOK_SOURCE.includes('npm-registry-fetch/lib/check-response.js'), 'hook must target npm-registry-fetch')
  assert.ok(EOTP_HOOK_SOURCE.includes('HttpErrorAuthOTP'), 'hook must wrap the EOTP error class')
  assert.ok(EOTP_HOOK_SOURCE.includes('DSH_ROFM_EOTP_BODY'), 'hook must read the output path from the env')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-hook-'))
  const hookPath = path.join(dir, 'eotp-hook.cjs')
  try {
    fs.writeFileSync(hookPath, EOTP_HOOK_SOURCE, 'utf8')
    const result = spawnSync(process.execPath, ['--require', hookPath, '-e', 'process.exit(0)'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_ROFM_EOTP_BODY: path.join(dir, 'out.json') },
    })
    assert.equal(result.status, 0, 'hook preload failed: ' + (result.stderr || ''))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
test('release: ReleaseError carries a recovery hint', () => {
  const error = new ReleaseError('boom', 'fix it')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'ReleaseError')
  assert.equal(error.message, 'boom')
  assert.equal(error.recovery, 'fix it')
  assert.equal(new ReleaseError('plain').recovery, '')
})

// ---------------------------------------------------------------------------
// v1.4.1 F-02 / T-11: resume version integrity + read-only fetch
// ---------------------------------------------------------------------------

/** Run one git command in a temp repo (skip the test when git is unavailable). */
function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

const GIT_AVAILABLE = (() => {
  try {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8' })
    return !probe.error && probe.status === 0
  } catch {
    return false
  }
})()

function makeTempGitRepo({ version = '1.4.0' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-rel-'))
  runGit(dir, ['init', '-q', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'audit@example.com'])
  runGit(dir, ['config', 'user.name', 'audit'])
  runGit(dir, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-rofm', version }) + '\n')
  fs.mkdirSync(path.join(dir, 'engine'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'engine', 'package.json'), JSON.stringify({ name: 'dsh-rofm-engine', version }) + '\n')
  runGit(dir, ['add', '-A'])
  runGit(dir, ['commit', '-qm', 'init'])
  return dir
}

test('release: resume version integrity needs HEAD and the worktree at the target version (F-02)', () => {
  // The happy path: a committed release bump.
  assert.deepEqual(
    evaluateResumeVersionIntegrity({ targetVersion: '1.4.2', committedVersion: '1.4.2', worktreeVersion: '1.4.2' }),
    [],
  )
  // The audit T-02 scenario: a failed commit left the bump uncommitted; the
  // worktree says 1.4.2 but HEAD still says 1.4.0 -> resume must refuse.
  const dirtyBump = evaluateResumeVersionIntegrity({ targetVersion: '1.4.2', committedVersion: '1.4.0', worktreeVersion: '1.4.2' })
  assert.equal(dirtyBump.length, 1)
  assert.match(dirtyBump[0], /HEAD package\.json says "1\.4\.0".*not committed/)
  // The reverse (committed 1.4.2 but worktree reverted to 1.4.0) is also unsafe.
  const reverted = evaluateResumeVersionIntegrity({ targetVersion: '1.4.2', committedVersion: '1.4.2', worktreeVersion: '1.4.0' })
  assert.equal(reverted.length, 1)
  assert.match(reverted[0], /working-tree package\.json says "1\.4\.0"/)
  // Both wrong -> both problems reported, never a silent pass.
  assert.equal(
    evaluateResumeVersionIntegrity({ targetVersion: '1.4.2', committedVersion: '1.4.0', worktreeVersion: '1.4.1' }).length,
    2,
  )
  // A non-semver target is rejected instead of silently compared.
  assert.equal(evaluateResumeVersionIntegrity({ targetVersion: 'banana', committedVersion: 'x', worktreeVersion: 'x' }).length, 1)
})

test('release: assertTagMatchesVersion rejects a tag that describes another version (F-02)', { skip: GIT_AVAILABLE ? false : 'git is not available' }, async () => {
  const dir = makeTempGitRepo({ version: '1.4.0' })
  try {
    // A tag pointing at the 1.4.0 commit must not be used to publish 1.4.2.
    runGit(dir, ['tag', '-a', 'v1.4.2', '-m', 'v1.4.2'])
    await assert.rejects(
      () => assertTagMatchesVersion('v1.4.2', '1.4.2', { cwd: dir }),
      (error) => error instanceof ReleaseError && /points at a commit whose package\.json says 1\.4\.0, not 1\.4\.2/.test(error.message),
    )
    // A tag whose commit really is the released version passes.
    runGit(dir, ['tag', '-a', 'v1.4.0', '-m', 'v1.4.0'])
    await assertTagMatchesVersion('v1.4.0', '1.4.0', { cwd: dir })
    // A missing tag is an actionable error, not a crash.
    await assert.rejects(
      () => assertTagMatchesVersion('v9.9.9', '9.9.9', { cwd: dir }),
      (error) => error instanceof ReleaseError && /cannot be read/.test(error.message),
    )
    // readPackageVersionAtRef exposes the same data used by the check.
    assert.deepEqual(await readPackageVersionAtRef('v1.4.0', dir), { ok: true, version: '1.4.0', error: null })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('release: preflight fetch does not create .git/FETCH_HEAD (T-11 dry-run side effect)', { skip: GIT_AVAILABLE ? false : 'git is not available' }, () => {
  assert.deepEqual(fetchArgs(), ['fetch', '--quiet', '--no-write-fetch-head', 'origin', 'main'])
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-fetch-'))
  const bare = path.join(root, 'origin.git')
  const work = path.join(root, 'work')
  try {
    runGit(root, ['init', '--bare', '-q', bare])
    runGit(root, ['init', '-q', '-b', 'main', work])
    runGit(work, ['config', 'user.email', 'audit@example.com'])
    runGit(work, ['config', 'user.name', 'audit'])
    fs.writeFileSync(path.join(work, 'README.md'), 'fixture\n')
    runGit(work, ['add', '-A'])
    runGit(work, ['commit', '-qm', 'init'])
    runGit(work, ['remote', 'add', 'origin', 'file:///' + bare.replace(/\\/g, '/')])
    runGit(work, ['push', '-q', '-u', 'origin', 'main'])
    // Make the local clone one commit behind so fetch actually transfers data.
    fs.writeFileSync(path.join(work, 'README.md'), 'fixture 2\n')
    runGit(work, ['commit', '-qam', 'second'])
    runGit(work, ['push', '-q', 'origin', 'main'])
    runGit(work, ['reset', '-q', '--hard', 'HEAD~1'])
    fs.rmSync(path.join(work, '.git', 'FETCH_HEAD'), { force: true })

    const fetched = runGit(work, fetchArgs())
    assert.equal(fetched.status, 0, `fetch failed: ${fetched.stderr}`)
    assert.equal(fs.existsSync(path.join(work, '.git', 'FETCH_HEAD')), false, '--no-write-fetch-head must not create FETCH_HEAD')
    const remoteHead = runGit(work, ['ls-remote', 'origin', 'refs/heads/main']).stdout.split(/\s+/)[0]
    const tracked = runGit(work, ['rev-parse', 'origin/main']).stdout.trim()
    assert.equal(tracked, remoteHead, 'the remote-tracking ref must still be refreshed for the behind check')

    // Control: the historical plain fetch DOES create FETCH_HEAD (the side
    // effect the release tool used to have during --dry-run).
    runGit(work, ['fetch', '--quiet', 'origin', 'main'])
    assert.equal(fs.existsSync(path.join(work, '.git', 'FETCH_HEAD')), true, 'plain fetch writes FETCH_HEAD (control)')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
