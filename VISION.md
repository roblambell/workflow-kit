# Vision

## The Thesis

AI coding tools are single-session by nature. One context window, one work item, one PR at a time. A feature with eight work items means eight sequential sessions, eight rounds of waiting for CI, eight manual PR flows. The AI does the hard part — writing code — but you do the tedious part: picking the next item, watching CI, managing merges, forwarding review feedback, rebasing. You become the bottleneck in your own AI-assisted workflow.

The answer isn't bigger context windows or smarter agents that do everything in one session. The answer is decomposition into human-reviewable units plus parallel execution. This is how engineering teams already work — just with people instead of AI sessions. The missing piece is the orchestration layer: what to work on, in what order, how many at once, what to do when CI fails or a reviewer pushes back.

ninthwave is that orchestration layer. It doesn't write code. It manages the pipeline that does. You decompose a feature into work items, ninthwave launches parallel sessions — each a full native instance of whatever AI tool you already use — sequences dependencies, monitors CI, dispatches feedback, and merges. You review every PR before it lands. The AI writes code; ninthwave manages the factory floor.

## What Exists Today

v0.1.0 shipped March 2026. This is what's real and working:

- **Decompose + orchestrate pipeline.** `/decompose` breaks a spec into batched work items (~200-400 LOC each). `ninthwave orchestrate` runs an event-driven daemon that launches workers, monitors CI and PR state, merges, cleans up, and recovers from crashes. The full cycle: spec in, merged PRs out.

- **Deterministic orchestrator, intelligent workers.** The orchestrator is a TypeScript state machine with 13 states and pure transition functions. It never calls an LLM. Workers are the intelligent agents — full AI coding sessions that implement, test, review, and open PRs. This split keeps orchestration predictable, auditable, and cheap. Token costs scale with the number of work items, not with orchestration complexity.

