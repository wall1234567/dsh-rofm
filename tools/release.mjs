/**
 * dsh-rofm - one-command release tool.
 *
 * Turns the maintainer checklist into a single auditable command:
 *
 *   node tools/release.mjs --bump patch --title "..." --yes
 *   node tools/release.mjs --version 1.4.0 --title "..." --yes
 *   node tools/release.mjs --resume          # finish an interrupted release
 *   node tools/release.mjs --bump patch --dry-run
 *
 * What it does, in order:
 *
 *   1. preflight: clean git tree on main, not behind origin/main, package.json and
 *      engine/package.json versions agree, CHANGELOG.md already has the target
 *      version section, and tag / npm version / GitHub Release do not exist yet;
 *   2. checks: node --test, test/simulate.mjs, tools/selfcheck.mjs, engine CLI help
 *      and npm pack --dry-run (no runtime memory data inside the tarball);
 *   3. version bump in package.json + engine/package.json, one release commit,
 *      annotated tag vX.Y.Z;
 *   4. git push origin main + tag;
 *   5. npm publish - when npm asks for a one-time password (2FA) the tool prints
 *      the npm authorization URL, opens the browser and waits for the confirmation,
 *      then retries the publish automatically;
 *   6. GitHub Release for the tag, with the CHANGELOG section as release notes.
 *
 * Why the npm dance: npm's CLI redacts the 2FA authorization URL on screen and
 * only offers the interactive flow on a real TTY, so a plain scripted "npm
 * publish" dies with EOTP. This tool installs a tiny NODE_OPTIONS --require hook
 * that persists the raw EOTP response body, then polls npm's done-url itself.
 *
 * The tool is zero-dependency and cross-platform (Windows / Linux / macOS); it is
 * pure maintainer tooling, never imported by the plugin runtime. Only Node
 * builtins are used. The test suite covers its pure helpers (test/release.test.mjs).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import tls from 'node:tls'
import readline from 'node:readline/promises'

import { invokedAsMain } from './main-module.mjs'

/** Absolute path of the repository root (this file lives in <root>/tools). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** npm package name this tool releases. */
export const PACKAGE_NAME = 'dsh-rofm'
/** Release branch a release is cut from. */
export const MAIN_BRANCH = 'main'
/** Release tag prefix: v1.2.3. */
export const TAG_PREFIX = 'v'
/** Allowed --bump levels. */
export const BUMP_LEVELS = ['patch', 'minor', 'major']

const PACKAGE_FILE = 'package.json'
const ENGINE_PACKAGE_FILE = path.join('engine', 'package.json')
const CHANGELOG_FILE = 'CHANGELOG.md'
const RELEASE_COMMIT_PREFIX = 'release: ' + PACKAGE_NAME + ' '
const GITHUB_API = 'https://api.github.com'
const NPM_DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const NPM_TOKEN_CONFIG_KEYS = ['//registry.npmjs.org/:_authToken', '_authToken']
const OTP_POLL_TIMEOUT_MS = 10 * 60 * 1000
const OTP_POLL_FALLBACK_MS = 3000
const REGISTRY_WAIT_TIMEOUT_MS = 6 * 60 * 1000
const REGISTRY_WAIT_INTERVAL_MS = 10 * 1000
const CHILD_TIMEOUT_MS = 30 * 60 * 1000
const TLS_ERROR_PATTERN = /CRYPT_E_NO_REVOCATION_CHECK|schannel[^\n]*failed|SSL certificate problem|server certificate verification failed|certificate verify failed/i

/** Exit code for a completed release. */
export const EXIT_OK = 0
/** Exit code for a failed or aborted release. */
export const EXIT_FAILED = 1
/** Exit code for invalid command line arguments. */
export const EXIT_USAGE = 2

export const USAGE = [
  'dsh-rofm release tool',
  '',
  'Usage:',
  '  node tools/release.mjs --bump <patch|minor|major> [options]',
  '  node tools/release.mjs --version <x.y.z> [options]',
  '  node tools/release.mjs --resume [options]',
  '',
  'Modes (choose exactly one):',
  '  --bump <level>        bump the current version by patch/minor/major',
  '  --version <x.y.z>     release an explicit version (must be greater than the current one)',
  '  --resume              finish an interrupted release of the current package.json version',
  '',
  'Options:',
  '  --title <text>        release title (commit message and GitHub Release name)',
  '  --dry-run             run every check and print the plan, change nothing',
  '  --yes, -y             do not ask for confirmation (required when stdin is not a TTY)',
  '  --skip-tests          skip node --test / simulate / selfcheck / CLI smoke test',
  '  --skip-npm            do not publish to npm',
  '  --skip-github         do not create the GitHub Release',
  '  --skip-push           commit and tag locally, do not push',
  '  --no-browser          do not open a browser for the npm 2FA confirmation',
  '  --otp <code>          pass a one-time password to npm directly',
  '  --allow-dirty         allow an unclean working tree (not recommended)',
  '  --help, -h            show this help',
  '',
  'Environment:',
  '  GITHUB_TOKEN / GH_TOKEN   token used to create the GitHub Release',
  '                           (falls back to the git credential manager entry)',
  '  NPM_CLI                   path to npm-cli.js when npm is not on PATH',
  '  NPM_TOKEN                 npm token override (normally read from npm config)',
].join('\n')

/** Script written to a temp file and preloaded into the npm child (exported for tests). */
export const EOTP_HOOK_SOURCE = [
  "'use strict'",
  '// Installed for one npm child process by tools/release.mjs (NODE_OPTIONS --require hook).',
  '// The npm CLI redacts the 2FA authorization URL on screen, so we persist the raw',
  '// EOTP response body here and let the release tool poll it.',
  "const Module = require('node:module')",
  "const fs = require('node:fs')",
  'const originalLoad = Module._load',
  'const outputPath = process.env.DSH_ROFM_EOTP_BODY',
  'Module._load = function load(request, parent, isMain) {',
  '  const exported = originalLoad.apply(this, arguments)',
  '  try {',
  "    if (outputPath && exported && typeof exported === 'object' && parent && typeof parent.filename === 'string') {",
  "      const normalized = parent.filename.replace(/\\\\/g, '/')",
  "      if (request === './errors.js' && normalized.endsWith('npm-registry-fetch/lib/check-response.js')) {",
  '        const Original = exported.HttpErrorAuthOTP',
  '        if (typeof Original === "function" && !Original.__dshRofmPatched) {',
  '          class DumpedAuthOTP extends Original {',
  '            constructor(method, response, body, spec) {',
  '              super(method, response, body, spec)',
  '              try { fs.writeFileSync(outputPath, JSON.stringify(body)) } catch (error) {}',
  '            }',
  '          }',
  '          DumpedAuthOTP.__dshRofmPatched = true',
  "          Object.defineProperty(exported, 'HttpErrorAuthOTP', { value: DumpedAuthOTP, writable: true, configurable: true })",
  '        }',
  '      }',
  '    }',
  '  } catch (error) {}',
  '  return exported',
  '}',
].join('\n')

