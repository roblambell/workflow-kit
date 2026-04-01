# Feat: Track repair PR history and forward-fixer handoff on the canonical item (H-PMR-2)

**Priority:** High
**Source:** Decomposed from post-merge CI repair tracking feature 2026-04-01
**Depends on:** H-PMR-1
**Domain:** post-merge-repair-tracking

Teach the launch, snapshot, daemon, and repair-agent plumbing to preserve the original PR context while swapping the canonical item onto a new active repair PR when one exists. The item should keep enough prior PR metadata to support multiple PR references in status, telemetry, and restart recovery, but the implementation should stay narrowly scoped to the repair re-entry path rather than refactoring all PR handling into a generic list abstraction. Update the forward-fixer contract so it can explicitly produce either a minimal fix PR or a revert PR without creating a second committed work item in `.ninthwave/work/`.

**Test plan:**
- Add launch and snapshot coverage proving the canonical item can detect and resume a repair PR after the forward-fixer creates it, including restart/reconstruct paths
- Add daemon and snapshot persistence coverage that preserves original PR context while exposing the current active repair PR on the same item
- Add agent and action tests proving the forward-fixer launch path supports repair PR creation for both fix and revert outcomes without publishing a synthetic child work item

Acceptance: The original item can carry its original PR context and a new active repair PR at the same time, survives daemon restart without losing that mapping, and the forward-fixer path supports either fix or revert PR creation while keeping the repo work item set unchanged.

Key files: `core/commands/launch.ts`, `core/snapshot.ts`, `core/daemon.ts`, `core/reconstruct.ts`, `agents/forward-fixer.md`, `test/verify-main.test.ts`
