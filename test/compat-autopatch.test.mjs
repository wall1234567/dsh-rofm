/**
 * dsh-rofm — Derpyu 工具白名单自动补丁测试（P1b：lib/compat-autopatch.js）。
 *
 * 全部在 os.tmpdir() 里搭"profile + qq-agent-presets 包"临时夹具（默认用 `link:`
 * 依赖，与 Derpyu 的 scripts/setup-dsh.mjs 实际安装形态一致），测完统一清理，
 * 不碰真实 profile、不污染仓库。目标文件内容按真实
 * `plugins/qq-agent-presets/qq-tool-restrict.mjs` 的 SAFE_EXACT 段结构构造。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import {
  AUTO_PATCH_TOOL_NAMES,
  ensureAutopatch,
  locateToolRestrictFile,
  patchText,
  readAutopatchState,
} from '../lib/compat-autopatch.js'

const MARKER = '// rofm-autopatch: 自动补丁注入'

// ---------------------------------------------------------------------------
// 临时目录 + 夹具
// ---------------------------------------------------------------------------

const tempDirs = []

function makeTempDir(prefix = 'dsh-rofm-autopatch-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort：只读用例会在 finally 里恢复权限 */
    }
  }
})

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function readFile(file) {
  return fs.readFileSync(file, 'utf8')
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function listBackups(file) {
  const dir = path.dirname(file)
  const prefix = `${path.basename(file)}.bak-rofm-`
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith(prefix))
  } catch {
    return []
  }
}

function listTmpFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.includes('.rofm-tmp-'))
  } catch {
    return []
  }
}

/** 与 Derpyu 真实文件同结构的夹具（SAFE_EXACT 是唯一被识别的段落）。 */
function upstreamText() {
  return [
    '// fixture：与真实 qq-tool-restrict.mjs 的 SAFE_EXACT 段结构一致',
    'const SAFE_PREFIXES = [',
    "  'mcp__snowluma__',",
    ']',
    '',
    'const SAFE_EXACT = new Set([',
    "  'ask_user_question',",
    "  'todo_write',",
    '])',
    '',
    'export function apply(ctx) {',
    '  ctx.tools.guard((exec) => SAFE_EXACT.has(exec?.name))',
    '}',
    '',
  ].join('\n')
}

/** 已打补丁的夹具文本（用于 already 用例）。 */
function patchedText() {
  const result = patchText(upstreamText())
  assert.equal(result.status, 'patchable')
  return result.text
}

/**
 * profile 夹具。mode 覆盖定位模块支持的全部安装形态：
 *   link / link-relative / file / version / node-modules / junction / empty
 */
