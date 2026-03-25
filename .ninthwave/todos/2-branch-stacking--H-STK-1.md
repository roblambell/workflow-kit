# Feat: rebaseOnto() and createWorktree() startPoint param (H-STK-1)

**Priority:** High
**Source:** Stacked branches plan (eng-reviewed 2026-03-25)
**Depends on:** None
**Domain:** branch-stacking

Add `rebaseOnto(worktreePath, newBase, oldBase, branch)` to `core/git.ts` — a squash-merge-safe rebase using `git rebase --onto`. This replays only the dependent's commits onto a new base, avoiding duplicate commits when the dependency was squash-merged. Also extend `createWorktree()` with an optional `startPoint` parameter (default `"HEAD"`) so worktrees can be created from a dependency branch instead of main.

**Test plan:**
- Test `rebaseOnto()` success path: create a real git repo with branches A and B (B stacked on A), squash-merge A to main, verify `rebaseOnto("main", "todo/A", "todo/B")` replays only B's commits
- Test `rebaseOnto()` conflict: introduce a conflicting change, verify returns `false` and aborts the rebase cleanly (no `.git/rebase-apply` left over)
- Test `createWorktree()` with `startPoint`: verify the new branch starts from the specified commit, not HEAD

Acceptance: `rebaseOnto()` correctly handles squash merge scenarios (no duplicate commits). Returns `true` on success, `false` on conflict with clean abort. `createWorktree()` backward-compatible (existing callers unchanged). All existing `git.test.ts` tests still pass. New tests cover success, conflict, and squash-merge scenarios.

Key files: `core/git.ts`, `test/git.test.ts`
