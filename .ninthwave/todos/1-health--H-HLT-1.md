# Feat: Add deterministic worker health checks to orchestrator daemon (H-HLT-1)

**Priority:** High
**Source:** Friction log — supervisor-missed-stalled-workers (2026-03-25), worker-empty-input-race (2026-03-25)
**Depends on:** (none)
**Domain:** health

The orchestrator daemon polls GitHub for CI/PR state but never reads worker screens. When workers stall (empty prompt, permission dialog, error loop, hung process), the daemon can't detect it — items sit in `implementing` state indefinitely. The LLM supervisor reported "ok" while all 3 workers were stalled.

Add deterministic worker screen health checks to the orchestrator's snapshot-building cycle. During `buildSnapshot()`, for each item in `launching` or `implementing` state with a `workspaceRef`, read the worker's terminal screen via the multiplexer's `readScreen()` method. Parse the screen content to detect common stall patterns:

1. **Empty input** — Claude Code prompt visible but no input text (worker never received "Start" or finished and is idle)
2. **Permission prompt** — worker waiting for user approval (Y/n dialog)
3. **Error state** — repeated error messages or crash output
4. **No output change** — screen content identical across N consecutive polls (worker process hung)

Add a `screenHealth` field to `ItemSnapshot` with values: `healthy`, `stalled-empty`, `stalled-permission`, `stalled-error`, `stalled-unchanged`, or `unknown`. In `transitionItem()`, when `screenHealth` indicates a stall in `implementing` state, emit a `send-message` action with an appropriate nudge (e.g., "Start" for empty input, or a diagnostic message for errors). Add a `stallDetectedAt` timestamp to `OrchestratorItem` to prevent repeated nudges — only send one nudge per stall detection, then wait for recovery before nudging again.

**Test plan:**
- Unit test: `buildSnapshot` with mocked `readScreen` returning empty-prompt screen → `screenHealth === "stalled-empty"`
- Unit test: `buildSnapshot` with mocked `readScreen` returning permission prompt → `screenHealth === "stalled-permission"`
- Unit test: `buildSnapshot` with mocked `readScreen` returning normal coding output → `screenHealth === "healthy"`
- Unit test: `transitionItem` with stalled-empty screen → emits send-message action with "Start"
- Unit test: stall nudge deduplication — second consecutive stall poll does NOT emit another send-message
- Unit test: `readScreen` throws → `screenHealth === "unknown"`, no crash
- Verify existing orchestrator tests still pass (no regressions)

Acceptance: Orchestrator detects stalled workers via screen reading. Stall patterns (empty input, permission prompt, error, unchanged) correctly classified. Nudge messages sent once per stall detection. Graceful degradation when `readScreen` is unavailable. All tests pass.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`
