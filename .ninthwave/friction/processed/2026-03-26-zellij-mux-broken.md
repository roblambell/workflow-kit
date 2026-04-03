# Zellij multiplexer integration completely broken (2026-03-26)

## What happened
1. Ran `ninthwave orchestrate --mux zellij` outside a zellij session → orchestrator launched all 4 workers, all failed with "cmux launch failed" (wrong mux name in error), went to stuck state. Wasted 20+ minutes before user noticed.
2. Started a zellij session and ran the command inside it → "Bye from Zellij!" -- session immediately exited, losing the terminal.

## Impact
- Complete inability to use zellij as a multiplexer
- Misleading error messages (says "cmux" when zellij was selected)
- No fail-fast -- silent failure wastes significant time
- Destructive behavior (kills the user's terminal session)

## Root causes
- `isInsideWorkspace()` missing `ZELLIJ_SESSION_NAME` check
- `ZellijAdapter.isAvailable()` only checks binary, not session
- No pre-flight mux validation in orchestrator
- `closeWorkspace()` has destructive `delete-session` fallback
- Hardcoded "cmux" in error message

## Additional bug: ID collision false completion
When work items reuse IDs from old cycles (H-MUX-1/H-MUX-2 existed from March 24), the orchestrator
matches old merged PRs and fast-tracks new items to "done" without doing any work. Reconcile then
deletes the work item files. This caused a false success report and ~30 min of wasted debugging.

## Decomposed into
- H-MFV-1: Fail fast when mux unavailable (new ID to avoid collision)
- H-MZJ-1: Fix zellij session exit bug (new ID to avoid collision)
- H-MID-1: Fix orchestrator false completion on ID collision
