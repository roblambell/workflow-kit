# Fix: Align status pills and remote snapshots with post-merge verifying (H-PS-2)

**Priority:** High
**Source:** Post-merge status plan 2026-04-01
**Depends on:** None
**Domain:** post-merge-status

Align the rest of the user-facing status language with the post-merge lifecycle. The cmux/TUI status pills should use `Verifying` for merged work that is still waiting on default-branch checks and `Done` for the final successful state, while crew/remote snapshots must accept the new display states without parse failures.

Implementation notes:
- Update `statusDisplayForState()` in `core/orchestrator-types.ts` so `merged`, `forward-fix-pending`, and `fixing-forward` display as `Verifying`
- Keep `fix-forward-failed` as a failed state
- Ensure `done` displays as `Done`
- Extend `CrewRemoteItemState` in `core/crew.ts` so remote snapshots can carry `verifying` and `done`
- Do not change the underlying orchestrator state machine or dependency semantics in this item

**Test plan:**
- Update `test/status.test.ts` to reflect the new state labels and daemon/display mappings
- Update `test/verify-main.test.ts` to expect `Verifying` for `forward-fix-pending` and `fixing-forward`, and `Done` for `done`
- Verify remote snapshot parsing accepts the new display states without falling back or rejecting them
- Run `bun test test/status.test.ts test/verify-main.test.ts`

Acceptance: Status pills and remote snapshot parsing consistently use the new post-merge terminology, `Verifying` is shown for post-merge in-flight states, `Done` is shown for the terminal success state, and no internal orchestration behavior changes.

Key files: `core/orchestrator-types.ts`, `core/crew.ts`, `test/status.test.ts`, `test/verify-main.test.ts`
