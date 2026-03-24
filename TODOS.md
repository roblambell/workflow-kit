# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Security Hardening (prompt injection mitigation, 2026-03-24)




### Feat: Lock PRs and filter comments by author association (H-SEC-1)

**Priority:** High
**Source:** Prompt injection risk — public PR comments are an untrusted input channel that agentic workers act on

Lock automated PR conversations immediately after creation to prevent non-collaborators from commenting. Add `author_association` filtering to `cmdPrActivity` and `cmdWaitForActivity` so only comments from `OWNER`, `MEMBER`, or `COLLABORATOR` are reported as activity. Update the worker agent prompt to note that only trusted-origin feedback should be acted on.

Implementation:
1. Add a `prLock(projectRoot, prNumber)` function to `core/gh.ts` that calls `PUT /repos/{owner}/{repo}/issues/{issue_number}/lock` via `gh api`.
2. Call `prLock` in the worker's PR creation step (after `gh pr create`) and in the orchestrator's launch action.
3. In `core/commands/watch.ts`, filter the jq queries in `cmdPrActivity` and `cmdWaitForActivity` to only count comments where `.author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`.
4. Update `agents/todo-worker.md` "Review Feedback" section to note that feedback is pre-filtered to trusted collaborators by the toolchain.

Acceptance: PRs opened by workers are locked immediately after creation. `pr-activity` and `wait-for-activity` ignore comments from non-collaborators. `bun test` passes. Manual test: a comment from a non-collaborator on a locked PR is rejected by GitHub; if lock fails gracefully (e.g., insufficient permissions), the author_association filter still blocks untrusted input.

Key files: `core/gh.ts`, `core/commands/watch.ts`, `agents/todo-worker.md`, `test/watch.test.ts`

---

## Event-Driven Orchestrator (orchestrator pivot, 2026-03-23)













### Feat: Implement event loop and orchestrate CLI command (H-ORCH-8)

**Priority:** High
**Source:** Orchestrator pivot
**Depends on:** H-ORCH-7, H-ORCH-3

Create `core/commands/orchestrate.ts` with `cmdOrchestrate`. Implements: arg parsing (`--items`, `--merge-strategy`, `--wip-limit`, `--poll-interval`, `--orchestrator-ws`), state reconstruction from existing worktrees/PRs on startup (crash recovery), the main event loop (poll all items, detect transitions, execute actions, check batch progression, adaptive sleep), structured logging to stdout, and graceful SIGINT handling. Wire into `cli.ts`. The adaptive poll interval: 30s when workers active, 120s when waiting for reviews, 10s between batches.

Acceptance: `ninthwave orchestrate --items H-X-1,H-X-2 --merge-strategy asap` processes items through the full lifecycle. Structured log output shows transitions and actions. Graceful shutdown on SIGINT. Can resume after restart (reconstructs state from disk + GitHub). Integration test runs a full batch cycle with mocked dependencies.

Key files: `core/commands/orchestrate.ts` (new), `core/cli.ts`, `test/orchestrate.test.ts` (new)

---

### Docs: Update /work skill to use orchestrate command (M-ORCH-9)

**Priority:** Medium
**Source:** Orchestrator pivot
**Depends on:** H-ORCH-8

Rewrite Phases 2-5 of `skills/work/SKILL.md`. Phase 1 (SELECT) stays interactive. After selection, the skill launches `ninthwave orchestrate --items <IDs> --merge-strategy <strategy> --wip-limit <N>` instead of manually calling `start` and polling. Phases 3 (WAIT), 4 (MERGE), 5 (FINALIZE) collapse into monitoring the daemon's output. Add a note that users can also run `ninthwave orchestrate` directly from a terminal without an AI tool session.

Acceptance: The `/work` skill delegates orchestration to the daemon after item selection. The skill no longer contains manual poll/merge/clean logic. Documentation is clear about both usage modes (skill-driven and CLI-driven).

Key files: `skills/work/SKILL.md`

---

### Docs: Update worker agent for daemon-driven orchestration (M-ORCH-10)

**Priority:** Medium
**Source:** Orchestrator pivot
**Depends on:** H-ORCH-8

Update `agents/todo-worker.md` to reference the new `[ORCHESTRATOR]` message format from the deterministic daemon. Clarify that the orchestrator is now a TypeScript process (not an LLM). Adjust the "Idle" phase to note that the daemon handles all post-PR lifecycle automatically (merge, rebase, cleanup). Workers still need to respond to CI fix requests and review feedback sent via `cmux send`.

Acceptance: Worker agent prompt accurately describes the daemon-driven workflow. No references to LLM orchestrator polling. Message format examples match what the daemon sends.

Key files: `agents/todo-worker.md`

---

## Vision (recurring, 2026-03-23)













### Feat: Explore vision, scope next iteration, and decompose into TODOs (L-VIS-1)

**Priority:** Low
**Source:** Self-improvement loop
**Depends on:** M-BREW-6, M-ORCH-9, M-ORCH-10

This is a recurring meta-item. When all other TODOs are complete, this item triggers a new cycle: (1) Review the current state of ninthwave against the product vision — what's shipped, what's missing, what friction was logged. (2) Read the friction log and identify actionable improvements. (3) Identify the next most impactful capability or refinement. (4) Decompose it into TODO items following the standard format. (5) Add a new copy of this same item (L-VIS-2, L-VIS-3, etc.) depending on the new terminal items, so the cycle continues. This keeps ninthwave moving toward feature-completeness unattended.

Acceptance: New TODO items are written to TODOS.md. A new vision exploration item is added depending on the new terminal items. The friction log is reviewed and actionable items are addressed. TODOS.md is non-empty after this item completes (unless the vision is fully realized).

Key files: `TODOS.md`, `CLAUDE.md`, `README.md`

---
