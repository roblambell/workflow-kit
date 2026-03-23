# Contributing to workflow-kit

## Development Setup

Clone the repo and install into a test project from your local copy:

```bash
git clone git@github.com:roblambell/workflow-kit.git ~/code/workflow-kit
cd /path/to/your/project
~/code/workflow-kit/install.sh
```

After making changes, re-run `install.sh` and review the diff in the target project.

## Architecture

```
workflow-kit/
├── core/
│   ├── batch-todos.sh          # Universal CLI (auto-detects AI tool)
│   └── docs/todos-format.md    # TODOS.md format reference
├── skills/                     # Cross-tool SKILL.md files
│   ├── work/SKILL.md           # /work -- batch orchestration
│   ├── decompose/SKILL.md      # /decompose -- feature breakdown
│   └── todo-preview/SKILL.md   # /todo-preview -- dev servers
├── agents/
│   └── todo-worker.md          # Installed to all tool agent directories
├── install.sh                  # Project installer (local clone)
├── remote-install.sh           # One-liner remote installer
└── README.md
```

### Design Principles

- **Project-specific context lives in the project**, not in workflow-kit. The worker reads the project's instruction file (`CLAUDE.md`, `AGENTS.md`, etc.) for coding conventions, test commands, and architecture docs.
- **Skills use `.agents/skills/`** -- the cross-tool standard from [agentskills.io](https://agentskills.io). One copy, discovered by all tools.
- **Agents are installed to all tool directories unconditionally** -- `.claude/agents/`, `.opencode/agents/`, `.github/agents/`. Any team member works regardless of tool.
- **Expected skills are soft dependencies** -- `/review`, `/qa`, etc. are used if available, with built-in fallbacks when they're not.

### Key Files

| File | What it does |
|------|-------------|
| `core/batch-todos.sh` | The CLI backbone. Parses TODOS.md, manages worktrees/partitions, launches AI sessions, monitors PRs, handles version bumps. ~1900 lines of bash. |
| `skills/work/SKILL.md` | The orchestration skill. Drives the 5-phase workflow (select, launch, monitor, merge, finalize). |
| `skills/decompose/SKILL.md` | Breaks feature specs into PR-sized work items with dependency batches. |
| `agents/todo-worker.md` | The worker prompt. Each AI session follows this: read the TODO, read project conventions, implement, test, review, PR, wait for orchestrator. |

### How the Pieces Fit

1. **User runs `/decompose`** -- the decompose skill explores the codebase, breaks the feature into work items, writes them to `TODOS.md`
2. **User runs `/work`** -- the work skill reads `TODOS.md`, presents selection options, then calls `batch-todos.sh start` to create worktrees and launch AI sessions via cmux
3. **`batch-todos.sh start`** auto-detects the AI tool (Claude Code, OpenCode, Copilot CLI), creates a git worktree per item, allocates a partition for port/DB isolation, and launches each session with the `todo-worker` agent
4. **Each worker session** reads `CLAUDE.md`/`AGENTS.md` for project conventions, implements the TODO, runs tests, creates a PR, then idles waiting for orchestrator messages
5. **The orchestrator** (the `/work` skill session) monitors PR status, dispatches CI fixes and review feedback to workers via `cmux send`, merges PRs, rebases dependents, and handles version bumping

## Pull Requests

External contributors: fork the repo and open a PR against `main`. The `main` branch is protected -- direct pushes require maintainer access.

## Licence

MIT -- see [LICENSE](LICENSE).
