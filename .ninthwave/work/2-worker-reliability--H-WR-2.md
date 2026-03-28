# Fix: Preserve worktrees on stuck items (H-WR-2)

**Priority:** High
**Source:** Friction: preserve-worktree-on-stuck.md (H-TUI-3 lost work, 2026-03-28)
**Depends on:** None
**Domain:** worker-reliability

When a worker is marked stuck after exhausting retries, the orchestrator cleans up the worktree immediately, destroying any partial work the worker may have done locally but not pushed. This makes manual recovery impossible.

Changes:
1. In `stuckOrRetry()` (orchestrator.ts:869-878): when transitioning to stuck, emit a workspace-close action (kill the CMux session) but NOT a clean action (preserve the worktree directory). Screen capture should still happen for diagnostics.
2. In the final cleanup sweep (orchestrate.ts:961-990): skip worktree removal for items in stuck state. Close workspaces but leave worktree directories intact.
3. Add `nw clean <ID>` subcommand (or extend existing clean command) for manual cleanup of preserved stuck worktrees. This lets users inspect partial work, then clean when done.
4. Update the `nw status` or stuck item display to show the preserved worktree path so users know where to find it.

**Test plan:**
- Test stuckOrRetry() emits workspace-close but NOT clean action when retries exhausted
- Test final cleanup sweep skips worktree removal for stuck items
- Test done items still get full cleanup (worktree removed)
- Test `nw clean <ID>` removes a preserved stuck worktree
- Test screen capture still happens on stuck transition

Acceptance: Stuck items preserve their worktree directory after the orchestrator finishes. Users can inspect partial work at the worktree path. `nw clean <ID>` removes a stuck worktree on demand. Done items still get full automatic cleanup. `bun test test/` passes.

Key files: `core/orchestrator.ts:869-878,1877-1922`, `core/commands/orchestrate.ts:961-990`, `core/commands/clean.ts`
