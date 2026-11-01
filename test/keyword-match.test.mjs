/**
 * Bidirectional keyword matching tests (plan §3.6 / contract §5.2).
 *
 * The hard constraint is the v1.3.0 no-regression rule: every folder that
 * engine/tokenize.js `keywordMatches()` accepts must still be matched by
 * `matchKeywords()` (fuzz-checked against the legacy predicate).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasMatch, matchKeywords } from '../engine/keyword-match.js'
import { countKeywordMatches, keywordMatches, normalizeText } from '../engine/tokenize.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(next, list) {
  return list[Math.floor(next() * list.length)]
}

function makeCfg(patch = {}) {
  return {
    keywords: { min: 3, max: 8, matchMode: 'contains' },
    match: { expandLatinCase: false, cjkBigram: false },
    ...patch,
  }
}

const DEFAULT_CFG = makeCfg()

// ---------------------------------------------------------------------------
// direction 1 — the v1.3.0 predicate (folder keyword ⊆ user text)
// ---------------------------------------------------------------------------

test('direction 1: CJK substring and Latin word boundary still match', () => {
  const cfg = makeCfg()
  const cjk = matchKeywords('接口网关配置出问题了', ['接口网关'], cfg)
  assert.equal(cjk.matchCount, 1)
  assert.deepEqual(cjk.matched, ['接口网关'])

  const latin = matchKeywords('please restart docker now', ['docker'], cfg)
  assert.equal(latin.matchCount, 1)

  // word boundaries: "dock" must not match "docker"
  assert.equal(matchKeywords('docker is running', ['dock'], cfg).matchCount, 0)
  // NFKC + case folding (full-width and uppercase)
  assert.equal(matchKeywords('请检查 ＤＯＣＫＥＲ 服务', ['docker'], cfg).matchCount, 1)
  assert.equal(matchKeywords('请检查 Docker 服务', ['DOCKER'], cfg).matchCount, 1)
  // multi-word CJK phrase appearing as a whole
  const phrase = matchKeywords('请检查接口网关 8080 的端口配置', ['接口网关 8080'], cfg)
  assert.equal(phrase.matchCount, 1)
  assert.equal(phrase.phraseHit, true)
})

// ---------------------------------------------------------------------------
// direction 2 — user tokens inside the folder keyword
// ---------------------------------------------------------------------------

test('direction 2: multi-word / spaced folder keywords match through their parts', () => {
  const cfg = makeCfg()
  const gateway = matchKeywords('帮我看下网关', ['接口网关 8080'], cfg)
  assert.equal(gateway.matchCount, 1)
  assert.deepEqual(gateway.matched, ['接口网关 8080'])
  assert.equal(gateway.phraseHit, false) // the whole phrase was not in the text

  const port = matchKeywords('8080 端口对不对', ['接口网关 8080'], cfg)
  assert.equal(port.matchCount, 1)

  // English phrase split works too
  const compose = matchKeywords('compose file broken', ['docker compose'], cfg)
  assert.equal(compose.matchCount, 1)

  // no accidental match when no token is contained
  assert.equal(matchKeywords('完全无关的一句话', ['接口网关 8080'], cfg).matchCount, 0)
})

test('direction 2: several folder keywords -> matchCount counts each once', () => {
  const cfg = makeCfg()
  const result = matchKeywords('网关和缓存都要看', ['接口网关', '缓存', '无关词'], cfg)
  assert.equal(result.matchCount, 2)
  assert.deepEqual(result.matched, ['接口网关', '缓存'])
  // duplicate folder keywords are normalized away
  const duplicated = matchKeywords('网关', ['接口网关', '接口网关', ' 接口网关 '], cfg)
  assert.equal(duplicated.matchCount, 1)
})

// ---------------------------------------------------------------------------
// phraseHit / titleHit quality signals
// ---------------------------------------------------------------------------

test('phraseHit: only true when a multi-word keyword is matched as a whole', () => {
  assert.equal(matchKeywords('接口网关 8080 开头的配置', ['接口网关 8080'], makeCfg()).phraseHit, true)
  assert.equal(matchKeywords('网关配置', ['接口网关 8080'], makeCfg()).phraseHit, false)
  // "docker" alone is a direction-2 (part-of-phrase) hit, not a whole-phrase hit
  assert.equal(matchKeywords('docker', ['docker compose'], makeCfg()).phraseHit, false)
  assert.equal(matchKeywords('docker compose up', ['docker compose'], makeCfg()).phraseHit, true)
  assert.equal(matchKeywords('compose', ['docker compose'], makeCfg()).phraseHit, false)
})

test('titleHit: optional title tokens are matched against the user text', () => {
  const cfg = makeCfg()
  const withTitle = matchKeywords('网关今天又挂了', ['部署'], cfg, { title: '接口网关修复记录' })
  assert.equal(withTitle.titleHit, true)
  assert.equal(withTitle.matchCount, 0) // title only affects titleHit, not matchCount
  assert.equal(matchKeywords('完全无关', ['部署'], cfg, { title: '接口网关修复记录' }).titleHit, false)
  // whole-title containment also counts
  assert.equal(matchKeywords('请看 接口网关修复记录 这条', ['部署'], cfg, { title: '接口网关修复记录' }).titleHit, true)
  // no title => never true, never throws
  assert.equal(matchKeywords('部署', ['部署'], cfg).titleHit, false)
  assert.equal(matchKeywords('部署', ['部署'], cfg, null).titleHit, false)
})

// ---------------------------------------------------------------------------
// matchCount / hasMatch contract
// ---------------------------------------------------------------------------

test('matchCount is a superset of the v1.3.0 count; hasMatch agrees', () => {
  const text = normalizeText('请检查接口网关 8080 和 docker 的配置')
  const keywords = ['接口网关', '接口网关 8080', 'docker', 'docker compose', 'redis']
  const legacy = countKeywordMatches(text, keywords, 'contains', text)
  const result = matchKeywords(text, keywords, makeCfg())
  assert.ok(result.matchCount >= legacy)
  assert.equal(result.matchCount, 4) // 接口网关, 接口网关 8080, docker, docker compose
  assert.equal(hasMatch(text, keywords, makeCfg()), true)
  assert.equal(hasMatch(text, ['redis', 'kafka'], makeCfg()), false)
  assert.equal(matchKeywords(text, ['redis', 'kafka'], makeCfg()).matchCount, 0)
})

test('exact match mode keeps the legacy direction and still no-regresses', () => {
  const cfg = makeCfg({ keywords: { min: 3, max: 8, matchMode: 'exact' } })
  const text = normalizeText('接口网关 docker')
  const keywords = ['接口网关', 'docker', 'docker compose', 'redis']
  const legacy = countKeywordMatches(text, keywords, 'exact', text)
  const result = matchKeywords(text, keywords, cfg)
  assert.ok(result.matchCount >= legacy)
  assert.ok(legacy > 0)
})

// ---------------------------------------------------------------------------
// opt-in expansions (default OFF, add-only)
// ---------------------------------------------------------------------------

test('match.expandLatinCase defaults off and only adds matches when enabled', () => {
  const off = makeCfg()
  const on = makeCfg({ match: { expandLatinCase: true, cjkBigram: false } })
  // compound / cramped Latin variants: default misses, enabled matches
  assert.equal(matchKeywords('myapi failed', ['api'], off).matchCount, 0)
  assert.equal(matchKeywords('myapi failed', ['api'], on).matchCount, 1)
  assert.equal(matchKeywords('nodejs crashed', ['node.js'], off).matchCount, 0)
  assert.equal(matchKeywords('nodejs crashed', ['node.js'], on).matchCount, 1)
  // the flag never removes a match
  const next = mulberry32(31415)
  const vocab = ['api', 'docker', 'node.js', 'redis', '接口网关', '缓存', '端口配置']
  for (let trial = 0; trial < 120; trial += 1) {
    const keywords = []
    for (let at = 0; at < 1 + Math.floor(next() * 5); at += 1) keywords.push(pick(next, vocab))
    const text = `${pick(next, vocab)} ${pick(next, vocab)} ${pick(next, vocab)} 配置`
    assert.ok(matchKeywords(text, keywords, on).matchCount >= matchKeywords(text, keywords, off).matchCount)
  }
})

test('match.cjkBigram defaults off and is a monotone (add-only) expansion', () => {
  const off = makeCfg()
  const on = makeCfg({ match: { expandLatinCase: false, cjkBigram: true } })
  const next = mulberry32(271828)
  const vocab = ['接口网关', '端口配置', '数据库', '缓存', '灰度发布', '熔断限流', '日志链路']
  for (let trial = 0; trial < 120; trial += 1) {
    const keywords = []
    for (let at = 0; at < 1 + Math.floor(next() * 4); at += 1) keywords.push(pick(next, vocab))
    const text = `${pick(next, vocab)}的${pick(next, vocab)}问题`
    const base = matchKeywords(text, keywords, off)
    const expanded = matchKeywords(text, keywords, on)
    assert.ok(expanded.matchCount >= base.matchCount, `trial ${trial}`)
    // enabling the flag may never drop a previously matched keyword
    for (const keyword of base.matched) assert.ok(expanded.matched.includes(keyword))
  }
})

test('flags are read from cfg and absent config means defaults OFF', () => {
  const noCfg = matchKeywords('myapi', ['api'], undefined)
  assert.equal(noCfg.matchCount, 0)
  assert.equal(matchKeywords('myapi', ['api'], { match: {} }).matchCount, 0)
  assert.equal(matchKeywords('myapi', ['api'], { match: { expandLatinCase: 'yes' } }).matchCount, 0)
  assert.equal(matchKeywords('myapi', ['api'], { match: { expandLatinCase: true } }).matchCount, 1)
})

// ---------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------

test('robustness: garbage input never throws and never reports phantom matches', () => {
  const cfg = makeCfg()
  const garbageKeywords = [null, undefined, 42, {}, [], '', '   ', 'docker']
  for (const input of [null, undefined, '', 'hi', 'docker']) {
    const result = matchKeywords(input, garbageKeywords, cfg)
    assert.equal(typeof result.matchCount, 'number')
    assert.ok(Array.isArray(result.matched))
    assert.ok(result.matchCount <= 1)
  }
  for (const keywords of [null, undefined, 'docker', 42, {}, [null], [42, {}]]) {
    const result = matchKeywords('docker', keywords, cfg)
    assert.equal(result.matchCount, 0)
    assert.deepEqual(result.matched, [])
    assert.equal(hasMatch('docker', keywords, cfg), false)
  }
  assert.equal(matchKeywords('docker', ['docker'], null).matchCount, 1)
  assert.equal(hasMatch('', ['docker'], cfg), false)
  // a very long text does not explode (cached tokenization)
  const longText = `${'docker '.repeat(2000)}compose`
  const longResult = matchKeywords(longText, ['docker compose'], cfg)
  assert.equal(longResult.matchCount, 1)
})

// ---------------------------------------------------------------------------
// v1.3.0 no-regression fuzz (hard constraint, contract §5.2)
// ---------------------------------------------------------------------------

test('v1.3.0 no-regression: every keywordMatches hit is matched by matchKeywords (fuzz)', () => {
  const next = mulberry32(20261031)
  const cjk = ['星港项目', '接口网关', '端口配置', '数据库', '缓存', '熔断', '灰度发布', '鉴权', '压测', '回滚', '部署', '日志', '链路追踪', '限流', '消息队列', '定时任务', '备份', '迁移', '监控', '告警']
  const latin = ['api', 'gateway', 'redis', 'kafka', 'docker', 'node.js', 'postgres', 'http2', 'timeout', 'retry', 'c++', 'udp', 'tls', 'v2.3', '8080', 'feature_flag', '接口网关 8080', 'docker compose']
  let checkedFolders = 0
  let legacyHits = 0
  for (let trial = 0; trial < 300; trial += 1) {
    const folders = []
    const folderCount = 1 + Math.floor(next() * 10)
    for (let at = 0; at < folderCount; at += 1) {
      const keywords = []
      const keywordCount = 1 + Math.floor(next() * 5)
      for (let k = 0; k < keywordCount; k += 1) {
        const base = next() < 0.65 ? pick(next, cjk) : pick(next, latin)
        const variant = next()
        if (variant < 0.1) keywords.push(base.toUpperCase())
        else if (variant < 0.2) keywords.push(` ${base} `)
        else if (variant < 0.3) keywords.push(base.replace(/ /g, '  '))
        else keywords.push(base)
      }
      folders.push(keywords)
    }
    const parts = []
    for (let at = 0; at < 4; at += 1) {
      const base = next() < 0.6 ? pick(next, cjk) : pick(next, latin)
      if (next() < 0.4) parts.push(base)
      else parts.push(`${base}的${pick(next, cjk)}`)
    }
    parts.push('请检查 Docker 的 feature_flag 端口 8080，node.js v2.3')
    const rawText = parts.join('；')
    const text = normalizeText(rawText)
    for (const keywords of folders) {
      checkedFolders += 1
      const legacyHitsForFolder = new Set()
      for (const keyword of keywords) {
        if (keywordMatches(text, keyword, 'contains')) legacyHitsForFolder.add(normalizeText(keyword).trim())
      }
      if (!legacyHitsForFolder.size) continue
      legacyHits += legacyHitsForFolder.size
      const result = matchKeywords(rawText, keywords, makeCfg())
      assert.ok(result.matchCount > 0, `trial ${trial}: ${JSON.stringify(keywords)} vs ${rawText}`)
      assert.ok(result.matchCount >= legacyHitsForFolder.size)
      for (const keyword of legacyHitsForFolder) assert.ok(result.matched.includes(keyword), `missing ${keyword}`)
    }
  }
  assert.ok(checkedFolders > 1000)
  assert.ok(legacyHits > 100)
})

test('v1.3.0 no-regression: exact mode fuzz on tokens', () => {
  const next = mulberry32(777)
  const vocab = ['api', 'docker', 'docker compose', 'redis', '接口网关', '缓存', '8080', 'v2.3']
  const cfg = makeCfg({ keywords: { min: 3, max: 8, matchMode: 'exact' } })
  for (let trial = 0; trial < 120; trial += 1) {
    const keywords = []
    for (let at = 0; at < 1 + Math.floor(next() * 4); at += 1) keywords.push(pick(next, vocab))
    const text = `${pick(next, vocab)} ${pick(next, vocab)} 配置 docker`
    const normalized = normalizeText(text)
    // count distinct normalized legacy hits (matchKeywords de-duplicates keywords)
    const legacyExpected = new Set()
    for (const keyword of keywords) {
      const normalizedKeyword = normalizeText(keyword).trim()
      if (keywordMatches(normalized, normalizedKeyword, 'exact')) legacyExpected.add(normalizedKeyword)
    }
    assert.equal(countKeywordMatches(normalized, keywords, 'exact', normalized) > 0, legacyExpected.size > 0)
    const result = matchKeywords(text, keywords, cfg)
    assert.ok(result.matchCount >= legacyExpected.size, `trial ${trial}`)
    for (const keyword of legacyExpected) assert.ok(result.matched.includes(keyword))
  }
})
