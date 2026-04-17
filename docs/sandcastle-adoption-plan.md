# Sandcastle adoption -- phase plan

Status: Phase 0 spike analysis complete, live validation pending (see `docs/sandcastle-spike-findings.md`)
Owner: rob
Date: 2026-04-17 (plan), 2026-04-17 (spike analysis)
Companion: `docs/sandcastle-spike-findings.md`; see also `VISION.md` sections *Sandbox composition* and *Architecture evolution*

## Summary

Adopt [sandcastle](https://github.com/mattpocock/sandcastle) as ninthwave's sandbox primitive (worktree lifecycle + pluggable provider + agent invocation). Delete the ninthwave-native worktree + launch code that sandcastle replaces. Keep pipeline orchestration, daemon, PR lifecycle, crew mode, decomposition, and multiplexer support.

Alongside this, reposition strait from "ninthwave's sandbox runtime" to "in-container data plane composable with any sandbox". Reposition ninthwave's README around *spec -> stacked, reviewable PRs -> merged*.

## Decision

**Bigger bet, after a short de-risking spike.** Reasoning: incremental (parallel provider paths during transition) carries ~5-8 PRs of carrying-cost and real divergence risk; we are the only users; git is the rollback. The spike contains the downside of the bigger bet without the carrying cost of incremental.

## Phases

### Phase 0 -- Spike (1-2 days, single branch, no merge target)

Goal: validate sandcastle end-to-end for one real ninthwave work item, including subscription auth and commit extraction. Output: go/no-go plus list of upstream gaps.

**Status: analysis complete; live run pending. See `docs/sandcastle-spike-findings.md` for full findings.** Verdict: conditional go.

Revised exit criteria (from the spike findings, supersedes the original bullets):

- One-off script exercises `createSandbox({ branch, sandbox: docker() }).run({ agent: claudeCode(...), ... })` on a throwaway branch and produces the expected commit.
- Subscription auth confirmed via `CLAUDE_CODE_OAUTH_TOKEN` injected through the sandcastle provider `env` field. **The earlier bind-mount `~/.claude` approach has been dropped** -- see the findings doc for rationale (maintainer position, file-ownership risk, filesystem-boundary rule in `CLAUDE.md`).
- Commit extraction via `RunResult.commits` matches `git log origin/main..HEAD` exactly.
- Two concurrent `createSandbox` calls on distinct branches run cleanly with no resource collision.
- `run()` (not `interactive()`) is the orchestrator hot-path entry point.
- Gaps categorised into upstream / adapt-locally / defer. See the findings doc's Gap list for the concrete list.

### Phase 1 -- Adapter layer

Goal: introduce the seam and the pieces unique to ninthwave that sandcastle does not provide.

- **SandboxProvider seam.** Introduce a thin interface in `core/` that today's code conforms to (no behavior change). Intent: one place to swap implementations in Phase 2.
- **Subscription-auth injection (was: host-credential mount).** Inject `CLAUDE_CODE_OAUTH_TOKEN` from `~/.ninthwave/` into sandcastle via the provider `env` field. No `~/.claude` bind-mount (see spike findings). Upstream contribution to sandcastle: document the `CLAUDE_CODE_OAUTH_TOKEN` path in their README as the Claude-subscription entry point.
- **Multiplexer-as-inspection, not as-runtime.** Decouple cmux/tmux from the launch hot path. Sessions run inside sandcastle; multiplexer becomes an optional `nw attach` affordance for debugging.
- **Pulled forward from Phase 2: end-to-end implementer path on sandcastle.** Land one real work item through `createSandbox` + `sandbox.run` on the implementer role only. Reviewer, rebaser, and forward-fixer follow in Phase 2.

### Phase 2 -- Delegate to sandcastle

Goal: land the engine swap as a single coordinated feature branch (stacked PRs acceptable; single merge gate).

- Replace `core/git.ts` worktree creation/removal with `sandcastle.createWorkspace()`.
- Replace `core/commands/launch.ts` worker bootstrap with `sandcastle.createSandbox()` + agent invocation.
- Delete ninthwave-native partition math if sandcastle providers handle port/network namespacing adequately; otherwise retain as adapter logic.
- Wire pipeline events (spec, CI-fail, review-feedback) to fresh `run()` invocations against the persisted workspace.
- Retire the inbox wait loop in favor of worker completion signals (see Phase 3).

### Phase 3 -- Completion-signal protocol

Goal: eliminate the inbox wait loop; standardize "done" detection across supported tools.

- Define sentinel format (e.g. `<ninthwave-done status="complete|needs-review|blocked"/>`), documented in `agents/implementer.md` and the review worker prompts.
- Validate reliability per tool (Claude Code, OpenCode, Copilot CLI): does the agent emit the sentinel before exit in the common and edge cases? If not, document the fallback (process exit + heartbeat timeout).
- Remove the inbox wait loop from worker prompts. On review feedback, orchestrator spawns a fresh sandcastle run.
- Measure: sessions-minutes saved, subscription quota reclaimed.

### Phase 4 -- strait composition

Goal: deliver strait as a first-class in-container data plane that composes with sandcastle providers (per the strait pivot commit).

- Package strait as a devcontainer feature or container init module.
- Document the wiring: how a sandcastle Docker provider initializes strait inside the container (iptables REDIRECT, root-vs-agent trust boundary).
- Ship a sensible default policy (deny-by-default egress, allowlist for common package registries and the AI tool's API endpoints).
- Add an `nw` flag to opt in/out of strait per work item or per project.

### Phase 5 -- README + positioning refresh

Goal: reposition ninthwave around *spec -> stacked, reviewable PRs -> merged*.

- Rewrite the README hook around the pipeline outcome, not the parallelism mechanism.
- Add a *How it runs* section crediting sandcastle (sandbox), strait (data plane), and the ninthwave daemon (pipeline) as composable layers.
- Add a commands / API table (sandcastle-style) for scannability.
- Update marketing surfaces (tap formula description, social blurbs) to match.

## Out of scope for this plan

- Ninthwave Cloud (reporting / analytics). Continues on its existing trajectory.
- CLI redesign. Continues; this plan does not block or fork it.
- Cross-repo orchestration, remote session access, adaptive resource management (all previously deferred).

## Success criteria

- A developer installs ninthwave, runs `nw init`, gets prompted once for sandbox provider (default: Docker via sandcastle), completes a one-time `claude setup-token` to mint `CLAUDE_CODE_OAUTH_TOKEN`, and runs a real work item through to a merged PR using their existing Claude Max subscription -- no API keys, no extra billing. (OpenCode and Copilot CLI auth flows differ and are out of scope for the initial Claude Code path; they come in a follow-up after Phase 2 lands the adapter seam.)
- `core/git.ts` worktree code and `core/commands/launch.ts` bootstrap are net-deleted (or net-reduced to an adapter).
- Inbox wait loops are gone; session-slot-minutes per work item are measurably lower.
- strait runs inside a sandcastle-provided container, enforcing egress policy, with zero ninthwave-side network code.
- README leads with the pipeline outcome; `nw` is not confused with "agent teams" products.

## Risks and open questions

- **sandcastle's `interactive()` blocks the calling process.** Resolved by the spike: we use `run()` / `createSandbox().run()` on the hot path, not `interactive()`. TUI attach is deferred and becomes an `nw attach` multiplexer affordance, not part of the sandbox runtime.
- **Upstream subscription-auth guidance is blocked on Anthropic compliance clarity.** The sandcastle maintainer has publicly declined to recommend subscription auth pending Anthropic's position (see sandcastle issue #191). Anthropic does document `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` for headless Claude Code, and sandcastle passes env vars through unchanged, so the mechanism works today. Risk: Anthropic tightens this path. Mitigation: we document the fallback (API-key mode) clearly; users who already have an API key are not worse off than today.
- **Completion-signal reliability across tools.** If any supported tool does not reliably emit the sentinel, we need a robust fallback (exit code + heartbeat) and tool-specific testing. Sandcastle's default signal is `<promise>COMPLETE</promise>` but is fully configurable via `completionSignal`.
- **Coupling to sandcastle's release cadence.** Pinning a specific version is mandatory; contributing upstream for shared concerns is preferable to forking.
- **Provider parity.** Isolated providers (Vercel, Daytona) do not support `interactiveExec`. If we ever want live attach, we commit to bind-mount providers only for that mode. Acceptable given TUI attach is no longer central.
- **Non-Claude tools are not covered by the Phase 1 auth recipe.** The `CLAUDE_CODE_OAUTH_TOKEN` path is Claude-Code-specific. OpenCode and Copilot CLI auth flows will each need their own analysis before we expand adoption beyond Claude Code.
- **Strait timing.** Phase 4 depends on strait's in-container pivot landing. Track via strait repo.

## Next action

Complete the [live validation checklist](./sandcastle-spike-findings.md#outstanding-live-validation) in the spike findings doc on a throwaway branch (one afternoon on a laptop with Docker Desktop and a Claude Max subscription). If all four checks pass, run `/decompose` against this doc to generate the Phase 1-5 work items. If any check fails, log the failure mode and reconsider before proceeding.
