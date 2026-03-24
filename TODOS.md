# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Brew Distribution (brew install pivot, 2026-03-23)









### Feat: Create Homebrew tap and formula (H-BREW-4)

**Priority:** High
**Source:** Brew distribution pivot
**Depends on:** H-BREW-3
**Repo:** homebrew-tap

Create the `ninthwave-sh/homebrew-tap` repository with a Homebrew formula at `Formula/ninthwave.rb`. The formula downloads the source tarball, compiles via `bun build --compile`, installs the binary to `bin/`, and installs resource files (skills, agents, docs, VERSION) to `share/ninthwave/`. Symlinks should use the Homebrew `opt` prefix for stability across upgrades. Test with `brew install --build-from-source`.

Acceptance: `brew tap ninthwave-sh/tap && brew install ninthwave` installs successfully. `ninthwave version` works after install. `ninthwave setup` in a project creates correct symlinks pointing into the Homebrew share directory.

Key files: `Formula/ninthwave.rb` (new, in homebrew-tap repo)

---

### Docs: Update README and CONTRIBUTING for brew distribution (M-BREW-6)

**Priority:** Medium
**Source:** Brew distribution pivot
**Depends on:** H-BREW-4

Update README.md installation section: `brew install ninthwave-sh/tap/ninthwave` as primary method, curl one-liner as fallback. Update the getting-started flow to use `ninthwave setup`. Remove references to git-clone installation as the primary path. Update CONTRIBUTING.md for the new development workflow (binary compilation, release process). Remove the bash `setup` script (replaced by `ninthwave setup`). Remove `remote-install.sh` or update it to install via brew.

Acceptance: README shows brew as the primary install method. CONTRIBUTING documents the build/release process. The bash `setup` script is removed. `bun test` passes.

Key files: `README.md`, `CONTRIBUTING.md`, `setup` (delete), `remote-install.sh` (delete or update)

---

## Event-Driven Orchestrator (orchestrator pivot, 2026-03-23)









### Feat: Implement orchestrator action execution (H-ORCH-7)

**Priority:** High
**Source:** Orchestrator pivot
**Depends on:** H-ORCH-6, H-ORCH-2, H-ORCH-4, H-ORCH-5

Add `executeAction(action)` method to the `Orchestrator` class. Action types: `launch` (calls `launchSingleItem`), `merge` (calls `prMerge`, pulls main, sends rebase requests to dependent workers), `notify-ci-failure` (sends CI failure details to worker via `cmux send`), `notify-review` (sends review comments to worker), `clean` (calls `cleanSingleWorktree`, closes workspace), `mark-done` (calls `cmdMarkDone`). Each action updates internal state on success. Post PR comments as audit trail for key actions.

Acceptance: Each action type executes correctly with mocked dependencies. State updates after action execution. Failed actions (merge conflict, missing workspace) are handled gracefully. Tests mock `gh.ts`, `cmux.ts`, `git.ts`, `start.ts`, `clean.ts`.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`

---

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
