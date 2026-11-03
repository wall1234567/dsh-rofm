# test/fixtures/memory-snapshot — pinned dsh-rofm e2e fixture

`test/e2e-real-data-readonly.test.mjs` runs the three read-only observer tools
(`memory-audit`, `selfcheck`, `recall-report`) against THIS fixture instead of
the mutable repository `memory/` store. It used to depend on the developer
machine's live memory (and on the 2026-11-01 snapshot numbers), which made the
release gate skip on CI checkouts and fail whenever the live store legitimately
evolved. The fixture makes the test deterministic on every machine.

## Contents (stable test data, NOT a live snapshot)

```
memory/sessions/
├── session-legacy-f908562e/      legacy:   5 folders, all pending (createdAt < 2026-10-27T19:14Z)
├── session-synthetic-a46df597/   synthetic:5 folders + 5 images + recall-state v2 + 8000-token fake-window stats
├── session-current-b5eeee7e/     current:  5 folders, all scored
└── qqb-g-1134030529/             current: 10 folders (8 scored / 2 pending) + recall-state v2 (real QQ channel store)
```

Derived expectations (pinned in the test): 4 stores / 25 folders / 13 scored /
12 pending; era buckets legacy 5, synthetic 5, current 15; current pending 2;
5 archived images; 2 recall-state v2 snapshots.

The `synthetic` store keeps the real fake-window stats evidence
(`windowTokens: 8000`, `beforePercent: 6764.15`) but only 5 folders, which is
below `engine/era.js`'s `stressBacklog >= 100` rule — so its folder entries carry
the engine-supported `pendingEra: "synthetic"` mark (the field
`tools/memory-audit.mjs --apply` writes). This is the documented way to express
per-folder era in a small fixture.

## Provenance and privacy

The fixture was trimmed from quarantined development/test data by the 1.4.1
cleanup step (see `D:\workspace\output\rofm-fix\fixture-sample\README.md` and
`manifest.json` for per-file sizes/hashes). It contains no content of the live
`session-7bc15160` session; the QQ store is the historical 10-folder channel
sample already used by the 1.4.0 acceptance tests.

## Rules

- Tests must treat this tree as **strictly read-only** (the e2e test snapshots
  size+mtime of every file before/after and fails on any change).
- Do not regenerate it from the live `memory/`: it is pinned test data.
  If a fixture change is ever needed, update the pinned numbers in
  `test/e2e-real-data-readonly.test.mjs` in the same change.
