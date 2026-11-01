/**
 * CLI tests — `node engine/cli.mjs init|compress|recall|list|report`
 * (docs/SPEC.md §8).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI = path.join(REPO_ROOT, 'engine', 'cli.mjs')

const tempDirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-cli-'))
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

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
}

function buildConversationFile(dir) {
  const messages = []
  for (let index = 0; index < 16; index += 1) {
    messages.push({ role: 'user', content: `第${index}轮：部署 docker 端口 8080 的配置方案和注意事项。` })
    messages.push({ role: 'assistant', content: `第${index}轮部署方案：端口 8080，参数必须正确，版本 v1.4.2。` })
  }
  const file = path.join(dir, 'conversation.json')
  fs.writeFileSync(file, JSON.stringify({ messages, usedPercent: 74, contextWindowTokens: 128000 }))
  return file
}

/** 2026-10-30 10:00 +08:00 — every message gets an event time on that day. */
const TIMED_DAY_BASE = Date.UTC(2026, 9, 30, 2, 0, 0)

/**
 * Conversation whose messages carry `time` (event time) so the archived folders
 * get `eventStart/eventEnd` and the in-memory time index can query them.
 */
function buildTimedConversationFile(dir, { windowTokens = 128000 } = {}) {
  const messages = []
  for (let index = 0; index < 16; index += 1) {
    messages.push({
      role: 'user',
      content: `第${index}轮：部署 docker 端口 8080 的配置方案和注意事项。`,
      time: TIMED_DAY_BASE + index * 120_000,
    })
    messages.push({
      role: 'assistant',
      content: `第${index}轮部署方案：端口 8080，参数必须正确，版本 v1.4.2。`,
      time: TIMED_DAY_BASE + index * 120_000 + 60_000,
    })
  }
  const file = path.join(dir, 'conversation-timed.json')
  fs.writeFileSync(file, JSON.stringify({ messages, usedPercent: 74, contextWindowTokens: windowTokens }))
  return file
}

/** Config that actually enforces time windows and keeps the archive small. */
function writeTimedConfig(dir) {
  const configPath = path.join(dir, 'config-timed.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      time: { mode: 'constrain', timezone: 'Asia/Shanghai' },
      compress: { targetChunkChars: 120, minChunkChars: 20 },
    }),
  )
  return configPath
}

/** Archive the timed conversation once; returns the CLI context + compress JSON. */
function prepareTimedArchive() {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const configPath = writeTimedConfig(root)
  const conversation = buildTimedConversationFile(root)
  const compress = runCli(['compress', '--input', conversation, '--session-id', 'cli-timed', '--dir', memoryDir, '--config', configPath])
  assert.equal(compress.status, 0, compress.stderr)
  return { root, memoryDir, configPath, conversation, compressJson: JSON.parse(compress.stdout) }
}

test('cli: help exits 0 and prints usage', () => {
  const help = runCli(['help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /node engine\/cli\.mjs init/)
  assert.match(help.stdout, /node engine\/cli\.mjs recall/)
  // v1.4.0 CLI surface (time assistance / pagination / selector mode / P1-6 opt-in).
  assert.match(help.stdout, /--time-from/)
  assert.match(help.stdout, /--granularity day\|month\|year/)
  assert.match(help.stdout, /--offset/)
  assert.match(help.stdout, /--limit/)
  assert.match(help.stdout, /--mode fair\|deterministic\|legacy/)
  assert.match(help.stdout, /--allow-small-window/)
  assert.match(help.stdout, /Pure time browsing/)
})

test('cli: init prints JSON and creates the memory dir', () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const configPath = path.join(root, 'missing-config.json')
  const init = runCli(['init', '--dir', memoryDir, '--config', configPath])
  assert.equal(init.status, 0, init.stderr)
  const parsed = JSON.parse(init.stdout)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.folderCount, 0)
  assert.ok(fs.existsSync(memoryDir))
})

