# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Operational Maturity (vision exploration, 2026-03-24)


### Feat: Memory-aware dynamic WIP limits (H-WIP-1)

**Priority:** High
**Source:** Vision — prevent OOM on memory-constrained machines
**Depends on:** None

The WIP limit is currently a static number (default 5). Each worker consumes ~2.5GB (AI tool + language server + worktree). On a 16GB Mac with other processes, launching 5 workers risks OOM. Use `os.freemem()` and `os.totalmem()` to estimate available capacity at each batch launch. Cap WIP at `floor(availableMemory / 2.5GB)` with a minimum of 1 and a maximum of the configured limit. Log when WIP is reduced due to memory pressure.

**Test plan:**
- Unit test: WIP calculation returns correct values for various memory scenarios
- Unit test: WIP never drops below 1
- Unit test: WIP respects configured maximum even when memory allows more
- Edge case: system reports 0 free memory (should still allow 1 worker)

Acceptance: WIP limit is dynamically calculated based on available memory. Workers are queued when memory is constrained instead of launching immediately. Structured log emitted when WIP is reduced. Tests pass. No regression in orchestrator tests.

Key files: `core/commands/orchestrate.ts`, `core/orchestrator.ts`

---


### Feat: Automatic worker retry on crash or OOM (M-RET-1)

**Priority:** Medium
**Source:** Vision — resilience improvement for production use
**Depends on:** H-WIP-1

When a worker transitions to "stuck" due to heartbeat timeout or workspace death, automatically retry once before marking as permanently stuck. Clean up the failed worktree, create a fresh one, and relaunch the worker. Add `retryCount` to `OrchestratorItem` and `maxRetries` to `OrchestratorConfig` (default: 1). Log retries as structured events. Only mark as permanently stuck after exhausting retries.

**Test plan:**
- Unit test: stuck worker triggers retry transition when retryCount < maxRetries
- Unit test: retry creates fresh worktree and relaunches worker
- Unit test: permanently stuck after maxRetries exhausted
- Unit test: retryCount is tracked in item metrics for analytics
- Edge case: worker crashes during retry (second attempt counts correctly)

Acceptance: Workers that crash are retried once automatically with a fresh worktree. Retry count is tracked per item and reflected in analytics. Items are permanently stuck only after exhausting retries. Retries are logged as structured events. Tests pass. No regression in orchestrator state machine tests.

Key files: `core/orchestrator.ts`, `core/commands/orchestrate.ts`, `core/commands/clean.ts`

---

## Engineering Review (vision exploration, 2026-03-24)


### Docs: Engineering review — core orchestrator and state machine (H-ENG-1)

**Priority:** High
**Source:** Vision — comprehensive architecture audit
**Depends on:** None

Run `/plan-eng-review` on the core orchestrator: state machine (`core/orchestrator.ts`), command driver (`core/commands/orchestrate.ts`), and supporting modules (shell execution, git operations, lock management). Audit: state transition correctness, error handling at boundaries, race conditions in concurrent operations, recovery robustness, and test coverage gaps. Document findings in a `docs/reviews/eng-review-orchestrator.md` file. For each finding that requires a code change, add a new TODO item to TODOS.md with the appropriate priority, description, and test plan.

**Test plan:**
- Run `/plan-eng-review` targeting orchestrator modules
- Verify review document is comprehensive (covers all 13 states and transitions)
- Verify each actionable finding has a corresponding TODO with acceptance criteria

Acceptance: `docs/reviews/eng-review-orchestrator.md` exists with structured findings. Every actionable finding (not just observations) has a corresponding TODO added to TODOS.md. Review covers: state transitions, error handling, race conditions, recovery paths, and test coverage. No code changes in this TODO — findings only.

Key files: `core/orchestrator.ts`, `core/commands/orchestrate.ts`, `core/shell.ts`, `core/git.ts`, `core/lock.ts`, `test/orchestrator.test.ts`, `test/orchestrate.test.ts`

---

### Docs: Engineering review — worker lifecycle and communication (H-ENG-2)

**Priority:** High
**Source:** Vision — comprehensive architecture audit
**Depends on:** None