/** Error carrying a "what to do next" hint for the operator. */
export class ReleaseError extends Error {
  constructor(message, recovery = '') {
    super(message)
    this.name = 'ReleaseError'
    this.recovery = recovery
  }
}

// ---------------------------------------------------------------------------
// pure helpers (unit tested by test/release.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Parse a strict semantic version ("1.2.3"). Returns null for anything else.
 * @param {string} text
 * @returns {{major:number, minor:number, patch:number} | null}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** Format a version object back to "x.y.z". */
export function formatVersion(version) {
  return version.major + '.' + version.minor + '.' + version.patch
}

/**
 * Bump a version string by one of patch/minor/major.
 * @param {string} current
 * @param {'patch'|'minor'|'major'} level
 * @returns {string}
 */
export function bumpVersion(current, level) {
  const version = parseVersion(current)
  if (!version) throw new ReleaseError('current version is not semver: ' + current)
  if (!BUMP_LEVELS.includes(level)) throw new ReleaseError('bump level must be one of ' + BUMP_LEVELS.join(', ') + ', got: ' + level)
  if (level === 'major') return formatVersion({ major: version.major + 1, minor: 0, patch: 0 })
  if (level === 'minor') return formatVersion({ major: version.major, minor: version.minor + 1, patch: 0 })
  return formatVersion({ major: version.major, minor: version.minor, patch: version.patch + 1 })
}

/**
 * True when version a is strictly greater than version b.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function versionGreater(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return false
  if (left.major !== right.major) return left.major > right.major
  if (left.minor !== right.minor) return left.minor > right.minor
  return left.patch > right.patch
}

/** "v1.2.3" for a version string. */
export function tagName(version) {
  return TAG_PREFIX + version
}

/**
 * Work out the version a run targets.
 * Throws for a downgrade or an invalid --bump/--version combination.
 * @param {string} current
 * @param {object} options parsed CLI options
 * @returns {{version:string, mode:'release'|'resume'}}
 */
export function resolveTargetVersion(current, options) {
  const parsedCurrent = parseVersion(current)
  if (!parsedCurrent) throw new ReleaseError('package.json version is not semver: ' + current)
  if (options.resume) return { version: formatVersion(parsedCurrent), mode: 'resume' }
  if (options.version !== null && options.version !== undefined) {
    if (!parseVersion(options.version)) throw new ReleaseError('--version must be x.y.z, got: ' + options.version)
    if (!versionGreater(options.version, current)) throw new ReleaseError('target version ' + options.version + ' must be greater than current version ' + current)
    return { version: options.version, mode: 'release' }
  }
  return { version: bumpVersion(current, options.bump), mode: 'release' }
}

/**
 * Resume-mode version integrity check (v1.4.1, audit F-02).
 *
 * A `--resume` run attempts to finish a release whose version bump is supposed
 * to be committed already. Historically the tool blindly tagged whatever HEAD
 * was, while `npm publish` read the WORKING-TREE package.json — so a failed
 * `git commit` followed by `--resume --allow-dirty` could tag a commit whose
 * package.json still said 1.4.0 while publishing 1.4.2 (audit T-02).
 *
 * Pure helper: the caller reads the two version sources (committed HEAD and
 * the dirty/clean working tree) and gets the human-readable problems back.
 *
 * @param {{targetVersion:string, committedVersion:string, worktreeVersion:string}} input
 * @returns {string[]} problems (empty = safe to resume)
 */
export function evaluateResumeVersionIntegrity({ targetVersion, committedVersion, worktreeVersion }) {
  const problems = []
  if (!parseVersion(targetVersion)) return [`target version is not semver: ${JSON.stringify(targetVersion)}`]
  if (committedVersion !== targetVersion) {
    problems.push(
      `HEAD package.json says ${JSON.stringify(committedVersion)} but the release targets ${JSON.stringify(targetVersion)} ` +
        '(the version bump is not committed yet)',
    )
  }
  if (worktreeVersion !== targetVersion) {
    problems.push(
      `working-tree package.json says ${JSON.stringify(worktreeVersion)} but the release targets ${JSON.stringify(targetVersion)}`,
    )
  }
  return problems
}

/**
 * `git fetch` arguments used by preflight. `--no-write-fetch-head` keeps
 * `--dry-run` from creating/rewriting `.git/FETCH_HEAD` (audit T-11); the
 * remote-tracking refs are still refreshed, which is what the behind check needs.
 * @param {string} [branch]
 * @returns {string[]}
 */
export function fetchArgs(branch = MAIN_BRANCH) {
  return ['fetch', '--quiet', '--no-write-fetch-head', 'origin', branch]
}

/**
 * Version recorded in `package.json` at one git ref (tag, branch or SHA).
 * @param {string} ref
 * @param {string} [cwd]
 * @returns {Promise<{ok:boolean, version:string|null, error:string|null}>}
 */
export async function readPackageVersionAtRef(ref, cwd = REPO_ROOT) {
  const shown = await run('git', ['show', String(ref) + ':package.json'], { cwd })
  if (shown.code !== 0) return { ok: false, version: null, error: outputTail(shown) }
  try {
    const parsed = JSON.parse(shown.stdout)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'string') {
      return { ok: false, version: null, error: 'package.json has no string version' }
    }
    return { ok: true, version: parsed.version, error: null }
  } catch (error) {
    return { ok: false, version: null, error: 'package.json at ' + ref + ' is not valid JSON: ' + error.message }
  }
}

/**
 * Assert that an existing/created release tag points at a commit whose
 * package.json version is the version being released (audit F-02). Without this
 * a resume could publish artifacts that the tag does not describe.
 *
 * @param {string} tag
 * @param {string} version
 * @param {{cwd?:string, log?:object}} [options]
 * @returns {Promise<void>} throws ReleaseError on mismatch
 */
export async function assertTagMatchesVersion(tag, version, options = {}) {
  const cwd = options.cwd || REPO_ROOT
  const log = options.log
  const committed = await readPackageVersionAtRef(tag, cwd)
  if (!committed.ok) {
    throw new ReleaseError(
      'tag ' + tag + ' exists but its package.json cannot be read: ' + committed.error,
      'Inspect the tag (`git show ' + tag + ':package.json`) or delete it and bump the version.',
    )
  }
  if (committed.version !== version) {
    throw new ReleaseError(
      'tag ' + tag + ' points at a commit whose package.json says ' + committed.version + ', not ' + version,
      'Delete the wrong tag (git tag -d ' + tag + '), commit the version bump, then re-run with --resume.',
    )
  }
  if (log) log.ok('tag ' + tag + ' commit package.json version is ' + version)
}

/**
 * Extract one version section from CHANGELOG.md.
 * The section starts at "## [<version>]" and ends before the next "## " heading.
 * @param {string} changelog
 * @param {string} version
 * @returns {{heading:string, body:string} | null}
 */
