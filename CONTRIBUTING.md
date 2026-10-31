# 贡献指南 / Contributing

感谢你愿意改进 `dsh-rofm`。这是一个零依赖的 DSH Host 插件：
`engine/` 是独立的记忆引擎（不 import 任何 `@deepseek-ai/*`），`lib/` 是 DSH 适配层。

## 开发环境

- Node.js ≥ 20（仓库不需要 `npm install`，也没有任何第三方依赖）；
- 三个平台（Windows / Linux / macOS）都是**一等支持**：路径一律用 `node:path` 组合，
  不要假设 `/` 或 `\`，不要手写 `file://` URL（用 `node:url` 的 `pathToFileURL`/`fileURLToPath`）；
- 运行测试（任选其一）：

```bash
npm test                               # = node --test（引擎 + 适配层 + 模拟），推荐：不依赖 shell 通配符
node --test test/*.test.mjs            # 只跑引擎单元测试（bash/zsh/Git Bash 会展开 *）
node --test test-adapter/*.test.mjs    # 只跑适配层测试（mock session/context）
node test/simulate.mjs                 # 端到端模拟 + 报告
npm run check                          # 测试 + 模拟 + selfcheck + CLI help 一条龙
```

> 仓库零依赖，不需要 `npm install`。**bash / zsh / Git Bash** 下 `node --test test/*.test.mjs`
> 通配符由 shell 展开；**PowerShell / cmd 不展开 `*`**，请用 `npm test` / `npm run check`
> （`node --test` 自己发现 `test/**` 与 `test-adapter/**` 的测试文件），或显式列出文件名。
> Node 不在 `PATH` 时用绝对路径调用即可。

## 三平台开发与测试（v1.3.0）

- **CI 矩阵**：`.github/workflows/ci.yml` 在 `ubuntu-latest` / `windows-latest` / `macos-latest`
  × Node 20/22/24 上跑全部步骤（引擎测试、适配层测试、`test/simulate.mjs`、`node engine/cli.mjs --help`、
  `node tools/selfcheck.mjs`），全部步骤用 `shell: bash`（Windows 上是 Git Bash；macOS 自带的
  bash 3.2 也兼容）。PR 必须让 9 个组合全绿。
- **平台相关行为**（路径分隔符/盘符、符号链接、大小写不敏感文件系统、`~` 展开、`realpath`）优先
  写成不依赖宿主 OS 的测试：可以用 `path.posix` / `path.win32` / 注入的 `platform`、`pathImpl`
  来模拟别的平台（见 `test/portability.test.mjs` 与 `lib/qq-media.js` 的 `validateMediaPath`）。
- **本机无法提供的能力用 `t.skip(原因)` 显式跳过**，不要静默删除用例。当前已知的跳过条件：
  - **Windows 用户无权创建符号链接**时，2 个 symlink 用例（`qq-media.test.mjs` 的 realpath 跟随 /
    symlinked `.staging` 拒绝）会 skip —— Linux/macOS CI 上会真实执行；
  - **Windows 专属**用例（`skip: !isWindows`：正斜杠分隔符、mediaRoots 大小写不敏感）在
    Linux/macOS 上 skip，在 Windows 上执行；
  - **junction 用例**（`compat-autopatch.test.mjs`）：当前用户/平台创建不了 junction 或目录符号
    链接时 skip（POSIX 上 `symlinkSync(..., 'junction')` 退化为普通 symlink，通常仍会执行）；
  - **zstd 会话日志用例**：`node:zlib` 的 zstd 支持需要 Node ≥ 22.15，Node 20 上相关用例 skip。
- **macOS 文件系统默认大小写不敏感**：新增文件/import 路径要注意**大小写精确**。CI 的
  `test/portability.test.mjs` 会做 case-exact import 检查（Windows/macOS 本机可能“碰巧能过”，
  Linux 上才会暴露）。
- **Windows 上不要提交 CRLF**：`.gitattributes` 已把源码/文档固定为 LF，请保留；
  测试也会断言写出的 JSON/JSONL 只有 LF。
- 修改跨平台行为时，请同步更新 README 的「跨平台支持」小节与 `docs/SPEC.md` 的
  「Platform and path contract」。

## 修改约定

- **不要**给 `engine/` 增加依赖，也不要让它 import DSH 包；DSH 相关逻辑只放在 `lib/`；
- 保持 `engine/` 的公开 API 与 `docs/SPEC.md` 一致；行为变化请同步更新 SPEC 与
  `docs/VERIFICATION.md`（或新增验证记录）；
- 崩溃/错误路径必须是可恢复的：坏配置不致命、坏索引可重建、写盘失败不破坏对话；
- 新行为要有测试：引擎/CLI 测试放 `test/`，DSH 适配层测试放 `test-adapter/`；
- 提交前跑一遍全部测试，并确认 `git status` 干净。

## 提交 PR

1. Fork 仓库并从 `main` 拉分支（`fix/...`、`feat/...`）；
2. 说明改了什么、为什么、如何验证（贴测试命令与结果）；
3. PR 描述里关联相关 issue；
4. CI 会在 Node 20/22/24 × Linux/Windows/macOS 上跑测试，全部通过后合并。

## 提交信息

建议使用 [Conventional Commits](https://www.conventionalcommits.org/) 风格：
`fix: ...`、`feat: ...`、`docs: ...`、`test: ...`、`chore: ...`。

## 安全问题

如果发现可能导致数据丢失/权限越界的问题，请先通过 issue 或私信维护者，
不要直接公开利用细节。

## License

提交代码即表示同意以仓库的 MIT License 发布（见 `LICENSE`）。