test('cli: compress -> list -> recall -> report end to end', () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const configPath = path.join(root, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({}))
  const conversation = buildConversationFile(root)

  const compress = runCli([
    'compress',
    '--input', conversation,
    '--used-percent', '74',
    '--session-id', 'cli-session',
    '--dir', memoryDir,
    '--config', configPath,
  ])
  assert.equal(compress.status, 0, compress.stderr)
  const compressJson = JSON.parse(compress.stdout)
  assert.equal(compressJson.ok, true)
  assert.equal(compressJson.shouldCompress, true)
  assert.ok(compressJson.folderCount >= 1, JSON.stringify(compressJson))
  assert.match(compressJson.archiveNote, /^\[memory\] /)

  const list = runCli(['list', '--dir', memoryDir, '--config', configPath])
  assert.equal(list.status, 0, list.stderr)
  const listJson = JSON.parse(list.stdout)
  assert.equal(listJson.count, compressJson.folderCount)
  assert.equal(listJson.folders.length, compressJson.folderCount)

  const recall = runCli([
    'recall',
    '--text', '部署 docker 端口 8080 配置方案',
    '--context', 'token=41000', 'window=128000',
    '--dir', memoryDir,
    '--config', configPath,
  ])
  assert.equal(recall.status, 0, recall.stderr)
  const recallJson = JSON.parse(recall.stdout)
  assert.equal(recallJson.ok, true)
  assert.equal(typeof recallJson.stats, 'object')
  assert.ok(recallJson.stats.matchedFolders >= 1)
  assert.equal(recallJson.stats.contextChars, 41000)
  assert.equal(recallJson.stats.windowTokens, 128000)

  const report = runCli(['report', '--dir', memoryDir, '--config', configPath])
  assert.equal(report.status, 0, report.stderr)
  assert.match(report.stdout, /=== memory recall report ===/)
  assert.match(report.stdout, /compression events     : 1/)
  assert.match(report.stdout, /recall events          : 1/)

  const reportJson = runCli(['report', '--dir', memoryDir, '--config', configPath, '--json'])
  assert.equal(reportJson.status, 0, reportJson.stderr)
  const parsedReport = JSON.parse(reportJson.stdout)
  assert.equal(parsedReport.summary.compressionEvents, 1)
  assert.equal(parsedReport.summary.recallEvents, 1)
})