export function extractChangelogSection(changelog, version) {
  if (typeof changelog !== 'string' || typeof version !== 'string' || version.length === 0) return null
  const escaped = version.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
  const headingMatch = new RegExp('^## \\[' + escaped + '\\][^\n]*', 'm').exec(changelog)
  if (!headingMatch) return null
  const rest = changelog.slice(headingMatch.index + headingMatch[0].length)
  const nextHeading = /^## /m.exec(rest)
  const rawBody = nextHeading ? rest.slice(0, nextHeading.index) : rest
  return { heading: headingMatch[0], body: rawBody.replace(/^\s+/, '').replace(/\s+$/, '') }
}

/** Release notes body: an H1 with the package name + version, then the changelog section. */
export function buildReleaseBody(version, sectionBody) {
  const body = typeof sectionBody === 'string' ? sectionBody.trim() : ''
  return '# ' + PACKAGE_NAME + ' ' + version + '\n\n' + body + '\n'
}

/** GitHub Release name, e.g. "dsh-rofm 1.2.3" or "dsh-rofm 1.2.3 - title". */
export function buildReleaseName(version, title) {
  const text = typeof title === 'string' ? title.trim() : ''
  return PACKAGE_NAME + ' ' + version + (text.length > 0 ? ' \u2014 ' + text : '')
}

/** Commit subject for a release commit. */
export function releaseCommitMessage(version, title) {
  const text = typeof title === 'string' ? title.trim() : ''
  return RELEASE_COMMIT_PREFIX + version + (text.length > 0 ? ' \u2014 ' + text : '')
}

/**
 * Parse a GitHub remote URL into owner/repo.
 * Supports https, ssh://git@, git@github.com: and a bare github.com/owner/repo.
 * @param {string} url
 * @returns {{owner:string, repo:string} | null}
 */
export function parseGitHubRemote(url) {
  if (typeof url !== 'string') return null
  const text = url.trim()
  const patterns = [
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
    /^(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    /^github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return { owner: match[1], repo: match[2] }
  }
  return null
}

/**
 * Parse the command line of the release tool (pure; no I/O).
 * @param {string[]} argv
 * @returns {object} normalized options
 */
export function parseCliArgs(argv) {
  const options = {
    help: false,
    resume: false,
    bump: null,
    version: null,
    title: '',
    dryRun: false,
    yes: false,
    skipTests: false,
    skipNpm: false,
    skipGithub: false,
    skipPush: false,
    noBrowser: false,
    otp: null,
    allowDirty: false,
  }
  const args = Array.isArray(argv) ? argv : []
  const readValue = (index, flag) => {
    const value = args[index + 1]
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new ReleaseError('missing value for ' + flag + '\n\n' + USAGE)
    }
    return value
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--resume') options.resume = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--skip-tests') options.skipTests = true
    else if (arg === '--skip-npm') options.skipNpm = true
    else if (arg === '--skip-github') options.skipGithub = true
    else if (arg === '--skip-push') options.skipPush = true
    else if (arg === '--no-browser') options.noBrowser = true
    else if (arg === '--allow-dirty') options.allowDirty = true
    else if (arg === '--bump') { options.bump = readValue(index, '--bump'); index += 1 }
    else if (arg === '--version') { options.version = readValue(index, '--version'); index += 1 }
    else if (arg === '--title') { options.title = readValue(index, '--title'); index += 1 }
    else if (arg === '--otp') { options.otp = readValue(index, '--otp'); index += 1 }
    else throw new ReleaseError('unknown argument: ' + arg + '\n\n' + USAGE)
  }
  if (options.help) return options
  const modes = [options.bump !== null, options.version !== null, options.resume].filter(Boolean).length
  if (modes !== 1) throw new ReleaseError('choose exactly one of --bump, --version or --resume\n\n' + USAGE)
  if (options.bump !== null && !BUMP_LEVELS.includes(options.bump)) throw new ReleaseError('--bump must be one of ' + BUMP_LEVELS.join(', '))
  if (options.version !== null && !parseVersion(options.version)) throw new ReleaseError('--version must be x.y.z, got: ' + options.version)
  return options
}

/**
 * Command that opens a URL in the platform's default browser.
 * Pure: the platform is injectable so all three cases can be unit tested.
 * @param {string} url
 * @param {string} [platform] defaults to the host platform
 * @returns {{command:string, args:string[]}}
 */
export function openCommandFor(url, platform) {
  const target = String(url)
  const host = typeof platform === 'string' && platform.length > 0 ? platform : os.platform()
  if (host === 'win32') return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', target] }
  if (host === 'darwin') return { command: 'open', args: [target] }
  return { command: 'xdg-open', args: [target] }
}

/** Quote one argument for a POSIX shell / the cmd.exe command line. */
export function shellQuote(argument) {
  const value = String(argument)
  if (/^[A-Za-z0-9@%_+=:,./\\-]+$/.test(value)) return value
  return '"' + value.replace(/(["\\])/g, '\\$1') + '"'
}

/**
 * Wrap an argv list in a platform shell command (used when npm is only on PATH).
 * @param {string[]} args
 * @param {string} [platform]
 * @returns {{command:string, args:string[]}}
 */
export function shellCommandFor(args, platform) {
  const commandLine = (Array.isArray(args) ? args : []).map(shellQuote).join(' ')
  const host = typeof platform === 'string' && platform.length > 0 ? platform : os.platform()
  if (host === 'win32') return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', commandLine] }
  return { command: process.env.SHELL || 'sh', args: ['-c', commandLine] }
}

/**
 * Add the operating system certificate store to Node's default CA bundle.
 * Node >= 24 exposes tls.getCACertificates/setDefaultCACertificates, which is
 * what makes the release tool work behind a TLS-inspecting corporate proxy
 * (Windows/macOS system roots) without disabling verification. Older Node
 * versions fall back to the one-shot unverified retry in requestJson().
 * @param {object} [tlsModule] injectable for tests
 * @returns {boolean} whether the system store was installed
 */
export function installSystemCertificates(tlsModule = tls) {
  try {
    const getCertificates = tlsModule && tlsModule.getCACertificates
    const setCertificates = tlsModule && tlsModule.setDefaultCACertificates
    if (typeof getCertificates !== 'function' || typeof setCertificates !== 'function') return false
    const certificates = []
    for (const kind of ['system', 'extra']) {
      const bundle = getCertificates(kind)
      if (Array.isArray(bundle)) certificates.push(...bundle)
    }
    if (certificates.length === 0) return false
    setCertificates(certificates)
    return true
  } catch (error) {
    return false
  }
}

/** Value for NODE_OPTIONS that preloads the EOTP hook (quoted when the path has spaces). */
export function nodeOptionsForRequire(hookPath) {
  const value = String(hookPath)
  return '--require ' + (/\s/.test(value) ? '"' + value + '"' : value)
}

/**
 * Validate the file list of "npm pack --dry-run".
 * @param {string} output combined stdout/stderr of npm pack --dry-run
 * @returns {string[]} problems (empty when the tarball content is fine)
 */
export function validatePackOutput(output) {
  const text = typeof output === 'string' ? output : ''
  const problems = []
  if (!/(?:^|\s)memory\/\.gitkeep(?:\s|$)/m.test(text)) problems.push('memory/.gitkeep is missing from the npm tarball')
  if (/memory\/(?:sessions|\.compat-state)/.test(text)) problems.push('runtime memory data is inside the npm tarball')
  if (/(?:^|\s)test\/\S+\.test\.mjs/m.test(text)) problems.push('test files are inside the npm tarball')
  return problems
}

/**
 * Pull the web-auth URL pair out of a raw npm EOTP response body.
 * @param {unknown} body parsed JSON body
 * @returns {{authUrl:string, doneUrl:string} | null}
 */
export function extractOtpUrls(body) {
  if (body === null || typeof body !== 'object') return null
  const pick = (value) => (typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value) ? value : null)
  const authUrl = pick(body.authUrl)
  const doneUrl = pick(body.doneUrl)
  if (!authUrl || !doneUrl) return null
  return { authUrl, doneUrl }
}

// ---------------------------------------------------------------------------
// child process helpers
// ---------------------------------------------------------------------------

const activeChildren = new Set()

/**
 * Run a child process and capture its output.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?:string, env?:Record<string,string>, input?:string|null, timeoutMs?:number, quiet?:boolean}} [options]
 * @returns {Promise<{code:number, signal:string|null, stdout:string, stderr:string}>}
 */
function run(command, args, options = {}) {
  const cwd = options.cwd || REPO_ROOT
  const env = { ...process.env, ...(options.env || {}) }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : CHILD_TIMEOUT_MS
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ code: -1, signal: null, stdout: '', stderr: String((error && error.message) || error) })
      return
    }
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    let finished = false
    const finish = (code, signal) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      activeChildren.delete(child)
      resolve({ code: code === null || code === undefined ? -1 : code, signal: signal || null, stdout, stderr })
    }
    const timer = setTimeout(() => { try { child.kill() } catch (error) {} }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { stderr += String((error && error.message) || error) })
    child.on('close', finish)
    try { child.stdin.end(options.input === undefined || options.input === null ? '' : String(options.input)) } catch (error) {}
  })
}

