# Review: Core State Machine (H-ER-2)

**Priority:** High
**Source:** Engineering review -- full codebase audit
**Depends on:** H-ER-1
**Domain:** eng-review

Read the full Orchestrator class and evaluate state transition completeness, correctness, timeout logic, and execution safety. Reference findings from Review 1 (`.ninthwave/reviews/01-types-data-model.md`) where relevant. Write findings to `.ninthwave/reviews/02-state-machine.md`.

## Files to Review

- `core/orchestrator.ts` -- full file (2,662 LOC). Focus on Orchestrator class, processTransitions, all transition handler methods, all execute* methods.
- `.ninthwave/reviews/01-types-data-model.md` -- prior review findings to reference

## Review Criteria

1. **State transition completeness:** Map every possible (state, snapshot) pair. Is there an explicit handler for each? Are there unreachable states? Dead transitions?
2. **transition() flag management:** The `transition()` method clears/sets several flags (rebaseRequested, reviewCompleted, ciFailureNotified, failureReason, startedAt, endedAt). Are there races where a flag is cleared prematurely or set incorrectly?
3. **WIP limit enforcement:** `launchReadyItems()` is called every cycle. Can rapid state transitions in a single cycle allow launching more items than the WIP limit? (processTransitions calls `transitionItem` for all items THEN `launchReadyItems` -- can items transition to "ready" during transitionItem and get launched in the same cycle?)
4. **Timeout hierarchy correctness:** The implementing handler has three-layer timeout (heartbeat > process liveness > commit-based). Can a single flaky `workerAlive=false` reading kill a healthy worker?
5. **Stacked branch safety:** When a dependency goes stuck, pre-WIP dependents are rolled back to queued with baseBranch cleared. But what happens if the dependent already pushed commits against the old base? Dangling branch risk?
6. **Priority merge queue:** `prioritizeMergeActions` serializes merges. Does this cause starvation of lower-priority items when higher-priority items cycle between ci-passed and ci-failed?
7. **executeAction side effects:** Each execute* method mutates item state AND performs external operations. What happens when the external op fails mid-way through a compound action (e.g., `executeMerge` succeeds at `prMerge` but fails at `ffMerge`)?
8. **Retry semantics:** `stuckOrRetry` resets `lastAliveAt` and `notAliveCount` but not `lastCommitTime`. Could stale commit time from a previous attempt cause the new attempt to immediately time out?

## Cross-Cutting Themes

### Theme A: Feature Necessity

- ARCHITECTURE.md lists 16 states. Are all reachable and exercised in real usage?
- Is `bootstrapping` used outside cross-repo? If cross-repo is stripped, can this state go too?
- Is `verifying` actually doing verification or just a passthrough?
- Are stacked launches being used, or is this complexity without users?
- Is the review worker flow (review-pending, reviewing) serving users or adding unused complexity?

### Theme B: Complexity Reduction

- Can any states be collapsed (e.g., `pr-open` and `ci-pending` seem like they could be one state)?
- Is the three-layer timeout hierarchy necessary or could a simpler model achieve the same outcome?
- Can the execute* methods be simplified or deduplicated?
- The Orchestrator class is 2,662 LOC in a single file. Can it be decomposed without losing the "pure state machine" property?

## Output Format

Write to `.ninthwave/reviews/02-state-machine.md` using the same structure as Review 1 (Summary, Findings with severity and STRIP/SIMPLIFY/KEEP/QUESTIONABLE tags, Theme A, Theme B, Recommendations). Reference specific line numbers and code snippets.

**Test plan:**
- Verify `.ninthwave/reviews/02-state-machine.md` exists with all required sections
- Verify all 16+ states are accounted for in the review
- Verify findings reference Review 1 where relevant

Acceptance: Review document exists at `.ninthwave/reviews/02-state-machine.md` with complete state transition analysis, all states accounted for, findings referencing specific line numbers, and cross-references to Review 1 findings.

Key files: `core/orchestrator.ts`