Run `/plan-eng-review` on the worker lifecycle: launch (`core/commands/start.ts`), multiplexer abstraction (`core/mux.ts`, `core/cmux.ts`), message sending (`core/send-message.ts`), heartbeat monitoring, cleanup (`core/commands/clean.ts`), and reconciliation (`core/commands/reconcile.ts`). Audit: worker launch reliability, message delivery guarantees, heartbeat accuracy, cleanup completeness, and cross-platform edge cases (cmux vs tmux). Document findings in `docs/reviews/eng-review-workers.md`. Add TODOs for actionable findings.

**Test plan:**
- Run `/plan-eng-review` targeting worker lifecycle modules
- Verify review covers both cmux and tmux code paths
- Verify each actionable finding has a corresponding TODO

Acceptance: `docs/reviews/eng-review-workers.md` exists with structured findings. Every actionable finding has a corresponding TODO added to TODOS.md. Review covers: launch reliability, message delivery, heartbeat accuracy, cleanup completeness, and multiplexer edge cases. No code changes in this TODO — findings only.

Key files: `core/commands/start.ts`, `core/mux.ts`, `core/cmux.ts`, `core/send-message.ts`, `core/commands/clean.ts`, `core/commands/reconcile.ts`, `test/start.test.ts`, `test/mux.test.ts`, `test/clean.test.ts`, `test/reconcile.test.ts`

---

### Docs: Engineering review — data pipeline (parser, analytics, webhooks, templates) (M-ENG-3)

**Priority:** Medium
**Source:** Vision — comprehensive architecture audit
**Depends on:** None

Run `/plan-eng-review` on the data pipeline: TODOS.md parser (`core/parser.ts`), analytics (`core/analytics.ts`, `core/commands/analytics.ts`), webhooks (`core/webhooks.ts`), decomposition templates (`core/templates.ts`), cross-repo resolution (`core/cross-repo.ts`), and configuration (`core/config.ts`). Audit: parser robustness with malformed input, analytics data integrity, webhook failure handling, template extensibility, and cross-repo edge cases. Document findings in `docs/reviews/eng-review-data-pipeline.md`. Add TODOs for actionable findings.

**Test plan:**
- Run `/plan-eng-review` targeting data pipeline modules
- Verify review covers edge cases in parser (malformed TODOS.md, missing fields)
- Verify each actionable finding has a corresponding TODO

Acceptance: `docs/reviews/eng-review-data-pipeline.md` exists with structured findings. Every actionable finding has a corresponding TODO added to TODOS.md. Review covers: parser robustness, analytics integrity, webhook failure handling, template extensibility, and cross-repo edge cases. No code changes in this TODO — findings only.

Key files: `core/parser.ts`, `core/analytics.ts`, `core/commands/analytics.ts`, `core/webhooks.ts`, `core/templates.ts`, `core/cross-repo.ts`, `core/config.ts`, `test/parser.test.ts`, `test/analytics.test.ts`, `test/webhooks.test.ts`, `test/templates.test.ts`

---

## Vision (recurring, 2026-03-24)


### Feat: Explore vision, scope next iteration, and decompose into TODOs (L-VIS-5)

**Priority:** Low
**Source:** Self-improvement loop
**Depends on:** ANL-*, WIP-*, GHI-*, DAE-*, RET-*, ENG-*

This is a recurring meta-item. When all other TODOs are complete, this item triggers a new cycle: (1) Review the current state of ninthwave against the product vision — what's shipped, what's missing, what friction was logged. (2) Read the friction log and identify actionable improvements. (3) Identify the next most impactful capability or refinement. (4) Decompose it into TODO items following the standard format. (5) Add a new copy of this same item (L-VIS-6, etc.) depending on the new terminal items, so the cycle continues.

Acceptance: New TODO items are written to TODOS.md. A new vision exploration item is added depending on the new terminal items. The friction log is reviewed and actionable items are addressed. TODOS.md is non-empty after this item completes.

Key files: `TODOS.md`, `CLAUDE.md`, `README.md`, `vision.md`

---
