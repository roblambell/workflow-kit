# Fix: Repair rebase loop -- circuit breaker + worker message priority (H-RR-1)

**Priority:** High
**Source:** Friction log: repair-rebase-vs-worker-message.md (2026-03-27)
**Depends on:** None
**Domain:** daemon

The orchestrator's repair rebase logic has two bugs that combine to create an infinite loop when a PR has merge conflicts. Bug 1: `executeDaemonRebase` launches repair workers even when the original worker is alive -- it should `cmux send` a rebase message to the live worker first (lightweight, immediate) and only fall back to repair when the worker is dead. Bug 2: there is no circuit breaker on repair attempts -- the repair "succeeds" without resolving conflicts, `handleRepairing` clears `rebaseRequested`, and the trigger at line 883 fires again every ~15 seconds forever.

**Test plan:**
- Test circuit breaker marks stuck after `maxRepairAttempts` (set count to limit, verify `executeDaemonRebase` transitions to stuck)
- Test worker message preferred over repair when `item.workspaceRef` exists and `sendMessage` succeeds (verify `launchRepair` NOT called)
- Test repair fallback when worker message fails (`sendMessage` returns false, verify repair launches and `repairAttemptCount` increments)
- Test `repairAttemptCount` resets when conflicts resolve (`isMergeable !== false` after repair) and preserves when conflicts persist
- Integration-style test: full loop of detect-conflict -> daemon-rebase -> repair -> CI restarts -> still conflicting, verify terminates after `maxRepairAttempts`
- All existing repair worker tests must continue passing unchanged

Acceptance: Repair rebase loop terminates after `maxRepairAttempts` (default 3) with item marked stuck and descriptive `failureReason`. When a live worker exists (`item.workspaceRef` set), `sendMessage` is tried before launching a repair worker. `repairAttemptCount` resets to 0 when conflicts are actually resolved (`isMergeable !== false`). All existing tests pass. 7 new unit tests pass.

Key files: `core/orchestrator.ts` (OrchestratorItem interface ~line 91, OrchestratorConfig ~line 126, DEFAULT_CONFIG ~line 316, executeDaemonRebase lines 1749-1781, handleRepairing lines 1003-1008), `test/orchestrator-unit.test.ts` (repair worker state transitions section ~line 2263)
