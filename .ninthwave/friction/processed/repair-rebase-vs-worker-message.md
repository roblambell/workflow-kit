# Repair rebase jobs opened instead of messaging existing worker

**Observed:** 2026-03-27
**Context:** strait repo, orchestrating M-V4-1 and M-V4-2 (both touch `src/main.rs`, no dependency relationship, running in parallel)

## What happened

When M-V4-1 merged and M-V4-2 needed to rebase, the orchestrator spawned repair rebase jobs instead of sending a `cmux send` rebase message to the live M-V4-2 worker.

## Issue 1: Orchestrator should message live workers, not spawn repair jobs

The orchestrator never sent a rebase message to the live worker. It went straight to launching repair rebase jobs. Repair jobs are a recovery mechanism — they should only be used when the original worker has exited (e.g., recovering from a previous session or a crashed worker). When the worker is still alive, `cmux send` is the correct approach.

**Proof it works:** Manually sent a `cmux send` rebase message to the M-V4-2 worker — it picked it up and rebased successfully.

## Issue 2: Repair rebase jobs are broken independently

Even setting aside that repair jobs shouldn't have launched here, they also didn't work. The orchestrator kept closing and reopening repair jobs in a loop without ever completing the rebase. This is a separate bug — when repair jobs do launch (in legitimate recovery scenarios), they need to actually succeed.

## Impact

- Live worker never gets told to rebase — sits idle while repair jobs churn
- Repair jobs loop (close/reopen) without completing, burning resources
- Two actors on the same worktree simultaneously causes interference (repair job clobbered the manual rebase attempt)
- Slower turnaround and confusing to observe

## Fix direction

1. **Primary:** When a worker is still alive, `cmux send` a rebase request — don't spawn repair jobs
2. **Separate bug:** Fix repair rebase jobs so they actually complete when they do run (recovery scenarios)
3. **Guard:** Never have two processes (worker + repair, or repair + repair) operating on the same worktree concurrently
