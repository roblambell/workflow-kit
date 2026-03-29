# Review: Worker Management & Message Delivery (H-ER-3)

**Priority:** High
**Source:** Engineering review -- full codebase audit
**Depends on:** H-ER-2
**Domain:** eng-review

Read all worker lifecycle code -- launching, health monitoring, message delivery, and cleanup. Reference findings from Reviews 1-2. Write findings to `.ninthwave/reviews/03-worker-management.md`.

## Files to Review

- `core/commands/launch.ts` (1,261 LOC) -- worker session initialization
- `core/mux.ts` (292 LOC) -- multiplexer interface
- `core/cmux.ts` -- cmux adapter implementation
- `core/worker-health.ts` (269 LOC) -- liveness detection, screen health classification
- `core/send-message.ts` (141 LOC) -- message delivery via paste buffer
- `core/commands/clean.ts` -- worker cleanup
- `core/partitions.ts` -- port/DB isolation per worker
- `core/delivery.ts` (63 LOC) -- continuous delivery loop tracking
- `.ninthwave/reviews/01-types-data-model.md` -- prior review
- `.ninthwave/reviews/02-state-machine.md` -- prior review

## Review Criteria

1. **Screen parsing fragility:** `worker-health.ts` uses keyword heuristics (PROMPT_INDICATORS, PROCESSING_INDICATORS, ERROR_INDICATORS) to detect worker state. How brittle is this against AI tool UI changes? What is the false positive/negative rate? Can "Error:" in a code snippet trigger false error detection?
2. **Message delivery reliability:** The paste-buffer-then-Return approach in `send-message.ts` has a delivery verification step, but what happens when verification fails? Trace the exact "silent failure" path.
3. **Launch race conditions:** `launchSingleItem` creates a worktree, allocates a partition, seeds agent files, and launches a workspace. If any step after worktree creation fails, is the worktree leaked?
4. **Partition allocation atomicity:** `allocatePartition` uses `existsSync` + `writeFileSync` which is not atomic. Two concurrent daemons could allocate the same partition number.
5. **Cleanup completeness:** `cleanSingleWorktree` removes worktree, branch, remote branch, and partition. If remote branch deletion fails (network), is the partition still released? Are there ordering dependencies?
6. **Worker health debounce:** `NOT_ALIVE_THRESHOLD = 5` polls. At 2s poll interval, that is 10 seconds. Is this sufficient to avoid false positives from cmux listing latency? Too generous for detecting genuine crashes?
7. **Memory WIP limit:** `calculateMemoryWipLimit` uses `os.freemem()`. What is the actual behavior on macOS? Does it include inactive cache pages?

## Cross-Cutting Themes

### Theme A: Feature Necessity

- Is `delivery.ts` (63 LOC) serving a real user need or tracking overhead?
- Is the Multiplexer abstraction in `mux.ts` justified when cmux is the only implementation, or should it be inlined?
- Is partition-based port isolation actually needed by users, or do most projects not have port conflicts?
- Is the three-layer health monitoring (heartbeat + liveness + commits) all necessary?

### Theme B: Complexity Reduction

- `launch.ts` at 1,261 LOC -- can agent seeding, prompt construction, and workspace setup be simplified?
- Can `mux.ts` be collapsed into `cmux.ts` since there is only one adapter?
- Is the three-layer health monitoring the minimum viable approach or over-engineered?
- Can message delivery be simplified (fewer retries, simpler verification)?

## Output Format

Write to `.ninthwave/reviews/03-worker-management.md` using the same structure (Summary, Findings with severity/tags, Theme A, Theme B, Recommendations). Reference specific line numbers and cross-reference prior reviews.

**Test plan:**
- Verify `.ninthwave/reviews/03-worker-management.md` exists with all required sections
- Verify the "silent failure" message delivery path is fully traced
- Verify findings cross-reference Reviews 1-2

Acceptance: Review document exists at `.ninthwave/reviews/03-worker-management.md` covering all worker lifecycle phases (launch, health, messaging, cleanup), with specific line references and cross-references to prior reviews.

Key files: `core/commands/launch.ts`, `core/mux.ts`, `core/cmux.ts`, `core/worker-health.ts`, `core/send-message.ts`, `core/commands/clean.ts`, `core/partitions.ts`, `core/delivery.ts`
