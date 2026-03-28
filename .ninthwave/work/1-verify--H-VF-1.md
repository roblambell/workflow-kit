# Feat: Post-merge CI verification state machine and commit polling (H-VF-1)

**Priority:** High
**Source:** Scope reduction plan 2026-03-28
**Depends on:** H-RN-2
**Domain:** verify

Extend the orchestrator state machine to verify that CI passes on main after a PR is merged. Currently, `merged` transitions immediately to `done` (line 662 of orchestrator.ts). Change this to poll CI on the merge commit before declaring done.

New states to add to OrchestratorItemState: `verifying` (polling main CI), `verify-failed` (CI failed on main), `repairing-main` (verifier agent fixing -- wired in H-VF-3).

State transitions:
- `merged` -> `verifying` (when `verifyMain` config is true) or `merged` -> `done` (when false)
- `verifying` + CI passes -> `done`
- `verifying` + CI fails -> `verify-failed`
- `verify-failed` -> `repairing-main` (when verifier launches -- H-VF-3)
- `verify-failed` -> `stuck` (when max verify retries exceeded, default: 2)

Configuration: Add `verifyMain: true` to DEFAULT_CONFIG (opt-out). Add `--no-verify-main` CLI flag to disable.

Track merge commit SHA: After `executeMerge()` succeeds (line 1437), get the merge commit SHA via `gh pr view {prNum} --json mergeCommit --jq .mergeCommit.oid` and store it on the item (add `mergeCommitSha?: string` to OrchestratorItem).

New CI polling function in `core/gh.ts`:
```
checkCommitCI(repoRoot: string, sha: string): "pass" | "fail" | "pending"
```
Uses `gh api repos/{owner}/{repo}/commits/{sha}/check-runs` to get check run statuses. Map to pass/fail/pending using the same logic as existing PR checks (SUCCESS=pass, FAILURE/ERROR/CANCELLED=fail, else pending). Ignore the ninthwave/review status check (from H-RV-1) to avoid self-referential loops.

Update `buildSnapshot()` in orchestrate.ts: items in `verifying` state should not be skipped (currently `done` and `stuck` are skipped at line 240). Add polling for merge commit CI status for items in `verifying` or `verify-failed` states.

Update dependency resolution: items unblock when deps reach `done` (keep current behavior). The `merged` state no longer auto-transitions to `done`, so dependents must wait for `verifying` -> `done`.

**Test plan:**
- Unit test: merged -> verifying transition when verifyMain=true
- Unit test: merged -> done transition when verifyMain=false
- Unit test: verifying -> done when checkCommitCI returns "pass"
- Unit test: verifying -> verify-failed when checkCommitCI returns "fail"
- Unit test: verify-failed -> stuck after maxVerifyRetries exceeded
- Unit test: checkCommitCI parses gh api response correctly (mock gh)
- Unit test: --no-verify-main flag sets verifyMain to false
- Edge case: merge commit SHA retrieval fails gracefully (fall back to done)
- Edge case: checkCommitCI ignores ninthwave/review check to avoid loops

Acceptance: After PR merge, daemon polls CI on main commit before transitioning to done. Items stay in `verifying` until CI passes. Failed CI transitions to `verify-failed`. Max retry circuit breaker transitions to `stuck`. `--no-verify-main` skips verification. Dependency resolution waits for `done` (not `merged`). All tests pass.

Key files: `core/orchestrator.ts:22-38,319,662,1437`, `core/commands/orchestrate.ts:240,1735`, `core/gh.ts`, `core/help.ts`
