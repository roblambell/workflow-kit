# ninthwave

Parallel AI coding orchestration. TypeScript + Bun CLI.

## Development

```bash
bun test              # run tests (vitest)
bun run core/cli.ts   # run CLI directly
```

No build step — Bun executes TypeScript directly. Changes take effect immediately.

## Architecture

- `core/cli.ts` — CLI entry point and command dispatcher
- `core/commands/` — one file per command (list, start, clean, watch, etc.)
- `core/parser.ts` — TODOS.md parsing and domain normalization
- `skills/` — SKILL.md files for AI tool integration (/work, /decompose, etc.)
- `agents/todo-worker.md` — worker agent prompt (copied to all tool directories by setup)
- `core/commands/setup.ts` — project setup command (seeds config, symlinks, agents)

## Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Tests live in `test/` using vitest with `vi.mock` for external dependencies
- **Mock isolation:** `bun test` (our CI runner) does not isolate `vi.mock` between test files — mocks leak across files and break unrelated tests. Prefer dependency injection (pass collaborators as function arguments) over `vi.mock`. Only use `vi.mock` when the mocked module is not imported by any other test file. When in doubt, inject.
- No runtime dependencies beyond Bun — keep it self-contained
- Convention over configuration — sensible defaults, minimal config files

## Dogfooding Mode

This repo uses ninthwave to develop ninthwave. When working here:

1. **Log friction.** Any issue, slowdown, or surprising behavior you encounter while using ninthwave tools (the CLI, /work, /decompose, workers, orchestrator) is valuable signal. Append observations to the friction log at `~/.claude/projects/-Users-roblambell-code-ninthwave/memory/project_dogfood_friction.md`.

2. **Workers auto-merge.** When processing TODOs in this repo, workers should create PRs with auto-merge enabled (`gh pr merge --squash --auto` after PR creation). This keeps the feedback loop tight.

3. **Continuous delivery.** The orchestrator should not stop after one batch. Process all dependency batches sequentially until TODOS.md is empty. If friction was logged during a batch, decompose actionable friction into new TODOs and continue.

4. **Self-improvement loop.** The goal is: decompose → work → merge → check friction → decompose friction into TODOs → work → repeat until no actionable friction remains.
