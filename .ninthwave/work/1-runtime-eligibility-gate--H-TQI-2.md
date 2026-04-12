# Runtime engine: enforce ignored-item launch gate + persistence (H-TQI-2)

**Priority:** High
**Source:** Follow-up on cue/ignore runtime plan feedback (2026-04-12)
**Depends on:** H-TQI-1
**Domain:** orchestrator-runtime
**Lineage:** 86e4f8a8-a56f-4f6c-bdc8-4457ad7e4eb8

Add and persist per-item `queueEligibility` in runtime state, defaulting to `cued` for backward compatibility. Ensure scheduler launch candidacy excludes ignored items and that toggled state survives daemon restart.

**Test plan:**
- Verify missing eligibility defaults to `cued` on read.
- Verify ignored items are excluded from launch selection.
- Verify toggled values survive snapshot serialization/deserialization.

Acceptance: Engine truthfully treats ignored items as out-of-queue until re-toggled, across restarts.

Key files: `core/orchestrator.ts`, `core/snapshot.ts`, `core/orchestrate-event-loop.ts`
