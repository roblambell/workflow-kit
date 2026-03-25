# Feat: Worker no-op PR path for TODOs that need no code change (M-DET-6)

**Priority:** Medium
**Source:** Grind cycle 2 observation — workers with no code changes have no clean exit path
**Depends on:** None
**Domain:** detection-latency-auto-rebase

When a worker determines that a TODO requires no code change (already fixed, not applicable, or findings-only), the worker should create a "no-op" PR that only removes the TODO entry from TODOS.md. The PR body should explain why no code change was needed. This keeps the orchestrator's PR-based lifecycle working and provides an audit trail. Update the worker agent prompt (`agents/todo-worker.md`) to explicitly instruct workers that "no code change needed" is a valid outcome with a defined action: create a TODOS.md-only PR with an explanation.

**Test plan:**
- Verify worker agent prompt includes no-op PR instructions
- Manual test: worker processes a TODO that needs no code change and creates a TODOS.md-only PR
- Verify orchestrator correctly handles TODOS.md-only PRs through the merge lifecycle

Acceptance: Worker agent prompt includes explicit instructions for the no-op case. Workers create TODOS.md-only PRs when no code change is needed. PR body explains the rationale. Orchestrator handles these PRs normally. No regression.

Key files: `agents/todo-worker.md`, `core/orchestrator.ts`