/** Last lines of a child process output, trimmed for error messages. */
function outputTail(result, maxLines = 25) {
  const text = ((result.stdout || '') + '\n' + (result.stderr || '')).trim()
  if (text.length === 0) return '(no output)'
  const tail = text.split('\n').slice(-maxLines).join('\n')
  return tail.length > 4000 ? tail.slice(-4000) : tail
}

/**
 * git command with a one-shot fallback for the Windows schannel revocation-check
 * failure (GIT_SSL_NO_VERIFY only for that single command; never persisted).
 */
async function git(args, options = {}) {
  const first = await run('git', args, options)
  if (first.code === 0 || !TLS_ERROR_PATTERN.test(first.stderr)) return first
  const logger = options.log
  if (logger) {
    logger.warn('git could not verify the TLS certificate (Windows schannel / revocation check).')
    logger.warn('Retrying this one command with GIT_SSL_NO_VERIFY=1. Permanent fix: use an SSH remote')
    logger.warn('(git@github.com:owner/repo.git) or repair the Windows CA / revocation store.')
  }
  return run('git', args, { ...options, env: { ...(options.env || {}), GIT_SSL_NO_VERIFY: '1' } })
}

/** Resolve the npm CLI to use: explicit env, npm_execpath, ~/.npm-cli layout, then PATH. */
async function detectNpm() {
  const cliCandidates = []
  if (process.env.NPM_CLI) cliCandidates.push(process.env.NPM_CLI)
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) cliCandidates.push(process.env.npm_execpath)
  const homeNpm = path.join(os.homedir(), '.npm-cli', 'bin', 'npm-cli.js')
  cliCandidates.push(homeNpm)
  for (const cliPath of cliCandidates) {
    if (!cliPath || !fs.existsSync(cliPath)) continue
    const probe = await run(process.execPath, [cliPath, '--version'])
    if (probe.code === 0) return { kind: 'cli', cliPath, version: probe.stdout.trim(), homeNpm: cliPath === homeNpm }
  }
  const probe = await run(shellCommandFor(['npm', '--version']).command, shellCommandFor(['npm', '--version']).args)
  if (probe.code === 0) return { kind: 'path', cliPath: null, version: probe.stdout.trim(), homeNpm: false }
  return null
}

/** Run npm with the detected CLI shape. */
function runNpm(npm, args, options = {}) {
  if (!npm) return Promise.resolve({ code: -1, signal: null, stdout: '', stderr: 'npm is not available' })
  if (npm.kind === 'cli') return run(process.execPath, [npm.cliPath, ...args], options)
  const shell = shellCommandFor(['npm', ...args])
  return run(shell.command, shell.args, options)
}

/** "1.2.3" when that exact version exists on the npm registry, else null. */
async function npmViewVersion(npm, spec) {
  const result = await runNpm(npm, ['view', spec, 'version'])
  if (result.code !== 0) return null
  const lines = (result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return null
  return lines[lines.length - 1].replace(/^['"]|['"]$/g, '')
}

/** Read the npm auth token from environment or npm config (never logged). */
async function readNpmToken(npm) {
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN.trim()
  for (const key of NPM_TOKEN_CONFIG_KEYS) {
    const result = await runNpm(npm, ['config', 'get', key])
    if (result.code !== 0) continue
    const value = (result.stdout || '').trim()
    if (value.length > 0 && value !== 'undefined' && value !== 'null') return value
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    return null
  }
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

/** True for the TLS certificate verification failures a corporate proxy produces. */
export function isCertificateError(error) {
  if (!error) return false
  const text = String(error.code || '') + ' ' + String(error.message || '')
  return /CERT|certificate|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/i.test(text)
}

function httpsJson({ url, method = 'GET', headers = {}, payload = null, rejectUnauthorized = true, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers, rejectUnauthorized, timeout: timeoutMs }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = null
        try { data = text.trim().length > 0 ? JSON.parse(text) : null } catch (error) { data = null }
        resolve({ status: response.statusCode || 0, headers: response.headers || {}, data, text })
      })
    })
    request.on('timeout', () => request.destroy(new Error('HTTPS request timed out after ' + timeoutMs + 'ms')))
    request.on('error', reject)
    if (payload !== null) request.write(JSON.stringify(payload))
    request.end()
  })
}

/**
 * HTTPS JSON request with a certificate-error fallback:
 * first retry trusts the OS store (Node >= 24), then a last-resort retry skips
 * verification with a loud warning (Node 20/22). All other errors propagate.
 */
