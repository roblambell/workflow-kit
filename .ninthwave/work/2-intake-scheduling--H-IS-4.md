# Feat: Add acceptingWork toggle for drain mode (H-IS-4)

**Priority:** High
**Source:** docs/intake-scheduling-design.md
**Depends on:** H-IS-3
**Domain:** intake-scheduling
**Lineage:** 05145d61-dc8d-48f1-832e-bb8b7986042b

Add `acceptingWork` boolean to the orchestrator for flow control. When `acceptingWork` is false, no new items are launched but in-flight items continue through their full lifecycle normally (CI, review, rebase, fix-forward all proceed). This gives operators a clean "drain" mode: stop new work, let existing work finish, resume when ready -- without losing the configured `maxInflight` value.

Orchestrator state:
- Add `acceptingWork: boolean` field, default `true`, runtime-only (not persisted to config)
- Each `nw` session starts with `acceptingWork = true`
- Add `toggleAcceptingWork()` method that flips the boolean

Launch gating change:
- Current: `activeItemCount < maxInflight`
- New: `acceptingWork && activeItemCount < maxInflight`
- When not accepting work, `launchReadyItems()` returns early with no actions

TUI hotkey:
- `p` key toggles `acceptingWork` (mnemonic: "pause intake")
- Must not conflict with existing hotkeys (check tui-keyboard.ts for conflicts)
- `+`/`-` still adjust `maxInflight` while not accepting (limit is ready when you resume)

TUI indicator:
- When `acceptingWork` is false, show a "DRAINING" or "NOT ACCEPTING" label in the status bar
- Use the existing status-render.ts pattern for the settings panel display
- The indicator should be noticeable but not a full-width banner -- a label alongside the inflight count

JSON mode output:
- Include `acceptingWork` in the orchestrator state snapshot emitted in `--json` mode

**Test plan:**
- Unit test: `toggleAcceptingWork()` flips boolean state
- Unit test: `launchReadyItems()` returns empty when `acceptingWork` is false even with available slots
- Unit test: in-flight items continue transitions normally when `acceptingWork` is false
- Integration test: `p` hotkey calls toggle method
- Verify `+`/`-` still adjust maxInflight while not accepting work
- Edge case: toggling acceptingWork back to true resumes launches immediately on next poll cycle
- Edge case: starting a new `nw` session always begins with `acceptingWork = true`

Acceptance: `p` key toggles `acceptingWork`. When not accepting, no new items launch but in-flight items proceed normally. TUI shows a clear indicator when not accepting. `+`/`-` still adjust `maxInflight` while draining. JSON output includes `acceptingWork` state. `bun run test` passes.

Key files: `core/orchestrator.ts`, `core/tui-keyboard.ts`, `core/status-render.ts`, `core/orchestrate-event-loop.ts`, `core/orchestrate-tui-render.ts`, `test/orchestrator.test.ts`, `test/orchestrator-unit.test.ts`, `test/tui-keyboard.test.ts`, `test/status-render.test.ts`
