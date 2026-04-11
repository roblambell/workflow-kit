# Worker Health Recovery Plan

**Status:** Draft for engineering review
**Date:** 2026-04-01
**Problem area:** worker reliability, orchestration, TUI + headless tool supervision

## Problem

Workers can hit terminal or retryable AI tool failures while their surrounding session still exists.

Example:
- A TUI worker shows a provider error like `server_is_overloaded`
- The cmux/tmux workspace is still alive
- The orchestrator still treats the item as healthy because it sees a live workspace or a recent-looking heartbeat
- The item stops making progress and burns a session slot until a timeout or manual intervention

Headless has the mirrored problem in reverse:
- The process may exit because the tool failed
- But the orchestrator only sees a dead process, not whether the failure was retryable, fatal, or a clean completion

Today the system is good at detecting crashed workers and stale activity. It is weak at detecting semantic tool failure.

## Goals

1. Detect tool-level failure separately from process/session liveness.
2. Recover automatically from retryable provider/tool failures.
3. Fail fast and clearly on permanent misconfiguration or auth/quota failures.
4. Work across both TUI-backed workers and headless workers.
5. Stay deterministic in the orchestrator hot path.
6. Keep the diff small enough to ship incrementally.

## Constraints

- No LLM in the orchestrator hot path, per `ETHOS.md`.
- No writes outside the project tree and `~/.ninthwave/`.
- The launch path already flows through `core/ai-tools.ts`, `core/commands/launch.ts`, `core/headless.ts`, `core/snapshot.ts`, and `core/orchestrator.ts`.
- TUI backends only expose `readScreen`, `listWorkspaces`, and lifecycle control. They do not currently expose structured tool events.
- Headless already owns a detached process, pid file, and append-only log file.

## What Already Exists

Existing code we should reuse, not rebuild:

- `core/snapshot.ts`
  Polls PR state, worker liveness, commit freshness, and heartbeat files. This is the natural place to attach a worker-health snapshot.
- `core/orchestrator.ts`
  Already separates pure transition logic from side effects. New health signals should enter here through `ItemSnapshot`, not through ad hoc shell calls in the state machine.
- `core/ai-tools.ts`
  Already centralizes tool-specific behavior. Tool-specific failure classification belongs here or in a directly adjacent helper.
- `core/headless.ts`
  Already owns pid files and logs. This is the right place to add headless worker status files.
- `mux.readScreen(...)`
  Already gives best-effort tail output for cmux, tmux, and headless logs.
- Existing stuck/retry flow in `core/orchestrator.ts` and `core/orchestrator-actions.ts`
  We should feed better failure reasons into the existing retry and stuck machinery instead of inventing a second recovery loop.

What this plan reuses:
- Existing retry counters and `stuckOrRetry()` behavior
- Existing `readScreen()` plumbing for TUI output sampling
- Existing headless log + pid directories under `userStateDir(projectRoot)`

What this plan does **not** rebuild:
- A second orchestrator loop
- An LLM-based anomaly detector
- A full PTY proxy for TUI in the first iteration

## Decision Summary

Ship this in two layers.

### Layer 1: Common health model + TUI output classification

Add a first-class worker-health signal that can say:
- `healthy`
- `retryable-error`
- `fatal-error`
- `exited-success`
- `unknown`

For TUI workers, derive that signal from recent screen output plus existing liveness/activity signals.

### Layer 2: Structured headless runner status

Wrap headless tool launches in a small `nw worker-runner` command that:
- spawns the real AI tool
- classifies known tool failures
- writes a machine-readable status file
- retries internally only for immediate transient bootstrap failures when that is clearly safe
- exits with explicit status so the orchestrator can distinguish fatal vs retryable failures

This gives headless a clean contract without requiring the orchestrator to reverse-engineer meaning from raw logs.

## Why This Shape

This is the smallest path that improves both TUI and headless.

- TUI needs a read-only inference path first because the terminal session itself is the product surface.
- Headless can support a real supervisor contract now because ninthwave already owns the detached process boundary.
- Both paths can converge on the same `WorkerHealthSnapshot` type inside snapshot/orchestrator code.

## Architecture

### 1. Common health model

Add a shared internal shape used by snapshot building and transition logic.

```ts
type WorkerHealthState =
  | "healthy"
  | "retryable-error"
  | "fatal-error"
  | "exited-success"
  | "unknown";

interface WorkerHealthSnapshot {
  state: WorkerHealthState;
  source: "screen" | "headless-status" | "process-exit";
  reason?: string;
  detectedAt: string;
  retryAfterMs?: number;
}
```

Extend `ItemSnapshot` with an optional `workerHealth` field.