async function requestJson({ url, method = 'GET', headers = {}, payload = null, log, label }) {
  try {
    return await httpsJson({ url, method, headers, payload })
  } catch (error) {
    if (!isCertificateError(error) || !log) throw error
    log.warn('HTTPS certificate verification failed for ' + (label || url) + ': ' + error.message)
    if (installSystemCertificates()) {
      log.warn('Installed the operating system certificate store for this process; retrying with verification enabled.')
      return httpsJson({ url, method, headers, payload })
    }
    log.warn('Retrying once without certificate verification (old Node without --use-system-ca).')
    log.warn('If this machine uses a corporate TLS proxy, point NODE_EXTRA_CA_CERTS at its root CA to silence this.')
    return httpsJson({ url, method, headers, payload, rejectUnauthorized: false })
  }
}

async function githubRequest({ token, method = 'GET', apiPath, payload = null, log }) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: 'Bearer ' + token,
    'user-agent': 'dsh-rofm-release-tool',
    'x-github-api-version': '2022-11-28',
  }
  if (payload !== null) headers['content-type'] = 'application/json'
  const response = await requestJson({ url: GITHUB_API + apiPath, method, headers, payload, log, label: 'api.github.com' })
  return { status: response.status, data: response.data }
}

async function resolveGithubToken() {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (envToken && envToken.trim().length > 0) return envToken.trim()
  const credential = await run('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' })
  if (credential.code === 0) {
    const match = /^password=(.+)$/m.exec(credential.stdout || '')
    if (match) return match[1].trim()
  }
  return null
}

async function findGithubRelease({ token, repo, tag, log }) {
  const response = await githubRequest({ token, method: 'GET', apiPath: '/repos/' + repo.owner + '/' + repo.repo + '/releases/tags/' + tag, log })
  if (response.status === 200 && response.data && typeof response.data.html_url === 'string') return response.data.html_url
  return null
}

// ---------------------------------------------------------------------------
// npm publish with the browser 2FA flow
// ---------------------------------------------------------------------------

async function pollNpmAuth(doneUrl, token, log) {
  const deadline = Date.now() + OTP_POLL_TIMEOUT_MS
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    let response
    try {
      const headers = { accept: 'application/json', 'user-agent': 'dsh-rofm-release-tool' }
      if (token) headers.authorization = 'Bearer ' + token
      response = await requestJson({ url: doneUrl, headers, log, label: 'registry.npmjs.org' })
    } catch (error) {
      log.warn('waiting for the npm 2FA confirmation (network error: ' + error.message + '), retrying...')
      await sleep(OTP_POLL_FALLBACK_MS)
      continue
    }
    const data = response.data
    if (response.status === 200 && data && typeof data.token === 'string' && data.token.length > 0) {
      log.ok('npm 2FA confirmed')
      return data.token
    }
    if (response.status === 202) {
      const retryAfter = Number((response.headers && response.headers['retry-after']) || 0)
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : OTP_POLL_FALLBACK_MS
      if (attempt === 1 || attempt % 5 === 0) log.info('waiting for the browser confirmation... (' + attempt + ' checks)')
      await sleep(Math.max(1000, waitMs))
      continue
    }
    throw new ReleaseError('npm 2FA check failed with HTTP ' + response.status + ': ' + JSON.stringify(data), 'Run npm publish once by hand in a real terminal; if that works, retry this tool. Do not use --otp with a stale code.')
  }
  throw new ReleaseError('timed out after 10 minutes waiting for the npm 2FA confirmation', 'Run the tool again with --no-browser and open the printed URL manually.')
}

async function waitForNpmVersion(npm, version, log) {
  const deadline = Date.now() + REGISTRY_WAIT_TIMEOUT_MS
  let lastLog = Date.now()
  while (Date.now() < deadline) {
    const live = await npmViewVersion(npm, PACKAGE_NAME + '@' + version)
    if (live === version) {
      log.ok('registry now serves ' + PACKAGE_NAME + '@' + version)
      return true
    }
    if (Date.now() - lastLog > 30000) {
      log.info('npm is still processing the publish; waiting for the registry...')
      lastLog = Date.now()
    }
    await sleep(REGISTRY_WAIT_INTERVAL_MS)
  }
  log.warn('npm accepted the publish but the registry does not serve the version yet;')
  log.warn('check https://www.npmjs.com/package/' + PACKAGE_NAME + '/v/' + version + ' in a minute.')
  return false
}

