# Fix: Hold completion, broker reporting, and status UI until repair verification actually finishes (H-PMR-3)

**Priority:** High
**Source:** Decomposed from post-merge CI repair tracking feature 2026-04-01
**Depends on:** H-PMR-1, H-PMR-2
**Domain:** post-merge-repair-tracking

Fix the reporting and presentation paths that currently make a post-merge repair item look complete too early, including the known bug where `core/commands/orchestrate.ts` reports broker completion during merge-time cleanup before post-merge verification is really done. Status rendering, crew snapshots, completion prompts, and final run summaries should treat an item with active repair work as still in progress, surface the current repair PR while preserving prior PR references, and only mark the item done after the final repair merge has been verified on main. Keep the behavior change tightly scoped to the post-merge repair path.

**Test plan:**
- Add orchestrate-loop coverage proving crew completion and completion summaries are withheld while the canonical item is in repair investigation or repair PR re-entry states
- Extend status and snapshot render tests to show repairing items as active/verifying instead of done, while surfacing the relevant repair PR reference
- Verify completion prompt and cleanup flows do not treat merge-time cleanup as true completion until post-repair verification reaches `done`

Acceptance: During post-merge repair, the canonical item renders as active or verifying rather than done, broker completion is not emitted during merge-time cleanup, and run completion UI and cleanup only treat the item as complete after final post-merge verification succeeds.

Key files: `core/commands/orchestrate.ts`, `core/status-render.ts`, `core/crew.ts`, `core/daemon.ts`, `test/orchestrate.test.ts`, `test/status-render.test.ts`, `test/verify-main.test.ts`
