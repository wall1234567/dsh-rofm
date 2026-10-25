#!/usr/bin/env node
/**
 * dsh-rofm engine — standalone CLI (zero dependencies, no DSH imports).
 *
 *   node engine/cli.mjs init [--dir memory]
 *   node engine/cli.mjs compress --input conversation.json [--used-percent 63]
 *                                [--session-id X] [--config config.json] [--dir memory]
 *   node engine/cli.mjs recall --text "用户这句话"
 *                            [--context token=41000 window=128000]
 *                            [--config config.json] [--seed 42] [--dir memory]
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
                               [--session-id X] [--config config.json] [--dir memory]
  node engine/cli.mjs recall --text "用户这句话"
                               [--context token=41000 window=128000]
                               [--config config.json] [--seed 42] [--dir memory]
  node engine/cli.mjs list [--config config.json] [--dir memory]
  node engine/cli.mjs report [--config config.json] [--dir memory] [--json]
  node engine/cli.mjs help

conversation.json = { "messages": MemMessage[], "usedPercent": 63.2,
                      "contextWindowTokens": 128000 }
Commands print JSON to stdout (report prints its text report unless --json) and
human hints to stderr. Exit code 1 on invalid input.
`

class CliError extends Error {}

/** Flags that intentionally take no value (`report --json`). */
const BOOLEAN_FLAGS = new Set(['json'])

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
    folders: result.folders.map((folder) => ({
      id: folder.id,
      alpha: folder.meta.alpha,
      keywords: folder.meta.keywords,
      title: folder.meta.title,
      chars: folder.meta.stats.chars,
      tokens: folder.meta.stats.tokens,
      messages: folder.meta.stats.messages,
    })),
    archiveNote: result.folders.length > 0 ? buildArchiveNote(plan) : '',
    warnings: result.warnings,
  })
  hint(
    refused
      ? `refused to archive (${result.reason}): memory folder cap reached; conversation left untouched`
      : plan.shouldCompress
        ? `archived ${result.folders.length} folder(s); kept ${plan.keep.length} message(s)`
        : `nothing compressed (${plan.reason})`,
  )
  return 0
}

function commandRecall(flags) {
  if (typeof flags.text !== 'string' || !flags.text) throw new CliError('recall requires --text "用户这句话"')
  const { cfg, memoryDir } = makeContext(flags)
  const context = parseContext(flags.context)
  const engine = new MemoryEngine({ memoryDir, config: cfg })
  engine.load()
  const result = engine.recall(flags.text, { chars: context.chars, windowTokens: context.windowTokens })
  const block = engine.buildRecallBlock(result.additions)
  emitJson({
    ok: true,
    block,
    additions: result.additions.map((addition) => ({
      id: addition.id,
      generation: addition.generation,
      alpha: addition.alpha,
      probability: addition.probability,
      chars: addition.chars,
      tokens: addition.tokens,
    })),
    stats: result.stats,
    warnings: result.warnings,
  })
  if (block) hint(block)
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
