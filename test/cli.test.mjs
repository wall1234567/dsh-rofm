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

test('cli: help exits 0 and prints usage', () => {
  const help = runCli(['help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /node engine\/cli\.mjs init/)
  assert.match(help.stdout, /node engine\/cli\.mjs recall/)
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
