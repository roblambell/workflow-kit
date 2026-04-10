# Refactor: Per-run CI fail counter with lifetime total (H-CF-8)

**Priority:** High
**Source:** Dogfooding -- inflated ciFailCount persists across daemon restarts, causing items to immediately re-stuck
**Depends on:** H-CF-7
**Domain:** orchestrator-ci

**Lineage:** 2a80eccd-3f78-4dce-b26e-a1382cf91bd2

Currently `ciFailCount` is restored from saved daemon state during reconstruction (`core/reconstruct.ts:245`). This means items that exhausted their CI retry budget in a previous session immediately hit the circuit breaker on restart, even if the underlying issue has been fixed. Change the design so the circuit breaker is per-run: stop restoring `ciFailCount` during reconstruction (it starts at 0 each session). Add a separate `ciFailCountTotal` field that accumulates over the item's lifetime and IS persisted, for observability. Increment `ciFailCountTotal` alongside `ciFailCount` at each CI failure site.

Changes:
1. Add `ciFailCountTotal: number` to `OrchestratorItem` in `core/orchestrator-types.ts` (default 0)
2. Add `ciFailCountTotal: number` to `DaemonStateItem` in `core/daemon.ts`
3. At each `ciFailCount++` site in `core/orchestrator.ts` (~4 sites), also increment `item.ciFailCountTotal++`
4. In `core/reconstruct.ts:245`: restore `ciFailCountTotal` from saved state but do NOT restore `ciFailCount` (remove or skip that line)
5. In `core/daemon.ts` serialization: persist `ciFailCountTotal`
6. In `core/analytics.ts` / status rendering: expose `ciFailCountTotal` where `ciFailCount` is shown for diagnostics

**Test plan:**
- Add reconstruction test: item with saved `ciFailCount: 6` reconstructs with `ciFailCount: 0` and `ciFailCountTotal: 6`
- Add test: circuit breaker uses per-run `ciFailCount` (not total) -- item with high total but low per-run count does NOT go stuck
- Update existing reconstruction tests in `test/orchestrate.test.ts:2102` that expect ciFailCount to be restored
- Verify `nw retry` still resets both counters to 0

Acceptance: `ciFailCount` starts at 0 on every daemon session. `ciFailCountTotal` accumulates across sessions and is persisted/restored. The circuit breaker (`ciFailCount > maxCiRetries`) operates on the per-run counter. Status display shows both counters. All tests pass.

Key files: `core/orchestrator-types.ts:52`, `core/daemon.ts:41`, `core/reconstruct.ts:245`, `core/orchestrator.ts:964`
