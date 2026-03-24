# ninthwave

Parallel AI coding orchestration. TypeScript + Bun CLI.

## Development

```bash
bun test              # run all tests
bun run core/cli.ts   # run CLI directly
```

No build step — Bun executes TypeScript directly. Changes take effect immediately.

## Architecture

- `core/cli.ts` — CLI entry point and command dispatcher
- `core/commands/` — one file per command (list, start, clean, watch, etc.)
- `core/parser.ts` — reads `.ninthwave/todos/` directory and domain normalization
- `skills/` — SKILL.md files for AI tool integration (/work, /decompose, etc.)
- `agents/todo-worker.md` — worker agent prompt (copied to all tool directories by setup)
- `core/commands/setup.ts` — project setup command (seeds config, symlinks, agents)

## Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Tests live in `test/` using bun's native test runner (vitest-compatible API via `import { describe, it, expect, vi } from "vitest"`)
- **Mock isolation:** `bun test` does not isolate `vi.mock` between test files — mocks leak across files and break unrelated tests. Prefer dependency injection (pass collaborators as function arguments) over `vi.mock`. Only use `vi.mock` when the mocked module is not imported by any other test file. When in doubt, inject.
- **Always run `bun test test/`** (scoped to test directory) to avoid picking up tests from `.worktrees/` during orchestration
- No runtime dependencies beyond Bun — keep it self-contained
- Convention over configuration — sensible defaults, minimal config files

## Dogfooding Mode

This repo uses ninthwave to develop ninthwave. When working here, **dogfooding self-improvement mode is the default** — follow the full loop below unless explicitly asked to skip it.

### Basics

1. **Log friction.** Any issue, slowdown, or surprising behavior you encounter while using ninthwave tools (the CLI, /work, /decompose, workers, orchestrator) is valuable signal. Append observations to the friction log at `~/.claude/projects/-Users-roblambell-code-ninthwave/memory/project_dogfood_friction.md`.

2. **Workers auto-merge.** When processing TODOs in this repo, workers should create PRs with auto-merge enabled (`gh pr merge --squash --auto` after PR creation). This keeps the feedback loop tight.

3. **WIP limit ≤ 5.** Each worker session (Claude Code + language server + worktree) consumes ~2-3GB RAM. On a 16GB Mac, WIP limit of 5 is the default; reduce if memory pressure is observed.

4. **Always use worktree isolation for parallel agents.** When spawning agents that work on branches in the same repo, use `isolation: "worktree"` so each gets its own working copy. Never have two agents share a checkout.

### Self-Improvement Loop (default behavior)

The full dogfooding cycle runs automatically unless the user explicitly opts out:

1. **Process all code TODOs.** Launch the orchestrator on all ready items. It handles dependency batches, CI, merging, and cleanup automatically.

2. **Pause before the vision TODO.** When all code items are done but before running the recurring vision item (L-VIS-N), stop and review friction.

3. **Review friction.** Read the friction log and run it through `/plan-ceo-review` (scope/ambition) and `/plan-eng-review` (architecture/execution). This ensures friction fixes are well-scoped and well-designed before decomposition.

4. **Decompose friction into TODOs.** Use `/decompose` to break actionable friction into TODO items in `.ninthwave/todos/` so they're processed before the vision item.

5. **Process friction TODOs.** Launch the orchestrator again on the new friction-derived items.

6. **Run the vision TODO.** Once no actionable friction remains, process the recurring vision item (L-VIS-N). This explores what's next, decomposes new work, and adds a new vision item (L-VIS-N+1) depending on the new terminal items.

7. **Repeat.** Go back to step 1 with the new TODOs from the vision exploration. The cycle continues indefinitely: code → friction review → friction fixes → vision → new code → repeat.

### Opting Out

If the user explicitly asks to skip the self-improvement loop (e.g., "just process the items" or "no friction review"), process items straight through without pausing. Ask the user at the start of `/work` if there's any ambiguity.
