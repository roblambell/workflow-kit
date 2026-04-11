# Vision

<!-- Convention: Do NOT add completion markers to this document. No strikethrough
     (~~done~~), no "*(complete)*" annotations, no "Decomposed →" references, no
     inline "(Shipped.)" markers. Completed work belongs in CHANGELOG.md. This
     document describes the product vision and what's next. -->

## The Thesis

AI coding tools are single-session by nature. One context window, one work item, one PR at a time. A feature with eight work items means eight sequential sessions, eight rounds of waiting for CI, eight manual PR flows. The AI does the hard part -- writing code -- but you do the tedious part: picking the next item, watching CI, managing merges, forwarding review feedback, rebasing. You become the bottleneck in your own AI-assisted workflow.

The answer isn't bigger context windows or smarter agents that do everything in one session. The answer is decomposition into human-reviewable units plus parallel execution. This is how engineering teams already work -- just with people instead of AI sessions. The missing piece is the orchestration layer: what to work on, in what order, how many at once, what to do when CI fails or a reviewer pushes back.

ninthwave is that orchestration layer. It doesn't write code. It manages the pipeline that does. You decompose a feature into work items, ninthwave launches parallel sessions -- each a full native instance of whatever AI tool you already use -- sequences dependencies, monitors CI, dispatches feedback, and merges. You review every PR before it lands. The AI writes code; ninthwave manages the factory floor.

## What Exists Today

v0.1.0 shipped March 2026. Twelve grind cycles (0-11) have shipped since then. See CHANGELOG.md for the detailed history of each cycle.

