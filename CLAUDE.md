# ninthwave

Parallel AI coding orchestration. TypeScript + Bun CLI.

**Required reading:** [ETHOS.md](ETHOS.md) -- core principles and hard boundaries.

## Development

```bash
task setup            # install git hooks (run once after cloning)
bun run test          # run the full CI-equivalent suite (unit + system)
bun run test:unit     # run unit/contract/scenario/smoke tests only (fast, excludes test/system/)
bun run test:system   # run system integration tests only (test/system/, slow)
bun run test:pre-commit  # run the hook-equivalent safety gate
bun run core/cli.ts   # run CLI directly
```

No build step -- Bun executes TypeScript directly. Changes take effect immediately.

## Architecture

- `core/cli.ts` -- CLI entry point and command dispatcher
- `core/commands/` -- one file per command (list, launch, clean, watch, init, etc.)
- `core/commands/orchestrate.ts` -- `nw` orchestration event loop with TUI mode (interactive) and JSON mode (`--json` for piping/CI)
- `core/parser.ts` -- reads `.ninthwave/work/` directory and domain normalization
- `core/status-render.ts` -- shared status table rendering for `ninthwave status --watch` and the daemon TUI
- `skills/` -- SKILL.md files for AI tool integration (/decompose, etc.)
- `agents/implementer.md` -- implementation agent prompt (copied to all tool directories by init)
- `core/commands/init.ts` -- project setup command (seeds config and managed tool copies)

## Conventions

- **Filesystem boundary:** ninthwave operates within the project directory and `~/.ninthwave/` only. It does not write to `~/.copilot/`, `~/.claude/`, `~/.config/`, or any other tool-specific user config. If a tool requires external setup, document it -- don't automate it.
- **Name casing:** use `Ninthwave` when referring to the product in prose. Use lowercase only for commands, package names, repo names, and filesystem paths such as `nw`, `ninthwave status`, `ninthwave-sh/tap/ninthwave`, and `.ninthwave/`.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Tests live in `test/` using bun's native test runner (vitest-compatible API via `import { describe, it, expect, vi } from "vitest"`)
- **Mock isolation:** `bun test` does not isolate `vi.mock` between test files -- mocks leak across files and break unrelated tests. Prefer dependency injection (pass collaborators as function arguments) over `vi.mock`. Only use `vi.mock` when the mocked module is not imported by any other test file. When in doubt, inject.
- **Always run `bun run test`** for the full suite. If you invoke Bun directly, use `bun test test/` (scoped to `test/`) to avoid picking up tests from `.ninthwave/.worktrees/` during orchestration.
- Convention over configuration -- sensible defaults, minimal config files
- **VISION.md is forward-looking only.** Do not add completion markers (`*(complete)*`, strikethrough `~~done~~`, `(Shipped.)`, `Decomposed →`) to VISION.md. Completed work belongs in CHANGELOG.md. Vision workers should remove or collapse shipped sections, not annotate them.

## Test Safety

- Full-suite runs have three layers of timeout protection: 5s per-test (bun default), 300s global process timeout (`test/setup-global.ts` via preload), and 120s shell-level timeout (CI).
- Use `bun run test:unit` for fast feedback during development. Use `bun run test` for full verification before PRs.
- `--smol` flag is used on all test runs for tighter GC. `--bail` fails fast on first failure.
- Pre-commit runs `bun run test:pre-commit`, which executes `test/lint-tests.test.ts` with a 30s shell-level timeout.
- `test/lint-tests.test.ts` scans all test files under `test/` for dangerous patterns. It runs as part of the regular test suite and is the pre-commit safety gate.
- **Lint rules:** `no-leaked-server` (Bun.serve without cleanup), `no-uncleared-interval` (setInterval without clear), `no-long-timeout` (setTimeout > 30s), `no-unreset-globals` (globalThis override without restore), `no-leaked-mock` (vi.mock of module with its own test file), `no-describe-skip` (describe.skip/it.skip/test.skip).
- To suppress a lint rule: add `// lint-ignore: <rule-id>` on or above the flagged line.

## Dogfooding Mode

This repo uses ninthwave to develop ninthwave. When working here, log friction and follow the conventions below.

### Basics

1. **Log friction.** Any issue, slowdown, or surprising behavior you encounter while using ninthwave tools (the CLI, /decompose, workers, orchestrator) is valuable signal. Log friction entries to `.ninthwave/friction/` using the timestamped markdown format workers use.

2. **WIP limit ≤ 5.** Each worker session (Claude Code + language server + worktree) consumes ~2-3GB RAM. On a 16GB Mac, WIP limit of 5 is the default; reduce if memory pressure is observed.

3. **Always use worktree isolation for parallel agents.** When spawning agents that work on branches in the same repo, use `isolation: "worktree"` so each gets its own working copy. Never have two agents share a checkout.

4. **Edit canonical sources, not generated mirrors.** In this repo, `skills/`, `agents/`, and the root `CLAUDE.md` are the tracked sources of truth. Regenerated copies under `.claude/`, `.codex/`, `.opencode/`, and `.github/` are ignored here. This repo also keeps `.github/copilot-instructions.md` untracked.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming -> invoke office-hours
- Bugs, errors, "why is this broken", 500 errors -> invoke investigate
- Ship, deploy, push, create PR -> invoke ship
- QA, test the site, find bugs -> invoke qa
- Code review, check my diff -> invoke review
- Update docs after shipping -> invoke document-release
- Weekly retro -> invoke retro
- Design system, brand -> invoke design-consultation
- Visual audit, design polish -> invoke design-review
- Architecture review -> invoke plan-eng-review
