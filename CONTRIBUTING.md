# Contributing to ninthwave

## Development Setup

Clone the repo:

```bash
git clone git@github.com:ninthwave-sh/ninthwave.git ~/code/ninthwave
```

### Prerequisites

- [Bun](https://bun.sh/) -- runtime and test runner
- [gh](https://cli.github.com/) -- PR operations
- [cmux](https://cmux.com/) -- parallel terminal sessions (for testing `nw` orchestration)

### Dogfooding (developing ninthwave with ninthwave)

ninthwave dogfoods itself. The repo IS the bundle, so the tracked sources of truth are `skills/`, `agents/`, and the root `CLAUDE.md`. Re-run init to regenerate the managed copies used by local tools:

```bash
cd ~/code/ninthwave
bun run core/cli.ts init --yes
```

That refreshes managed copies under `.claude/`, `.opencode/`, and `.github/agents/` from the canonical sources. Project instruction files such as `CLAUDE.md`, `AGENTS.md`, and `.github/copilot-instructions.md` are user-owned inputs, so init reads them but never creates, overwrites, or prunes them. This repo keeps generated tool copies untracked via repo-local `.gitignore` rules so only the canonical sources are committed here; normal user repos can choose their own tracking policy.

### Testing in another project

```bash
cd /path/to/your/project
~/code/ninthwave/core/cli.ts setup
```

Changes to source files take effect immediately (the dev install runs TypeScript directly via Bun).

### CLI aliases

The CLI installs as both `ninthwave` (full name) and `nw` (short alias). `nw` is the recommended daily-driver command -- 2 chars, no conflicts with existing tools. Both names invoke the same binary.

When installed via Homebrew, the `nw` symlink is created automatically by the formula. For development, `ninthwave init` creates the symlink next to the `ninthwave` binary if it's in PATH.

## Architecture

> For a deep-dive into the orchestrator state machine, data flow, key abstractions, and extension points, see [ARCHITECTURE.md](ARCHITECTURE.md).

```
ninthwave/                          # The repo IS the installable bundle
├── core/
│   ├── cli.ts                      # CLI entry point (TypeScript + Bun)
│   ├── commands/                   # CLI command implementations
│   ├── parser.ts                   # Reads .ninthwave/work/ directory
│   └── docs/work-item-format.md     # Work item file format reference
├── skills/                         # SKILL.md files (cross-tool standard)
│   ├── decompose/SKILL.md          # /decompose -- feature breakdown
├── agents/
│   └── implementer.md              # Copied to all tool agent directories by setup
└── README.md
```

### Design Principles

- **Self-contained bundle.** The repo itself is the installable unit. Brew installs the compiled binary + resource files. Dev mode runs TypeScript directly via Bun.
- **Project-specific context lives in the project**, not in ninthwave. The worker reads project-owned instruction files (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, etc.) for coding conventions, test commands, and architecture docs, and treats them as read-only inputs.
- **Skills are installed as managed copies** -- `ninthwave init` copies `skills/` into `.claude/skills/` so tools can discover them without depending on a fixed bundle path.
- **Agents are copied to all tool directories** -- `.claude/agents/`, `.opencode/agents/`, `.github/agents/`. Any team member works regardless of tool.
- **Expected skills are soft dependencies** -- `/review`, `/qa`, etc. are used if available, with built-in fallbacks when they're not.

### Key Files

| File | What it does |
|------|-------------|
| `core/cli.ts` | The CLI entry point. Routes commands to `core/commands/` which handle worktrees/partitions, AI session launches, PR monitoring, and version bumps. TypeScript + Bun. |
| `core/commands/setup.ts` | Shared setup helpers for prerequisite checks plus managed skill/agent copy installation. |
| `skills/decompose/SKILL.md` | Breaks feature specs into PR-sized work items with dependency batches. |
| `agents/implementer.md` | The implementation agent prompt. Each AI session follows this: read the work item, read project conventions, implement, test, review, PR, wait for orchestrator. |

### How the Pieces Fit

1. **User runs `/decompose`** -- the decompose skill explores the codebase, breaks the feature into work items, writes them to `.ninthwave/work/`
2. **User runs `nw`** -- the CLI owns selection, orchestration settings, and the worker-launch flow
3. **The orchestrator** creates a git worktree per item, allocates a partition for port/DB isolation, and launches each session with the `ninthwave-implementer` agent
4. **Each worker session** reads `CLAUDE.md`/`AGENTS.md` for project conventions, implements the work item, runs tests, creates a PR, then idles waiting for orchestrator messages
5. **The orchestrator** monitors PR status, dispatches CI fixes and review feedback to workers via the multiplexer, merges PRs, rebases dependents, and handles version bumping

### TypeScript Development

The CLI is implemented in TypeScript and runs via Bun. No build step needed -- Bun executes `.ts` files directly.

```bash
# Run tests
bun test

# Run a specific test file
bun test test/parser.test.ts

# Run tests in watch mode
bun test --watch

# Run the CLI directly
bun run core/cli.ts list
bun run core/cli.ts batch-order H-1 H-2

# Type-check without running
bunx tsc --noEmit
```

Changes to `.ts` files take effect immediately on the next invocation -- no compilation needed.

### Building and Releasing

ninthwave is distributed as a compiled binary via Homebrew. The build and release pipeline is automated via GitHub Actions.

**Compiling locally:**

```bash
bun build core/cli.ts --compile --outfile ninthwave
```

This produces a standalone `ninthwave` binary that doesn't require Bun at runtime.

**Release process:**

1. Bump `VERSION` and update `CHANGELOG.md`
2. Push a git tag: `git tag v$(cat VERSION) && git push --tags`
3. GitHub Actions (`.github/workflows/release.yml`) automatically:
   - Compiles binaries for macOS (arm64/x64) and Linux (x64)
   - Creates a GitHub Release with the binaries attached
4. The Homebrew formula in [`ninthwave-sh/homebrew-tap`](https://github.com/ninthwave-sh/homebrew-tap) references the release tarball
5. Users update via `brew upgrade ninthwave`

## Pull Requests

External contributors: fork the repo and open a PR against `main`. The `main` branch is protected -- direct pushes require maintainer access.

## Licence

Apache 2.0 -- see [LICENSE](LICENSE).
