# 发布到 GitHub / 插件市场（维护者手册）

本文件记录把本仓库开源到 GitHub 的操作步骤，以及后续发版的可选动作。
仓库本身已经具备：MIT `LICENSE`、`.gitignore`（忽略 `memory/` 运行时数据与本地噪音）、
`CHANGELOG.md`、GitHub Actions CI（`.github/workflows/ci.yml`）。

> 发布前检查：`npm test`（= `node --test`）、`node test/simulate.mjs` 全部通过
> （当前基线：引擎 188、适配层 113，共 302 个测试）；再跑一次 `node tools/selfcheck.mjs`
> 确认本机真实数据为 0 failed（历史遗留问题只允许 WARN）；`npm pack --dry-run` 的文件清单里
> 没有 `memory/` 运行时数据；`git status` 干净；`memory/` 里只有 `.gitkeep`。

## 1. 认证（三选一）

- **SSH（推荐）**：`ssh-keygen -t ed25519 -C "you@example.com"`，把
  `~/.ssh/id_ed25519.pub` 加到 GitHub → Settings → SSH and GPG keys，然后
  `ssh -T git@github.com` 验证；
- **HTTPS + PAT**：GitHub → Settings → Developer settings → Personal access tokens
  生成有 `repo`（或 `Contents: read/write`）权限的 token，push 时用户名填 GitHub 用户名、
  密码填 token；可用 `git config --global credential.helper manager` 记住；
- **GitHub CLI**：安装 `gh` 后 `gh auth login`，之后可 `gh repo create ... --push`。

## 2. 创建仓库并推送

在 GitHub 网页新建仓库（不要勾选初始化 README/LICENSE/.gitignore），然后：

```bash
cd dsh-rofm
git branch -M main
git remote add origin git@github.com:<你的 GitHub 用户名>/dsh-rofm.git   # 或 https://...
git push -u origin main
```

或者用 GitHub CLI 一步完成：

```bash
gh repo create dsh-rofm --public --source=. --remote=origin --push
```

## 3. 仓库设置（About / Topics）

- Description 建议：`DSH 长期记忆插件：上下文超阈值时归档最早对话，之后按关键词+重要性概率自动回忆。Host-only, zero-dependency engine.`
- Topics 建议：`dsh`、`dsh-plugin`、`deepseek-harness`、`memory`、`recall`、
  `long-term-memory`、`context-window`、`compaction`
- 建议开启 Issues、Discussions（可选）、Secret scanning / Dependabot（可选）。

## 4. 发版（Release）

```bash
git tag -a v1.2.0 -m "v1.2.0"
git push origin v1.2.0
```

然后在 GitHub → Releases → Draft a new release：选 `v1.2.0` tag，
把 `CHANGELOG.md` 对应段落贴进说明；GitHub 会自动提供源码 zip/tar。

## 5. 可选：发布 npm / DSH 插件市场

插件通过 `package.json` 的 `dsh.bundle.patch` 声明自己是 DSH bundle，
`locale/*.json`、`icon.svg` 是插件管理器的显示资源。若要上架 DSH 插件市场/以 npm 分发：

1. 包名 `dsh-rofm` 已确认在 npm 上未被占用（2026-10-23 查询），且开源版已移除
   `"private": true`，可直接 `npm publish`；若想换名或加作用域，先改 `package.json` 的 `name`；
2. `npm publish`（本仓库零依赖，`files` 字段已限定发布内容）；
3. 在市场的索引/提交入口登记仓库地址与包名。

> 注意：`memory/` 是运行时数据，已在 `.gitignore` 中排除；发布包里仅含 `memory/.gitkeep`。

## 6. 发布前自检清单

- [ ] 无个人路径/用户名/会话 id/审计记录等隐私内容（当前文件与完整 git 历史）；
- [ ] 无 token / 密码 / 私钥；
- [ ] `LICENSE`、`README`、`CHANGELOG`、`CONTRIBUTING` 齐全；
- [ ] CI 在 Node 20/22/24 × Linux/Windows 上全绿；
- [ ] `node tools/selfcheck.mjs` 在本机真实数据上 `0 failed`（历史遗留只允许 WARN）；
- [ ] 版本号已在 `package.json`、`engine/package.json`、`CHANGELOG.md`、git tag 四处一致；
- [ ] `memory/` 只有 `.gitkeep`，`git status` 干净；
- [ ] `npm pack --dry-run` 预演通过，包内只有 `memory/.gitkeep`（无会话数据 / 无测试目录）。
