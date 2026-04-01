# Refactor: Extract shared watch engine runner (H-TRS-2)

**Priority:** High
**Source:** Decomposed from TUI responsiveness plan 2026-04-01
**Depends on:** None
**Domain:** tui-responsiveness

Extract a shared engine runner that owns `orchestrateLoop`, snapshot emission, log forwarding, and runtime control intake so both detached daemon mode and the future foreground child process use the same orchestration core. Keep the transport boundary narrow: config in, structured snapshots and log events out, control commands back in. Do not rewrite the state machine or change JSON mode semantics. 

**Test plan:**
- Add unit coverage for engine runner startup, snapshot emission, and log forwarding with fake orchestrator deps
- Add tests proving detached daemon mode and interactive child mode both bind to the same shared runner entry
- Verify control messages are applied in order and reflected in subsequent emitted snapshots

Acceptance: There is one reusable orchestration engine path for both daemon and interactive child execution, snapshots and logs can be streamed outward, and runtime controls can be sent inward without changing existing orchestrator state-machine behavior.

Key files: `core/commands/orchestrate.ts`, `core/daemon.ts`, `test/orchestrate.test.ts`
