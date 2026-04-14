<p align="center">
  <a href="https://ninthwave.sh"><img src="docs/assets/brand/logo.svg" alt="Ninthwave logo" width="100" /></a>
</p>
<h1 align="center">Ninthwave</h1>

<p align="center">
  <strong>Orchestrate parallel AI coding into reviewable PRs.</strong>
</p>

<p align="center">
  <a href="https://github.com/ninthwave-io/ninthwave/stargazers"><img src="https://img.shields.io/github/stars/ninthwave-io/ninthwave?style=flat" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="Apache 2.0 License" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/github/v/release/ninthwave-io/ninthwave?sort=semver&color=green&label=version" alt="Version" /></a>
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

I always start in plan mode and run several harnesses in parallel. Once a plan is detailed enough I look at its scope: if the change feels like a single PR's worth of work, I let the harness that planned it carry on and implement it directly. If it looks bigger than that, I run it through `/decompose` so `nw` can pick up the work items.

For greenfield and rapid prototyping I leave Ninthwave in auto mode and let it run. On existing projects I stay in manual mode: I review PRs as they open, leave feedback inline, and Ninthwave actions it from there. Once I am happy with a PR I merge it manually. Dropping into a worker session is a last resort for when something is genuinely stuck.

Claude Code on Opus 4.6 runs end to end without intervention. Copilot CLI on Opus 4.6, and Codex and OpenCode on gpt-5.4 high, follow the work spec fine but sometimes stumble on Ninthwave's harness scaffolding -- heartbeats, inbox polling, and the end-of-session wait for inbox messages -- so those sessions occasionally need a nudge.

## How it works

`Plan -> /decompose -> parallel native sessions -> stacked PRs -> review + feedback loop -> checks -> merge`

1. Use `/decompose` to turn a plan into markdown work items.
2. Run `nw` to launch parallel native sessions of your AI tool.
3. Review small PRs while the orchestrator keeps the queue moving through review, CI, and merge.

Ninthwave's orchestrator is deterministic.

For the transition states, flow diagrams, and deeper internals, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Install

```bash
brew install ninthwave-io/tap/ninthwave
```

Requires [gh](https://cli.github.com).

Run inside [cmux](https://cmux.com) or [tmux](https://github.com/tmux/tmux/wiki) for the best experience. Ninthwave can launch workers in headless mode, but attachable sessions are what let you jump straight into a worker when you need to inspect or steer it. If you are not already comfortable with tmux, start with cmux.

<p align="center">
  <img src="docs/assets/cmux-worker-panels.png" alt="cmux showing active Ninthwave worker sessions and in-flight task output one step away while Ninthwave runs" />
</p>

<p align="center">
  <em>Ninthwave works standalone; cmux or tmux keeps active worker sessions one step away when you need to inspect, steer, or unblock work in flight.</em>
</p>

## Quick start

1. Install Ninthwave:

   ```bash
   brew install ninthwave-io/tap/ninthwave
   nw init # in a repo
   ```

2. Optional but recommended: install `cmux` or `tmux` so you can attach to worker sessions when needed.

3. Once you have a plan, create work items with `/decompose`, then run:

   ```bash
   nw
   ```

From there, Ninthwave launches the queue, opens reviewable PRs, watches checks, and keeps the pipeline moving. Use auto mode for greenfield work or rapid prototyping; on existing projects, stay in manual mode and review each PR as it opens, leaving feedback inline for Ninthwave to action.

## License

Apache 2.0. See [LICENSE](LICENSE).
