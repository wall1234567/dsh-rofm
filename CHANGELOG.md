# Changelog

All notable changes to `dsh-rofm` are documented here.
The project follows a lightweight [SemVer](https://semver.org/) scheme.

## [Unreleased]

### Added

- **一条命令发版（`tools/release.mjs`）**：把「预检 → 测试/打包检查 → 版本号 + release commit +
  annotated tag → 推送 GitHub → `npm publish`（内置 npm 2FA 浏览器授权流程：打印授权链接、自动开浏览器、
  轮询确认后用一次性密码重试）→ 创建 GitHub Release（正文取自 CHANGELOG）」串成一条命令。
  支持 `--bump patch|minor|major` / `--version x.y.z` / `--resume`（中断后只补做未完成步骤，不重复发布）
  / `--dry-run` / `--yes` / `--skip-npm` / `--skip-github` / `--skip-push` / `--otp` / `--no-browser` 等参数；
  跨平台（Windows/Linux/macOS）、零依赖。npm 发布是异步的（HTTP 202），脚本会轮询 registry 直到版本可见；
  Windows schannel 的证书吊销检查会让 `git push` 偶发失败，脚本只对出错的那条命令用 `GIT_SSL_NO_VERIFY=1`
  重试并提示改用 SSH remote；Node ≥ 24 上自动加载系统证书库，兼容 TLS 代理。
- **`package.json` 快捷脚本**：`npm run release -- --bump patch --yes`、`npm run release:status`
  （= `node tools/release.mjs --resume --dry-run`，查看当前版本还剩哪些发布步骤）。
- **`test/release.test.mjs`（新，22 例）**：发版工具纯函数的单元测试——版本解析/递增/比较、CHANGELOG 段落提取、
  GitHub remote 解析、CLI 参数校验、平台浏览器 opener、npm 2FA URL 校验、`npm pack --dry-run` 清单校验、
  系统证书库安装、`ReleaseError` 恢复提示。
- **文档**：`docs/PUBLISHING.md` 重写为「一条命令发版（推荐）+ 首次环境准备 + 手动发版（备选/排障）+
  发布前自检清单」，补充 npm 2FA/EOTP、npm 异步发布、Windows schannel TLS、`--resume` 续发等排障说明。

## [1.4.0] — 2026-11-01

本版本完成四件事 + 一项增补（**1.4.0 增补：事件约束**，见后文专节；版本号保持 1.4.0 不变），
**旧数据无需迁移**（旧 `index.json`、旧 `recall-state.json` v2/v1、旧 pending 全部可读；
新字段一律 optional、有值才写）：

1. **召回确定性 + 公平性（默认行为变化）**：用 FAIR-DRI 确定性选择替换 v1.3.0 的 α 概率掷骰。
   **α 从「回忆概率乘数」变成「确定性优先级」**：高 α 记忆被查询命中后首轮必现，低 α 记忆不被丢弃、
   有有界最迟召回；block 裁剪从 createdAt FIFO 改为优先级裁剪（高 α pin）；同一输入多次召回结果完全一致；
   `memory_recall` 支持 `offset` 分页。保留 `recall.mode='deterministic'`（纯 DRI 研究对照）与
   `recall.mode='legacy'`（v1.3.0 概率路径原样保留，一键回滚）。
2. **时间辅助**：`memory_recall` 新增 `timeFrom/timeTo/granularity/offset`（日/月/年/epoch，最小连续 3 天，
   中心日→±1 天→月→年→全库阶梯放宽，纯时间浏览）；建立**纯内存**日/月/年时间索引（不落盘、不搬动 folder）。
   澄清语义：`createdAt` 是**归档时间**，不是事件时间；事件时间存在可选 `eventStart/eventEnd` 字段，
   旧数据安全回退归档时间。
3. **评分流水线与遗留数据**：新增数据时代分桶（legacy/synthetic/current）、任务区块 token 预算、pending 背压、
   heuristic 兜底、评分质量告警与 judge 遥测；pre-1.2.0 遗留与压测遗留**只标记不重评**；
   当前真实待评分口径 **2/369 = 0.54%**（1.3.0 后正常会话 b5eeee7e 为 0/359 = 0%）。
4. **归档与健壮性**：修复 P0-1（自指反馈环）、P0-2（pending 永不参与召回）、P0-3（当前回合被中途归档）、
   P0-6（评分任务 FIFO 饿死新记忆）、P1-1（再归档误删刚注入记忆）、P1-4（commit 无回滚/不幂等）、
   P1-6（小窗口自毁/假窗口）等 1.3.0 已确认缺陷。

### 确定性召回 + 公平性（FAIR-DRI）

#### Added

- **`engine/recall-index.js`（新）**：FAIR-DRI 确定性选择器，导出
  `buildRecallIndex` / `querySeeds` / `countCandidates` / `selectRecall` / `selectSigma` /
  `comparePriority` / `emptyLanes` / `serializeLanes` / `deserializeLanes` / `lanesFingerprint` /
  `trimBlock` / `simulateTurns` / `summarizeGuarantees`。要点：
  - 全局优先级 `σ = (alpha desc, createdAt asc, id asc)`；每个关键词 posting 按 σ 有序，查询是 k 路归并；
  - 8 步车道（严格顺序）：`rareHigh`（稀有词即时道）→ `queryBoost`（被裁高α查询重入）→
    `register`（上轮 defer 的高α，2 轮 TTL）→ `σ 高车道`（剩余高α名额，lookahead 溢出进寄存器）→
    `lowProbe`（低α显式引用探针）→ `rotation`（低α全局轮转）→ `recycle`（回收道，15 轮冷却）→
    `commit`（优先级 block 裁剪）；
  - 配额：`k = recall.firstGenMax`（10）、`r = max(1, min(k-1, round(k×exploreRatio)))`（默认 2，低α轮转）、
    `k_H = k - r`（默认 8，高α车道）、`θ_H = 0.6`、稀有词 `τ = max(8, ceil(0.002×N))`；
  - **选择零随机**：模块内无 `Math.random` 参与选择，`Date.now()` 只用于缓存时间戳；
  - Aho-Corasick 关键词匹配（contains 模式，CJK 子串 / Latin 词边界），与 `engine/tokenize.js` 语义一致；
  - 分页：`offset/limit` 在候选集上确定性分页，`+1` lookahead 计算 `hasMore`；
  - **block 优先级裁剪**：裁剪键 `(是否不在本轮候选集, α<θ_H, α asc, injectedRound asc, id)`，
    高α pin（block 里同时有低α时绝不裁高α），`maxChars` 硬限至少保留 1 条。
- **`engine/keyword-match.js`（新）**：双向关键词匹配 + 质量分（`matchKeywords` / `hasMatch`）——
  保留 v1.3.0 方向（folder 关键词 ⊆ 用户话，无回归）并新增“用户 token 出现在多词 folder 关键词里”；
  `match.expandLatinCase` / `match.cjkBigram` 可选（默认关，只增不减）。
- **`recall.mode`（新配置）**：`'fair'`（默认）/ `'deterministic'` / `'legacy'`。
- **`recall.fairness`（新配置块）**：`thetaHigh` / `exploreRatio` / `specificProbeSlots` /
  `rareTerm{ratio,minPosting,scanCap}` / `register{lookahead,capFactor,ttlRounds}` / `queryBoost` /
  `recycle{enabled,cooldownRounds,maxPerRound}` / `ledger{maxEntries,overflow}` /
  `blockTrim{policy,protectCurrentQuery,pinHigh}` / `roundBudget{maxChars}`。
- **`recall.hops` / `recall.maxWindowPercent`（新配置）**：后代扩展轮数（默认 0）与 block 的窗口比例上限（默认 10%）。
- **`recall.minAlpha`（引擎键）**：查询期 α 下限（QQ 群成员门控由 `compat.memberMinAlpha` 覆盖）。
- **`recall-state.json` v3**：新增 `round` / `configFingerprint` / `lanes`（frontier、exploreCursor、
  pendingHigh、highRecycle、recycle）/ `ledger` / `counters{reInjections,registerDrops,recallTimeEvicted,timeMisses}` /
  `degraded`；读 v2 只恢复 block（ledger/lanes 重置，允许有界重复、不丢记忆），读 v1 仍按 ids 重建；写回 v3。
- **`memory_recall` 分页**：`offset` 参数（0..10000，默认 0）；结果渲染“本页：第 N～M 条 / 还有更多：可用 offset=… 继续翻页”。
- **`memory_recall` 选路与自动召回一致（G4）**：手动检索也通过 `plugin.getRecallContext()` 传入
  `{lanes, round, blockIds, ledger}`（`exclude = block ∪ ledger`），因此不会绕过 recycle 冷却重复注入
  刚被裁掉的记忆；重新浮出的合法通道是 recycle 冷却与 `offset` 分页。纯时间 browse 不读不写 lane 状态；
  legacy 模式完全不传这些 v1.4.0 参数（回滚）。
- **lane/保证遥测**：`recall` 事件（engine）新增 `mode/candidates/lanesPicked{…}/pops/frontierHits/registerDrops/
  reInjections/degraded/timeFiltered/timeWindow/offset/limit/hasMore/missType`，`added[].lane` 记录来源车道；
  另新增 adapter 侧 **`recall-block`** 事件：`blockBefore/blockAfter/evicted/pinnedHigh/round/lanesPicked`
  （记录注入 + 优先级裁剪对 block 的实际影响）。
- **`tools/selfcheck.mjs` 新检查 `recall fairness`**：聚合 lane 分布、`registerDrops`、`degraded`、`missType`、
  `guarantees`（meanPicks / highAlphaLaneShare）；旧遥测缺字段只 INFO。

#### Changed（行为变化，务必注意）

- **α 语义**：从“第一代命中后以概率 α 掷骰加回”改为“确定性优先级”——σ 排序第一位是 α，
  α ≥ θ_H 走高α车道，高α被稀有词命中当轮必现；**α=0.1 的单次命中率不再≈10%**，低α也不会被彻底抛弃。
- **召回结果确定性**：同一记忆库 + 会话状态 + 查询 → 结果完全一致（不再有随机重掷；要翻更多结果用 `offset` 分页）。
- **block 裁剪**：从 createdAt FIFO 改为优先级裁剪（先裁“本轮查询没命中 + 低α + 更早注入”），
  高α pin；被裁高α进 `highRecycle` 等 `queryBoost` 重入，被裁低α进 `recycle` 15 轮冷却后重入。
- **每轮注入量**：`k` 条封顶（v1.3.0 第 2 代起无上限，单轮可洪泛 157–652 条 / 26–110 万字符）。
- **`recall.fairness.rareTerm.scanCap`**：限制参与“稀有词”判定的 seed 数（默认 512），防止长文本爆炸。
- **`deterministic` 模式**：只做纯 DRI + sticky ledger + 优先级裁剪（无 rareHigh/queryBoost/register/rotation 公平逻辑），
  供研究对照；`legacy` 模式保留 v1.3.0 全部行为。

#### Fixed

- **P0-4 召回逐候选随机掷骰**：同一记忆时有时无、α=0.1 单次命中≈10%、seed>0 时每轮 RNG 相同、p(n)=0 for n≥22——
  fair/deterministic 路径已无随机；legacy 保留公式仅用于回滚对照。
- **低α挤掉高α**：v1.3.0 概率洪泛 + createdAt FIFO 会持续把较早的高α挤出 block；1.4.0 由 σ 高车道 +
  优先级裁剪 + queryBoost 重入修复（block 内高α占比由仿真 ~22% 提升到 86–97%）。
- **`memory_recall` 命中失败后无路可走**：fair 模式下低α显式引用走探针、其余可 `offset` 翻页；
  `missType='time'` 明确告诉模型“关键词对了、时间不对”。

### 时间辅助（v1.4.0 新增）

#### Added

- **`engine/time-index.js`（新）**：纯内存日/月/年索引 + 时间查询归一化，导出
  `TIME_DEFAULTS` / `detectGranularity` / `normalizeTimeQuery` / `folderTimeRange` / `buildTimeIndex` /
  `queryTimeIndex` / `timeFallbackLadder` / `zonedDayStart` / `zonedMonthStart` / `zonedYearStart` /
  `dayKey` / `addZonedDays` / `formatWindow` / `validateTimezone` / `timeConstraintEnabled`。
  时区用 `Intl.DateTimeFormat`（绝不 ±86400000 推日界）；匹配规则唯一：folder 半开区间
  `[start,end)` 与查询窗口 `[from,to)` 重叠；索引只从 `index.json` 派生、**不落盘**，
  index mtime/时区变化时惰性重建；`time.mode='off'` 时零行为。
- **`time` 配置块（新）**：`mode` / `timezone` / `minRangeDays` / `maxRangeDays` / `centerDayPriority` /
  `fallback` / `fallbackMinResults` / `windowScanMax` / `askUserHint` / `judgeEventTime`。
- **`memory_recall` 时间参数**：`timeFrom` / `timeTo`（`'2026-10-31'`/`'2026-10'`/`'2026'`/epoch）与
  `granularity`（day/month/year）；只传时间不传关键词 = **纯时间浏览（browse）**，按事件时间升序并标注；
  最小 3 天（跨度不足以中心扩到 3 天）、最大 366 天、未来钳制、反向对调、非法降级不抛错。
- **事件时间采集**：归档时把消息 `time` 机械采集为 `eventStart=min(time)` / `eventEnd=max(time)+1` /
  `eventTimeSource='messages'`（`engine/compress.js` 的 `eventTimeRangeOf`；被动归档同写）；
  旧数据无事件字段 → 回退 `[createdAt, createdAt+1)`（`eventTimeSource='archive'`），不阻断升级。
- **index/folder 新可选字段**：`eventStart` / `eventEnd` / `eventTimeSource`（`'messages'|'judge'|'archive'`）；
  `engine/store.js` 的 `indexEntryFromMeta` 显式拷贝，read→write→read 不丢。
- **`engine.recall` 时间参数与返回**：返回 `timeWindow:{from,to,level,granularity,widenedTo,requested,enforced,
  hardWindow,hits,timezone}` 与 `missType:'time'|'keyword'`；时间过滤只作用于 `C(Q)∩W`（第一代），
  rank 定义在过滤后的候选集上（否则界不成立）。
- **`tools/time-view.mjs`（新，只读）**：按事件时间列出某个窗口内的记忆（`--memory/--from/--to/--json`），
  从不写任何文件。
- **`engine/cli.mjs`**：`recall` 新增 `--time-from/--time-to/--granularity/--offset/--limit/--mode`，
  省略 `--text` 但有时间参数 = 纯时间浏览；输出新增 `browsing/mode/page:{offset,limit,returned,candidates,hasMore}/
  timeWindow:{…}/missType`，additions 带 `lane`；`compress` 新增 `--allow-small-window`，输出
  `protectedTurn/smallWindow/maxFoldersCapped/eventTime`。
- **`tools/selfcheck.mjs` 新检查 `time index`**：CSR 时间索引与 folder 事件区间一致（50 条交叉核对）、
  时区可解析、`constrain` 过滤与朴素区间判断一致、`off/index` 永不改变召回。

#### Changed

- **`createdAt` 语义澄清**：它是**归档时间（archivedAt）**，不是事件时间；时间查询用事件区间，
  旧数据回退归档时刻。文档/README/SPEC 已写明，代码不改字段名、不迁移。
- **engine 默认 `time.mode='index'`，随包 `config.json` 默认 `'constrain'`**；`time.timezone` engine 默认
  `''`（宿主本地）、随包 `'Asia/Shanghai'`。两处有意不同，由 `test/config-consistency.test.mjs` 钉住。
- **`time.mode='off'`**：忽略时间参数并返回 warning；`'index'`：归一化但**不过滤**（`enforced=false`，
  工具需提示“未启用时间约束”）；`'constrain'`：过滤。
- **显式同时给 `timeFrom`+`timeTo` = 硬窗口**（不放宽）；单日/单月/单年 = 软窗口（走阶梯放宽）。

#### Fixed

- **G4 时间约束**：日/月/年/范围正确、最小 3 天归一、空白/非法/未来时间安全降级、旧数据无 eventTime 时回退；
  30+ 条边界/时区/闰年/跨日/区间重叠用例覆盖。
- **“时间错”与“关键词错”混淆**：过滤前有候选、过滤后为 0 → `missType='time'`，不计入 `memory_recall` 的
  3/6 次连败，并提示可向用户询问期望时间。

### 评分流水线与遗留数据

#### Added

- **`engine/era.js`（新）**：数据时代判定唯一真相——`LEGACY_ERA_CUTOFF_MS=Date.parse('2026-10-27T19:14:00Z')`、
  `SYNTHETIC_WINDOW_TOKENS=32000`、`SYNTHETIC_BEFORE_PERCENT=500`、`STRESS_MIN_FOLDERS=100`、
  `STRESS_MIN_PENDING=100`；导出 `sessionEraSignals`/`sessionEra`/`classifyFolderEra`/`summarizeEras`。
  规则：`legacy` 按 folder（createdAt 边界或 `pendingEra` 标记优先）；`synthetic = fakeWindow && (folders>=100 || pending>=100)`；
  其余 `current`。真实数据：legacy 593（587 pending）/ synthetic 2780（2180）/ current 369（2 pending）。
- **`tools/memory-audit.mjs`（新）**：只读时代审计（`--json` / `--verbose` / `--limit` / `--apply` / `--help`）。
  默认不写任何文件；`--apply` **只**在 `index.json` 的 folder 条目写 `pendingEra` 标记，不动
  `meta.json`/`scored`/`alpha`/`keywords`/`createdAt`/遥测，不重评、不删除。
- **`scoring` 配置块（新）**：`includeLegacy` / `maxPending` / `fallback` / `autoHeuristicAfterRounds{plain,channel}` /
  `taskBudgetPercent` / `taskMaxTokens` / `order` / `warnUniformAlpha` / `maxItemsPerJudge`。
- **任务区块预算**：整块 ≤ `min(scoring.taskMaxTokens=12000, 窗口×scoring.taskBudgetPercent=15%)`；
  待评分与待复核同时存在时待评分最多占 60%（pending 60% / rescore 40%）；单条 <60 token 时截断并提示。
- **任务区块排序与标签**：`scoring.order='newest'`（默认，最新归档先评分）、`mixed`、`oldest`（v1.3.0 FIFO 回滚）；
  每条显示 `pendingSince` 年龄与内容类型标签（tool/decision/user）。
- **pending 背压**：归档前 `pendingCount > scoring.maxPending`（200）→ 按 `scoring.fallback` 暂停归档或降级 heuristic；
  `compress-applied` 记 `pendingAtArchive`/`pendingCount`/`pendingRounds`。
- **heuristic 兜底**：`scoring.fallback='onPressure'`（默认）时，普通会话连续 4 轮 / QQ 通道连续 2 轮 pending 未消化即降级
  heuristic 评分（`meta.scoreMode='heuristic'`，可审计）；`'always'` 强制、`'never'` 关闭。
- **评分来源标记**：所有归档路径统一写 `meta.scoreMode='model'|'heuristic'`、`meta.archivedByVersion=<插件版本>`、
  `meta.archivedFrom='adapter'|'passive'`、`meta.pendingSince`。
- **`memory_judge` 批量上限**：`updates` 超过 `scoring.maxItemsPerJudge`（100）→ 拒绝并提示分批提交。
- **评分质量告警（非阻断）**：同批 keywords 重复率 >50%、α 或 β 全同、`reason` 缺失率 >90% → `warnings`；
  不改变已写入的评分。
- **judge 遥测（P2-5）**：每次 `memory_judge` 写一条 `type:'judge'` 事件
  `{sessionId,batchSize,updated,kept,rejected,elapsedMs,uniformAlphaRate,keywordRepeatRate,reasonMissingRate}`，
  **不含正文/关键词原文**；`scoring.judgeTelemetry=false` 可关。
- **`tools/recall-report.mjs`**：新增 `lanes (v1.4.0)` / `time filter` / `pending era` 三行。

#### Changed

- **`selfcheck` 时代分桶**：新增 `pending era` 检查——legacy/synthetic 只 INFO，**只对 current 判 WARN/FAIL**
  （WARN >5% 且 >20 条；FAIL >20%；current <20 个 folder 时不判 FAIL）。
- **`selfcheck` 真实数据口径**：本机检测到 QQ 插件时 **10 pass / 1 warn / 0 fail**；neutral profile 下
  **4 pass / 1 warn / 0 fail**。
- **遗留下沉**：`scoring.includeLegacy=false`（默认）时 legacy/synthetic pending **不进入**任务区块、
  不占用模型评分轮次；当前真实待评分只有 2 条（QQ 通道）。

#### Fixed

- **P0-1 自指反馈环**：任务区块自身是 system prompt 的一部分，v1.3.0 会随归档增长反过来触发下一轮归档；
  1.4.0 给任务区块加硬 token 预算，并只列 current pending。
- **P0-2 pending 永不参与召回 / 普通 WebUI 无 heuristic 兜底**：评分兜底策略 + 背压 + 质量告警落地；
  未评分记忆仍按契约不参与召回，但会在积压/通道不可用时自动降级 heuristic 保证可回忆。
- **P0-6 评分任务 FIFO 饿死新记忆**：默认 `newest` 优先，最新归档先进入任务区块。
- **P2-5 评分不可观测**：judge 遥测落地。
- **数据口径混淆（“81.8% pending”）**：时代分桶后明确当前真实口径 2/369 = 0.54%；
  pre-1.2.0 遗留 587 与 a46 压测 2180 **默认不回补**，只标记 `pendingEra`。

### 归档与健壮性

#### Added

- **`compress` 新配置**：`protectCurrentTurn=true` / `allowSmallWindow=false` / `smallWindowTokens=20000` /
  `hardLimitStop=true` / `maxFoldersPerStep=500` / `releaseTargetPercent=50` / `releaseFloorEnabled=true`。
- **`planCompression` 新可选入参**：`protectTurn` / `protectSeq` / `pendingCount` / `windowTokens` /
  `allowSmallWindow` / `maxFolders` / `eventTimes`（全部向后兼容）。
- **plan 只读字段**：`protectedTurn` / `protectedStart` / `smallWindow` / `maxFoldersCapped` / `maxFolders` /
  `releaseTokens` / `releaseTargetPercent` / `releaseFloor` / `eventTime` / `eventTimeSourceCounts` /
  `pendingAtArchive`（`releaseCapped` 保留兼容、恒为 false），
  以及失败 `reason ∈ 'protected-turn'|'no-legal-cut'|'small-window'|'window-conflict'|'hard-limit'`。
- **commit 事务（P1-4）**：先写 folder → 最后写 index；写 `.commit-<id>.json` journal，
  异常时回滚已写 folder + 图片 + 内存索引并 **rethrow** 原错误（附加 `error.rolledBack=true` /
  `error.writtenFolderIds`）；load 与每次 commit 开头清理陈旧 journal（只删 journal 文件，**绝不删 folder**）。
- **幂等键**：`(sessionId, turn, seqStart, seqEnd, contentHash)`（取代 v1.3.0 依赖 createdAt 的弱幂等）。
- **`engine/store.js` 新导出**：`removeFolder` / `beginCommitJournal` / `finishCommitJournal` /
  `cleanupCommitJournals`、`PENDING_ERAS` / `SCORE_MODES` / `ARCHIVE_SOURCES` / `EVENT_TIME_SOURCES`。
- **`compress-applied` 新遥测**：`pendingAtArchive`/`pendingCount`/`smallWindow`/`protectedTurn`/`foldersPlanned`/
  `foldersCommitted`/`rollback`/`maxFoldersCapped`/`eventTimeSourceCounts`/`scoreMode`/`archivedByVersion`。

#### Changed

- **删除 v1.3.0 的 arbitrary fallback cut**：找不到合法切点（例如会切断当前回合）时**拒绝归档**，不再“随便切一刀”。
- **hardLimit 硬停止**：连续 2 个压力 episode 仍无法降到 `hardLimitPercent` 以下 → 停止该会话自动归档并 WARN 一次
  （不再每个 pre-step 重试、越推越高）；`hardLimitStop=false` 恢复旧行为。
- **小窗口/假窗口 sanity**：窗口 < `smallWindowTokens`、配置窗口与宿主窗口相差 >4×、或实测上下文 >窗口 500% 且
  `allowSmallWindow!=true` 时**跳过自动归档**（每会话只 WARN 一次）。
- **pass-0 再归档**：本回合刚注入的 additions 受保护（`injectedTurn`），多步工具回合不再被自己删掉刚召回的记忆。
- **单步归档上限**：`maxFoldersPerStep` 与释放估算取小，`maxFoldersCapped` 可观测。
- **归档释放下限（新）**：不再“只压到 trigger 以下”；每次归档至少压到 `compress.releaseTargetPercent`（默认 **50%**）以下，
  `compressPercent` 只作为目标值、不足时自动扩大移除范围；合法切点/文件夹上限导致达不到下限时记 warning（下一次归档继续）。
  `releaseCapped` 字段保留兼容（恒 false），新增 `releaseFloor/releaseTargetPercent` 计划与遥测字段。

#### Fixed

- **P0-3 当前回合问题被中途归档**：`protectTurnOf` 计算当前 turn 保护区间，`planCompression` 的 `protectSeq`
  保证移除前缀不越过它；无合法切点拒绝归档。
- **P1-1 同回合 pass-0 误删刚注入的 recall additions**：`injectedTurn` 保护。
- **P1-4 commit 部分失败无回滚 / 重试不幂等**：事务 + journal + contentHash 幂等键。
- **P1-6 小窗口自我增压 / hardLimit 只告警**：小窗口 sanity + 硬停止 + 单步上限 + 假窗口 guard。
- **`tokensUpTo(-1)=Infinity` 的假窗口退化告警**：修正为有限值。

### 兼容性、迁移与回滚

- **无需迁移**：旧 `index.json`（version 1，无新字段）可读；新字段全部 optional（有值才写，缺省不写）；
  旧 `recall-state.json` v2/v1 可读（v2 只恢复 block、ledger/lanes 重置；v1 按 ids 重建），写回 v3；
  旧 config 缺新键 → 全部走默认；旧 pending 照常可被评分/召回。
- **不重写旧数据**：1.4.0 不批量重评、不改写旧 `meta.json`；`memory-audit --apply` 也只写 `pendingEra` 标记。
- **遗留数据处置（用户已拍板）**：pre-1.2.0 遗留 587 + a46 压测 2180 **默认不回补**；
  `scoring.includeLegacy=false` 让它们不进入评分任务区块；当前真实待评分口径 **2/369 = 0.54%**；
  1.3.0 之后正常会话 b5eeee7e 为 **0/359 = 0%**。
- **回滚开关（一档一开关）**：
  - `recall.mode='legacy'` → 回到 v1.3.0 概率召回（含随机掷骰/代数公式）；
  - `time.mode='off'` → 关闭时间辅助（不采集/不建索引/忽略时间参数）；
  - `scoring.fallback='never'` → 关闭 heuristic 兜底（pending > maxPending 时暂停归档）；
  - `compress.protectCurrentTurn=false` + `allowSmallWindow=true` + `hardLimitStop=false` → 恢复 v1.3.0 归档行为（不推荐）；
  - `scoring.order='oldest'` / `scoring.includeLegacy=true` → 恢复 v1.3.0 的任务区块排序/时代口径。
- **QQ 通道与跨平台不变**：compat 行为、三平台矩阵与 v1.3.0 一致；`compat.memberMinAlpha` 门控在 fair 模式下
  仍作为查询期 α 过滤。

### 文档、配置与版本

- **README**：新增 §1.3（确定性召回/三模式/公平性 G1–G3）、§1.10（时间辅助）、§1.11（遗留数据口径）、
  §3.0 配置默认值表与 §3.0.6 回滚开关；α 语义、recall-state v3、小窗口限制、任务预算/背压/质量告警、
  工具与目录结构、English summary 全部同步。
- **docs/SPEC.md**：§2 默认值（含 v1.4.0 全部新键与产品覆盖说明）、§3 数据格式（index 新字段/recall-state v3/
  时间索引纯内存）、§4.5 数据时代、§4.6 评分流水线、§5.7 归档保护与事务、§6.1–§6.8（legacy/FAIR-DRI/
  lane 状态/block 裁剪/分页/关键词匹配/渲染/时间辅助）、§9 遥测、§10 测试矩阵、§11 平台契约不变。
- **docs/VERIFICATION.md**：新增 §20「v1.4.0 验证记录」（公平性/时间/小窗口/数据时代/兼容/性能/用例数）。
- **`config.json`**：写入全部新键的产品默认值（`recall.mode='fair'`、`time.mode='constrain'`、
  `time.timezone='Asia/Shanghai'`、`scoring`/`time`/`match` 全量、`compress` 5 新键），
  `compress.triggerPercent` 保持 **60**，`_readme` 增补 1.4.0 说明；保留 `compat`/`logging`/`test`/
  `storage.perSession` 等既有键。
- **版本**：`package.json` 与 `engine/package.json` → **1.4.0**。
- **`test/config-consistency.test.mjs`（新）**：断言 `DEFAULT_CONFIG` == 随包 `config.json`（除两处有意的
  `time` 产品覆盖）== 文档中的关键默认值，且两个 `package.json` 版本一致 = 1.4.0。
- **`tools/verify-1.4.0.mjs`（新）一键门禁**：8 步 = 全量 `node --test` / `test/simulate.mjs` /
  `tools/selfcheck.mjs` / `engine/cli.mjs --help` / `tools/memory-audit.mjs --json` /
  `tools/time-view.mjs --help` / `test/e2e-adapter-simulate.test.mjs` / `test/e2e-real-data-readonly.test.mjs`；
  全部 exit 0 → `RESULT: PASS`，并汇总 node:test 用例数。
- **`package.json` scripts**：`check` 追加 `memory-audit --json` 与 `time-view --help`；新增
  `verify` = `node tools/verify-1.4.0.mjs`（保留 `release`/`release:status`/`test`/`simulate`/`selfcheck`/`cli`）。

### 事件约束（1.4.0 增补）

给记忆增加一层可选的**事件约束**：评分时由当前会话模型判断一段记忆属于哪个**事件**（一次旅行、
一个工作项目、一次方案评审/决定线程、一段持续排查的故障等），召回时可把检索范围限定在该事件内。
事件标签**全库唯一**，事件索引**纯内存派生**（不建事件文件夹、不搬记忆、不落盘第二份真相）。

#### Added

- **`engine/event-index.js`（新，零依赖）**：事件约束的唯一实现。导出
  `EVENT_DEFAULTS` / `EVENT_MODES` / `EVENT_METRICS` / `normalizeEventLabel` / `eventSimilarity` /
  `eventKeyOf` / `buildEventIndex` / `resolveEventQuery` / `assignEventLabel` / `eventIdsFor` /
  `eventConfig`。归一化：trim → NFKC → 折叠空白 → Latin 小写 → 去首尾成对引号/括号 →
  截断到 `event.maxLabelLength=60`；空占位词（空/无/不约束/无事件/none/null/n-a/-）→ “不属于任何事件”。
  相似度 = token 集合（Latin 词 len≥2 + CJK bigram + CJK 单字）上的 **Dice 系数**：
  `metric='dice'`（默认）`score = 2·|A∩B| / (|A|+|B|)`（对称、惩罚长度失衡：`项目` 吞不掉`登录重构项目`，
  `日本旅行`≈`日本旅行计划` 仍相似；实测 0.778），另可选 `avg` / `min` 做实验。
  “双向高度相似” = `score ≥ event.similarity.threshold=0.72`。
- **`event` 配置段（新）**：`mode`（`off` 忽略事件参数 / `index` 只建内存索引不约束（engine 默认）/
  `constrain` 真正过滤（随包 config.json 默认））、`maxLabelLength:60`、
  `similarity:{metric:'dice', threshold:0.72, maxCandidates:5}`、`askUserHint:true`；
  `validateConfig` 的 group/键校验同步（metric 枚举、threshold 0..1、maxCandidates 1..10）。
- **数据字段（可选，旧数据没有属正常）**：folder meta / index entry 新增 `event`（canonical 标签）、
  `eventSource`（`llm`）、`eventAt`（最近写入时间）；`indexEntryFromMeta` **有值才写**，旧 index 字节兼容。
  **不建事件文件夹、不新增落盘事件索引**：事件索引只从 `index.folders` 内存派生（缓存键 = index
  mtime/size/folderCount + 配置指纹）。
- **`memory_judge` 新参 `event`**：评分模型给记忆打事件标签（同一事件始终用同一标签；寒暄/一次性闲聊/
  纯过程日志给「空」= 删除 `meta.event`）。**评分期自动归并**：与已有 canonical 标签高度相似的标签
  静默归并到后者并返回 warning（稳定前缀 `event-merged:`），保证同一事件在全库只有一个标签。
  新记忆不强制 event（α+β+keywords 三元组必填不变），缺失时只加非阻断提示；judge 摘要含
  assigned/merged/cleared 计数（不含正文）。
- **`memory_recall` 新参 `event`**：可选；省略或给「空」= 不约束事件；与 `timeFrom/timeTo` 同时给时
  **AND**（`C(Q) ∩ W ∩ E`）。回忆期四态：`exact`（限定到该事件并标注条数）、
  `similar`（歧义：不自动合并，返回候选事件让模型判断；无法判断则提示询问用户）、
  `unknown`（该事件没有记忆：提示补标签 / `event:"空"` / 问用户）、`empty/disabled`（不约束）。
  `missType` 新增 `'event'` / `'event-ambiguous'`，**均不计 3/6 连败**。
- **`engine/recall-index.js` 事件过滤**：`scanCandidates`/`countCandidates`/`selectRecall`/
  `selectSigma` 支持 `eventIds`，在时间过滤之后过滤（只约束第一代；`hops` 后代沿用同一集合）；
  `stats.filteredByEvent` 按去重口径计数（与 `filteredByTime` 同规则）。
- **遥测**：`recall` 事件新增 `eventStatus` / `eventLabel` / `eventFiltered`（旧遥测缺字段按“缺失”
  处理，不当作 0 丢失）。
- **`engine/cli.mjs`**：`recall` 新增 `--event <name>`；省略 `--text` 但给 `--event` = **纯事件浏览**
  （按 eventStart 升序）；输出新增 `eventInfo` / `eventStatus` 相关字段与歧义/未知提示。
- **`test/event-index.test.mjs`（新，28 例）**：归一化/空词/长度、Dice/avg/min 相似度、
  exact/similar/unknown/disabled 四态、评分归并（`event-merged:`）、索引构建与缓存、真实标签实测。
- **`test/recall-index.test.mjs` +8 事件用例**：`C(Q)∩W∩E`、时间+事件 AND、`filteredByEvent`。

#### Changed

- **自动召回不加事件约束**：自动召回（`agent/inbox/inserted`）发生在模型思考**之前**，没有事件判断者；
  事件约束只用于**模型主动检索**（`memory_recall`）。空召回提示可补一句“可用 memory_recall 的 event
  参数限定”，不新增常驻提示。
- **召回过滤顺序**：`α/minAlpha → 时间 → 事件`；显式双端点时间仍是硬窗口；事件约束与时间一样只约束
  第一代。`stats.candidates` 语义保持“全部过滤后（α∩时间∩事件）的候选数”。
- **旧文案修正**：`memory_judge` 工具描述与回忆块前言里的 “α 影响回忆概率” 改为
  “α 决定召回优先级与车道（回滚模式 legacy 下才是概率乘数）”；`memory_recall` 描述里的
  “α 概率规则” 改为 “α 优先级规则”。README/SPEC 的原文镜像同步。

#### 兼容与回滚

- **无需迁移**：旧记忆没有 `event` → 不参与事件约束召回（仍可按关键词/时间正常回忆）；
  用 `memory_judge` 复核时补标签即可，**不批量回填、不改写旧 meta**。
- **回滚**：`event.mode='off'` 一键关闭（忽略事件参数、不建索引；已写入的 `event` 标签保留，重开即恢复）。
- **明确不做**：不做独立事件进程/约束器服务、不建物理事件文件夹、不新增落盘事件索引、
  不做语义向量相似（零依赖 token 相似度）、不自动给历史数据打标签。

### 已知限制

- 公平性保证有前提：高α首轮保证要求稀有高α候选 ≤ k_H 且高α到达率 ≤ k_H/轮；低α轮转界要求 `a_low < r`；
  超过时 `degraded=true` / `registerDrops>0` 会出现在遥测与日志（配额不足，不是丢记忆）。
- 确定性选择意味着“同样条件不会自己变化”：要翻更多结果用 `memory_recall` 的 `offset` 分页。
- 旧数据没有事件时间（本机 0/4825 消息带 time）：历史记忆的时间查询回退归档时刻，直到新归档产生事件时间。
- heuristic 兜底质量低于模型评分（α 启发式、β=0、关键词 tokenizer），只保证可回忆、不保证准。
- 时间辅助不建物理日/月/年目录；不要手工按日期搬 folder（会被判定为数据损坏）。
- 1.4.0 不开放 `memory_judge` 的 eventTime 覆写（`time.judgeEventTime=false`，留 1.4.1 评估）。
- 时间阶梯 `day3 → month → year → all` 是平级放宽序列（不是 day3 内再嵌套 month）。
- 重启后首轮 block 裁剪没有 `candidateIds`，退化为纯 α 裁剪（仍保证高α pin 与至少保留 1 条）。
- **事件相似是 token（Dice）相似、不是语义向量**：同义改写、缩写/全称混用可能低于 0.72 阈值，
  此时按 `similar` 返回候选让模型/用户判断，而不是自动合并；阈值/指标可配。
- **旧数据没有 event**：1.4.0 之前的记忆不参与事件约束召回（仍可按关键词/时间回忆），复核评分时补标签即可。
- **自动召回不做事件约束**：发生在模型思考之前，没有事件判断者；事件约束只在 `memory_recall` 生效。

### Tests

- v1.4.0 新增/扩展测试：`test/recall-index.test.mjs`、`test/time-index.test.mjs`、`test/keyword-match.test.mjs`、
  `test/turn-protection-engine.test.mjs`、`test/memory-audit.test.mjs`、`test/config-consistency.test.mjs`、
  `test/e2e-adapter-simulate.test.mjs`、`test/e2e-real-data-readonly.test.mjs`，以及 `test-adapter/` 的
  公平性/确定性/评分压力/时间工具适配用例。
- 发布门禁 `node tools/verify-1.4.0.mjs` = **8/8 PASS**；`node --test` = **916 tests / 914 pass / 0 fail / 2 skip**
  （2 skip = Node zstd 平台条件跳过，非缺陷）+ e2e **12 + 7 = 19** → 门禁汇总 **935 / 933 pass / 0 fail**。
  最终数字以 `docs/VERIFICATION.md` §20 与门禁输出为准（本条目不改写历史 v1.3.0 的 493 用例基线）。

## [1.3.0] — 2026-10-31

本版本完成两件事：**QQ 渠道兼容**（`dsh-onebot-qq` 与 `Derpyu520/qq-bridge` 的「归档 → 评分 → 回忆」
闭环跑通，未安装这两个插件时行为与 1.2.1 完全一致）与**跨平台兼容**（插件与独立引擎用同一套代码在
**Windows、Linux、macOS** 上运行，CI 矩阵扩到 **三平台 × Node 20/22/24**）。跨平台部分修掉一批只会在
POSIX 上暴露的路径/URL/启发式问题，补上「任意一台机器都能验证」的跨平台测试与平台事实注入；
**Windows 行为不变**。

### 跨平台兼容（Windows / Linux / macOS）

#### Added

- **`lib/paths.js`（新）**：可移植路径助手 `expandHomePath()` / `isHomeRelativePath()`——
  `~`、`~/…`、`~\…` 在三个平台都展开到当前用户 home；`~user`（shell 用户名写法）**不**展开；
  Windows/POSIX 分隔符都接受，因此一份 `config.json` 可跨机器复用。
- **`storage.dir` 与 `compat.mediaRoots` 支持 `~/`**：`"dir": "~/rofm-memory"`、
  `"mediaRoots": ["~/Pictures/QQ"]` 会在 Windows/Linux/macOS 上一致展开；相对路径仍相对插件目录
  （`mediaRoots` 相对进程 cwd，保持既有兼容），绝对路径原样使用；非法/缺失值回退 `memory/`，
  不会让插件启动失败。（`lib/config-store.js` 的 `resolveStorageDir()`、`lib/compat.js`）
- **`validateMediaPath()` 可注入平台与路径规则**：新增可选 `platform`（`win32`/`linux`/`darwin`）与
  `pathImpl`（`node:path` / `path.posix` / `path.win32`）参数，使「Windows 大小写不敏感」「POSIX 大小写敏感」
  「macOS realpath 归一化」三种围栏规则都能在任意一台机器上单测；生产调用不传，行为与既有行为相同。
- **`tools/main-module.mjs`（新）**：跨平台主模块检测——`isMainModule()`（纯比较，可注入平台）、
  `canonicalScriptPath()`（realpath 解析符号链接）、`invokedAsMain()`；替代 CLI 里手拼 `file://` URL 的旧写法。
- **`test/portability.test.mjs`（新，12 例）**：① 静态检查——全仓相对 import 必须按磁盘大小写精确解析
  （Windows 上发现不了的 Linux 大小写崩溃）、运行时代码只用 `node:` 内置模块、禁止手拼 `file://` URL 与
  内联 `process.platform` 分支、`package.json` 的 `main`/`exports`/`files` 大小写精确存在；
  ② `~` 展开与 adapter 接线；③ POSIX/Windows/macOS 路径围栏模拟；④ 真实文件系统：符号链接/junction
  记忆目录、空格/中文/`#` 路径、LF-only 写入。
- **`test/main-module.test.mjs`（新，6 例）**：空格/`#`/`%`/`?`/中文路径匹配、注入平台的大小写折叠、
  符号链接/junction 入口，以及「把 repair 工具复制到 `run #1 中文 目录` 后执行 `--help`」的端到端回归。
- **`test/importance-cross-platform.test.mjs`（新，4 例）**：Windows 与 POSIX 路径的 `signals.code`
  必须相等（同一段对话在任何 OS 上 α 一致）；日期/URL/协议相对 URL 不计为路径。
- **插件激活日志带平台信息**：`dsh-rofm activated: platform=<os>/<arch> node=<version> memoryDir=…`。
- **CI 三平台矩阵**：`ubuntu-latest` + `windows-latest` + `macos-latest` × Node 20/22/24（9 个组合），
  新增 Platform info 步骤打印实际 `process.platform/arch/version`；测试步骤保留 `shell: bash`
  （macOS 自带 bash 3.2 兼容）。
- **文档**：README 新增 §2.4「跨平台支持（Windows / Linux / macOS）」（三 OS 安装示例、数据目录与路径规则、
  macOS 大小写不敏感/符号链接说明、`mediaRoots` 的 POSIX 示例、排障日志）；
  CONTRIBUTING/PUBLISHING/VERIFICATION/SPEC 同步（SPEC §11 路径与平台契约、VERIFICATION §19 跨平台验证）。
- **QQ 语音归档（`lib/voice-notes.js`，新）**：`dsh-onebot-qq` 把入站语音渲染成 `[语音]` 占位、转写结果稍后
  以 `（语音转写：…）` 单独投递；归档时把两者合成 `[语音] <转写文本>`，没有转写的占位记成 `[语音]（未转写）`，
  回忆块里仍然看得出「这是一条语音」以及说了什么。只作用于 QQ 通道会话（普通 WebUI 会话文本不受影响）；
  纯字符串变换、幂等、无标记文本原样返回。
- **README §3.2.7 按真机 e2e 改写**：图片/视频/文件是 `[图片:<路径>]` 注解读，语音不含路径（靠 STT）；
  补充两个前提（群聊必须 @ 机器人、`compat.mediaRoots` 必须含插件 `mediaDir`）与「QQ 会把 @ 和图片拆成两条」。

#### Fixed

- **`tools/repair-session-log.mjs` 主模块检测（只在 POSIX/特殊路径上坏）**：原来的
  `new URL('file://' + path.resolve(argv[1]))` 在含 `#`/`?`/`%`/空格/非 ASCII 的路径上、以及符号链接调用
  （macOS `/tmp`→`/private/tmp`、`link:` 安装）时会判定失败，工具静默不执行；改用
  `invokedAsMain(import.meta.url)`，`selfcheck.mjs` 同步。
- **`engine/importance.js` 的 POSIX 路径识别**：代码/路径密度信号原来只认 Windows 盘符路径，
  同一段对话在 Linux/macOS 上 α 会偏低；现补充 POSIX 绝对/`./`/`../`/`~/` 路径（并让 Windows 正则避开
  URL 尾与 `PATH=/usr/bin:/bin` 误判），三平台 α 一致。
- **zstd 工具在旧 Node 上的裸 `TypeError`**：`repair-session-log.mjs` / `selfcheck.mjs` 现在先探测
  `node:zlib` 的 zstd 能力，缺失时给出「需要 Node >= 22.15，或改用纯 `.jsonl`」的可执行错误
  （`engines.node >=20` 不变）。
- **`lib/qq-media.js` 围栏比较集中化**：`comparablePath`/`isPathInside` 改用可注入的 `pathImpl.sep` 与
  platform 口径（macOS 仍按 realpath 归一化后的真实路径比较），生产行为不变、规则可单测。
- **测试环境的跨平台/跨机器稳定性**：`test-adapter/plugin-mock.test.mjs` 显式 `compat.qqBots="off"`，
  开发机真的装了 QQ bot 插件时不再误判监听器数量；文件符号链接用例在无权限环境正确 skip，
  目录链接改用 junction 覆盖 Windows。

#### Changed

- **版本 1.3.0**（`package.json`、`engine/package.json`）。
- `config.json` 的 `_readme` 补充 `~/` 展开与路径解析规则说明。

#### Tests

- `node --test` 共 **493** 用例（**491 pass + 2 skip**，0 fail）：`test/*.test.mjs` 361（359 pass + 2 skip，
  后者是 Windows 上无法创建文件符号链接的既有用例）、`test-adapter/*.test.mjs` 132 全 pass、
  `test/simulate.mjs` 计入 1；新增 portability 12 / main-module 6 / importance 跨平台 4 三组跨平台用例，
  以及 voice-notes 11（语音标记改写 + `buildSurfaceEntries` 开关）。
  本机（Windows 11 / Node v24.21.0）另跑 `node test/simulate.mjs`、`node tools/selfcheck.mjs`
  （7 passed, 0 warnings, 0 failed）、`node engine/cli.mjs --help` 均通过；Linux/macOS 由 CI 矩阵兜底。


### QQ 渠道兼容（与跨平台同版发布）

让 `dsh-onebot-qq` 与 `Derpyu520/qq-bridge` 下的「归档 → 评分 → 回忆」闭环真正跑通，
且**未安装这两个插件时行为与 1.2.1 完全一致**（`compat.qqBots` 默认 `auto`，检测不到就不注册任何新监听器、
不改 system prompt、会话 id 原样使用）。

#### Added

- **`lib/compat.js`（新）**：QQ 渠道检测与解析层——profile 定位（`DSH_PROFILE_DIR` →
  `$DSH_HOME/profiles/$DSH_PROFILE` → `~/.dsh/profiles/desktop`）、两个插件的三重检测信号、
  `qqBots: auto|off|on` 开关、`compat` 配置块归一化、会话 id → 稳定 chat 键
  （onebot 去 `-<base36 时间戳>` 后缀、Derpyu 去尾部 32 位 hex）、群消息发送者解析
  （`<user_message qq="…">` / `[HH:MM nick(uid)]`）、α 门控决策、触发 kind 合并、评分模式决策；
  全部纯函数、零依赖、不抛错，带 profile mtime 缓存。
- **`lib/compat-autopatch.js`（新）**：Derpyu 工具白名单自动补丁——定位
  `<profile>/node_modules/qq-agent-presets/qq-tool-restrict.mjs`，把 `memory_judge` /
  `memory_recall` / `memory_image` 幂等插入 `SAFE_EXACT`；写前备份（最多 5 份）、原子写、
  sha256 状态（`memory/.compat-state.json`）、上游更新后自愈重打；结构不识别/只读/定位失败只 WARN 不写。
- **`lib/passive-archive.js`（新）**：被动归档兜底——监听 `session/event` 的 `compaction/summary`，
  把被 shadow 的 user/assistant 原文归档进同一 chat 记忆目录（不修改对方 checkpoint、不写自己的 checkpoint），
  per 会话水位 `memory/sessions/<chatKey>/.passive-watermark.json` 去重。
- **`lib/heuristic-score.js`（新）**：启发式评分降级路径——α 复用 `engine/importance.js`、
  关键词复用 `engine/tokenize.js`，归档即 `scored:true`（模型评分不可用时保证记忆仍可回忆）。
- **`lib/qq-media.js`（新）**：onebot 本地图片路径解析/校验/暂存——从正文抽绝对路径（后缀白名单）、
  realpath 必须落在 `compat.mediaRoots` 内、大小上限、复制到 `memory/.staging/<chatKey>-<messageId>/`、
  归档时消费并清理。
- **`compat` 配置块**（`config.json` + adapter 默认值/校验）：`qqBots`、`ownerIds`、`memberMinAlpha`、
  `autoPatchDerpyu`、`channelScore`、`mediaRoots`、`maxImageBytes`、`stagingTtlMs`。
- **引擎 `recall({ minAlpha })`**：可选的 α 下限；低于下限的记忆与未评分记忆同口径
  （不匹配、不掷骰、不占 `firstGenMax`、不做关键词桥），用于非主人群成员的回忆门控。
- **`surface.buildSurfaceEntries(session, measurement, { conversationSourceKinds })`**：
  允许把第三方插件的 user 消息 kind（如 `plugin:dsh-onebot`）计为真实对话，否则这些消息会被当成
  宿主注入的 pinned 上下文而永不归档。
- **QQ 通道会话 prompt 规则**：禁止提及评分/打分/α/β/`memory_judge`/`memory_recall`/评分任务/归档/
  压缩归档/写入记忆库；允许自然引用回忆内容；上下文不足时引导调用 `memory_recall`。
- **每轮重置 `memory_recall` 未命中锁**：`agent/pre-step` 检测 `turn` 变化即 `resetAttempts()`，
  reserved2 这类没有真人 inbox 消息的通道会话不会在 6 次未命中后永久锁死。
- **`docs/SPEC.md`**：新增 v1.3.0 修订说明（compat 为 adapter-only，引擎仅新增 `minAlpha`）。

#### Changed

- **Derpyu 评分策略**：补丁生效 → 模型评分（`memory_judge`）；补丁未生效或被
  `autoPatchDerpyu=false` 关闭 → 自动降级启发式评分并只打一条 WARN。
  `compat.channelScore="heuristic"` 可强制启发式。
- **两个 QQ 渠道都保持 rofm 自我压缩**：rofm 60% 先于 preset/宿主压缩器 80%，正常路径下 rofm 先归档；
  被动归档只在对方先压时兜底。
- **记忆目录按 chat 键归并**：`memory/sessions/<chatKey>/`，Derpyu `/reset`、切模式、
  preset 冲突重建后仍命中同一份记忆与 `recall-state.json`；旧数据不迁移（compat 前不会产生记忆）。
- **`memory_recall` 继承门控**：同一轮内由非主人群消息触发的 `memory_recall` 也带
  `minAlpha = compat.memberMinAlpha`，模型无法绕过群成员门控。
- **两个 `package.json` 版本升到 1.3.0**（嵌套 `engine/package.json` 跟随插件发布版本）。

#### Fixed

- **第三方插件的 user 消息被当成宿主注入上下文而永不归档**：`lib/surface.js` 原本把
  `source.kind` 不在内置集合里的 user 消息按 pinned 处理，onebot 的
  `plugin:dsh-onebot` 消息因此永远不会进入归档；新增
  `buildSurfaceEntries(session, measurement, { conversationSourceKinds })` 选项让兼容层追加该 kind。
- **`memory_recall` 可绕过群成员门控**：自动回忆按 `memberMinAlpha` 收窄后，模型仍可主动调用
  `memory_recall` 拿到低 α 记忆；现在该工具在同一轮内继承同一个 α 下限。

#### Docs

- README 新增「3.2 QQ 渠道兼容」整节：检测/开关、chat 键归并、群成员门控、评分策略、
  自动补丁与回滚、被动归档、onebot 图片归档、通道可见性、`compat` 配置表、已知限制；
  §8 English summary 同步补英文摘要；目录结构与测试数字更新。

#### Tests

- 304 → **456** 用例（`node --test`，454 pass + 2 skip（Windows symlink 用例））：
  新增 compat（28）、compat-autopatch（31）、heuristic-score（10）、passive-archive（13）、
  qq-media（49）、recall `minAlpha`（4）、适配层 compat 集成（10）与兼容流水线（7）。
- 零回归：`compat` 未启用时监听器仍是 3 个、prompt 文本不变、会话 id 原样使用；
  既有契约/回归测试全部保持通过。

## [1.2.1] — 2026-10-28

### Fixed

- **高 α 警告真正落地（用户反馈修复）**：`importance.warnAbove` 的警告此前只存在于引擎
  `plan.warnings`，DSH 适配层从不记录——README 却写着“会记录警告”。现在
  `lib/plugin.js compressOnce()` 把 plan 中的新警告（排除启动时已打印的配置警告）以
  `archive: …` 写进宿主日志，并把 `warnings` 数组写入 `compress-applied` 遥测。
- **`memory_judge` 对超阈值 α 回传提醒**：模型提交 α > `importance.warnAbove`（默认
  `0.8`）时**仍按提交值生效**（`warnAbove` 是提醒阈值，不是上限），但工具返回值新增
  `warnings: string[]`，render 后模型看到「注意：α=0.95 超过 importance.warnAbove=0.8…
  建议复核时下调（本次已按提交值生效，未拦截）」。

### Docs

- README：`α > warnAbove` 修正为 `α > importance.warnAbove（默认 0.8）`，并说明警告的
  可见位置（插件日志 / `compress-applied.warnings` 遥测 / `memory_judge` 返回值）；
  补充 `memory_judge` output 的 `warnings` 字段；测试计数 302 → 304。
- `docs/SPEC.md`：修订说明、§4.2 output schema / execute 行为、§9 `compress-applied`
  遥测示例与说明、§10 测试计数；`docs/VERIFICATION.md` 新增 §18 1.2.1 验证记录。

### Tests

- 新增用例：`memory_judge` 对 α=0.95 返回提醒且值保留 0.95、α=0.5 无提醒；归档时引擎
  警告出现在宿主日志与 `compress-applied.warnings`；当前基线 **304/304**（引擎 188 +
  适配层 115 + simulate 1）。

### Version

- `package.json` / `engine/package.json` → **1.2.1**（行为补丁；`config.json` 无新增键，
  向后兼容）。

## [1.2.0] — 2026-10-28

### Added（用户请求的改进）

- **R1 归档与任务区块上限提高**：`compress.maxFoldersPerRun` 默认 **100 → 500**
  （`engine/config.js` `DEFAULT_CONFIG` 与随包 `config.json` 同步；`storage.maxFolders`
  仍是 10000）。「记忆评分任务」区块每轮最多列 **100 条待评分 + 100 条待复核**
  （`lib/plugin.js` `TASKS_LIST_LIMIT = 100`，已导出，此前各 50 条）。一次压力事件能清掉
  更多积压；代价是任务区块可能变得很长——**100 条待复核每条都带完整原文与上次评分理由**，
  满额时区块可能给每轮上下文增加数万字符，提交评分后会立刻缩短。
- **R2 文件夹标题规则**：标题优先取 chunk 内**第一条内容非空的用户消息**；chunk 从回合中间
  开始（assistant/tool 开头）时，在本次归档的移除区间里**向前**继承最近一条有内容的用户消息
  （不再退化成 `{"exitCode":0,...}` / `[tool-call ...` 这类重复前缀）；都没有才退回 chunk
  首条消息，仍为空则用 `第N段对话`。标题最多 **24 个 Unicode 码点**（去重后缀可能超出）；
  同一次归档内出现重复标题时，给**每个**重复项加全角序号 `（<folder 序号>）`（1 起），
  唯一标题保持不变。标题只用于展示（`meta.title` / 任务区块 / 记忆查找），不参与回忆概率。
- **R3 checkpoint 注记合并（N 累计）**：每次归档会把替换区间前方**本插件自己的**旧注记
  `[memory] N 段更早的对话已归档到 memory/` 合并进来，surface 上只保留**一条**注记，
  其 N 为**累计归档段数**（旧注记文本含附录被丢弃、只保留 N 累加）。
  `buildArchiveNote(plan, { totalSegments })` 支持累计 N（不传时输出与旧版逐字节相同），
  新增导出 `parseArchiveNote(text)`（锚定开头、兼容带/不带关键词并容忍 `\n\n` 附录）。
  **外来 checkpoint**（别的压缩器写的）**不合并、不改写**，且阻止替换区间继续向前扩张。
  遥测 `compress-applied` 新增 `mergedCheckpoints` / `archiveSegments`，保留
  `pinnedShadowed` / `pinnedChars`。
- **R4 pinned 记录策略收紧**：归档不再把**宿主每轮都会重新注入**的 pinned 内容写进注记——
  `runtime-context` / `time-context` / `skill-catalog` / in-history `system/message`、
  `developer/message` 副本 / 遗留 `rofm-recall` 一律静默 shadow（宿主会再注入，写进去只会
  白占上下文），**永不变成回忆文件夹**；只有 `subagent-settled`、
  `subagent-error-details`、`tool-jobs`、`user-approval` 这类**一次性通知**才写入注记附录，
  且只写**本次归档事务 shadow 到**的部分；未知来源的 pinned 按“写入”处理（避免新宿主特性
  静默丢数据）。附录固定标记改为
  `[memory] 本次归档区间内还有 N 条非对话上下文（子代理/后台任务/审批等一次性通知，宿主不会重新注入），已并入本说明以免丢失：`。
  说明（含附录）仍必须小于被替换内容，否则跳过本次压缩（安全优先，不丢数据）。
- **R5 独立自检工具 `tools/selfcheck.mjs`**：零依赖、**不 import `lib/plugin.js`** 的独立
  健康检查（自带读取器，坏掉的适配层无法掩盖自身损坏），校验：配置与 `engine/config.js`
  可加载、引擎默认值（500 + 标题唯一性冒烟）、记忆库 index↔磁盘双向对账与 `meta.json`
  模式、`recall-state.json` v2 快照、用 zstd 解帧重放 `surfaceOp` 得到的会话日志注记
  （同一会话本插件注记 ≤ 1、N 为正整数、附录不得混入会被重新注入的内容、外来 checkpoint
  只计数不报错）、可选 `--with-tests` 跑测试套件。每项 PASS / WARN / FAIL，**有 FAIL 才退出 1**；
  旧版本合法历史数据报 WARN 不报 FAIL。支持 `--json --memory-dir --sessions-dir --session
  --max-sessions`，并新增 npm script `selfcheck`（`npm run check` 也纳入）。
- **评分任务区块明确要求“本轮直接提交”（用户请求）**：`记忆评分任务` 开头新增一句
  「**这是本轮必须完成的工作：请直接调用 memory_judge 提交下面列出的条目，不要询问用户、
  不要等待用户确认；建议一次提交本轮列出的全部条目，提交后继续当前任务。**」。
  背景：100+100 的大列表会让模型把评分当成“需要用户批准的动作”而拖延——实测一个会话
  21 个 turn 内 `memory_judge` 调用 **0 次**、393 条积压；而 1.0.0 时代列表只有 6 条时，
  模型在归档后 34 秒内就自主提交。这是提示词层面的行为约束，**不新增配置项**。

### Changed

- **归档说明的 pinned 附录语义**（R4）：从 v1.2 的“所有区间内 pinned 上下文都并入注记”
  收紧为“只保留一次性通知”；runtime-context 等重新注入类内容不再进注记，历史会话里由旧版
  留下的多条注记/附录不会被自动改写（只在新归档发生时自然合并；`tools/selfcheck.mjs`
  会把旧版本遗留的多注记/旧附录报为 WARN）。
- **任务区块列表上限来源**（R1）：每轮列表上限由 `TASKS_LIST_LIMIT = 100` 控制，与
  `compress.maxFoldersPerRun = 500`（单次归档量）相互独立。

### Tests

- 新增 `test/selfcheck.test.mjs`（13 个用例：CLI 参数、PASS/WARN/FAIL 判定、退出码、
  `--json` 汇总等）；
- `test/compress.test.mjs` 新增 R2 标题用例（中途开始的 chunk 继承最近用户消息、重复标题
  `（N）` 后缀且唯一标题不变、无用户文本回退 `第N段对话`）与 `buildArchiveNote` /
  `parseArchiveNote` 用例；
- `test-adapter/plugin-mock.test.mjs` 新增 R3（旧注记合并为累计单条、旧附录丢弃、外来
  checkpoint 终止合并且不改写、两次真实归档端到端只剩一条注记）与 R4（重新注入类 pinned
  不写入、四类一次性通知写入且只来自本次事务、附录标记文本、`pinnedRecorded` 遥测）用例；
  任务区块上限用例改为 100+100；
- 当前基线：**引擎 188/188、适配层 113/113，`node --test` 共 302/302 通过**；
  `node tools/selfcheck.mjs` 在本机真实数据上 **4 passed, 1 warnings, 0 failed**（WARN 为
  旧版本遗留的多条注记，历史数据不算 FAIL）。

- **CI 兼容**：`node:zlib` 的 zstd 只从 Node 22.15/23.8 起提供，Node 20 上 `test/repair-session-log.test.mjs`
  与 `test/selfcheck.test.mjs` 自动 skip（其余用例照常跑），CI 矩阵保持 Node 20/22/24 × Linux/Windows，
  并新增 `tools/selfcheck.mjs` 冒烟步骤。

### Docs

- README：头部 v1.2 摘要、§1.1（标题规则/注记合并/ pinned 分类）、§1.2（100+100 与上下文代价）、
  §1.6（新遥测）、§1.8（重写为注记合并 + pinned 记录策略）、§3（`maxFoldersPerRun=500`）、
  §4 目录结构（`tools/selfcheck.mjs`）、§6 已知限制、§7（新增 selfcheck 使用说明/检查项/退出码
  与样例输出、测试矩阵与计数）、§8 English summary；
- `docs/SPEC.md`：v1.2.0 修订说明、§2 默认值 500、§3 `compress-applied` 遥测字段、
  §4.2 任务区块 100+100、§5 标题规则（R2）、§5.4 `buildArchiveNote`/`parseArchiveNote`、
  §5.5 注记合并（R3）与 pinned 记录策略（R4）、§7 公共 API、§9 报告字段、§10 测试矩阵与计数；
- `docs/VERIFICATION.md`：新增 §17 v1.2.0 验证记录（R1–R5 + 真实运行数字），并修正
  §13.4 的 `maxFoldersPerRun 100`、§16.3 的 50+50、pinned/I7 旧描述等过期表述；
- `docs/PUBLISHING.md`：发布前基线更新为 302 个测试并加入 `node tools/selfcheck.mjs`。

### Version

- `package.json` / `engine/package.json` → **1.2.0**（新行为；`config.json` 无新增键，
  旧配置/旧记忆文件夹/旧 recall-state/旧会话日志均向后兼容）。

### 2026-10-26 / 10-27 工作批次（并入 1.2.0 正式版）

#### Added（用户请求的改进）

- **α 判断纳入用户喜好**：`memory_judge` 的 `TOOL_DESCRIPTION` 与 `alpha` 参数说明、
  “记忆评分任务”区块的 α 评分口径都明确要求——用户明确表达的喜好/厌恶/习惯/长期偏好
  （「我喜欢…」「以后都…」「不要…」）判为较高 α，闲聊/过程性日志判低。α 仍由当前会话
  模型判断（归档本身不调用模型）。
- **模型主动回忆工具 `memory_recall`**：模型可传关键词主动检索本会话归档；与自动回忆
  共用同一套关键词匹配 + α 概率规则（`engine.recall`），已在回忆块中的条目作为
  `excludeIds` 跳过、不重复注入；结果带 α/β/关键词/原文，图片以**文件路径**列出。
  **连续未命中升级**：连续第 3 次未命中提醒“可能关键词没有选对或目标回忆 α 值太低…”；
  模型继续换关键词则连续第 6 次未命中后**停用工具**并提示“目标回忆 α 值过低或运气不行，
  如有需要下一轮对话再尝试。”，本回合再调用直接报错；成功回忆或下一条真实用户消息重置。
- **图片文件夹 + 路径提示（程序完成，不依赖模型）**：新增每会话 `<memoryDir>/images/`。
  归档时把归档区间里的图片块替换成 `[图片：（<name>）]`，把规范化图片字节按名复制进
  images/，并在 `meta.images` 记录 `{name, placeholder, mediaType, width, height, bytes,
  attachmentId}`；同时维护 `images/index.json` 查找表。**回忆时不再重新上传附件**，
  而是把占位符就地展开成 `[图片：（<name>，文件：<绝对路径>）]`（文件丢失标 `（缺失）`），
  模型用宿主 `read_image` 读取。附件服务/路径不可用时降级为占位文本并记 warning；
  归档被拒绝/回滚时清理本次写入的图片与索引条目。没有新增配置项。
- **评分后重写头节点**：`memory_judge` 成功改动任务列表后设置 `forceNewSeries`，下一次
  pre-step 返回 `startsRequestSeries: true`，宿主重写系统提示词头节点而不是追加整份 in-history
  系统提示词（否则每轮评分会多带上万字符）。
- **任务区块上限 12+12 → 50+50**：`记忆评分任务` 每轮最多列 50 条待评分新归档 +
  50 条待复核（此前各 12 条）。一次可提交更多，清空积压更快；代价是区块变长
  （待复核条目含完整原文，50 条时请留意上下文占用）。
- **归档图片查找工具 `memory_image`**：只读；按记忆关键词/标题/文件名（`query`）、
  记忆文件夹 id（`memoryId`）或图片文件名子串（`name`）过滤，返回图片**绝对路径**、
  是否存在、媒体类型/尺寸/字节数、所属记忆 id 与归档时间；可再用 `read_image` 查看。
- **会话日志修复工具 `tools/repair-session-log.mjs`**：修复 v1.2 早期试验形态（回忆块写成
  历史消息）漏写 message `id` 而损坏的日志；只补缺失的 id，默认备份，支持 `--dry-run`。

#### Changed

- **回忆块注入位置：保持系统提示词 section（回退 v1.2 的历史消息试验）**。回忆块仍是
  `dsh-rofm:recall` system prompt section（order 100），注入/恢复/再归档都设置
  `forceNewSeries`，由 `onPreStep` 返回 `startsRequestSeries: true` 让宿主重写头节点。
  v1.2 曾把它改成“系统提示词之后的第一条历史消息（原地替换）”，现已按用户要求回退：
  该形态会占一条 user 历史消息、在已有历史的会话上无法保证最早位置，且早期实现因漏写
  message id 影响会话加载（修复工具见上）。
- **句子完整性拆分（I2）**：`engine/compress.js` 的单条超长消息不再按裸字符数切片，而是只在
  句子边界（`。！？；…`/换行；英文 `. ! ? ;` 仅在空白/结尾前）切分；跨目标的句子整体移动，
  **单个回忆文件夹允许超过 `targetChunkChars`**；单句超长整句保留；切分文本拼接与原文完全一致、
  不拆 UTF-16 代理对。其余分块规则（整用户回合、minChunkChars、maxFolders、tool 配对）不变。
- **pinned 上下文不再无声消失（修复）**：压缩替换区间内夹着的非可归档 pinned 节点
  （runtime-context 快照、后续 system 节点、其它插件的 in-history 提示等）现在会被渲染并
  **并入 checkpoint 归档说明**（固定标记 `[memory] 本次归档区间内还有 N 条非对话上下文…已并入本说明以免丢失：`），
  不再出现“从上下文移除但没有归档/不可回忆”的情况；这些内容不会变成回忆文件夹。
  归档说明仍需小于被替换内容，否则跳过本次压缩记 warning（不丢数据）。
  `compress-applied` 遥测新增 `pinnedShadowed` / `pinnedChars`。

#### Fixed

- **本地 fallback 渲染器与引擎渲染器一致性**：fallback 提取为导出的
  `renderRecallBlockFallback(ordered)`；`renderRecallBlock()` 先按 createdAt 排序再试
  `buildRecallBlock()`，仅在其抛错/返回空时走 fallback。新增回归测试断言两者输出
  **逐字节相同**，防止再次出现“fallback 前言永远到不了注入文本”的漂移。
- **图片元数据**：`meta.images` 为新增字段，旧文件夹无该字段时行为与之前完全一致。

#### Tests

- 新增 `test/images.test.mjs`（含路径展开/索引用例）、`test-adapter/recall-tool.test.mjs`
  （图片路径过滤与渲染）、`test-adapter/image-tool.test.mjs`（25）、
  `test-adapter/scoring-rubric.test.mjs`（3）、`test-adapter/recall-render.test.mjs`（3）、
  `test/repair-session-log.test.mjs`（6，多帧 zstd 往返）；
  `test-adapter/plugin-mock.test.mjs` 覆盖 I1/I2/I5/图片路径/记忆查找工具/pinned 合并；
  注入位置与再归档相关旧断言恢复为 `startsRequestSeries: true` 语义；
  `test-adapter/audit-tests-real-api-conformance.test.mjs` 断言 3 个工具、2 个 section、
  pre-step 决策的 `startsRequestSeries` 行为。
- `test/compress.test.mjs`：新增句末切分/整句保留/精确拼接/代理对/拉丁边界 5 例，
  两个依赖旧“裸字符切片”的用例改写为带标点夹具（断言意图不变）。
- 任务区块上限 50+50 的用例改为 64+64 个夹具、断言只列前 50 条；
- 当前基线：**引擎 168/168、适配层 110/110，`node --test` 共 279/279 通过**。

#### Docs

- README：§1.1（句末切分/图片/pinned 合并）、§1.2（α 用户喜好）、§1.3（系统提示词 section +
  `memory_recall`/`memory_image`）、§1.4（再归档/头重写）、§1.7（图片路径提示）、
  §1.8（pinned 合并）、§6 已知限制/日志修复、§7 测试矩阵、§8 English summary、目录结构；
- `docs/SPEC.md`：修订说明、§1/§3（图片与 `meta.images`/`images/index.json`）、§3.1（恢复语义）、
  §4（α 用户喜好）、§4.2（`memory_judge` 逐字 description）、§4.3（`memory_recall`）、
  §4.4（`memory_image`）、§5.4（句末拆分）、§5.5（图片路径/pinned 合并）、§5.6（再归档/头重写）、
  §6.7（注入位置/fallback 镜像/修复工具）、§10 测试矩阵与计数；
- `docs/VERIFICATION.md` §16 更新为最终形态，`docs/PUBLISHING.md` 基线更新；
- 工具：`tools/recall-report.mjs` 新增 `archived images` / `pinned context merged` 两行与
  `workStats.archivedImages/pinnedShadowed/pinnedChars`；`tools/show-recall.mjs` 显示每个 folder
  的归档图片数（`folders[].images` / `summary.images`）。

#### Version

- `package.json` / `engine/package.json` → **1.2.0**（新行为；`config.json` 无新增键，
  旧配置/旧记忆文件夹/旧 recall-state 均向后兼容）。

## [1.1.0] — 2026-10-26

### Added（记忆评分任务增强）

- **复核条目显示完整原文与上次评分理由**：`rescorePending` 的 folder 现在在
  `dsh-rofm:memory-tasks` 区块里附上 `上次评分理由：…`（`meta.judgeReason`，
  无记录时显示 `（无记录）`）和缩进的 `原文：` 段落（该 folder 的完整原文，按
  `role: content` 渲染，不截断）。再归档已经把这条回忆从注入块移除，旧实现只给
  标题/关键词/旧 α/β，模型只能凭标题重判；现在模型能按原文复核。原文不可读时该
  条仍保留并标记 `（原文为空或不可读）`，不会被静默丢弃。
- **任务区块列表上限 6 → 12**：每轮最多列 **12 条待评分新归档 + 12 条待复核**；
  评分口径新增一条“复核条目附带完整原文与上次评分理由”的说明。
- 版本号 **1.1.0**（新行为，向后兼容：`memory_judge` schema 不变，任务区块只是在
  原有行后追加信息）。

### Tests

- `test-adapter/plugin-mock.test.mjs`：`memory-tasks section caps each list at 12
  entries`（14+14 fixtures → 各 12 条）与 `re-review entries quote the full
  original text and the last judge reason`（超出 160 字摘要窗口的尾部标记、上次
  评分理由、损坏 folder 的降级显示）。

### Docs

- README §1.2、`docs/SPEC.md` §4.2 与测试矩阵、`docs/VERIFICATION.md` §15 同步；
  测试基线更新为引擎 119 / 适配层 54（`node --test` 共 174）。

## [1.0.0] — 2026-10-24（updated 2026-10-25 / 本次修订）

首个开源稳定版（first open-source stable release）。2026-10-25 的修订仍属于 1.0.0
（不新开版本号），内容如下。

### Added（本次修订 2026-10-25）

- **`memory_judge` model tool (current-model scoring)**: α, trust β and keywords
  are now judged by the *current session model*, in its own turn and with the
  real conversation in context — never by a separate extra model call during
  archiving. The tool is registered through `ctx.tools.register()` (removed on
  disable) with the documented schema (`updates[]` → `id`, `alpha`, `beta`,
  `keywords`, `keep`, `reason`; output `{updated, kept, rejected}`), clamps
  α/β, validates 3–8 keywords, rejects unknown / cross-session ids per update,
  enforces "a pending memory needs all three values", and writes `meta.json` +
  `index.json` (`scored: true`, sources `llm`, `judgedAt`).
- **Deterministic pending archiving (no model call)**: `agent/pre-step`
  archiving splits/serialises the earliest span, writes folders as
  `scored: false` (`alpha: 0`, `beta: 0`, `keywords: []`, sources `pending`,
  `pendingSince`) and replaces the span with a compaction checkpoint. Until the
  model judges a folder it **never participates in recall** (no match, roll,
  quota or keyword bridge).
- **"记忆评分任务" system-prompt section** (`dsh-rofm:memory-tasks`, order 101):
  lists up to 6 pending new folders (id/title/160-char summary) and 6 folders
  whose recalled copy was re-archived (with current α/β/keywords), plus the
  scoring rubric; empty when there is nothing to do (or a one-line nudge when a
  recall block is present).
- **Recall block re-archiving**: when the context exceeds the trigger again,
  pass 0 first removes the oldest recalled entries from the injected block by
  the same earliest-share rule; because each already has a memory folder **no
  new folder is created** — the folders get `rescorePending: true` for
  re-review through `memory_judge` (or `keep=true`). The v2 recall-state
  snapshot shrinks with the block, a `rearchive` telemetry event is appended,
  and the remaining share continues with normal conversational archiving.
- **β trust metadata on every recall folder / block entry**: model-judged
  `β ∈ [-10, 10]` (clamped, one decimal) written as `meta.beta` +
  `betaSource: "llm"`; heuristic engine/CLI archiving writes `beta: 0` /
  `scored: true`. The recall block preamble now explains the *trust* rubric:
  jokes/exaggeration/irony, later-negated statements, prompt injection or
  suspicious instructions, out-of-context or stale fragments → negative;
  trusted facts/decisions/agreements → positive; 0 = unknown/neutral. β never
  affects the recall probability.
- **Restart memory v2 snapshot**: `recall-state.json` stores the rendered
  `block` plus `additions` with per-memory β and `messages`; after a restart the
  block is restored verbatim through `startsRequestSeries: true` even if the
  memory folders were deleted or moved (legacy v1 id-only state still read).
- **Tools/telemetry**: `show-recall` shows α/β/`scored`/`rescorePending` and the
  pending counts; `recall-report` reports re-archive/pending counts and optional
  β statistics; `compress-applied` records pending `folderMetadata[]`;
  `recall` records `added[].beta`; `rearchive` records `removedIds` /
  `removedTokens` / `targetTokens`.

### Changed（本次修订 2026-10-25）

- Removed `lib/llm-metadata.js` (`LlmMetadataScorer`) and the extra scoring
  model call; removed the now-unused adapter config keys
  `importance.mode`/`llmProvider`/`llmModel`/`llmMaxCharsPerFolder`/
  `llmMaxTotalChars` and `recall.pressureChars` (stale keys in an old
  `config.json` are ignored). The plugin now registers **1 model tool + 2
  system-prompt sections + 3 event listeners**.
- No version bump: `package.json` stays `1.0.0`; plugin-manager descriptions
  (`locale/{zh,en}.json`) and all docs were synchronised with the tool-based
  scoring architecture and the re-archiving rule.

### Fixed（本次修订 2026-10-25）

- Recalled (pinned) memory blocks can no longer grow without bound: they are
  re-archived under the same trigger/percentage rule while keeping exactly one
  folder per memory (only `rescorePending` is set, never a duplicate folder).
- A recalled block no longer vanishes after a restart when the local memory
  folders were deleted/moved (the v2 snapshot contains the block text and the
  messages).

### Fixed（开源前审计加固 2026-10-25）

- **Prototype pollution (security)**: a JSON config key `"__proto__"` was
  dropped and replaced the merged object's prototype instead (`engine/config.js`
  `deepMerge`/`cloneConfig`; the same latent sink existed in the adapter's
  `lib/config-store.js`). Both now store it as an own data key via
  `Object.defineProperty`; unknown keys stay preserved and no prototype is
  changed. Regression tests: `test/audit-engine.test.mjs`,
  `test-adapter/audit-host.test.mjs`.
