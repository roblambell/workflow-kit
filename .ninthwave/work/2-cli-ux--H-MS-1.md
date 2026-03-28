# Refactor: Consolidate merge strategies to auto/manual (H-MS-1)

**Priority:** High
**Source:** Friction decomposition 2026-03-28, replacing H-TUI-3
**Depends on:** None
**Domain:** cli-ux

Replace the 4 merge strategies (asap/approved/ask/reviewed) with 2 core strategies: auto and manual. This is a type rename + behavior consolidation -- no new functionality.

```typescript
type MergeStrategy = "auto" | "manual"
```

Mapping:
- `asap` + `reviewed` -> `auto`: Orchestrator merges when CI passes (and review completes if review is enabled). Enable GitHub auto-merge on PR.
- `ask` + `approved` -> `manual`: Create PR, never auto-merge. Human must click merge on GitHub.

Changes required:
- Rename `MergeStrategy` type definition in `core/orchestrator.ts:43`
- Rewrite `evaluateMerge()` switch from 4 cases to 2 (auto merges immediately or after review, manual transitions to review-pending)
- Update `MERGE_STRATEGIES` array in `core/interactive.ts:46-62` to show 2 options
- Update `promptMergeStrategy()` in `core/interactive.ts:252-290`
- Update CLI usage string and `parseWatchArgs()` in `core/commands/orchestrate.ts:1853-1855`
- Update `DEFAULT_CONFIG.mergeStrategy` from `"asap"` to `"auto"` in `core/orchestrator.ts:368`
- Update all `mergeStrategy: "asap"` references in test files to `"auto"`
- Update all `mergeStrategy: "ask"` references in test files to `"manual"`
- Remove `"approved"` and `"reviewed"` test cases, replace with equivalent auto/manual tests
- Update analytics tracking in `core/analytics.ts`

**Test plan:**
- Test evaluateMerge() for auto strategy: merges when CI passes, blocks on CHANGES_REQUESTED
- Test evaluateMerge() for manual strategy: never merges, always transitions to review-pending
- Test interactive prompt shows 2 options (auto, manual) with correct descriptions
- Test CLI accepts --merge-strategy auto|manual and rejects old values
- Verify all existing orchestrator tests pass with updated strategy names

Acceptance: `MergeStrategy` type is `"auto" | "manual"`. evaluateMerge() handles both cases. `DEFAULT_CONFIG.mergeStrategy` is `"auto"`. Interactive prompt shows 2 options. CLI accepts `auto|manual`. `bun test test/` passes.

Key files: `core/orchestrator.ts:43,118,368,1308-1400`, `core/interactive.ts:46-62,252-290`, `core/commands/orchestrate.ts:1853-1855,2142`, `core/analytics.ts:63`, `test/orchestrator-unit.test.ts:252-372`, `test/orchestrator.test.ts`, `test/orchestrate.test.ts`
