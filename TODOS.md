# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Time-to-Ship Analytics (mid-term, 2026-03-24)






### Feat: Emit structured metrics from orchestrator runs (H-ANL-1)

**Priority:** High
**Source:** CEO roadmap — data-driven pipeline improvement
**Depends on:** INI-*

After each orchestration run, write a structured JSON metrics file to `.ninthwave/analytics/`. Include: run timestamp, wall-clock duration, items attempted, items completed, items failed, CI retry count per item, merge strategy used, tool used per item (from worktree config). The existing `orchestrate_complete` event already has most of this data — extract and persist it. One file per run, named by timestamp.

**Test plan:**
- Unit test: metrics file written on orchestrate_complete
- Unit test: file contains wall-clock duration and item counts
- Unit test: CI retry count is tracked per item
- Unit test: metrics directory created if not exists
- Unit test: handles zero-item run gracefully

Acceptance: After every `ninthwave orchestrate` run, a JSON metrics file appears in `.ninthwave/analytics/`. File contains all required fields. Data is accurate (matches actual orchestration events).

Key files: `core/commands/orchestrate.ts`, `core/analytics.ts` (new), `test/analytics.test.ts` (new)

---

### Feat: Add ninthwave analytics command to display trends (M-ANL-2)

**Priority:** Medium
**Source:** CEO roadmap — visible ROI and improvement tracking
**Depends on:** H-ANL-1

Add `ninthwave analytics` command that reads `.ninthwave/analytics/*.json` files and displays trends: average wall-clock time per run, average items per batch, CI retry rate, total items shipped, items per day. Show last 10 runs by default, `--all` for full history. Colored output with trend arrows (↑↓→) comparing latest run to average.

**Test plan:**
- Unit test: parses metrics files correctly
- Unit test: computes averages across multiple runs
- Unit test: trend arrows show correct direction
- Unit test: handles single run (no trend) gracefully
- Unit test: `--all` flag includes all runs

Acceptance: `ninthwave analytics` shows a readable summary of orchestration performance over time. Trends are visible. Output works with piping/grep.

Key files: `core/commands/analytics.ts` (new), `core/cli.ts`, `test/analytics.test.ts`

---

## Vision (recurring, 2026-03-24)










### Feat: Explore vision, scope next iteration, and decompose into TODOs (L-VIS-4)

**Priority:** Low
**Source:** Self-improvement loop
**Depends on:** MUX-*, DF-*, WLD-*, INI-*, STU-*, WHK-*, TPL-*, ANL-*

This is a recurring meta-item. When all other TODOs are complete, this item triggers a new cycle: (1) Review the current state of ninthwave against the product vision — what's shipped, what's missing, what friction was logged. (2) Read the friction log and identify actionable improvements. (3) Identify the next most impactful capability or refinement. (4) Decompose it into TODO items following the standard format. (5) Add a new copy of this same item (L-VIS-5, etc.) depending on the new terminal items, so the cycle continues.

Acceptance: New TODO items are written to TODOS.md. A new vision exploration item is added depending on the new terminal items. The friction log is reviewed and actionable items are addressed. TODOS.md is non-empty after this item completes.

Key files: `TODOS.md`, `CLAUDE.md`, `README.md`, `vision.md`

---
