# 贡献指南 / Contributing

感谢你愿意改进 `dsh-rofm`。这是一个零依赖的 DSH Host 插件：
`engine/` 是独立的记忆引擎（不 import 任何 `@deepseek-ai/*`），`lib/` 是 DSH 适配层。

## 开发环境

- Node.js ≥ 20（仓库不需要 `npm install`，也没有任何第三方依赖）；
- 运行测试（任选其一）：

```bash
npm test                               # = node --test（引擎 + 适配层 + 模拟），推荐
node --test test/*.test.mjs            # 只跑引擎单元测试
node --test test-adapter/*.test.mjs    # 只跑适配层测试（mock session/context）
node test/simulate.mjs                 # 端到端模拟 + 报告
```

> 仓库零依赖，不需要 `npm install`。Windows 下 `npm test` 可以直接跑；若要手写通配符，
> 请在 Git Bash 里执行（PowerShell 不会展开 `*`）。

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
4. CI 会在 Node 20/22/24 × Linux/Windows 上跑测试，全部通过后合并。

## 提交信息

建议使用 [Conventional Commits](https://www.conventionalcommits.org/) 风格：
`fix: ...`、`feat: ...`、`docs: ...`、`test: ...`、`chore: ...`。

## 安全问题

如果发现可能导致数据丢失/权限越界的问题，请先通过 issue 或私信维护者，
不要直接公开利用细节。

## License

提交代码即表示同意以仓库的 MIT License 发布（见 `LICENSE`）。
