# Refactor: Rename sessionLimit to maxInflight (H-IS-2)

**Priority:** High
**Source:** docs/intake-scheduling-design.md
**Depends on:** H-IS-1
**Domain:** intake-scheduling
**Lineage:** f046ede8-f697-435d-bc9f-f8c8d9bf155d

Mechanical rename of all session-limit terminology to the new maxInflight naming. This is a purely cosmetic refactor with zero behavioral change -- every reference to the old name becomes the new name. The rename makes the concept self-descriptive: "max inflight" clearly says "how many items can be concurrently active."

Renames (all occurrences across core + test files):
- `sessionLimit` -> `maxInflight` (TypeScript property on OrchestratorConfig and everywhere it is referenced)
- `session_limit` -> `max_inflight` (config key in UserConfig interface, JSON read/write in config.ts)
- `--session-limit` -> `--max-inflight` (CLI flag in watch-args.ts; accept `--session-limit` as a silent deprecated alias)
- `sessionLimitOverride` -> `maxInflightOverride` (ParsedWatchArgs and consumers)
- `activeSessionCount` -> `activeItemCount` (orchestrator getter)
- `availableSessionSlots` -> `availableInflightSlots` (orchestrator getter)
- `setSessionLimit()` -> `setMaxInflight()` (orchestrator method)
- `computeDefaultSessionLimit()` -> `computeDefaultMaxInflight()` (event loop helper)
- `pendingSessionLimit` -> `pendingMaxInflight` (TUI state in tui-keyboard.ts)
- `onSessionLimitChange` -> `onMaxInflightChange` (TUI callback)
- `reviewSessionLimit` -> `reviewMaxInflight` (watch-args and consumers)
- `"active sessions"` -> `"in flight"` (status-render.ts display label)

Config migration: In `config.ts`, when reading config JSON, check for old `session_limit` key and treat it as `max_inflight` if the new key is absent. On next write, persist as `max_inflight` only.

**Test plan:**
- Run full test suite after rename to confirm no missed references (TypeScript will catch property mismatches at runtime)
- Verify `--session-limit` still parses without error (deprecated alias) in watch-args tests
- Verify config migration: old `{"session_limit": 3}` file reads as `max_inflight: 3`
- Verify status output shows "in flight" instead of "active sessions"
- Grep for any remaining "sessionLimit", "session_limit", or "session-limit" references that were missed

Acceptance: Zero references to `sessionLimit`, `session_limit`, or `--session-limit` remain in core/ or test/ (except the deprecated alias handler in watch-args.ts and config migration fallback in config.ts). Status bar shows "in flight" terminology. `--session-limit` still works as a silent alias. `bun run test` passes.

Key files: `core/orchestrator-types.ts`, `core/orchestrator.ts`, `core/config.ts`, `core/orchestrate-event-loop.ts`, `core/commands/watch-args.ts`, `core/commands/orchestrate.ts`, `core/commands/run-items.ts`, `core/tui-keyboard.ts`, `core/tui-settings.ts`, `core/status-render.ts`, `core/tui-widgets.ts`, `core/orchestrate-tui-render.ts`, `core/daemon.ts`, `core/interactive.ts`, `core/rotation.ts`, `core/mock-broker.ts`, `core/external-review.ts`, `core/watch-engine-runner.ts`
