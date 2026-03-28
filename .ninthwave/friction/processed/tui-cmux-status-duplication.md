# Friction: TUI and cmux workspace sidebar duplicate status without clear scope

**Observed:** 2026-03-27
**Project:** strait (ninthwave-sh/strait)
**Severity:** Medium
**Component:** orchestrator TUI, cmux workspace sidebar, worker status contract

## What happened

The orchestrator TUI and cmux workspace sidebar both show status for each item, but they display overlapping/duplicated information without clear differentiation:

- TUI row shows: icon + ID + state (e.g., "Implementing", "CI Pending")
- cmux sidebar shows: title, worker state ("Running"/"Idle"), orchestrator state ("Implementing"/"CI Pending"), and a subtitle line ("CI running", "Writing tests", "PR created: ...")

Example from screenshot:
```
H-CP-18 Log SigV4 signi...
  ⚡ Idle                    ← worker state (from cmux)
  ● CI Pending               ← orchestrator state (redundant with TUI)
  CI running                  ← subtitle (from worker? or orchestrator?)
  ninthwave/H-CP-18 ~ ~/code/...  ← worktree path
```

It's unclear what each field's source/contract is:
- Who sets the subtitle line? Worker or orchestrator?
- Should the cmux sidebar show orchestrator state at all, or only worker-local state?
- The TUI already shows orchestrator state — duplicating it in cmux adds noise.

## Expected behavior

Clear separation of concerns:
- **TUI**: shows orchestrator-managed state (queued → launching → implementing → ci-pending → merging → done)
- **cmux sidebar**: shows worker-local state only (what the worker is doing right now — "Reading code", "Writing tests", "Running cargo test", etc.)
- **Contract**: workers set their own status line via cmux (free-form text describing current activity). The orchestrator owns the lifecycle state and should NOT duplicate it into the cmux sidebar.

This means the cmux sidebar should NOT show "CI Pending" or "Implementing" — those are orchestrator states visible in the TUI. The sidebar should show what the worker process is actually doing.
