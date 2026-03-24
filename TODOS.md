# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Multiplexer Abstraction (vision L-VIS-3, 2026-03-24)






### Feat: Auto-detect multiplexer and add --mux flag (M-MUX-3)

**Priority:** Medium
**Source:** L-VIS-3 vision review
**Depends on:** H-MUX-2

Add multiplexer auto-detection to `getMux()`: (1) check `NINTHWAVE_MUX` env var for explicit override, (2) check if inside a cmux session (cmux-specific env vars), (3) check if inside a tmux session (`TMUX` env var), (4) check if cmux binary is available, (5) fall back to tmux. Add `--mux cmux|tmux` flag to `orchestrate` and `start` commands that sets `NINTHWAVE_MUX` before resolving the adapter. Thread the selected `Multiplexer` instance through the dependency chain via the existing `OrchestratorDeps` / `ExecutionContext` patterns.

**Test plan:**
- Unit test: auto-detection picks cmux when cmux env var is present
- Unit test: auto-detection picks tmux when TMUX env var is present
- Unit test: `NINTHWAVE_MUX=tmux` override works
- Unit test: `--mux` CLI flag is parsed and threaded through

Acceptance: Auto-detection picks the correct multiplexer based on environment. `--mux` flag overrides detection in `start` and `orchestrate`. `NINTHWAVE_MUX` env var works. Clear error message if no multiplexer is available.

Key files: `core/mux.ts`, `core/commands/start.ts`, `core/commands/orchestrate.ts`, `test/mux.test.ts`

---

### Docs: Update README and setup for tmux support (M-MUX-4)

**Priority:** Medium
**Source:** L-VIS-3 vision review
**Depends on:** M-MUX-3

Update README.md prerequisites table to list cmux or tmux as alternatives (cmux recommended for visual sidebar, tmux for headless/existing setups). Update the "How It Works" section to mention multiplexer flexibility. Update `ninthwave setup` to detect which multiplexer is available and include it in the post-setup summary. Add a brief "Using with tmux" section in the README explaining the difference.

**Test plan:**
- Review: README prerequisites section lists both multiplexers
- Review: Setup output mentions detected multiplexer
- Unit test: setup detects tmux availability when cmux is not available

Acceptance: README prerequisites show cmux and tmux as alternatives. Setup detects and reports available multiplexer. A user with only tmux installed sees clear guidance on how to proceed.

Key files: `README.md`, `core/commands/setup.ts`, `test/setup.test.ts`

---

## Vision (recurring, 2026-03-24)






### Feat: Explore vision, scope next iteration, and decompose into TODOs (L-VIS-4)

**Priority:** Low
**Source:** Self-improvement loop
**Depends on:** H-MUX-2, M-MUX-3, M-MUX-4, H-DF-1, H-DF-2, M-DF-3, M-DF-4, L-DF-5

This is a recurring meta-item. When all other TODOs are complete, this item triggers a new cycle: (1) Review the current state of ninthwave against the product vision — what's shipped, what's missing, what friction was logged. (2) Read the friction log and identify actionable improvements. (3) Identify the next most impactful capability or refinement. (4) Decompose it into TODO items following the standard format. (5) Add a new copy of this same item (L-VIS-5, etc.) depending on the new terminal items, so the cycle continues.

Acceptance: New TODO items are written to TODOS.md. A new vision exploration item is added depending on the new terminal items. The friction log is reviewed and actionable items are addressed. TODOS.md is non-empty after this item completes.

Key files: `TODOS.md`, `CLAUDE.md`, `README.md`, `vision.md`

---

## Dogfood Friction Fixes (friction decomposition, 2026-03-24)






### Refactor: Workers remove their own TODO item in PRs instead of orchestrator push (H-DF-1)

**Priority:** High
**Source:** Friction #23 — mark-done push race with concurrent auto-merges
**Depends on:** None

Pivot mark-done ownership: workers remove their TODO item from TODOS.md as part of their PR branch (before opening the PR), so merging the PR automatically removes the item from main. Remove `executeMarkDone()` from the orchestrator state machine — no more raw commit+push to main after merge. Update `todo-worker.md` to instruct workers to delete their `### ... (ID)` block from TODOS.md before creating the PR. The orchestrator's `done` transition no longer needs a mark-done action. Reconcile remains as a safety net for edge cases (PRs that merge without removing their TODO).

