## Don't clean up worktrees when items go stuck

**Observed:** H-TUI-3 ran for ~30min twice, then was marked stuck. The orchestrator immediately cleaned up the worktree, destroying any partial work the worker may have done locally but not pushed.

**Root cause:** The orchestrator always cleans worktrees on terminal transitions (stuck, done). When an item is stuck after exhausting retries, the worktree is removed, making manual recovery impossible.

**Fix:** When an item transitions to stuck (not done), preserve the worktree. The human may want to inspect partial work, continue manually, or resume with a new worker on the existing branch. Only clean worktrees on successful completion (done) or explicit user request.
