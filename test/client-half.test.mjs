/**
 * dsh-rofm — 浏览器半身 `client.js` 冒烟测试。
 *
 * `client.js` 是给 `window.__ModuleLoader__` 用的纯浏览器脚本：Node 里没有
 * window / document / ModuleLoader，**不能真的执行**。所以这里做的全是静态校验：
 *
 *   1. 语法可解析（`new Function` 通过 = 没有 ESM / 构建语法）；
 *   2. loader / 路由 / apply / ctx.effect 等关键契约字符串存在；
 *   3. 用户可见的主文案**不内嵌**在客户端里 —— 必须来自宿主 GET 响应；
 *   4. 客户端写死的路由与动作和 `lib/compat-consent.js` 的宿主常量逐字一致；
 *   5. package.json 声明了 web 客户端半身（manifest 由宿主半身同批补；
 *      暂时缺失时只校验 client.js 存在，并用 diagnostic 提示）。
 *
 * 运行：`node --test test/client-half.test.mjs`
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CONSENT_ACTIONS, CONSENT_PROMPT, CONSENT_ROUTE } from '../lib/compat-consent.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_FILE = path.join(ROOT, 'client.js')
const PACKAGE_FILE = path.join(ROOT, 'package.json')

/** 用户 v1.5.7 指定的中文原文（逐字）。宿主常量必须与它一致。 */
const PROMPT_ZH =
  '由于qq-bridge的白名单机制会使rofm在QQ渠道失效且有恶劣影响，故请求您允许rofm将工具添加进白名单中，如您不允许，为防止恶劣后果，rofm会默认关闭，您后续可自行开启。'

const source = readFileSync(CLIENT_FILE, 'utf8')

test('client.js 是可直接解析的纯浏览器脚本', () => {
  assert.doesNotThrow(() => new Function(source), 'client.js 必须是可解析的普通脚本')
  // 纯浏览器脚本里不写 ESM 顶层语法；有的话 browser loader 会直接语法错误。
  assert.ok(!/^\s*(import|export)\s/m.test(source), 'client.js 不应包含 ESM import/export 语句')
  assert.ok(!/\.innerHTML\s*=/.test(source), '弹窗正文来自宿主响应，必须走 textContent 而不是 innerHTML')
})

