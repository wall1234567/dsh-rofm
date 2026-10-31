/**
 * Unit tests for the QQ compatibility layer (`lib/compat.js`).
 *
 * Everything here is pure: detection reads a temporary fake profile, session
 * parsing is string work, the owner gate is one small decision function. The
 * adapter integration (plugin.js wiring) is covered by
 * `test-adapter/compat-integration.test.mjs`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  COMPAT_MODES,
  CompatDetector,
  DEFAULT_COMPAT_CONFIG,
  DERPYU_TOOL_NAMES,
  ONEBOT_SOURCE_KIND,
  compatDefaults,
  detectQqCompat,
  detectionLogLine,
  mergeTriggerSourceKinds,
  normalizeCompatConfig,
  parseOwnerIdentity,
  parseSessionChatKey,
  profileDirCandidates,
  resolveChannelScore,
  resolveProfileDir,
  resolveRecallGate,
  scanProfile,
  stripOnebotSuffix,
} from '../lib/compat.js'

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-compat-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

/** A base36 epoch-ms suffix as produced by `Date.now().toString(36)`. */
const NOW_SUFFIX = Date.now().toString(36)

// ---------------------------------------------------------------- config

test('normalizeCompatConfig: a missing block yields defaults with no warnings', () => {
  for (const raw of [undefined, null]) {
    const { compat, warnings } = normalizeCompatConfig(raw)
    assert.deepEqual(warnings, [])
    assert.equal(compat.qqBots, 'auto')
    assert.deepEqual(compat.ownerIds, [])
    assert.equal(compat.memberMinAlpha, 0.5)
    assert.equal(compat.autoPatchDerpyu, true)
    assert.equal(compat.channelScore, 'model')
    assert.deepEqual(compat.mediaRoots, [])
    assert.equal(compat.maxImageBytes, 8 * 1024 * 1024)
    assert.equal(compat.stagingTtlMs, 24 * 60 * 60 * 1000)
  }
})

test('normalizeCompatConfig: invalid fields fall back to defaults with warnings', () => {
  const { compat, warnings } = normalizeCompatConfig({
    qqBots: 'maybe',
    ownerIds: 'me',
    memberMinAlpha: 2,
    autoPatchDerpyu: 'yes',
    channelScore: 'magic',
    mediaRoots: 'C:/x',
    maxImageBytes: -1,
    stagingTtlMs: 1.5,
  })
  assert.equal(compat.qqBots, 'auto')
  assert.deepEqual(compat.ownerIds, [])
  assert.equal(compat.memberMinAlpha, 0.5)
  assert.equal(compat.autoPatchDerpyu, true)
  assert.equal(compat.channelScore, 'model')
  assert.deepEqual(compat.mediaRoots, [])
  assert.equal(compat.maxImageBytes, DEFAULT_COMPAT_CONFIG.maxImageBytes)
  assert.equal(compat.stagingTtlMs, DEFAULT_COMPAT_CONFIG.stagingTtlMs)
  assert.equal(warnings.length, 8, warnings.join('\n'))
  assert.ok(warnings.some((warning) => warning.startsWith('compat.qqBots')))
})

test('normalizeCompatConfig: valid values are kept and normalized', () => {
  const { compat, warnings } = normalizeCompatConfig({
    qqBots: 'on',
    ownerIds: [' 123 ', 456, 456],
    memberMinAlpha: 0,
    autoPatchDerpyu: false,
    channelScore: 'heuristic',
    mediaRoots: ['C:/media', 'C:/media', ''],
    maxImageBytes: 1024,
    stagingTtlMs: 0,
  })
  assert.deepEqual(warnings, [])
  assert.equal(compat.qqBots, 'on')
  assert.deepEqual(compat.ownerIds, ['123', '456'])
  assert.equal(compat.memberMinAlpha, 0)
  assert.equal(compat.autoPatchDerpyu, false)
  assert.equal(compat.channelScore, 'heuristic')
  assert.equal(compat.mediaRoots.length, 1)
  assert.equal(compat.maxImageBytes, 1024)
  assert.equal(compat.stagingTtlMs, 0)
})

test('normalizeCompatConfig: only a wrong ownerIds entry type is reported', () => {
  const { compat, warnings } = normalizeCompatConfig({ ownerIds: ['123', '123', '', null, 5] })
  assert.deepEqual(compat.ownerIds, ['123', '5'])
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].startsWith('compat.ownerIds'))
})

