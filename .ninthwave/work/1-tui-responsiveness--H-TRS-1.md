# Fix: Add interactive watch stall instrumentation (H-TRS-1)

**Priority:** High
**Source:** Decomposed from TUI responsiveness plan 2026-04-01
**Depends on:** None
**Domain:** tui-responsiveness

Add focused instrumentation around the current interactive watch loop so we can prove where responsiveness drops today and verify the split-process design later. Measure event-loop lag and stage timings for poll, action execution, main refresh, display sync, and render, then emit structured warnings when a single stage crosses useful thresholds. Keep the diff limited to observability and test hooks. 

**Test plan:**
- Add orchestrate coverage for stage timing capture and long-stage warning thresholds
- Add tests for event-loop lag sampling in interactive mode without requiring real blocking subprocesses
- Verify the new logs are emitted in TUI mode and do not change non-interactive behavior

Acceptance: Interactive watch emits structured timing data for the main blocking stages, warns on long stalls, and gives us clear before/after evidence for later responsiveness work without changing orchestrator semantics.

Key files: `core/commands/orchestrate.ts`, `test/orchestrate.test.ts`