test('cli: invalid input exits 1 with an error on stderr', () => {
  const root = tempDir()
  const missingInput = runCli(['compress', '--dir', path.join(root, 'memory')])
  assert.equal(missingInput.status, 1)
  assert.match(missingInput.stderr, /--input/)

  const unknown = runCli(['bogus-command'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown command/)

  const badJsonFile = path.join(root, 'bad.json')
  fs.writeFileSync(badJsonFile, '{not json')
  const badInput = runCli(['compress', '--input', badJsonFile, '--dir', path.join(root, 'memory')])
  assert.equal(badInput.status, 1)
  assert.match(badInput.stderr, /invalid JSON/)

  const noText = runCli(['recall', '--dir', path.join(root, 'memory')])
  assert.equal(noText.status, 1)
  assert.match(noText.stderr, /--text/)
})

// ---------------------------------------------------------------------------
// v1.4.0 CLI surface — event time, time-window recall, browsing, pagination,
// selector mode, and the P1-6 small-window opt-in (contract §5.5/§5.6).
// ---------------------------------------------------------------------------

test('cli: compress reports protectedTurn/smallWindow/maxFoldersCapped/eventTime and folder event ranges', () => {
  const { compressJson } = prepareTimedArchive()
  assert.equal(compressJson.ok, true)
  assert.equal(compressJson.shouldCompress, true)
  assert.equal(compressJson.reason, 'ok')
  assert.equal(compressJson.protectedTurn, false)
  assert.equal(compressJson.smallWindow, false)
  assert.equal(compressJson.maxFoldersCapped, false)
  assert.ok(
    compressJson.eventTime && Number.isFinite(compressJson.eventTime.start) && Number.isFinite(compressJson.eventTime.end),
    `expected an archived event-time span, got ${JSON.stringify(compressJson.eventTime)}`,
  )
  assert.equal(compressJson.eventTime.source, 'messages')
  assert.ok(compressJson.eventTime.end > compressJson.eventTime.start, 'the archived span is a half-open [min, max+1) interval')
  assert.ok(
    compressJson.eventTime.end - compressJson.eventTime.start <= 32 * 120_000 + 1,
    `the archived event span must stay inside the conversation span, got ${compressJson.eventTime.end - compressJson.eventTime.start}`,
  )
  assert.ok(compressJson.folderCount >= 2, `expected several folders, got ${compressJson.folderCount}`)
  for (const folder of compressJson.folders) {
    assert.ok(Number.isFinite(folder.eventStart), 'folder eventStart is reported')
    assert.ok(folder.eventEnd > folder.eventStart, 'folder eventEnd is the half-open end')
  }
})

test('cli: recall --time-from/--time-to filters by event time, reports page/timeWindow/missType', () => {
  const { memoryDir, configPath } = prepareTimedArchive()
  const baseArgs = ['--context', 'window=128000', '--dir', memoryDir, '--config', configPath]

  const hit = runCli(['recall', '--text', '部署 docker 端口 8080 配置方案', '--time-from', '2026-10-30', '--time-to', '2026-10-30', ...baseArgs])
  assert.equal(hit.status, 0, hit.stderr)
  const hitJson = JSON.parse(hit.stdout)
  assert.equal(hitJson.ok, true)
  assert.equal(hitJson.mode, 'fair')
  assert.equal(hitJson.browsing, false)
  assert.ok(hitJson.timeWindow, 'timeWindow is present')
  assert.equal(hitJson.timeWindow.level, 'day')
  assert.equal(hitJson.timeWindow.enforced, true)
  assert.ok(hitJson.timeWindow.hits >= 1)
  assert.ok(hitJson.page && Number.isInteger(hitJson.page.offset) && typeof hitJson.page.hasMore === 'boolean')
  assert.equal(hitJson.missType, null)
  assert.ok(hitJson.additions.length >= 1)
  assert.ok(typeof hitJson.block === 'string' && hitJson.block.length > 0)

  const miss = runCli(['recall', '--text', '部署 docker 端口 8080 配置方案', '--time-from', '2026-10-20', '--time-to', '2026-10-21', ...baseArgs])
  assert.equal(miss.status, 0, miss.stderr)
  const missJson = JSON.parse(miss.stdout)
  assert.equal(missJson.additions.length, 0)
  assert.equal(missJson.missType, 'time')

  // A single month is a soft window and resolves to the natural month.
  const month = runCli(['recall', '--text', '部署 docker 端口 8080 配置方案', '--time-from', '2026-10', ...baseArgs])
  assert.equal(month.status, 0, month.stderr)
  const monthJson = JSON.parse(month.stdout)
  assert.equal(monthJson.timeWindow.level, 'month')
  assert.ok(monthJson.additions.length >= 1)

  // --granularity is forwarded and reflected in the normalized window.
  const granularity = runCli(['recall', '--text', '部署 docker 端口', '--time-from', '2026-10', '--granularity', 'month', ...baseArgs])
  assert.equal(granularity.status, 0, granularity.stderr)
  assert.equal(JSON.parse(granularity.stdout).timeWindow.granularity, 'month')
})

test('cli: recall pure time browsing without --text, pagination and --mode', () => {
  const { memoryDir, configPath } = prepareTimedArchive()
  const browse = runCli(['recall', '--time-from', '2026-10-30', '--time-to', '2026-10-30', '--limit', '3', '--dir', memoryDir, '--config', configPath])
  assert.equal(browse.status, 0, browse.stderr)
  const browseJson = JSON.parse(browse.stdout)
  assert.equal(browseJson.ok, true)
  assert.equal(browseJson.browsing, true)
  assert.equal(browseJson.missType, null)
  assert.equal(browseJson.page.limit, 3)
  assert.equal(browseJson.page.offset, 0)
  assert.equal(browseJson.additions.length, 3)
  assert.equal(browseJson.page.hasMore, true)
  assert.ok(browseJson.timeWindow && browseJson.timeWindow.enforced === true)

  const page = runCli([
    'recall',
    '--text', '部署 docker 端口',
    '--mode', 'deterministic',
    '--offset', '1',
    '--limit', '2',
    '--dir', memoryDir,
    '--config', configPath,
  ])
  assert.equal(page.status, 0, page.stderr)
  const pageJson = JSON.parse(page.stdout)
  assert.equal(pageJson.mode, 'deterministic')
  assert.equal(pageJson.page.offset, 1)
  assert.equal(pageJson.page.limit, 2)
  assert.equal(pageJson.additions.length, 2)
})

test('cli: compress --allow-small-window overrides the P1-6 refusal', () => {
  const root = tempDir()
  const memoryDir = path.join(root, 'memory')
  const configPath = path.join(root, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({}))
  const conversation = buildTimedConversationFile(root, { windowTokens: 8000 })

  const refused = runCli(['compress', '--input', conversation, '--dir', memoryDir, '--config', configPath])
  assert.equal(refused.status, 0, refused.stderr)
  const refusedJson = JSON.parse(refused.stdout)
  assert.equal(refusedJson.shouldCompress, false)
  assert.equal(refusedJson.reason, 'small-window')
  assert.equal(refusedJson.smallWindow, true)
  assert.equal(refusedJson.folderCount, 0)
  assert.match(refused.stderr, /--allow-small-window/)

  const allowed = runCli(['compress', '--input', conversation, '--allow-small-window', '--dir', memoryDir, '--config', configPath])
  assert.equal(allowed.status, 0, allowed.stderr)
  const allowedJson = JSON.parse(allowed.stdout)
  assert.equal(allowedJson.shouldCompress, true)
  assert.equal(allowedJson.smallWindow, false)
  assert.ok(allowedJson.folderCount >= 1)
})

test('cli: invalid new recall flags exit 1 with a clear error', () => {
  const root = tempDir()
  const trailing = ['--dir', path.join(root, 'memory'), '--config', path.join(root, 'missing-config.json')]
  for (const [args, pattern] of [
    [['recall', '--text', 'x', '--mode', 'bogus'], /--mode must be/],
    [['recall', '--text', 'x', '--granularity', 'week'], /--granularity must be/],
    [['recall', '--text', 'x', '--limit', '0'], /--limit must be/],
    [['recall', '--text', 'x', '--offset', '-1'], /--offset must be/],
    [['recall', '--time-from'], /requires a value/],
  ]) {
    const result = runCli([...args, ...trailing])
    assert.equal(result.status, 1, `expected exit 1 for "${args.join(' ')}" (stdout=${result.stdout})`)
    assert.match(result.stderr, pattern)
  }
})
