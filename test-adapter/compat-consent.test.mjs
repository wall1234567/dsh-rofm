/**
 * dsh-rofm — Derpyu 白名单注入授权的适配层测试（v1.5.7）。
 *
 * 使用一个极小的 mock Cordis context（systemPrompt / tools / tokenMeter /
 * connection.fetch 路由 / on / effect / inject），没有真的 DSH，也没有任何
 * 网络；`DSH_PROFILE_DIR` 指向临时假 profile，所以 `compat` 检测与真实安装
 * 一样走 `detectQqCompat`，但只读/写临时目录里的第三方文件。
 *
 * 覆盖：pending 不写文件、allow 立即注入并持久化、deny 停用当前实例并写
 * `config.local.json`、已拒绝后再开启不注入、autoPatchDerpyu=false 与
 * derpyuConsent="allow" 两个显式开关、enabled:false 启动早退。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RofmPlugin } from '../lib/plugin.js'
import {
  CONSENT_FILE_NAME,
  CONSENT_PROMPT,
  CONSENT_ROUTE,
  consentFilePath,
  legacyConsentFilePath,
} from '../lib/compat-consent.js'

// ---------------------------------------------------------------------------
// mock context
// ---------------------------------------------------------------------------

function makeContext(options = {}) {
  const handlers = new Map()
  const effects = []
  const injectCallbacks = []
  const capture = { sections: [], tools: [], logs: [], routes: [], bundleCalls: [] }
  const toolsService = {
    register(definition) {
      const entry = { definition, disposed: false }
      capture.tools.push(entry)
      return () => {
        entry.disposed = true
      }
    },
  }
  const connection = {
    fetch: {
      register(route) {
        // The real host keeps exact Fetch routes in a Map keyed by path alone
        // and throws on a duplicate path. Mirror that, so splitting GET and
        // POST into two registrations fails here instead of only in the GUI.
        if (capture.routes.some((entry) => entry.route.path === route.path)) {
          throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
        }
        const entry = { route, disposed: false }
        capture.routes.push(entry)
        return async () => {
          entry.disposed = true
        }
      },
    },
  }
  const pluginManagerMode = options.pluginManagerMode ?? 'ok'
  const pluginManager = pluginManagerMode === 'missing'
    ? undefined
    : {
        setBundleEnabled(name, enabled) {
          capture.bundleCalls.push({ name, enabled })
          if (pluginManagerMode === 'fail') {
            return Promise.resolve({ changed: false, application: 'failed', stage: 'enable', target: name, error: { code: 'operation-error' } })
          }
          return Promise.resolve({ changed: true, application: 'applied', stage: 'enable', target: name, enabled })
        },
      }
  const ctx = {
    logger: {
      info: (message) => capture.logs.push(['info', String(message)]),
      warn: (message) => capture.logs.push(['warn', String(message)]),
      debug: (message) => capture.logs.push(['debug', String(message)]),
    },
    tokenMeter: { measure: () => ({ tokens: 0, contextWindow: 1000 }) },
    systemPrompt: {
      section(sectionOptions) {
        const entry = { sectionOptions, disposed: false }
        capture.sections.push(entry)
        return () => {
          entry.disposed = true
        }
      },
    },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
      return () => {
        const list = handlers.get(name) ?? []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose ?? (() => {})
    },
    inject(_names, callback) {
      const scoped = {
        connection,
        get(name) {
          return name === 'connection' ? connection : undefined
        },
        effect: ctx.effect,
        logger: ctx.logger,
      }
      const run = () => {
        const dispose = callback(scoped)
        if (typeof dispose === 'function') effects.push(dispose)
        return dispose
      }
      injectCallbacks.push(run)
      return run()
    },
    /** Re-run every `ctx.inject` callback, like a service remount / HMR re-entry. */
    reacquireConnection() {
      for (const run of injectCallbacks.slice()) run()
    },
    get(name) {
      if (name === 'systemPrompt') return ctx.systemPrompt
      if (name === 'tokenMeter') return ctx.tokenMeter
      if (name === 'tools') return ctx.tools
      if (name === 'connection') return connection
      if (name === 'pluginManager') return pluginManager
      return undefined
    },
    handlerCount() {
      let total = 0
      for (const list of handlers.values()) total += list.length
      return total
    },
  }
  ctx.tools = toolsService
  return { ctx, capture }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-consent-adapter-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(root, 'dshhome')
  try {
    return fn(root)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

async function withTempRootAsync(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-consent-adapter-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(root, 'dshhome')
  try {
    return await fn(root)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

function withProfileEnv(profileDir, fn) {
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profileDir
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
}

async function withProfileEnvAsync(profileDir, fn) {
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profileDir
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
}

/** One fake Derpyu install (same SAFE_EXACT shape as the real upstream file). */
function makeDerpyuProfile(root) {
  const profileDir = path.join(root, 'profile')
  const packageDir = path.join(root, 'derpyu', 'plugins', 'qq-agent-presets')
  mkdirSync(packageDir, { recursive: true })
  const file = path.join(packageDir, 'qq-tool-restrict.mjs')
  writeFileSync(
    file,
    [
      '// fake qq-tool-restrict (same SAFE_EXACT shape as Derpyu upstream)',
      "export const name = 'qq-tool-restrict'",
      'const SAFE_EXACT = new Set([',
      "  'ask_user_question',",
      "  'todo_write',",
      '])',
      'export function apply() {}',
      '',
    ].join('\n'),
  )
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-fake',
        dependencies: { 'qq-agent-presets': `link:${packageDir.replace(/\\/g, '/')}` },
        dsh: { profile: { bundles: ['qq-agent-presets'] } },
      },
      null,
      2,
    ),
  )
  return { profileDir, packageDir, file }
}

