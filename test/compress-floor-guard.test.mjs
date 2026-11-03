/**
 * v1.4.1 archive-floor / multi-pass guard (L1 from the real-session telemetry).
 *
 * Real data: `session-7bc15160` turn 32 ran 3 archival passes in a row at
 * 59.47% → 47.00% → 36.03% → 28.36% and 17.07% → 12.71% → 10.28% → 6.20%.
 * The session log shows why: the assistant temporarily lowered
 * `compress.triggerPercent` to **5** (`triggerPercent -> 5`, seq 5925) and
 * restored it to 60 afterwards (seq 5972) — so every pass correctly ran while
 * the *configured* trigger was still exceeded. This is NOT a code regression,
 * but it must stay that way: the loop may only run another pass while the
 * DSH-measured context is above `compress.triggerPercent`.
 *
 * These tests drive the real `RofmPlugin.compressWithEscalation` against a fake
 * DSH session (the same approach as the adapter's own test-adapter suite):
 *   1. triggerPercent=60: a pass that lands below 60% must stop the episode
 *      (exactly one `compress-applied` event, no extra pass);
 *   2. triggerPercent=5: extra passes legitimately continue while > 5%, capped
 *      at `1 + maxExtraPasses`;
 *   3. engine telemetry: the engine `compress` event carries the archive-floor /
 *      robustness fields (L2 engine-side confirmation).
 *
 * Only `os.tmpdir()` is written.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { RofmPlugin } from '../lib/plugin.js'

const tempDirs = []
function tempDir(prefix = 'dshr-floor-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const clone = (value) => JSON.parse(JSON.stringify(value))

class FakeSession {
  constructor({ contextWindow = 30000, id = 'session-floor' } = {}) {
    this.id = id
    this.header = { origin: 'main' }
    this.events = []
    this.nodes = []
    this.replaceGeneration = 0
    this.contentGeneration = 0
    this.windowTokens = contextWindow
  }

  get surface() {
    const session = this
    return {
      get nodes() {
        return session.nodes
      },
      get replaceGeneration() {
        return session.replaceGeneration
      },
      get contentGeneration() {
        return session.contentGeneration
      },
    }
  }

  get seq() {
    return this.events.length
  }

  eventAt(seq) {
    return this.events[seq]
  }

  snapshotEvents() {
    return this.events.slice()
  }

  requestContext() {
    return { provider: 'mock', model: 'mock', contextWindow: this.windowTokens }
  }

  deriveEventMessage(event) {
    if (!event) return null
    switch (event.type) {
      case 'user/message':
        return event.data
      case 'assistant/message':
      case 'system/message':
      case 'developer/message':
        return event.data.message
      case 'tool/result':
        return event.data.message
      default:
        return null
    }
  }

  deriveMessages() {
    return this.nodes.map((seq) => this.deriveEventMessage(this.eventAt(seq))).filter((message) => message !== null)
  }

  append(type, data, options = {}) {
    const seq = this.events.length
    const event = { type, seq, time: Date.now(), data: clone(data) }
    if (SURFACE_TYPES.has(type)) {
      this.events.push(event)
      if (options.surfaceOp === 'append') {
        this.nodes.push(seq)
        this.contentGeneration += 1
        return event
      }
      // Replacement: swap the shadowed node range for the new node (the adapter's
      // surface contract), so the fake meter reflects the new context size.
      const startSeq = options.surfaceOp?.startSeq
      const endSeq = options.surfaceOp?.endSeq
      const startIdx = this.nodes.indexOf(startSeq)
      const endIdx = this.nodes.indexOf(endSeq)
      if (startIdx >= 0 && endIdx >= startIdx) {
        const shadowed = this.nodes.slice(startIdx, endIdx + 1)
        event.sourceEventSeqs = shadowed
        this.nodes.splice(startIdx, shadowed.length, seq)
      } else {
        this.nodes.push(seq)
      }
      this.replaceGeneration += 1
      this.contentGeneration += 1
      return event
    }
    this.events.push(event)
    return event
  }
}

function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function assistantMessage(text) {
  return { role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text }] }
}

/**
 * Fake token meter: 4 chars per token over the model-visible nodes. The `nodes`
 * price list matters: the adapter uses it for `shadowedTokenCount` and refuses a
 * note that is not smaller than the span it replaces.
 */
