<h1 align="center">Ninthwave</h1>

<p align="center">
  <strong>From spec to merged PRs. Automatically.</strong>
</p>

<p align="center">
  <a href="https://github.com/ninthwave-sh/ninthwave/stargazers"><img src="https://img.shields.io/github/stars/ninthwave-sh/ninthwave?style=flat" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="Apache 2.0 License" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.0-green" alt="Version" /></a>
  <a href="https://agentskills.io"><img src="https://img.shields.io/badge/Agent%20Skills-standard-purple" alt="Agent Skills" /></a>
</p>

<p align="center">
  <img src="docs/assets/hero.png" alt="ninthwave: parallel AI coding sessions orchestrated from work items" width="800" />
</p>

Ninthwave orchestrates parallel AI coding sessions from markdown work items.

Write specs. Run `nw`. Get merged PRs.

## How it works

Work items are markdown files in `.ninthwave/work/`. Use `/decompose` to generate them from a feature spec:

```markdown
# Feat: Add rate limiting to API endpoints (H-API-1)

**Priority:** High
**Depends on:** None
**Domain:** api

Add token-bucket rate limiting to all public API endpoints.
Return 429 with Retry-After header when exceeded.

Acceptance: Rate limit triggers at 100 req/min per key.
429 response includes correct Retry-After. Tests cover
happy path and limit-exceeded scenarios.
```

Run `nw` or `/work` and the orchestrator handles the rest:

```
  .ninthwave/work/*.md
          │
         nw
          │
    ┌─────┴─────┐
    ▼           ▼
    A           B ───▶ C       C depends on B
    │           │      │
    ▼           ▼      ▼
   PR          PR     PR
    │           │      │
    └─────┬─────┴──────┘
          │
  CI · review · merge
          │
        main
```

Each item gets its own git worktree and a full native instance of [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [OpenCode](https://opencode.ai), or [Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli). The orchestrator monitors CI, routes review feedback back into worker sessions, auto-rebases, and merges approved PRs. Dependent items stack as chained PRs -- reviewers see clean diffs.

Multiple daemons can coordinate in crew mode -- tasks brokered by [ninthwave.sh](https://ninthwave.sh) with creator-affinity for human steering, WIP limits, and overflow.

## Install

```bash
brew install ninthwave-sh/tap/ninthwave
```

Requires [cmux](https://cmux.com), an AI coding tool, and [`gh`](https://cli.github.com). Run `nw doctor` to verify your setup.

## License

Apache 2.0. See [LICENSE](LICENSE).