test('compatDefaults returns a fresh mutable copy each time', () => {
  const first = compatDefaults()
  const second = compatDefaults()
  first.ownerIds.push('1')
  first.mediaRoots.push('C:/x')
  assert.deepEqual(second.ownerIds, [])
  assert.deepEqual(second.mediaRoots, [])
  assert.equal(Object.isFrozen(second), false)
})

// ------------------------------------------------------------- detection

test('profileDirCandidates: DSH_PROFILE_DIR wins, then DSH_HOME/DSH_PROFILE, then ~/.dsh/profiles/desktop', () =>
  withTempDir((dir) => {
    const profileDir = path.join(dir, 'profiles', 'one')
    const dshHome = path.join(dir, 'dshhome')
    const homeDir = path.join(dir, 'home')
    const candidates = profileDirCandidates({
      env: { DSH_PROFILE_DIR: profileDir, DSH_HOME: dshHome, DSH_PROFILE: 'web' },
      homeDir,
    })
    assert.deepEqual(candidates, [
      path.resolve(profileDir),
      path.resolve(dshHome, 'profiles', 'web'),
      path.resolve(homeDir, '.dsh', 'profiles', 'desktop'),
    ])
    const fallback = profileDirCandidates({ env: {}, homeDir })
    assert.deepEqual(fallback, [path.resolve(homeDir, '.dsh', 'profiles', 'desktop')])
  }))

test('resolveProfileDir returns undefined when no candidate exists', () =>
  withTempDir((dir) => {
    assert.equal(resolveProfileDir({ env: { DSH_PROFILE_DIR: path.join(dir, 'nope') }, homeDir: dir }), undefined)
    mkdirSync(path.join(dir, 'p'), { recursive: true })
    assert.equal(resolveProfileDir({ env: { DSH_PROFILE_DIR: path.join(dir, 'p') }, homeDir: dir }), path.join(dir, 'p'))
  }))

test('scanProfile finds dsh-onebot-qq through each independent signal', () =>
  withTempDir((dir) => {
    // signal 1: package.json dependency
    writeJson(path.join(dir, 'package.json'), { dependencies: { 'dsh-onebot-qq': '^0.9.6' } })
    assert.equal(scanProfile(dir).onebot.detected, true)
    // signal 2: installed node_modules entry
    const second = path.join(dir, 'second')
    mkdirSync(path.join(second, 'node_modules', 'dsh-onebot-qq'), { recursive: true })
    assert.equal(scanProfile(second).onebot.detected, true)
    // signal 3: patch file reference
    const third = path.join(dir, 'third')
    mkdirSync(third, { recursive: true })
    writeFileSync(path.join(third, 'cordis.patch.yml'), '- insert:\n    - id: onebot\n      name: dsh-onebot-qq\n')
    assert.equal(scanProfile(third).onebot.detected, true)
  }))

test('scanProfile finds Derpyu through bundles, dependencies, patch markers and node_modules', () =>
  withTempDir((dir) => {
    const byBundle = path.join(dir, 'bundle')
    writeJson(path.join(byBundle, 'package.json'), {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'qq-agent-presets', 'qq-mode-console'] } },
    })
    const detection = scanProfile(byBundle)
    assert.equal(detection.derpyu.detected, true)
    assert.ok(detection.derpyu.evidence.some((item) => item.includes('qq-agent-presets')))

    const byPatch = path.join(dir, 'patch')
    mkdirSync(byPatch, { recursive: true })
    writeFileSync(path.join(byPatch, 'cordis.patch.yml'), '- id: mcp-snowluma\n- name: preset-qq-chat\n')
    assert.equal(scanProfile(byPatch).derpyu.detected, true)

    const byModules = path.join(dir, 'modules')
    mkdirSync(path.join(byModules, 'node_modules', 'qq-agent-presets'), { recursive: true })
    assert.equal(scanProfile(byModules).derpyu.detected, true)
  }))

test('scanProfile tolerates a missing or corrupt profile without throwing', () =>
  withTempDir((dir) => {
    const empty = scanProfile(path.join(dir, 'missing'))
    assert.deepEqual(empty, { onebot: { detected: false, evidence: [] }, derpyu: { detected: false, evidence: [] } })
    writeFileSync(path.join(dir, 'package.json'), '{ not json')
    assert.equal(scanProfile(dir).onebot.detected, false)
    assert.equal(scanProfile(undefined).onebot.detected, false)
  }))

