# Feat: Split foreground watch into operator and engine processes (H-TRS-3)

**Priority:** High
**Source:** Decomposed from TUI responsiveness plan 2026-04-01
**Depends on:** H-TRS-2
**Domain:** tui-responsiveness

Change foreground `nw watch` so the parent process is a TUI operator shell and a child process runs the blocking orchestration engine. The operator should own raw stdin, alt-screen lifecycle, render timers, and local selection state while rendering only from transport snapshots instead of live `Orchestrator` state. The engine should keep all git, GitHub, cmux, and reconcile work on its side of the boundary. 

**Test plan:**
- Add integration coverage with a fake engine that blocks before sending the next snapshot, proving the operator still handles keypresses and repaint
- Add tests that the operator renders from snapshot payloads and no longer depends on live orchestrator mutation paths
- Verify quit and completion flows still restore terminal state correctly when the child is running or blocked

Acceptance: In foreground interactive watch, the TUI remains usable while the engine is blocked on orchestration work, rendering is driven by engine snapshots, and terminal lifecycle behavior stays correct.

Key files: `core/commands/orchestrate.ts`, `core/tui-keyboard.ts`, `core/status-render.ts`, `test/orchestrate.test.ts`, `test/tui-keyboard.test.ts`
