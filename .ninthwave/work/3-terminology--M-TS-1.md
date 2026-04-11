# Refactor: Rename WIP to session in core source comments (M-TS-1)

**Priority:** Medium
**Source:** Terminology alignment -- v0.4.0 renamed public API but internal comments were not migrated
**Depends on:** None
**Domain:** terminology

**Lineage:** 8335c806-970b-46cb-9ae0-600c3a7f3b25

Rename all remaining "WIP" references to "session" in core/*.ts source files. This includes code comments, JSDoc comments, section header comments, and one variable rename (`PRE_WIP_STATES` -> `PRE_SESSION_STATES` in orchestrator.ts). The public API already uses session terminology (`sessionLimit`, `activeSessionCount`, `availableSessionSlots`). This is a mechanical rename with no behavioral changes.

Replacement patterns: "WIP limit" -> "session limit", "WIP slot" -> "session slot", "WIP states" -> "session states", "WIP pool" -> "session pool", "WIP full" -> "session limit full", "pre-WIP" -> "pre-session", "WIP queueing" -> "session queueing", "WIP availability" -> "session availability". Read each reference in context and choose the natural phrasing.

**Test plan:**
- Run `bun run test` -- the `PRE_WIP_STATES` variable rename must not break any references
- Grep for remaining "WIP" in core/*.ts after changes to confirm none were missed
- Verify comment changes compile cleanly (no accidental code edits)

Acceptance: Zero "WIP" references remain in core/*.ts files (excluding node_modules). `PRE_WIP_STATES` renamed to `PRE_SESSION_STATES`. All tests pass. No behavioral changes.

Key files: `core/orchestrator.ts`, `core/orchestrator-types.ts`, `core/orchestrator-actions.ts`, `core/orchestrate-event-loop.ts`, `core/schedule-runner.ts`, `core/schedule-processing.ts`, `core/schedule-state.ts`, `core/tui-keyboard.ts`, `core/tui-widgets.ts`, `core/interactive.ts`, `core/memory.ts`, `core/mock-broker.ts`, `core/external-review.ts`, `core/status-render.ts`, `core/commands/orchestrate.ts`, `core/commands/run-items.ts`, `core/commands/launch.ts`
