# 验证记录 / Verification log

本文件记录发布前在真实 DeepSeek Harness（desktop profile）里做过的端到端验证，
以及可以独立复现的测试命令。

> **当前架构见 §13（本次修订，2026-10-25）**：归档不调用模型（新归档以“待评分”落盘），
> 由当前会话模型在“记忆评分任务”区块后调用 `memory_judge` 工具提交 α/β/关键词；
> 被加回的回忆块在后续归档时按同一占比规则再归档（`rescorePending`，不新建 folder）。
> **§2–§12 是历史版本（0.1.x–0.3.0）的验证记录**，其中提到的“归档时额外调用模型打分”
> （`lib/llm-metadata.js`）与 `recall.pressureChars` 压力裁剪等机制已被本次修订取代/移除，
> 仅作历史留档，**不代表当前行为**。
> **v1.2.0 的当前行为与验证数字以 §17 为准**（§1 的数字已同步到 v1.2.0）。

## 1. 自动化测试

下面的命令假设 `node` 在 `PATH` 里；若不在，把 `NODE` 换成你自己的 Node 可执行文件路径即可：

```bash
NODE=node

# 引擎（零依赖、独立于 DSH，含开源前审计回归/会话日志修复工具/自检工具测试）：188 个测试
"$NODE" --test test/*.test.mjs
# ✔ tests 188  pass 188  fail 0

# DSH 适配层（mock session/context，含 memory_judge / memory_recall / memory_image）：113 个测试
"$NODE" --test test-adapter/*.test.mjs
# ✔ tests 113  pass 113  fail 0

# 一次性运行全部（引擎 + 适配层 + 模拟）：302 个测试
npm test

# 独立自检（v1.2 R5；有 FAIL 时退出码 1）
"$NODE" tools/selfcheck.mjs
"$NODE" tools/selfcheck.mjs --with-tests   # 额外跑 node --test

# 端到端模拟 + 测试阶段报告
"$NODE" test/simulate.mjs
"$NODE" tools/recall-report.mjs --help
"$NODE" tools/show-recall.mjs
"$NODE" tools/repair-session-log.mjs --help
```

当前测试数字为引擎 188/188、适配层 113/113（`node --test` 共 302/302，含 1 个
`test/simulate.mjs` 文件；§13/§14/§15 记录了历史功能修订，§16 记录 v1.2，§17 记录 v1.2.0）。

覆盖内容：erf/p(n) 数值、关键词抽取与匹配、α 范围与高 α 警告、压缩触发/20%
选取/保留最近消息/不拆 tool 对/分文件夹、回忆第一代上限、代数链、已尝试排除、
createdAt 排序、损坏 index 重建、原子写、1000 文件夹性能、报告聚合、
pre-step 归档（待评分，不调用模型）、超过 emergency 线后的多轮紧急归档、合成上下文不归档、
β 归一化/回忆块/遥测、未评分不可回忆、`memory_judge` 工具、任务区块、
回忆块再归档（rescorePending）、重启记忆 v2 快照恢复；以及 §14 的开源前审计回归
（原型污染、代理对拆分、CLI 严格参数、工具损坏数据降级、真实 Session 契约等）、
§17 的 v1.2 R1–R5（500 上限 / 100+100 任务区块 / 标题规则 / 注记合并 / pinned 记录策略 /
自检工具）。

## 2. 真实 DSH 端到端验证（2026-10-23）

测试思路：用一个**全新的子代理会话**证明“记忆”确实只存在于 `memory/` 里，
而不是残留在模型上下文中。

测试配置（隔离，仅作用于子代理，主会话关闭）：

```json
"compress": { "triggerPercent": 10, "compressPercent": 30, "contextWindowTokens": 600,
              "minMessagesToCompress": 1, "keepRecentMessages": 1,
              "applyToSubagents": true, "applyToMainSessions": false },
"recall":   { "probabilityScale": 1000, "seed": 7, "applyToSubagents": true,
              "applyToMainSessions": false, "triggerSourceKinds": ["user", "agent-message"] }
```

步骤与结果（最终版代码复跑，2026-10-23 19:32）：

1. 启动子代理 A，提示词里只出现一次秘密：「凤凰计划内部编号是 ZX-42-ALPHA」，
   并要求它只回复「已收到」。
2. A 的回合结束（`agent/turn-stopping`）时上下文占用 **2931.5%**（测试窗口 600），
   插件把最早 30% 归档：生成 **3 个回忆文件夹（α=0.72 / 0.65 / 0.65）**，
   `removedChars=4885`、`keptMessages=2`，并用 compaction checkpoint 事务
   （`compaction/start → compaction/summary → 替换 user/message → compaction/end`）
   把这段从模型上下文替换成一条很短的归档说明。A 的回复「已收到」不含编号。
3. 启动**全新子代理 B**（没有任何关于编号的历史），只给出问题与
   `parent message / self-contained` 等关键词，要求它只凭当前上下文回答编号。
4. 结果：B 的回忆遥测显示 `matchedFolders=2, attempts=3, addedFolders=3`
   （第一代 2 个、第二代 1 个），`addedChars=4885`、`addedPercentOfWindow=207.83%`
   （测试窗口 600 造成的百分比放大），回忆耗时 **1.19 ms**；
   B 的回答是 **ZX-42-ALPHA**，并说明“来自 prior memory recall，没有使用任何文件/搜索工具”。

会话日志层面的直接证据（`$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd`）：

- A 的会话日志含完整 `compaction/start/summary/end`，模型可见 surface 里原始提示词已被
  checkpoint 说明替换（原文只保留在日志的 append-origin 记录中，供界面回看）；
- B 的 `system/message`（surface 第 0 个节点、位于所有对话之前）包含
  `## 记忆回忆…` 区块且含 `ZX-42-ALPHA`；同时 B 的 `user/message` 里都不含该编号 ——
  证明答案只能来自被加回上下文的回忆，也证明“加到最早期 = 系统提示词最前面”；
- 回忆块里的消息已修复为单层 `user:` / `assistant:` 前缀（此前测试发现过 `user: user:`
  重复前缀，已在最终代码中修复并复验）。

这说明：归档 → 清除模型上下文 → 关键词命中 → 按 α/代数概率加回 → 再开始思考，
整条链路在真实 DSH 中工作正常；统计口径（加回比例、加回字数、代数）也写入
`memory/stats.jsonl`，可由 `tools/recall-report.mjs` 复核。

测试结束后已把 `config.json` 恢复为默认值、清空测试期产生的 `memory/` 数据。

## 3. 关闭即停止

- 插件注册 **1 个模型工具（`memory_judge`）+ 2 个 system-prompt sections + 3 个事件监听器**
  （inbox / pre-step / disposed，均为 Cordis effect），没有定时器、子进程或后台任务；
- 在插件管理器中禁用 `dsh-rofm` 行即卸载全部 contribution（工具、两个 section、全部监听器）；
- 已实际执行一次“禁用 → 启用”验证：禁用生效、重新启用后插件恢复 working
  （`fiberPhase=active`）。

## 4. 已知限制 / 尚未验证的部分

- 回忆块是 system-prompt section（system/message），不是 user/assistant 对话消息：
  DSH 重启后会重新组装系统提示词，之前的回忆块不会自动出现在模型上下文中。
  **本次修订起**已注入的回忆会以 **v2 快照**持久化到本会话目录的 `recall-state.json`
  （`version: 2`：渲染好的 `block` 全文 + `additions`（每条回忆的 β 与 `messages` 原文）），
  会话恢复后的第一次 pre-step / prompt section 调用会**原样恢复并重新注入**
  （`startsRequestSeries` 强制重写 head），回忆文件夹被删除也仍能恢复；
  旧 **v1** 只存 ids、恢复仍依赖文件夹在盘（早期版本记录中“重启后回忆块消失”的描述
  对应 ≤1.0.0 的 v1 行为）；
- **待评分记忆不可回忆**：归档只把内容以 `scored:false` 落盘；要等当前会话模型在
  “记忆评分任务”区块后调用 `memory_judge` 提交 α/β/关键词，它才参与回忆。模型不调用时，
  这些记忆会一直列在任务区块里且不可回忆，但内容已安全落盘、不会丢；若 Harness 没有
  `tools` 服务，插件会在启动时记一条警告并**停用自动归档**（保留上下文；已有记忆仍可回忆）；
- 再归档只发生在 pass 0（同一次压力事件的后续 emergency pass 只处理真实对话）；若对应
  memory folder 已被手动删除，该回忆仍会从注入块移除（已无法从磁盘回忆），只记录 warning；
