<h1 align="center">ninthwave</h1>

<p align="center">
  <strong>From spec to merged PRs. Automatically.</strong>
</p>

<p align="center">
  <a href="https://github.com/ninthwave-sh/ninthwave/stargazers"><img src="https://img.shields.io/github/stars/ninthwave-sh/ninthwave?style=flat" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.1.0-green" alt="Version" /></a>
  <a href="https://agentskills.io"><img src="https://img.shields.io/badge/Agent%20Skills-standard-purple" alt="Agent Skills" /></a>
</p>

<!-- PLACEHOLDER: docs/assets/pipeline-overview.png
     LEFT: Icons stacked vertically: TODOS.md (markdown icon), Linear, ClickUp, GitHub Issues
     CENTER: Arrows converge into a cmux screenshot showing orchestrator + 4 worker
     sessions in the sidebar with colored status indicators
     RIGHT: GitHub PR list with green merge checkmarks
     Visual: work items in → parallel sessions → PRs out -->
<p align="center">
  <img src="docs/assets/pipeline-overview.svg" alt="ninthwave pipeline: work items in, parallel sessions, PRs out" width="800" />
</p>

---

**ninthwave is an open-source orchestration layer for AI coding tools.** It decomposes a feature into reviewable work items, launches parallel AI sessions to implement them, sequences dependencies, monitors CI, and merges — automatically. Each session is a full native instance of Claude Code, OpenCode, or Copilot CLI. You review every PR before it lands.

Your AI tool handles one session at a time. An 8-item feature means 8 sequential sessions, 8 CI waits, 8 manual PR flows. ninthwave runs them in parallel, manages the lifecycle, and lets you focus on review — not orchestration.