/** One plugin backed by a temp memory dir and a temp plugin root. */
function makePlugin({ root, compat = {}, rowExtra = {}, pluginRootName = 'plugin-root', pluginManagerMode = 'ok' } = {}) {
  const memoryDir = path.join(root, 'memory')
  const pluginDir = path.join(root, pluginRootName)
  mkdirSync(pluginDir, { recursive: true })
  const { ctx, capture } = makeContext({ pluginManagerMode })
  const plugin = new RofmPlugin(
    ctx,
    { enabled: true, storage: { dir: memoryDir }, compat, ...rowExtra },
    { pluginDir },
  )
  plugin.start()
  return { plugin, ctx, capture, memoryDir, pluginDir }
}

function jsonRequest(body) {
  return { json: async () => body }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function consentFile() {
  return consentFilePath()
}

function localConfig(pluginDir) {
  return path.join(pluginDir, 'config.local.json')
}

function toolRejectedText(file) {
  return ['memory_judge', 'memory_recall', 'memory_image'].every((name) => readFileSync(file, 'utf8').includes(`'${name}'`))
}

// ---------------------------------------------------------------------------
// pending
// ---------------------------------------------------------------------------

test('consent adapter: the first Derpyu detection asks and does not touch the third-party file', async () => {
  await withTempRootAsync(async (root) => {
    const { profileDir, file } = makeDerpyuProfile(root)
    await withProfileEnvAsync(profileDir, async () => {
      const before = readFileSync(file, 'utf8')
      const { plugin, ctx, capture } = makePlugin({ root, compat: { qqBots: 'auto' } })

      assert.equal(plugin.consentPending, true, 'the patch must wait for the user answer')
      assert.equal(plugin.autopatchApplied, false)
      assert.equal(plugin.autopatchStatus.status, 'pending-consent')
      assert.equal(readFileSync(file, 'utf8'), before, 'the third-party file must stay byte-identical')
      assert.equal(readdirSync(path.dirname(file)).some((name) => name.includes('.bak-rofm-')), false, 'no backup may be written')
      assert.equal(existsSync(consentFile()), false, 'no decision is recorded before the answer')

      // The browser half finds one authenticated route that serves both methods:
      // the host keys routes by path, so a second registration for the same path
      // would be rejected and its method left unserved.
      assert.equal(capture.routes.length, 1)
      assert.equal(capture.routes[0].route.path, CONSENT_ROUTE)
      assert.deepEqual(capture.routes[0].route.methods, ['GET', 'POST'])
      assert.equal(capture.routes[0].route.requestBody, 'buffered')
      assert.equal(capture.routes[0].disposed, false)

      // The single handler dispatches on the method: GET reports, POST decides.
      const routedGet = await capture.routes[0].route.fetch(new Request(`http://127.0.0.1${CONSENT_ROUTE}`))
      assert.equal(routedGet.status, 200)
      assert.equal((await routedGet.json()).pending, true)

      // HMR / connection-remount re-entry must reuse the live route instead of
      // registering the same path again (the host rejects duplicates; during the
      // 2026-11-10 incident the second registration left POST unserved and the
      // consent dialog could not submit).
      ctx.reacquireConnection()
      assert.equal(capture.routes.length, 1, 're-entry must reuse the live exact-Fetch route')
      assert.equal(capture.routes[0].disposed, false)
      assert.equal(
        capture.logs.some(([level, line]) => level === 'warn' && line.includes('route registration failed')),
        false,
        're-entry must not hit the duplicate-route rejection',
      )
      const routedAfterReentry = await capture.routes[0].route.fetch(new Request(`http://127.0.0.1${CONSENT_ROUTE}`))
      assert.equal((await routedAfterReentry.json()).pending, true, 'the reused route keeps serving GET')

      // GET payload: pending + the exact user sentence + the resolved target.
      const response = plugin.handleConsentGet()
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.pending, true)
      assert.equal(payload.detected, true)
      assert.equal(payload.decision, null)
      assert.equal(payload.message.zh, CONSENT_PROMPT.zh)
      assert.equal(payload.targetFile, file)

      // A malformed answer is refused and changes nothing.
      const bad = await plugin.handleConsentPost(jsonRequest({ decision: 'allowed' }))
      assert.equal(bad.status, 400)
      const stillPending = await plugin.handleConsentGet().json()
      assert.equal(stillPending.pending, true)
      assert.equal(readFileSync(file, 'utf8'), before)

      // Scenario: qq-bridge is installed AFTER rofm is already running. The host
      // re-detects from the profile (mtime changed) and the consent API flips to
      // pending without a plugin restart; the browser half's 30s watch turns that
      // into a popup without a page refresh.
      const profileFile = path.join(profileDir, 'package.json')
      const installedProfile = readJson(profileFile)
      writeFileSync(profileFile, JSON.stringify({ name: 'dsh-profile-fake' }, null, 2), 'utf8')
      utimesSync(profileFile, new Date(), new Date(Date.now() + 1000))
      const notInstalled = await plugin.handleConsentGet().json()
      assert.equal(notInstalled.detected, false, 'without qq-bridge there is nothing to authorize')
      assert.equal(notInstalled.pending, false)
      assert.equal(notInstalled.patchEnabled, true, 'the browser half still keeps watching')

      writeFileSync(profileFile, JSON.stringify(installedProfile, null, 2), 'utf8')
      utimesSync(profileFile, new Date(), new Date(Date.now() + 2000))
      const reinstalled = await plugin.handleConsentGet().json()
      assert.equal(reinstalled.detected, true)
      assert.equal(reinstalled.pending, true, 'a later qq-bridge install must re-open the gate')
      assert.equal(readFileSync(file, 'utf8'), before, 'still no unauthorized write')
    })
  })
})