- 归档使用 DSH 的 compaction checkpoint 事件格式；若未来 DSH 修改该事件格式，
  适配层需要跟进。当前 profile 未启用 `compaction-basic`，因此本次真机运行没有经过
  DSH 的 compaction invariant 校验；事件序列按官方 producer 的格式构造，且 mock 测试
  覆盖了该序列（start → summary → replace → end、shadowedSeqs 全覆盖）；
- 真机验证是在**子代理会话**上完成的（测试配置对主会话关闭，避免污染当前对话）；
  主会话与子代理会话走同一套代码路径，主会话路径由 `test-adapter` 的 mock 测试覆盖，
  但没有在主会话上真机触发归档；
- 插件管理器的标题/描述/图标资源已按 DSH 规范导出（`locale/*.json`、`icon.svg`、
  package exports），但没有浏览器截图能力，**Plugins 页面的实际渲染未做视觉验证**；
- `compress.contextWindowTokens > 0` 会强制覆盖宿主窗口（用于小窗口/测试），
  默认 0 表示使用 DSH 上报值。

## 5. 自检中修正的问题（避免“看起来能用”）

- `engine`：回忆结果排序只读顶层 `createdAt`，该字段未写入返回对象，导致按创建时间
  排序在部分路径失效（默认仍按插入顺序）；已补字段并复测；
- `engine`：index 缓存仅比较 mtime，同毫秒写入会偶发读到旧索引；已加入 size 维度并新增
  强制 `reload()`；
- `lib`：归档消息文本重复带 `user:` 前缀；已改为只存正文，由 engine 统一加前缀；
- 文档：安装路径曾写成开发目录；`node --test test/` 在 Node 24 下不能直接跑目录，
  已改为 `node --test test/*.test.mjs`；
- 安装：linked bundle 在 profile 的 bundle 列表里曾丢失一次（reload 后插件不再激活）；
  已重新 `set_bundle` 持久化，并复验一次 profile reload 后仍为 active；
- `lib`：最早一段归档里混入 runtime-context / skill-catalog 等宿主合成 user 消息，
  导致回忆里出现“当前工作目录”这类噪音；已只归档真实 user/assistant/tool 对话；
- `lib`：DeepSeek 适配器为 `systemPromptUpdate: 'in-history'`，后续系统提示词更新会被
  追加到历史中，回忆块不在最前；已在回忆后的 pre-step 返回 `startsRequestSeries: true`，
  强制 DSH 重写 head system 节点，并复验“唯一非空 system 节点 = surface 第 0 个节点”；
- 新增 `compress-applied` 遥测：压缩后用 DSH tokenMeter 再测一次上下文，记录
  before/after tokens 与百分比，便于从 `stats.jsonl` 直接复核“DSH 显示的上下文减少”。

## 6. 多轮真机演示记录（2026-10-23）

完整留档曾保存在本机临时目录（**该临时记录已在 0.2.4 清理测试遗留时删除**，
不随仓库发布；本节保留结论）：

- 7 轮真实多轮对话（星港部署 / 霜火缓存 / 数据库 / 监控 / 安全 / 汇总核对 / 最终核对）；
- 触发 3 次归档（62.715% / 64.578% / 76.655%），生成 5 个回忆文件夹，
  α = 0.63 / 0.53 / 0.75 / 0.75 / 0.70，每个都有 7~8 个关键词；
- DSH tokenMeter 实测：30,662 → 28,483 tokens；下一轮模型请求上下文 30,427 → 22,763
  tokens（-25.2%）；
- 回忆 3 次（3/3、4/4、5 命中加回 3，概率 = α，0.63/0.53/0.75，耗时 0.78ms），
  按文件夹 createdAt 升序注入到 system 第 0 节点，回忆时间 < 请求时间 < 应答时间；
- 独立复核脚本 `verify.mjs`（零依赖）：11/11 项检查全部 PASS；
- 演示配置用 `contextWindowTokens=40000` 模拟窗口（DSH 实际上报 1,048,576），
  其余阈值/比例/概率公式与生产默认一致，详见该次记录中的 REPORT.md（已清理）。

## 7. 主会话真机触发（2026-10-23 20:48，默认配置）

用户主会话在真实默认配置下（`triggerPercent=60`、`contextWindowTokens=0` →
DSH 实际上报窗口 **1,048,576**）触发了一次归档，触发点 `agent/pre-step`：

- 上下文 **62.72%**（657,679 / 1,048,576）→ 归档后 **33.10%**（347,043）；
  provider 实测上下文 655,302 → 326,294（-50.2%）；
- compaction 事务完整，模型可见 surface 出现 `[memory]` checkpoint；
- 记录与独立复核（8/8 PASS）曾保存在本机临时目录
  （**该临时记录已在 0.2.4 清理测试遗留时删除**）。

**这次真机触发暴露并修复了两个真实 bug**（修复后引擎测试 71/71、适配层 10/10）：

1. **回合边界超调**：对齐下一个 user 边界使实际移除 309,560 tokens（47%，远超 20%）。
   修复：`compress.maxBoundaryOvershoot=1.25`——若下一个边界超过目标 1.25 倍，回退到上一个边界；
2. **超大单回合不拆分**：生成 1 个 67 万字的文件夹。修复：`chunkSegments` 对超过
   `targetChunkChars` 的单个 user 回合继续按消息拆分；`compressWithEscalation` 只要仍 >60%
   就继续普通 pass（最多 `maxExtraPasses`），不再只在 >85% 才补。

本 profile 未启用 `compaction-basic`，因此真机运行未经过 DSH compaction invariant 校验。

## 8. 0.2.0 行为变更（α/关键词由模型生成 + 每会话独立目录）

- **α 与关键词改为模型生成**：归档前调用 Host `llm` 服务（默认当前会话 provider/model），
  模型返回 `{alpha, keywords}`；插件校验（α 范围、3~8 个关键词、条数一致），失败重试一次，
  仍失败则**放弃本次归档**（不回退启发式）。因此归档会多一次 LLM 调用。
- **归档只在 `agent/pre-step` 执行**：`turn-stopping` 是同步事件无法等待模型调用；
  pre-step 正好在“下一次思考之前”，同时满足防爆位置。
- **每会话独立回忆文件夹**：`memory/sessions/<session-id>/`，各会话的 index/stats/folders 完全隔离，
  回忆不跨会话；`storage.perSession=true`（默认）。
- **概率函数核对（代码层面）**：
  - `engine/recall.js` 的 `recallProbability(n,μ,σ)` 实现为
    `(1-erf((n-μ)/(σ√2)))/(1-erf((1-μ)/(σ√2)))`，`n<=1` 直接返回 1，与要求公式一致；
  - 第一代概率 = `α × probabilityScale`，第 n 代 = `α × p(n) × probabilityScale`
    （`probabilityScale` 默认 1，仅调试用）；概率被夹到 [0,1]，`roll < probability` 成功；
  - `firstGenMax` 只对第 1 代**成功加回**计数（失败尝试不计数），第 n>1 代无数量上限（`maxGeneration` 可选）；
  - 已尝试/已加回的文件夹不会重复尝试；子代由已加回文件夹的关键词扩展。
  - 结论：与要求一致；唯一“超出要求”的是 `probabilityScale` 调试乘数与 `maxGeneration` 安全阀，默认关闭/为 1。
- 注意：桌面上的两份旧记录（demo / main-session-trigger）产生于 0.1.x：
  当时 α/关键词是启发式、且记忆是全局目录；它们仍可作为“旧行为”证据，但**不代表 0.2.0 的当前行为**
  （记录本体已在 0.2.4 清理测试遗留时删除）。

### 8.1 0.2.0 真机验证（2026-10-23 21:10）

用一个 Team 子会话做隔离真机测试（`applyToMainSessions=false / applyToSubagents=true`、
`contextWindowTokens=5000` 只为快速触发）：第 2 轮 pre-step 触发了归档，模型（真实
`deepseek-account/deepseek-flash`）返回并写入了：

- folder `mem-…-0001`：**α=0.95**，关键词 `星港项目、API端口8080、nginx灰度10%、
  PostgreSQL 16 一主两从、霜火项目、redis maxTotal=64、TTL=300秒、缓存key前缀sr:`
- folder `mem-…-0002`：**α=0.85**，关键词 `星港项目、PostgreSQL 16 一主两从、
  nginx灰度10%、redis maxTotal=64、TTL=300秒、sr: 前缀`
- `meta.importanceSource="llm"`、`keywordsSource="llm"`、`llm={provider,model}` 落盘；
- 记忆目录为 `memory/sessions/beee46bb-…/`（每会话独立）。