- **UTF-16 surrogate safety**: splitting an oversized message by
  `targetChunkChars` could cut a surrogate pair in half (mojibake in the recall
  block); the split now keeps the pair together (`engine/compress.js`).
- **`cfg.warnings` unbounded growth**: `computeImportance` re-pushed the same
  high-α warning on every call of a long-lived config (and every plan copy);
  duplicates are now skipped (`engine/importance.js`).
- **CLI argument validation (SPEC §8)**: flags that need a value no longer
  silently become `true` (`--seed`/`--dir`/… now exit 1); `--seed` must be an
  integer in `[0, 4294967295]`; `report --json` keeps working
  (`engine/cli.mjs`).
- **CLI context-window fallback**: `compress` now honours
  `compress.contextWindowTokens` when the conversation JSON carries no host
  window (the SPEC §2 comment was stale in both directions;
  `engine/config.js` comment + SPEC updated).
- **`tools/show-recall.mjs` resilience**: corrupt `index.json`,
  `stats.jsonl` lines, `context.json`, `recall-state.json`, `config.json` or a
  legacy root index no longer crash with raw stack traces (read-only fallbacks:
  in-memory index rebuild from `meta.json`, per-line JSONL skip, per-folder
  `corrupt: true`); a missing option value no longer swallows the next flag
  (`--session --json`).
