<p align="center">
  <a href="https://ninthwave.sh"><img src="docs/assets/brand/logo.svg" alt="Ninthwave logo" width="100" /></a>
</p>
<h1 align="center">Ninthwave</h1>

<p align="center">
  <strong>Orchestrate parallel AI coding into reviewable PRs.</strong>
</p>

<p align="center">
  <a href="https://github.com/ninthwave-sh/ninthwave/stargazers"><img src="https://img.shields.io/github/stars/ninthwave-sh/ninthwave?style=flat" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="Apache 2.0 License" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.3.2-green" alt="Version" /></a>
  <a href="https://agentskills.io"><img src="https://img.shields.io/badge/Agent%20Skills-standard-purple" alt="Agent Skills" /></a>
</p>

<p align="center">
  <img src="docs/assets/hero-orchestrator.png" alt="Ninthwave orchestrator managing parallel work items with live queue and PR pipeline status" />
</p>

Ninthwave is the orchestration layer for parallel AI coding. Turn plans into small, reviewable PRs while keeping your existing AI tool, billing, and local control.

## Why try Ninthwave?

- Turn a spec or plan into small work items, typically ~200-400 lines of meaningful change, so both humans and agents can reason about them during review
- Run multiple native AI coding sessions in parallel, each isolated in its own worktree
- Coordinate the full delivery loop through [Implementer](agents/implementer.md), CI, [Reviewer](agents/reviewer.md), [Rebaser](agents/rebaser.md), merge, and [Forward-Fixer](agents/forward-fixer.md)
- Launch dependent work early as stacked PRs so reviewers get clean diffs
- Share or join a crew to spread work across teammates or multiple machines, using the hosted broker by default or a [self-hosted broker](docs/faq.md#what-is-the-self-hosted-broker) when you need full control
- Use the native tools directly, while Ninthwave's TUI shows live queue and pipeline status
- Stay multi-tool and no-lock-in: [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [OpenCode](https://opencode.ai), [Codex CLI](https://github.com/openai/codex), or [Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)

## How I use it

I work in small iterations. I push planning down to a fairly detailed low spec, then use `/decompose` to break it into work items and let `nw` work through the queue.

When I'm confident in a breakdown, I leave Ninthwave in auto mode and let it merge as checks pass. When I want a closer look, I switch to manual mode and either review the PRs and leave feedback there, or jump straight into the worker session and iterate with the implementer directly.

## How it works

`Plan -> /decompose -> parallel native sessions -> stacked PRs -> review + feedback loop -> checks -> merge`

1. Use `/decompose` to turn a plan into markdown work items.
2. Run `nw` to launch parallel native sessions of your AI tool.
3. Review small PRs while the orchestrator keeps the queue moving through review, CI, and merge.

Ninthwave's orchestrator is deterministic.

For the transition states, flow diagrams, and deeper internals, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Install

```bash
brew install ninthwave-sh/tap/ninthwave
```

Requires [gh](https://cli.github.com).

Run inside [cmux](https://cmux.com) or [tmux](https://github.com/tmux/tmux/wiki) for the best experience. Ninthwave can launch workers in headless mode, but attachable sessions are what let you jump straight into a worker when you need to inspect or steer it. If you are not already comfortable with tmux, start with cmux.

## Updating

```bash
nw update
```

`nw update` detects how your install was managed and runs the matching updater. v1 supports two install sources:

- **Homebrew** (`brew install ninthwave-sh/tap/ninthwave`) -- runs `brew upgrade ninthwave`
- **Direct install script** (`curl -fsSL https://ninthwave.sh/install | bash`, which places `nw` under `~/.ninthwave/bin/`) -- re-runs the install script

For other installs (source clones, non-standard paths), `nw update` prints manual guidance instead of guessing. Ninthwave does not hot-reload, so restart any running `nw` sessions after a successful update. When you start `nw` and a newer version is available, Ninthwave also shows a startup prompt with Update / Skip / Skip-until-next-version options -- see the [FAQ](docs/faq.md#how-do-i-update-ninthwave) for details.

<p align="center">
  <img src="docs/assets/cmux-worker-panels.png" alt="cmux showing active Ninthwave worker sessions and in-flight task output one step away while Ninthwave runs" />
</p>

<p align="center">
  <em>Ninthwave works standalone; cmux or tmux keeps active worker sessions one step away when you need to inspect, steer, or unblock work in flight.</em>
</p>

## Quick start

1. Install Ninthwave:

   ```bash
   brew install ninthwave-sh/tap/ninthwave
   nw init # in a repo
   ```

2. Optional but recommended: install `cmux` or `tmux` so you can attach to worker sessions when needed.

3. Once you have a plan, create work items with `/decompose`, then run:

   ```bash
   nw
   ```

From there, Ninthwave launches the queue, opens reviewable PRs, watches checks, and keeps the pipeline moving. Leave it in auto mode when you want merges to keep flowing, or switch to manual mode when you want to review PRs and send feedback back through the loop.

## License

Apache 2.0. See [LICENSE](LICENSE).