**Test plan:**
- Unit test: orchestrator state machine no longer emits `mark-done` action after merge
- Unit test: `done` transition succeeds without mark-done side effect
- Integration test: verify reconcile still catches items merged without TODO removal
- Review: todo-worker.md includes instruction to remove TODO item before PR

Acceptance: Workers remove their own `### ... (ID)` block from TODOS.md in their PR branch. Orchestrator no longer calls `executeMarkDone()` or pushes to main. No push race condition possible. Reconcile still catches edge cases where a PR merges without removing its TODO.

Key files: `core/orchestrator.ts`, `agents/todo-worker.md`, `test/orchestrator.test.ts`

---

### Feat: Reconcile closes stale cmux workspaces for done items (H-DF-2)

**Priority:** High
**Source:** Friction #22 — zombie cmux workspaces left open after orchestrator exits
**Depends on:** None

Extract the workspace-closing logic from `cmdCloseWorkspaces()` in `clean.ts` into a shared helper (or call it directly from reconcile). After reconcile marks items done and cleans worktrees, it should also list cmux workspaces via `mux.listWorkspaces()`, match by TODO ID in the workspace name, and close any that correspond to done/merged items. This prevents zombie terminal sessions from accumulating across orchestrator runs.

**Test plan:**
- Unit test: reconcile calls workspace close for items it marks done
- Unit test: workspace matching correctly extracts TODO ID from workspace name
- Unit test: reconcile skips workspace close when no workspaces match
- Unit test: reconcile handles mux.listWorkspaces() returning empty list

Acceptance: Running `ninthwave reconcile` closes cmux workspaces for any items it marks done. Workspace matching uses the TODO ID pattern in the workspace name. No zombie workspaces remain after reconcile completes.

Key files: `core/commands/reconcile.ts`, `core/commands/clean.ts`, `test/reconcile.test.ts`

---

### Feat: Worker heartbeat via worktree commit tracking (M-DF-3)

**Priority:** Medium
**Source:** Friction #24 — can't distinguish active workers from hung ones
**Depends on:** None

Add `lastCommitTime` to the orchestrator's snapshot builder by running `git log -1 --format=%cI` on each worktree branch. Pass this to the supervisor prompt as an additional signal alongside state duration. The supervisor can then distinguish "implementing for 8 min with commits 2 min ago" (healthy) from "implementing for 8 min with no commits" (likely stuck). This is a lightweight proxy — no worker-side changes needed, just reading git log from the worktree.

**Test plan:**
- Unit test: snapshot builder includes `lastCommitTime` for implementing items
- Unit test: `lastCommitTime` is null when worktree has no commits beyond base
- Unit test: supervisor prompt includes commit freshness information
- Edge case: worktree branch doesn't exist yet (just launched)

Acceptance: Orchestrator snapshot includes `lastCommitTime` per item. Supervisor prompt shows commit freshness alongside state duration. Supervisor can distinguish active workers (recent commits) from stalled ones (no recent commits). No changes to worker code.

Key files: `core/commands/orchestrate.ts`, `core/supervisor.ts`, `test/orchestrate.test.ts`

---

### Fix: Truncate long domain slugs to max 40 characters (L-DF-5)

**Priority:** Low
**Source:** Friction #4 — domain slug from long section headers is unwieldy for --domain filter
**Depends on:** None

Cap domain slugs at 40 characters in `normalizeDomain()`. If the auto-slugified result exceeds the limit, truncate at the last complete hyphen-separated word that fits within 40 chars (don't cut mid-word). This keeps `--domain` filters usable without requiring custom domain mappings in `.ninthwave/domains.conf`.

**Test plan:**
- Unit test: short slugs (<= 40 chars) are unchanged
- Unit test: long slug is truncated at word boundary
- Unit test: slug of exactly 40 chars is not truncated
- Unit test: custom domain mappings in domains.conf still take priority over truncation

Acceptance: `normalizeDomain()` returns slugs of at most 40 characters. Truncation happens at hyphen boundaries (no mid-word cuts). Existing short slugs and custom mappings are unaffected.

Key files: `core/parser.ts`, `test/parser.test.ts`

---
