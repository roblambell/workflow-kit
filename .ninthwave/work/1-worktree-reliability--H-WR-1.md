# Feat: Post-worktree-create bootstrap hook (H-WR-1)

**Priority:** High
**Source:** Dogfooding friction -- 12 of 18 entries from polyglot monorepo orchestration
**Depends on:** None
**Domain:** worktree-reliability
**Lineage:** 2210237d-f380-469a-be07-5658240ab3dd

Workers launch into worktrees missing npm/pnpm dependencies, Hex packages, and gitignored test config files (e.g. `test.secret.exs`). Pre-commit hooks then fail because the environment is incomplete, forcing workers to bypass hooks with `--no-verify`. Add a convention-based bootstrap hook that ninthwave runs after `git worktree add` and before launching the worker, so projects can install dependencies and copy gitignored files into new worktrees. Also clean stale `.git/worktrees/*/index.lock` files from crashed sessions before worktree operations.

**Test plan:**
- Unit test: bootstrap hook is called after worktree creation with correct args (worktree path, hub root, work item ID)
- Unit test: hook exit non-zero fails launch and returns null (item transitions to stuck)
- Unit test: hook timeout (>5 min) fails launch gracefully
- Unit test: missing hook file is a no-op (backwards compatible)
- Unit test: stale `index.lock` removed before `createWorktree`/`attachWorktree`
- Verify existing launch tests still pass (no regressions)

Acceptance: `.ninthwave/hooks/post-worktree-create` script (if present and executable) runs after `git worktree add` with args `$1=worktreePath $2=hubRoot $3=workItemId`. Exit non-zero aborts launch. 5-minute timeout. Stdout/stderr captured for diagnostics. Missing hook is a silent no-op. `nw init` scaffolds `.ninthwave/hooks/` directory. Stale `index.lock` files cleaned before worktree creation. `agents/implementer.md` documents that bootstrap hook handles dependency installation. `ARCHITECTURE.md` documents the hook convention.

Key files: `core/commands/launch.ts`, `core/commands/init.ts`, `agents/implementer.md`, `ARCHITECTURE.md`
