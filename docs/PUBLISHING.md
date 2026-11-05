# 发布 dsh-rofm（维护者手册）

> **当前版本：1.4.3（2026-11-05）**——`package.json` 与 `engine/package.json` 必须都为 `1.4.3`
> （`tools/release.mjs` 的预检会强制两者一致，并校验 `CHANGELOG.md` 已有 `## [1.4.3]` 段）。
> 1.4.3 是**补丁版**：修复 QQ 渠道兼容下“记忆评分任务”摘要显示原始 JSON 而不是对话正文的缺陷
> （`lib/message-text.js` 新增模型可读渲染层；不改数据格式、无需迁移）。
> **上一发布：1.4.2（2026-11-03，隐私修复 + memory_group_recall）**；1.4.0 / 1.4.1 / 1.5.0 从未单独发布到 npm
> （内容全部并入 1.4.2）。本手册中标注 "v1.4.1 起" 的机制在 1.4.2/1.4.3 继续沿用。

本文件记录把 `dsh-rofm` 发布到 **GitHub** 与 **npm** 的完整流程。
仓库已具备：MIT `LICENSE`、`.gitignore`（忽略 `memory/` 运行时数据与本地噪音）、
`CHANGELOG.md`、GitHub Actions CI（`.github/workflows/ci.yml`），以及一条命令完成发版的
`tools/release.mjs`。

