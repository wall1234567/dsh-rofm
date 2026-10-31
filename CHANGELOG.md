# Changelog

All notable changes to `dsh-rofm` are documented here.
The project follows a lightweight [SemVer](https://semver.org/) scheme.

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
