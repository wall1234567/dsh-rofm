#!/usr/bin/env node
/**
 * dsh-rofm engine — standalone CLI (zero dependencies, no DSH imports).
 *
 *   node engine/cli.mjs init [--dir memory]
 *   node engine/cli.mjs compress --input conversation.json [--used-percent 63]
 *                                [--session-id X] [--allow-small-window]
 *                                [--config config.json] [--dir memory]
 *   node engine/cli.mjs recall --text "用户这句话"
 *                            [--context token=41000 window=128000]
 *                            [--time-from 2026-10-31] [--time-to 2026-11-01]
 *                            [--granularity day|month|year]
 *                            [--event 日本旅行]
 *                            [--offset 0] [--limit 5] [--mode fair|deterministic|legacy]
 *                            [--config config.json] [--seed 42] [--dir memory]
 *   node engine/cli.mjs recall --time-from 2026-10-31 [--time-to 2026-11-02]
 *                            # pure time browsing (no --text, v1.4.0 §6.8)
 *   node engine/cli.mjs recall --event 日本旅行
 *                            # pure event browsing (no --text, v1.4.0 §6.9)
 *   node engine/cli.mjs list [--config config.json] [--dir memory]
 *   node engine/cli.mjs report [--config config.json] [--dir memory] [--json]
 *
 * JSON goes to stdout; human hints go to stderr. Exit code 1 on invalid input.
 */

import fs from 'node:fs'
import path from 'node:path'
import { defaultConfigPath, loadConfig, resolveMemoryDir } from './config.js'
import { MemoryEngine } from './engine.js'
import { buildArchiveNote } from './compress.js'
import { ensureMemoryDir, loadIndex, readStats } from './store.js'
import { formatReport, summarizeStats } from './stats.js'

const USAGE = `dsh-rofm engine CLI (standalone, zero dependencies)

Usage:
  node engine/cli.mjs init [--dir memory]
  node engine/cli.mjs compress --input conversation.json [--used-percent 63]
                               [--session-id X] [--allow-small-window]
                               [--config config.json] [--dir memory]
  node engine/cli.mjs recall --text "用户这句话"
                               [--context token=41000 window=128000]
                               [--time-from 2026-10-31] [--time-to 2026-11-01]
                               [--granularity day|month|year]
                               [--event 日本旅行]
                               [--offset 0] [--limit 5] [--mode fair|deterministic|legacy]
                               [--config config.json] [--seed 42] [--dir memory]
  node engine/cli.mjs list [--config config.json] [--dir memory]
  node engine/cli.mjs report [--config config.json] [--dir memory] [--json]
  node engine/cli.mjs help

  Pure time browsing: omit --text and pass --time-from/--time-to (a time window
  is a lookup, not a recall decision; needs time.mode="constrain" in the config
  to actually filter, otherwise timeWindow.enforced=false). --time-* accept
  "2026-10-31" (day), "2026-10" (month), "2026" (year) or an epoch ms value.

  Event constraint: --event <name> restricts the recall to memories tagged with
  that event (needs event.mode="constrain"). "空" means "no event constraint".
  Omit --text and pass --event for pure event browsing. A submitted event that is
  bidirectionally similar to an existing one returns eventInfo.candidates instead
  of guessing (ambiguous), so the caller can decide or ask the user.

conversation.json = { "messages": MemMessage[], "usedPercent": 63.2,
                      "contextWindowTokens": 128000,
                      "totalUsedTokens": 41234 (optional), "sessionId": "..." (optional) }
  Messages may carry "tokens" (host count) and "time" (event time, epoch ms):
  the latter is collected into the archived folders' eventStart/eventEnd.
Commands print JSON to stdout (report prints its text report unless --json) and
human hints to stderr. Exit code 1 on invalid input.
`

class CliError extends Error {}

/** Flags that intentionally take no value (`report --json`, compress opt-in). */
const BOOLEAN_FLAGS = new Set(['json', 'allow-small-window'])

/** Accepted `--mode` values for `recall` (legacy stays available as rollback). */
const RECALL_MODES = new Set(['fair', 'deterministic', 'legacy'])
/** Accepted `--granularity` values for `recall`. */
const TIME_GRANULARITIES = new Set(['day', 'month', 'year'])


function emitJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function hint(message) {
  process.stderr.write(String(message) + '\n')
}

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      let key
      let value
      if (equals >= 0) {
        key = arg.slice(2, equals)
        value = arg.slice(equals + 1)
      } else {
        key = arg.slice(2)
        const next = argv[index + 1]
        if (key === 'context') {
          const parts = []
          while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
            const candidate = argv[index + 1]
            if (!candidate.includes('=')) break
            parts.push(candidate)
            index += 1
          }
          flags.context = [...(Array.isArray(flags.context) ? flags.context : []), ...parts]
          continue
        }
        if (next !== undefined && !next.startsWith('--')) {
          value = next
          index += 1
        } else {
          value = true
        }
      }
      if (key === 'context') flags.context = [...(Array.isArray(flags.context) ? flags.context : []), ...String(value).split(/\s+/)].filter(Boolean)
      else if (value === true && !BOOLEAN_FLAGS.has(key)) throw new CliError(`--${key} requires a value`)
      else flags[key] = value
    } else {
      positionals.push(arg)
    }
  }
  return { flags, positionals }
}

function parseContext(parts) {
  const context = {}
  const list = Array.isArray(parts) ? parts : parts ? [parts] : []
  for (const part of list) {
    for (const token of String(part).split(/[,\s]+/)) {
      if (!token) continue
      const match = /^([A-Za-z_-]+)=(.+)$/.exec(token)
      if (!match) continue
      const key = match[1].toLowerCase()
      const value = Number(match[2])
      if (!Number.isFinite(value)) continue
      if (key === 'window' || key === 'windowtokens' || key === 'window_tokens') context.windowTokens = Math.round(value)
      else if (key === 'chars' || key === 'char') context.chars = Math.round(value)
      else if (key === 'token' || key === 'tokens' || key === 'context') context.chars = Math.round(value)
      else if (key === 'used' || key === 'usedpercent') context.usedPercent = value
    }
  }
  return context
}

function readJsonFile(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new CliError(`cannot read ${filePath}: ${err && err.code ? err.code : err}`)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new CliError(`invalid JSON in ${filePath}: ${err && err.message ? err.message : err}`)
  }
}

function makeContext(flags) {
  const cwd = process.cwd()
  const explicitConfig = typeof flags.config === 'string' ? path.resolve(cwd, flags.config) : null
  let configPath = explicitConfig
  if (!configPath) {
    const shared = defaultConfigPath()
    if (fs.existsSync(shared)) configPath = shared
  }
  const cfg = loadConfig(configPath)
  // Invalid input must fail (exit code 1, SPEC §8), not silently fall back to a
  // default seed: `--seed` without a valid integer is rejected.
  if (flags.seed !== undefined) {
    const seed = Number(flags.seed)
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new CliError('--seed must be an integer in [0, 4294967295]')
    }
    cfg.recall.seed = seed
  }
  const memoryDir = typeof flags.dir === 'string' ? path.resolve(cwd, flags.dir) : resolveMemoryDir(cfg)
  return { cfg, memoryDir }
}

/**
 * Validate + collect the v1.4.0 `recall` extras. Invalid enum/int values are
 * rejected (exit 1, SPEC §8) instead of silently clamped; time inputs themselves
 * are normalized by the engine, which reports problems in `warnings`.
 */