- [1. 一条命令发版（推荐）](#1-一条命令发版推荐)
- [2. 首次环境准备（只做一次）](#2-首次环境准备只做一次)
- [3. 手动发版（备选 / 排障）](#3-手动发版备选--排障)
- [4. 发布前自检清单](#4-发布前自检清单)

## 1. 一条命令发版（推荐）

### 1.1 先写 CHANGELOG

发版前先在 `CHANGELOG.md` 里写好目标版本的段落（脚本不会替你生成发布说明，
它把这一段原样作为 GitHub Release 正文，并用标题里的版本号做校验）：

```md
## [1.4.3] — 2026-11-05

一句话说明本次发布。

### Added

- …
```

> 示例用当前版本 **1.4.3**；下一次发布时把版本号/日期换成目标版本即可（脚本按 `package.json` 的当前版本
> 与 `CHANGELOG.md` 里 `## [<版本>]` 段落做校验，版本是数据、不是写死在脚本里的常量）。

### 1.2 执行

```bash
# 递增补丁版本并发布（--title 会进 commit message 与 GitHub Release 名称）
node tools/release.mjs --bump patch --title "一句话标题" --yes

# 递增次版本（1.4.2 → 1.5.0 即 minor）
node tools/release.mjs --bump minor --title "一句话标题" --yes

# 或者显式指定版本（必须大于当前版本；当前 1.4.2，目标 1.4.3）
node tools/release.mjs --version 1.4.3 --title "一句话标题" --yes

# 先看看会发生什么：跑完所有检查并打印计划，但不改任何东西
node tools/release.mjs --bump patch --title "一句话标题" --dry-run

# 发布中断后继续：只补做未完成的步骤，不会重复提交/重复发布
node tools/release.mjs --resume --yes
```

脚本按顺序执行：

1. **预检**：git 工作区干净、当前分支为 `main`、本地不在 `origin/main` 之后、
   `package.json` 与 `engine/package.json` 版本一致、`CHANGELOG.md` 有目标版本段落、
   tag / npm 版本 / GitHub Release 都不存在（`--resume` 时允许已存在；**v1.4.1 起** `--resume` 会校验
   tag 对应提交里的 `package.json` 版本与待发布版本一致，`--allow-dirty` 也做同样校验）；
2. **检查**：`node --test`、`node test/simulate.mjs`、`node tools/selfcheck.mjs`、
   `node engine/cli.mjs --help`，以及 `npm pack --dry-run` 的文件清单
   （确认包内只有 `memory/.gitkeep`，没有会话数据/测试文件；`--dry-run` 不执行任何网络操作）；
3. **提交 + tag**：同时更新两个 `package.json` 的版本号，提交
   `release: dsh-rofm <版本> — <标题>`，打 annotated tag `v<版本>`；
4. **推送**：`git push origin main` + `git push origin v<版本>`；
5. **npm 发布**：`npm publish`。npm 要求 2FA 时脚本会打印授权链接并自动打开浏览器，
   确认后自动用一次性密码重试发布；npm 的发布处理是异步的，脚本会等 registry 出现该版本；
6. **GitHub Release**：用 tag `v<版本>` 创建 Release，正文取自 CHANGELOG 该版本段落。

### 1.3 参数

| 参数 | 作用 |
| --- | --- |
| `--bump <patch\|minor\|major>` | 在当前版本上递增 |
| `--version <x.y.z>` | 指定目标版本（必须大于当前版本） |
| `--resume` | 续一个中断的发布：只补做未完成的部分 |
| `--dry-run` | 跑完检查并打印计划，不做任何修改 |
| `--yes` / `-y` | 不再交互确认（非交互终端必须加） |
| `--title <text>` | 发布标题（commit message / GitHub Release 名称） |
| `--skip-tests` | 跳过测试与打包检查（不建议） |
| `--skip-npm` / `--skip-github` | 只发其中一端 |
| `--skip-push` | 只提交 + tag，不推送 |
| `--no-browser` | npm 2FA 时只打印链接、不自动打开浏览器 |
| `--otp <code>` | 直接把一次性密码交给 npm（不走浏览器流程） |
| `--allow-dirty` | 允许脏工作区（不建议） |

`npm run release -- <参数>` 等价于 `node tools/release.mjs <参数>`；
`npm run release:status` = `node tools/release.mjs --resume --dry-run`，
用来查看当前版本还剩哪些发布步骤没做。

### 1.4 环境变量

- `GITHUB_TOKEN` / `GH_TOKEN`：创建 GitHub Release 用的 token（`repo`，或
  `Contents: read/write` + Releases 权限）。不设置时脚本从 `git credential fill` 取
  （Windows 上就是 Git Credential Manager 里保存的 GitHub 凭据）；
- `NPM_CLI`：npm 不在 `PATH` 时指向 `npm-cli.js`；DSH 环境常见路径是
  `%USERPROFILE%\.npm-cli\bin\npm-cli.js`；
- `NPM_TOKEN`：覆盖 npm 配置里的 token（一般不需要，脚本会从 `npm config get` 读取）。

### 1.5 常见问题

- **npm 报 EOTP**：脚本会自动进入浏览器授权流程。如果浏览器没有弹出来，用
  `--no-browser` 重跑并按终端打印的 URL 手动确认；也可以 `--otp <一次性密码>` 直接传入。
  npm 只用一次性密码，不要复用旧密码。
- **npm 已返回 202，但 registry 还查不到版本**：npm 发布是异步的（官方提示
  "may take a few minutes"）。脚本已经会轮询最多 6 分钟；超时只是警告，Release 仍会创建，
  过一分钟刷新 npm 页面即可；
- **git push 报 schannel / CRYPT_E_NO_REVOCATION_CHECK**：这是 Windows schannel 的
  证书吊销检查问题。脚本对**出错的那一条命令**自动用 `GIT_SSL_NO_VERIFY=1` 重试并打印警告；
  长期方案是改用 SSH remote（`git@github.com:owner/repo.git`）或修好 Windows 的
  CA/吊销设置；
- **卡在某一步**：修好后 `node tools/release.mjs --resume --yes` 继续即可。已推送的
  commit/tag、已发布的 npm 版本、已创建的 Release 都会被跳过。

## 2. 首次环境准备（只做一次）

1. Node.js ≥ 20（仓库零依赖，不需要 `npm install`）；
2. `git remote -v` 指向 GitHub 仓库（HTTPS 或 SSH 均可）：

   ```bash
   git branch -M main
   git remote add origin git@github.com:<owner>/dsh-rofm.git   # 或 https://...
   git push -u origin main
   ```

3. GitHub 认证（三选一）：SSH key；HTTPS + PAT（用
   `git config --global credential.helper manager` 记住）；或 `GITHUB_TOKEN` 环境变量；
4. npm 认证：`~/.npmrc` 里有 `//registry.npmjs.org/:_authToken`（`npm whoami` 能返回用户名）。
   账号开启 2FA 也没关系：发布时按提示在浏览器确认一次即可；
5. 仓库设置建议：Description「DSH 长期记忆插件：上下文超阈值时归档最早对话，之后按关键词与
   确定性优先级 α 自动回忆（支持时间/事件约束）。」，Topics：`dsh`、`dsh-plugin`、`deepseek-harness`、`memory`、
   `recall`、`long-term-memory`、`context-window`、`compaction`；开启 Issues，
   可选 Discussions / Dependabot。

## 3. 手动发版（备选 / 排障）

`tools/release.mjs` 不可用时（例如受限环境、npm 交互被拦截），可以按下面的步骤手工执行：

1. 更新 `package.json` 与 `engine/package.json` 的 `version`，在 `CHANGELOG.md` 写好对应段落；
2. 跑 `npm test`、`node test/simulate.mjs`、`node tools/selfcheck.mjs`、
   `node engine/cli.mjs --help`、`npm pack --dry-run`；
3. `git add -A && git commit -m "release: dsh-rofm <版本>"`；
4. `git tag -a v<版本> -m "v<版本>" && git push origin main --follow-tags`；
5. `npm publish`（要求 2FA 时按提示完成浏览器确认）；
6. GitHub → Releases → Draft a new release：选 `v<版本>` tag，把 CHANGELOG 对应段落贴进说明；
   GitHub 会自动提供源码 zip/tar。

> 装 `gh` CLI 也可以辅助（`gh release create v<版本> --notes-file <文件>`），
> 但仓库自带脚本不依赖它。

## 4. 发布前自检清单

- [ ] **隐私/config.local 检查（v1.4.1 起强制，v1.4.2 沿用）**：跟踪的 `config.json` 里
  `compat.ownerIds`（QQ 主人号）与 `compat.mediaRoots`（本机 onebot 媒体根路径）必须保持为空 `[]`；
  本机个人值写在 gitignored 的 `config.local.json`（合并顺序 `DEFAULT ← config.json ← config.local.json ←
  row config`），**不要提交**。发布前跑 `node tools/privacy-check.mjs`（失败即停下），并用 `git diff`
  确认没有真实 QQ 号 / 用户目录路径 / 会话 id 进入提交。使用方可自行填写，或用 profile 层
  （`cordis.patch.yml` 的 `config:`）覆盖——覆盖是按字段深合并，见 README §3；
- [ ] 无个人路径/用户名/会话 id/审计记录等隐私内容（当前文件与完整 git 历史）；
- [ ] 无 token / 密码 / 私钥；
- [ ] `LICENSE`、`README`、`CHANGELOG`、`CONTRIBUTING` 齐全；
- [ ] CI 在 Node 20/22/24 × Linux/Windows/macOS（3 OS × 3 Node = 9 个组合）上全绿；
- [ ] 跨平台检查项已过：`test/portability.test.mjs` 全绿、README §2.4「跨平台支持」与
  `docs/SPEC.md` 的 Platform and path contract 与当前代码一致（见 `docs/VERIFICATION.md` §19）；
- [ ] `node tools/selfcheck.mjs` 在本机真实数据上 `0 failed`（历史遗留只允许 WARN）；
- [ ] 若新增/删除测试：已同步 `tools/gate-baseline.json` 的 `minFullSuiteTests`（当前 **1060**；
  e2e-adapter 12 / e2e-real-data 8 不变），且 `node tools/verify-1.4.0.mjs`（历史命名）= **8/8 PASS**；
- [ ] 版本号已在 `package.json`、`engine/package.json`、`CHANGELOG.md`、git tag 四处一致
  （目标 **1.4.3**；前三个 + tag 冲突由脚本强制检查）；
- [ ] `memory/` 只有 `.gitkeep`，`git status` 干净；
- [ ] `npm pack --dry-run` 预演通过，包内只有 `memory/.gitkeep`（无会话数据 / 无测试目录）。

> `node tools/release.mjs --dry-run` 已经覆盖上面「检查」类的大部分条目；
> 隐私/密钥类检查仍需人工过一遍 git 历史。

## 隐私检查（v1.4.1 起强制，v1.4.2 沿用）

发布前必须确认仓库内**没有任何个人信息**（QQ 号、本机绝对路径、昵称、真实会话样本）：

```bash
node tools/privacy-check.mjs
```

- 失败会列出具体问题；`config.json` 的 `compat.ownerIds` / `compat.mediaRoots` 必须为空；
- 个人值放在被 git 忽略的 `config.local.json`，不要提交；
- 测试夹具（`test/fixtures/**`）必须是脱敏样本；不要提交真实会话内容/截图；
- 首次发布前请检查 `git log -S"<你的 QQ 号>"` / `git log -S"<你的用户名>"`：若历史已有泄漏，
  需要重写历史并 force-push（并处理已发布到 npm/GitHub 的旧版本），
  