Rule of thumb:
- Heartbeat answers: "what is the worker doing?"
- Worker health answers: "is the tool still able to continue?"
- Process/session liveness answers: "does a container/shell still exist?"

These are different signals. Today they are partially conflated.

### 2. Tool failure classification

Add tool-specific output classification behind the AI tool profile boundary.

```text
tail output -> tool profile classifier -> WorkerHealthSnapshot?
```

Known initial patterns to classify:

- Retryable
  - provider overloaded / service unavailable
  - transient network transport failures
  - temporary rate limiting where waiting is expected
- Fatal
  - auth failure
  - invalid API key
  - quota exhausted without local recovery path
  - invalid model / unsupported agent / broken CLI invocation
- Explicit success
  - headless worker exits 0 after the tool run completes

Important rule:
- Unknown text never becomes a failure.
- Classification is opt-in and conservative.

### 3. TUI-backed workers

Use existing `mux.readScreen()` as the observation point.

```text
cmux/tmux workspace
   -> readScreen(last N lines)
   -> classify via tool profile
   -> attach workerHealth to snapshot
   -> orchestrator retries, pauses, or marks stuck
```

TUI behavior:
- If output matches a retryable tool failure, treat the worker as unhealthy even if the workspace is alive.
- Close the workspace and use the existing retry path with bounded retries and backoff.
- If output matches a fatal tool failure, close the workspace and mark the item `stuck` with a specific `failureReason`.
- If output indicates an active composing/generating state, treat it as a positive activity signal and suppress false stall detection.

This directly addresses the friction note captured in `.ninthwave/friction/2026-03-27T13-11-30Z--supervisor.md` before review cleanup removed the inbox entry.

### 4. Headless workers

Replace direct raw tool execution with a thin runner:

```text
orchestrator
   -> launch headless workspace
   -> sh -c "exec nw worker-runner ..."
      -> spawn real tool
      -> stream stdout/stderr to existing headless log
      -> classify known failures
      -> write workers/<id>.status.json
      -> exit with explicit result
```

Status file shape:

```json
{
  "id": "H-RSH-4",
  "state": "retryable-error",
  "reason": "provider overloaded: server_is_overloaded",
  "detectedAt": "2026-04-01T12:00:00.000Z",
  "retryAfterMs": 30000,
  "attempt": 1,
  "tool": "opencode"
}
```

Headless snapshot logic:
- Prefer status-file health over pid-only liveness.
- If pid is dead and status says `retryable-error`, use retry flow.
- If pid is dead and status says `fatal-error`, go `stuck` immediately.
- If pid is dead and there is no status file, fall back to current dead-process logic.

### 5. Orchestrator transition changes

The orchestrator should check `workerHealth` before relying on session existence.

For `implementing`:
- `retryable-error` -> bounded retry path, with failure reason preserved
- `fatal-error` -> `stuck` immediately, preserve workspace output if possible
- `healthy` -> continue normal heartbeat / commit / PR progression
- `unknown` -> continue existing liveness and timeout logic

For `launching`:
- `fatal-error` during startup should short-circuit to `stuck`
- `retryable-error` during startup should short-circuit to retry without waiting for launch timeout

For `ci-failed` with a still-running worker:
- if the worker is semantically dead because the tool hit a fatal error, stop notifying it as if it were responsive

### 6. Backoff policy

Retryable tool failures need a short, explicit backoff so we do not churn hot loops.

Proposed policy:
- Reuse existing item retry budget
- Add retry delay metadata from classification when known
- Default to exponential backoff capped at a few minutes

```text
attempt 1: 30s
attempt 2: 60s
attempt 3: 120s
cap: 300s
```

The orchestrator remains deterministic because the delay policy is static and local.

## Minimal File Plan

Keep this to one new file plus focused edits.

Expected touched files:
- `core/ai-tools.ts`
- `core/snapshot.ts`
- `core/orchestrator-types.ts`
- `core/orchestrator.ts`
- `core/headless.ts`
- `core/commands/launch.ts`
- `core/commands/orchestrate.ts`
- `test/orchestrator-unit.test.ts`
- `test/headless.test.ts`
- `test/launch.test.ts`
- `test/orchestrate.test.ts`
- `test/async-snapshot.test.ts`
- `test/contract/build-snapshot.test.ts`
- `test/scenario/stuck-detection.test.ts`

One new file:
- `core/worker-runner.ts`

This is slightly broad, but still one feature slice. Most changes are narrow type/plumbing updates.

## Data Flow Diagram

