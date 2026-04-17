# Sandcastle spike -- findings

Status: analysis complete, live Docker run still pending manual execution
Date: 2026-04-17
Target: `@ai-hero/sandcastle` v0.4.8 (latest at time of analysis)
Companion: `docs/sandcastle-adoption-plan.md`

## TL;DR

Sandcastle's programmatic API is a clean match for the ninthwave daemon model, but
three of the spike's five questions cannot be closed by desk research alone. The
plumbing and commit-extraction questions can be answered with high confidence
from the upstream source. The subscription-auth question has a clear answer but
an unfavourable one: sandcastle does not ship a blessed path for Claude Max
subscriptions, and the maintainer has publicly declined to recommend one. Live
container validation is still required before Phase 1 can start.

Recommendation: **conditional go**, gated on a one-afternoon live run on a
throwaway branch that exercises subscription auth with `CLAUDE_CODE_OAUTH_TOKEN`
(see [Outstanding live validation](#outstanding-live-validation) below). Phase 1
scope is substantially the same as the adoption plan proposed, with one
meaningful narrowing called out at the bottom.

## Methodology

This spike was executed in an ninthwave worker session, which has no Docker
daemon and no Claude subscription credentials available to it. That constrained
what could be validated empirically. The following were done here:

- Read `@ai-hero/sandcastle`'s public source (`src/index.ts`, `src/run.ts`,
  `src/Orchestrator.ts`, `src/AgentProvider.ts`, `src/createSandbox.ts`,
  `src/createWorktree.ts`, `src/sandboxes/docker.ts`) at tag `v0.4.8`.
- Read the project's README, the shipped `.sandcastle/Dockerfile`, and the full
  comment thread on [mattpocock/sandcastle#191 -- "Possible to use Claude
  subscription instead of ANTHROPIC_API_KEY?"](https://github.com/mattpocock/sandcastle/issues/191).
- Cross-walked sandcastle's surface against ninthwave's current
  `core/commands/launch.ts` and `core/git.ts`, including every worktree path
  (implementer, reviewer, rebaser, forward-fixer).

The following were **not** done here and remain outstanding:

- An actual `docker run` of a sandcastle sandbox.
- A live attempt to authenticate Claude Code via a bind-mounted `~/.claude`
  directory or via `CLAUDE_CODE_OAUTH_TOKEN`.
- Concurrent two-sandbox execution to confirm port/filesystem isolation in
  practice.
- An end-to-end replay of one merged ninthwave work item through sandcastle.

Those four items form the [Outstanding live validation](#outstanding-live-validation)
checklist. None of them change the direction of the recommendation, but each
can kill Phase 1 if it fails, so none should be skipped.

## The five required answers

### 1. Did subscription auth via bind-mount work for Claude Code?

**Not validated live, and the upstream posture is discouraging.**

Issue #191 is the canonical reference. The sandcastle maintainer (Matt Pocock)
has stated, publicly and repeatedly, that he cannot legally recommend using a
Claude subscription to drive sandcastle, citing unresolved compliance questions
with Anthropic. He does note, as a factual matter, that Anthropic itself
documents `claude setup-token` and the `CLAUDE_CODE_OAUTH_TOKEN` environment
variable for Claude Code headless use, and that sandcastle passes environment
variables through to the agent unchanged. That is the path to investigate in
the live run.

The plan's original framing -- bind-mount `~/.claude` into the container -- is
mechanically possible: `docker()` accepts arbitrary `mounts: [{ hostPath,
sandboxPath, readonly }]` entries, and bind-mounts survive the user-remap
(`agent`, uid 1000) that sandcastle's Dockerfile performs. But it is not a
blessed or tested path, and it carries at least two concrete risks that the
OAuth-token path does not:

- Credential file format churn. Claude Code's subscription state is stored as
  JSON under `~/.claude`; any field layout change breaks the mount silently.
- File-ownership drift. The Dockerfile remaps `node` (uid 1000) to `agent` (uid
  1000) and then `chown`s `/home/agent`. A mount at `/home/agent/.claude` gets
  `chown`ed at container start, which means the host file ownership can be
  rewritten under the user's foot. This is a real footgun we would ship to
  every ninthwave user.

The OAuth-token path is strictly safer: `CLAUDE_CODE_OAUTH_TOKEN` is a
well-defined environment variable that Anthropic documents, sandcastle passes
through cleanly, and it requires no filesystem-level coupling to the host. It
is also, critically, what the sandcastle maintainer obliquely points users at
when asked.

**Recommendation:** drop the bind-mount `~/.claude` pattern from the plan. The
ninthwave-level recipe becomes:

1. One-time: user runs `claude setup-token` on the host to mint
   `CLAUDE_CODE_OAUTH_TOKEN`.
2. Ninthwave stores the token in the project `.sandcastle/.env` (already
   gitignored by sandcastle's `init`) or -- better -- reads it from
   `~/.ninthwave/` and injects via the sandcastle provider `env` field at
   launch.
3. Ninthwave does *not* touch `~/.claude` on the host. This keeps us on the
   right side of the filesystem-boundary rule in `CLAUDE.md` ("ninthwave
   operates within the project directory and `~/.ninthwave/` only").

This changes the plan's "Host-credential mount" phase from a generic-mount
upstream contribution into a much smaller ninthwave-local concern: "inject
`CLAUDE_CODE_OAUTH_TOKEN` via sandcastle's existing provider env merge." No
upstream change needed for subscription auth to work.

### 2. Is `interactive()` or `run()` the correct entry point for ninthwave?

**`run()` and `createSandbox().run()` are the right fit. `interactive()` is
not.**

Reading `src/Orchestrator.ts` and `src/run.ts` makes this unambiguous:

- `run()` drives `buildPrintCommand` (which for Claude Code is `claude -p
  --mode stream-json ...`), streams JSON events line by line, hits an idle
  timeout if the agent goes quiet, stops on a configurable completion signal
  (default `<promise>COMPLETE</promise>`), and returns a typed result with
  `commits`, `branch`, `stdout`, and `iterationsRun`. This is exactly what the
  ninthwave daemon needs for headless worker invocation.

- `interactive()` is a TUI attach wrapper around `buildInteractiveArgs`. It
  takes over the terminal, which is a non-starter for the daemon, and it is
  limited to bind-mount and no-sandbox providers -- the isolated providers
  (Vercel, Daytona) do not support it. Since the plan has already de-emphasised
  live TUI attach, we do not need `interactive()` for the orchestrator hot path.

- `createSandbox({ branch }).run(...)` gives us a long-lived container that can
  handle multiple invocations on the same branch without paying container
  startup for each round. This is the right shape for ninthwave's event loop
  (initial run, then CI-fix runs, then review-feedback runs, all on the same
  branch). Commits accumulate; dependencies and build artifacts persist across
  rounds.

**Recommendation:** map ninthwave's four worker roles onto sandcastle as
follows:

| ninthwave worker | sandcastle entry point |
| --- | --- |
| Implementer (initial launch) | `createSandbox({ branch, sandbox, hooks })` + `sandbox.run({ agent, promptFile, completionSignal, maxIterations })` |
| CI-fix relaunch on same branch | Reuse existing `sandbox` handle, call `sandbox.run(...)` again |
| Reviewer (no auto-fix) | `run({ branchStrategy: { type: "head" }, ... })` or a sibling `createSandbox` on a review branch |
| Rebaser, forward-fixer | Either `createWorktree` + shell git, or a plain `sandbox.run()` with a dedicated prompt. `createWorktree` is probably overkill; the existing git-shell path is fine. |

Live TUI attach is deferred (per the plan). `nw attach` remains an optional
multiplexer-level affordance and does not live in the sandcastle hot path.

### 3. Does commit extraction match ninthwave's expectations?

**Mostly yes, with one integration gap: sandcastle does not push.**

`RunResult.commits: { sha: string }[]` and `RunResult.branch: string` match
ninthwave's expectations directly. The branch strategy `{ type: "branch",
branch: "ninthwave/${id}" }` maps 1:1 to our `ninthwave/{id}` convention.
Sandcastle's `WorktreeManager` handles branch creation, attach, and the "reuse
existing worktree on collision" case (`throwOnDuplicateWorktree: false`),
subsuming most of `ensureWorktreeAndBranch` in `core/commands/launch.ts`.

What sandcastle does **not** do:

- **Push to `origin`.** Commits land locally on the branch in the worktree;
  pushing is left to the caller. Ninthwave currently relies on the implementer
  prompt to `git push -u origin ninthwave/{id}` at PR-creation time. That
  continues to work under sandcastle (the prompt runs inside the sandbox, which
  has `git` and `gh`), but if we ever want sandcastle to push for us we will
  have to layer that on ourselves. This is not a gap per se -- it is a design
  choice -- but it is worth noting.
- **PR reconciliation.** Sandcastle has no concept of "this branch already has
  an open PR; skip launch and let the daemon handle CI" -- that is the
  `validatePickupCandidate` / `classifyPrMetadataMatch` logic in
  `core/commands/launch.ts` and `core/work-item-files.ts`. It stays in
  ninthwave as adapter logic before we ever call into sandcastle.
- **Partition allocation.** Sandcastle gives isolation per sandbox (each is its
  own container) but does not know about database partitions or port
  reservations. Ninthwave's `core/partitions.ts` and the `YOUR_PARTITION` env
  var stay. We pass them into the sandcastle prompt via `promptArgs` and inject
  partition-keyed env vars via the sandcastle provider's `env` option.
- **Stale `index.lock` cleanup** from `cleanStaleIndexLocks()`. Sandcastle's
  `WorktreeManager` may or may not hit this case; if it does, we either
  upstream the cleanup or retain it as a pre-sandcastle adapter step.

### 4. What sandcastle gaps exist?

See [Gap list](#gap-list) below for the categorised version. The summary:

- **Upstream to sandcastle:** one small contribution (`CLAUDE_CODE_OAUTH_TOKEN`
  documented as a first-class subscription-auth path), one medium
  contribution (optional `postCreate` git hook analogous to
  `.ninthwave/hooks/post-worktree-create`). The subscription-auth piece may
  need to wait on upstream compliance clarity from Anthropic; the post-create
  hook is pure plumbing.
- **Adapt locally:** partition allocation, PR reconciliation, stale-lock
  cleanup, launch-override tool profiles for Copilot CLI / OpenCode / etc.
  (sandcastle only has Claude Code, pi, codex, opencode as shipped agents; our
  `core/ai-tools.ts` profiles stay as the routing layer), inbox-wait retirement
  (Phase 3 of the plan).
- **Defer:** Vercel / isolated-provider support (we do not need it yet),
  strait composition (Phase 4 of the plan, gated on the strait in-container
  pivot), live TUI attach across providers (de-emphasised).

### 5. Go / no-go recommendation and revised Phase 1 scope

**Conditional go.** The API shape is right; the architectural fit is good; the
rewrite arithmetic ("Phase 2 deletes ninthwave's worktree + launch plumbing, we
add one adapter layer") holds up under scrutiny. The one open risk --
subscription auth -- has a documented escape hatch
(`CLAUDE_CODE_OAUTH_TOKEN`) that is almost certainly the right answer.

The "conditional" is the live run called out in the next section. Until that
run has produced a green branch with real commits and confirmed that
`CLAUDE_CODE_OAUTH_TOKEN` is the path forward, we should not start Phase 1.

**Revised Phase 1 scope:**

- Unchanged: introduce a thin `SandboxProvider` seam in `core/` that conforms
  today's code. Unchanged because it is the right shape regardless of which
  sandbox engine we adopt underneath.
- **Narrowed:** "Host-credential mount pattern" becomes "inject
  `CLAUDE_CODE_OAUTH_TOKEN` from `~/.ninthwave/` into the sandcastle provider
  env." No `~/.claude` bind-mount. This keeps ninthwave inside its filesystem
  boundary (per `CLAUDE.md`).
- **Pulled forward from Phase 2:** wire `createSandbox` + `sandbox.run` for the
  implementer path only, end-to-end, on one work item, in one PR. The
  remaining worker roles (reviewer, rebaser, forward-fixer) follow in separate
  stacked PRs inside Phase 2.
- Unchanged: "multiplexer-as-inspection, not as-runtime" -- this is a
  documentation-only change in Phase 1.
- **Added:** upstream the `CLAUDE_CODE_OAUTH_TOKEN` docs contribution to
  sandcastle in parallel with Phase 1. Low risk, high ecosystem value.

## Gap list

### Upstream to sandcastle

1. **Document `CLAUDE_CODE_OAUTH_TOKEN` as the Claude-subscription path.**
   Currently buried in issue #191 comments. A small PR to the README and
   `ClaudeCodeOptions` docs would unstick a real adoption blocker. Pure docs;
   no compliance risk for sandcastle itself (Anthropic ships this token
   mechanism).
2. **Optional `onWorktreeReady` hook.** Ninthwave has a `post-worktree-create`
   bootstrap hook that runs on the host before the sandbox starts (for copying
   gitignored config, running deps-installs that need host state, etc.).
   Sandcastle has `hooks.onSandboxReady`, which runs inside the sandbox after
   start. These cover different phases. Proposing an `onWorktreeReady` host-side
   hook would be broadly useful to anyone mixing host tooling with sandcastle
   sandboxes.

### Adapt locally

1. **Partition allocation.** Keep `core/partitions.ts`. Pass `YOUR_PARTITION`
   into the prompt via `promptArgs`. Inject partition-keyed env vars (e.g.
   `DATABASE_URL`, port numbers) into sandcastle via the `env` option on the
   sandbox provider.
2. **PR reconciliation.** Keep `validatePickupCandidate` and the "existing-PR
   short-circuit" path in `launchSingleItem`. Sandcastle has no equivalent and
   does not need to.
3. **Stale index.lock cleanup.** Keep `cleanStaleIndexLocks()` as a pre-
   sandcastle adapter step, at least until we have evidence that sandcastle's
   `WorktreeManager` already handles this case.
4. **AI tool profiles.** Ninthwave supports Claude Code plus Copilot CLI,
   OpenCode, and others via `core/ai-tools.ts`. Sandcastle supports a fixed
   set. For tools sandcastle does not ship, either (a) build a one-off custom
   `AgentProvider` in ninthwave's codebase, or (b) fall back to the current
   multiplexer-based launch path for those tools. Option (a) is cleaner
   long-term.
5. **Inbox wait loop retirement.** Already in the plan as Phase 3; the gap is
   just that sandcastle's completion-signal contract
   (`<promise>COMPLETE</promise>` by default, configurable) is our lever. We
   document it in `agents/implementer.md` and drop the inbox wait loop.
6. **Headless logs.** Ninthwave writes `headlessLogFilePath(...)` for each
   worker. Sandcastle writes to `.sandcastle/logs/<branch>.log`. We can keep
   sandcastle's path (and update `nw logs` to read from it) or add a `logging:
   { type: "file", path: ninthwaveHeadlessLogPath }` override. The latter is
   probably the right call; it keeps `nw logs` unchanged.
7. **`HUB_ROOT` vs `PROJECT_ROOT` distinction.** Sandcastle bind-mounts the
   worktree as the sandbox's working directory and has no notion of a separate
   "hub" (where `.ninthwave/work/` lives). Ninthwave already handles this via
   the system prompt variables; sandcastle does not interfere with it.

### Defer

1. **Isolated providers (Vercel, Daytona).** Not needed until we target cloud
   runners. The bind-mount providers (Docker, Podman) cover local development.
2. **Strait composition.** Phase 4 of the plan; gated on strait's in-container
   pivot. Sandcastle supports Docker networks per container, which is the
   right hook point, but the integration work is entirely in the strait repo
   for now.
3. **Live TUI attach across providers.** De-emphasised already. If we ever
   re-prioritise, it is a bind-mount-only feature and `interactive()` is the
   entry point.
4. **PR-creation / push logic moving into sandcastle.** Leave it in the
   worker prompt for now. Revisit only if we find ourselves re-implementing
   the same push logic per tool profile.

## Outstanding live validation

These four checks must pass on a throwaway branch before Phase 1 begins. None
can be done from an ninthwave worker session; all require a laptop with
Docker Desktop and a signed-in Claude Max subscription.

1. **Subscription auth via `CLAUDE_CODE_OAUTH_TOKEN`.** Run `claude
   setup-token` on the host. Persist the token. In a one-off sandcastle
   script:

   ```ts
   import { run, claudeCode } from "@ai-hero/sandcastle";
   import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

   await run({
     agent: claudeCode("claude-opus-4-6", {
       env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! },
     }),
     sandbox: docker(),
     prompt: "Print 'hello from inside sandcastle'. Then output <promise>COMPLETE</promise>.",
     branchStrategy: { type: "branch", branch: "spike/sandcastle-auth" },
   });
   ```

   Expected: green run, no `ANTHROPIC_API_KEY` in the environment, one trivial
   commit on `spike/sandcastle-auth`.
2. **Work-item replay.** Pick one recently merged ninthwave work item (small
   scope, docs or refactor). Copy its markdown body into a prompt file. Call
   `createSandbox({ branch: "spike/<id>-replay", sandbox: docker(), hooks: {
   onSandboxReady: [{ command: "bun install" }] })` then `sandbox.run({ agent:
   claudeCode(...), promptFile: ..., maxIterations: 5, completionSignal:
   "<promise>COMPLETE</promise>" })`. Diff the resulting branch against the
   historical merge.
3. **Concurrent two-sandbox run.** Spawn two `createSandbox` calls with
   distinct branches (`spike/a`, `spike/b`), each doing a trivial file write
   and commit. Confirm both finish cleanly, no port or volume collision, and
   the resulting branches are independent.
4. **Log/commit extraction parity.** Compare `result.commits` (sandcastle) with
   `git log --format=%H origin/main..HEAD` inside the worktree. Confirm they
   match exactly and cover every commit the agent made.

If any of these fails, document the specific failure mode in a follow-up
friction entry and halt the Phase 1 kickoff.

## Keeper spike code

Nothing in this PR. The spike script above should live on a throwaway branch
(`spike/sandcastle-oauth`) and be discarded after validation. The one piece
of code worth keeping long-term is the `CLAUDE_CODE_OAUTH_TOKEN` injection
pattern, which will be implemented properly in Phase 1 against the adapter
seam, not lifted verbatim from the spike.

## What this means for the adoption plan

See the accompanying edits to `docs/sandcastle-adoption-plan.md`. The summary
of changes there:

- Phase 0 exit criteria rewritten to match the live-validation checklist
  above.
- Phase 1 "Host-credential mount" narrowed to "inject
  `CLAUDE_CODE_OAUTH_TOKEN`"; bind-mount `~/.claude` dropped.
- Risks section updated to reflect that upstream subscription-auth guidance is
  blocked on Anthropic compliance clarity, not on sandcastle itself.
- Success criteria reworded to say `CLAUDE_CODE_OAUTH_TOKEN`, not "existing
  Claude Code / OpenCode / Copilot subscription" (the latter is misleading --
  OpenCode and Copilot auth work differently and will need their own
  per-provider analysis before Phase 2 expands beyond the Claude Code path).