test('client.js 暴露 ModuleLoader 浏览器半身', () => {
  assert.ok(source.includes('window.__ModuleLoader__.load'), '必须用 window.__ModuleLoader__.load 注册')
  assert.ok(source.includes("id: 'dsh-rofm'"), 'loader id 必须是包名 dsh-rofm')
  assert.ok(source.includes('exports.name'), 'exports.name 必须设置')
  assert.ok(source.includes('exports.inject'), 'exports.inject 必须设置')
  assert.ok(source.includes("exports.name = 'dsh-rofm'"), 'exports.name 应为 dsh-rofm')
  assert.ok(source.includes('exports.inject = []'), '本半身不注册 slot，inject 为空数组')
  assert.ok(source.includes('function apply'), '必须导出 apply')
  assert.ok(source.includes('exports.apply = apply'), 'apply 必须挂到 exports 上')
  assert.ok(source.includes('ctx.effect'), '清理必须注册到 ctx.effect')
  assert.equal((source.match(/window\.__ModuleLoader__\.load\(/g) ?? []).length, 1, '只允许注册一次，避免重复加载')
})

test('client.js 使用冻结的授权路由与轮询节奏', () => {
  assert.ok(source.includes(CONSENT_ROUTE), '路由必须与宿主 CONSENT_ROUTE 一致')
  assert.ok(source.includes('credentials: \'same-origin\''), '同源请求要显式带 credentials')
  const fast = Number((source.match(/FAST_POLL_MS\s*=\s*(\d+)/) ?? [])[1])
  assert.ok(fast >= 2000 && fast <= 3000, `快速轮询应在 ~2500ms，实际 ${fast}`)
  const slow = Number((source.match(/SLOW_POLL_MS\s*=\s*(\d+)/) ?? [])[1])
  assert.ok(slow >= 25000 && slow <= 35000, `退避上限应在 ~30000ms，实际 ${slow}`)
  assert.ok(source.includes('visibilitychange'), '页面回到可见时要补查一次')
  // v1.5.7-final（零轮询修订）：任何非 pending 的响应都必须停止轮询——
  // 没检测到 qq-bridge 时就是普通 rofm，不能留 30s 常驻复查；
  // qq-bridge 后装需要刷新页面才弹窗。
  assert.ok(!source.includes('watchLater'), '不允许保留常驻慢速复查（无 qq-bridge 时必须停）')
  assert.ok(
    /stopped = true/.test(source),
    '非 pending 的响应必须停止轮询',
  )
})

test('client.js 的授权 POST 契约与宿主动作常量一致', () => {
  assert.equal(CONSENT_ACTIONS.ALLOW, 'allow')
  assert.equal(CONSENT_ACTIONS.DENY, 'deny')
  assert.ok(source.includes("'Content-Type': 'application/json'"), 'POST 必须声明 JSON')
  assert.ok(source.includes('decision: action'), 'POST body 必须是 { decision }')
  assert.ok(source.includes(`submit('${CONSENT_ACTIONS.ALLOW}')`), '允许按钮提交 allow')
  assert.ok(source.includes(`submit('${CONSENT_ACTIONS.DENY}')`), '不允许按钮提交 deny')
  assert.ok(source.includes('already'), '必须处理多标签页 already:true')
  assert.ok(source.includes('allowedNotice') && source.includes('deniedNotice'), '结果提示必须取响应里的文案')
  assert.ok(source.includes('allowLabel') && source.includes('denyLabel'), '按钮文字必须取响应里的文案')
})

test('弹窗可访问性标记与主题变量存在', () => {
  assert.ok(source.includes("'role', 'dialog'"), '弹窗必须是 role=dialog')
  assert.ok(source.includes("'aria-modal', 'true'"), '弹窗必须 aria-modal=true')
  assert.ok(source.includes('aria-live'), '提交状态应通过 aria-live 播报')
  assert.ok(source.includes('--dsw-alias-'), '颜色需要使用 DSH 主题变量')
  assert.ok(/var\(--dsw-alias-bg-layer-2,#[0-9a-f]{3,8}\)/.test(source), '主题变量必须带 fallback 颜色')
  // 事故回归（2026-11-10）：POST 一直失败 / 宿主接口消失时必须能关闭弹窗，
  // 否则整页被遮罩永久卡住。关闭后本页停止轮询，刷新页面会重新询问。
  assert.ok(source.includes('rofm-consent-close'), '弹窗必须有可点击的关闭按钮（×）')
  assert.ok(source.includes('function dismiss'), '必须有关闭出口 dismiss')
  assert.ok(source.includes("event.key !== 'Escape'") && source.includes("'keydown'"), '必须支持 Esc 关闭弹窗')
  assert.ok(source.includes("uiText('gone')"), '宿主接口失效时必须提示可关闭后刷新')
  assert.ok(
    /settled\) \{\s*stopped = true/.test(source.replace(/\s*\n\s*/g, ' ')),
    '本页已作答但宿主仍 pending 时必须停止轮询（不能开着重询循环）',
  )
})

test('主文案不在客户端内嵌（唯一真相在宿主）', () => {
  assert.ok(!source.includes(CONSENT_PROMPT.zh), '客户端不得内嵌 CONSENT_PROMPT.zh，必须从 GET 响应取')
  assert.ok(!source.includes(CONSENT_PROMPT.en), '客户端不得内嵌 CONSENT_PROMPT.en，必须从 GET 响应取')
  assert.ok(source.includes('message'), '客户端应从响应读取 message')
  assert.ok(source.includes('data.pending === true'), '客户端应根据 pending 决定是否弹窗')
})

test('宿主常量与用户指定中文原文逐字一致', () => {
  assert.equal(CONSENT_ROUTE, '/api/rofm/derpyu-consent')
  assert.equal(CONSENT_PROMPT.zh, PROMPT_ZH, '宿主 CONSENT_PROMPT.zh 必须与用户指定原文逐字一致')
  assert.ok(CONSENT_PROMPT.en.length > 0, '英文兜底文案必须存在')
})

test('package.json 声明了 web 客户端半身', (t) => {
  assert.ok(existsSync(CLIENT_FILE), 'client.js 必须存在')
  const pkg = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8'))
  const client = pkg?.dsh?.client
  if (client === undefined) {
    // Lead 负责补 manifest；此测试先不硬失败，由任务的完成说明指出这一条。
    t.diagnostic('package.json 暂无 dsh.client manifest：等待宿主半身同批补齐（platform=web, immediately=true）')
    return
  }
  assert.equal(client.platform, 'web', 'dsh.client.platform 必须是 web')
  assert.equal(client.immediately, true, '没有 slot 引用本半身，必须立即加载')
  assert.equal(pkg.exports?.['./client'], './client.js', 'exports["./client"] 必须指向 ./client.js')
})

test('client.js 体积受控（≤ 540 行）', () => {
  const lines = source.split('\n').length
  assert.ok(lines <= 540, `client.js 体积失控：${lines} 行`)
})
