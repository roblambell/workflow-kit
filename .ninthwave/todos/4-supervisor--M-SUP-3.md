# Refactor: Remove inline supervisor code and update tests (M-SUP-3)

**Priority:** Medium
**Source:** Supervisor session pivot plan — cleanup phase
**Depends on:** H-SUP-2
**Domain:** supervisor

## Context

With the supervisor session fully wired in (H-SUP-2), the inline LLM code in `core/supervisor.ts` is dead code. Remove it to keep the codebase clean and prevent confusion about which supervisor path is active.

## Requirements

1. From `core/supervisor.ts`, remove:
   - `callClaudeCLI()` function
   - `buildSupervisorPrompt()` function
   - `parseSupervisorResponse()` function
   - `supervisorTick()` function
   - `applySupervisorActions()` function
   - `writeFrictionLog()` function
   - All related types: `SupervisorAction`, `SupervisorObservation`, `SupervisorConfig`, `SupervisorDeps`, `SupervisorState`
   - All related constants: `BACKOFF_THRESHOLD`, `DISABLE_THRESHOLD`, `MAX_BACKOFF_INTERVAL_MS`, `DEFAULT_SUPERVISOR_CONFIG`
   - `getEffectiveInterval()` function
   - `createSupervisorDeps()` factory
2. Keep in `core/supervisor.ts`:
   - `isDogfoodingMode()` — still used for auto-activation detection
   - `shouldActivateSupervisor()` — still used to determine if supervisor session should launch
3. Remove imports for deleted symbols from `core/commands/orchestrate.ts`.
4. Update `test/supervisor.test.ts`: remove all tests for deleted functions.
5. Update `test/orchestrate.test.ts`: remove or update any integration tests that exercise the inline supervisor tick.
6. Add tests for `launchSupervisorSession()` in `test/start.test.ts` if not already covered by H-SUP-2.

Acceptance: `core/supervisor.ts` only exports `isDogfoodingMode` and `shouldActivateSupervisor`. No references to `callClaudeCLI`, `buildSupervisorPrompt`, `supervisorTick`, or related symbols remain in the codebase. All tests pass.

**Test plan:**
- `bun test test/` passes with no failures
- Grep for removed function names confirms zero references outside test files
- `isDogfoodingMode` and `shouldActivateSupervisor` still work correctly

Key files: `core/supervisor.ts`, `core/commands/orchestrate.ts`, `test/supervisor.test.ts`, `test/orchestrate.test.ts`, `test/start.test.ts`
