# Review: Daemon Event Loop, Scheduling & Infrastructure (H-ER-5)

**Priority:** High
**Source:** Engineering review -- full codebase audit
**Depends on:** H-ER-4
**Domain:** eng-review

Read the daemon event loop, crew mode, scheduling system, analytics, and supporting infrastructure. This is the critical review for identifying features to strip. Reference findings from Reviews 1-4. Write findings to `.ninthwave/reviews/05-daemon-infrastructure.md`.

## Files to Review

- `core/daemon.ts` (697 LOC) -- event-driven daemon loop, state persistence
- `core/commands/orchestrate.ts` (3,706 LOC) -- main event loop, snapshot building, action execution, TUI rendering, keyboard handling, crew/schedule integration
- `core/crew.ts` (599 LOC) -- multi-daemon crew mode coordination
- `core/mock-broker.ts` (625 LOC) -- mock WebSocket broker for crew testing
- `core/schedule-runner.ts` -- scheduled task execution
- `core/schedule-eval.ts` -- cron expression evaluation
- `core/schedule-state.ts` -- scheduled task state management
- `core/schedule-files.ts` -- scheduled task file I/O
- `core/schedule-history.ts` -- scheduled task history
- `core/analytics.ts` (448 LOC) -- cost/token tracking
- `core/shell.ts` -- shell execution abstraction
- `core/preflight.ts` -- pre-flight checks
- `.ninthwave/reviews/01-types-data-model.md` through `04-git-github.md` -- prior reviews

## Review Criteria

1. **Multi-daemon safety:** Two daemons on the same project: PID race, state file last-write-wins corruption, partition overlap. Assess blast radius and likelihood.
2. **Crash recovery completeness:** Are there states that cannot be recovered? E.g., an item in "launching" state when the daemon crashes -- the workspace exists but the daemon lost the workspace ref.
3. **State file atomicity:** Is `writeStateFile` atomic (write-then-rename) or direct write? Corruption risk on crash mid-write?
4. **Event loop starvation:** A slow GitHub API call during `buildSnapshot` blocks all items. Are there timeout protections on individual API calls?
5. **Crew mode correctness:** WebSocket reconnection with state reconciliation. What happens when the server reassigns a claimed item to another daemon during a disconnect?
6. **Schedule WIP sharing:** Scheduled tasks consume from the shared WIP pool. Can a burst of scheduled tasks starve the main work item queue?
7. **TUI resource usage:** The poll loop makes N GitHub API calls per cycle. At scale, is there a rate limiting concern?
8. **`orchestrate.ts` complexity:** At 3,706 LOC, this is the largest file. Identify extraction candidates.

## Cross-Cutting Themes -- THIS IS THE CRITICAL FEATURE-STRIPPING REVIEW

### Theme A: Feature Necessity

This review must make clear recommendations on these features:

- **Crew mode** (`crew.ts` 599 LOC + `mock-broker.ts` 625 LOC = 1,224 LOC): Is anyone using multi-daemon coordination? Or is this speculative infrastructure for a future that has not arrived? If stripped, how much simpler does the daemon loop become? Trace all crew-mode code paths in `orchestrate.ts` and estimate how many LOC they add.
- **Scheduling** (`schedule-*.ts` ~1,500 LOC across 5 files): Is the cron scheduling system used? Or is it dead weight from a feature that was built but not adopted? Trace all schedule code paths in `orchestrate.ts`.
- **Analytics** (`analytics.ts` 448 LOC): Are users looking at cost/token reports, or is this internal instrumentation that nobody checks?
- **TUI complexity**: Keyboard shortcuts, panel modes, log viewer, help overlays, detail views -- are users actually using the TUI interactively, or do they just launch `nw watch` and check back? What is the minimum viable TUI?

### Theme B: Complexity Reduction

- `orchestrate.ts` at 3,706 LOC is the biggest file and the biggest target. How much of its complexity comes from crew mode, scheduling, and TUI features? If those were stripped/simplified, what would the core loop shrink to? Estimate LOC.
- Can `daemon.ts` and `orchestrate.ts` be unified or better decomposed?
- Is the `buildSnapshot` polling approach the simplest way to get the information needed?
- Are there redundant code paths in action execution?

## Output Format

Write to `.ninthwave/reviews/05-daemon-infrastructure.md` using the same structure. For Theme A, provide specific LOC counts for each feature area and a clear STRIP/KEEP/SIMPLIFY recommendation with justification.

**Test plan:**
- Verify `.ninthwave/reviews/05-daemon-infrastructure.md` exists with all required sections
- Verify crew mode, scheduling, analytics, and TUI each have explicit STRIP/KEEP/SIMPLIFY recommendations with LOC estimates
- Verify findings cross-reference Reviews 1-4

Acceptance: Review document exists at `.ninthwave/reviews/05-daemon-infrastructure.md` with clear, LOC-backed recommendations for each feature area (crew, scheduling, analytics, TUI) and a total "potential LOC reduction" estimate.

Key files: `core/daemon.ts`, `core/commands/orchestrate.ts`, `core/crew.ts`, `core/mock-broker.ts`, `core/schedule-runner.ts`, `core/schedule-eval.ts`, `core/schedule-state.ts`, `core/schedule-files.ts`, `core/schedule-history.ts`, `core/analytics.ts`, `core/shell.ts`, `core/preflight.ts`
