# Daemon and worker race on same worktree during rebase

**Date:** 2026-03-27
**Severity:** High — causes loss of prior work, redundant re-implementation
**Observed during:** Orchestrator restart with existing PR #271 for H-NTF-1

## Symptoms

- H-NTF-1 had an open PR from a prior session (PR #271, code complete)
- `attachWorktree` correctly reused the existing branch
- Daemon detected the PR was behind main and ran `daemon-rebase` (succeeded)
- Worker launched in the same worktree, detected disrupted state, ran `git reset --hard origin/main`
- All prior work from PR #271 was lost; worker started re-implementing from scratch
- TUI showed "Rebasing" while worker was already doing "Writing code"

## Root cause

When an existing branch with an open PR is reused, the orchestrator:
1. Attaches a worktree to the existing branch
2. Launches a worker into that worktree
3. Detects the PR is behind main and runs daemon-rebase

Steps 2 and 3 race — the daemon modifies the worktree (rebase, force-push) while the worker is simultaneously reading/writing in the same directory.

## Fix needed

When reusing a branch with an existing open PR:
- Do NOT launch a worker if the PR is already code-complete
- Instead, transition to `ci-pending` state and let the daemon handle rebase + CI + merge
- Only launch a worker if additional work is needed (e.g., CI failed, review feedback pending)

Alternative: if a worker must be launched, do NOT daemon-rebase — let the worker handle the rebase via `send-message` so there's no concurrent mutation.
