# workflow-kit

Tool-agnostic batch TODO processing for AI coding assistants.

Decomposes features into PR-sized work items, launches parallel AI coding sessions to implement them, and orchestrates merging, rebasing, and version bumping.

## Supported AI Tools

Works with any tool that supports the [Agent Skills standard](https://agentskills.io):

- **Claude Code** -- skills from `.agents/skills/`, agent from `.claude/agents/`
- **OpenCode** -- discovers `.agents/skills/` natively, agent from `.opencode/agents/`
- **GitHub Copilot CLI** -- discovers `.agents/skills/` natively, agent from `.github/agents/`
- **Codex, Gemini CLI, Cursor, Kiro, Goose, Amp** -- all discover `.agents/skills/`

The tool is auto-detected from the orchestrator's environment. Workers launch with the same tool. Override with `WK_AI_TOOL=claude|opencode|copilot`.

## Dependencies

- **git** -- worktree management
- **gh** -- GitHub CLI for PR operations
- **cmux** -- terminal multiplexer for parallel sessions
- **gstack** -- provides `/review`, `/qa`, `/design-review` ([install](https://garryslist.org))
- An AI coding tool (Claude Code, OpenCode, Copilot CLI, etc.)

## Quick Start

```bash
# Clone the repo
git clone git@github.com:roblambell/workflow-kit.git ~/code/workflow-kit

# Install into your project (auto-detects installed tools)
cd /path/to/your/project
~/code/workflow-kit/install.sh

# Review and commit
git diff
git add -A && git commit -m "chore: install workflow-kit"
```

## What Gets Installed

### Core

| File | Purpose |
|------|---------|
| `scripts/batch-todos.sh` | CLI for parsing TODOS.md, managing worktrees, launching sessions, monitoring PRs |
| `docs/guides/todos-format.md` | Format reference for TODOS.md |
| `TODOS.md` | Work item file (created if missing) |
| `.workflow-kit/config` | Project-specific settings |
| `.workflow-kit/domains.conf` | Custom domain slug mappings |

### Skills (cross-tool, via `.agents/skills/`)

| Skill | Purpose |
|-------|---------|
| `/todos` | Interactive batch orchestration -- select, launch, monitor, merge, finalize |
| `/decompose` | Break a feature spec into TODO items with dependency batches |
| `/todo-preview` | Port-isolated dev servers for worktree testing |

### Agent

| File | Purpose |
|------|---------|
| `todo-worker` | Worker agent that implements a single TODO: read, implement, test, review, PR |

Installed to each detected tool's agent directory (`.claude/agents/`, `.opencode/agents/`, `.github/agents/`).

### From gstack (dependency)

| Skill | Used By | When |
|-------|---------|------|
| `/review` | todo-worker | Always -- pre-landing code review |
| `/design-review` | todo-worker | UI/visual changes |
| `/qa` | todo-worker | Bug fixes with UI impact |
| `/plan-eng-review` | `/decompose` | Optional architecture validation |

## How It Works

### 1. Decompose

Break a feature into TODO items:

```
/decompose
```

Or write them directly to `TODOS.md` following `docs/guides/todos-format.md`.

### 2. Process

Launch parallel AI sessions to implement TODOs:

```
/todos
```

This orchestrates: SELECT items, LAUNCH parallel sessions, MONITOR for PRs/CI/reviews, MERGE in order, FINALIZE with version bump.

### 3. Standalone CLI

```bash
scripts/batch-todos.sh list --ready          # List ready items
scripts/batch-todos.sh batch-order H-1 H-2   # Check dependency order
scripts/batch-todos.sh start H-1 H-2         # Launch sessions (auto-detects tool)
scripts/batch-todos.sh status                 # Check worktree status
scripts/batch-todos.sh watch-ready            # Watch PR readiness
scripts/batch-todos.sh version-bump           # Bump version from commits
```

## Project Configuration

### `.workflow-kit/config`

```bash
# File extensions for LOC counting in version-bump
LOC_EXTENSIONS="*.ts *.tsx *.py *.go"
```

### `.workflow-kit/domains.conf`

Map TODOS.md section headers to domain slugs:

```
auth=auth
infrastructure=infra
frontend=frontend
```

## Architecture

```
workflow-kit/
├── core/
│   ├── batch-todos.sh          # Universal CLI (auto-detects AI tool)
│   └── docs/todos-format.md
├── skills/                     # Cross-tool SKILL.md files
│   ├── todos/SKILL.md
│   ├── decompose/SKILL.md
│   └── todo-preview/SKILL.md
├── agents/
│   └── todo-worker.md          # Worker agent (installed to tool-specific dirs)
├── install.sh                  # Auto-detect tools, place files
└── README.md
```

**Design principle:** Project-specific context lives in the project's instruction file (`CLAUDE.md`, `AGENTS.md`, etc.), not in workflow-kit. The worker reads the project's instructions for coding conventions, test commands, and architecture docs.

## Updating

Re-run the install script. It overwrites core files but preserves project-specific config:

```bash
~/code/workflow-kit/install.sh --project-dir /path/to/project
git diff  # review changes
git commit -am "chore: update workflow-kit"
```