测试后已删除该测试会话目录、恢复默认配置。

### 8.2 重启后回忆恢复（2026-10-23 追加）

- 旧版：重启只丢“已注入到模型上下文里的回忆块”，本地回忆文件夹从未丢失；
- 0.2.1：每次注入后把已回忆文件夹 id 写入本会话目录的 `recall-state.json`；
  会话恢复后第一次 pre-step / prompt section 调用会从本地文件夹重建并重新注入
  （`startsRequestSeries` 强制写回 head），**不需要等新用户消息**；
- 测试：`test-adapter` 新增 restart 用例（新建同 id session + 新 plugin 实例，pre-step 后
  回忆块恢复），12/12 通过；若记忆文件夹被删除则跳过对应 id。
  （历史记录：当时 α/关键词由归档时的额外模型调用产生，该机制已被本次修订替换。）

## 9. 0.2.2：完整内容打分 + 回忆块不会累计爆上下文（历史记录）

> 本节记录 0.2.2 的历史行为，**已被本次修订取代**：不再有“归档时模型打分”
> （`lib/llm-metadata.js` 已删除，改为 `memory_judge` 工具 + 待评分）；
> 回忆块不再靠 `recall.pressureChars` 压力裁剪，而是按同一占比规则再归档
> （`rescorePending`，见 §13.4）。以下仅作历史留档。

- **完整内容打分（历史）**：`importance.llmMaxCharsPerFolder=0` 表示发送每个文件夹的**完整**文本；
  `chunkSegments` 会把单条超大消息按字符拆成多个 ~`targetChunkChars` 文件夹，保证文件夹小且完整；
  `llmMaxTotalChars` 只用于分批（超出则多次调用），不再截断任何文件夹。
  测试：`a single message larger than targetChunkChars is split...` 与 `LLM scorer receives the complete folder content`。
- **加回的上下文是否被归档（历史）**：0.2.2 时不会（回忆块 pinned，普通归档不移除它），
  靠硬上限 + `recall.pressureChars` 压力裁剪控制长度。本次修订改为**回忆块也会被再归档**
  （从模型可见上下文移除、只置 `rescorePending` 复核 α/β、不新建 folder），
  见 §13.4 与 README §1.4。
- 结论（历史）：回忆块结构上不可被“归档成文件夹”，但被严格限长并在压力下主动丢弃，
  不会出现“加回上下文累计到爆窗口”的问题。

## 10. 0.2.3：修复“重启后插件静默失效”

- 现象：重启 DSH 后本会话的 recall/compress 都不再触发（stats.jsonl 无新增 recall 事件）。
- 根因：恢复的主会话 header 会持久化 `delegationDepth: 0`；旧判断
  `header.origin === 'subagent' || header.delegationDepth !== undefined`
  把深度 0 的主会话误判成子代理，于是 `applyToSubagents=false` 让它静默跳过。
- 修复：只有 `origin === 'subagent'` 或 `delegationDepth > 0` 才算子代理；
  新增回归测试 `a resumed main session with delegationDepth 0 is still a main session`（15/15 通过）。
- 影响：重启后第一次归档/回忆即可恢复；之前没有任何本地记忆损坏（文件夹一直在磁盘上）。

## 11. 0.2.4：独立审计后的缺陷修复（2026-10-23 晚）

独立审计（静态审阅 + 90 余项独立对抗测试 + 运行态核对）未发现 P0；以下确认为真实缺陷并已修复
（代码修复均有回归测试或独立验证脚本覆盖；当前引擎 76/76、适配层 26/26 通过）：

1. **重启后首条用户消息会丢掉重启前的回忆**（P1，`lib/plugin.js`）：
   `agent/inbox/inserted` 先于任何 pre-step/assemble 触发，旧代码直接 `saveRecallState()`
   用新一批 id 覆盖 `recall-state.json`，`restoreRecallState()` 之后才执行 → 重启前已注入的
   回忆被静默丢弃。修复：inbox 处理先恢复持久化回忆，再合并/落盘新一批。
2. **配置热加载可能漏掉改动**（P2，`lib/config-store.js`）：旧实现只比较 `mtime`；
   同一文件系统时钟 tick 内的两次写入可共享 `mtimeMs`（实测本机 266/300 对快速写入同 mtime），
   且同大小编辑无其他变化。修复：按**文件内容**判断变化（`mtime`/`size` 仅作记录），
   并加回归测试；`touch` 不再触发无意义的引擎重建。
3. **损坏/半写入的 `config.json` 会静默回落默认值**（P2，`lib/config-store.js`）：
   旧实现解析失败即换成内置默认值（并丢 rowConfig、清空引擎缓存，`memoryDir` 也可能回落到全局目录）。
   修复：保留上一次可用配置，文件恢复合法后自动重载。
4. **压力裁剪掉的回忆无法再次回忆**（P2，`lib/plugin.js`）：`trimRecallOnPressure`/
   `trimRecallBlock` 丢弃 additions 时没有从 `recalledIds` 删除 id，与 README“之后还能再次回忆”不符。
   修复：丢弃时同步删除 id。
5. **回忆块跨批次顺序可能与标题不符**（P2，`lib/plugin.js`）：标题承诺 createdAt 升序，
   但每批新回忆被追加在末尾。修复：渲染时按 folder createdAt 排序（id 作为稳定 tie-break）。
6. **`storage.maxFolders` 安全上限从未生效**（P2）：文档写“拒绝再创建”，代码从未读取。
   修复：归档前检查，超限则**整体拒绝**本次归档（绝不做部分写入后再替换上下文），
   引擎 `commitCompression` 也加了兜底拒绝。
7. **禁用插件时仍在途的归档可能继续写盘**（P2，`lib/plugin.js`）：`this.disposed` 是死代码。
   修复：用 `ctx.effect` 注册 dispose 置位，并在模型打分 await 之后、写盘/替换上下文之前检查。
8. **上下文替换成功后的回滚会误删归档**（P2，`lib/compaction.js` + `lib/plugin.js`）：
   旧代码只要 compaction 事务抛错就删除刚写的文件夹（即使替换事件已落地）。修复：只有替换前失败
   才回滚；替换已落地时保留文件夹（错误对象带 `memoryRecallArchiveCommitted` 标记）。
9. **per-session 下 `tools/recall-report.mjs` 默认读错路径**（P2，工具 bug）：
   默认 perSession 后遥测写在 `memory/sessions/<id>/stats.jsonl`，但工具仍读根
   `memory/stats.jsonl` → 默认永远 0 事件。修复：默认聚合所有 session 遥测 + 旧版全局遥测，`--dir` 保持单目录语义。
10. **索引可携带 `.`/`..` id**（P3，`engine/store.js`）：过滤器用的 `SAFE_ID_RE` 允许这两个名字，
    但加载时 `assertSafeId` 会拒绝 → 索引可出现永远加载失败的条目。修复：统一 `isSafeFolderId`。
11. **拆分超大消息时 `meta.source.seqStart/seqEnd` 不准**（P3，`engine/compress.js`）：
    按字符拆分的片段使 `seqEnd = start + 条数 - 1` 失真。修复：chunk 记录真实的消息序号范围。
12. **per-session 引擎缓存不随 agent dispose 释放**（P2，`lib/plugin.js`）：`engines` Map
    以配置版本+目录为键，agent 销毁后不清理。修复：`agent/disposed` 时按 session 驱逐对应引擎。

随后的回归评审又修正了几处 P3（同属 0.2.4）：

13. **配置读取 I/O 错误（EPERM/EISDIR 等）曾回落默认值**（`lib/config-store.js`）：
    old 逻辑把“读失败”等同“文件不存在”，会重置所有配置并清空引擎缓存、`memoryDir` 也可能回落到全局目录。
    现在只有 ENOENT 才按“可选文件缺失”处理，其他 I/O 错误保留上一次可用配置；首次加载坏
    `config.json` 也会把解析错误写进 `cfg.warnings`（插件启动时记录），不再静默。
14. **`storage.maxFolders` 拒绝在引擎/CLI 层是“成功形状”**（`engine/compress.js`/`engine.js`/`cli.mjs`）：
    `commitCompression` 返回 `folders: []`，旧包装仍报 `committed: true`、CLI 打印 “archived 0 folder(s)”。
    现在返回 `refused: true, reason: 'storage.maxFolders'`，`MemoryEngine.compress` 报 `committed: false`，
    CLI 输出 `ok: false` + 明确的拒绝原因。