- **Multi-tool, no lock-in.** Works with Claude Code, OpenCode, Copilot CLI, and anything supporting the [Agent Skills standard](https://agentskills.io). Workers read your project's instruction files for conventions. No proxy, no billing layer, no API key management.

- **Convention over configuration.** Cross-repo resolves via sibling directories. Port isolation via partition math. Domain slugs from section headers. Zero config for the common case.

- **Self-developing.** ninthwave dogfoods itself. The friction log from that process has surfaced 11 issues and driven multiple improvements. The L-VIS recurring item in TODOS.md keeps the self-improvement loop running.

- **Competitive positioning (Q1 2026).** Parallel AI coding exploded: Claude Code Agent Teams (16+ agents), Cursor (8 agents), Superset IDE (10+ agents), dmux, Conductor. All launch parallel sessions. None decompose work, order dependencies, manage CI lifecycle, or orchestrate merges. ninthwave's moat is the integrated pipeline, not session launching. Agent Teams is complementary (intra-task collaboration on one item) while ninthwave is inter-task orchestration (N workers on N items).

## Principles

1. **Orchestrate around, never wrap.** ninthwave does not proxy AI tool calls, intercept responses, or inject middleware. Workers are full native instances of your AI tool. ninthwave manages what happens before the session starts and after the PR opens. This is the most important principle and the one that differentiates ninthwave from agent frameworks.

2. **Deterministic orchestration, intelligent workers.** The orchestrator is a TypeScript state machine — no LLM calls, no non-determinism, no token costs. Workers are the intelligent agents. This split keeps the orchestrator predictable, auditable, testable, and cheap. The orchestrator handles the mechanical lifecycle; workers handle the thinking.

3. **Convention over configuration.** The common case should work with zero config files. Cross-repo resolves via sibling directories. Port isolation via partition math. Domain slugs from section headers. Only require explicit configuration when convention genuinely cannot cover the use case.

4. **Human-sized PRs.** Every work item targets 200-400 LOC of meaningful change — small enough for a human to review meaningfully, large enough to be a coherent unit of work. This is not a sizing guideline; it's a product requirement. If the AI produces 2000-line PRs, the human loses the ability to audit. ninthwave's value depends on the human staying in the review loop.

5. **Bring your own everything.** Your AI tool, your billing, your API keys, your task tracker, your CI. ninthwave is a coordination layer, not a platform. No vendor lock-in at any level.

6. **The friction log is the roadmap.** Dogfooding generates signal. Every friction point encountered while using ninthwave is a potential improvement. L-VIS cycles review the friction log and decompose actionable items into TODOs. This is not aspirational — it's how v0.1.0 was built.

7. **Delegate, don't debug.** The orchestrator's job is to detect problems and dispatch them to workers. It doesn't read source code, diagnose root causes, or attempt patches. When CI fails, tell the worker. When a review comment appears, forward it. The orchestrator manages the pipeline; workers do the thinking.

8. **Test confidence is merge confidence.** Every work item has a test plan. Every PR has verified test outcomes. The orchestrator surfaces aggregate test confidence so humans review with context. ninthwave doesn't run tests — it tracks and surfaces the results of tests that workers and CI already run.

## What's Next

Six priority areas over the next 6-12 months. Not dated milestones — ordered by dependency and impact.

### A. Solidify the Foundation *(largely achieved)*

Make what exists reliable, well-documented, and pleasant for a solo developer on a single repo.

- ~~Resolve known friction: domain slug truncation, worker friction logging in dogfood mode.~~ Done. Friction fixes (DF-1 through DF-5) decomposed and in progress.
- ~~Complete the orchestrate integration in `/work`.~~ Done. Phase 3 continuous delivery loop shipped.
- First-run experience: `ninthwave init` for zero-config onboarding (INI-1, INI-2 in progress). Goal: any git repo → working parallel session in under 5 minutes with zero manual input.
- ~~Exhaustive state machine testing.~~ Done (M-TST-1).
- ~~Test confidence in decompose.~~ Done — `**Test plan:**` field is now required for every work item.

### A-bis. Visibility & Developer Experience *(new, from competitive analysis)*

Make ninthwave's work visible, measurable, and professional-feeling.

- **Terminal status UI** — beautiful real-time display with color-coded agent states, batch progress, and auto-pane in cmux (STU-1, STU-2).
- **Webhook notifications** — Slack/Discord integration for orchestrator lifecycle events (WHK-1). Team visibility beyond the operator.
- **Time-to-ship analytics** — structured metrics per run, `ninthwave analytics` command for trends (ANL-1, ANL-2). Data-driven pipeline improvement.
- **Web dashboard** — local web UI at localhost:9876 for orchestration state visualization (Phase 4).

### A-ter. Decomposition Quality *(new, competitive moat)*

The integrated pipeline (decompose → batch → orchestrate → merge) is ninthwave's moat. Parallel session launching is now commodity (5+ tools do it as of Q1 2026). Decomposition quality determines PR quality.

- **Decomposition templates** — pre-built patterns for common work types: API endpoint, frontend component, database migration (TPL-1).
- **Self-improving decomposition** — local learning from past orchestration runs. Items touching conflict-prone file pairs get auto-split (Phase 4).
- **Community learning (opt-in)** — anonymized decomposition quality metrics contributed back to improve the product (Phase 5, SaaS-adjacent).
- **Wildcard dependencies** — cleaner dependency declarations with pattern matching (WLD-1, already implemented).

### B. Sandboxed Workers

Workers run in isolated environments. Prevent accidental destructive operations and contain blast radius.

Tiered approach based on trust level and environment:

- **Local/lightweight (default):** [nono](https://github.com/always-further/nono) — kernel-level sandboxing via Seatbelt (macOS) and Landlock (Linux). Zero startup latency, granular filesystem allowlisting, snapshot and rollback, credential injection via proxy. Best fit for trusted local development. Convention: this is the default, zero-config.
- **Policy-driven:** [leash](https://github.com/strongdm/leash) — container-based isolation with Cedar policy engine. Full audit trail of every filesystem access and network connection. For environments needing complete observability and composable policies.
- **Maximum isolation:** [Firecracker](https://github.com/firecracker-microvm/firecracker) microVMs — hardware virtualization via KVM. Minimal overhead, battle-tested at AWS Lambda scale. For untrusted code or multi-tenant scenarios.

Worker snapshots enable pre-commit review of filesystem changes before they're applied to the repo.

### C. Remote Session Access

Worker sessions accessible via auth-protected web links, posted directly on PRs.

Two access modes depending on what cmux sockets support:

- **Full TUI:** As close to the exact terminal session as possible — observe or interact with the worker in real time.
- **Chat interface:** Stripped-down, chat-optimized view when full TUI isn't feasible.

Infrastructure:

- **Tunnels:** cloudflared exposes local cmux sessions through Cloudflare tunnels. No port forwarding, no VPN.
- **Managed domain + auth:** Free `*.yourproject.ninthwave.sh` subdomains with Cloudflare Access for authentication. This is the one thin managed layer ninthwave offers — domain routing and auth only. Compute stays on your machine or your infra.

Use cases: team visibility into worker progress, reviewer jumps into a session from the PR link, remote pair debugging with a stuck worker.

### D. LLM Supervisor

An optional advisory layer on top of the deterministic daemon.

- Opt-in via `--supervisor` flag on `ninthwave orchestrate`. Auto-activates in dogfooding mode.
- Periodically reviews the daemon's structured logs and applies judgment: stuck workers, repeating CI errors, patterns suggesting systemic issues, process improvements the daemon can't detect.
- Advisory outputs only: structured log events, friction log entries, suggested actions (send worker a hint, adjust WIP). The daemon continues regardless of supervisor output.
- **Key principle: the LLM makes itself less necessary over time.** Each dogfooding cycle should move more intelligence from the supervisor into deterministic daemon logic. The supervisor's job is to detect what the daemon doesn't handle yet — then that detection gets codified.

### E. Expand the Surface Area

- **External task backends.** Two categories: (1) Project management — Linear adapter first, then ClickUp, GitHub Issues. Work items created by humans or planning tools. (2) Observability/alerting — Sentry adapter first, then PagerDuty, CloudWatch. Work items created by production signals. Both use the same three-operation interface: list items, read item, mark done. TODOS.md remains the built-in default.
- **GitHub Action for CI/CD failures.** `ninthwave-sh/create-todo` — a thin GitHub Action that appends a TODO to TODOS.md when a CD workflow fails. Bridges CI/CD signals into the work queue for teams using TODOS.md without an external task backend.
- **Multiplexer abstraction.** tmux and zellij as alternative backends. Three operations to abstract: create session, send message, list sessions. cmux remains the default.
- **Smarter resource management.** Memory-aware WIP limits based on available RAM. Adaptive scaling under load. Document: each worker consumes ~2-3GB (AI tool + language server + worktree).
- **Cross-repo maturity.** Monorepo workspace support (pnpm/yarn/turborepo). Dependency ordering across repos.

## Non-Goals

What ninthwave will not become:

1. **Not an AI tool.** No LLM calls in the core pipeline. The supervisor is opt-in, advisory, and designed to shrink over time as its patterns get codified into the daemon.

2. **Not a compute platform.** ninthwave never owns your compute, your code, or your AI tool billing. The one exception: optional managed domain routing and auth for remote session access (`*.yourproject.ninthwave.sh` via Cloudflare Access). This is a thin coordination layer — your workers, your machine, your infrastructure.

3. **Not a CI/CD replacement.** ninthwave monitors your CI pipeline. It doesn't run tests or build code. The worker runs tests locally; CI is the authoritative check.

4. **Not a code review tool.** ninthwave dispatches review feedback to workers. It doesn't perform reviews. It integrates with review skills you bring. The human reviewer is always in the loop.

5. **Not a project management tool.** TODOS.md is a lightweight work queue, not Jira. For teams with existing task management, ninthwave connects via adapters.

6. **Not a monolithic agent.** Many small workers plus a deterministic orchestrator is the architecture. It's not a stepping stone to a single agent that handles everything in one session. Decomposition and parallel execution is the point.

7. **Not a monitoring system.** ninthwave doesn't collect metrics, set alert thresholds, or evaluate production health. It accepts work items from systems that do — via task backend adapters (Sentry, PagerDuty) or the `create-todo` GitHub Action for CI/CD failures. Production signals flow through your existing tools into ninthwave's work queue.

## Feature-Completeness

ninthwave is feature-complete when:

- A developer goes from spec to merged, reviewed PRs in a single command cycle.
- The pipeline handles all common failure modes automatically: CI failures, merge conflicts, review feedback, worker crashes, dependency ordering.
- Works with 3+ AI coding tools. *(Achieved: Claude Code, OpenCode, Copilot CLI.)*
- Works with 2+ terminal multiplexers. *(In progress — tmux adapter in TODOS.md.)*
- Connects to 2+ task backends. *(Not yet.)*
- Connects to 2+ observability/alerting backends (Sentry, PagerDuty). *(Not yet.)*
- GitHub Action bridges CI/CD failures into TODOS.md. *(Not yet.)*
- Every decomposed work item has a test plan with tracked outcomes. *(Test plan field required since v0.1.0. Outcome tracking via analytics — in progress.)*
- Workers run sandboxed by default. *(Not yet.)*
- Remote session links posted on PRs with auth. *(Not yet.)*
- Resource management is automatic — memory-aware WIP, no manual tuning. *(Not yet.)*
- Install to working parallel session in under 10 minutes. *(`ninthwave init` in progress — targeting under 5 minutes with zero manual input.)*

After feature-completeness, ninthwave enters maintenance: bug fixes, compatibility updates for new AI tools and platforms, and community-driven extensions.

## The Self-Improvement Loop

ninthwave uses itself to develop itself. This is not a metaphor — the v0.1.0 release was built this way.

The cycle: decompose a feature into TODOs, process them via `ninthwave orchestrate` with auto-merge, review the friction log after each batch, decompose actionable friction into new TODOs, repeat until no actionable friction remains.

The **L-VIS recurring item** in TODOS.md is the mechanism. When all other TODOs complete, L-VIS triggers: review this document against the current state, check the friction log, identify the next most impactful capability, decompose it into TODOs, add a new L-VIS-(N+1) depending on the terminal items. The cycle continues.

The supervisor layer will eventually automate friction detection during orchestration, making the loop tighter. But the core mechanic — dogfood, log friction, decompose, work, repeat — is already running.
