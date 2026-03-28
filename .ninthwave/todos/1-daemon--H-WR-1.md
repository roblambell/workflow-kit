# Fix: Prevent daemon-worker worktree race on restart with existing PR (H-WR-1)

**Priority:** High
**Source:** Friction log: daemon-worker-worktree-race.md (2026-03-27)
**Depends on:** None
**Domain:** daemon

When the orchestrator restarts and finds an existing open PR (e.g., PR #271 from a prior session), it launches a worker into the worktree AND triggers a daemon-rebase in the same poll cycle. The worker and daemon race on the same directory -- the daemon force-pushes a rebase while the worker is initializing, the worker detects disrupted state, runs `git reset --hard origin/main`, and all prior work is lost. Fix: when reusing a branch with an existing code-complete open PR, transition directly to `ci-pending` without launching a worker. Only launch a worker if additional work is needed (CI failed, review feedback pending). If a worker must launch alongside a needed rebase, send the rebase via `cmux send` to the worker instead of running daemon-rebase concurrently.

**Test plan:**
- Test `executeLaunch` with `existingPrNumber` signal: verify state transitions to `ci-pending` and no AI session is launched
- Test `reconstructState` detects existing open PR and sets `ci-pending` state (not `ready`)
- Test that `daemon-rebase` is NOT triggered in the same cycle as a worker launch for the same item
- Edge case: existing open PR with failing CI -- should launch worker for CI fix, not skip

Acceptance: When an orchestrator restart finds an existing code-complete open PR, the item transitions to `ci-pending` without launching a worker. No concurrent daemon-rebase and worker activity on the same worktree. Existing tests pass. Prior work is preserved on restart.

Key files: `core/commands/start.ts` (launchSingleItem lines 472-487), `core/commands/orchestrate.ts` (reconstructState lines 631-749), `core/orchestrator.ts` (executeLaunch lines 1278-1328)