```text
                        ACTIVE WORKER OBSERVATION

                +-------------------------------+
                | snapshot.ts                   |
                +-------------------------------+
                    |               |
                    |               |
          TUI path  |               |  headless path
                    |               |
                    v               v
          mux.readScreen()     read status.json + pid/log
                    |               |
                    +-------+-------+
                            |
                            v
                 ai-tools classifier / status parser
                            |
                            v
                 WorkerHealthSnapshot on ItemSnapshot
                            |
                            v
                    orchestrator.handleImplementing()
                            |
       +--------------------+----------------------+
       |                    |                      |
       v                    v                      v
   healthy             retryable-error         fatal-error
       |                    |                      |
       v                    v                      v
  normal flow         retry + backoff         stuck + preserve
                                                  diagnostics
```

## Failure Scenarios

### Scenario A: TUI provider overload

```text
tool prints provider error
  -> workspace still alive
  -> screen classifier marks retryable-error
  -> orchestrator closes workspace
  -> item retries after backoff
```

### Scenario B: Headless auth failure

```text
worker-runner sees invalid auth output
  -> writes fatal-error status file
  -> process exits
  -> snapshot reads fatal-error
  -> orchestrator marks stuck immediately
```

### Scenario C: Active long generation with little output

```text
worker is composing
  -> screen classifier detects active generation marker
  -> workerHealth stays healthy
  -> existing timeout logic is suppressed by positive activity
```

### Scenario D: Unknown output format

```text
screen/log text does not match known patterns
  -> workerHealth = unknown
  -> current heartbeat/liveness/commit logic remains in control
```

## Test Strategy

### Unit

- classifier maps known retryable strings to `retryable-error`
- classifier maps known fatal strings to `fatal-error`
- unknown output returns `undefined` or `unknown`
- headless status parser prefers status file over pid-only inference
- orchestrator transitions on `workerHealth` before timeout-based fallback

### Integration

- snapshot attaches `workerHealth` from TUI `readScreen`
- snapshot attaches `workerHealth` from headless status files
- retry path preserves failure reason and uses bounded retries
- fatal path lands in `stuck` and captures screen/log tail

### Scenario coverage

- TUI workspace alive + overload error => retry, not wait-for-timeout
- TUI workspace alive + fatal auth error => stuck immediately
- headless pid dead + retryable status => retry
- headless pid dead + fatal status => stuck
- active composing marker + stale commit time => not stuck

## Rollout Plan

### Phase 1

Common worker health type + TUI screen classification.

Success criteria:
- a live-but-broken TUI worker no longer burns a slot until timeout
- existing timeout and retry behavior still works for unknown cases

### Phase 2

Headless `worker-runner` + status file contract.

Success criteria:
- headless retryable vs fatal failures are distinguishable in snapshot and status output
- existing headless launch and cleanup behavior remains stable

### Phase 3 (explicitly deferred)

Evaluate whether TUI needs a true PTY supervisor instead of read-screen inference.

Only do this if:
- screen classification proves too brittle
- or the tool vendors expose structured events we can consume cleanly

## Worktree Parallelization Strategy

This work should be decomposed into parallelizable slices with one serialization point:

- Parallel slice A: common health model + TUI classifier + orchestrator wiring
- Parallel slice B: headless status contract + worker-runner
- Parallel slice C: status/TUI rendering polish and regression tests after A/B land

Dependency rule:
- B can proceed in parallel with A if both agree on the shared `WorkerHealthSnapshot` shape first.
- C should wait until A and B stabilize their status vocabulary.

## Risks

1. False positives from output classification.
   Mitigation: conservative pattern list, unknown stays unknown, strong regression tests.

2. Divergent behavior across tools.
   Mitigation: keep classification table per tool profile, not global regex soup.

3. Headless wrapper adds launch complexity.
   Mitigation: ship wrapper only for headless, keep TUI launch unchanged in phase 1.

4. Retry churn during provider incidents.
   Mitigation: explicit backoff and existing retry budgets.

## NOT in scope

- Full PTY proxy/supervisor for cmux/tmux workers
  Rationale: stronger long-term option, but too much surface area for the first reliability wedge.
- LLM-based anomaly detection or adaptive classification
  Rationale: violates the deterministic-core constraint and is unnecessary for known failure strings.
- New UI panels or analytics dashboards for worker health
  Rationale: reliability signal first, UI polish second.
- Cross-process distributed lease coordination
  Rationale: current problem is worker semantic failure, not multi-daemon leadership.
- New publish/distribution pipeline
  Rationale: this change introduces no new external artifact; `worker-runner` is an internal CLI command executed by Bun inside the existing repo.

## Open Questions For Review

1. Should retryable TUI failures consume the existing `retryCount`, or should tool-transient retries have their own smaller budget?
2. Should headless retry backoff live in `worker-runner`, in the orchestrator, or split between both?
3. Do we want `workerHealth` exposed in daemon state / TUI immediately, or can that wait until after recovery logic lands?