- **`tools/recall-report.mjs`**: JSON `null` β is no longer counted as β=0 in
  `betaStats` (non-numeric β is ignored, as documented).
- **Test-suite holes**: removed a tautological assertion
  (`test/engine.test.mjs`), added a positive control to the tool-call/result
  pairing test (`test-adapter/plugin-mock.test.mjs`) and a non-empty guard to a
  vacuous `every()` (`test/recall.test.mjs`); added 35 audit tests across
  `test/audit-*.test.mjs`, `test-adapter/audit-*.test.mjs` (strict real-Session
  conformance, public API surface, CLI/tools robustness, prototype pollution).
- No version bump: this hardening revision stays **1.0.0** per the maintainer
  request.

### Changed（开源前审计加固 2026-10-25）

- `package.json`: added `scripts` (`test` = `node --test`, `simulate`, `cli`,
  `check`), `author`, and raised `engines.node` from `>=18` to `>=20` to match
  the CI matrix (Node 18 is EOL); README/SPEC/CONTRIBUTING updated accordingly.
- Open-source hygiene: docs no longer contain machine-specific paths or real
  session ids; `docs/SPEC.md`/`docs/VERIFICATION.md`/`README.md` updated for the
  audit fixes, final test counts (engine 119, adapter 53) and known limitations.
