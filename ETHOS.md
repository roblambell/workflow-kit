# Ethos

Core principles and hard boundaries for ninthwave. This is a guardrail document -- it defines what we will and won't do.

## Principles

### 1. Never modify user config outside the project directory

ninthwave operates within `.ninthwave/` and the project root. It does not write to `~/.copilot/`, `~/.claude/`, `~/.config/`, or any user-global configuration. If a tool requires external setup, document it -- don't automate it.

### 2. Convention over configuration

Sensible defaults, minimal config files. Cross-repo resolves via sibling directories. Port isolation via partition math. Domain slugs from section headers. Zero config for the common case.

### 3. Deterministic core, advisory AI

The orchestrator daemon is deterministic TypeScript -- no LLM calls in the core pipeline. LLM output never bypasses deterministic logic.

### 4. Scope discipline

Each iteration narrows before it widens. Ship the narrowest working wedge, validate it, then extend. Work items are scoped to ~200–400 LOC. PRs change one thing. Features decompose into human-reviewable units.

### 5. Transparency

Every action is auditable. PR comments carry role tags. Analytics are structured JSON. Friction logs capture what went wrong. No silent side effects -- if ninthwave does something, there's a record.

### 6. Multi-tool, no lock-in

Works with Claude Code, OpenCode, Copilot CLI, and anything supporting the Agent Skills standard. No proxy, no billing layer, no API key management. The user picks their AI tool; ninthwave orchestrates it.

### 7. Human review required

ninthwave manages the pipeline, not the decisions. Every PR is reviewed before it lands. Auto-merge means "merge when CI passes and reviews approve" -- not "merge without review."

### 8. Isolation by default

Workers get their own worktrees and partitions. Parallel sessions never share a checkout. Test databases and ports are partitioned. The blast radius of any single worker is its own branch. Sandboxing is planned via [strait](https://github.com/ninthwave-sh/strait).

## Hard Boundaries

These are not up for debate:

- **No writing outside the project tree.** Not even "helpful" dotfile setup.
- **No LLM in the hot path.** The daemon event loop must remain deterministic and auditable.
- **No vendor lock-in.** Every integration is an adapter behind an interface. Swapping tools is a config change, not a rewrite.
- **No silent mutations.** If state changes, it's logged, committed, or commented on a PR.