15. **回滚标记的冻结错误对象隐患**（`lib/compaction.js`）：原先给 error 对象挂属性，
    若 error 被冻结则标记失败、仍可能误回滚已落地的归档。改为模块级 `WeakSet` + `archiveCommitted(error)`
    判断（冻结对象也能作为 WeakSet 键），并补了“替换后失败保留文件夹 / 替换前失败回滚”两条回归测试。
    另：dispose 检查提前到模型打分之前，避免禁用后仍发起一次无意义的打分调用。

审计中记录但**未改**（不影响正确性/属口径问题）：`p(n)` 在 n≥22 因 erf 截断为 0（真实值 <1e-8）；
拆分消息导致文件夹 chars 与 `removeChars` 差一个角色前缀；`addedChars` 不含回忆块标题开销；
关键词抽取在高度重复文本下可能被套话挤占（召回效果风险，非正确性问题）。

## 12. 1.0.0：已加回的记忆不再占用第一代名额（2026-10-24）

**问题**：引擎做 BFS 时不知道插件的 `recalledIds`（插件在结果返回后才过滤），
已加回的文件夹仍参与第一代竞争并计入 `firstGenMax`。复现：12 个文件夹都含关键词「部署」，
其中 10 个已加回、2 个是新的 → 修复前 `attempts = 10` 全花在重复项上，新的 2 条一次都没被尝试，
插件过滤后注入 0 条；用户反复说同一个高频词时，新归档记忆可能长期轮不到第一代。

**修复**：`recall({ ..., excludeIds })`（`MemoryEngine.recall(userText, context, { excludeIds })`），
适配层传入会话的 `state.recalledIds`。被排除的文件夹不再掷骰、不占 `attempts`/`firstGenMax`，
但仍是**透明桥梁**：其关键词继续扩展 BFS 后代，保证“旧记忆 → 新记忆”的可达性。
遥测新增 `excludedFolders`，插件日志追加 `excluded=N`。

**复现验证**（独立脚本，直接 import `engine/index.js`，临时目录）：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 12 个同关键词，10 个已加回 | `attempts=10`，加回 1..10，插件注入 0 条 | `attempts=2`，加回 11、12，注入 2 条；`excludedFolders=10` |
| 12 个全部已加回（反复同词） | 再次加回 10 条重复项 | `attempts=0`、`addedFolders=0`、`excludedFolders=12` |
| 旧记忆 A→B→C→D 链已加回，之后新增 E | E 靠重掷旧链才可能被捞到 | A 作桥梁：E 以第 4 代被加回，旧 A 不被重复加回 |

**测试基线**：引擎 `80/80`、适配层 `27/27`，`test/simulate.mjs` 正常；新增回归用例：

- `test/recall.test.mjs`：excludeIds 不占名额、排除项仍当桥梁、缺省/空排除等价旧行为、全排除时不掷骰；
- `test/engine.test.mjs`：`MemoryEngine.recall` 透传 `excludeIds` 且遥测记录 `excludedFolders`；
- `test-adapter/plugin-mock.test.mjs`：同一关键词的第二条用户消息不再让已注入文件夹参与掷骰
  （`attempts=0`、`excludedFolders>0`、注入块不变、日志含 `excluded=`）。

```bash
node --test test/*.test.mjs            # ✔ tests 80  pass 80  fail 0
node --test test-adapter/*.test.mjs    # ✔ tests 27  pass 27  fail 0
```

## 13. 本次修订：当前模型工具评分 + 回忆块再归档（2026-10-25）

本次修订把 α/β/关键词的产生方式改为**当前会话模型在自己的回合内调用 `memory_judge` 工具**
（归档不调用模型），并让被加回的回忆块也能按同一占比规则再归档。改动范围：
`engine/**`、`lib/**`、`test/**`、`test-adapter/**`；文档/工具/版本：
`README.md`、`docs/SPEC.md`、`docs/VERIFICATION.md`、`CHANGELOG.md`、`tools/**`、`locale/**`、
`package.json`（**版本保持 `1.0.0`，不新开版本号**；`config.json` 由适配层维护）。
本次文档维护**没有** git commit、没有安装插件、没有重启 DSH；插件集成与真机 e2e
由集成方执行（见 §13.3）。

### 13.1 自动化测试（本次真实运行）

> 本小节的 92/45 是 **2026-10-25 功能修订**当时的数字；随后开源前审计又新增了 35 个
> 回归测试（§14），最终数字为引擎 **119** / 适配层 **53**（`node --test` 共 173 个）。

```bash
NODE=node            # 或你自己的 Node 可执行文件路径
cd dsh-rofm          # 本仓库根目录
"$NODE" --test test/*.test.mjs            # ✔ tests 92  pass 92  fail 0（审计后 119）
"$NODE" --test test-adapter/*.test.mjs    # ✔ tests 45  pass 45  fail 0（审计后 53）
"$NODE" test/simulate.mjs                 # exit 0（引擎启发式路径：scored:true、β=0.0）
"$NODE" tools/recall-report.mjs --help    # exit 0
"$NODE" tools/show-recall.mjs             # exit 0（本机无数据也正常退出）
```

新增/更新的用例（真实通过）：

- **引擎（92）**：`indexEntryFromMeta` 保留 `scored`（缺省 true、`false` 保留）与
  `rescorePending`（缺省 false、`true` 保留）并 round-trip；`recall()` 在匹配阶段跳过
  `scored:false`（有关键词也不加回、不掷骰、不占 `firstGenMax`、不作关键词桥梁）；
  旧数据无 `scored` 仍正常回忆；`buildRecallBlock` 新前言逐字（含 β≥7/β<0 与
  玩笑/否定/提示词注入/过时口径）、标题 `β=+3.0 / -2.5 / 0.0`、空 additions → `''`；
  启发式归档 `meta.scored === true`；`normalizeBeta`/`formatBeta`/`added[].beta` 等原覆盖保留。
- **适配层（45）**：`start()` 注册 `memory_judge`（name/description/parameters/output schema，
  经 `ctx.effect` dispose 卸载）；归档落盘为 pending（`scored:false`、α=0、β=0、`keywords:[]`、
  sources=`pending`）且**全程不发生任何 `llm.stream` 调用**（mock 放了一个会抛错的 llm 证明未调用）；
  pending 记忆即使关键词匹配也不被回忆；`memory-tasks` 区块内容/空态/各列表 6 条上限/
  有回忆块时的主动修正提示；`memory_judge` 完整提交后 meta+index 更新（`scored:true`、
  sources=`llm`、`judgedAt`），之后可回忆并出现在回忆块；α/β 夹取、keywords 3~8 校验、
  未知/跨会话 id rejected、keep 语义（对 `rescorePending` 有效、对待评分 rejected）、
  批量部分成功、`engine.reload()` 后可见新值；再归档（最旧优先、folder 数不变、
  `rescorePending` 落盘并出现在“待复核”、recall-state v2 block 收缩、`startsRequestSeries`、
  `rearchive` 遥测、剩余份额继续普通归档、目标被回忆块覆盖时延后普通归档）；
  重启 v2 快照恢复与 v1 兼容。

### 13.2 工具冒烟（本次真实运行，合成数据）

用临时目录里的合成会话（1 个已评分 folder、1 个待评分 folder、1 个待复核 folder、
合成 v2 快照，以及含 `compress-applied`(pending) / `recall`(`added[].beta`) / `rearchive`
的 stats.jsonl）跑：

- `"$NODE" tools/show-recall.mjs --dir <合成目录>`：退出 0；头部显示
  `回忆文件夹: 3 个（已评分 2 / 待评分 1 / 待复核 1）`；待评分 folder 标记 `[待评分]`、
  `关键词: (尚未评分)`、`sources: α=pending keywords=pending β=pending`；待复核 folder 标记
  `[待复核]`；并打印两条提示（1 个待评分需 `memory_judge` / 1 个待复核需复核 α/β）；
  `recall-state.json` 只打印 v2 摘要（`version=2 block=<n> 字 additions=1 条` + 每条
  `gen/α/β/字数/messages`），不会重复打印整块；
- `"$NODE" tools/show-recall.mjs --json --dir <合成目录>`：
  `summary = {"folders":3,"scored":2,"pending":1,"rescorePending":1,"recallable":2}`，
  `folders[].scored/rescorePending/pending/sources` 均存在；`wouldInject` **不含**待评分 folder
  （含已评分与待复核回忆）；
- `"$NODE" tools/recall-report.mjs --dir <合成目录>`：在原有报告后输出
  `re-archive events       : 1, recalled folders removed: 1, tokens: 184` 与
  `pending folders created : 1 (awaiting memory_judge)`，β 行
  `beta (trust)           : n=2, mean=+2.50, β≥7: 1, 0≤β<7: 0, β<0: 1`；
  `--json` 增加 `workStats`（`rearchiveEvents/rearchivedFolders/rearchivedTokens/pendingCreated`）
  与 `betaStats`；
