# Sandcastle adoption -- phase plan

Status: draft, pre-decompose
Owner: rob
Date: 2026-04-17
Companion: see `VISION.md` sections *Sandbox composition* and *Architecture evolution*

## Summary

Adopt [sandcastle](https://github.com/mattpocock/sandcastle) as ninthwave's sandbox primitive (worktree lifecycle + pluggable provider + agent invocation). Delete the ninthwave-native worktree + launch code that sandcastle replaces. Keep pipeline orchestration, daemon, PR lifecycle, crew mode, decomposition, and multiplexer support.

Alongside this, reposition strait from "ninthwave's sandbox runtime" to "in-container data plane composable with any sandbox". Reposition ninthwave's README around *spec -> stacked, reviewable PRs -> merged*.

## Decision

**Bigger bet, after a short de-risking spike.** Reasoning: incremental (parallel provider paths during transition) carries ~5-8 PRs of carrying-cost and real divergence risk; we are the only users; git is the rollback. The spike contains the downside of the bigger bet without the carrying cost of incremental.

## Phases

### Phase 0 -- Spike (1-2 days, single branch, no merge target)

Goal: validate sandcastle end-to-end for one real ninthwave work item, including subscription auth and commit extraction. Output: go/no-go plus list of upstream gaps.

- Wire one work item from `.ninthwave/work/` through a throwaway script that calls `sandcastle.createWorkspace()` + `createSandbox()` + `interactive()` (or `run()`).
- Host-credential mount: bind `~/.claude` (and equivalents) into a Docker bind-mount provider; confirm Claude Code authenticates against the user's subscription without API keys.
- Confirm commit extraction matches ninthwave's expectations (branch, messages, diff shape).
- Measure: does `interactive()` work headlessly enough for our daemon model, or do we need `run()` + log capture? Is `--dangerously-skip-permissions` acceptable in our threat model with strait in place?
- Capture every gap as an issue: upstream to sandcastle, adapt in ninthwave, or defer.

Exit criteria: one work item produces a mergeable PR via sandcastle-backed plumbing on a throwaway branch.

### Phase 1 -- Adapter layer

Goal: introduce the seam and the pieces unique to ninthwave that sandcastle does not provide.

- **SandboxProvider seam.** Introduce a thin interface in `core/` that today's code conforms to (no behavior change). Intent: one place to swap implementations in Phase 2.
- **Host-credential mount pattern.** Document and implement which host paths are mounted into which tool's sandbox (Claude Code, OpenCode, Copilot CLI, gh). Likely upstream a generic hook to sandcastle; we own the ninthwave-level recipe.
- **Multiplexer-as-inspection, not as-runtime.** Decouple cmux/tmux from the launch hot path. Sessions run inside sandcastle; multiplexer becomes an optional `nw attach` affordance for debugging.

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

- A developer installs ninthwave, runs `nw init`, gets prompted once for sandbox provider (default: Docker via sandcastle), and runs a real work item through to a merged PR using their existing Claude Code / OpenCode / Copilot subscription -- no API keys, no extra billing.
- `core/git.ts` worktree code and `core/commands/launch.ts` bootstrap are net-deleted (or net-reduced to an adapter).
- Inbox wait loops are gone; session-slot-minutes per work item are measurably lower.
- strait runs inside a sandcastle-provided container, enforcing egress policy, with zero ninthwave-side network code.
- README leads with the pipeline outcome; `nw` is not confused with "agent teams" products.

## Risks and open questions

- **sandcastle's `interactive()` blocks the calling process.** Resolution pending the Phase 0 spike; likely fine if sessions run under a multiplexer pane or via `run()` + log capture, and if we de-emphasize live TUI attachment (per our updated view that subscription auth, not TUI attachment, is the frictionless win).
- **Host-credential mount is not built into sandcastle.** We need to either upstream a generic hook or implement per-provider ourselves. Upstream is preferable for ecosystem health.
- **Completion-signal reliability across tools.** If any supported tool does not reliably emit the sentinel, we need a robust fallback (exit code + heartbeat) and tool-specific testing.
- **Coupling to sandcastle's release cadence.** Pinning a specific version is mandatory; contributing upstream for shared concerns is preferable to forking.
- **Provider parity.** Isolated providers (Vercel, Daytona) do not support `interactiveExec`. If we ever want live attach, we commit to bind-mount providers only for that mode. Acceptable given TUI attach is no longer central.
- **Strait timing.** Phase 4 depends on strait's in-container pivot landing. Track via strait repo.

## Next action

Schedule Phase 0 spike. One day if things go well, two if we hit auth mount snags. After the spike, run `/decompose` against this doc to generate the Phase 1-5 work items.
