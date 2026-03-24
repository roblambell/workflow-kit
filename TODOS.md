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

## Wildcard Dependencies (2026-03-24)




### Feat: Support wildcard patterns in Depends on fields (H-WLD-1)

**Priority:** High
**Source:** CEO roadmap review — needed for cleaner dependency declarations
**Depends on:** None

Already implemented. Parser now supports wildcard patterns in `**Depends on:**` fields: `MUX-*` matches all items with that domain code (any priority), `H-MUX-*` matches only high-priority MUX items. Two-pass parsing: first pass collects all literal IDs, second pass expands wildcards. Expansion function `expandWildcardDeps()` is exported and tested.

**Test plan:**
- Unit test: domain wildcard `MUX-*` matches all MUX items across priorities
- Unit test: priority-prefixed wildcard `H-MUX-*` matches only high-priority
- Unit test: multiple wildcards in one depends line
- Unit test: self-exclusion (item doesn't depend on itself)
- Integration test: parseTodos expands wildcards during parsing
- Integration test: mixed literal and wildcard deps

Acceptance: `**Depends on:** MUX-*` in TODOS.md correctly expands to all MUX items. Batch ordering and orchestrator readiness work with expanded deps. All existing tests pass.

Key files: `core/parser.ts`, `core/types.ts`, `test/parser.test.ts`

---

## Zero-Config Onboarding (short-term, 2026-03-24)




### Feat: Add ninthwave init command with auto-detection (H-INI-1)

**Priority:** High
**Source:** CEO roadmap — #1 adoption priority
**Depends on:** WLD-*

Add `ninthwave init` command that auto-detects the project environment and configures everything in one step. Detect: (1) repo structure (monorepo vs single), (2) CI system (GitHub Actions workflows in `.github/workflows/`), (3) available multiplexer (cmux binary, tmux, TMUX env var), (4) existing AI tool config (`.claude/`, `.opencode/`, `.github/copilot-instructions.md`). Write `.ninthwave/config` with detected settings. Run existing `setup` logic for scaffolding. Print a summary of what was detected and configured. Different from `setup` in that it requires zero manual input — pure auto-detection.

**Test plan:**
- Unit test: detects GitHub Actions from `.github/workflows/*.yml`
- Unit test: detects cmux when binary exists on PATH
- Unit test: detects tmux when TMUX env var is set
- Unit test: detects Claude Code from `.claude/` directory
- Unit test: writes `.ninthwave/config` with detected values
- Integration test: full `init` on a fresh repo creates working setup

Acceptance: Running `ninthwave init` in any git repo produces a working ninthwave setup with zero manual input. The command detects CI, mux, and AI tool automatically. Output shows what was detected. `ninthwave list` works immediately after init.

Key files: `core/commands/init.ts` (new), `core/cli.ts`, `core/commands/setup.ts` (reuse detection logic), `test/init.test.ts` (new)

---

### Feat: Detect and configure CI system during init (M-INI-2)

**Priority:** Medium
**Source:** CEO roadmap — init needs CI awareness for orchestrator
**Depends on:** H-INI-1

Extend init to write CI-specific config: detect test command from `package.json` scripts (`test`, `check`, `lint`), detect CI workflow file names, write `.ninthwave/config` fields `ci_provider=github-actions`, `test_command=bun test`. The orchestrator can later use these to verify CI status without hardcoding assumptions.

**Test plan:**
- Unit test: detects `bun test` from package.json scripts
- Unit test: detects `npm test` as fallback
- Unit test: writes `ci_provider` and `test_command` to config
- Unit test: handles missing package.json gracefully

Acceptance: After `ninthwave init`, `.ninthwave/config` contains `ci_provider` and `test_command` fields. Values match the project's actual CI setup.

Key files: `core/commands/init.ts`, `test/init.test.ts`

---

## Terminal Status UI (short-term, 2026-03-24)




### Feat: Rewrite status command with structured real-time display (H-STU-1)

**Priority:** High
**Source:** CEO roadmap — professional terminal status UI
**Depends on:** WLD-*

Rewrite `ninthwave status` to show a structured, colored terminal display. Show each active item with: ID, title (truncated), current state (color-coded: green=merged, yellow=implementing, red=ci-failed, blue=review), PR number, and time in current state. Show batch progress (e.g., "Batch 2/4: 3 merged, 1 implementing, 1 ci-pending"). Show summary line with totals. Use ANSI color codes from existing `core/output.ts` utilities.

**Test plan:**
- Unit test: formats item rows with correct color codes per state
- Unit test: batch progress line shows correct counts
- Unit test: handles zero items gracefully
- Unit test: truncates long titles to terminal width
- Integration test: `ninthwave status` produces parseable output

Acceptance: `ninthwave status` shows a clean, colored table of active items with state indicators. Batch progress is visible. Output is readable on standard 80-column terminal.

Key files: `core/commands/status.ts` (rewrite), `core/output.ts`, `test/status.test.ts` (new)

---

### Feat: Auto-open status pane in cmux during orchestration (M-STU-2)

**Priority:** Medium
**Source:** CEO roadmap — real-time visibility in cmux
**Depends on:** H-STU-1

When the orchestrator runs inside cmux, auto-open a dedicated pane that runs `ninthwave status --watch` (polling loop that refreshes every 5 seconds). The pane opens alongside worker panes so the operator can see both agent interactions and orchestration progress. Use `mux.launchWorkspace()` with a special workspace name (e.g., `nw-status`). Close the status pane automatically when orchestration completes via the existing clean logic.

**Test plan:**
- Unit test: orchestrator launches status pane via mux.launchWorkspace
- Unit test: status pane uses `nw-status` workspace name
- Unit test: status pane is closed on orchestration complete
- Unit test: `--watch` flag triggers polling refresh loop
- Unit test: no status pane opened when mux is not available

Acceptance: Running `ninthwave orchestrate` in cmux opens a status pane that updates in real-time. The pane closes when orchestration finishes. No status pane if running outside cmux.

Key files: `core/commands/orchestrate.ts`, `core/commands/status.ts`, `test/orchestrate.test.ts`

---

## Webhook Notifications (mid-term, 2026-03-24)




### Feat: Fire webhooks on orchestrator lifecycle events (M-WHK-1)

**Priority:** Medium
**Source:** CEO roadmap — team visibility via Slack/Discord
**Depends on:** MUX-*, DF-*, INI-*, STU-*

Add webhook support to the orchestrator. Read `NINTHWAVE_WEBHOOK_URL` env var (or `.ninthwave/config` field `webhook_url`). On key events (batch_complete, pr_merged, ci_failed, orchestrate_complete), POST a JSON payload to the webhook URL with event type, item details, and summary stats. Use `fetch()` (built into Bun). Fire-and-forget — don't block orchestration on webhook delivery. Log webhook failures but don't treat them as orchestration errors.

**Test plan:**
- Unit test: webhook fires on batch_complete event with correct payload
- Unit test: webhook fires on ci_failed with item details
- Unit test: no webhook when NINTHWAVE_WEBHOOK_URL is not set
- Unit test: webhook failure is logged but doesn't block orchestration
- Unit test: payload includes event type, item IDs, and summary stats

Acceptance: Setting `NINTHWAVE_WEBHOOK_URL` causes the orchestrator to POST JSON on lifecycle events. Slack/Discord incoming webhooks receive formatted messages. Missing or failing webhook URL doesn't affect orchestration.

Key files: `core/commands/orchestrate.ts`, `core/webhooks.ts` (new), `test/webhooks.test.ts` (new)

---

## Decomposition Templates (mid-term, 2026-03-24)




### Feat: Add decomposition template library for common patterns (M-TPL-1)

**Priority:** Medium
**Source:** CEO roadmap — deepen decomposition quality moat
**Depends on:** INI-*

Create a `templates/` directory with markdown decomposition templates for common work patterns. Each template defines: pattern name, typical item breakdown (e.g., "Rails feature" = model + migration + controller + view + tests), dependency relationships between items, and suggested LOC budget per item. Update `/decompose` skill to detect matching patterns and offer templates during Phase 2 (EXPLORE). Templates are advisory — the skill can deviate based on codebase analysis.

**Test plan:**
- Review: templates/ directory contains at least 3 patterns (API endpoint, frontend component, database migration)
- Review: /decompose SKILL.md references templates directory
- Unit test: template loading from templates/ directory
- Unit test: template matching against feature description

Acceptance: `templates/` contains at least 3 well-structured decomposition templates. `/decompose` offers matching templates when applicable. Templates improve decomposition consistency without being rigid.

Key files: `templates/` (new directory), `skills/decompose/SKILL.md`, `core/templates.ts` (new, optional)

---

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