- 无数据冒烟：`"$NODE" tools/recall-report.mjs --help` 退出 0；
  `"$NODE" tools/show-recall.mjs`（本机仅空会话）退出 0。

> 以上为合成数据冒烟，不是真实会话数据；真实会话结果见 §13.3。

### 13.3 真机 e2e（集成方执行，2026-10-25）

证据材料为一次性工作区过程材料，不随仓库发布（本节保留结论）。
插件已以 link 形式安装进 desktop profile（`include:dsh-rofm`，enabled / active）；
测试用临时 config（仅子代理、小窗口 600、trigger 10%）写在插件目录 `config.json`，
测后已恢复默认配置。测试会话名为 `e2e-memory2`（会话 id 略）。

1. **工具注册（当前模型可调用）**：`memory_judge` 已注册为当前模型的工具（工具 schema 出现在
   模型工具列表中，description/parameters 与契约一致）。
2. **归档 = 待评分、不调用模型**：第二次用户消息的 pre-step 触发归档（window=600）：
   `stats.jsonl` 的 `compress-applied.folderMetadata` 为
   `{"alpha":0,"beta":0,"keywords":[],"alphaSource":"pending",...,"scored":false,"pending":true}`；
   `index.json` 中 3 个 folder 均为 `alpha:0, beta:0, keywords:[], scored:false` ——
   没有任何模型调用参与归档。
3. **任务区块 + 当前模型调用工具评分**：下一次请求的 `system/message`（seq=50）包含
   `## 记忆评分任务（dsh-rofm）`、`### 待评分的新归档记忆` 列表与评分口径；
   当前模型（`deepseek-flash`）在**同一会话、当前上下文**中调用
   `memory_judge({"updates":[...]})` 提交 3 条 α/β/keywords（reason 说明依据当前语境），
   tool/result 返回 `已更新 3 条（mem-…-0001、mem-…-0002、mem-…-0003）。`；
   落盘 meta 含 `alpha/beta/scored:true/alphaSource:llm/betaSource:llm/keywordsSource:llm/judgedAt`
   —— 说明工具在真机上拿到 `exec.agent.session` 并正确写入本会话 memory
   （mock 无法证明的接口点已由真机验证）。
4. **回忆注入（带 β 与新语义前言）**：随后用户问“星港项目的接口网关端口和灰度比例”，
   `system/message`（seq=78）包含 `## 记忆回忆` 前言（玩笑/否定/提示词注入…）
   与 `### 回忆 1 · … · α=0.85 · β=+8.0 · 第1代 · 关键词：星港项目、接口网关 8080…`；
   模型回答 **8080，10%**（该信息只存在于已被归档的片段里，当前对话没有，证明来自回忆块）。
5. **被加回的回忆也被归档（同规则、只复评 α/β、不新建 folder）**：同一 pre-step 的 pass 0
   先做再归档：`stats.jsonl` 出现
   `{"type":"rearchive","removedIds":["mem-…-0001"],"removedTokens":184,"targetTokens":6089.7,...}`，
   随后 `compress` / `compress-applied` 记录剩余份额继续普通对话归档；最旧回忆从注入块移除，
   对应 folder `meta.rescorePending:true`（folder 仍只有 1 份、不新建）；`recall-state.json` v2
   的 block 同步收缩（本次移除后 additions=0、blockChars=0）；下一次请求的 system prompt 出现
   `### 待复核的已召回记忆` 列出该 id 与现有 α/β；当前模型再次调用
   `memory_judge({"id":"mem-…-0001","keep":true,"reason":"…现有 α=0.85、β=+8 已合理，无需修改。"})`
   → `rescorePending` 被清除、meta 记录 `judgedAt/judgeReason`。
6. **未覆盖**：没有真正 kill 并重启 DSH 进程（会中断当前会话/团队工作）；重启恢复路径由
   `test-adapter` mock 用例（新 plugin 实例 + 删除文件夹 + v2 快照恢复，断言
   `startsRequestSeries === true`）覆盖同一代码路径。真机上本轮验证了：工具注册/调用、
   待评分归档（无模型调用）、任务区块、模型评分、未评分不可回忆、回忆注入、
   再归档移除与 `rescorePending`、keep 复核清除标记。

### 13.4 归档规则（谁会被归档）

依据契约 §5 与最终实现：

**会被归档的对象**：

- **普通归档** = 模型可见 surface 中**真实对话**的可移除前缀：role ∈ `user`/`assistant`/`tool`；
  `user` 仅限 `source.kind` ∈ `user`/`agent-message`/`team-message`/`user-rpc`；
  只在 `agent/pre-step`、上下文 > `compress.triggerPercent`（默认 60%）、
  消息数 ≥ `minMessagesToCompress`（4）、上下文 ≥ `minContextTokens`（512）时触发；
  按 token 累计取**最早** `compressPercent`（默认 20%，目标值）的已用上下文，向完整 user 回合
  边界对齐（不拆 tool-call/tool-result；下一个 user 边界超过目标 `maxBoundaryOvershoot`（1.25）
  倍则回退上一边界）；最新 `keepRecentMessages`（默认 2）条永不移除；按 `targetChunkChars`
  （约 1200 字）分文件夹（保持完整 user 回合、单条超大消息只在**句子边界**切分、
  <200 字尾块合并、单次 ≤ `maxFoldersPerRun` **500**（v1.2 R1，此前 100））；
  **归档不调用模型**：文件夹以 `scored:false` 待评分落盘，
  由当前模型经 `memory_judge` 评分后才可回忆；然后用 DSH compaction checkpoint 把该段替换成
  一条 `[memory]` 归档说明（模型不再看到原文；日志/界面仍保留原文可回看）；
- **再归档（本次修订新增）** = 被加回的回忆块也参与归档：与普通归档**同触发、同占比**
  （`targetTokens = totalTokens × compressPercent / 100`），按 createdAt 从**最旧**开始把回忆
  从注入块移除（下一次请求的模型可见上下文里消失），**不新建 folder**，只把对应 folder 置
  `rescorePending:true` 进“待复核”，由当前模型用 `memory_judge` 复核 α/β（`keep=true` 表示保持）；
  剩余份额继续普通对话归档；只有 pass 0 做再归档。`recall.maxRecalledBlocks/maxRecalledChars`
  上限仍保留（只丢块、不建/不标记；为避免把整个回忆块清空，最后 1 条无论多大都会保留）。

**不会被归档的对象**：

- system prompt 本身 —— 回忆块是 system-prompt section（role=system，pinned 在 head），
  **普通归档的候选前缀只由真实对话组成，不会把 system 节点当作归档对象**；但若按用户回合
  对齐后的 surface 替换区间恰好跨过中间的历史 system 节点（`surface` 第 0 个节点受 host
  保护、永不替换，其余历史 system 节点 host 允许被 shadow），它们会随该区间一起离开模型可见
  上下文。**再归档规则**则专门处理回忆块：从注入块移除并置 `rescorePending`（不新建 folder）；
- compaction checkpoint 的 `[memory]` 归档说明（`source.kind=compact-checkpoint`）；
- 宿主合成的 user 上下文（runtime-context / skill-catalog / … 等非真实用户来源）；
- 默认子代理会话（`applyToSubagents=false`；打开后按同一规则处理其真实对话）。

**另外**：同一段对话不会归档两次（归档后它已不在 surface 的可移除前缀里，且
`commitCompression` 对同 id 同内容幂等跳过）；再归档也不会重复建 folder（每条回忆只有一个
folder）；`storage.maxFolders` 达到上限时**整次归档被拒绝**（不部分写入、不替换上下文）。

**结论**：回忆块**不会以“再生成新 folder”的方式被重复归档**；本次修订把它改为“从模型可见
上下文移除 + 只复核 α/β（`rescorePending`）”，folder 数量不增加、内容不重复。产生新 folder
的来源仍然是真实对话的可移除前缀。

### 13.5 本次变更的残余风险

- **待评分流程依赖模型主动调用工具**：模型不调用时，新归档会一直 pending、不可回忆
  （任务区块会持续列出，模型有机会补）；这是“α/β 必须结合当前语境”的直接代价，内容本身
  已安全落盘；若 Harness 没有 `tools` 服务，插件会停用自动归档（避免产生永远无法被回忆的
  记忆），并记录警告；