async function publishToNpm({ npm, version, options, log }) {
  if (!npm) throw new ReleaseError('npm is not available', 'Put npm on PATH or set NPM_CLI to npm-cli.js.')
  const alreadyLive = (await npmViewVersion(npm, PACKAGE_NAME + '@' + version)) === version
  if (alreadyLive) {
    log.info(PACKAGE_NAME + '@' + version + ' is already published to npm, skipping publish')
    return { status: 'already-published', visible: true }
  }
  if (options.otp) {
    log.info('publishing with the one-time password from --otp')
    const result = await runNpm(npm, ['publish', '--otp=' + options.otp])
    if (result.code !== 0) throw new ReleaseError('npm publish failed:\n' + outputTail(result), 'Run node tools/release.mjs --resume after checking npm manually.')
    log.ok('npm publish accepted')
    return { status: 'published', visible: await waitForNpmVersion(npm, version, log) }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-release-'))
  const hookPath = path.join(tempDir, 'eotp-hook.cjs')
  const bodyPath = path.join(tempDir, 'eotp-body.json')
  try {
    fs.writeFileSync(hookPath, EOTP_HOOK_SOURCE, 'utf8')
    log.info('npm publish ' + PACKAGE_NAME + '@' + version)
    const first = await runNpm(npm, ['publish'], {
      env: { NODE_OPTIONS: nodeOptionsForRequire(hookPath), DSH_ROFM_EOTP_BODY: bodyPath },
    })
    if (first.code === 0) {
      log.ok('npm publish accepted')
      return { status: 'published', visible: await waitForNpmVersion(npm, version, log) }
    }
    const urls = extractOtpUrls(readJsonFile(bodyPath))
    if (!urls) {
      const otpHint = /EOTP|one-time pass/i.test(first.stdout + first.stderr)
      const recovery = otpHint
        ? 'npm requires a one-time password but the authorization URL could not be captured. Run "npm publish" in a real terminal once, or pass --otp <code>.'
        : 'Check the npm output above and run node tools/release.mjs --resume when fixed.'
      throw new ReleaseError('npm publish failed:\n' + outputTail(first), recovery)
    }
    log.info('npm requires a one-time password (2FA).')
    log.info('Open this URL in a browser and confirm the npm prompt:')
    log.plain('  ' + urls.authUrl)
    if (!options.noBrowser) {
      const opener = openCommandFor(urls.authUrl)
      try {
        const child = spawn(opener.command, opener.args, { stdio: 'ignore', windowsHide: false })
        child.unref()
      } catch (error) {
        log.warn('could not open the browser automatically; open the URL above manually.')
      }
    }
    const token = await readNpmToken(npm)
    if (!token) log.warn('could not read the npm token from npm config; polling the done-url without auth headers.')
    const otp = await pollNpmAuth(urls.doneUrl, token, log)
    log.info('retrying npm publish with the confirmed one-time password')
    const second = await runNpm(npm, ['publish', '--otp=' + otp])
    if (second.code !== 0) throw new ReleaseError('npm publish failed after the 2FA confirmation:\n' + outputTail(second), 'Run node tools/release.mjs --resume once the problem is fixed.')
    log.ok('npm publish accepted')
    return { status: 'published', visible: await waitForNpmVersion(npm, version, log) }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (error) {}
  }
}

async function createGithubRelease({ repo, version, section, token, title, log }) {
  const tag = tagName(version)
  const existing = await findGithubRelease({ token, repo, tag, log })
  if (existing) {
    log.warn('GitHub Release ' + tag + ' already exists: ' + existing)
    return existing
  }
  const payload = {
    tag_name: tag,
    name: buildReleaseName(version, title),
    body: buildReleaseBody(version, section.body),
    draft: false,
    prerelease: false,
    make_latest: 'true',
  }
  log.info('creating GitHub Release ' + tag)
  const response = await githubRequest({ token, method: 'POST', apiPath: '/repos/' + repo.owner + '/' + repo.repo + '/releases', payload, log })
  if (response.status === 201 && response.data && typeof response.data.html_url === 'string') {
    log.ok('GitHub Release created: ' + response.data.html_url)
    return response.data.html_url
  }
  if (response.status === 422 && /already_exists/.test(JSON.stringify(response.data))) {
    log.warn('GitHub Release ' + tag + ' was created concurrently; treating it as done')
    return findGithubRelease({ token, repo, tag, log })
  }
  throw new ReleaseError('GitHub Release creation failed (HTTP ' + response.status + '): ' + JSON.stringify(response.data).slice(0, 500), 'Re-run node tools/release.mjs --resume once the API problem is fixed.')
}

// ---------------------------------------------------------------------------
// repository context and preflight
// ---------------------------------------------------------------------------

function readContext() {
  const packagePath = path.join(REPO_ROOT, PACKAGE_FILE)
  const enginePackagePath = path.join(REPO_ROOT, ENGINE_PACKAGE_FILE)
  const changelogPath = path.join(REPO_ROOT, CHANGELOG_FILE)
  const required = [[PACKAGE_FILE, packagePath], ['engine/package.json', enginePackagePath], [CHANGELOG_FILE, changelogPath]]
  for (const [label, filePath] of required) {
    if (!fs.existsSync(filePath)) throw new ReleaseError('missing ' + label + ' in ' + REPO_ROOT)
  }
  let pkg = null
  let enginePkg = null
  try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) } catch (error) { throw new ReleaseError(PACKAGE_FILE + ' is not valid JSON: ' + error.message) }
  try { enginePkg = JSON.parse(fs.readFileSync(enginePackagePath, 'utf8')) } catch (error) { throw new ReleaseError('engine/package.json is not valid JSON: ' + error.message) }
  if (!pkg || pkg.name !== PACKAGE_NAME) throw new ReleaseError('this tool releases ' + PACKAGE_NAME + ', but package.json says ' + (pkg && pkg.name))
  return { packagePath, enginePackagePath, changelogPath, pkg, enginePkg, changelog: fs.readFileSync(changelogPath, 'utf8') }
}

async function runCheckSuite({ log }) {
  const node = process.execPath
  const steps = [
    ['node --test', ['--test']],
    ['node test/simulate.mjs', ['test/simulate.mjs']],
    ['node tools/selfcheck.mjs', ['tools/selfcheck.mjs']],
    ['node engine/cli.mjs --help', ['engine/cli.mjs', '--help']],
  ]
  for (const [label, args] of steps) {
    log.info(label + ' ...')
    const result = await run(node, args, { cwd: REPO_ROOT })
    if (result.code !== 0) {
      throw new ReleaseError(label + ' failed (exit ' + result.code + '):\n' + outputTail(result), 'Fix the failure first, or pass --skip-tests to override (not recommended).')
    }
    log.ok(label + ' passed')
  }
}

