# Fix: Clean orphaned worktrees at orchestrator startup and during reconcile (M-REC-1)

**Priority:** Medium
**Source:** Dogfooding observation — stale worktrees accumulate after grind cycles
**Depends on:** None
**Domain:** orchestrator-review-findings

Stale worktrees from previous runs accumulate because neither the orchestrator startup nor `reconcile()` cleans worktrees that have no matching todo file. The orchestrator should clean orphaned worktrees at startup (before launching any workers) so each run starts clean.

Two places need the fix:

1. **Orchestrator startup** (primary): Before the orchestrate loop begins, iterate all `todo-*` directories in the worktree dir. If a worktree's ID has no matching todo file in the todos dir, clean it. This ensures each orchestrator run starts with a clean slate.

2. **Reconcile** (secondary): Add the same orphan check after step 4 in `reconcile()` so that `ninthwave reconcile` also catches orphans when run standalone.

The check is: for each `todo-{ID}` directory in `.worktrees/`, if no `*--{ID}.md` file exists in `.ninthwave/todos/`, the worktree is orphaned and should be removed.

**Test plan:**
- Unit test: orchestrator startup cleans worktrees with no matching todo file
- Unit test: worktree with matching todo file is preserved at startup
- Unit test: reconcile also cleans orphaned worktrees
- Unit test: non-todo worktrees are left alone

Acceptance: Orchestrator cleans orphaned `todo-*` worktrees at startup. Reconcile does the same. `bun test test/` passes.

Key files: `core/commands/orchestrate.ts`, `core/commands/reconcile.ts`, `test/orchestrate.test.ts`, `test/reconcile.test.ts`