function measure(session) {
  const nodes = []
  for (const seq of session.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq))
    const tokens = Math.max(0, Math.ceil(JSON.stringify(message?.content ?? '').length / 4))
    nodes.push({ seq, tokens, heuristicTokens: tokens })
  }
  return { totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0), nodes }
}

function makeContext(session) {
  const capture = { tools: [], sections: [], logs: [] }
  const toolsService = {
    register(definition) {
      const entry = { definition, disposed: false }
      capture.tools.push(entry)
      return () => {
        entry.disposed = true
      }
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    tokenMeter: { measure: () => measure(session) },
    systemPrompt: { section(sectionOptions) { capture.sections.push(sectionOptions); return () => {} } },
    on() { return () => {} },
    effect(callback) { const dispose = callback(); return dispose },
    dispose() {},
    get(name) {
      if (name === 'systemPrompt') return this.systemPrompt
      if (name === 'tokenMeter') return this.tokenMeter
      if (name === 'tools') return this.tools
      return undefined
    },
  }
  ctx.tools = toolsService
  return { ctx, capture }
}

function pluginConfig(memoryDir, compressOverrides) {
  return {
    enabled: true,
    compress: {
      enabled: true,
      allowSmallWindow: true,
      smallWindowTokens: 1000,
      contextWindowTokens: 0,
      minContextTokens: 0,
      minMessagesToCompress: 2,
      minChunkChars: 50,
      targetChunkChars: 1200,
      maxFoldersPerRun: 200,
      maxFoldersPerStep: 200,
      keepRecentMessages: 2,
      applyToSubagents: true,
      applyToMainSessions: true,
      preStepEnabled: false,
      emergencyPercent: 85,
      emergencyCompressPercent: 40,
      maxExtraPasses: 2,
      hardLimitPercent: 95,
      hardLimitStop: true,
      ...compressOverrides,
    },
    scoring: { includeLegacy: true, taskMaxTokens: 1000000, taskBudgetPercent: 100 },
    recall: { mode: 'legacy', seed: 7, probabilityScale: 1000, firstGenMax: 10, applyToSubagents: true, applyToMainSessions: true },
    importance: { min: 0.01, max: 1, warnAbove: 0.8 },
    keywords: { min: 3, max: 8 },
    storage: { dir: memoryDir, perSession: false },
    logging: { enabled: false, verbose: false },
    compat: { qBots: 'off' },
  }
}

/** A ~67% full context: 20 messages of ~1000 tokens each against a 30k window. */
function buildSession(contextWindow = 30000) {
  const session = new FakeSession({ contextWindow })
  session.append('system/message', {
    turn: 1,
    step: 1,
    message: { id: 'sys-1', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYSTEM PROMPT' }] },
  }, { surfaceOp: 'append' })
  for (let at = 1; at <= 20; at += 1) {
    const role = at % 2 === 1 ? 'user' : 'assistant'
    const message = role === 'user' ? userMessage(`第 ${at} 段：${'x'.repeat(4000)}`) : assistantMessage(`第 ${at} 段回答：${'y'.repeat(4000)}`)
    session.append(role === 'user' ? 'user/message' : 'assistant/message', role === 'user' ? message : { turn: at, step: 1, message, stream: [] }, { surfaceOp: 'append' })
  }
  session.append('user/message', userMessage('现在总结一下'), { surfaceOp: 'append' })
  return session
}

function runEpisode({ compress }) {
  const memoryDir = tempDir()
  const session = buildSession()
  const { ctx } = makeContext(session)
  const plugin = new RofmPlugin(ctx, pluginConfig(memoryDir, compress))
  plugin.start()
  const cfg = plugin.currentConfig()
  const applied = []
  const original = plugin.compressOnce.bind(plugin)
  plugin.compressOnce = async (...args) => {
    const result = await original(...args)
    applied.push(args[4]?.pass ?? -1)
    return result
  }
  return { memoryDir, session, plugin, cfg, applied }
}

function readAppliedEvents(memoryDir) {
  const file = path.join(memoryDir, 'stats.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === 'compress-applied')
}

test('L1: a pass that lands below triggerPercent stops the escalation loop (1 pass only)', async () => {
  const { memoryDir, session, plugin, cfg, applied } = runEpisode({
    compress: { triggerPercent: 60, compressPercent: 20, releaseTargetPercent: 50, releaseFloorEnabled: true },
  })
  const before = measure(session).totalTokens
  assert.ok((before / 30000) * 100 > 60, 'fixture must start above the trigger')
  await plugin.compressWithEscalation(session, 99, cfg, 'test')
  const events = readAppliedEvents(memoryDir)
  assert.equal(events.length, 1, `expected exactly one archival pass, got ${events.length}: ${JSON.stringify(events.map((e) => [e.pass, e.beforePercent, e.afterPercent]))}`)
  assert.deepEqual(applied, [0], 'compressOnce ran for pass 0 only')
  assert.ok(events[0].afterPercent < 60, 'the single pass landed below the trigger')
  // The next pre-step is below the trigger: the engine refuses the plan outright.
  const engine = plugin.engineFor(session, cfg)
  const plan = engine.planCompression(session.nodes.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean), events[0].afterPercent, {
    totalUsedTokens: measure(session).totalTokens,
  })
  assert.equal(plan.shouldCompress, false)
  assert.equal(plan.reason, 'below-threshold')
})

test('L1: with a deliberately lowered trigger the loop runs 1+maxExtraPasses passes and no more', async () => {
  // releaseFloorEnabled=false keeps each pass at compressPercent so the context
  // stays above the (artificially low) trigger after every pass — this reproduces
  // the real-session cascade shape without depending on the floor.
  const { memoryDir, session, plugin, cfg, applied } = runEpisode({
    compress: { triggerPercent: 5, compressPercent: 20, releaseTargetPercent: 4, releaseFloorEnabled: false, maxExtraPasses: 2 },
  })
  await plugin.compressWithEscalation(session, 99, cfg, 'test')
  const events = readAppliedEvents(memoryDir)
  assert.equal(events.length, 3, `maxExtraPasses=2 ⇒ at most 3 passes, got ${events.length}`)
  assert.deepEqual(applied, [0, 1, 2])
  for (const event of events) assert.ok(event.beforePercent > 5, `pass ${event.pass} started above trigger: ${event.beforePercent}`)
  // The 4th pass would still be above 5% here, but the configured cap stops it.
  assert.ok(events[2].afterPercent > 5, 'fixture: the context is still above the lowered trigger when the cap hits')
})

test('L2: the engine `compress` telemetry carries the archive-floor / robustness fields', async () => {
  const { memoryDir, session, plugin, cfg } = runEpisode({
    compress: { triggerPercent: 60, compressPercent: 20, releaseTargetPercent: 50, releaseFloorEnabled: true },
  })
  await plugin.compressWithEscalation(session, 99, cfg, 'test')
  const file = path.join(memoryDir, 'stats.jsonl')
  const events = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === 'compress')
  assert.equal(events.length, 1)
  const event = events[0]
  for (const field of ['releaseFloor', 'releaseTargetPercent', 'releaseCapped', 'trickleArchive', 'foldersPlanned', 'foldersCommitted', 'foldersSkipped']) {
    assert.ok(Object.hasOwn(event, field), `engine compress telemetry is missing ${field}`)
  }
  assert.equal(event.releaseTargetPercent, 50)
  assert.equal(event.foldersPlanned, event.foldersCommitted, 'committed == planned')
})