- `package.json` now points at the public repository
  (`repository`/`homepage`/`bugs` → https://github.com/wall1234567/dsh-rofm).

### Fixed（1.0.0 首发）

- **Already-recalled folders no longer starve the first-generation quota**: the
  engine used to know nothing about `recalledIds` (the adapter filtered results
  *after* the BFS), so folders already in the injected recall block still
  competed for the `firstGenMax` slots and spent every attempt on duplicates.
  With a repeated high-frequency keyword, memories archived later could never be
  tried — e.g. 12 folders matching 「部署」 with 10 already recalled produced
  `attempts: 10` on the duplicates and **0** newly injected memories. `recall()`
  now accepts `excludeIds` and the adapter passes the session's `recalledIds`:
  excluded folders are never rolled again and never consume `attempts` or
  `firstGenMax`, but they still act as keyword bridges, so new memories remain
  reachable through old ones. The example now attempts exactly the 2 new folders
  and injects them; a fully-excluded recall attempts 0. Telemetry gains
  `excludedFolders` and the recall log line reports `excluded=N`.
- **Already-recalled folders no longer starve the first-generation quota**: the
  engine used to know nothing about `recalledIds` (the adapter filtered results
  *after* the BFS), so folders already in the injected recall block still
  competed for the `firstGenMax` slots and spent every attempt on duplicates.
  With a repeated high-frequency keyword, memories archived later could never be
  tried — e.g. 12 folders matching 「部署」 with 10 already recalled produced
  `attempts: 10` on the duplicates and **0** newly injected memories. `recall()`
  now accepts `excludeIds` and the adapter passes the session's `recalledIds`:
  excluded folders are never rolled again and never consume `attempts` or
  `firstGenMax`, but they still act as keyword bridges, so new memories remain
  reachable through old ones. The example now attempts exactly the 2 new folders
  and injects them; a fully-excluded recall attempts 0. Telemetry gains
  `excludedFolders` and the recall log line reports `excluded=N`.

## [0.3.0] — 2026-10-23

### Changed

- **Renamed to `dsh-rofm`** (formerly `dsh-memory-recall`): package name, host
  plugin id, Cordis bundle row id, system-prompt section name (`dsh-rofm:recall`),
  CLI/report usage strings, tests and documentation all follow the new name. The
  rename avoids confusion with an unrelated npm package that already used the old
  name. The on-disk `memory/` layout is unchanged.
- **Upgrading from the old name**: remove the `dsh-memory-recall` bundle from the
  DSH profile, then install `dsh-rofm` (same plugin, new identity). Do not run both
  at once — each would archive and recall independently.

## [0.2.4] — 2026-10-23

### Fixed

- **Restart recall ordering (P1)**: the first user message after a DSH restart
  used to overwrite `recall-state.json` with only the new batch, silently
  dropping memories that had been recalled before the restart. The persisted
  block is now restored before the new batch is merged/saved.
- **Config hot reload**: content is compared instead of mtime only, so
  same-tick / same-size saves are picked up; a corrupt or partially written
  `config.json` (or an unreadable path) keeps the last good configuration
  instead of silently resetting every knob; a broken first load now surfaces a
  warning.
- **Pressure-trimmed memories** can be recalled again: dropping an addition also
  drops its id from `recalledIds`.
- **Recall block ordering**: blocks are sorted by folder `createdAt` at render
  time, matching the header's promise across recall batches.
- **`storage.maxFolders`** is enforced: exceeding the cap refuses the whole
  archive (no partial write, no context replacement); the engine and CLI report
  `refused` explicitly.
- **Disable means off**: an in-flight async archival (waiting on the model
  scoring call) now aborts before writing once the plugin row is disposed, and
  the per-session engine cache is evicted on `agent/disposed`.
- **Rollback safety**: memory folders are only rolled back when the
  model-visible surface was not replaced; after a committed replacement they are
  kept (they are the only archive of that span). The marker is now frozen-error
  safe.
- **`tools/recall-report.mjs`** aggregates the per-session telemetry layout by
  default (`memory/sessions/<id>/stats.jsonl` + legacy global file); `--dir`
  still targets one directory.
- **Index hardening**: `.` / `..` folder ids are filtered from index reads and
  writes.
- **`meta.source.seqStart/seqEnd`** stay correct when one huge message is split
  into multiple folders.
- Documentation: removed a stale `agent/turn-stopping` listener claim, corrected
  "no LLM" statements (archiving performs one model call for α/keywords), synced
  SPEC with the implementation.

### Changed

- Local install/development location moved alongside the other local plugins;
  docs no longer contain machine-specific paths.

## [0.2.3] — 2026-10-23

### Fixed

- Resumed main sessions persist `delegationDepth: 0`; those were misclassified
  as subagents after a DSH restart, so `applyToSubagents: false` made
  recall/compression silently stop. Only `origin === "subagent"` or
  `delegationDepth > 0` is treated as a subagent now.

## [0.2.2] — 2026-10-23

### Added

- Complete-content model scoring: a folder is never truncated by default
  (`importance.llmMaxCharsPerFolder: 0`); oversized messages are split into
  ~`targetChunkChars` folders, and scoring batches by `llmMaxTotalChars`.
- Recall-block pressure trimming (`recall.pressureChars`) so the injected block
  cannot accumulate until the context window blows up.

## [0.2.1] — 2026-10-23

### Added

- Restart recovery: injected recall ids are persisted per session
  (`recall-state.json`); the first pre-step / prompt assembly rebuilds and
  re-injects the block without waiting for a new user message.

## [0.2.0] — 2026-10-23

### Added

- **Model-generated α and keywords**: each archival run scores its folders with
  a real `llm` call (3–8 keywords, α within `[importance.min, importance.max]`);
  no heuristic fallback — a failed scoring call aborts the archival.
- **Per-session memory isolation**: `memory/sessions/<session-id>/` holds that
  session's index, telemetry and folders (`storage.perSession: true`).
- Archival runs from `agent/pre-step` (the only place where an async model call
  can still happen before the next model request).

## [0.1.0] — 2026-10-23

### Added

- Initial release: deterministic, zero-dependency memory engine
  (`engine/`), DSH host adapter (`lib/`), compaction-checkpoint archival,
  keyword + α probability recall with generation chain
  (`1×α`, `α·p(n)`, μ=5, σ=3), first-generation cap, standalone CLI, stats report
  tool, and the MIT-licensed plugin bundle.
