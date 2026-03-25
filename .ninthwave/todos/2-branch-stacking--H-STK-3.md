# Feat: Orchestrator stacking readiness (H-STK-3)

**Priority:** High
**Source:** Stacked branches plan (eng-reviewed 2026-03-25)
**Depends on:** H-STK-1
**Domain:** branch-stacking

Add stacked branch awareness to the orchestrator state machine. Changes to `core/orchestrator.ts`:

1. Add `baseBranch?: string` to `Action`, `OrchestratorItem`, and `OrchestratorDeps.launchSingleItem` interfaces
2. Add `enableStacking?: boolean` (default: `true`) to `OrchestratorConfig`
3. Add `STACKABLE_STATES` set (`ci-passed`, `review-pending`, `merging`)
4. Add `canStackLaunch(item)` method — returns `{ canStack: true, baseBranch }` when item has exactly one in-flight dep in a stackable state (all other deps done/merged)
5. Update `processTransitions()` — after normal `readyIds` check, promote queued items via `canStackLaunch()` and set `item.baseBranch`
6. Update `launchReadyItems()` — include `baseBranch` in launch actions
7. Update `executeLaunch()` — pass `action.baseBranch` through to `deps.launchSingleItem()`

The orchestrator owns all stacking decisions (not `buildSnapshot`, which stays a pure external-state poller). `canStackLaunch()` is a pure function of config + internal state — no runtime environment checks.

**Test plan:**
- Test `canStackLaunch()` with 7 scenarios: single dep in ci-passed (stackable), single dep in review-pending (stackable), multiple in-flight deps (not stackable), all deps done (not stackable), stacking disabled (not stackable), mixed done + one in-flight (stackable), dep in implementing (not stackable)
- Test `processTransitions()` promotes stackable-ready items and sets baseBranch on the item
- Test `launchReadyItems()` includes baseBranch in the launch action
- Test `executeLaunch()` passes baseBranch through to the injected deps.launchSingleItem

Acceptance: Items with a single dep in `ci-passed`/`review-pending`/`merging` are promoted to `ready` with `baseBranch` set. Launch actions carry `baseBranch`. `enableStacking: false` disables all stacking. Existing non-stacked behavior unchanged. All existing orchestrator tests pass.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`
