<h1 align="center">ninthwave</h1>

<p align="center">
  <strong>From spec to merged PRs. Automatically.</strong>
</p>

<p align="center">
  <a href="https://github.com/ninthwave-sh/ninthwave/stargazers"><img src="https://img.shields.io/github/stars/ninthwave-sh/ninthwave?style=flat" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.0-green" alt="Version" /></a>
  <a href="https://agentskills.io"><img src="https://img.shields.io/badge/Agent%20Skills-standard-purple" alt="Agent Skills" /></a>
</p>

<p align="center">
  <img src="docs/assets/hero.png" alt="ninthwave running in cmux: orchestrator with parallel worker sessions" width="800" />
</p>
<p align="center"><em><code>todos/*.md</code> &rarr; sequenced AI agents &rarr; human-sized PRs</em></p>

---

**ninthwave orchestrates parallel AI coding sessions from todo files.** Each work item gets a full native instance of Claude Code, OpenCode, or Copilot CLI with the latest agent features, full capability, focused on one task. Workers open a PR then idle with full context. Review comments, CI failures, and rebase requests go straight back to the worker to handle. Switch into any session to steer. The orchestrator sequences dependencies, auto-merges, and cleans up.

- **Parallel sessions.** Each work item gets its own git worktree and AI coding session.
- **Dependency sequencing.** Items launch in batch order. Dependent items target their dependency's branch (stacked PRs).
- **Review relay.** PR comments from reviewers are forwarded directly into the worker's session.
- **CI failure recovery.** Orchestrator detects failures, notifies the worker, retries up to 3x, marks stuck if unresolvable.
- **Auto-rebase.** Daemon rebases branches automatically. Falls back to a repair worker on conflicts.
- **Auto-merge.** Approved PRs merge on CI pass, or gate on manual confirmation.
- **Crew mode.** Multiple daemons on different machines coordinate via [ninthwave.sh](https://ninthwave.sh) broker with creator-affinity scheduling.
- **Convention over configuration.** Cross-repo via sibling directories, port isolation, domain mapping. Zero config for the common case.

## Install

```bash
brew install ninthwave-sh/tap/ninthwave
```

**Prerequisites:** [cmux](https://cmux.com) for terminal sessions, an AI coding tool ([Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [OpenCode](https://opencode.ai), or [Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)), and [`gh`](https://cli.github.com) for PR operations.

## Quick Start

```bash
nw init                     # initialize project
nw list                     # see work items
nw H-RR-1 H-RR-2           # launch items by ID
nw watch                    # full pipeline: launch, monitor CI, merge
nw status                   # live dashboard
nw clean                    # remove merged worktrees
```

Run `nw` with no arguments for an interactive guide that lets you pick items and choose how to run them.

Each session is a full native instance of your AI coding tool in its own git worktree. Switch into any session via cmux to steer it mid-flight.

One developer runs `nw init`. The team gets everything via `git pull`.

Run `nw doctor` to verify your setup.

## How It Works

Todo files in `.ninthwave/todos/` define work items with priorities, dependencies, and optional repo targets. `nw <ID>` creates a git worktree and AI coding session for each item. `nw watch` runs the full pipeline: a deterministic daemon that sequences batches, monitors CI, relays review feedback into worker sessions, auto-rebases branches, and merges approved PRs. Dependent items automatically target their dependency's branch, giving reviewers clean diffs.

The orchestrator is deterministic: no LLM calls in the event loop. Workers are the intelligent agents.

## CLI

| Command | |
|---------|---|
| `nw` | Interactive guide — pick items, choose how to run |
| `nw <ID> [ID2...]` | Launch items by ID |
| `nw init` | Initialize project |
| `nw watch` | Full pipeline: launch, monitor CI, merge |
| `nw status` | Live session dashboard |
| `nw doctor` | Check prerequisites |
| `nw list` | List and filter work items |
| `nw stop` | Stop orchestrator |
| `nw retry <IDs>` | Re-queue stuck items |
| `nw clean` | Remove merged worktrees |

Run `nw --help` for the full command reference, or `nw <command> --help` for details on any command.

## Skills

ninthwave ships with skills that plug into your AI tool's chat interface. These are optional. The CLI works standalone.

| Skill | |
|-------|---|
| `/decompose` | Break a feature spec into batched work items with dependency mapping |
| `/work` | Full delivery loop: select items, launch sessions, monitor, merge, finalize |
| `/todo-preview` | Port-isolated dev servers for live testing in worktrees |

Workers can use `/review`, `/design-review`, `/qa`, and `/plan-eng-review` during execution if available. [gstack](https://github.com/garrytan/gstack) provides all four. Or bring your own: any skill following the [Agent Skills standard](https://agentskills.io) works.

## Updating

```bash
brew upgrade ninthwave
nw init   # re-sync project-level files
```

Project config (`.ninthwave/`) is preserved.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, and how the pieces fit together.

## License

MIT. See [LICENSE](LICENSE).
