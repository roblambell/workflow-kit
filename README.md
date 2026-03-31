<p align="center">
  <a href="https://ninthwave.sh"><img src="docs/assets/brand/logo.svg" alt="Ninthwave logo" width="100" /></a>
</p>
<h1 align="center">Ninthwave</h1>

<p align="center">
  <strong>Decompose. Run nw. Get merged PRs.</strong>
</p>

<p align="center">
  <a href="https://github.com/ninthwave-sh/ninthwave/stargazers"><img src="https://img.shields.io/github/stars/ninthwave-sh/ninthwave?style=flat" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="Apache 2.0 License" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.3.2-green" alt="Version" /></a>
  <a href="https://agentskills.io"><img src="https://img.shields.io/badge/Agent%20Skills-standard-purple" alt="Agent Skills" /></a>
</p>

<p align="center">
  <a href="https://ninthwave.sh"><img src="docs/assets/hero-orchestrator.png" alt="Ninthwave orchestrator: status table showing parallel work items with states, throughput, and merged PRs" width="740" /></a>
</p>

Ninthwave orchestrates parallel AI coding sessions from markdown work items.

## How it works

Work items are markdown files in `.ninthwave/work/`. Use `/decompose` to generate them from a plan.

Run `nw` or `/work` and the orchestrator handles the rest.

Each item gets its own git worktree and a full native instance of [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [OpenCode](https://opencode.ai), or [Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli), you can jump into and steer.

The orchestrator monitors CI, coordinates between implementer and review agents, external feedback, and merges approved PRs. Dependent items stack as chained PRs - reviewers get clean diffs.

Tasks can be brokered by [ninthwave.sh](https://ninthwave.sh) for collaboration with author-affinity preference.

## Install

```bash
brew install ninthwave-sh/tap/ninthwave
```

Requires [gh](https://cli.github.com) and a terminal multiplexer: [tmux](https://github.com/tmux/tmux/wiki) or [cmux](https://cmux.com) (recommended!).

## Getting started

Just run `nw` inside tmux, cmux, or with [iTerm2 tmux integration](docs/iterm2.md).

## License

Apache 2.0. See [LICENSE](LICENSE).