test('detectQqCompat: auto enables only for an installed plugin', () =>
  withTempDir((dir) => {
    writeJson(path.join(dir, 'package.json'), { dependencies: { 'dsh-onebot-qq': '^0.9.6' } })
    const detection = detectQqCompat({ profileDir: dir, qqBots: 'auto' })
    assert.equal(detection.enabled, true)
    assert.equal(detection.onebot.detected, true)
    assert.equal(detection.derpyu.detected, false)
    assert.deepEqual(detection.reasons, ['dsh-onebot-qq'])
    assert.equal(detectionLogLine(detection), 'compat enabled (dsh-onebot-qq)')

    const clean = path.join(dir, 'clean')
    mkdirSync(clean, { recursive: true })
    writeJson(path.join(clean, 'package.json'), { dependencies: { 'dsh-rofm': '^1.2.1' } })
    const off = detectQqCompat({ profileDir: clean, qqBots: 'auto' })
    assert.equal(off.enabled, false)
    assert.equal(detectionLogLine(off), undefined)
  }))

test('detectQqCompat: qqBots=off forces off, qqBots=on forces on', () =>
  withTempDir((dir) => {
    writeJson(path.join(dir, 'package.json'), { dependencies: { 'dsh-onebot-qq': '^0.9.6' } })
    const forcedOff = detectQqCompat({ profileDir: dir, qqBots: 'off' })
    assert.equal(forcedOff.enabled, false)
    assert.deepEqual(forcedOff.reasons, ['compat.qqBots=off'])
    // "off" must not even scan the profile (cheap + no misleading evidence).
    assert.deepEqual(forcedOff.onebot, { detected: false, evidence: [] })

    const forcedOn = detectQqCompat({ profileDir: path.join(dir, 'missing'), qqBots: 'on' })
    assert.equal(forcedOn.enabled, true)
    assert.deepEqual(forcedOn.reasons, ['forced by compat.qqBots=on'])
  }))

test('detectQqCompat: a broken or missing profile never throws', () => {
  const broken = detectQqCompat({ profileDir: undefined, qqBots: 'auto', env: {}, homeDir: path.join(os.tmpdir(), 'dsh-rofm-nope-home') })
  assert.equal(broken.enabled, false)
  assert.ok(broken.warnings.some((warning) => warning.includes('profile')))
})

test('CompatDetector caches by mtime and re-detects after a profile change', () =>
  withTempDir((dir) => {
    writeJson(path.join(dir, 'package.json'), { dependencies: {} })
    const detector = new CompatDetector({ profileDirs: [dir] })
    const first = detector.detect('auto')
    assert.equal(first.enabled, false)
    assert.equal(detector.detect('auto'), first, 'same signature must reuse the cached object')

    writeJson(path.join(dir, 'package.json'), { dependencies: { 'dsh-onebot-qq': '^0.9.6' } })
    // Force a distinct mtime: Windows can tie two writes within the same tick.
    const stamp = new Date(Date.now() + 5000)
    utimesSync(path.join(dir, 'package.json'), stamp, stamp)
    const second = detector.detect('auto')
    assert.notEqual(second, first)
    assert.equal(second.enabled, true)
    // A mode change must not reuse the previous detection either.
    const off = detector.detect('off')
    assert.equal(off.enabled, false)
  }))

// ----------------------------------------------------------- session ids

test('parseSessionChatKey: plain sessions keep their id verbatim', () => {
  for (const id of ['session-test', 'abc-123', '', undefined, null]) {
    const parsed = parseSessionChatKey(id)
    assert.equal(parsed.mode, COMPAT_MODES.PLAIN)
    assert.equal(parsed.chatKey, String(id ?? '').trim())
    assert.equal(parsed.suffix, '')
  }
})

test('parseSessionChatKey: onebot ids drop only a plausible timestamp suffix', () => {
  const plainChat = parseSessionChatKey('onebot-123456')
  assert.equal(plainChat.mode, COMPAT_MODES.ONEBOT)
  assert.equal(plainChat.chatKey, 'onebot-123456')
  assert.equal(plainChat.suffix, '')

  const collided = parseSessionChatKey(`onebot-123456-${NOW_SUFFIX}`)
  assert.equal(collided.mode, COMPAT_MODES.ONEBOT)
  assert.equal(collided.chatKey, 'onebot-123456')
  assert.equal(collided.suffix, NOW_SUFFIX)

  const group = parseSessionChatKey(`onebot-group_789-${NOW_SUFFIX}`)
  assert.equal(group.chatKey, 'onebot-group_789')

  // A chat id that merely ends in base36 characters (not a plausible epoch) is
  // kept: stripping it would silently merge two different chats.
  const lookalike = parseSessionChatKey('onebot-group-abc1234')
  assert.equal(lookalike.chatKey, 'onebot-group-abc1234')
  assert.equal(lookalike.suffix, '')

  const shortNumber = parseSessionChatKey('onebot-123-456789')
  assert.equal(shortNumber.chatKey, 'onebot-123-456789')
})