- 再归档只发生在 pass 0；若对应 memory folder 已被手动删除，回忆仍会从注入块移除
  （已无法从磁盘回忆），只记录 warning；剩余份额的普通归档与 emergency pass 逻辑保持原样；
- v2 快照会随注入的回忆量增长（`block` 全文 + `messages` 原文），受
  `recall.maxRecalledChars` 硬上限约束；再归档会同步收缩快照；
- β 是元信息：模型给出的 β 只影响阅读模型的采信建议，**不会**改变回忆概率或名额；
  β 的提示词质量属于效果问题，不是正确性问题；
- 归档仍依赖 DSH compaction checkpoint 事件格式；若未来 DSH 修改该格式，适配层需要跟进。

## 14. 开源前代码 / 测试审计（2026-10-25）

独立审计分三条并行通道：`engine/` + `tools/`、DSH 适配层（`lib/`）、测试套件与
mock 保真度。所有修复都必须先复现、再补回归测试、最后做最小修改；版本号保持
`1.0.0`，不新开版本。

### 14.1 修复的缺陷

| 级别 | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| P2（安全） | `engine/config.js` `deepMerge`/`cloneConfig` | 配置 JSON 的 `"__proto__"` 键被丢弃并替换合并结果的原型（原型污染；违反 SPEC §2 “未知键保留”） | 用 `Object.defineProperty` 写入 `__proto__` 自有属性；嵌套键同样安全 |
| P2（安全） | `lib/config-store.js` `deepMerge`/`clone` | 同上（适配层自己的 merge 实现，配置文件 → 实时配置路径） | 同样的 own-property 写入；新增 `test-adapter/audit-host.test.mjs` |
| P3 | `engine/importance.js` | 长生命周期 `cfg.warnings` 每次 `computeImportance` 重复 push 同一条高 α 警告，无界增长 | 去重后再 push |
| P3 | `engine/compress.js` | 单条超大消息按 `targetChunkChars` 切片时可能切断 UTF-16 代理对（emoji/扩展汉字变乱码） | 切片落在高代理项时补上低代理项 |
| P3 | `engine/cli.mjs` | 缺值 flag（`--seed`/`--dir`/…）静默变成 `true` 并退出 0；`--seed abc` 被忽略 | 仅 `--json` 为布尔 flag，其余缺值抛 `CliError`；`--seed` 校验为 `[0, 2^32-1]` 整数 |
| P3 | `engine/cli.mjs` | CLI 忽略 `compress.contextWindowTokens`（SPEC §2 文档为 CLI 回退） | 窗口优先级：conversation JSON 宿主值 → 配置值回退；同步注释与 SPEC |
| P3 | `tools/show-recall.mjs` | `--session --json` 把 `--json` 当作 session id | 选项值以 `--` 开头视为缺值 |
| P3 | `tools/show-recall.mjs` | 损坏的 index / stats 行 / context / recall-state / config / 旧版根 index 直接抛原始堆栈 | 只读降级：index 用 `scanFolderMetas` 内存重建、逐行跳过坏遥测、单个损坏 folder 标记 `corrupt`、容错读 config/recall-state |
| P3 | `tools/recall-report.mjs` | JSON `null` 的 β 经 `Number(null)` 变成 0 计入 `betaStats`（文档要求忽略非数值） | 仅接受 `typeof === 'number'` 的 β |

### 14.2 新增 / 加固的测试

- `test/audit-engine.test.mjs`（11）：上述 engine/tools 缺陷的 test-first 回归；
- `test/audit-tests-cli-tools.test.mjs`（10）：SPEC §7 公共 API 面、§8 `--seed` 确定性、
  §9 `betaStats`/`workStats` 与 `show-recall` 的 JSON/文本/缺目录/列表模式；
- `test/audit-tests-engine-robustness.test.mjs`（6）：畸形 index（`[]`/`null`/字符串/无 folders）、
  损坏 context、重复 id、空/超长输入、`estimateTokens` 公式与 emoji、关键词边界；
- `test-adapter/audit-tests-real-api-conformance.test.mjs`（5）：严格真实 Session 克隆
  （`surfaceOp`、`sourceEventSeqs`、node-0 保护、已知事件词汇）、合法 compaction 括号与
  token-meter shadow 字段、`memory_judge` ToolDefinition + `output.render`、pre-step
  `startsRequestSeries` 一次性、恶意 session id 不能逃出 `memory/sessions/`；
- `test-adapter/audit-host.test.mjs`（3）：适配层 `deepMerge`/`ConfigStore` 原型污染回归；
- 既有测试加固：删除恒真断言（`test/engine.test.mjs`）、工具对测试补“确实发生压缩”的正控制
  （`test-adapter/plugin-mock.test.mjs`）、空数组 `every()` 前补非空断言（`test/recall.test.mjs`）。

### 14.3 最终验证数字

- `node --test test/*.test.mjs` → **119/119 pass**；
- `node --test test-adapter/*.test.mjs` → **53/53 pass**；
- `npm test`（`node --test`，含 `test/simulate.mjs`）→ **173/173 pass**；
- `node test/simulate.mjs`、`node engine/cli.mjs --help`、`node tools/recall-report.mjs --help`、
  `node tools/show-recall.mjs --json` 均 exit 0；版本保持 `1.0.0`；
- 发布包（`npm pack --dry-run`）不含任何运行时 `memory/` 数据。

### 14.4 审计结论与残余风险

- 三条通道都做了“先复现再修复”；没有未复现的修复。适配层（`lib/`）未发现已证实的功能缺陷，
  只加固了与 engine 同类的原型污染 sink。
- 未覆盖/无法在 CI 覆盖：真实 DSH 宿主启动（契约以从 `app.asar` 提取的真实源码 + 严格
  Session 克隆验证）；`show-recall --live` 的 zstd 会话日志路径；真实 tokenMeter 的
  usage-pricing fold；`systemPrompt` section 的 `context.agent` 运行时约定（公开 d.ts 只声明
  `scope`/`signal`）。以上属于发布说明中应保留的诚实边界。
- 已清扫：无个人路径 / 用户名 / 真实 session id / 密钥；`memory/` 只保留 `.gitkeep`；
  Node 版本要求统一为 `>=20`（与 CI 矩阵一致）；文档中的测试数字与命令已同步。

### 14.5 已知文档 / 实现措辞差异（本次未改行为，仅记录）

- SPEC §5.4 只写“尾部小块并入前一块”，实现还会把开头小错块前移、超大消息拆分产生的
  中间小片段可能独立成块；
- SPEC §4 写 `computeImportance()` 返回 `{alpha, signals}`，实际还返回 `warnings`（正文有提）；
- SPEC §2 “percentages clamped to (0,100]” 与实现“非法值替换为默认值 + warning”措辞可再收紧；
- `storage.indexFile`/`statsFile` 接受 `../` 相对路径 —— 无权限边界（`storage.dir` 本就允许绝对路径），
  仅建议只在手工配置中这样用。

## 15. 1.1.0：任务区块增强（2026-10-26）

### 15.1 变更

- **复核条目（`rescorePending`）显示完整原文与上次评分理由**：`dsh-rofm:memory-tasks`
  区块里每条待复核记忆现在形如：
  ```text
  1. id=mem-… · 标题=… · 现有 α=0.70 β=+4.0 · 关键词=星港、灰度
     上次评分理由：用户当时确认这是玩笑
     原文：
     user: …
     assistant: …
  ```
  `上次评分理由` 来自 `meta.judgeReason`（无记录时显示 `（无记录）`）；`原文` 是该
  folder 的**完整原文**（`memoryFolderReview()` 按 `messageToText` 渲染 role 前缀，
  不截断），原文不可读时保留该条并标记 `（原文为空或不可读）`。
- **列表上限 6/6 → 12/12**：每轮最多列 12 条待评分新归档 + 12 条待复核；评分口径
  新增一条复核说明。
- 版本号 `package.json` / `engine/package.json` = **1.1.0**；`memory_judge` schema
  未变，任务区块只是追加信息（向后兼容）。

### 15.2 验证（本机真实运行）

- `node --test test/*.test.mjs` → **119/119 pass**；
- `node --test test-adapter/*.test.mjs` → **54/54 pass**；
- `npm test`（= `node --test`，含 `test/simulate.mjs`）→ **174/174 pass**；
- 新增/更新用例：
  - `memory-tasks section caps each list at 12 entries`：14 个待评分 + 14 个待复核
    fixture，断言两个列表各只列 12 条；
  - `re-review entries quote the full original text and the last judge reason`：
    原文尾部标记（位于 160 字摘要窗口之外）可见、`上次评分理由：用户当时确认这是玩笑`
    可见、损坏 `context.json` 的 folder 显示 `（原文为空或不可读）` 且工具不崩溃；