function writeVersionFile(filePath, version) {
  const text = fs.readFileSync(filePath, 'utf8')
  const pattern = /("version"\s*:\s*")[^"]*(")/
  if (!pattern.test(text)) throw new ReleaseError('could not find a "version" field in ' + filePath)
  fs.writeFileSync(filePath, text.replace(pattern, '$1' + version + '$2'), 'utf8')
}

async function preflight({ options, context, log }) {
  log.step('Preflight checks')
  const inside = await git(['rev-parse', '--is-inside-work-tree'], { log })
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw new ReleaseError('not a git checkout: ' + REPO_ROOT)
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { log })).stdout.trim()
  if (branch !== MAIN_BRANCH) throw new ReleaseError('releases are cut from ' + MAIN_BRANCH + ', current branch is ' + branch, 'Switch back to ' + MAIN_BRANCH + ' first.')
  log.ok('branch: ' + branch)

  const status = await git(['status', '--porcelain'], { log })
  const dirty = (status.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (dirty.length > 0) {
    if (!options.allowDirty) throw new ReleaseError('working tree is not clean:\n    ' + dirty.slice(0, 10).join('\n    '), 'Commit or stash the changes, then run the release again.')
    log.warn('working tree is dirty (' + dirty.length + ' entries); continuing because of --allow-dirty')
  } else {
    log.ok('working tree is clean')
  }

  const remoteUrl = (await git(['remote', 'get-url', 'origin'], { log })).stdout.trim()
  const repo = parseGitHubRemote(remoteUrl)
  if (!repo) throw new ReleaseError('origin is not a GitHub remote: ' + (remoteUrl || '(missing remote)'), 'Expected https://github.com/<owner>/<repo>.git or git@github.com:<owner>/<repo>.git.')
  log.ok('remote: ' + repo.owner + '/' + repo.repo)

  const currentVersion = String(context.pkg.version || '')
  if (!parseVersion(currentVersion)) throw new ReleaseError('package.json version is not semver: ' + currentVersion)
  if (context.enginePkg.version !== currentVersion) {
    throw new ReleaseError('version mismatch: package.json is ' + currentVersion + ' but engine/package.json is ' + context.enginePkg.version, 'Make both files agree before releasing.')
  }
  const target = resolveTargetVersion(currentVersion, options)
  log.ok('version: ' + currentVersion + ' -> ' + target.version + (target.mode === 'resume' ? ' (resume)' : ''))

  // F-02: a resume may only finish the release of the version that HEAD already
  // declares. A failed `git commit` leaves the bump uncommitted; resuming then
  // would tag an old commit while publishing the dirty working tree.
  if (target.mode === 'resume') {
    const committed = await readPackageVersionAtRef('HEAD')
    if (!committed.ok) {
      throw new ReleaseError('cannot read package.json at HEAD for the resume check: ' + committed.error, 'Check the git state, then re-run.')
    }
    const problems = evaluateResumeVersionIntegrity({
      targetVersion: target.version,
      committedVersion: committed.version,
      worktreeVersion: currentVersion,
    })
    if (problems.length > 0) {
      throw new ReleaseError(
        'cannot resume the release of ' + target.version + ':\n  - ' + problems.join('\n  - '),
        'Commit the version bump first (git add package.json engine/package.json && git commit -m "release: ' + PACKAGE_NAME + ' ' + target.version + '"), then re-run with --resume. Alternatively revert both version files and start over.',
      )
    }
    log.ok('resume: HEAD and working-tree versions are both ' + target.version)
  }

  const section = extractChangelogSection(context.changelog, target.version)
  if (!section || section.body.trim().length === 0) {
    throw new ReleaseError(CHANGELOG_FILE + ' has no non-empty "## [' + target.version + ']" section', 'Write the release notes first, e.g. "## [' + target.version + '] - YYYY-MM-DD".')
  }
  log.ok('changelog: ' + section.heading)

  const npm = options.skipNpm ? null : await detectNpm()
  if (!npm && !options.skipNpm) throw new ReleaseError('npm is not available', 'Put npm on PATH, or set NPM_CLI to npm-cli.js (DSH layouts often use %USERPROFILE%\\.npm-cli\\bin\\npm-cli.js).')
  if (npm) log.ok('npm: ' + (npm.version || 'available') + (npm.kind === 'cli' ? ' (npm-cli.js)' : ''))

  // T-11: --no-write-fetch-head keeps a --dry-run from creating .git/FETCH_HEAD.
  const fetched = await git(fetchArgs(), { log })
  if (fetched.code !== 0) throw new ReleaseError('git fetch origin failed:\n' + outputTail(fetched), 'Check network and git credentials; an SSH remote avoids the Windows schannel TLS problem.')
  const behind = Number((await git(['rev-list', '--count', 'HEAD..origin/' + MAIN_BRANCH], { log })).stdout.trim() || '0')
  if (behind > 0) throw new ReleaseError('local ' + MAIN_BRANCH + ' is behind origin/' + MAIN_BRANCH + ' by ' + behind + ' commit(s)', 'Run git pull --ff-only origin ' + MAIN_BRANCH + ' first.')
  log.ok('local ' + MAIN_BRANCH + ' is up to date with origin')

  const tag = tagName(target.version)
  const localTag = (await git(['tag', '--list', tag], { log })).stdout.trim() === tag
  const remoteTags = await git(['ls-remote', '--tags', 'origin', 'refs/tags/' + tag], { log })
  const remoteTag = remoteTags.code === 0 && remoteTags.stdout.trim().length > 0
  if (remoteTags.code !== 0) log.warn('could not list remote tags: ' + outputTail(remoteTags))
  if (target.mode !== 'resume' && (localTag || remoteTag)) {
    throw new ReleaseError('tag ' + tag + ' already exists' + (remoteTag ? ' on origin' : ''), 'Release a new version, or re-run with --resume to finish the existing one.')
  }
  log.ok('tag ' + tag + ': ' + (localTag ? 'local' : 'not local') + ', ' + (remoteTag ? 'on origin' : 'not on origin'))

  let npmExists = false
  if (npm) npmExists = (await npmViewVersion(npm, PACKAGE_NAME + '@' + target.version)) !== null
  if (npmExists && target.mode !== 'resume') {
    throw new ReleaseError(PACKAGE_NAME + '@' + target.version + ' is already published to npm', 'Bump the version, or re-run with --resume.')
  }
  if (npm) log.ok(PACKAGE_NAME + '@' + target.version + ' on npm: ' + (npmExists ? 'already published' : 'not published'))

  let githubToken = null
  let releaseExists = false
  if (!options.skipGithub) {
    githubToken = await resolveGithubToken()
    if (!githubToken) throw new ReleaseError('no GitHub token found', 'Set GITHUB_TOKEN (scopes: repo / Contents and Releases), or sign in through the git credential manager.')
    releaseExists = (await findGithubRelease({ token: githubToken, repo, tag, log })) !== null
    if (releaseExists && target.mode !== 'resume') {
      throw new ReleaseError('GitHub Release ' + tag + ' already exists', 'Delete it first or bump the version.')
    }
    log.ok('GitHub Release ' + tag + ': ' + (releaseExists ? 'exists' : 'missing'))
  }

  if (!options.skipTests) {
    log.step('Checks: test suite')
    await runCheckSuite({ log })
  } else {
    log.warn('test suite skipped (--skip-tests)')
  }

  if (npm && !options.skipNpm) {
    log.step('Checks: npm pack --dry-run')
    const pack = await runNpm(npm, ['pack', '--dry-run'])
    if (pack.code !== 0) throw new ReleaseError('npm pack --dry-run failed:\n' + outputTail(pack))
    const problems = validatePackOutput(pack.stdout + '\n' + pack.stderr)
    if (problems.length > 0) throw new ReleaseError('npm tarball content problem: ' + problems.join('; '), 'Fix package.json "files" or remove runtime data before releasing.')
    log.ok('package content looks sane (only memory/.gitkeep from memory/)')
  }

  return {
    mode: target.mode,
    currentVersion,
    targetVersion: target.version,
    repo,
    npm,
    githubToken,
    changelogSection: section,
    tagExists: localTag,
    remoteTagExists: remoteTag,
    npmExists,
    releaseExists,
  }
}

// ---------------------------------------------------------------------------
// plan / confirmation / execution
// ---------------------------------------------------------------------------

function printPlan(plan, options, log) {
  const tag = tagName(plan.targetVersion)
  const gitLine = plan.mode === 'resume'
    ? 'reuse existing commit, ensure tag ' + tag + (options.skipPush ? ' (push skipped)' : ' + push origin ' + MAIN_BRANCH + ' and ' + tag)
    : 'bump, commit "release: ' + PACKAGE_NAME + ' ' + plan.targetVersion + '", tag ' + tag + (options.skipPush ? ' (push skipped)' : ' + push origin ' + MAIN_BRANCH + ' and ' + tag)
  log.plain('')
  log.plain('Release plan')
  log.plain('  repository : ' + plan.repo.owner + '/' + plan.repo.repo)
  log.plain('  version    : ' + plan.currentVersion + ' -> ' + plan.targetVersion + (plan.mode === 'resume' ? ' (resume)' : ''))
  log.plain('  changelog  : ' + plan.changelogSection.heading + ' (' + plan.changelogSection.body.split('\n').length + ' lines)')
  log.plain('  git        : ' + gitLine)
  log.plain('  npm        : ' + (options.skipNpm ? 'skipped' : 'publish ' + PACKAGE_NAME + '@' + plan.targetVersion + (plan.npmExists ? ' (already published)' : '')))
  log.plain('  github     : ' + (options.skipGithub ? 'skipped' : 'create release ' + tag + (plan.releaseExists ? ' (already exists)' : '')))
  log.plain('')
}

