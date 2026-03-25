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
- One external dependency: [nono](https://github.com/nicholasgasior/nono) for worker sandboxing (installed automatically via `brew install ninthwave`). ninthwave gracefully degrades without it — workers run unsandboxed but functional
- Convention over configuration — sensible defaults, minimal config files

## Dogfooding Mode

This repo uses ninthwave to develop ninthwave. When working here, **dogfooding self-improvement mode is the default** — follow the full loop below unless explicitly asked to skip it.

### Basics

1. **Log friction.** Any issue, slowdown, or surprising behavior you encounter while using ninthwave tools (the CLI, /work, /decompose, workers, orchestrator) is valuable signal. Append observations to the friction log at `~/.claude/projects/-Users-roblambell-code-ninthwave/memory/project_dogfood_friction.md`.

2. **Workers auto-merge.** When processing TODOs in this repo, workers should create PRs with auto-merge enabled (`gh pr merge --squash --auto` after PR creation). This keeps the feedback loop tight.

3. **WIP limit ≤ 5.** Each worker session (Claude Code + language server + worktree) consumes ~2-3GB RAM. On a 16GB Mac, WIP limit of 5 is the default; reduce if memory pressure is observed.

4. **Always use worktree isolation for parallel agents.** When spawning agents that work on branches in the same repo, use `isolation: "worktree"` so each gets its own working copy. Never have two agents share a checkout.

### Self-Improvement Loop (default behavior)

`/work` handles the full dogfooding cycle automatically. Its Phase 3 continuous delivery loop includes friction review, friction decomposition, and vision exploration — no separate commands needed.

The cycle: process all ready TODOs → review friction log → decompose actionable friction into new TODOs → process friction TODOs → run vision item (L-VIS-N) → repeat with new TODOs from vision.

Between batches, `/work` pauses at checkpoints to report progress and confirm continuation. The friction log is reviewed before the vision item runs, ensuring friction fixes ship before new features are explored.

### Opting Out

If the user explicitly asks to skip the self-improvement loop (e.g., "just process the items" or "no friction review"), process items straight through without pausing. Ask the user at the start of `/work` if there's any ambiguity.