- `node test/simulate.mjs`、`node engine/cli.mjs --help`、`node tools/recall-report.mjs --help`、
  `node tools/show-recall.mjs --json` 均 exit 0。

### 15.3 注意

- 复核条目显示完整原文会让任务区块变长（每条约为一个 folder 的原文；folder 目标约
  `compress.targetChunkChars` 默认 1200 字，超大消息按块切分）。12 条时请预留相应
  上下文空间；如需要可在后续版本加一个可配置的原文显示上限。

## 16. v1.2：用户改进与最终形态（2026-10-26 起；注入位置 2026-10-27 回退）

> 本插件在 v1.2 期间试验过“回忆块 = 系统提示词之后的第一条历史消息”，随后按用户要求**回退**到
> 系统提示词 section；早期试验形态曾因漏写 message `id` 使部分会话日志无法加载，已提供
> `tools/repair-session-log.mjs` 修复。下面是最终形态的验证清单。

### 16.1 变更清单与验证点

1. **α 用户喜好**
   - 行为：`memory_judge` description / `alpha` 参数说明 / “记忆评分任务” α 口径三处都包含
     “用户明确表达的喜好/厌恶/习惯/长期偏好 → 高 α”条款（逐字见 SPEC §4.2、README §1.2）。
   - 验证：`node --test test-adapter/scoring-rubric.test.mjs`（3/3）与 plugin-mock 的
     “memory-tasks section lists pending folders … and the rubric”。
2. **句子完整性拆分**
   - 行为：超长消息只在句末/换行切分，跨目标句子整体移动，文件夹可 > `targetChunkChars`；
     拼接与原文逐字一致、不拆代理对。
   - 验证：`node --test test/compress.test.mjs`（25/25）。
3. **回忆块注入位置（回退）**
   - 行为：恢复为 `dsh-rofm:recall` system prompt section（order 100）；注入/恢复/再归档设置
     `forceNewSeries`，`onPreStep` 返回 `startsRequestSeries: true` 触发头节点重写；
     不再写任何 `rofm-recall` 历史消息。
   - 验证：`plugin-mock` 的 “start() registers … two prompt sections” 与
     “recall … before thinking”（断言 `startsRequestSeries` 一次为 true、下一 step 为 undefined）；
     `audit-tests-real-api-conformance` 的 pre-step 用例同样断言 true/undefined。
   - 真实侧：请求的 system prompt 里能看到 `## 记忆回忆（按创建时间从早到晚）` 区块；
     会话日志不应新增 `rofm-recall` 的 user/message。
4. **图片文件夹 + 路径提示**
   - 行为：归档时图片块 → `[图片：（name）]` + `<session>/images/<name>` + `meta.images` +
     `images/index.json`；回忆块与 `memory_recall` 文本把占位符展开成**绝对路径**
     （文件丢失标 `（缺失）`），不再重新上传附件。
   - 验证：`node --test test/images.test.mjs`（含 `injectImagePaths`/索引用例）与 plugin-mock 的
     “I4: archived images are stored as files, shown by path in the recall block, and findable
     via memory_image”（断言文件字节、`meta.images`、索引、块内路径、工具返回路径）。
   - 真实侧：归档后 `ls memory/sessions/<id>/images/` 可见文件；回忆块中应出现
     `[图片：（…，文件：<绝对路径>）]`；用 `read_image` 读该路径可查看。
5. **`memory_recall` 工具**
   - 行为：关键词主动回忆 + 连续未命中 3 次提醒 / 6 次停用到下一轮；结果含 α/β/关键词/原文，
     图片以文件路径列出；不触碰注入块。
   - 验证：`node --test test-adapter/recall-tool.test.mjs`（图片路径过滤/展开、3/6 升级）
     与 plugin-mock 的 “I5: memory_recall recalls by keyword and escalates…”。
6. **`memory_image` 工具**
   - 行为：只读查找归档图片；按 query（记忆关键词/标题/文件名）、memoryId（记忆文件夹 id）、
     name（文件名子串）过滤，返回绝对路径/存在性/元数据/所属记忆；无过滤返回最近归档。
   - 验证：`node --test test-adapter/image-tool.test.mjs`（25/25，覆盖过滤/排序/limit/空态/
     禁用的会话/渲染），以及 plugin-mock I4 里的端到端查找与渲染。
7. **fallback 渲染一致性**
   - 行为：`renderRecallBlockFallback()` 导出；引擎渲染失败时才使用；两者逐字节相同。
   - 验证：`node --test test-adapter/recall-render.test.mjs`（3/3）。
8. **pinned 合并（v1.2 I7；v1.2 R4 已收紧，见 §17）**
   - 行为（v1.2）：压缩替换区间里的 pinned 节点原文并入 checkpoint 归档说明；不变成回忆文件夹；
     说明仍需小于被替换内容，否则跳过压缩。**v1.2 起**只有
     `subagent-settled`/`subagent-error-details`/`tool-jobs`/`user-approval` 等一次性通知
     写入注记附录；runtime-context/time-context/skill-catalog/in-history system 副本
     **不再写入**（宿主会重新注入，静默 shadow、不变成文件夹）。
   - 验证：plugin-mock 的 I7 用例已按 v1.2 R4 更新（附录只含一次性通知、遥测
     `pinnedRecorded`/`pinnedShadowed` 正确、重新注入类内容不出现）。
9. **会话日志修复工具**
   - 行为：只给缺 message `id` 的日志事件补 uuid（不猜 role/source/content），
     支持 `--dry-run`，默认写 `.bak-<时间戳>`，多帧 zstd 原样重编码。
   - 验证：`node --test test/repair-session-log.test.mjs`（6/6，含 plain 与多帧 zstd 往返）。

### 16.2 本次运行结果（v1.2 当时，本机真实执行；v1.2 数字见 §17）

- `node --test test/*.test.mjs` → **168/168 pass**
- `node --test test-adapter/*.test.mjs` → **110/110 pass**
- `npm test`（= `node --test`，含 `test/simulate.mjs`）→ **279/279 pass**
- `node test/simulate.mjs`、`node engine/cli.mjs --help`、`node tools/recall-report.mjs --help`、
  `node tools/show-recall.mjs --json`、`node tools/repair-session-log.mjs --help` 均 exit 0
