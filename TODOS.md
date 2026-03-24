# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Reliability & DX (friction log iteration 2, 2026-03-24)

### Fix: Clean command should scope workspace closing to specified IDs (H-FIX-1)

**Priority:** High
**Source:** Friction log #9

The `clean` command's `cleanSingleWorktree` calls `cmux close-workspace` for ALL todo workspaces, not just the one being cleaned. This kills active worker sessions when you only want to clean a merged item. The orchestrator's `executeClean` calls `deps.closeWorkspace(item.workspaceRef)` correctly (scoped to one workspace), but if `cleanSingleWorktree` is also closing all workspaces, it's destructive. Audit `core/commands/clean.ts` to ensure only the targeted workspace is closed. The workspace ref or item ID should be used to scope the close.

Acceptance: Running `ninthwave clean H-1` when H-2 and H-3 have active workers only closes H-1's workspace. Other workers continue uninterrupted. Unit test verifies scoped closing.

Key files: `core/commands/clean.ts`, `test/clean.test.ts`

---

### Fix: Setup command should use relative symlinks (H-FIX-2)

**Priority:** High
**Source:** Friction log #1

The `setup` command creates skill symlinks using absolute paths. When the repo is moved or renamed, all symlinks break. Change `setupProject` in `core/commands/setup.ts` to compute relative paths from the symlink location to the target, using `path.relative()`. This makes setup resilient to repo moves and renames.

Acceptance: `ninthwave setup` creates relative symlinks for skills and agents. Symlinks survive `mv` of the project directory. Existing test coverage updated.

Key files: `core/commands/setup.ts`, `test/setup.test.ts`

---

### Feat: Memory-aware WIP defaults in orchestrate command (M-FIX-3)

**Priority:** Medium
**Source:** Friction log #11

Each parallel worker consumes ~2-3GB RAM (Claude Code + language server + git worktree). Running 8 workers on a 16GB machine caused an OOM crash. The `orchestrate` command should set a sensible default WIP limit based on available system memory. Use `os.totalmem()` to detect RAM and compute: `Math.max(2, Math.floor(totalGB / 3))` as the default. Log the computed default. Allow `--wip-limit` to override.

Acceptance: On a 16GB machine, default WIP is 5. On 8GB, default WIP is 2. The `--wip-limit` flag still overrides. Structured log shows the computed vs. overridden value. Unit test mocks `os.totalmem()` and verifies computation.

Key files: `core/commands/orchestrate.ts`, `test/orchestrate.test.ts`

---

### Docs: Update README CLI reference to include orchestrate command (M-DOC-1)

**Priority:** Medium
**Source:** Self-review

The README's CLI reference table lists all commands but is missing the new `orchestrate` command. Add it to the table. Also update the `/work` skill description in the Skills table to mention it delegates to `orchestrate`. Update the "What happens" column for the /work Monitor phase.

Acceptance: README CLI table includes `orchestrate --items ID1,ID2 [options]` with description. Skills table /work description is updated. No other README changes.

Key files: `README.md`

---

### Feat: Shim auto-resolves bundle path without .ninthwave/dir (M-FIX-4)

**Priority:** Medium
**Source:** Friction log #2
**Depends on:** H-FIX-2

The `.ninthwave/work` shim depends on `.ninthwave/dir` to find the ninthwave bundle. This file contains absolute paths and isn't committed to git. After a fresh clone, the shim fails silently. Change the shim to resolve the bundle path by: (1) checking if `ninthwave` is in PATH (brew install), (2) walking up the directory tree to find a ninthwave checkout (dev mode). Remove the dependency on `.ninthwave/dir`. Update `setup.ts` to generate the improved shim.

Acceptance: After `git clone` + `ninthwave setup`, the shim works without `.ninthwave/dir`. The `ninthwave` binary in PATH takes priority. Dev-mode fallback walks up to find `core/cli.ts`. Unit test verifies shim generation.

Key files: `core/commands/setup.ts`, `test/setup.test.ts`

---

### Feat: Add GitHub Actions CI workflow (M-CI-1)

**Priority:** Medium
**Source:** Self-review

The repo has no CI. PRs merge without automated test verification. Add a `.github/workflows/ci.yml` that runs `bunx vitest run` on push to main and on pull requests. Use the `oven-sh/setup-bun` action. Add a required status check named "CI Gate" to match the existing branch protection rule.

Acceptance: `bunx vitest run` runs on every PR. The workflow name is "CI" with a job named "CI Gate". Tests pass on the current codebase (excluding known pre-existing failures in setup.test.ts which use Bun APIs unavailable in the CI Node environment — skip those).

Key files: `.github/workflows/ci.yml`

---

### Feat: Workers log friction when dogfooding ninthwave (L-DX-1)

**Priority:** Low
**Source:** Friction log #7
**Depends on:** H-FIX-1

