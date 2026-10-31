# 发布 dsh-rofm（维护者手册）

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
## [1.4.0] — 2026-11-01

一句话说明本次发布。

### Added

- …
```

### 1.2 执行

```bash
# 递增补丁版本并发布（--title 会进 commit message 与 GitHub Release 名称）
node tools/release.mjs --bump patch --title "一句话标题" --yes

# 或者显式指定版本
node tools/release.mjs --version 1.4.0 --title "一句话标题" --yes

# 先看看会发生什么：跑完所有检查并打印计划，但不改任何东西
node tools/release.mjs --bump patch --title "一句话标题" --dry-run

# 发布中断后继续：只补做未完成的步骤，不会重复提交/重复发布
node tools/release.mjs --resume --yes
```

脚本按顺序执行：

1. **预检**：git 工作区干净、当前分支为 `main`、本地不在 `origin/main` 之后、
   `package.json` 与 `engine/package.json` 版本一致、`CHANGELOG.md` 有目标版本段落、
   tag / npm 版本 / GitHub Release 都不存在（`--resume` 时允许已存在）；
2. **检查**：`node --test`、`node test/simulate.mjs`、`node tools/selfcheck.mjs`、
   `node engine/cli.mjs --help`，以及 `npm pack --dry-run` 的文件清单
   （确认包内只有 `memory/.gitkeep`，没有会话数据/测试文件）；
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
5. 仓库设置建议：Description「DSH 长期记忆插件：上下文超阈值时归档最早对话，之后按关键词+
   重要性概率自动回忆。」，Topics：`dsh`、`dsh-plugin`、`deepseek-harness`、`memory`、
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

> 装 `gh` CLI 也可以辅助（`gh release create v1.4.0 --notes-file <文件>`），
> 但仓库自带脚本不依赖它。

## 4. 发布前自检清单

- [ ] 无个人路径/用户名/会话 id/审计记录等隐私内容（当前文件与完整 git 历史）；
- [ ] 无 token / 密码 / 私钥；
- [ ] `LICENSE`、`README`、`CHANGELOG`、`CONTRIBUTING` 齐全；
- [ ] CI 在 Node 20/22/24 × Linux/Windows/macOS（3 OS × 3 Node = 9 个组合）上全绿；
- [ ] 跨平台检查项已过：`test/portability.test.mjs` 全绿、README §2.4「跨平台支持」与
  `docs/SPEC.md` 的 Platform and path contract 与当前代码一致（见 `docs/VERIFICATION.md` §19）；
- [ ] `node tools/selfcheck.mjs` 在本机真实数据上 `0 failed`（历史遗留只允许 WARN）；
- [ ] 版本号已在 `package.json`、`engine/package.json`、`CHANGELOG.md`、git tag 四处一致
  （前三个 + tag 冲突由脚本强制检查）；
- [ ] `memory/` 只有 `.gitkeep`，`git status` 干净；
- [ ] `npm pack --dry-run` 预演通过，包内只有 `memory/.gitkeep`（无会话数据 / 无测试目录）。

> `node tools/release.mjs --dry-run` 已经覆盖上面「检查」类的大部分条目；
> 隐私/密钥类检查仍需人工过一遍 git 历史。
