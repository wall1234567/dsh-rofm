/**
 * dsh-rofm — Derpyu 白名单注入授权（v1.5.7）的纯逻辑测试。
 *
 * 覆盖 `lib/compat-consent.js`：状态文件读写、门禁状态机、浏览器接口 payload、
 * 以及拒绝后写 `config.local.json` 的失败安全行为。DSH 适配层（plugin.js 的
 * pending/allow/deny 流程）在 `test-adapter/compat-consent.test.mjs`。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CONSENT_ACTIONS,
  CONSENT_ALLOW_LABEL,
  CONSENT_DECISIONS,
  CONSENT_DENY_LABEL,
  CONSENT_FILE_NAME,
  CONSENT_MODES,
  CONSENT_PROMPT,
  CONSENT_ROUTE,
  CONSENT_TOOL_NAMES,
  CONSENT_VERSION,
  consentDetail,
  consentFilePath,
  consentModeOf,
  consentStateDir,
  consentPayload,
  clearLocalDisable,
  describeConsentState,
  legacyConsentFilePath,
  localConfigPath,
  normalizeConsentAction,
  normalizeConsentRecord,
  readConsent,
  writeConsent,
  writeLocalDisable,
} from '../lib/compat-consent.js'

/** 用户 v1.5.7 指定的弹窗文案，必须逐字保留（改这里等于改需求）。 */
const USER_PROMPT_ZH =
  '由于qq-bridge的白名单机制会使rofm在QQ渠道失效且有恶劣影响，故请求您允许rofm将工具添加进白名单中，如您不允许，为防止恶劣后果，rofm会默认关闭，您后续可自行开启。'

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-consent-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(dir, 'dshhome')
  try {
    return fn(dir)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

const DERPYU = { enabled: true, derpyu: { detected: true, evidence: ['node_modules/qq-agent-presets'] } }
const NO_QQ = { enabled: false, derpyu: { detected: false, evidence: [] } }

test('consent: the popup text is the user-specified sentence, verbatim', () => {
  assert.equal(CONSENT_PROMPT.zh, USER_PROMPT_ZH)
  assert.ok(CONSENT_PROMPT.en.length > 0, 'an English fallback is required for non-zh browsers')
  assert.equal(CONSENT_ROUTE, '/api/rofm/derpyu-consent')
  assert.deepEqual(CONSENT_MODES, ['ask', 'allow'])
  assert.equal(CONSENT_VERSION, 1)
  assert.equal(CONSENT_FILE_NAME, '.compat-consent.json')
  assert.deepEqual(CONSENT_ACTIONS, { ALLOW: 'allow', DENY: 'deny' })
  assert.deepEqual(CONSENT_DECISIONS, { ALLOWED: 'allowed', DENIED: 'denied' })
  assert.equal(CONSENT_ALLOW_LABEL.zh, '允许')
  assert.equal(CONSENT_DENY_LABEL.zh, '不允许')
  assert.deepEqual(CONSENT_TOOL_NAMES, ['memory_judge', 'memory_recall', 'memory_image', 'memory_group_recall'])
})

test('consent: the detail names every injected tool and the target file', () => {
  const detail = consentDetail({ targetFile: 'C:/profile/node_modules/qq-agent-presets/qq-tool-restrict.mjs' })
  for (const name of CONSENT_TOOL_NAMES) assert.ok(detail.zh.includes(name), `zh detail must mention ${name}`)
  assert.ok(detail.zh.includes('qq-tool-restrict.mjs'))
  assert.ok(detail.en.includes('SAFE_EXACT'))
  // Without a target the generic relative hint is used.
  assert.ok(consentDetail().zh.includes('qq-agent-presets/qq-tool-restrict.mjs'))
  assert.ok(consentDetail({ targetFile: '   ' }).en.length > 0)
})

test('consent: the decision lives in DSH_HOME (machine-level) and round-trips atomically', () => {
  withTempDir((dir) => {
    // v1.5.7-final: machine-level state directory, not the install directory.
    assert.equal(consentStateDir(), path.join(process.env.DSH_HOME, 'rofm'))
    const file = consentFilePath()
    assert.equal(file, path.join(process.env.DSH_HOME, 'rofm', CONSENT_FILE_NAME))
    assert.equal(readConsent(), undefined, 'a missing file means "not decided yet"')

    const written = writeConsent(CONSENT_DECISIONS.ALLOWED, { at: 1760000000000 })
    assert.equal(written.ok, true)
    assert.equal(written.path, file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(parsed, { version: CONSENT_VERSION, decision: 'allowed', at: 1760000000000 })
    assert.equal(readFileSync(file, 'utf8').endsWith('\n'), true)
    assert.equal(readConsent().decision, 'allowed')
    assert.equal(readConsent().path, file)
    assert.equal(readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-')).length, 0, 'no temp file may survive')

    // The legacy per-install path is only a migration fallback: an old decision
    // found there is still honoured, and an explicit legacyPaths candidate is
    // preferred only when the machine-level file is missing.
    const legacy = legacyConsentFilePath(path.join(dir, 'memory'))
    assert.equal(legacy, path.join(dir, 'memory', CONSENT_FILE_NAME))
    assert.equal(legacyConsentFilePath(''), undefined)
    mkdirSync(path.dirname(legacy), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ version: 1, decision: 'denied', at: 7 }), 'utf8')
    assert.equal(readConsent({ legacyPaths: [legacy] }).decision, 'allowed', 'machine-level state wins')
    rmSync(file, { force: true })
    const migratedRead = readConsent({ legacyPaths: [legacy] })
    assert.equal(migratedRead.decision, 'denied')
    assert.equal(migratedRead.path, legacy)

    // A refusal records how rofm was closed (`closed:'bundle'` = Settings switch
    // off, so re-enabling from Settings counts as permission; `hard` = legacy).
    const closedWrite = writeConsent('denied', { closed: 'bundle', at: 9 })
    assert.equal(closedWrite.ok, true)
    assert.equal(readConsent().decision, 'denied')
    assert.equal(readConsent().closed, 'bundle')
    writeConsent('allowed')
    assert.equal(readConsent().closed, undefined, 'an allow decision carries no close marker')
    assert.equal(normalizeConsentRecord({ decision: 'denied', closed: 'weird' }).closed, undefined)

    // A corrupt / unknown-decision record is treated as "not decided" again.
    writeFileSync(file, '{ not json', 'utf8')
    assert.equal(readConsent(), undefined)
    writeFileSync(file, JSON.stringify({ version: 1, decision: 'maybe', at: 1 }), 'utf8')
    assert.equal(readConsent(), undefined)
    writeFileSync(file, JSON.stringify(['allowed']), 'utf8')
    assert.equal(readConsent(), undefined)

    // Invalid write arguments are refused, not thrown.
    assert.equal(writeConsent('maybe').ok, false)
  })
})

test('consent: normalizeConsentRecord keeps known decisions and drops garbage', () => {
  assert.equal(normalizeConsentRecord({ decision: 'allowed', at: 5 }).decision, 'allowed')
  assert.equal(normalizeConsentRecord({ decision: 'denied' }).decision, 'denied')
  assert.equal(normalizeConsentRecord({ decision: 'denied', at: 0 }).at > 0, true, 'a missing/invalid timestamp falls back to now')
  assert.equal(normalizeConsentRecord(undefined), undefined)
  assert.equal(normalizeConsentRecord(null), undefined)
  assert.equal(normalizeConsentRecord('allowed'), undefined)
  assert.equal(normalizeConsentRecord({ decision: 'allow' }), undefined, 'the request value is not a decision')
})

test('consent: the gate is a pure truth table (no IO)', () => {
  // No Derpyu: nothing to ask, nothing to patch.
  let state = describeConsentState({ detection: NO_QQ, compat: {}, record: undefined })
  assert.equal(state.detected, false)
  assert.equal(state.prompt, false)
  assert.equal(state.patchAllowed, false)

  // Derpyu + ask + no decision -> prompt, patch stays blocked.
  state = describeConsentState({ detection: DERPYU, compat: { derpyuConsent: 'ask' }, record: undefined })
  assert.equal(state.prompt, true)
  assert.equal(state.patchAllowed, false)
  assert.equal(state.denied, false)
  assert.equal(state.mode, 'ask')

  // Default mode when the key is absent is still "ask".
  assert.equal(consentModeOf({}), 'ask')
  assert.equal(consentModeOf(undefined), 'ask')
  assert.equal(consentModeOf({ derpyuConsent: 'weird' }), 'ask')
  assert.equal(consentModeOf({ derpyuConsent: 'allow' }), 'allow')

  // Persisted "allowed": no prompt, patch allowed.
  state = describeConsentState({ detection: DERPYU, compat: {}, record: { decision: 'allowed' } })
  assert.equal(state.prompt, false)
  assert.equal(state.patchAllowed, true)
  assert.equal(state.decision, 'allowed')

  // Persisted "denied": no prompt, patch blocked, denied flag set.
  state = describeConsentState({ detection: DERPYU, compat: {}, record: { decision: 'denied' } })
  assert.equal(state.prompt, false)
  assert.equal(state.patchAllowed, false)
  assert.equal(state.denied, true)

  // Config "allow" is the explicit pre-authorization / headless escape hatch.
  state = describeConsentState({ detection: DERPYU, compat: { derpyuConsent: 'allow' }, record: undefined })
  assert.equal(state.prompt, false)
  assert.equal(state.patchAllowed, true)

  // autoPatchDerpyu=false wins over everything: no prompt because there is
  // nothing to authorize.
  state = describeConsentState({
    detection: DERPYU,
    compat: { autoPatchDerpyu: false },
    record: undefined,
  })
  assert.equal(state.patchEnabled, false)
  assert.equal(state.prompt, false)
  assert.equal(state.patchAllowed, false)
})

test('consent: normalizeConsentAction accepts only the two answers', () => {
  assert.equal(normalizeConsentAction({ decision: 'allow' }), 'allow')
  assert.equal(normalizeConsentAction({ decision: 'deny' }), 'deny')
  assert.equal(normalizeConsentAction({ decision: 'allowed' }), undefined)
  assert.equal(normalizeConsentAction({}), undefined)
  assert.equal(normalizeConsentAction(null), undefined)
  assert.equal(normalizeConsentAction('allow'), undefined)
})

test('consent: the browser payload carries pending + localized copy', () => {
  const pending = describeConsentState({ detection: DERPYU, compat: {}, record: undefined })
  const payload = consentPayload({
    state: pending,
    pluginVersion: '1.5.7',
    targetFile: 'C:/p/qq-tool-restrict.mjs',
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.pending, true)
  assert.equal(payload.detected, true)
  assert.equal(payload.decision, null)
  assert.equal(payload.message.zh, USER_PROMPT_ZH)
  assert.equal(payload.pluginVersion, '1.5.7')
  assert.equal(payload.patchEnabled, true, 'the browser half reads patchEnabled to keep watching')
  assert.equal(payload.targetFile, 'C:/p/qq-tool-restrict.mjs')
  assert.ok(payload.title.zh.length > 0)
  assert.ok(payload.allowedNotice.zh.length > 0)
  assert.ok(payload.deniedNotice.zh.length > 0)
  assert.equal(payload.allowLabel.zh, '允许')
  assert.equal(payload.denyLabel.zh, '不允许')

  const decided = describeConsentState({ detection: DERPYU, compat: {}, record: { decision: 'denied' } })
  const decidedPayload = consentPayload({ state: decided })
  assert.equal(decidedPayload.pending, false)
  assert.equal(decidedPayload.decision, 'denied')
  assert.equal(decidedPayload.patchAllowed, false)
  assert.equal(decidedPayload.pluginVersion, 'unknown', 'a missing version is never null')
  assert.equal(decidedPayload.targetFile, null)
})

test('consent: a deny writes enabled:false into config.local.json without losing keys', () => {
  withTempDir((dir) => {
    const target = localConfigPath(dir)
    assert.equal(target, path.join(dir, 'config.local.json'))
    assert.equal(localConfigPath(''), undefined)

    // No file yet: created with just the switch.
    let result = writeLocalDisable(dir)
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { enabled: false })
    assert.equal(readFileSync(target, 'utf8').endsWith('\n'), true)

    // Existing local config: other keys survive, enabled is flipped.
    writeFileSync(target, JSON.stringify({ enabled: true, compat: { ownerIds: ['1'] }, _readme: 'keep me' }, null, 2), 'utf8')
    result = writeLocalDisable(dir)
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {
      enabled: false,
      compat: { ownerIds: ['1'] },
      _readme: 'keep me',
    })

    // Broken JSON: never overwrite the user's file; report the failure.
    writeFileSync(target, '{ broken', 'utf8')
    result = writeLocalDisable(dir)
    assert.equal(result.ok, false)
    assert.match(result.error, /not readable JSON/)
    assert.equal(readFileSync(target, 'utf8'), '{ broken')

    // Non-object root is refused too.
    writeFileSync(target, '["enabled"]', 'utf8')
    result = writeLocalDisable(dir)
    assert.equal(result.ok, false)
    assert.match(result.error, /not a JSON object/)
    assert.equal(readFileSync(target, 'utf8'), '["enabled"]')

    // clearLocalDisable removes only the switch (used when rofm is re-enabled).
    writeFileSync(target, JSON.stringify({ enabled: false, compat: { ownerIds: ['1'] } }, null, 2), 'utf8')
    const cleared = clearLocalDisable(dir)
    assert.equal(cleared.ok, true)
    assert.equal(cleared.changed, true)
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { compat: { ownerIds: ['1'] } })
    assert.equal(clearLocalDisable(dir).changed, false, 'a second clear is a no-op')
    writeFileSync(target, '{ broken', 'utf8')
    assert.equal(clearLocalDisable(dir).ok, false)
    assert.equal(readFileSync(target, 'utf8'), '{ broken')

    assert.equal(writeLocalDisable('').ok, false)
  })
})

test('consent: the machine-level state directory is created on demand', () => {
  withTempDir(() => {
    // $DSH_HOME/rofm may not exist yet; the atomic write creates it.
    assert.equal(existsSync(consentStateDir()), false)
    assert.equal(writeConsent('denied').ok, true)
    assert.equal(existsSync(path.join(consentStateDir(), CONSENT_FILE_NAME)), true)
    assert.equal(readConsent().decision, 'denied')
  })
})