When the project being worked on IS the ninthwave repo (dogfooding), workers encounter friction but have no mechanism to report it. Add a step to `agents/todo-worker.md` that detects dogfooding mode (check if `skills/work/SKILL.md` exists in the project root) and, when active, appends friction observations to a friction log file at the end of the worker's run. The friction entry should include the TODO ID, a brief description, and the severity.

Acceptance: Worker agent prompt includes a dogfooding friction logging step. Detection is based on `skills/work/SKILL.md` existing in the project root. Friction is appended to `.ninthwave/friction.log`. The step is skipped for non-ninthwave projects.

Key files: `agents/todo-worker.md`

---

## LLM Supervisor (orchestrator intelligence layer, 2026-03-24)

### Feat: Add LLM supervisor tick to orchestrate event loop (H-SUP-1)

**Priority:** High
**Source:** Dogfooding insight
**Depends on:** M-FIX-3

The deterministic orchestrator daemon handles the mechanical lifecycle (poll, merge, clean) but can't apply judgment. Add a periodic "supervisor tick" to the orchestrate event loop that pipes recent structured logs + current state into an LLM prompt. The supervisor runs on a configurable interval (default: every 5 minutes, or at batch boundaries). It does NOT drive the loop — the daemon continues regardless. The supervisor produces structured observations.

The supervisor prompt receives: (1) the last N log entries since the previous tick, (2) current item states, (3) wall-clock elapsed time per item in each state. It answers:

1. **Anomaly detection** — Is anything stuck or abnormal? (worker idle too long, CI cycling on same error, PR open but no commits for 10+ minutes)
2. **Intervention suggestions** — Should I send a worker a hint? Retry? Escalate to human?
3. **Friction observations** — Anything surprising about how the pipeline is behaving
4. **Process improvements** — Patterns across workers that suggest systemic fixes (e.g., "3 workers hit the same import error — add a CLAUDE.md note")

Implementation: Add a `supervisorTick` function that calls an LLM (via the `claude` CLI or Anthropic SDK) with the supervisor prompt. The orchestrate loop calls it every `--supervisor-interval` seconds (default 300). Observations are: (a) logged as structured JSON events, (b) optionally appended to a friction log file (`--friction-log`), (c) actions (send message to worker, adjust WIP) are returned as suggested actions that the daemon can execute.

The supervisor is opt-in via `--supervisor` flag (off by default). When running in dogfooding mode (detected by `skills/work/SKILL.md` in project root), it activates automatically.

Acceptance: `ninthwave orchestrate --supervisor --items X,Y` periodically invokes the LLM supervisor. Observations appear in structured logs as `supervisor_tick` events. Friction is logged to `--friction-log` path when specified. Worker messages are sent when the supervisor suggests intervention. The daemon continues running if the supervisor call fails. Unit test verifies the tick interval logic and prompt construction (with mocked LLM call).

Key files: `core/commands/orchestrate.ts`, `core/supervisor.ts` (new), `test/supervisor.test.ts` (new)

---

### Docs: Update /work skill and worker agent for supervisor mode (M-SUP-2)

**Priority:** Medium
**Source:** Follows H-SUP-1
**Depends on:** H-SUP-1

Update `skills/work/SKILL.md` Phase 1 to add a supervisor toggle question: "Enable LLM supervisor? (monitors for anomalies, logs friction)" with options A) Yes (recommended for unattended runs) B) No (daemon only). Pass `--supervisor` flag when enabled. Update the Phase 2 ORCHESTRATE section to mention supervisor log events. Update `agents/todo-worker.md` to note that workers may receive supervisor-generated hints (prefixed `[SUPERVISOR]`) in addition to standard orchestrator messages.

Acceptance: /work skill asks about supervisor mode during selection. Orchestrate command includes `--supervisor` when enabled. Worker agent prompt documents `[SUPERVISOR]` message prefix.

Key files: `skills/work/SKILL.md`, `agents/todo-worker.md`

---

## Vision (recurring, 2026-03-24)

### Feat: Explore vision, scope next iteration, and decompose into TODOs (L-VIS-2)

**Priority:** Low
**Source:** Self-improvement loop
**Depends on:** M-FIX-4, M-CI-1, L-DX-1, M-SUP-2

This is a recurring meta-item. When all other TODOs are complete, this item triggers a new cycle: (1) Review the current state of ninthwave against the product vision — what's shipped, what's missing, what friction was logged. (2) Read the friction log and identify actionable improvements. (3) Identify the next most impactful capability or refinement. (4) Decompose it into TODO items following the standard format. (5) Add a new copy of this same item (L-VIS-3, etc.) depending on the new terminal items, so the cycle continues.

Acceptance: New TODO items are written to TODOS.md. A new vision exploration item is added depending on the new terminal items. The friction log is reviewed and actionable items are addressed. TODOS.md is non-empty after this item completes.

Key files: `TODOS.md`, `CLAUDE.md`, `README.md`

---
