# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## State Reconciliation (friction log, 2026-03-24)

### Feat: Add `ninthwave reconcile` command for state reconciliation (H-REC-1)

**Priority:** High
**Source:** Friction log #17
**Depends on:** None

Add a `reconcile` CLI command that synchronizes TODOS.md with GitHub PR state and cleans up stale worktrees. The command should: (1) `git pull --rebase` to get latest main, (2) query `gh pr list --state merged` for `todo/*` branches and extract item IDs, (3) call `mark-done` for any merged item still open in TODOS.md, (4) remove worktrees for done items via `git worktree list` filtering, (5) `git add TODOS.md && git commit && git push` if changes were made. This is the single biggest source of friction in the /work loop — the skill repeatedly launched orchestrator runs for already-completed work because it trusted stale TODOS.md.

Acceptance: `ninthwave reconcile` pulls main, marks merged items done, cleans stale worktrees, and commits+pushes TODOS.md. Running it when everything is in sync is a no-op (no empty commits). Unit test verifies each step with injected dependencies. The command handles merge conflicts in TODOS.md during rebase gracefully (stash/pop or report).

Key files: `core/commands/reconcile.ts`, `core/cli.ts`, `test/reconcile.test.ts`

---

### Feat: Wire reconcile into /work skill phases (M-REC-2)

**Priority:** Medium
**Source:** Friction log #17
**Depends on:** H-REC-1

Update the /work SKILL.md to call `ninthwave reconcile` (or `.ninthwave/work reconcile`) at two points: (1) at the start of Phase 1 before running `list --ready`, and (2) in Phase 3 after each orchestrator exit before checking for remaining items. The skill instructions should mandate: "Never trust `list --ready` without reconciling first." Also update the orchestrator to call reconcile after each merge action so TODOS.md stays in sync during a run, not just at exit.

Acceptance: The /work SKILL.md includes reconcile calls in Phase 1 and Phase 3. The orchestrator calls reconcile after merge actions. Manual testing confirms that `list --ready` reflects actual GitHub state after reconcile runs.

Key files: `skills/work/SKILL.md`, `core/commands/orchestrate.ts`

---

## Vision (recurring, 2026-03-24)



### Feat: Explore vision, scope next iteration, and decompose into TODOs (L-VIS-3)

**Priority:** Low
**Source:** Self-improvement loop
**Depends on:** H-OL-2, H-CDL-1, M-TST-1, M-TCO-1, L-FRE-1

This is a recurring meta-item. When all other TODOs are complete, this item triggers a new cycle: (1) Review the current state of ninthwave against the product vision — what's shipped, what's missing, what friction was logged. (2) Read the friction log and identify actionable improvements. (3) Identify the next most impactful capability or refinement. (4) Decompose it into TODO items following the standard format. (5) Add a new copy of this same item (L-VIS-4, etc.) depending on the new terminal items, so the cycle continues.

Acceptance: New TODO items are written to TODOS.md. A new vision exploration item is added depending on the new terminal items. The friction log is reviewed and actionable items are addressed. TODOS.md is non-empty after this item completes.

Key files: `TODOS.md`, `CLAUDE.md`, `README.md`

---
