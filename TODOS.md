# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Brew Distribution (brew install pivot, 2026-03-23)



### Feat: Add bundle directory resolution module (H-BREW-1)

**Priority:** High
**Source:** Brew distribution pivot
**Depends on:** None

Create `core/paths.ts` with a `getBundleDir()` function that resolves the ninthwave resource directory (skills, agents, docs). Resolution chain: (1) `NINTHWAVE_HOME` env var, (2) binary install prefix — if `process.argv[0]` is at `<prefix>/bin/ninthwave`, check `<prefix>/share/ninthwave/`, (3) development fallback — walk up from source file to find repo root containing `skills/work/SKILL.md`. This replaces the `.ninthwave/dir` mechanism and is the foundation for all subsequent brew work.

Acceptance: `getBundleDir()` returns correct path in dev mode (`bun run core/cli.ts`). Returns correct path when `NINTHWAVE_HOME` is set. Tests cover all three resolution paths. Module is exported and importable.

Key files: `core/paths.ts` (new), `test/paths.test.ts` (new)

---

### Feat: Port setup script to TypeScript CLI command (H-BREW-2)

**Priority:** High
**Source:** Brew distribution pivot
**Depends on:** H-BREW-1

Create `core/commands/setup.ts` that replaces the bash `setup` script. Wire it as `ninthwave setup` in `cli.ts`. Two modes: `ninthwave setup` (project — seeds `.ninthwave/`, TODOS.md, skill symlinks, agent copies, .gitignore) and `ninthwave setup --global` (user — seeds `~/.claude/skills/` symlinks only). Uses `getBundleDir()` from `core/paths.ts` to resolve skill/agent source paths. Also add `ninthwave version` command that reads VERSION from bundle dir. Update `cli.ts` to support commands that don't need a project root (`setup`, `version`).

Acceptance: `bun run core/cli.ts setup` in a git repo creates the same artifacts as the bash `setup` script. `bun run core/cli.ts setup --global` creates skill symlinks in `~/.claude/skills/`. `bun run core/cli.ts version` prints the version. Tests cover project setup, global setup, idempotency (running twice produces same result), and preserving existing config files.

Key files: `core/commands/setup.ts` (new), `core/cli.ts`, `test/setup.test.ts` (new), `setup` (reference for porting)

---

### Feat: Add binary compilation and release pipeline (H-BREW-3)

**Priority:** High
**Source:** Brew distribution pivot
**Depends on:** H-BREW-2

Add `bun build --compile` support. Add build scripts to `package.json` for macOS ARM64, macOS x64, and Linux x64 targets. Create `.github/workflows/release.yml` that triggers on tag push (`v*`), builds binaries, creates a GitHub Release with attached binaries. Add a compile smoke test to CI (`bun build --compile` + `./dist/ninthwave version`). Add `dist/` to `.gitignore`.

Acceptance: `bun run build` produces a working binary at `dist/ninthwave`. The binary runs `ninthwave version`, `ninthwave setup --help`, and `ninthwave list` correctly. CI includes a compile smoke test. Release workflow builds and publishes binaries on tag push.

Key files: `package.json`, `.github/workflows/release.yml` (new), `.github/workflows/ci.yml`, `.gitignore`

---

### Feat: Create Homebrew tap and formula (H-BREW-4)

**Priority:** High
**Source:** Brew distribution pivot
**Depends on:** H-BREW-3
**Repo:** homebrew-tap

Create the `ninthwave-sh/homebrew-tap` repository with a Homebrew formula at `Formula/ninthwave.rb`. The formula downloads the source tarball, compiles via `bun build --compile`, installs the binary to `bin/`, and installs resource files (skills, agents, docs, VERSION) to `share/ninthwave/`. Symlinks should use the Homebrew `opt` prefix for stability across upgrades. Test with `brew install --build-from-source`.

Acceptance: `brew tap ninthwave-sh/tap && brew install ninthwave` installs successfully. `ninthwave version` works after install. `ninthwave setup` in a project creates correct symlinks pointing into the Homebrew share directory.

Key files: `Formula/ninthwave.rb` (new, in homebrew-tap repo)

---

### Refactor: Simplify shim and update upgrade skill for brew (M-BREW-5)

**Priority:** Medium
**Source:** Brew distribution pivot
**Depends on:** H-BREW-2

Update the shim template in `core/commands/setup.ts` to generate `exec ninthwave "$@"` (no bun dependency, no `.ninthwave/dir`). Keep writing `.ninthwave/dir` for backward compatibility with existing skill references. Rewrite `skills/ninthwave-upgrade/SKILL.md` to detect install type: if `brew list ninthwave` succeeds, suggest `brew upgrade ninthwave`; if `.ninthwave/dir` points to a git repo, keep current git-pull behavior. Update TODOS.md template comment to use a URL instead of the `$(cat .ninthwave/dir)` shell expansion.