async function confirmPlan(options, log) {
  if (options.dryRun) {
    log.info('dry run: no changes will be made')
    return true
  }
  if (options.yes) return true
  if (!process.stdin.isTTY) throw new ReleaseError('confirmation required but stdin is not a TTY', 'Pass --yes to confirm a non-interactive release.')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('Continue with the release? [y/N] ')
    return /^(?:y|yes)$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

async function ensureTag(plan, log) {
  const tag = tagName(plan.targetVersion)
  const existing = (await git(['tag', '--list', tag], { log })).stdout.trim()
  if (existing === tag) {
    log.info('tag ' + tag + ' already exists')
    // F-02: an existing tag must describe the version being published.
    await assertTagMatchesVersion(tag, plan.targetVersion, { log })
    return
  }
  if (plan.mode === 'resume') {
    const subject = (await git(['log', '-1', '--format=%s'], { log })).stdout.trim()
    if (!subject.startsWith(RELEASE_COMMIT_PREFIX + plan.targetVersion)) {
      log.warn('HEAD does not look like the release commit (' + subject + '); tagging it anyway')
    }
  }
  const created = await git(['tag', '-a', tag, '-m', tag], { log })
  if (created.code !== 0) throw new ReleaseError('git tag ' + tag + ' failed:\n' + outputTail(created), 'Check the repository state, then re-run with --resume.')
  log.ok('created tag ' + tag)
  // F-02: never publish a version the new tag does not actually contain.
  await assertTagMatchesVersion(tag, plan.targetVersion, { log })
}

async function pushRef(args, description, log) {
  log.info('git push ' + description)
  const result = await git(args, { log })
  if (result.code !== 0) throw new ReleaseError('git push ' + description + ' failed:\n' + outputTail(result), 'Check network/credentials, then re-run with --resume to finish the push.')
  log.ok('pushed ' + description)
}

async function executeRelease({ options, context, plan, log }) {
  const tag = tagName(plan.targetVersion)
  const result = { version: plan.targetVersion, tag, commit: null, npmStatus: 'skipped', npmVisible: false, releaseUrl: null }

  log.step('1/4 git: ' + (plan.mode === 'resume' ? 'reuse existing commit, make sure the tag exists' : 'version bump, release commit, tag'))
  if (plan.mode !== 'resume') {
    writeVersionFile(context.packagePath, plan.targetVersion)
    writeVersionFile(context.enginePackagePath, plan.targetVersion)
    log.ok(PACKAGE_FILE + ' and engine/package.json now say ' + plan.targetVersion)
    const message = releaseCommitMessage(plan.targetVersion, options.title)
    const added = await git(['add', '--', PACKAGE_FILE, ENGINE_PACKAGE_FILE], { log })
    if (added.code !== 0) throw new ReleaseError('git add failed:\n' + outputTail(added))
    const committed = await git(['commit', '-m', message], { log })
    if (committed.code !== 0) throw new ReleaseError('git commit failed:\n' + outputTail(committed), 'Fix the commit problem and either (a) commit the two version files manually (git add package.json engine/package.json && git commit) and re-run with --resume, or (b) revert them (git checkout -- package.json engine/package.json) and start the release again. --resume refuses to run while the version bump is uncommitted, and --allow-dirty does not make the tag/version mismatch safe.')
    log.ok('committed: ' + message)
  }
  await ensureTag(plan, log)
  result.commit = (await git(['rev-parse', 'HEAD'], { log })).stdout.trim()

  log.step('2/4 git: push branch and tag')
  if (options.skipPush) {
    log.info('skipped (--skip-push)')
  } else {
    await pushRef(['push', 'origin', MAIN_BRANCH], 'origin ' + MAIN_BRANCH, log)
    await pushRef(['push', 'origin', tag], 'origin ' + tag, log)
  }

  log.step('3/4 npm: publish ' + PACKAGE_NAME + '@' + plan.targetVersion)
  if (options.skipNpm) {
    log.info('skipped (--skip-npm)')
  } else {
    const outcome = await publishToNpm({ npm: plan.npm, version: plan.targetVersion, options, log })
    result.npmStatus = outcome.status
    result.npmVisible = outcome.visible === true
  }

  log.step('4/4 github: release ' + tag)
  if (options.skipGithub) {
    log.info('skipped (--skip-github)')
  } else {
    result.releaseUrl = await createGithubRelease({ repo: plan.repo, version: plan.targetVersion, section: plan.changelogSection, token: plan.githubToken, title: options.title, log })
  }
  return result
}

function printSummary(result, log) {
  log.plain('')
  log.plain('Release complete')
  log.plain('  version : ' + result.version)
  log.plain('  tag     : ' + result.tag)
  if (result.commit) log.plain('  commit  : ' + result.commit.slice(0, 12))
  if (result.npmStatus === 'published') {
    log.plain('  npm     : https://www.npmjs.com/package/' + PACKAGE_NAME + '/v/' + result.version + (result.npmVisible ? '' : ' (npm is still processing - check the page in a minute)'))
  } else if (result.npmStatus === 'already-published') {
    log.plain('  npm     : already published')
  } else {
    log.plain('  npm     : skipped')
  }
  log.plain('  github  : ' + (result.releaseUrl || 'skipped / already existed'))
  log.plain('')
}

// ---------------------------------------------------------------------------
// logger + entry point
// ---------------------------------------------------------------------------

/** Simple log facade so tests could inject a quiet console if needed. */
export function createLogger(target = console) {
  const write = (prefix, message) => target.log(prefix + ' ' + message)
  return {
    step: (message) => write('\n==>', message),
    info: (message) => write('   ', message),
    ok: (message) => write(' [ok]', message),
    warn: (message) => write('[warn]', message),
    error: (message) => target.error('[error] ' + message),
    plain: (message) => target.log(message),
  }
}

/**
 * Entry point. Returns a process exit code (never throws for expected failures).
 * @param {string[]} [argv]
 * @param {{log?:Console}} [environment]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), environment = {}) {
  const log = createLogger(environment.log || console)
  let options
  try {
    options = parseCliArgs(argv)
  } catch (error) {
    log.error(error.message)
    return EXIT_USAGE
  }
  if (options.help) {
    log.plain(USAGE)
    return EXIT_OK
  }
  log.plain('dsh-rofm release tool' + (options.dryRun ? ' (dry run)' : ''))
  installSystemCertificates()
  try {
    const context = readContext()
    const plan = await preflight({ options, context, log })
    printPlan(plan, options, log)
    const confirmed = await confirmPlan(options, log)
    if (!confirmed) {
      log.warn('release cancelled')
      return EXIT_OK
    }
    if (options.dryRun) {
      log.ok('dry run complete: every check passed, nothing was changed')
      return EXIT_OK
    }
    const result = await executeRelease({ options, context, plan, log })
    printSummary(result, log)
    return EXIT_OK
  } catch (error) {
    if (error instanceof ReleaseError) {
      log.error(error.message)
      if (error.recovery) log.info('Next step: ' + error.recovery)
    } else {
      log.error(error && error.stack ? error.stack : String(error))
    }
    return EXIT_FAILED
  }
}

if (invokedAsMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code })
}
