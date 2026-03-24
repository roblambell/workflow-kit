# Contributing to ninthwave

## Development Setup

Clone the repo:

```bash
git clone git@github.com:ninthwave-sh/ninthwave.git ~/code/ninthwave
```

### Prerequisites

- [Bun](https://bun.sh/) — runtime and test runner
- [gh](https://cli.github.com/) — PR operations
- [cmux](https://cmux.com/) — parallel terminal sessions (for testing `/work`)

### Dogfooding (developing ninthwave with ninthwave)

ninthwave dogfoods itself. The repo IS the bundle — a symlink at `.claude/skills/ninthwave` points back to the repo root so skills are discoverable during development:

```bash
cd ~/code/ninthwave
mkdir -p .claude/skills
ln -s ../.. .claude/skills/ninthwave
bun run core/cli.ts setup
```

After this, `/work`, `/decompose`, `/todo-preview`, and `/ninthwave-upgrade` are available in the ninthwave repo itself.

### Testing in another project

```bash
cd /path/to/your/project
~/code/ninthwave/core/cli.ts setup
```

Changes to source files take effect immediately (the dev install runs TypeScript directly via Bun).

## Architecture

```
ninthwave/                          # The repo IS the installable bundle
├── core/
│   ├── cli.ts                      # CLI entry point (TypeScript + Bun)
│   ├── commands/                   # CLI command implementations
│   ├── parser.ts                   # TODOS.md parser
│   └── docs/todos-format.md        # TODOS.md format reference
├── skills/                         # SKILL.md files (cross-tool standard)
│   ├── work/SKILL.md               # /work — batch orchestration
│   ├── decompose/SKILL.md          # /decompose — feature breakdown
│   ├── todo-preview/SKILL.md       # /todo-preview — dev servers
│   └── ninthwave-upgrade/SKILL.md  # /ninthwave-upgrade — self-update
├── agents/
│   └── todo-worker.md              # Copied to all tool agent directories by setup
└── README.md
```

### Design Principles

- **Self-contained bundle.** The repo itself is the installable unit. Brew installs the compiled binary + resource files. Dev mode runs TypeScript directly via Bun.
- **Project-specific context lives in the project**, not in ninthwave. The worker reads the project's instruction file (`CLAUDE.md`, `AGENTS.md`, etc.) for coding conventions, test commands, and architecture docs.
- **Skills are discovered via symlinks** — `ninthwave setup` creates `.claude/skills/work -> ninthwave/skills/work` etc. so AI tools find the skills without scattering files across the project.
- **Agents are copied to all tool directories** — `.claude/agents/`, `.opencode/agents/`, `.github/agents/`. Any team member works regardless of tool.
- **Expected skills are soft dependencies** — `/review`, `/qa`, etc. are used if available, with built-in fallbacks when they're not.

### Key Files

| File | What it does |
|------|-------------|
| `core/cli.ts` | The CLI entry point. Routes commands to `core/commands/` which handle worktrees/partitions, AI session launches, PR monitoring, and version bumps. TypeScript + Bun. |
| `core/commands/setup.ts` | The `ninthwave setup` command. Creates project-level config: `.ninthwave/` dir, CLI shim, skill symlinks, agent copies. |
| `skills/work/SKILL.md` | The orchestration skill. Drives the 5-phase workflow (select, launch, monitor, merge, finalize). |
| `skills/decompose/SKILL.md` | Breaks feature specs into PR-sized work items with dependency batches. |
| `agents/todo-worker.md` | The worker prompt. Each AI session follows this: read the TODO, read project conventions, implement, test, review, PR, wait for orchestrator. |

### How the Pieces Fit

1. **User runs `/decompose`** — the decompose skill explores the codebase, breaks the feature into work items, writes them to `TODOS.md`
2. **User runs `/work`** — the work skill reads `TODOS.md`, presents selection options, then calls `.ninthwave/work start` to create worktrees and launch AI sessions via cmux
3. **`.ninthwave/work start`** (shim → `ninthwave` binary) auto-detects the AI tool, creates a git worktree per item, allocates a partition for port/DB isolation, and launches each session with the `todo-worker` agent
4. **Each worker session** reads `CLAUDE.md`/`AGENTS.md` for project conventions, implements the TODO, runs tests, creates a PR, then idles waiting for orchestrator messages
5. **The orchestrator** (the `/work` skill session) monitors PR status, dispatches CI fixes and review feedback to workers via `cmux send`, merges PRs, rebases dependents, and handles version bumping

### TypeScript Development

The CLI is implemented in TypeScript and runs via Bun. No build step needed — Bun executes `.ts` files directly.

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

Changes to `.ts` files take effect immediately on the next invocation — no compilation needed.

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

External contributors: fork the repo and open a PR against `main`. The `main` branch is protected — direct pushes require maintainer access.

## Licence

MIT — see [LICENSE](LICENSE).