- `node --check`（lib/*.js）通过；`git diff --check` 干净

### 16.3 兼容性与已知限制

- `config.json` 无新增键；旧配置、旧 `memory/` 文件夹（无 `meta.images`）、旧 v1/v2
  `recall-state.json` 均兼容（无 `images` 的文件夹行为与 1.1.0 完全一致）。
- 没有 `ctx.attachments` 服务的宿主上，归档图片只保留占位文本；回忆/找图仍可用（路径标记缺失）。
- 回忆块回到系统提示词后，任何回忆变化都会让宿主重写头节点（`startsRequestSeries`），
  会失效整段前缀缓存；这是 v1.1 既有行为，不是本次新增。
- v1.2 早期试验写入的无 `id` `rofm-recall` 消息不会自动消失；用
  `tools/repair-session-log.mjs`（先 `--dry-run`）修复后重启 DSH。
- `tools/show-recall.mjs` / `tools/recall-report.mjs` 只展示图片数量/索引信息，不展示图片内容。
- `memory_judge` 成功改动任务列表后触发 `startsRequestSeries` 头节点重写，避免每轮评分追加整份系统提示词。
- `记忆评分任务` 每轮上限：v1.2 期间为 50+50 条（2026-10-27 起；此前各 12 条），
  **v1.2 起为 100+100 条（见 §17，R1）**。待复核条目带完整原文与上次评分理由，
  100 条时区块会明显变长；待评分 100 条约增加上万字符，提交评分后会立即缩短。
- 真实宿主（desktop profile）需要重载插件后才会运行新代码；v1.2 早期历史消息形态的会话在回退后
  不会自动迁移，如需清理用上面的修复工具。

## 17. v1.2.0：R1–R5（2026-10-28）

> 本节是 v1.2.0 的**当前行为**验证记录。§1 的测试数字已同步到本次运行；
> 历史小节（§1–§16）里凡是与本节冲突的，以本节为准。

### 17.1 变更与验证点

1. **R1 上限（500 / 100+100）**
   - 行为：`compress.maxFoldersPerRun` 默认 **500**（`engine/config.js` `DEFAULT_CONFIG`
     与随包 `config.json` 同步，`storage.maxFolders` 仍 10000）；「记忆评分任务」区块
     每轮最多列 **100 条待评分 + 100 条待复核**（`lib/plugin.js` `TASKS_LIST_LIMIT = 100`，
     已导出）。代价：待复核条目每条带完整原文与上次评分理由，满额时区块可能增加数万字符。
   - 验证：`test/engine.test.mjs` / `test/audit-engine.test.mjs` 断言默认值 500；
     `test-adapter/plugin-mock.test.mjs` 的 “memory-tasks section caps each list at 100
     entries”（100+100 夹具只列前 100 条）；`tools/selfcheck.mjs` config/engine 两项
     独立断言 500 与标题唯一性冒烟。
2. **R2 标题规则**
   - 行为：优先取 chunk 内第一条内容非空的用户消息；从回合中间开始的 chunk 在本次归档的
     移除区间里向前继承最近一条用户消息；否则 chunk 首条消息；仍为空则 `第N段对话`；
     最多 24 个 Unicode 码点；同一归档内重复标题加全角 `（<folder 序号>）`，唯一标题不变。
   - 验证：`test/compress.test.mjs` 新增 4 个 R2 用例（中途继承 / 重复编号且唯一标题不变 /
     无用户文本回退 / 既有标题用例保持通过）。
3. **R3 checkpoint 注记合并**
   - 行为：每次归档把替换区间前方本插件旧注记合并为**一条**，N 累加为**累计归档段数**，
     旧注记文本（含附录）丢弃；`buildArchiveNote(plan,{totalSegments})` 支持累计 N
     （不传时输出与旧版逐字节相同）；新增 `parseArchiveNote()`（锚定开头、兼容带/不带关键词、
     容忍附录）；外来 checkpoint 不合并/不改写并阻止区间继续向前扩张；遥测新增
     `mergedCheckpoints` / `archiveSegments`。
   - 验证：`test/compress.test.mjs`（build/parse 用例，含外来文本返回 null 与附录容忍）；
     `test-adapter/plugin-mock.test.mjs` 的 R3 用例（旧注记合并、旧附录丢弃、外来 checkpoint
     终止合并且保持原样、两次真实归档端到端后 surface 只剩一条注记且 N 累计）。
   - 真实数据解析回放：本机 `~/.dsh/sessions` 下 109 份会话日志中，共 24 条
     `compaction/summary` 事件；其中 **23 条是本插件注记，23/23 全部被 `parseArchiveNote`
     正确解析**（含 2 条带 pinned 附录），另 1 条是其它压缩器写的 summary，被正确判定为
     外来 checkpoint（`parseArchiveNote` 返回 `null`，不参与合并/统计）。
4. **R4 pinned 记录策略**
   - 行为：宿主每轮重新注入的 pinned 内容（runtime-context / time-context / skill-catalog /
     in-history `system/message`、`developer/message` 副本 / 遗留 `rofm-recall`）**不写入注记**、
     静默 shadow、永不变成回忆文件夹；`subagent-settled` / `subagent-error-details` /
     `tool-jobs` / `user-approval` 只记录**本次归档事务 shadow 到**的；未知来源按记录处理；
     外来 checkpoint 不合并/不改写。附录固定标记改为
     `[memory] 本次归档区间内还有 N 条非对话上下文（子代理/后台任务/审批等一次性通知，宿主不会重新注入），已并入本说明以免丢失：`。
   - 验证：`test-adapter/plugin-mock.test.mjs` 的 R4 用例（重新注入类 pinned 不出现于注记、
     四类一次性通知只来自本次事务、附录标记文本、`pinnedRecorded` 遥测）；
     `lib/surface.js` 的 `classifyPinnedMessage` / `shouldRecordPinned` 为纯函数，
     由上述用例覆盖。
5. **R5 自检工具**
   - 行为：新增 `tools/selfcheck.mjs`（零依赖、不 import `lib/plugin.js`）与 npm script
     `selfcheck`；检查 config / engine 默认值 + `planCompression` 冒烟 / memory store /
     recall state / 会话日志注记（zstd 解帧重放 `surfaceOp`）/ 可选 `node --test`；
     每项 PASS / WARN / FAIL，**有 FAIL 才退出 1**。
   - 验证：`test/selfcheck.test.mjs`（13 个用例，黑盒 spawn 工具，覆盖 `--json`、
    `--memory-dir`/`--sessions-dir`、退出码与 PASS/WARN/FAIL 判定）。
   - 真实数据运行（本机）：默认 4 passed / 1 warnings / 0 failed，退出码 0；
     WARN 是**旧版本遗留**（session-f908562e 的最终 surface 上仍有 2 条 v1.2 之前的注记、
     旧注记附录里含重新注入类内容），按设计只报 WARN、不算 FAIL。
     `--with-tests` 时 5 passed / 1 warnings / 0 failed，测试套件项输出
     `node --test passed (302 passed, 0 failed)`。

### 17.2 本次运行结果（本机真实执行）

```bash
# 引擎（含 tools/selfcheck.mjs 的测试）：188/188 pass
"$NODE" --test test/*.test.mjs
# 适配层：113/113 pass
"$NODE" --test test-adapter/*.test.mjs
# 全部（引擎 + 适配层 + test/simulate.mjs）：302/302 pass
"$NODE" --test

# 自检工具（真实 memory/ 与历史会话日志）
"$NODE" tools/selfcheck.mjs
#   [PASS] config / engine / memory store / recall state
#   [WARN] session logs — 3 legacy warning(s)（旧版遗留）
#   selfcheck: 4 passed, 1 warnings, 0 failed   (exit 0)
"$NODE" tools/selfcheck.mjs --with-tests
#   [PASS] test suite — node --test passed (302 passed, 0 failed)
#   selfcheck: 5 passed, 1 warnings, 0 failed   (exit 0)

"$NODE" test/simulate.mjs
"$NODE" engine/cli.mjs --help
"$NODE" tools/recall-report.mjs --help
"$NODE" tools/show-recall.mjs --json
"$NODE" tools/repair-session-log.mjs --help
# 均 exit 0
```

### 17.3 兼容性与已知限制（v1.2）

- `config.json` **无新增键**；旧配置、旧记忆文件夹（无 `meta.images`/旧 note 格式）、
  旧 v1/v2 `recall-state.json`、旧会话日志均向后兼容。
- **旧版本遗留的多条注记不会被自动改写**：v1.2 只在新的归档发生时把旧注记自然合并；
  历史会话里已有的多条 `[memory]` 注记/含重新注入内容的旧附录保持原样
  （`tools/selfcheck.mjs` 报 WARN 而非 FAIL）。新会话/新归档会收敛到一条累计注记。
- **注记合并只在向后扩张安全时发生**：遇到外来 checkpoint、未知 pinned 或真实对话节点就停止，
  因此不是“每次都会合并”；没有旧注记可合时 N 仍是本次 folder 数（行为与旧版一致）。
- **任务区块变大**：100+100 上限下，满额待复核（每条完整原文+上次评分理由）可能给每轮
  上下文增加数万字符；提交评分后会立刻缩短，建议一次多提交几条。
- 标题去重只作用于**同一次归档**；不同归档之间的同名标题不会互相加序号。

## 18. v1.2.1 补丁：高 α 警告真正落地（2026-10-28）

> 本节是 1.2.1 的验证记录；测试数字以本节为准（**304/304**）。

### 18.1 修复内容

- 引擎 `importance.warnAbove` 警告此前只进 `plan.warnings`，DSH 适配层从不写日志/遥测 →
  `lib/plugin.js compressOnce()` 现在把 plan 中的新警告（排除启动时已打印的配置警告）以
  `archive: …` 写入宿主日志，并把 `warnings` 数组写进 `compress-applied` 遥测；
- `memory_judge` 提交 α > `importance.warnAbove`（默认 0.8）时**仍按提交值生效**（不是上限），
  但返回值新增 `warnings: string[]`，render 后模型看到「注意：α=… 超过 importance.warnAbove=…」提醒；
- README/SPEC 修正 `α > warnAbove` 的表述（补默认值 0.8 与警告可见位置：插件日志 /
  `compress-applied.warnings` / `memory_judge` 返回值）。

### 18.2 验证结果

- `node --test` → **304/304**（引擎 188 + 适配层 115 + simulate 1）；
- 新增用例：`memory_judge` 对 α=0.95 返回提醒且 α 保留 0.95、α=0.5 无提醒；归档时引擎警告
  出现在宿主日志与 `compress-applied.warnings`；
- `node tools/selfcheck.mjs` → 5 passed / 0 failed；
- CI：Node 20/22/24 × Ubuntu/Windows 全绿。