function buildRecallOptions(flags) {
  const options = {}
  if (flags['time-from'] !== undefined) options.timeFrom = flags['time-from']
  if (flags['time-to'] !== undefined) options.timeTo = flags['time-to']
  if (flags.granularity !== undefined) {
    if (typeof flags.granularity !== 'string' || !TIME_GRANULARITIES.has(flags.granularity)) {
      throw new CliError('--granularity must be one of day, month, year')
    }
    options.granularity = flags.granularity
  }
  if (flags.mode !== undefined) {
    if (typeof flags.mode !== 'string' || !RECALL_MODES.has(flags.mode)) {
      throw new CliError('--mode must be one of fair, deterministic, legacy')
    }
    options.mode = flags.mode
  }
  if (flags.event !== undefined) {
    if (typeof flags.event !== 'string' || flags.event.length > 200) {
      throw new CliError('--event must be a short event name (<= 200 chars)')
    }
    options.event = flags.event
  }
  if (flags.offset !== undefined) {
    const offset = Number(flags.offset)
    if (!Number.isInteger(offset) || offset < 0) throw new CliError('--offset must be a non-negative integer')
    options.offset = offset
  }
  if (flags.limit !== undefined) {
    const limit = Number(flags.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CliError('--limit must be an integer in [1, 1000]')
    options.limit = limit
  }
  return options
}

function commandInit(flags) {
  const { cfg, memoryDir } = makeContext(flags)
  ensureMemoryDir(memoryDir)
  const index = loadIndex(memoryDir, cfg)
  emitJson({ ok: true, memoryDir, folderCount: index.folders.length, warnings: cfg.warnings })
  hint(`memory directory ready: ${memoryDir}`)
  return 0
}

function commandCompress(flags) {
  if (typeof flags.input !== 'string' || !flags.input) throw new CliError('compress requires --input conversation.json')
  const cwd = process.cwd()
  const conversation = readJsonFile(path.resolve(cwd, flags.input))
  if (!conversation || typeof conversation !== 'object' || !Array.isArray(conversation.messages)) {
    throw new CliError('conversation.json must be an object with a "messages" array')
  }
  let usedPercent = Number(conversation.usedPercent)
  if (flags['used-percent'] !== undefined) usedPercent = Number(flags['used-percent'])
  if (!Number.isFinite(usedPercent)) throw new CliError('usedPercent missing: pass it in conversation.json or with --used-percent')

  const { cfg, memoryDir } = makeContext(flags)
  // Window precedence (SPEC §2 compress.contextWindowTokens): the host-reported
  // window in conversation.json wins; a positive config value is the fallback
  // (the adapter's resolveContextWindow treats it as an explicit override).
  const hostWindow = Number(conversation.contextWindowTokens)
  const configuredWindow = Number(cfg.compress && cfg.compress.contextWindowTokens)
  const windowTokens = Number.isFinite(hostWindow) && hostWindow > 0
    ? hostWindow
    : Number.isFinite(configuredWindow) && configuredWindow > 0
      ? configuredWindow
      : 0
  const totalUsedTokens = Number.isFinite(Number(conversation.totalUsedTokens))
    ? Number(conversation.totalUsedTokens)
    : windowTokens > 0
      ? Math.round((windowTokens * usedPercent) / 100)
      : undefined
  const engine = new MemoryEngine({ memoryDir, config: cfg })
  engine.load()
  const result = engine.compress(conversation.messages, usedPercent, {
    sessionId: typeof flags['session-id'] === 'string' ? flags['session-id'] : conversation.sessionId,
    totalUsedTokens,
    windowTokens: windowTokens > 0 ? windowTokens : undefined,
    // v1.4.0 P1-6: the CLI is an explicit operator action, so the small-window
    // sanity check can be overridden on purpose (mirrors compress.allowSmallWindow).
    ...(flags['allow-small-window'] === true ? { allowSmallWindow: true } : {}),
  })
  const plan = result.plan
  const refused = result.refused === true
  emitJson({
    ok: !refused,
    committed: result.committed,
    ...(refused ? { refused: true, refusedReason: result.reason } : {}),
    shouldCompress: plan.shouldCompress,
    reason: plan.reason,
    usedPercent: plan.usedPercent,
    totalTokens: plan.totalTokens,
    usedTokens: plan.usedTokens,
    targetTokens: plan.targetTokens,
    removedMessages: plan.remove.length,
    removedChars: plan.removeChars,
    removedTokens: plan.removeTokens,
    keptMessages: plan.keep.length,
    folderCount: result.folders.length,
    // v1.4.0 archive robustness (contract §5.5 / §7).
    protectedTurn: plan.protectedTurn === true,
    smallWindow: plan.smallWindow === true,
    maxFoldersCapped: plan.maxFoldersCapped === true,
    eventTime: plan.eventTime ?? null,
    folders: result.folders.map((folder) => ({
      id: folder.id,
      alpha: folder.meta.alpha,
      keywords: folder.meta.keywords,
      title: folder.meta.title,
      chars: folder.meta.stats.chars,
      tokens: folder.meta.stats.tokens,
      messages: folder.meta.stats.messages,
      eventStart: folder.meta.eventStart ?? null,
      eventEnd: folder.meta.eventEnd ?? null,
    })),
    archiveNote: result.folders.length > 0 ? buildArchiveNote(plan) : '',
    warnings: result.warnings,
  })
  hint(
    refused
      ? `refused to archive (${result.reason}): memory folder cap reached; conversation left untouched`
      : plan.shouldCompress
        ? `archived ${result.folders.length} folder(s); kept ${plan.keep.length} message(s)`
        : `nothing compressed (${plan.reason})` +
          (plan.reason === 'small-window' ? '; pass --allow-small-window to archive anyway' : ''),
  )
  return 0
}

function commandRecall(flags) {
  const recallOptions = buildRecallOptions(flags)
  const text = typeof flags.text === 'string' ? flags.text : ''
  const hasTimeInput =
    recallOptions.timeFrom !== undefined || recallOptions.timeTo !== undefined || recallOptions.granularity !== undefined
  const hasEventInput = recallOptions.event !== undefined
  if (!text.trim() && !hasTimeInput && !hasEventInput) {
    throw new CliError('recall requires --text "用户这句话" (or --time-from/--time-to / --event for pure browsing)')
  }
  const { cfg, memoryDir } = makeContext(flags)
  const context = parseContext(flags.context)
  const engine = new MemoryEngine({ memoryDir, config: cfg })
  engine.load()
  const result = engine.recall(text, { chars: context.chars, windowTokens: context.windowTokens }, recallOptions)
  const block = engine.buildRecallBlock(result.additions)
  emitJson({
    ok: true,
    block,
    // v1.4.0: pure time browsing and the deterministic selector surface.
    browsing: result.browse === true,
    mode: result.mode ?? null,
    page: result.page ?? null,
    timeWindow: result.timeWindow ?? null,
    // v1.4.0 event constraint: exact/unknown/similar/empty/disabled + candidates.
    eventInfo: result.eventInfo ?? null,
    missType: result.missType ?? null,
    additions: result.additions.map((addition) => ({
      id: addition.id,
      generation: addition.generation,
      alpha: addition.alpha,
      probability: addition.probability,
      chars: addition.chars,
      tokens: addition.tokens,
      ...(typeof addition.lane === 'string' ? { lane: addition.lane } : {}),
    })),
    stats: result.stats,
    warnings: result.warnings,
  })
  if (block) hint(block)
  else if (result.missType === 'event-ambiguous') {
    const labels = (result.eventInfo?.candidates || []).map((candidate) => `${candidate.label}(${candidate.count})`)
    hint(`event ambiguous: ${JSON.stringify(result.eventInfo?.requested)} is similar to ${labels.join(', ')} — is it the same event? retry with that label, or --event 空; ask the user when unsure`)
  } else if (result.eventInfo?.status === 'unknown') hint('event miss: no memory is tagged with that event yet (score/tag memories first, use --event 空, or ask the user)')
  else if (result.missType === 'event') hint('event miss: keywords matched, but none of those memories belong to the requested event (try another event / --event 空 / ask the user)')
  else if (result.browse === true) hint('no memory folder in the requested time window / event')
  else if (result.missType === 'time') hint('time miss: keywords matched outside the requested window (try another window / ask the user about the time)')
  else hint('nothing recalled')
  return 0
}

function commandList(flags) {
  const { cfg, memoryDir } = makeContext(flags)
  const index = loadIndex(memoryDir, cfg)
  emitJson({ ok: true, memoryDir, count: index.folders.length, folders: index.folders })
  hint(`${index.folders.length} folder(s) in ${memoryDir}`)
  return 0
}

function commandReport(flags) {
  const { cfg, memoryDir } = makeContext(flags)
  const events = readStats(memoryDir, cfg)
  const summary = summarizeStats(events)
  if (flags.json) {
    emitJson({ ok: true, memoryDir, eventCount: events.length, summary })
  } else {
    process.stdout.write(formatReport(summary))
    hint(`${events.length} telemetry event(s) in ${memoryDir}`)
  }
  return 0
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  const command = argv[0]
  const { flags } = parseArgs(argv.slice(1))
  switch (command) {
    case 'init':
      return commandInit(flags)
    case 'compress':
      return commandCompress(flags)
    case 'recall':
      return commandRecall(flags)
    case 'list':
      return commandList(flags)
    case 'report':
      return commandReport(flags)
    default:
      throw new CliError(`unknown command: ${command}\n\n${USAGE}`)
  }
}

try {
  process.exitCode = main()
} catch (err) {
  if (err instanceof CliError) {
    hint(`error: ${err.message}`)
  } else {
    hint(`error: ${err && err.stack ? err.stack : err}`)
  }
  process.exitCode = 1
}
