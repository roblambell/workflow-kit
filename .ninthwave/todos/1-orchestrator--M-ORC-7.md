# Fix: Suppress remote branch delete warnings when branch already deleted (M-ORC-7)

**Priority:** Medium
**Source:** Friction log — remote-branch-delete-fails (2026-03-25)
**Depends on:** (none)
**Domain:** orchestrator

After each PR merge, the orchestrator's cleanup code runs `git push origin --delete todo/X`. When GitHub's "auto-delete head branches" setting is enabled (which is common), the branch is already gone and the delete fails with "remote ref does not exist". This produces a noisy warning on every merged item, making logs look like something went wrong.

Fix: In the cleanup code path that deletes remote branches, treat "remote ref does not exist" exit codes / stderr patterns as success (the branch is already cleaned up). Alternatively, check if the remote branch exists before attempting deletion via `git ls-remote --heads origin todo/X` and skip if already gone. The simpler approach (treat specific error as success) is preferred to avoid an extra network round-trip.

**Test plan:**
- Unit test: remote branch delete succeeds → no warning
- Unit test: remote branch delete fails with "remote ref does not exist" → treated as success, no warning
- Unit test: remote branch delete fails with other error (e.g., auth failure) → warning preserved
- Verify existing clean tests still pass

Acceptance: No spurious "Failed to delete remote branch" warnings when GitHub auto-delete is enabled. Genuine deletion failures still produce warnings. All tests pass.

Key files: `core/commands/clean.ts`, `test/clean.test.ts`