**Core pipeline:**
- **Decompose + orchestrate.** `/decompose` breaks a spec into batched work items (~200-400 LOC each). `ninthwave orchestrate` runs an event-driven daemon that launches workers, monitors CI and PR state, merges, cleans up, and recovers from crashes. The full cycle: spec in, merged PRs out.
- **Deterministic orchestrator, intelligent workers.** The orchestrator is a TypeScript state machine with 13 states and pure transition functions -- no LLM calls. Workers are the intelligent agents. This split keeps orchestration predictable, auditable, and cheap.
- **Multi-tool, no lock-in.** Works with Claude Code, OpenCode, Copilot CLI, and anything supporting the [Agent Skills standard](https://agentskills.io).
- **Convention over configuration.** Port isolation via partition math. Domain slugs from section headers. Zero config for the common case.

**Key capabilities:**
- `ninthwave init` -- zero-config project onboarding with CI and test command auto-detection
- Daemon TUI with keyboard shortcuts and inline overlays
- Stacked branch execution -- dependent items launch early from the dependency's branch
- Review worker integration -- automated code review dispatched against PRs
- Worker health monitoring -- deterministic screen-based stall detection
- Memory-aware session limits based on available RAM
- Structured analytics with cost/token tracking
- Observability: `nw logs` (view/tail/filter), `nw history <ID>` (state timeline), structured transition events, log rotation
- Monorepo workspace detection (pnpm/yarn/npm)
- `nw doctor` health check command

**0.2.0 scope reduction.** Narrowed focus to the core orchestration pipeline. Removed: external task backends (GitHub Issues, ClickUp, Sentry, PagerDuty), sandboxing (nono, policy proxy), remote dashboard server, webhook notifications, and legacy migration commands. These features were working but added surface area beyond the narrowest wedge. They may return as separate packages or plugins.

**Crew mode foundation.** Multi-daemon coordination via WebSocket broker with creator-affinity scheduling -- items prefer the daemon whose human decomposed them, enabling easier steering and intervention. Affinity is a session-bounded preference, not a hard rule: when the creator's daemon hits its session limit, queued items overflow to other daemons. Review jobs are local-only and do not participate in crew claim scheduling. Mock broker for local testing, persistent daemon IDs, and reconnect state reconciliation. TUI displays crew status when connected.

**Competitive positioning.** Parallel AI coding exploded in early 2026: Claude Code Agent Teams (16+ agents), Cursor (8 agents), Superset IDE (10+ agents), dmux, Conductor. All launch parallel sessions. None decompose work, order dependencies, manage CI lifecycle, or orchestrate merges. ninthwave's moat is the integrated pipeline, not session launching.

## Principles

1. **Orchestrate around, never wrap.** ninthwave does not proxy AI tool calls, intercept responses, or inject middleware. Workers are full native instances of your AI tool. ninthwave manages what happens before the session starts and after the PR opens.

2. **Deterministic orchestration, intelligent workers.** The orchestrator is a TypeScript state machine -- no LLM calls, no non-determinism, no token costs. Workers are the intelligent agents.

3. **Convention over configuration.** The common case should work with zero config files. Only require explicit configuration when convention genuinely cannot cover the use case.

4. **Human-sized PRs.** Every work item targets 200-400 LOC of meaningful change -- small enough for a human to review meaningfully, large enough to be a coherent unit of work.

5. **Bring your own everything.** Your AI tool, your billing, your API keys, your task tracker, your CI. ninthwave is a coordination layer, not a platform.

6. **The friction log is the roadmap.** Dogfooding generates signal. Every friction point encountered while using ninthwave is a potential improvement.

7. **Delegate, don't debug.** The orchestrator's job is to detect problems and dispatch them to workers. It doesn't read source code, diagnose root causes, or attempt patches.

8. **Test confidence is merge confidence.** Every work item has a test plan. Every PR has verified test outcomes. The orchestrator surfaces aggregate test confidence.

9. **Reduce entropy, maintain outcomes.** Systems should get simpler over time, not more complex and fragile. Prefer removing code over adding code, fewer moving parts achieving the same results.

## What's Next

### CLI Redesign (in progress)

Restructuring the CLI mental model: `nw` (no args) adapts to project state, `nw <ID>` launches items with topo-sort, `nw watch` replaces `nw orchestrate`, `nw init` absorbs `nw setup`. Grouped help, rich per-command help pages, and an interactive no-args picker.

### Ninthwave Cloud -- Reporting & Analytics

The next evolution beyond the CLI. Ninthwave Cloud provides reporting and analytics for solo developers and engineering teams using AI coding orchestration.

- **DORA metrics.** Deployment frequency, lead time, change failure rate, and mean time to restore -- derived from the orchestrator's structured event stream.
- **Model usage analysis.** Token consumption, cost attribution, and model performance comparisons across work items and sessions. Helps engineers evaluate and compare efficiency, quality, and value across models.
- **Lead times and cycle efficiency.** Time from decomposition to merged PR, broken down by stage (queued, working, CI, review, merge). Identifies bottlenecks in the pipeline.
- **Review and rebase patterns.** Feedback round-trip times, review pass rates, rebase frequency. Surfaces friction points in the PR lifecycle.
- **Team insights.** Aggregate metrics across projects, teams, and time periods for engineering leaders. Answers: are we getting faster? Is quality holding? Where is the value?

### Sandboxing -- strait

Worker sandboxing is a longer-term vision being developed as a separate project: [strait](https://github.com/ninthwave-sh/strait). Sandboxing was previously shipped in ninthwave (nono integration) and removed in the 0.2.0 scope reduction. strait will provide isolation that integrates with ninthwave's worker lifecycle.

### Deferred

- **External task backends.** GitHub Issues, ClickUp, Sentry, PagerDuty integrations were removed in 0.2.0. May return as separate packages or plugins.
- **Remote session access.** Cloud tunnel provider and persistent domains. Foundation shipped; full implementation deferred.
- **Cross-repo orchestration.** Removed in scope reduction. May return as a plugin if there is demand.
- **Adaptive resource management.** Future extension beyond current capabilities.

## Non-Goals

What ninthwave will not become:

1. **Not an AI tool.** No LLM calls in the core pipeline. The daemon is deterministic TypeScript.

2. **Not a compute platform.** ninthwave never owns your compute, your code, or your AI tool billing.

3. **Not a CI/CD replacement.** ninthwave monitors your CI pipeline. It doesn't run tests or build code.

4. **Not a code review tool.** ninthwave orchestrates review workers but the review logic lives in the agent prompt, not the orchestrator. The human reviewer is always in the loop.

5. **Not a project management tool.** `.ninthwave/work/` is a lightweight work queue, not Jira.

6. **Not a monolithic agent.** Many small workers plus a deterministic orchestrator is the architecture. Decomposition and parallel execution is the point.

7. **Not a monitoring system.** ninthwave doesn't collect metrics or evaluate production health. Post-merge CI verification is orchestration -- completing the change lifecycle on GitHub -- not monitoring.

## Feature-Completeness

The CLI is approaching feature-completeness for the core orchestration pipeline. ninthwave is feature-complete when:

- A developer goes from spec to merged, reviewed PRs in a single command cycle.
- The pipeline handles all common failure modes automatically: CI failures, merge conflicts, review feedback, worker crashes, dependency ordering.
- Works with 3+ AI coding tools (currently: Claude Code, OpenCode, Copilot CLI).
- Extensible multiplexer support (ships with cmux, community can extend via Multiplexer interface).
- Post-merge CI verification completes the change lifecycle automatically.
- Every decomposed work item has a test plan with tracked outcomes.
- Resource management is automatic -- memory-aware session limits, no manual tuning.
- Install to working parallel session in under 10 minutes.
- Crew mode enables multi-daemon coordination for team workflows.

After CLI feature-completeness, the focus shifts to Ninthwave Cloud: reporting, analytics, and team insights built on the orchestrator's structured event stream.

