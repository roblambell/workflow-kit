# Refactor: Async buildSnapshot for TUI responsiveness (H-AS-1)

**Priority:** High
**Source:** Eng review 2026-03-29 -- TUI unresponsive during poll cycles
**Depends on:** None
**Domain:** tui-responsiveness

The TUI freezes for 3-7 seconds each poll cycle because buildSnapshot() calls checkPrStatus() per active item using synchronous Bun.spawnSync. With 5 WIP items, that is 10-15 blocking gh CLI calls at 300-500ms each. The fix: add an async shell runner (runAsync using Bun.spawn), create async variants of the gh functions (prListAsync, prViewAsync, prChecksAsync), make checkPrStatus async, and make buildSnapshot async. The orchestrate event loop already uses await, so each async gh call yields to the event loop, letting keyboard events fire and the TUI re-render from cached lastTuiItems.

Keep all existing sync functions unchanged -- they are used by tests and one-shot CLI commands. Add async variants alongside them. Update the OrchestrateLoopDeps interface to return Promise<PollSnapshot> from buildSnapshot. Update test mocks to return promises.

**Test plan:**
- Add tests for runAsync: basic execution (stdout, stderr, exitCode), timeout handling (process killed, timedOut flag), command-not-found (non-zero exit), stdin piping
- Add tests for prListAsync, prViewAsync, prChecksAsync: mock runAsync via vi.spyOn, verify JSON parsing and empty/error fallbacks match sync versions
- Add tests for checkPrStatusAsync: open PR with CI info, merged PR, no PR, gh unavailable
- Add tests for async buildSnapshot: mock async checkPr, verify snapshot assembly, skip terminal states, compute readyIds, handle checkPr failure gracefully
- Verify all 508 existing tests still pass (sync functions unchanged)

Acceptance: Keyboard events (scroll, help, quit) respond instantly even during active poll cycles with 5+ WIP items. All existing tests pass. New async function tests pass. GitHub API call volume is unchanged (same 2s interval, same calls per cycle). bun test test/ passes.

Key files: `core/shell.ts`, `core/gh.ts`, `core/commands/pr-monitor.ts`, `core/commands/orchestrate.ts`, `test/shell.test.ts`, `test/gh.test.ts`, `test/orchestrate.test.ts`