// ---------------------------------------------------------------------------
// allow
// ---------------------------------------------------------------------------

test('consent adapter: allow patches immediately, persists once, and survives a restart', async () => {
  await withTempRootAsync(async (root) => {
    const { profileDir, file } = makeDerpyuProfile(root)
    await withProfileEnvAsync(profileDir, async () => {
      const first = makePlugin({ root, compat: { qqBots: 'auto' } })
      const response = await first.capture.routes[0].route.fetch(new Request(`http://127.0.0.1${CONSENT_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' }),
      }))
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.ok, true)
      assert.equal(payload.decision, 'allowed')
      assert.equal(payload.persisted, true)
      assert.equal(payload.patch, 'patched')

      assert.equal(first.plugin.autopatchApplied, true)
      assert.equal(toolRejectedText(file), true, 'the four tool names must be injected')
      assert.equal(readJson(consentFile()).decision, 'allowed')
      assert.ok(readdirSync(path.dirname(file)).some((name) => name.includes('.bak-rofm-')), 'a backup must be written')

      // Second answer (another tab / a late click) is idempotent and does not
      // flip or replay anything.
      const again = await first.plugin.handleConsentPost(jsonRequest({ decision: 'deny' }))
      const againPayload = await again.json()
      assert.equal(againPayload.already, true)
      assert.equal(againPayload.decision, 'allowed')
      assert.equal(first.plugin.consentDenied, false)

      // Restart: the persisted decision pre-authorizes the patch, no prompt.
      const restarted = makePlugin({ root, compat: { qqBots: 'auto' }, pluginRootName: 'plugin-root-2' })
      assert.equal(restarted.plugin.consentPending, false)
      assert.equal(restarted.plugin.autopatchApplied, true)
      assert.equal(restarted.plugin.autopatchStatus.status, 'already')
      assert.equal(readJson(consentFile()).decision, 'allowed')
    })
  })
})

// ---------------------------------------------------------------------------
// deny
// ---------------------------------------------------------------------------

test('consent adapter: deny closes the Settings switch, stops this instance, and re-enable counts as permission', async () => {
  await withTempRootAsync(async (root) => {
    const { profileDir, file } = makeDerpyuProfile(root)
    await withProfileEnvAsync(profileDir, async () => {
      const before = readFileSync(file, 'utf8')
      const { plugin, ctx, capture, pluginDir, memoryDir } = makePlugin({ root, compat: { qqBots: 'auto' } })
      assert.ok(capture.tools.length >= 4, 'tools are registered before the answer')
      assert.ok(capture.sections.length >= 3, 'prompt sections are registered before the answer')
      assert.ok(ctx.handlerCount() >= 3)

      const response = await plugin.handleConsentPost(jsonRequest({ decision: 'deny' }))
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.ok, true)
      assert.equal(payload.decision, 'denied')
      assert.equal(payload.disabled, true)

      // Persisted state: the refusal records that rofm's Settings switch will be
      // closed (closed:'bundle'); config.local.json is NOT hard-disabled, so a
      // later re-enable from Settings is not blocked.
      const persisted = readJson(consentFile())
      assert.equal(persisted.decision, 'denied')
      assert.equal(persisted.closed, 'bundle')
      assert.equal(payload.closed, 'bundle')
      assert.equal(existsSync(localConfig(pluginDir)) ? readJson(localConfig(pluginDir)).enabled : undefined, undefined)
      assert.equal(readFileSync(file, 'utf8'), before, 'deny never writes the third-party file')

      // The current process stops contributing.
      assert.equal(plugin.consentDenied, true)
      assert.equal(plugin.autopatchApplied, false)
      assert.equal(plugin.toolRegistered, false)
      assert.equal(capture.tools.every((entry) => entry.disposed), true, 'every registered tool is unregistered')
      assert.equal(capture.sections.every((entry) => entry.disposed), true, 'every prompt section is unregistered')
      assert.equal(ctx.handlerCount(), 0, 'every event listener is removed')
      // The consent API itself stays alive so a reloaded page sees the decision
      // instead of retrying forever.
      assert.equal(capture.routes.every((entry) => entry.disposed === false), true)

      // Prompt sections return '' even if a provider is still called mid-flight.
      const recallSection = capture.sections[0]?.sectionOptions
      assert.equal(typeof recallSection?.text, 'function')
      assert.equal(recallSection.text({ agent: { session: { id: 'session-x' } } }), '')

      // A page asking again gets the recorded decision, not a second prompt.
      const payloadAfter = await plugin.handleConsentGet().json()
      assert.equal(payloadAfter.pending, false)
      assert.equal(payloadAfter.decision, 'denied')
      assert.equal(payloadAfter.patchAllowed, false)

      // The deny path turns the Settings switch (bundle) off; the test drives
      // that step explicitly instead of waiting for the 800 ms timer.
      assert.equal(await plugin.closeRofmBundle(), true, 'the Settings switch must be closed')
      assert.deepEqual(capture.bundleCalls, [{ name: 'dsh-rofm', enabled: false }])
      assert.equal(readJson(consentFile()).closed, 'bundle')

      // Re-enable from Settings: rofm loads again => that activation counts as
      // permission (no popup), the decision upgrades to allowed and the
      // whitelist patch is applied.
      const reenabled = makePlugin({ root, compat: { qqBots: 'auto' }, pluginRootName: 'plugin-root-2' })
      assert.equal(reenabled.plugin.consentPending, false, 'a re-enable must not ask again')
      assert.equal(reenabled.plugin.consentDenied, false)
      assert.equal(reenabled.capture.tools.length >= 4, true, 'rofm must be fully usable again')
      assert.equal(reenabled.plugin.autopatchApplied, true, 're-enable also injects the whitelist')
      assert.equal(readJson(consentFile()).decision, 'allowed')
      assert.ok(
        reenabled.capture.logs.some(([level, line]) => level === 'info' && line.includes('通过设置重新启用')),
        'the upgrade must be logged',
      )
    })
  })
})

test('consent adapter: without a pluginManager the deny falls back to enabled:false and keeps rofm closed', async () => {
  await withTempRootAsync(async (root) => {
    const { profileDir, file } = makeDerpyuProfile(root)
    await withProfileEnvAsync(profileDir, async () => {
      const before = readFileSync(file, 'utf8')
      const { plugin, pluginDir } = makePlugin({ root, compat: { qqBots: 'auto' }, pluginManagerMode: 'missing' })
      const broken = '{ broken local config'
      writeFileSync(localConfig(pluginDir), broken, 'utf8')

      const response = await plugin.handleConsentPost(jsonRequest({ decision: 'deny' }))
      const payload = await response.json()
      assert.equal(payload.decision, 'denied')
      assert.equal(payload.disabled, true)
      assert.equal(payload.closed, 'bundle')

      // No pluginManager service: fall back to the legacy hard close; a broken
      // config.local.json is never overwritten, only reported.
      assert.equal(await plugin.closeRofmBundle(), false)
      assert.equal(readJson(consentFile()).closed, 'hard')
      assert.equal(readFileSync(localConfig(pluginDir), 'utf8'), broken, 'the user file must stay byte-identical')
      assert.equal(readFileSync(file, 'utf8'), before, 'no patch in the fallback path')
      assert.ok(
        plugin.currentConfig() !== undefined && plugin.consentDenied === true,
        'the current process stays disabled',
      )

      // A later start sees closed:'hard' and stays inert; the prompt does not repeat.
      const restart = makePlugin({ root, compat: { qqBots: 'auto' }, pluginRootName: 'plugin-root-2' })
      assert.equal(restart.plugin.consentPending, false)
      assert.equal(restart.plugin.consentDenied, true)
      assert.equal(restart.capture.tools.length, 0)
    })
  })
})

// ---------------------------------------------------------------------------
// explicit switches / previous decisions
// ---------------------------------------------------------------------------

test('consent adapter: compat.derpyuConsent="allow" is the headless pre-authorization', () => {
  withTempRoot((root) => {
    const { profileDir, file } = makeDerpyuProfile(root)
    withProfileEnv(profileDir, () => {
      const { plugin } = makePlugin({ root, compat: { qqBots: 'auto', derpyuConsent: 'allow' } })
      assert.equal(plugin.consentPending, false)
      assert.equal(plugin.autopatchApplied, true)
      assert.equal(plugin.autopatchStatus.status, 'patched')
      assert.equal(toolRejectedText(file), true)
      assert.equal(existsSync(consentFile()), false, 'no prompt decision is needed')
    })
  })
})

test('consent adapter: autoPatchDerpyu=false never prompts and never writes', () => {
  withTempRoot((root) => {
    const { profileDir, file } = makeDerpyuProfile(root)
    withProfileEnv(profileDir, () => {
      const before = readFileSync(file, 'utf8')
      const { plugin } = makePlugin({ root, compat: { qqBots: 'auto', autoPatchDerpyu: false } })
      assert.equal(plugin.consentPending, false)
      assert.equal(plugin.autopatchApplied, false)
      assert.equal(plugin.autopatchStatus.status, 'disabled')
      assert.equal(readFileSync(file, 'utf8'), before)
    })
  })
})

test('consent adapter: a denied decision keeps rofm closed across re-enable/update and survives a legacy migration', () => {
  withTempRoot((root) => {
    const { profileDir, file } = makeDerpyuProfile(root)
    withProfileEnv(profileDir, () => {
      const before = readFileSync(file, 'utf8')
      // The decision was refused by an earlier 1.5.7 build, which stored it in
      // the install directory. A plugin update / re-enable (row config still
      // enabled:true) must NOT bring rofm back, re-prompt or patch.
      const legacyFile = legacyConsentFilePath(path.join(root, 'memory'))
      mkdirSync(path.dirname(legacyFile), { recursive: true })
      writeFileSync(legacyFile, JSON.stringify({ version: 1, decision: 'denied', at: 1794324481493 }), 'utf8')

      const { plugin, ctx, capture } = makePlugin({ root, compat: { qqBots: 'auto' } })
      assert.equal(plugin.consentPending, false, 'a refusal is never re-asked')
      assert.equal(plugin.consentDenied, true, 'rofm stays closed')
      assert.equal(plugin.autopatchApplied, false)
      assert.equal(plugin.autopatchStatus.status, 'denied')
      assert.equal(readFileSync(file, 'utf8'), before, 'no patch after a deny')
      assert.equal(capture.tools.length, 0, 'a refused rofm registers no tools')
      assert.equal(capture.sections.length, 0)
      assert.equal(capture.routes.length, 0)
      assert.equal(ctx.handlerCount(), 0)
      assert.equal(readJson(consentFile()).decision, 'denied', 'the legacy decision is migrated to DSH_HOME')
      assert.equal(readJson(localConfig(path.join(root, 'plugin-root'))).enabled, false)
      assert.ok(
        capture.logs.some(([level, line]) => level === 'warn' && line.includes('保持关闭')),
        'the plugin must explain that rofm stays closed and how to re-open it',
      )
    })
  })
})

test('consent adapter: enabled:false short-circuits before detection, routes and tools', () => {
  withTempRoot((root) => {
    const { profileDir, file } = makeDerpyuProfile(root)
    withProfileEnv(profileDir, () => {
      const before = readFileSync(file, 'utf8')
      const { plugin, ctx, capture } = makePlugin({ root, compat: { qqBots: 'auto' }, rowExtra: { enabled: false } })
      assert.equal(plugin.consentPending, false)
      assert.equal(plugin.autopatchApplied, false)
      assert.equal(plugin.autopatchStatus, undefined)
      assert.equal(capture.tools.length, 0)
      assert.equal(capture.sections.length, 0)
      assert.equal(capture.routes.length, 0)
      assert.equal(ctx.handlerCount(), 0)
      assert.equal(readFileSync(file, 'utf8'), before)
    })
  })
})