**Built on [cmux](https://cmux.com), works with tmux.** cmux provides composable primitives — terminal, workspaces, splits, notifications, CLI control — and invites developers to build their own workflows on top. ninthwave is our answer to that call: an orchestration layer that turns those primitives into a structured delivery pipeline. Already using tmux? ninthwave auto-detects it and works out of the box.

## What You Get

- **Decompose any feature** into PR-sized work items (~200-400 LOC) with dependency mapping
- **Launch parallel AI sessions** — each a full native instance of Claude Code, OpenCode, or Copilot CLI
- **Automatic CI + merge pipeline** — dependency ordering, CI monitoring, review dispatch, auto-merge
- **Switch into any session** mid-flight via cmux sidebar or tmux
- **Friction log + self-improvement** — log what slows you down, decompose fixes, process them automatically
- **Convention over configuration** — cross-repo, port isolation, domain mapping. Zero config for the common case
- **Bring your own everything** — your AI tool, your billing, your CI, your task tracker. No lock-in

Works for a solo dev decomposing a weekend feature and a team dividing a quarterly milestone.

## See It Work

```
> /decompose

ninthwave / Feature Decomposition
Project: acme-app (main)

What feature are we breaking down?

> Here's the spec for user onboarding: new users get a welcome email,
> an onboarding checklist on the dashboard, and a profile completion flow.

Exploring codebase...
  Found: lib/mailer.ex (email infrastructure exists)
  Found: lib/accounts/ (user model, no onboarding fields)
  Missing: onboarding context, checklist component, profile completion

Decomposition:

  Batch  ID      Title                           Est. LOC
  ─────  ──────  ──────────────────────────────  ────────
  1      C-UO-1  Add welcome email on signup         ~200
  1      H-UO-2  Create onboarding context           ~300
  2      H-UO-3  Dashboard onboarding checklist      ~350
  2      H-UO-4  Profile completion flow             ~400
  3      M-UO-5  Onboarding analytics events         ~150

5 items across 3 batches written to TODOS.md.


> /work

ninthwave / Batch Processing
Project: acme-app (main)

4 items ready (batches 1–2). How do you want to select?
  A) All ready (4 items)
  B) By feature code
  C) By priority

> a

Dependency analysis:
  Batch 1: C-UO-1, H-UO-2 (parallel, no file conflicts)
  Batch 2: H-UO-3, H-UO-4 (depends on batch 1)

Merge strategy?
  A) Auto-merge once approved + CI passes
  B) Auto-merge ASAP (CI only)
  C) Ask me before each merge

> a

Launching batch 1...
  todo/C-UO-1  → Add welcome email          [session started]
  todo/H-UO-2  → Create onboarding context  [session started]

cmux sidebar shows 2 active sessions. Switch into any one to steer it.

  C-UO-1  Implementing → Testing → PR #42 → CI passing → Approved → Merged
  H-UO-2  Implementing → Testing → PR #43 → CI passing → Approved → Merged

Batch 1 complete. Launching batch 2...
  todo/H-UO-3  → Dashboard checklist        [session started]
  todo/H-UO-4  → Profile completion flow    [session started]

  H-UO-3  Implementing → PR #44 → Review feedback → Fix pushed → Merged
  H-UO-4  Implementing → Testing → PR #45 → CI passing → Approved → Merged

All items merged. Version bump: 1.4.0 → 1.5.0 (CHANGELOG updated)
```

## How It Works

<!-- PLACEHOLDER: docs/assets/hero-demo.gif
     Screen recording of cmux showing /work launching 4 parallel sessions.
     Sidebar shows worker sessions with status progression:
     Implementing → Testing → PR Created → Merged.
     15-20 second loop. -->
<p align="center">
  <img src="docs/assets/hero-demo.svg" alt="ninthwave: parallel AI coding sessions in cmux" width="800" />
</p>

### `/decompose`: Spec to Work Items

| Phase | What happens |
|-------|-------------|
| **Intake** | Point to a PRD, spec, or describe the feature verbally |
| **Explore** | Scans the codebase: what exists vs. what needs building |
| **Architect** | Optional architecture review for complex features |
| **Decompose** | PR-sized items (~200-400 LOC each), dependencies mapped into batches |
| **Write** | Items written to TODOS.md (or synced to Linear/ClickUp) |

### `/work`: Orchestrate Parallel Sessions

| Phase | What happens |
|-------|-------------|
| **Select** | Choose items by feature, priority, domain, or all-at-once |
| **Launch** | Each item gets a git worktree + full AI coding session via your multiplexer (cmux or tmux) |
| **Monitor** | `orchestrate` daemon polls CI, dispatches failures to workers, forwards review feedback, handles rebases |
| **Merge** | Auto-merge after approval, on CI pass, or confirm each one |
| **Finalize** | Version bump, changelog, cleanup. Offer to continue with next batch. |

## Self-Improving

ninthwave includes a built-in feedback loop. As you work, log friction — slowdowns, surprises, rough edges. `/work` reviews your friction log between batches, decomposes actionable items into TODOs, processes them through the same pipeline, and repeats. When all code items are done, it offers vision exploration to identify what's next.

Your workflow improves itself. ninthwave uses this loop to develop itself.

## Quick Start

### Install

```bash
brew install ninthwave-sh/tap/ninthwave
```

This installs both `nw` (short alias) and `ninthwave` (full name). Use `nw` for daily work — it's the recommended command.

<details>
<summary>Alternative: install via curl</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/ninthwave-sh/ninthwave/main/install.sh | bash
```
</details>

### Prerequisites

| Dependency | Purpose | Install |
|------------|---------|---------|
| AI coding tool | Runs the sessions | [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [OpenCode](https://opencode.ai), or [Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) |
| [cmux](https://cmux.com) **or** [tmux](https://github.com/tmux/tmux) | Parallel terminal sessions | cmux *(recommended)*: `brew install --cask manaflow-ai/cmux/cmux`<br>tmux: `brew install tmux` |
| [gh](https://cli.github.com) | PR operations | `brew install gh && gh auth login` |

> **cmux vs tmux:** cmux provides a visual sidebar showing all active sessions with live status. tmux works as a headless alternative — same orchestration, no GUI. If you already have tmux, ninthwave auto-detects it. Install cmux for the best experience.

### Set up a project

```bash
cd /path/to/your/project
nw setup
```

One developer runs setup. The team gets everything via `git pull`.

### First run

> Open your AI tool in the project and say:
>
> **`/decompose`** Point it at a spec or describe a feature. It scans your codebase and creates work items.
>
> **`/work`** Select items, set a merge strategy, and watch parallel sessions launch.

## Why ninthwave?

**Your tool, multiplied.** Each session is a full native instance of the AI coding tool you already use. Same interface, same capabilities. Switch into any session via cmux's workspace sidebar, steer it mid-flight, or iterate on a PR. You review every PR before it merges.

**Deterministic orchestration.** One session per work item, dependency-ordered and conflict-checked. Workers idle after opening a PR — no polling, no redundant calls. The orchestrator wakes them for CI fixes or review feedback. Every step is visible and auditable.

**Bring your own agent.** Keep your billing, your interface, your API keys. Workers read your project instructions for conventions — same coding standards, same test commands, same architecture guardrails. No new billing layer, no proxy, no vendor lock-in. Works with Claude Code, OpenCode, Copilot CLI, and anything supporting the [Agent Skills standard](https://agentskills.io).

**Cross-repo by convention.** Work items can target different repositories via a `Repo:` field. Sibling directories resolve automatically — no config file required.

## Using with tmux

ninthwave auto-detects your multiplexer. If cmux is installed, it's preferred. Otherwise, tmux is used automatically.

To explicitly select a multiplexer:

```bash
# Via CLI flag
nw start C-UO-1 --mux tmux
nw orchestrate --items C-UO-1,H-UO-2 --mux tmux

# Via environment variable (persists for the session)
export NINTHWAVE_MUX=tmux
```

**Differences when using tmux:**

| Feature | cmux | tmux |
|---------|------|------|
| Visual sidebar | ✓ Live status indicators | ✗ No sidebar |
| Switch sessions | Click in sidebar | `tmux attach -t nw-1` |
| Session management | Automatic | `tmux list-sessions` to see `nw-*` sessions |
| Orchestration | Full | Full |
| CI monitoring | Full | Full |
| PR feedback loop | Full | Full |

All orchestration features work identically — the only difference is the UI.

## Remote Dashboard

The orchestrator includes a built-in web dashboard for monitoring worker sessions remotely. It's off by default and secure by default.

### Enable

```bash
# Via CLI flag
nw orchestrate --items C-UO-1,H-UO-2 --remote

# Via project config (persists)
echo "remote_sessions=true" >> .ninthwave/config
```

When enabled, the dashboard starts on a random localhost port with an auto-generated bearer token:

```
Dashboard: http://localhost:54321?token=abc123...
```

### What you see

- **Overview** — all items with color-coded states (queued, implementing, ci-passing, merged, etc.), PR links, and age
- **Session drill-down** — click into any worker to see its terminal output
- **Auto-refresh** — dashboard updates every 2 seconds

### Expose remotely

The dashboard binds to localhost only. To access it from another machine, use any tunneling tool you prefer:

```bash
# cloudflared (Cloudflare)
cloudflared tunnel --url http://localhost:54321

# ngrok
ngrok http 54321

# SSH tunnel
ssh -R 80:localhost:54321 your-server
```

ninthwave doesn't manage tunnels — you bring your own. The dashboard token provides authentication regardless of which tunnel you use.

> **Note:** cloudflared is **not** a prerequisite for ninthwave. It's one of several tunneling options. `nw doctor` lists it as an optional dependency.

### Verify your setup

```bash
nw doctor
```

Checks required tools (gh, AI tool, multiplexer, git config), recommended config (project setup, sandbox, pre-commit hook), and optional dependencies (cloudflared for remote access, webhook URL for notifications).

<!-- PLACEHOLDER: docs/assets/pr-feedback-loop.png
     Shows a GitHub PR titled "feat: Add onboarding checklist (H-UO-3)"
     Visible: a reviewer comment requesting a change, a worker comment responding
     with the fix, CI checks passing after the fix, merge button active.
     Demonstrates: review feedback is automatically dispatched to the right worker
     session. Workers address comments, push fixes, and respond on the PR. -->
<p align="center">
  <img src="docs/assets/pr-feedback-loop.svg" alt="PR feedback: workers address review comments automatically" width="700" />
</p>

## Reference

### Skills

| Skill | Description |
|-------|-------------|
| `/work` | Select work items, orchestrate parallel sessions, review friction, run vision — the full delivery loop |
| `/decompose` | Break a feature spec into PR-sized work items with dependency mapping |
| `/todo-preview` | Launch port-isolated dev servers for live testing in worktrees |
| `/ninthwave-upgrade` | Update ninthwave to the latest version |

### CLI

All commands work with both `nw` and `ninthwave` (identical behavior):

| Command | Description |
|---------|-------------|
| `list [--ready] [--priority P] [--domain D] [--feature F]` | List and filter work items |
| `deps <ID>` | Show dependency chain and dependents |
| `conflicts <ID1> <ID2> ...` | Check file-level and domain overlaps |
| `batch-order <ID1> [ID2] ...` | Group items into dependency-ordered batches |
| `start <ID1> [ID2] ...` | Create worktrees and launch AI sessions |
| `status` | Show active worktree status (branches, PRs, partitions) |
| `watch-ready` | Check PR merge readiness (pending/passing/failing) |
| `autopilot-watch [--interval N]` | Poll for PR status transitions |
| `merged-ids` | List already-merged work items |
| `mark-done <ID1> [ID2] ...` | Remove completed items from TODOS.md |
| `version-bump` | Bump version and generate changelog from commits |
| `clean [ID]` | Remove merged worktrees and close workspaces |
| `orchestrate --items ID1,ID2 [options]` | Orchestrate parallel processing (launch workers, poll CI, merge PRs) |
| `doctor` | Check environment health (required tools, config, optional dependencies) |
| `repos` | List discovered repos (sibling dirs + repos.conf) |

### Expected skills (bring your own)

Workers reference these skill names during execution. If available, they're used; if not, the worker falls back gracefully.

| Skill | When | Fallback |
|-------|------|----------|
| `/review` | Pre-landing code review | Self-review of the diff |
| `/design-review` | UI/visual changes | Skipped |
| `/qa` | Bug fixes with UI impact | Skipped |
| `/plan-eng-review` | Architecture validation | Skipped |

[gstack](https://github.com/garrytan/gstack) provides all four out of the box. Or bring your own: any skill with the matching name and the [SKILL.md standard](https://agentskills.io) will work.

### Work item backends

**Project management:**

| Backend | When to use |
|---------|-------------|
| `.ninthwave/todos/` (built-in) | Solo devs, quick projects, everything in markdown |
| GitHub Issues | Lightweight project tracking |
| ClickUp | Teams with existing task management |
| Linear, Jira (planned) | Coming soon |

**Observability:**

| Backend | When to use |
|---------|-------------|
| Sentry | Turn unresolved errors into work items automatically |
| PagerDuty | Turn incidents into work items, resolve on merge |

<details>
<summary><strong>What gets installed</strong></summary>

`brew install` places the `ninthwave` binary (plus `nw` short alias) and resource files (skills, agents, docs) in the Homebrew prefix. `nw setup` creates minimal project-level config.

**Project-level files** (created by `ninthwave setup`, committed to git):

| Path | Purpose |
|------|---------|
| `.ninthwave/config` | Project settings (LOC extensions, domain mappings) |
| `.ninthwave/domains.conf` | Custom domain slug mappings |
| `.claude/skills/*` | Symlinks to skills (for discovery) |
| `.claude/agents/todo-worker.md` | Worker agent (Claude Code) |
| `.opencode/agents/todo-worker.md` | Worker agent (OpenCode) |
| `.github/agents/todo-worker.agent.md` | Worker agent (Copilot CLI) |
| `TODOS.md` | Work items (created if missing) |

</details>

## Updating

Run `/ninthwave-upgrade` from any AI coding session, or manually:

```bash
brew upgrade ninthwave
nw setup   # re-sync project-level files
```

Project-specific config (`TODOS.md`, `.ninthwave/config`, `domains.conf`) is preserved.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, and how the pieces fit together.

## License

MIT. See [LICENSE](LICENSE).