Acceptance: New projects get the simplified shim. The upgrade skill correctly detects brew vs git installs. TODOS.md template uses a stable reference for the format guide.

Key files: `core/commands/setup.ts`, `skills/ninthwave-upgrade/SKILL.md`, `.ninthwave/work`

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



### Refactor: Export internal watch functions for orchestrator reuse (H-ORCH-1)

**Priority:** High
**Source:** Orchestrator pivot
**Depends on:** None

Export `checkPrStatus`, `getWatchReadyState`, `findTransitions`, and `findGoneItems` as public functions from `watch.ts`. Currently these are private helpers used only by the CLI commands. The orchestrator needs direct access to them. Also add a finer-grained status classification: split `ready` into `ci-passed` (CI green, merge criteria not yet checked) vs `ready` (all merge criteria met) so the orchestrator can distinguish "CI passed but not approved" from "ready to merge".

Acceptance: All four functions are exported and importable. Existing `watch-ready`, `autopilot-watch`, `pr-watch`, `pr-activity` commands still work identically. New tests cover the exported functions directly. Status output includes `ci-passed` as a distinct state.

Key files: `core/commands/watch.ts`, `test/watch.test.ts`

---

### Feat: Add prMerge and prComment to GitHub module (H-ORCH-2)

**Priority:** High
**Source:** Orchestrator pivot
**Depends on:** None

Add `prMerge(repoRoot, prNumber, method)` that runs `gh pr merge <N> --squash --delete-branch` and returns success boolean. Add `prComment(repoRoot, prNumber, body)` that runs `gh pr comment <N> --body <body>`. These are the orchestrator's primary GitHub write operations — currently done ad-hoc in bash but not available as TypeScript functions.

Acceptance: `prMerge` merges a PR and returns true on success, false on failure. `prComment` posts a comment. Both are unit-tested with mocked `gh` calls. Existing `gh.ts` tests still pass.

Key files: `core/gh.ts`, `test/gh.test.ts` (new)

---

### Refactor: Extract computeBatches from batch-order command (H-ORCH-3)

**Priority:** High
**Source:** Orchestrator pivot
**Depends on:** None

Extract the topological sort and batch grouping logic from `cmdBatchOrder` into a reusable `computeBatches(items, selectedIds)` function that returns `Map<string, number>` (item ID to batch number) and a batch count. The command function becomes a thin wrapper that calls `computeBatches` and formats the output. The orchestrator needs this to know which items to launch when dependencies clear.

Acceptance: `computeBatches` returns correct batch assignments. `cmdBatchOrder` output is unchanged. All existing batch-order tests pass. New tests cover `computeBatches` directly with edge cases (circular deps, single item, all independent).

Key files: `core/commands/batch-order.ts`, `test/batch-order.test.ts`

---

### Refactor: Extract launchSingleItem from start command (H-ORCH-4)

**Priority:** High
**Source:** Orchestrator pivot
**Depends on:** None

Extract the per-item launch logic from `cmdStart` into a standalone `launchSingleItem(item, todosFile, worktreeDir, projectRoot, aiTool)` function that creates one worktree, allocates a partition, and launches one cmux session. Returns `{ worktreePath, workspaceRef }`. The existing `cmdStart` becomes a loop over items calling `launchSingleItem`. The orchestrator needs this to launch items one at a time as WIP slots open.

Acceptance: `launchSingleItem` creates a worktree and launches a session for a single item. `cmdStart` produces identical behavior to before. All existing start tests pass. New tests cover single-item launch.

Key files: `core/commands/start.ts`, `test/start.test.ts`

---

### Feat: Define orchestrator types and state machine (H-ORCH-6)

**Priority:** High
**Source:** Orchestrator pivot
**Depends on:** H-ORCH-1

Create `core/orchestrator.ts` with the `OrchestratorItemState` type (queued, ready, launching, implementing, pr-open, ci-pending, ci-passed, ci-failed, review-pending, merging, merged, done, stuck), `OrchestratorItem` interface, `OrchestratorConfig` interface, and the `Orchestrator` class with state management methods. The class's `processTransitions(currentState)` method is pure — it takes a poll snapshot, compares against internal state, and returns an array of `Action` objects describing what to do. No side effects. This makes the state machine fully testable without mocks.

Acceptance: `Orchestrator` class correctly tracks item states. `processTransitions` returns correct actions for all state transitions (CI pass → merge action, CI fail → notify action, PR merged → clean action, batch complete → launch next). WIP limit is respected. Merge strategy (`asap`/`approved`/`ask`) gates merge actions correctly. Fully unit-tested with at least 15 test cases.

Key files: `core/orchestrator.ts` (new), `core/types.ts`, `test/orchestrator.test.ts` (new)

---

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
