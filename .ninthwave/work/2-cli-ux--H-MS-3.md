# Feat: Add bypass strategy with --dangerously-bypass flag (H-MS-3)

**Priority:** High
**Source:** Friction decomposition 2026-03-28, replacing H-TUI-3
**Depends on:** H-MS-1
**Domain:** cli-ux

Add "bypass" as a third merge strategy. Bypass uses admin override (`gh pr merge --admin`) to skip branch protection human review requirements. CI and AI review still run. Only available when `--dangerously-bypass` CLI flag is passed.

```typescript
type MergeStrategy = "auto" | "manual" | "bypass"
```

Changes:
1. Add `"bypass"` to `MergeStrategy` type (orchestrator.ts:43)
2. Add `evaluateMerge()` case for bypass: merge with admin override, skipping branch protection human review. Use `gh pr merge --admin --squash` via `prMerge()` in core/gh.ts (may need an `admin` option added)
3. Add `bypassEnabled: boolean` to `OrchestratorConfig` (defaults to false). Controls whether bypass appears in TUI strategy cycle (H-TUI-4).
4. Add `--dangerously-bypass` CLI flag to `parseWatchArgs()` in orchestrate.ts. Sets `bypassEnabled: true` on config.
5. Add `setMergeStrategy(strategy: MergeStrategy)` setter on Orchestrator class, following the `setEffectiveWipLimit()` pattern. This allows strategy changes during a running session (used by H-TUI-4's Shift+Tab cycling).
6. Guard: `setMergeStrategy("bypass")` should be rejected if `bypassEnabled` is false.

**Test plan:**
- Test evaluateMerge for bypass: merges with admin override after CI + review pass
- Test bypass blocked when bypassEnabled is false (setMergeStrategy rejects it)
- Test --dangerously-bypass flag sets bypassEnabled on config
- Test setMergeStrategy() changes strategy for subsequent evaluateMerge calls
- Test setMergeStrategy() is forward-only (existing PRs keep their state)
- Test prMerge with admin override flag

Acceptance: `MergeStrategy` type includes `"bypass"`. evaluateMerge handles bypass case with admin override. `--dangerously-bypass` CLI flag sets `bypassEnabled: true`. `setMergeStrategy()` exists and works for runtime strategy changes. Bypass is only settable when `bypassEnabled` is true. `bun test test/` passes.

Key files: `core/orchestrator.ts:43,118,368,1308-1400`, `core/gh.ts:111-124`, `core/commands/orchestrate.ts:1853-1855`, `core/interactive.ts`
