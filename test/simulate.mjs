#!/usr/bin/env node
/**
 * dsh-rofm — deterministic end-to-end simulation (docs/SPEC.md §9/§10).
 *
 * Runs a long simulated conversation that triggers compression, then several
 * user utterances that trigger recall chains with a seeded RNG (mulberry32,
 * seed 42). Prints every injected recall block and the required test-phase
 * report: "context added back %" and "chars added back".
 *
 *   node test/simulate.mjs        # exits 0 only when recall actually happened
 *
 * The script is also safe to execute under `node --test` (it registers one test
 * in that case instead of printing the whole transcript).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { estimateMessagesTokens, formatReport, loadConfig, MemoryEngine, summarizeStats } from '../engine/index.js'
import { readStats } from '../engine/store.js'

const SELF = fileURLToPath(import.meta.url)

const USER_UTTERANCES = [
  '部署 docker 的时候 8080 端口被占用，重启后还是不行，之前讨论过的方案是什么？必须恢复服务。',
  'redis 连接池的配置参数和缓存命中率怎么调？缓存 key 过期时间还记得吗？',
  '接口 api 的 JWT 鉴权 token 过期时间怎么设置？refresh token 放在哪里？',
  '数据库迁移和回滚版本的命令是什么？注意备份。',
  '再确认一下部署流程、端口配置和 nginx 反向代理的参数。',
  '单元测试覆盖率上不去，测试方案和 mock 参数怎么安排？',
]

/** The simulated conversation (long enough to trigger compression). */
function buildConversation() {
  const turns = [
    [
      '部署 docker 到生产环境，端口 8080 和 8443 怎么配置？必须保证服务不中断。',
      '部署方案：使用 docker-compose，端口映射 8080:8080、8443:8443。配置 nginx 反向代理，参数如下：\n```yaml\nservices:\n  api:\n    image: app:1.4.2\n    ports: ["8080:8080", "8443:8443"]\n```\n注意：改端口前必须更新防火墙规则。',
    ],
    [
      '数据库 redis 连接池经常超时，缓存命中率很低，怎么优化？',
      'redis 优化方案：连接池 maxTotal=64、maxIdle=16、minIdle=8；缓存 key 加业务前缀，TTL 300 秒。记住：连接池参数要与并发量匹配，不能盲目加大。',
    ],
    [
      '接口 api 的鉴权用 JWT，token 过期时间和刷新机制怎么定？',
      'JWT 方案：access token 15 分钟，refresh token 7 天；接口 /api/auth/refresh 负责刷新。注意：refresh token 必须存 redis 并支持主动失效。',
    ],
    [
      '数据库表结构要迁移，参数和版本怎么管理？迁移失败了怎么回滚？',
      '迁移方案：使用 migration 文件（版本号 v1.2.3），每一步必须可回滚；执行前备份数据库，禁止在生产直接改表结构。',
    ],
  ]
  const messages = []
  for (let turn = 0; turn < 14; turn += 1) {
    const [question, answer] = turns[turn % turns.length]
    const round = turn + 1
    messages.push({ role: 'user', content: `第 ${round} 轮：${question} 请给出具体参数和方案。` })
    if (round % 4 === 0) {
      messages.push({ role: 'assistant', content: `[tool-call: bash]\n\`\`\`bash\ncurl -s http://localhost:8080/api/health\n\`\`\`\n先检查服务健康状态，然后继续处理。` })
      messages.push({ role: 'tool', content: 'HTTP/1.1 200 OK\n{"status":"ok","version":"1.4.2","uptime":86400}' })
      messages.push({ role: 'assistant', content: `${answer}\n补充：接口 health 返回 200 表示服务正常，版本 v1.4.2，uptime 86400 秒。` })
    } else {
      messages.push({ role: 'assistant', content: answer })
    }
  }
  return messages
}

/**
 * Run the simulation. Returns { summary, blocks, memoryDir, compacted }.
 * Throws when the simulation failed to exercise compression/recall.
 */
