# Feat: Route runtime controls and recovery through the watch protocol (M-TRS-4)

**Priority:** Medium
**Source:** Decomposed from TUI responsiveness plan 2026-04-01
**Depends on:** H-TRS-2, H-TRS-3
**Domain:** tui-responsiveness

Move runtime TUI actions such as merge strategy, review mode, collaboration mode, WIP limit changes, timeout extension, and shutdown onto the operator-engine protocol instead of mutating the live orchestrator from keyboard handlers. Add a disconnect/restart overlay so child-process failure does not leave the terminal stuck in raw mode and so pending control changes can be shown honestly until the engine acknowledges them. 

**Test plan:**
- Add protocol tests for merge strategy, review mode, collaboration mode, WIP, timeout extension, and shutdown messages
- Add disconnect-path coverage proving the operator shows a recovery overlay and restores the terminal cleanly on quit
- Verify pending control UI state is replaced by engine-confirmed state and does not drift permanently

Acceptance: Runtime controls flow only through the watch protocol, pending and acknowledged control state are rendered correctly, and engine disconnects surface a recovery path instead of freezing or corrupting the terminal.

Key files: `core/commands/orchestrate.ts`, `core/tui-keyboard.ts`, `test/orchestrate.test.ts`, `test/tui-keyboard.test.ts`
