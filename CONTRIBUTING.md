# Contributing to ninthwave

## Development Setup

Clone the repo and link it as a global install for dogfooding:

```bash
git clone git@github.com:roblambell/ninthwave.git ~/code/ninthwave
```

### Dogfooding (developing ninthwave with ninthwave)

ninthwave dogfoods itself. The repo IS the bundle — a symlink at `.claude/skills/ninthwave` points back to the repo root so skills are discoverable during development:

```bash
cd ~/code/ninthwave
mkdir -p .claude/skills
ln -s ../.. .claude/skills/ninthwave
./setup
```

After this, `/work`, `/decompose`, `/todo-preview`, and `/ninthwave-upgrade` are available in the ninthwave repo itself.

### Testing in another project

```bash
cd /path/to/your/project
~/code/ninthwave/setup
```

Changes to source files take effect immediately (global installs point directly to the clone).

## Architecture

```
ninthwave/                          # The repo IS the installable bundle
├── core/
│   ├── batch-todos.sh              # Universal CLI (auto-detects AI tool)
│   └── docs/todos-format.md        # TODOS.md format reference
├── skills/                         # SKILL.md files (cross-tool standard)
│   ├── work/SKILL.md               # /work — batch orchestration
│   ├── decompose/SKILL.md          # /decompose — feature breakdown
│   ├── todo-preview/SKILL.md       # /todo-preview — dev servers
│   └── ninthwave-upgrade/SKILL.md  # /ninthwave-upgrade — self-update
├── agents/
│   └── todo-worker.md              # Copied to all tool agent directories by setup
├── setup                           # Project setup script
├── remote-install.sh               # One-liner remote installer
└── README.md
```

### Design Principles

- **Self-contained bundle.** The repo itself is the installable unit. Clone to `~/.claude/skills/ninthwave/` (global) or `.claude/skills/ninthwave/` (per-project). Setup creates minimal project-level config.
- **Project-specific context lives in the project**, not in ninthwave. The worker reads the project's instruction file (`CLAUDE.md`, `AGENTS.md`, etc.) for coding conventions, test commands, and architecture docs.
- **Skills are discovered via symlinks** — setup creates `.claude/skills/work -> ninthwave/skills/work` etc. so AI tools find the skills without scattering files across the project.
- **Agents are copied to all tool directories** — `.claude/agents/`, `.opencode/agents/`, `.github/agents/`. Any team member works regardless of tool.
- **Expected skills are soft dependencies** — `/review`, `/qa`, etc. are used if available, with built-in fallbacks when they're not.

### Key Files

| File | What it does |
|------|-------------|
| `core/batch-todos.sh` | The CLI backbone. Parses TODOS.md, manages worktrees/partitions, launches AI sessions, monitors PRs, handles version bumps. ~1900 lines of bash. |
| `skills/work/SKILL.md` | The orchestration skill. Drives the 5-phase workflow (select, launch, monitor, merge, finalize). |
| `skills/decompose/SKILL.md` | Breaks feature specs into PR-sized work items with dependency batches. |
| `agents/todo-worker.md` | The worker prompt. Each AI session follows this: read the TODO, read project conventions, implement, test, review, PR, wait for orchestrator. |
| `setup` | Creates project-level config: `.ninthwave/` dir, CLI shim, skill symlinks, agent copies. |

### How the Pieces Fit

1. **User runs `/decompose`** — the decompose skill explores the codebase, breaks the feature into work items, writes them to `TODOS.md`
2. **User runs `/work`** — the work skill reads `TODOS.md`, presents selection options, then calls `.ninthwave/work start` to create worktrees and launch AI sessions via cmux
3. **`.ninthwave/work start`** (shim → `core/batch-todos.sh`) auto-detects the AI tool, creates a git worktree per item, allocates a partition for port/DB isolation, and launches each session with the `todo-worker` agent
4. **Each worker session** reads `CLAUDE.md`/`AGENTS.md` for project conventions, implements the TODO, runs tests, creates a PR, then idles waiting for orchestrator messages
5. **The orchestrator** (the `/work` skill session) monitors PR status, dispatches CI fixes and review feedback to workers via `cmux send`, merges PRs, rebases dependents, and handles version bumping

## Pull Requests

External contributors: fork the repo and open a PR against `main`. The `main` branch is protected — direct pushes require maintainer access.

## Licence

MIT — see [LICENSE](LICENSE).
