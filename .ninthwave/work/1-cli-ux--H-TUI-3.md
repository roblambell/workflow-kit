# Refactor: Merge strategy simplification to auto/manual/bypass (H-TUI-3)

**Priority:** High
**Source:** TUI status improvements plan 2026-03-28, refined by CEO review 2026-03-28
**Depends on:** H-TUI-1
**Domain:** cli-ux

Replace the 4 merge strategies (asap/approved/ask/reviewed) with 3 clearer options. All three are first-class values of `MergeStrategy`. Clean cut -- no backwards compatibility aliases.

```typescript
type MergeStrategy = "auto" | "manual" | "bypass"
```

## Strategy definitions

| Strategy | CI | AI Review | Human Review | Orchestrator Action |
|----------|-----|-----------|-------------|---------------------|
| `auto` | must pass | always runs (blocking) | required if branch protection demands | Enable auto-merge on PR |
| `manual` | must pass | always runs (blocking) | n/a (human merges) | Create PR, do nothing else |
| `bypass` | must pass | always runs (blocking) | admin-override (skipped) | Merge with admin override (`gh pr merge --admin`) |

- `auto` (replaces asap + reviewed): enable GitHub auto-merge (existing flow). Orchestrator polls for merge completion. If branch protection requires human review, the PR waits for approval, then GitHub auto-merges once approved.
- `manual` (replaces ask/approved): create PR only, never auto-merge. Human must click merge on GitHub.
- `bypass`: merge with admin override, skipping branch protection human review requirement. CI and AI review still run. Only available when `--dangerously-bypass` CLI flag is passed.

## AI review enforcement

**Behavior change from old `asap`:** AI review now always runs for all strategies.

The orchestrator tracks review completion internally in the state machine:
```
ci-passed → review-pending → review-passed → merge
```

- Merge only happens after orchestrator confirms review passed
- No branch protection configuration needed -- works in any repo
- The `reviewEnabled` config field is removed -- AI review is always on, enforced by the orchestrator regardless of repo branch protection settings

## Stacked PR sequencing (auto mode)

Auto-merge is only enabled on the **next ready PR** in the dependency chain, not all at once:
1. PR1 (base: main) → enable auto-merge immediately
2. PR2 (branched off PR1) → do NOT enable auto-merge yet
3. PR1 merges → GitHub automatically retargets PR2's base to main
4. Orchestrator enables auto-merge on PR2
5. Repeat for PR3, etc.

This ensures correct diff display and merge ordering. Confirm this matches existing behavior and document explicitly.

## Strategy change behavior

Strategy change is forward-only:
- Cycling mid-session only affects future evaluateMerge() calls
- Existing PRs with auto-merge enabled keep it (no per-item strategy snapshotting needed)

## Implementation details

- Remove `reviewEnabled` field from `OrchestratorConfig` -- derived behavior is now "always on"
- Remove `bypassProtection: boolean` from `OrchestratorConfig` -- bypass is a strategy value
- Add `setMergeStrategy()` setter following the `setEffectiveWipLimit()` pattern
- Add `--dangerously-bypass` CLI flag to `cmdWatch()`
- `--dangerously-bypass` makes bypass available as a cycle option in the TUI, doesn't set it as default strategy
- Specify flag storage: `OrchestratorConfig.bypassEnabled: boolean` controls whether bypass appears in the TUI strategy cycle
- evaluateMerge() handles 3 switch cases: auto (enable auto-merge), manual (no merge action), bypass (admin override merge)

**Test plan:**
- Update all `mergeStrategy: "asap"` references to `"auto"` across test files (orchestrator.test.ts, orchestrate.test.ts, analytics.test.ts, daemon-integration.test.ts, telemetry.test.ts, merge-detection.test.ts)
- Rewrite "ask" strategy tests as "manual" strategy tests
- Test evaluateMerge() for all 3 strategies: auto enables auto-merge, manual does nothing, bypass uses admin override
- Test setMergeStrategy() setter changes the strategy and subsequent evaluateMerge uses new strategy
- Test strategy change doesn't retroactively affect existing PRs (forward-only)
- Test `--dangerously-bypass` flag pipeline from CLI → OrchestratorConfig.bypassEnabled → TuiState
- Test AI review enforcement: orchestrator blocks merge until review-passed state reached

Acceptance: `MergeStrategy` type is `"auto" | "manual" | "bypass"`. `evaluateMerge()` handles all 3 cases. AI review is always on, tracked in orchestrator state machine. `reviewEnabled` field removed. `DEFAULT_CONFIG.mergeStrategy` is `"auto"`. Interactive prompt shows 2 options (auto/manual); bypass only shown if `--dangerously-bypass` passed. `--dangerously-bypass` flag parsed in CLI and stored in config. `bun test test/` passes.

Key files: `core/orchestrator.ts:40,106-129,311-325,1114-1198`, `core/interactive.ts:46-62,175-213`, `core/commands/orchestrate.ts:1763,1998`, `skills/work/SKILL.md:115-122`
