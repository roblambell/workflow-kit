# Feat: Post-merge auto-rebase all sibling PRs via daemon (H-ORC-6)

**Priority:** High
**Source:** Friction #23 — CI churn from TODOS.md conflicts after merges
**Depends on:** H-ORC-5
**Domain:** workspace-lifecycle-daemon-rebase

After a PR merges, `executeMerge` checks sibling PRs for conflicts and sends rebase messages to workers. This causes CI churn — every worker rebases and triggers a new CI run. Replace the post-merge conflict detection loop with proactive daemon-rebase of ALL in-flight sibling PRs:

1. After pulling main, iterate all WIP sibling PRs with PR numbers
2. Try `deps.daemonRebase(worktreePath, branch)` for each
3. On success: continue (CI re-runs on force-pushed branch automatically)
4. On failure: check `checkPrMergeable` — if actually conflicting, send worker rebase message as fallback
5. If not conflicting: skip, no action needed

This eliminates TODOS.md-only conflicts before workers notice, reducing CI runs from N per conflict to 1.

**Test plan:**
- Update post-merge conflict detection tests for daemon-rebase-all behavior
- Test: daemon-rebase succeeds for sibling PRs (no worker message sent)
- Test: daemon-rebase fails, falls back to worker message for conflicting PRs
- Test: non-conflicting PRs skipped after daemon-rebase failure

Acceptance: After each merge, all sibling PRs are daemon-rebased. Worker rebase messages only sent as fallback. `bun test test/` passes.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`