export function runSimulation() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rofm-sim-'))
  const cleanup = () => {
    try {
      fs.rmSync(memoryDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  try {
    const cfg = loadConfig(undefined, {
      compress: {
        enabled: true,
        triggerPercent: 60,
        compressPercent: 20,
        minContextTokens: 200,
        minMessagesToCompress: 4,
        minChunkChars: 120,
        targetChunkChars: 500,
        keepRecentMessages: 4,
      },
      recall: { seed: 42, firstGenMax: 10, sort: 'createdAt' },
      importance: { warnAbove: 0.95 },
    })
    const engine = new MemoryEngine({ memoryDir, config: cfg })
    engine.load()

    const conversation = buildConversation()
    const estimatedTokens = estimateMessagesTokens(conversation)
    const usedPercent = 76.5
    const totalUsedTokens = estimatedTokens
    const compression = engine.compress(conversation, usedPercent, {
      sessionId: 'simulation',
      totalUsedTokens,
      windowTokens: 128000,
    })
    if (!compression.plan.shouldCompress || compression.folders.length === 0) {
      throw new Error(`simulation: compression did not trigger (${compression.plan.reason})`)
    }

    let live = compression.keep.slice()
    let contextChars = live.reduce((sum, message) => sum + String(message.content || '').length, 0)
    const blocks = []
    const recallSummaries = []
    for (const utterance of USER_UTTERANCES) {
      const before = live.length
      const result = engine.recall(utterance, { chars: contextChars, windowTokens: 128000, sessionId: 'simulation' })
      const block = engine.buildRecallBlock(result.additions)
      blocks.push({ utterance, block, stats: result.stats })
      recallSummaries.push(result.stats)
      // Continue the conversation: the user speaks and the assistant replies
      // with the recalled memory block injected (mirrors the DSH adapter).
      live = live.concat([
        { role: 'user', content: utterance },
        { role: 'assistant', content: (block ? block + '\n\n' : '') + '好的，根据历史记忆和当前上下文继续处理。参数保持不变。' },
      ])
      contextChars = live.reduce((sum, message) => sum + String(message.content || '').length, 0)
      if (live.length === before) throw new Error('simulation: live conversation did not grow')
    }

    const events = readStats(memoryDir, cfg)
    const summary = summarizeStats(events)
    if (summary.recallEvents <= 0) throw new Error('simulation: no recall telemetry was written')
    if (!(summary.charsAdded > 0)) throw new Error('simulation: recall never added any context back')

    return { memoryDir, summary, blocks, folders: compression.folders.length, removed: compression.removed.length, kept: compression.keep.length, conversation: conversation.length }
  } finally {
    cleanup()
  }
}

function printSimulation(result) {
  const out = []
  out.push('=== dsh-rofm simulation ===')
  out.push(`conversation messages      : ${result.conversation}`)
  out.push(`moved to memory folders    : ${result.removed} messages -> ${result.folders} folder(s)`)
  out.push(`still live after compress  : ${result.kept} messages`)
  out.push('')
  for (const [index, entry] of result.blocks.entries()) {
    out.push(`--- recall ${index + 1}: ${entry.utterance.slice(0, 40)}...`)
    out.push(entry.block ? entry.block.trimEnd() : '(nothing recalled)')
    out.push('')
  }
  out.push(formatReport(result.summary).trimEnd())
  out.push('')
  out.push(`context added back         : ${result.summary.contextAddedPercent} % (chars added back: ${result.summary.charsAdded})`)
  process.stdout.write(out.join('\n') + '\n')
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(SELF).href

if (isMain) {
  const result = runSimulation()
  printSimulation(result)
} else if (process.env.NODE_TEST_CONTEXT) {
  const { test } = await import('node:test')
  const assert = (await import('node:assert/strict')).default
  test('simulated long conversation compresses and recalls context', () => {
    const result = runSimulation()
    assert.equal(result.summary.recallEvents, USER_UTTERANCES.length)
    assert.ok(result.summary.charsAdded > 0, 'chars added back must be > 0')
    assert.ok(result.summary.contextAddedPercent > 0, 'context added back percentage must be > 0')
    assert.ok(result.blocks.some((entry) => entry.block.includes('## 记忆回忆')), 'at least one injected block expected')
  })
}