function makeFixture({ mode = 'link', toolText = upstreamText() } = {}) {
  const root = makeTempDir()
  const profileDir = path.join(root, 'profile')
  const packageDir = path.join(root, 'package')
  const memoryDir = path.join(root, 'memory')
  fs.mkdirSync(packageDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const packageFile = path.join(packageDir, 'qq-tool-restrict.mjs')
  writeFile(packageFile, toolText)

  const toPosix = (value) => value.replace(/\\/g, '/')
  const nodeModulesDir = path.join(profileDir, 'node_modules', 'qq-agent-presets')
  let dependency
  if (mode === 'link') dependency = `link:${toPosix(packageDir)}`
  else if (mode === 'link-relative') dependency = `link:${toPosix(path.relative(profileDir, packageDir))}`
  else if (mode === 'file') dependency = `file:${toPosix(packageDir)}`
  else if (mode === 'version') dependency = '^1.0.0'
  else if (mode === 'junction') dependency = '^1.0.0'
  else if (mode !== 'node-modules' && mode !== 'empty') throw new Error(`unknown fixture mode: ${mode}`)

  if (dependency !== undefined) {
    writeJson(path.join(profileDir, 'package.json'), {
      name: 'dsh-profile-fixture',
      private: true,
      dependencies: { 'qq-agent-presets': dependency },
      dsh: { profile: { bundles: ['qq-agent-presets'] } },
    })
  }
  if (mode === 'version' || mode === 'node-modules') {
    writeFile(path.join(nodeModulesDir, 'qq-tool-restrict.mjs'), toolText)
  }
  if (mode === 'junction') {
    fs.mkdirSync(path.dirname(nodeModulesDir), { recursive: true })
    fs.symlinkSync(packageDir, nodeModulesDir, 'junction')
  }

  const byPackageDir = mode === 'link' || mode === 'link-relative' || mode === 'file' || mode === 'junction'
  return {
    root,
    profileDir,
    packageDir,
    memoryDir,
    packageFile,
    targetFile: byPackageDir ? packageFile : path.join(nodeModulesDir, 'qq-tool-restrict.mjs'),
  }
}

/** 形如 lib/compat.js 的 detectQqCompat() 结果（本模块只需要这两层判定）。 */
function derpyuDetection(profileDir) {
  return {
    enabled: true,
    qqBots: 'auto',
    profileDir,
    onebot: { detected: false, evidence: [] },
    derpyu: { detected: true, evidence: ['fixture: qq-agent-presets'] },
    reasons: ['derpyu-qq-bridge'],
    warnings: [],
    cacheKey: 'fixture',
  }
}

// ---------------------------------------------------------------------------
// patchText：纯函数识别 + 注入
// ---------------------------------------------------------------------------

test('patchText：三名字已在 SAFE_EXACT 内 → already，不返回文本', () => {
  const result = patchText(patchedText())
  assert.equal(result.status, 'already')
  assert.equal(result.text, undefined)
  assert.equal(result.reason, undefined)
})

test('patchText：缺三名字 → patchable，插入行带标记且顺序/原有元素不变', () => {
  const text = upstreamText()
  const result = patchText(text)
  assert.equal(result.status, 'patchable')
  assert.equal(typeof result.text, 'string')
  const patched = result.text

  for (const element of ["'ask_user_question'", "'todo_write'", 'const SAFE_EXACT = new Set([']) {
    assert.ok(patched.includes(element), `缺少原有内容：${element}`)
  }
  // 三个新名字插在第一个元素之后、todo_write 之前，且各出现一次。
  const positions = ["'ask_user_question'", "'memory_judge'", "'memory_recall'", "'memory_image'", "'todo_write'"].map((needle) =>
    patched.indexOf(needle),
  )
  for (let i = 1; i < positions.length; i += 1) assert.ok(positions[i - 1] < positions[i], '注入顺序错误')
  for (const name of AUTO_PATCH_TOOL_NAMES) assert.equal(patched.split(`'${name}'`).length - 1, 1, name)
  // 每行注入都带可识别的行尾标记。
  assert.equal(patched.split(MARKER).length - 1, 3)
  // 行径缩进与原元素一致（2 空格）。
  assert.ok(patched.includes(`  'memory_judge', ${MARKER}\n`))
  // 纯函数幂等：再解析一次即 already。
  assert.equal(patchText(patched).status, 'already')
})

test('patchText：部分已存在 → 只补缺失项，不重复注入', () => {
  const text = upstreamText().replace("  'ask_user_question',", "  'ask_user_question',\n  'memory_judge',")
  const result = patchText(text)
  assert.equal(result.status, 'patchable')
  const patched = result.text
  for (const name of AUTO_PATCH_TOOL_NAMES) assert.equal(patched.split(`'${name}'`).length - 1, 1, name)
  assert.equal(patched.split(MARKER).length - 1, 2)
  assert.equal(patchText(patched).status, 'already')
})

test('patchText：names 参数可定制，且不会把默认三名字误判为 already', () => {
  const custom = patchText(upstreamText(), ['custom_memory_tool'])
  assert.equal(custom.status, 'patchable')
  assert.ok(custom.text.includes(`'custom_memory_tool', ${MARKER}`))
  assert.equal(patchText(custom.text, ['custom_memory_tool']).status, 'already')
  // 默认三工具还没注入 → 仍可补（说明 already 判定只看 Set 内实际名字）。
  assert.equal(patchText(custom.text).status, 'patchable')
})

test('patchText：没有 SAFE_EXACT 结构 → unsupported 且不返回文本', () => {
  const text = "const TOOL_NAMES = new Set([\n  'ask_user_question',\n])\n"
  const result = patchText(text)
  assert.equal(result.status, 'unsupported')
  assert.equal(result.text, undefined)
  assert.match(result.reason, /SAFE_EXACT/)
})

test('patchText：结构不同（单行 Set / 非字符串元素 / 一行多元素）→ unsupported', () => {
  const cases = [
    "const SAFE_EXACT = new Set(['ask_user_question', 'todo_write'])\n",
    "const SAFE_EXACT = new Set([\n  ask_user_question,\n  todo_write,\n])\n",
    "const SAFE_EXACT = new Set([\n  'ask_user_question', 'todo_write',\n])\n",
    "const SAFE_EXACT = new Set([\n  SAFE_EXTRA[0],\n])\n",
    "const SAFE_EXACT = new Set([\n  `ask_user_question`,\n])\n",
  ]
  for (const text of cases) {
    const result = patchText(text)
    assert.equal(result.status, 'unsupported', JSON.stringify(text))
    assert.equal(typeof result.reason, 'string')
    assert.equal(result.text, undefined)
  }
})

test('patchText：空 SAFE_EXACT 无法定位插入行 → unsupported；空 names → already', () => {
  assert.equal(patchText('const SAFE_EXACT = new Set([\n])\n').status, 'unsupported')
  assert.equal(patchText(upstreamText(), []).status, 'already')
})

test('patchText：CRLF 文件注入行仍用 CRLF（不产生混合行尾）', () => {
  const text = upstreamText().replace(/\n/g, '\r\n')
  const result = patchText(text)
  assert.equal(result.status, 'patchable')
  assert.ok(result.text.includes(`'memory_judge', ${MARKER}\r\n`))
  // 不允许出现裸 \n 行尾（文件原本全是 CRLF）。
  assert.ok(!/(?<!\r)\n/.test(result.text), '存在裸 \\n 行尾')
  assert.equal(patchText(result.text).status, 'already')
})

test('patchText：非字符串输入 / 非法工具名 → unsupported，不抛异常', () => {
  for (const value of [undefined, null, 12345, {}, []]) {
    const result = patchText(value)
    assert.equal(result.status, 'unsupported')
  }
  const illegal = patchText(upstreamText(), ["bad'name"])
  assert.equal(illegal.status, 'unsupported')
  assert.match(illegal.reason, /工具名/)
})

// ---------------------------------------------------------------------------
// locateToolRestrictFile：定位
// ---------------------------------------------------------------------------

test('locateToolRestrictFile：link: 绝对路径依赖 → 命中包内文件（source=package.json）', () => {
  const f = makeFixture({ mode: 'link' })
  const located = locateToolRestrictFile({ profileDir: f.profileDir })
  assert.ok(located)
  assert.equal(located.source, 'package.json')
  assert.equal(path.resolve(located.filePath), path.resolve(f.packageFile))
  assert.equal(path.resolve(located.packageDir), path.resolve(f.packageDir))
})

test('locateToolRestrictFile：link: 相对路径与 file: 依赖都能解析', () => {
  for (const mode of ['link-relative', 'file']) {
    const f = makeFixture({ mode })
    const located = locateToolRestrictFile({ profileDir: f.profileDir })
    assert.ok(located, mode)
    assert.equal(located.source, 'package.json', mode)
    assert.equal(path.resolve(located.filePath), path.resolve(f.packageFile), mode)
  }
})

test('locateToolRestrictFile：版本号依赖 → 退 node_modules 直查（source=node_modules）', () => {
  const f = makeFixture({ mode: 'version' })
  const located = locateToolRestrictFile({ profileDir: f.profileDir })
  assert.ok(located)
  assert.equal(located.source, 'node_modules')
  assert.equal(path.resolve(located.filePath), path.resolve(f.targetFile))
})

test('locateToolRestrictFile：仅 node_modules 存在；空 profile / 坏参数 → undefined 不抛', () => {
  const direct = makeFixture({ mode: 'node-modules' })
  const found = locateToolRestrictFile({ profileDir: direct.profileDir })
  assert.ok(found)
  assert.equal(found.source, 'node_modules')

  const empty = makeFixture({ mode: 'empty' })
  assert.equal(locateToolRestrictFile({ profileDir: empty.profileDir }), undefined)
  assert.equal(locateToolRestrictFile({ profileDir: path.join(empty.root, 'does-not-exist') }), undefined)
  assert.equal(locateToolRestrictFile({}), undefined)
  assert.equal(locateToolRestrictFile(), undefined)
  assert.equal(locateToolRestrictFile({ profileDir: 42 }), undefined)
})

test('locateToolRestrictFile：package.json 损坏 → 不抛，仍可走 node_modules 兜底', () => {
  const f = makeFixture({ mode: 'version' })
  writeFile(path.join(f.profileDir, 'package.json'), '{ not json ')
  const located = locateToolRestrictFile({ profileDir: f.profileDir })
  assert.ok(located)
  assert.equal(located.source, 'node_modules')

  const broken = makeFixture({ mode: 'empty' })
  writeFile(path.join(broken.profileDir, 'package.json'), '{ not json ')
  assert.equal(locateToolRestrictFile({ profileDir: broken.profileDir }), undefined)
})

test('locateToolRestrictFile + ensureAutopatch：node_modules 为 junction（Derpyu 实际形态）→ 写穿到真实包目录', (t) => {
  let f
  try {
    f = makeFixture({ mode: 'junction' })
  } catch (error) {
    t.skip(`当前环境不能创建目录 junction：${error.message}`)
    return
  }
  const located = locateToolRestrictFile({ profileDir: f.profileDir })
  assert.ok(located)
  assert.equal(located.source, 'node_modules')

  const result = ensureAutopatch({
    memoryDir: f.memoryDir,
    profileDir: f.profileDir,
    detection: derpyuDetection(f.profileDir),
  })
  assert.equal(result.status, 'patched')
  // junction 后面的真实 package 文件被改（而不是 junction 自身被替换成普通文件）。
  assert.equal(patchText(readFile(f.packageFile)).status, 'already')
  assert.ok(fs.lstatSync(path.join(f.profileDir, 'node_modules', 'qq-agent-presets')).isSymbolicLink())
})

// ---------------------------------------------------------------------------
// ensureAutopatch：主流程
// ---------------------------------------------------------------------------

test('ensureAutopatch：首次检测到 Derpyu → 原子注入 + 备份 + 状态记录', () => {
  const f = makeFixture({ mode: 'link' })
  const beforeText = readFile(f.packageFile)
  const now = new Date('2026-10-30T22:00:00+08:00')
  // 故意不传 profileDir：走 detection.profileDir 兜底（接线方只传 detection 也能工作）。
  const result = ensureAutopatch({ memoryDir: f.memoryDir, detection: derpyuDetection(f.profileDir), now })

  assert.equal(result.status, 'patched')
  assert.equal(path.resolve(result.filePath), path.resolve(f.packageFile))
  assert.ok(result.backupPath)
  assert.match(path.basename(result.backupPath), /\.bak-rofm-\d{14}$/)
  assert.ok(fs.existsSync(result.backupPath))
  assert.equal(readFile(result.backupPath), beforeText, '备份必须是打补丁前的原文')
  assert.equal(patchText(readFile(f.packageFile)).status, 'already')
  assert.equal(path.resolve(result.statePath), path.resolve(path.join(f.memoryDir, '.compat-state.json')))

  const state = readAutopatchState(f.memoryDir)
  assert.equal(state.version, 1)
  assert.equal(state.patches.length, 1)
  const record = state.patches[0]
  assert.equal(record.target, 'qq-agent-presets')
  assert.equal(path.resolve(record.filePath), path.resolve(f.packageFile))
  assert.equal(record.patchedAt, now.toISOString())
  assert.equal(record.backupPath, result.backupPath)
  assert.match(record.beforeHash, /^[0-9a-f]{64}$/)
  assert.match(record.afterHash, /^[0-9a-f]{64}$/)
  assert.notEqual(record.beforeHash, record.afterHash)
  assert.equal(record.beforeHash, sha256(beforeText))
  assert.equal(record.afterHash, sha256(readFile(f.packageFile)))
})

test('ensureAutopatch：上游已含三名字 → already，不备份、不写状态', () => {
  const f = makeFixture({ toolText: patchedText() })
  const beforeText = readFile(f.packageFile)
  const result = ensureAutopatch({
    memoryDir: f.memoryDir,
    profileDir: f.profileDir,
    detection: derpyuDetection(f.profileDir),
  })
  assert.equal(result.status, 'already')
  assert.equal(readFile(f.packageFile), beforeText)
  assert.equal(listBackups(f.packageFile).length, 0)
  assert.equal(fs.existsSync(path.join(f.memoryDir, '.compat-state.json')), false)
})

test('ensureAutopatch：重复调用 → already，文件/备份/状态都不变（幂等）', () => {
  const f = makeFixture()
  const options = { memoryDir: f.memoryDir, profileDir: f.profileDir, detection: derpyuDetection(f.profileDir) }
  assert.equal(ensureAutopatch(options).status, 'patched')

  const fileAfterFirst = readFile(f.packageFile)
  const stateFile = path.join(f.memoryDir, '.compat-state.json')
  const stateAfterFirst = readFile(stateFile)
  const backupsAfterFirst = listBackups(f.packageFile)
  assert.equal(backupsAfterFirst.length, 1)

  assert.equal(ensureAutopatch(options).status, 'already')
  assert.equal(readFile(f.packageFile), fileAfterFirst)
  assert.deepEqual(listBackups(f.packageFile), backupsAfterFirst)
  assert.equal(readFile(stateFile), stateAfterFirst)
})

test('ensureAutopatch：上游更新（hash 变化、三名字消失）→ 自愈重打并刷新记录', () => {
  const f = makeFixture()
  const options = { memoryDir: f.memoryDir, profileDir: f.profileDir, detection: derpyuDetection(f.profileDir) }
  assert.equal(ensureAutopatch({ ...options, now: new Date('2026-10-30T22:00:00+08:00') }).status, 'patched')
  const oldRecord = readAutopatchState(f.memoryDir).patches[0]

  // 模拟 Derpyu 升级：换回新上游内容（比原夹具多一行注释，hash 与旧 afterHash 不同）。
  const upgraded = upstreamText().replace('// fixture：', '// fixture (upgraded)：')
  assert.notEqual(sha256(upgraded), oldRecord.afterHash)
  writeFile(f.packageFile, upgraded)

  const healed = ensureAutopatch({ ...options, now: new Date('2026-10-31T09:30:00+08:00') })
  assert.equal(healed.status, 'patched')
  assert.equal(healed.reason, 'upstream-updated')
  assert.equal(patchText(readFile(f.packageFile)).status, 'already')

  const record = readAutopatchState(f.memoryDir).patches[0]
  assert.equal(record.beforeHash, sha256(upgraded))
  assert.equal(record.afterHash, sha256(readFile(f.packageFile)))
  assert.notEqual(record.afterHash, oldRecord.afterHash)
  assert.equal(listBackups(f.packageFile).length, 2)
})

test('ensureAutopatch：结构不识别 → failed，文件字节不变、不产生备份', () => {
  const f = makeFixture()
  const broken = "const SAFE_EXACT = [\n  'ask_user_question',\n]\n"
  writeFile(f.packageFile, broken)
  const warns = []
  const result = ensureAutopatch({
    memoryDir: f.memoryDir,
    profileDir: f.profileDir,
    detection: derpyuDetection(f.profileDir),
    logger: { warn: (line) => warns.push(line), info: () => {} },
  })
  assert.equal(result.status, 'failed')
  assert.match(result.reason, /^unsupported: /)
  assert.equal(readFile(f.packageFile), broken)
  assert.equal(listBackups(f.packageFile).length, 0)
  assert.equal(fs.existsSync(path.join(f.memoryDir, '.compat-state.json')), false)
  assert.ok(warns.some((line) => line.includes('结构无法识别')))
})

test('ensureAutopatch：只读文件 → failed，文件不变且无临时文件残留', () => {
  const f = makeFixture()
  fs.chmodSync(f.packageFile, 0o444)
  const beforeText = readFile(f.packageFile)
  try {
    const result = ensureAutopatch({
      memoryDir: f.memoryDir,
      profileDir: f.profileDir,
      detection: derpyuDetection(f.profileDir),
    })
    assert.equal(result.status, 'failed')
    assert.match(result.reason, /只读|不可写/)
    assert.equal(readFile(f.packageFile), beforeText)
    assert.equal(listBackups(f.packageFile).length, 0)
    assert.deepEqual(listTmpFiles(f.packageDir), [])
    assert.equal(fs.existsSync(path.join(f.memoryDir, '.compat-state.json')), false)
  } finally {
    fs.chmodSync(f.packageFile, 0o644)
  }
})

test('ensureAutopatch：同文件备份最多保留 5 份（清理最旧）', () => {
  const f = makeFixture()
  const baseMs = Date.parse('2026-10-30T22:00:00+08:00')
  // `backupStamp()` formats **local** time, so the expected names must be derived
  // from the same clock instead of hard-coded UTC+8 strings — otherwise this test
  // only passes in Asia/Shanghai and fails on every CI runner (all of them are
  // UTC), which is exactly what happened on the 1.3.0 release run.
  const localStamp = (ms) => {
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }
  for (let round = 0; round < 7; round += 1) {
    // 每轮都模拟一次"上游重新发布"，确保都要重新打补丁（才会产生新备份）。
    writeFile(f.packageFile, upstreamText().replace('// fixture：', `// fixture round ${round}：`))
    const result = ensureAutopatch({
      memoryDir: f.memoryDir,
      profileDir: f.profileDir,
      detection: derpyuDetection(f.profileDir),
      now: new Date(baseMs + round * 1000),
    })
    assert.equal(result.status, 'patched', `round ${round}`)
  }
  const backups = listBackups(f.packageFile)
  assert.equal(backups.length, 5)
  const newest = `bak-rofm-${localStamp(baseMs + 6 * 1000)}`
  const oldest = `bak-rofm-${localStamp(baseMs)}`
  const secondOldest = `bak-rofm-${localStamp(baseMs + 1000)}`
  assert.ok(backups.some((name) => name.endsWith(newest)), '应保留最新备份')
  assert.ok(!backups.some((name) => name.endsWith(oldest)), '最旧备份应被清理')
  assert.ok(!backups.some((name) => name.endsWith(secondOldest)), '次旧备份应被清理')
  assert.equal(patchText(readFile(f.packageFile)).status, 'already')
  // 同一目标文件在状态里只保留一条记录（不随每次备份膨胀）。
  assert.equal(readAutopatchState(f.memoryDir).patches.length, 1)
})

test('ensureAutopatch：不同 profile 共享 memoryDir → 状态保留两条记录', () => {
  const memoryDir = makeTempDir()
  const first = makeFixture()
  const second = makeFixture()
  assert.equal(
    ensureAutopatch({ memoryDir, profileDir: first.profileDir, detection: derpyuDetection(first.profileDir) }).status,
    'patched',
  )
  assert.equal(
    ensureAutopatch({ memoryDir, profileDir: second.profileDir, detection: derpyuDetection(second.profileDir) }).status,
    'patched',
  )
  const state = readAutopatchState(memoryDir)
  assert.equal(state.patches.length, 2)
})

// ---------------------------------------------------------------------------
// ensureAutopatch：开关 / 门控 / 失败安全
// ---------------------------------------------------------------------------

test('ensureAutopatch：enabled=false → disabled，完全不碰第三方文件与状态', () => {
  const f = makeFixture()
  const beforeText = readFile(f.packageFile)
  const result = ensureAutopatch({
    memoryDir: f.memoryDir,
    profileDir: f.profileDir,
    detection: derpyuDetection(f.profileDir),
    enabled: false,
  })
  assert.equal(result.status, 'disabled')
  assert.equal(readFile(f.packageFile), beforeText)
  assert.equal(listBackups(f.packageFile).length, 0)
  assert.equal(fs.existsSync(f.memoryDir), false)
})

test('ensureAutopatch：compat 未启用 / 未检测到 Derpyu / 未传 detection → 不动作', () => {
  const f = makeFixture()
  const beforeText = readFile(f.packageFile)
  const detection = derpyuDetection(f.profileDir)

  const disabled = ensureAutopatch({
    memoryDir: f.memoryDir,
    profileDir: f.profileDir,
    detection: { ...detection, enabled: false },
  })
  assert.equal(disabled.status, 'disabled')

  const undetected = ensureAutopatch({
    memoryDir: f.memoryDir,
    profileDir: f.profileDir,
    detection: { ...detection, derpyu: { detected: false, evidence: [] } },
  })
  assert.equal(undetected.status, 'no-target')

  const missing = ensureAutopatch({ memoryDir: f.memoryDir, profileDir: f.profileDir })
  assert.equal(missing.status, 'disabled')

  assert.equal(readFile(f.packageFile), beforeText)
  assert.equal(listBackups(f.packageFile).length, 0)
  assert.equal(fs.existsSync(f.memoryDir), false)
})

test('ensureAutopatch：找不到目标文件 → no-target + WARN，不写任何东西', () => {
  const f = makeFixture({ mode: 'empty' })
  const warns = []
  const result = ensureAutopatch({
    memoryDir: f.memoryDir,
    profileDir: f.profileDir,
    detection: derpyuDetection(f.profileDir),
    logger: { warn: (line) => warns.push(line), info: () => {} },
  })
  assert.equal(result.status, 'no-target')
  assert.equal(result.reason, 'target file not found')
  assert.ok(warns.some((line) => line.includes('未找到')))
  assert.equal(fs.existsSync(f.memoryDir), false)
})

test('ensureAutopatch：状态文件损坏 → 仍能打补丁并重建状态', () => {
  const f = makeFixture()
  const stateFile = path.join(f.memoryDir, '.compat-state.json')
  writeFile(stateFile, '{ this is not json')
  assert.deepEqual(readAutopatchState(f.memoryDir), {})

  const result = ensureAutopatch({
    memoryDir: f.memoryDir,
    profileDir: f.profileDir,
    detection: derpyuDetection(f.profileDir),
  })
  assert.equal(result.status, 'patched')
  const state = readAutopatchState(f.memoryDir)
  assert.equal(state.version, 1)
  assert.equal(state.patches.length, 1)
  assert.equal(state.patches[0].afterHash, sha256(readFile(f.packageFile)))
})

test('readAutopatchState：缺失 / 损坏 / 形状不对 / 非法 memoryDir → {}', () => {
  const f = makeFixture()
  assert.deepEqual(readAutopatchState(f.memoryDir), {})
  assert.deepEqual(readAutopatchState(undefined), {})
  assert.deepEqual(readAutopatchState(''), {})
  assert.deepEqual(readAutopatchState(42), {})

  const stateFile = path.join(f.memoryDir, '.compat-state.json')
  for (const bad of ['not json', '[]', '"a string"', 'null', '{"patches":"x"}', '{"version":1}', '{"patches":[]}extra']) {
    writeFile(stateFile, bad)
    assert.deepEqual(readAutopatchState(f.memoryDir), {}, `应为空对象：${bad}`)
  }
  // 合法状态（带 BOM）能读；非对象条目被过滤。
  writeFile(
    stateFile,
    `\uFEFF${JSON.stringify({ version: 1, patches: [{ target: 'qq-agent-presets' }, 'bad-entry', null] })}`,
  )
  assert.deepEqual(readAutopatchState(f.memoryDir), { version: 1, patches: [{ target: 'qq-agent-presets' }] })
})

test('ensureAutopatch：logger 兼容对象 / 双参函数 / 单参函数，且 logger 抛异常不影响补丁', () => {
  // 对象形式
  const first = makeFixture()
  const infoLines = []
  const warnLines = []
  const firstResult = ensureAutopatch({
    memoryDir: first.memoryDir,
    profileDir: first.profileDir,
    detection: derpyuDetection(first.profileDir),
    logger: { info: (line) => infoLines.push(line), warn: (line) => warnLines.push(line) },
  })
  assert.equal(firstResult.status, 'patched')
  assert.ok(infoLines.some((line) => line.startsWith('compat-autopatch: ') && line.includes('注入')))
  assert.equal(warnLines.length, 0)

  // 函数形式 (level, message) —— 与 RofmPlugin.log(level, message) 同签名
  const second = makeFixture()
  const calls = []
  const secondResult = ensureAutopatch({
    memoryDir: second.memoryDir,
    profileDir: second.profileDir,
    detection: derpyuDetection(second.profileDir),
    logger: (level, message) => calls.push([level, message]),
  })
  assert.equal(secondResult.status, 'patched')
  assert.ok(calls.some(([level, message]) => level === 'info' && message.includes('注入')))

  // 单参函数形式
  const third = makeFixture()
  const single = []
  const thirdResult = ensureAutopatch({
    memoryDir: third.memoryDir,
    profileDir: third.profileDir,
    detection: derpyuDetection(third.profileDir),
    logger: (message) => single.push(message),
  })
  assert.equal(thirdResult.status, 'patched')
  assert.ok(single.length > 0)

  // logger 自己抛异常：补丁仍成功（日志永不参与控制流）
  const fourth = makeFixture()
  const fourthResult = ensureAutopatch({
    memoryDir: fourth.memoryDir,
    profileDir: fourth.profileDir,
    detection: derpyuDetection(fourth.profileDir),
    logger: () => {
      throw new Error('logger boom')
    },
  })
  assert.equal(fourthResult.status, 'patched')
})

test('ensureAutopatch：不带参数调用不抛，返回结构化状态', () => {
  const result = ensureAutopatch()
  assert.equal(result.status, 'disabled')
  assert.ok('statePath' in result)
})

test('ensureAutopatch：写入后目标文件仍是合法文本（导出的三工具名可见于 SAFE_EXACT）', () => {
  const f = makeFixture()
  const result = ensureAutopatch({
    memoryDir: f.memoryDir,
    profileDir: f.profileDir,
    detection: derpyuDetection(f.profileDir),
  })
  assert.equal(result.status, 'patched')
  const patched = readFile(f.packageFile)
  const setStart = patched.indexOf('const SAFE_EXACT = new Set([')
  const setEnd = patched.indexOf('])', setStart)
  assert.ok(setStart >= 0 && setEnd > setStart)
  const setText = patched.slice(setStart, setEnd)
  for (const name of AUTO_PATCH_TOOL_NAMES) assert.ok(setText.includes(`'${name}'`), name)
  // 原文件里的其它内容没被动过。
  assert.ok(patched.includes('ctx.tools.guard('))
  assert.ok(patched.includes("'mcp__snowluma__'"))
})
