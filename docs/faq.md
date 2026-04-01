# Frequently Asked Questions

## Getting Started

### What is ninthwave?

ninthwave is an orchestration layer for parallel AI coding sessions. It breaks features into human-reviewable work items, launches multiple AI coding sessions in parallel, manages dependencies between them, monitors CI, and auto-merges PRs when they pass.

The core loop: **Decompose. Run `nw`. Get merged PRs.**

Instead of running one AI session at a time -- writing code, creating a PR, waiting for CI, reviewing, merging, then starting the next -- ninthwave runs them all in parallel and handles the coordination automatically.

### What are the prerequisites?

- **Git** -- version control (you already have this)
- **GitHub CLI (`gh`)** -- for PR operations. Install via `brew install gh` and authenticate with `gh auth login`
- **Optional interactive backend** -- install [tmux](https://github.com/tmux/tmux/wiki) or [cmux](https://cmux.com) if you want attachable terminal sessions. Headless works by default, so neither mux is mandatory. `tmux` is a broadly available terminal option; `cmux` gives the richest sidebar/progress UI on macOS
- **An AI coding tool** -- at least one of: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://opencode.ai), or [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli)

### How do I install ninthwave?

**Via Homebrew (recommended):**

```bash
brew install ninthwave-sh/tap/ninthwave
```

**From source:**

```bash
git clone https://github.com/ninthwave-sh/ninthwave
cd ninthwave
bun install
bun run build
```

### How do I set up a project?

Run `nw init` in the root of your Git repository:

```bash
cd your-project
nw init
```

This auto-detects your project structure (CI system, AI tools, monorepo layout) and creates:

- `.ninthwave/` directory with configuration
- Managed skill copies for `/decompose`
- Managed agent files (implementer, reviewer, forward-fixer) in your AI tool directories

Project instruction files such as `CLAUDE.md`, `AGENTS.md`, and `.github/copilot-instructions.md` are read-only inputs. ninthwave reads them for context and tool detection, but does not create, overwrite, or prune them.

No manual configuration is needed for the common case.

### How do I verify my setup?

```bash
nw doctor
```

This checks all prerequisites, configuration, and connectivity. It will tell you exactly what's missing or misconfigured.

---

## Core Concepts

### What is a work item?

A work item is a single unit of work sized for one PR (roughly 200-400 lines of code). It's a markdown file stored in `.ninthwave/work/` with a title, description, acceptance criteria, test plan, and dependency information.

`.ninthwave/work/` is the live queue of open work, not a permanent tracker. Completed items disappear from that directory on purpose so it always answers "what is still open?" rather than mixing open and closed work together.

Example filename: `1-auth--H-AUTH-1.md`

The filename encodes priority (`1` = high), domain (`auth`), and a unique ID (`H-AUTH-1`). The ID format is `<Priority>-<Domain>-<Number>` where priority is C (critical), H (high), M (medium), or L (low).

Each work item file includes:

- **Priority** -- determines processing order
- **Depends on** -- other items that must complete first
- **Domain** -- logical grouping (e.g., auth, frontend, infra)
- **Test plan** -- what tests the worker must write or verify
- **Acceptance criteria** -- definition of done

### Why do completed items disappear from `.ninthwave/work/`?

Because `.ninthwave/work/` is an active queue, not a `done/` board. When a work item finishes, its PR removes the file so the queue stays focused on work that still needs attention.

Retrospective lookup happens in the systems that already record completed work:

- **GitHub PRs** -- review discussion, CI results, and merged diffs
- **git history** -- the permanent code history
- **`nw history <ID>`** -- the item's state transition timeline
- **`nw logs`** -- orchestration events and failures

If you don't see a finished item in `.ninthwave/work/`, that's the expected success case.

### What is the orchestrator?

The orchestrator (`nw`) is a deterministic state machine that manages the lifecycle of work items from start to merged PR. It runs as a continuous loop, polling GitHub for CI/PR status and the active worker backend (`tmux`, `cmux`, or headless) every few seconds.

It handles: launching workers, tracking CI status, dispatching review feedback, retrying failures, resolving merge conflicts, and auto-merging PRs when all gates pass.

The orchestrator itself makes no LLM calls -- it's pure TypeScript logic. Only the workers (AI coding sessions) use AI.

### What is decomposition?

Decomposition is the process of breaking a feature into work items. Use the `/decompose` skill in your AI tool:

```
/decompose
```

Describe the feature you want to build, and the decomposer will:

1. Explore your codebase to understand existing patterns
2. Break the feature into PR-sized work items (200-400 LOC each)
3. Map dependencies between items and assign batches
4. Write each item as a markdown file in `.ninthwave/work/`

You can also create work items manually by writing markdown files directly.

### What are dependencies and batches?

Dependencies define ordering constraints between work items. If item `H-API-2` depends on `H-API-1`, the orchestrator won't merge `H-API-2` until `H-API-1` is merged.

Batches are groups of items that can run in parallel. Items in batch 1 have no dependencies. Items in batch 2 depend on items in batch 1, and so on. The orchestrator processes batches in order, running all items within a batch concurrently.

Dependencies are declared in the work item file:

```markdown
**Depends on:** H-API-1, H-DB-1
```

Wildcard patterns are also supported (e.g., `H-AUTH-*` depends on all auth items).

### What does the full workflow look like?

1. **Decompose** -- Break your feature into work items (`/decompose` or write them manually)
2. **Start orchestration** -- Run `nw`, select work items (and an AI tool when needed), then confirm the single startup settings screen
3. **Orchestrate** -- `nw` launches parallel AI sessions, each in an isolated worktree
4. **Workers implement** -- Each AI session reads its work item, writes code, runs tests, and creates a PR
5. **CI runs** -- The orchestrator monitors CI checks on each PR
6. **Review** -- Optional review workers (or humans) review PRs
7. **Merge** -- CI must pass in every mode; after that, `manual` waits for a human merge, `auto` lets ninthwave merge, and `bypass` is an explicit admin-only override
8. **Next batch** -- Newly unblocked items launch automatically

---

## Using ninthwave

### How do I create work items?

**Option 1: Use `/decompose`** (recommended)

In your AI tool, run `/decompose` and describe the feature. The decomposer analyzes your codebase and generates properly scoped work items with dependencies.

**Option 2: Write them manually**

Create a markdown file in `.ninthwave/work/`:

```markdown
# Add user authentication (H-AUTH-1)

**Priority:** High
**Depends on:** None
**Domain:** auth

Add JWT-based authentication middleware to the API.

**Test plan:**
- Unit tests for token validation
- Integration test for login flow
- Test expired token rejection
```

Save as `.ninthwave/work/1-auth--H-AUTH-1.md`.

### How do I run work items in parallel?

**Primary option: Use the CLI directly**

```bash
# Launch the canonical orchestration flow
nw

# Launch specific items by ID
nw H-AUTH-1 H-AUTH-2 H-API-1
```

The `--wip-limit` flag controls how many workers run simultaneously (default is auto-computed from available memory):

```bash
nw --items H-AUTH-1,H-AUTH-2 --wip-limit 3
```

### What happens when I run `nw`?

After you pick work items (and choose an AI tool if more than one is configured), `nw` shows one startup settings screen before the live status UI. That screen lets you set merge strategy, review mode, collaboration mode, WIP limit, and backend selection in one place.

There is no separate arming step after that screen. Once you confirm the startup settings, orchestration starts and the live status UI takes over.

### When should I choose `Auto`, `tmux`, `cmux`, or `headless`?

Use the startup settings screen to choose how workers should run:

| Backend | Choose it when |
|---|---|
| `Auto` | You want the default. ninthwave stays on your current cmux/tmux session when present, otherwise prefers installed tmux, then cmux, then falls back to headless |
| `tmux` | You want attachable terminal-native sessions, or already live in tmux/iTerm2 tmux control mode |
| `cmux` | You want the macOS sidebar/status UI and already have cmux available |
| `headless` | You want detached, programmatic operation and do not need an attachable mux workspace |

Interactive backends (`tmux`, `cmux`) give you attachable sessions you can jump into. `headless` runs detached instead.

The backend choice you confirm is saved as `backend_mode` and becomes the next startup default. For a one-off run, `NINTHWAVE_MUX=tmux|cmux|headless nw` takes precedence over the saved `backend_mode`, and the saved preference takes precedence over normal auto-detection. Invalid `NINTHWAVE_MUX` values warn and fall through instead of changing your saved default.

### What merge strategies are available?

All merge strategies are CI-first. The difference is what happens after CI passes.

| Strategy | Behavior |
|----------|----------|
| `auto` | CI must pass, then ninthwave auto-merges the PR |
| `manual` | CI must pass, then a human merges the PR |
| `bypass` | CI must pass, then ninthwave admin-merges without human approval requirements (`--dangerously-bypass` only) |

Set via the `--merge-strategy` flag, or choose it from the startup settings screen:

```bash
nw --items H-AUTH-1 --merge-strategy auto
```

### How do I check progress?

**Live dashboard:**

```bash
nw status
```

This shows a live-updating table of all items and their current states. Press `q` to exit.

**One-time snapshot:**

```bash
nw status --once
```

**Item list with dependencies:**

```bash
nw list              # All items
nw list --ready      # Only items with no unmet dependencies
nw deps H-AUTH-2     # Full dependency chain for an item
```

**Item history and retrospective lookup:**

```bash
nw history H-AUTH-2  # State transition timeline for one item
```

Use merged PRs, `git log`, `nw history`, and `nw logs` when you want to look back at completed work. `.ninthwave/work/` only shows open work.

**Orchestration logs:**

```bash
nw logs              # Recent log entries
nw logs --follow     # Tail live
nw logs --item H-1   # Filter to one item
```

### How do I use ninthwave with different AI tools?

ninthwave supports Claude Code, OpenCode, and GitHub Copilot CLI. When you run `nw init`, it auto-detects which tools are configured in your project (for example via `.claude/`, `.opencode/`, `.github/agents/`, or a user-managed `.github/copilot-instructions.md`) and writes managed agent/skill copies for each.

Switching tools doesn't require code changes -- ninthwave orchestrates at the session level, launching whichever tool is configured and sending it the work item prompt.

Most user repos can choose whether to commit those generated copies. The ninthwave repo itself ignores them and tracks only the canonical sources in `skills/`, `agents/`, and the root `CLAUDE.md`.

---

## How It Works

### How does worktree isolation work?

Each work item gets its own git worktree -- a separate checkout of the repository at `.worktrees/ninthwave-<ID>`. This means multiple workers can edit files concurrently without conflicts.

Each worktree also gets a **partition** -- a unique port range (e.g., 8000-8099, 8100-8199) and database prefix (e.g., `test_1`, `test_2`) for test isolation. Workers can run tests simultaneously without port collisions or shared test databases.

Worktrees are created automatically when an item launches and cleaned up when it completes (or preserved for inspection if it gets stuck).

### What happens when CI fails?

When CI fails on a PR, the orchestrator:

1. Detects the failure via GitHub status checks
2. Notifies the worker by sending a message to its terminal session
3. The worker reads the CI failure details and attempts a fix
4. If the fix succeeds, CI re-runs and the item continues through the pipeline
5. If failures persist beyond the retry limit (default: 5 attempts), the item is marked **stuck**

Stuck items preserve their worktree so you can inspect the state and either fix manually or retry with `nw retry <ID>`.

### What happens when a worker gets stuck?

The orchestrator monitors worker health by reading terminal output and tracking commit activity. A worker is considered stuck when:

- **No commits since launch** -- exceeds the launch timeout (default: 30 minutes)
- **No new commits** -- exceeds the activity timeout (default: 60 minutes)
- **Max retries exceeded** -- worker has crashed and been relaunched too many times (default: 3)

When a worker is stuck, the orchestrator closes its session, preserves the worktree for inspection, and marks the item as **stuck** with a failure reason.

You can retry stuck items:

```bash
nw retry H-AUTH-1
```

### How does stacked launching work?

Normally, an item waits for all its dependencies to be fully merged before launching. With stacked launching, an item can launch early against its dependency's branch while the dependency is still in-flight (implementing, PR open, or CI pending).

This speeds up dependency chains -- instead of waiting for each item to merge sequentially, the dependent item starts working immediately and rebases onto main after the dependency merges.

The orchestrator handles the rebase automatically. If conflicts arise, it attempts repair or marks the item stuck.

---

## Advanced Features

### Can I use ninthwave with monorepos or multiple repos?

**Monorepos:** ninthwave auto-detects pnpm, Yarn, and npm workspaces during `nw init` and handles workspace-aware operations.

**Cross-repo:** Work items can target sibling repositories using the `**Repo:**` field:

```markdown
**Repo:** api-service
```

The orchestrator resolves repos by convention (sibling directories) or explicit configuration. Cross-repo items are bootstrapped (cloned/updated) before launching and tracked via a shared index.

Use `nw repos` to see discovered sibling repositories.

### What is crew mode?

Crew mode allows multiple operators (each running their own `nw` orchestration session) to collaborate on the same set of work items. A shared broker coordinates task distribution so items aren't double-claimed.

```bash
# Create a crew
nw crew create

# Join an existing crew
nw crew join <crew-code>
```

The broker handles WIP-bounded scheduling with author-affinity (tasks route to the operator who created them when possible).

---

## Philosophy

### What doesn't ninthwave do?

ninthwave is intentionally narrow in scope:

- **Not an AI tool** -- it doesn't write code or make LLM calls. Workers (Claude Code, OpenCode, etc.) do the coding. ninthwave orchestrates.
- **Not a CI/CD system** -- it monitors your existing CI (GitHub Actions, etc.) but doesn't replace it.
- **Not a code review tool** -- it can dispatch review workers, but the review logic lives in agent prompts, not ninthwave.
- **Not a project management system** -- `.ninthwave/work/` is a lightweight file-based queue of open work, not a permanent ticket tracker.
- **Not a compute platform** -- you own your compute, API keys, and billing. ninthwave runs on your machine.

The orchestrator is a deterministic TypeScript state machine. It doesn't guess, hallucinate, or make judgment calls -- it follows rules. AI intelligence lives in the workers, not the orchestrator.
