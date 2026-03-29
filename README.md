<h1 align="center">Ninthwave</h1>

<p align="center">
  <strong>Decompose. Run nw. Get merged PRs.</strong>
</p>

<p align="center">
  <a href="https://github.com/ninthwave-sh/ninthwave/stargazers"><img src="https://img.shields.io/github/stars/ninthwave-sh/ninthwave?style=flat" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="Apache 2.0 License" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.0-green" alt="Version" /></a>
  <a href="https://agentskills.io"><img src="https://img.shields.io/badge/Agent%20Skills-standard-purple" alt="Agent Skills" /></a>
</p>

<p align="center">
  <a href="https://ninthwave.sh"><img src="docs/assets/hero.gif" alt="Ninthwave: Orchestrator, Implementer, and Reviewer in parallel cmux sessions" width="800" /></a>
</p>

Ninthwave orchestrates parallel AI coding sessions from markdown work items.

## How it works

Work items are markdown files in `.ninthwave/work/`. Use `/decompose` to generate them from a plan.

Run `nw` or `/work` and the orchestrator handles the rest.

Each item gets its own git worktree and a full native instance of [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [OpenCode](https://opencode.ai), or [Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli). The orchestrator monitors CI, coordinates between implementer and review agents, external feedback, and merges approved PRs. Dependent items stack as chained PRs - reviewers get clean diffs.

Join a crew to increase capacity. Tasks brokered by [ninthwave.sh](https://ninthwave.sh) with author-affinity preference, and WIP overflow distribution.

## Install

```bash
brew install ninthwave-sh/tap/ninthwave
```

Requires [cmux](https://cmux.com) and [gh](https://cli.github.com). Run `nw doctor` to verify your setup.

## License

Apache 2.0. See [LICENSE](LICENSE).
