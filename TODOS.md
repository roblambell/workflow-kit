# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Event-Driven Orchestrator (orchestrator pivot, 2026-03-23)















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
