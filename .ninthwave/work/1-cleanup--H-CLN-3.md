# Docs: Update ARCHITECTURE.md for ARC refactor (H-CLN-3)

**Priority:** High
**Source:** Post-ARC cleanup -- architecture docs outdated
**Depends on:** None
**Domain:** cleanup
**Lineage:** b34a1763-a728-4d3c-827c-7340427f415a

ARCHITECTURE.md is missing documentation for the modules and patterns introduced by the ARC refactor. The foundational sections (state machine, data flow, multiplexer, crew broker) are still accurate but several new architectural elements are undocumented.

Read the current ARCHITECTURE.md fully, then add/update sections for:

1. **Guard Registry** -- new section documenting `core/orchestrator-guards.ts`:
   - Pure temporal safety predicates (isCiFailTrustworthy, isHeartbeatActive, isEventFresherThan, etc.)
   - Signal freshness contract: every handler reading ciStatus/reviewDecision/isMergeable must consider staleness
   - How guards relate to grace periods and timeouts

2. **Request Queue** -- new section documenting `core/request-queue.ts`:
   - Token bucket rate limiting (proactive, targeting 85% of GitHub's 5000/hr)
   - Priority-based concurrency control (critical > high > normal > low)
   - Audit logging and per-category metrics via getStats()
   - How it replaced the reactive RateLimitBackoff

3. **Parallel Snapshot Building** -- update the event loop / snapshot section:
   - buildSnapshotAsync dispatches item polls in parallel through the RequestQueue
   - Priority ordering: merging > ci-failed > ci-pending > implementing
   - Concurrency capped by queue semaphore
   - Per-item error isolation (one failed poll doesn't block others)

4. **Runtime Transition Enforcement** -- update the state machine section:
   - transition() validates against STATE_TRANSITIONS table at runtime
   - Illegal transitions throw immediately
   - hydrateState() bypasses enforcement for reconstruction

5. **Bundled OrchestratorDeps** -- update or add to dependency injection section:
   - 6 sub-interfaces: git, gh, mux, workers, cleanup, io
   - Each action function accesses deps through typed sub-interface paths
   - Improves traceability of which actions depend on which capabilities

6. **Module inventory** -- update file listing to include:
   - `core/orchestrator-guards.ts` (~127 LOC) -- temporal safety predicates
   - `core/orchestrator-actions.ts` (~1,278 LOC) -- action execution functions
   - `core/request-queue.ts` (~372 LOC) -- request queueing and rate limiting
   - Note removal of `core/rate-limit-backoff.ts`

Do NOT add completion markers or status annotations to VISION.md (per CLAUDE.md conventions).

**Test plan:**
- Manual review of updated ARCHITECTURE.md for accuracy against current code
- Verify all referenced file paths and module names exist (grep/glob check)
- Run `bun run test` to ensure no test lint rules violated (e.g., em dash check on .md files)

Acceptance: ARCHITECTURE.md accurately describes the current orchestrator architecture including guard registry, request queue, parallel snapshots, transition enforcement, and bundled deps. All referenced files exist. No stale module descriptions remain.

Key files: `ARCHITECTURE.md`, reference `core/orchestrator-guards.ts`, `core/request-queue.ts`, `core/orchestrator-actions.ts`, `core/orchestrator-types.ts`