test('stripOnebotSuffix only strips in-epoch base36 values and never empties the base', () => {
  assert.deepEqual(stripOnebotSuffix('123456'), { base: '123456', suffix: '' })
  assert.deepEqual(stripOnebotSuffix(`123456-${NOW_SUFFIX}`), { base: '123456', suffix: NOW_SUFFIX })
  // 7 chars, parses to ~1988 (below the 2000 floor).
  assert.deepEqual(stripOnebotSuffix('123456-zzzzzz1'), { base: '123456-zzzzzz1', suffix: '' })
  // Negative/None: base36 parse of an in-range but out-of-window value.
  assert.deepEqual(stripOnebotSuffix('123456-1'), { base: '123456-1', suffix: '' })
  assert.deepEqual(stripOnebotSuffix(''), { base: '', suffix: '' })
})

test('parseSessionChatKey: Derpyu ids drop the 32-hex rebuild suffix', () => {
  const hex = 'a'.repeat(32)
  const rebuilt = parseSessionChatKey(`qqb-g-123456-${hex}`)
  assert.equal(rebuilt.mode, COMPAT_MODES.DERPYU)
  assert.equal(rebuilt.chatKey, 'qqb-g-123456')
  assert.equal(rebuilt.suffix, hex)

  const privateChat = parseSessionChatKey(`qqb-p-99-${hex}`)
  assert.equal(privateChat.mode, COMPAT_MODES.DERPYU)
  assert.equal(privateChat.chatKey, 'qqb-p-99')

  const bare = parseSessionChatKey('qqb-g-123456')
  assert.equal(bare.mode, COMPAT_MODES.DERPYU)
  assert.equal(bare.chatKey, 'qqb-g-123456')
  assert.equal(bare.suffix, '')

  // Both rebuilds of the same QQ chat must land on the same chat key.
  assert.equal(parseSessionChatKey(`qqb-g-7-${'b'.repeat(32)}`).chatKey, parseSessionChatKey(`qqb-g-7-${'c'.repeat(32)}`).chatKey)
})

test('parseSessionChatKey: near-misses stay plain sessions', () => {
  for (const id of [
    'qqb-x-1',
    'qqb-g-',
    'qqb-g-12-0123456789abcdef',
    'qqb-g-12-' + 'A'.repeat(32),
    'QQB-g-12',
    'onebot',
  ]) {
    assert.equal(parseSessionChatKey(id).mode, COMPAT_MODES.PLAIN, id)
  }
})

// ---------------------------------------------------------- owner parsing

test('parseOwnerIdentity reads the structured onebot wrapper first', () => {
  const text = '<user_message qq="10001" nickname="阿明">今天谁值班？</user_message>'
  assert.deepEqual(parseOwnerIdentity(text), { ownerId: '10001', nickname: '阿明', source: 'structured', restricted: false })
})

test('parseOwnerIdentity falls back to the [HH:MM nick(uid)] group prefix', () => {
  const text = '[09:30 小明(20002)] 昨天的部署参数是多少？\n[09:31 小红(20003)] 同问'
  const parsed = parseOwnerIdentity(text)
  assert.equal(parsed.ownerId, '20002')
  assert.equal(parsed.nickname, '小明')
  assert.equal(parsed.source, 'prefix')
})

test('parseOwnerIdentity reports restricted members and unmarked text', () => {
  const restricted = parseOwnerIdentity('[09:30 小明(20002)] [受限用户:仅问答] 你好')
  assert.equal(restricted.restricted, true)
  assert.equal(restricted.ownerId, '20002')
  for (const text of ['', undefined, null, '普通消息', 'no identity here']) {
    const parsed = parseOwnerIdentity(text)
    assert.equal(parsed.ownerId, undefined)
    assert.equal(parsed.source, 'none')
  }
})

