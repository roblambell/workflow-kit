## Worker times out on large cross-cutting refactors

**Observed:** H-TUI-3 (merge strategy simplification) ran for ~30 minutes twice, each time exiting with `exitCode: null` (killed) without pushing any commits. The work item touches orchestrator state machine, CLI flags, interactive prompts, and 6+ test files.

**Root cause:** The work item scope exceeds what a single worker session can complete within the timeout. The item involves:
- Rewriting a core type (`MergeStrategy`) and all references
- Refactoring `evaluateMerge()` state machine logic
- Adding new CLI flag (`--dangerously-bypass`)
- Removing config fields (`reviewEnabled`)
- Updating tests across 6+ files

**Potential fixes:**
1. Decompose H-TUI-3 further — separate the type rename from the behavioral changes
2. Increase worker timeout for items flagged as "large" or with many key files
3. Have the worker commit+push partial progress periodically (checkpoint commits) so work isn't lost on timeout
4. Allow the orchestrator to continue a worker on an existing branch rather than starting fresh

**Impact:** 2 worker sessions (~1 hour total) wasted with no output. Downstream items (H-TUI-4, M-TUI-5) blocked.
