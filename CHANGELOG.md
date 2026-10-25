# Changelog

All notable changes to `dsh-rofm` are documented here.
The project follows a lightweight [SemVer](https://semver.org/) scheme.

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
