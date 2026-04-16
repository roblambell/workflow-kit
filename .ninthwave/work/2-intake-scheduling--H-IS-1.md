# Refactor: Remove memory auto-adjustment (H-IS-1)

**Priority:** High
**Source:** docs/intake-scheduling-design.md
**Depends on:** None
**Domain:** intake-scheduling
**Lineage:** c0261e7b-7ced-42c0-b964-e52b3df39f7c

Remove the unreliable memory-based session limit reduction. The auto-adjustment via `calculateMemorySessionLimit()` adds complexity without trustworthy results -- actual workspace consumption depends on the AI tool, project size, and what tests run. After this change, the configured `sessionLimit` is the value used directly, with no `effectiveSessionLimit` indirection.

Removals:
- `calculateMemorySessionLimit()` and `BYTES_PER_WORKER` from `core/orchestrator-types.ts`
- `_effectiveSessionLimit` field, `setEffectiveSessionLimit()` method, and `effectiveSessionLimit` getter from `core/orchestrator.ts`
- Memory adjustment block in `core/orchestrate-event-loop.ts` (~lines 999-1013)
- Memory calc usage in `core/commands/run-items.ts` (lines ~115-123) -- replace with direct use of configured limit
- `getAvailableMemory()` from `core/memory.ts` (only consumer is memory calc; delete entire file if no other callers)

Simplifications:
- `availableSessionSlots` uses `config.sessionLimit` directly instead of `effectiveSessionLimit`
- `setSessionLimit()` no longer needs to clear `_effectiveSessionLimit`
- `orchestrate-event-loop.ts` poll cycle no longer calls memory calc or logs `session_limit_reduced_memory`
- `run-items.ts` uses configured limit directly, no memory capping

**Test plan:**
- Remove/update `calculateMemorySessionLimit` test suite in `orchestrator.test.ts` (8 test cases covering memory scenarios)
- Remove/update `effectiveSessionLimit` override tests in `orchestrator.test.ts` and `orchestrator-unit.test.ts`
- Update `setSessionLimit` tests in `orchestrator-unit.test.ts` to remove memory override clearing assertions
- Verify existing launch gating tests still pass with direct limit usage
- Edge case: run-items with no CLI override should use config value directly (no memory capping)

Acceptance: `calculateMemorySessionLimit`, `BYTES_PER_WORKER`, `_effectiveSessionLimit`, `setEffectiveSessionLimit`, and `effectiveSessionLimit` getter are all deleted. No code references `getAvailableMemory()` for session limiting. The configured `sessionLimit` is used directly everywhere. `bun run test` passes.

Key files: `core/orchestrator-types.ts`, `core/orchestrator.ts`, `core/orchestrate-event-loop.ts`, `core/commands/run-items.ts`, `core/memory.ts`, `test/orchestrator.test.ts`, `test/orchestrator-unit.test.ts`
