# Test: Prove blocked-engine responsiveness and shared-engine regressions (H-TRS-5)

**Priority:** High
**Source:** Decomposed from TUI responsiveness plan 2026-04-01
**Depends on:** H-TRS-1, H-TRS-3, M-TRS-4
**Domain:** tui-responsiveness

Harden the new architecture with regression coverage that exercises the exact failure mode behind this plan: a blocked orchestration engine while the TUI remains responsive. Add end-to-end style tests around blocked refreshes, blocked actions, disconnect recovery, and shared daemon behavior so future synchronous helper additions do not quietly re-couple the UI and engine. Keep this item focused on verification and thin cleanup only. 

**Test plan:**
- Add blocked-engine regression tests for help, quit, navigation, and overlay interaction while the engine is busy
- Add shared-engine tests covering detached daemon mode, interactive child mode, and snapshot/log emission parity
- Verify instrumentation from H-TRS-1 records long engine stalls without flagging operator repaint as blocked

Acceptance: The suite fails if foreground watch input or repaint is re-coupled to a blocked engine, both engine wrappers stay behaviorally aligned, and instrumentation demonstrates the operator stays responsive during simulated multi-second engine stalls.

Key files: `test/orchestrate.test.ts`, `test/tui-keyboard.test.ts`, `core/commands/orchestrate.ts`, `core/daemon.ts`