test('resolveRecallGate: owner messages and unmarked messages are ungated', () => {
  const compat = { ownerIds: ['10001'], memberMinAlpha: 0.5 }
  assert.equal(resolveRecallGate({ mode: COMPAT_MODES.ONEBOT, text: '<user_message qq="10001" nickname="A">x</user_message>', compat }).minAlpha, 0)
  // Private chat / WebUI: no sender marker at all.
  assert.equal(resolveRecallGate({ mode: COMPAT_MODES.ONEBOT, text: '帮我记一下', compat }).minAlpha, 0)
  // Derpyu triggers are synthetic wake prompts: never gated.
  assert.equal(resolveRecallGate({ mode: COMPAT_MODES.DERPYU, text: '[09:30 小明(20002)] x', compat }).minAlpha, 0)
  assert.equal(resolveRecallGate({ mode: COMPAT_MODES.PLAIN, text: '[09:30 小明(20002)] x', compat }).minAlpha, 0)
})

test('resolveRecallGate: a non-owner group member recalls with memberMinAlpha', () => {
  const compat = { ownerIds: ['10001'], memberMinAlpha: 0.5 }
  const group = resolveRecallGate({ mode: COMPAT_MODES.ONEBOT, text: '[09:30 小明(20002)] 部署参数', compat })
  assert.equal(group.gated, true)
  assert.equal(group.minAlpha, 0.5)
  assert.equal(group.ownerId, '20002')
  assert.equal(group.nickname, '小明')

  // Empty ownerIds: every marked sender is a non-owner (there is no owner yet).
  const nobody = resolveRecallGate({ mode: COMPAT_MODES.ONEBOT, text: '[09:30 小明(20002)] x', compat: { ownerIds: [], memberMinAlpha: 0.7 } })
  assert.equal(nobody.gated, true)
  assert.equal(nobody.minAlpha, 0.7)
})

test('resolveRecallGate: memberMinAlpha=0 (or invalid) disables the gate', () => {
  const text = '[09:30 小明(20002)] 部署参数'
  assert.equal(resolveRecallGate({ mode: COMPAT_MODES.ONEBOT, text, compat: { ownerIds: [], memberMinAlpha: 0 } }).gated, false)
  assert.equal(resolveRecallGate({ mode: COMPAT_MODES.ONEBOT, text, compat: { ownerIds: [], memberMinAlpha: -1 } }).gated, false)
  assert.equal(resolveRecallGate({ mode: COMPAT_MODES.ONEBOT, text, compat: {} }).minAlpha, 0)
})

// ------------------------------------------- trigger kinds / scoring mode

test('mergeTriggerSourceKinds adds the onebot kind only when compat is enabled', () => {
  assert.deepEqual(mergeTriggerSourceKinds(['user'], { enabled: false }), ['user'])
  assert.deepEqual(mergeTriggerSourceKinds(undefined, { enabled: false }), ['user'])
  assert.deepEqual(mergeTriggerSourceKinds(['user'], { enabled: true }), ['user', ONEBOT_SOURCE_KIND])
  // Idempotent, and a custom list keeps its own kinds.
  assert.deepEqual(
    mergeTriggerSourceKinds(['user', ONEBOT_SOURCE_KIND], { enabled: true }),
    ['user', ONEBOT_SOURCE_KIND],
  )
  assert.deepEqual(mergeTriggerSourceKinds(['user', 'agent-message'], { enabled: true }), ['user', 'agent-message', ONEBOT_SOURCE_KIND])
})

test('resolveChannelScore: Derpyu degrades to heuristic until the patch is applied', () => {
  assert.equal(resolveChannelScore({ mode: COMPAT_MODES.PLAIN }), 'model')
  assert.equal(resolveChannelScore({ mode: COMPAT_MODES.ONEBOT, compat: { channelScore: 'model' } }), 'model')
  assert.equal(
    resolveChannelScore({ mode: COMPAT_MODES.DERPYU, compat: { channelScore: 'model' }, autopatchApplied: false }),
    'heuristic',
  )
  assert.equal(
    resolveChannelScore({ mode: COMPAT_MODES.DERPYU, compat: { channelScore: 'model' }, autopatchApplied: true }),
    'model',
  )
  assert.equal(
    resolveChannelScore({ mode: COMPAT_MODES.ONEBOT, compat: { channelScore: 'heuristic' } }),
    'heuristic',
  )
  assert.equal(resolveChannelScore({ mode: COMPAT_MODES.DERPYU, compat: { channelScore: 'heuristic' }, autopatchApplied: true }), 'heuristic')
})

test('DERPYU_TOOL_NAMES is the documented three-name whitelist', () => {
  assert.deepEqual([...DERPYU_TOOL_NAMES], ['memory_judge', 'memory_recall', 'memory_image'])
  assert.equal(Object.isFrozen(DERPYU_TOOL_NAMES), true)
})
