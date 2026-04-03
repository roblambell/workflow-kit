# TUI Responsiveness Plan

**Status:** Draft for engineering review
**Date:** 2026-04-01
**Problem area:** orchestration, TUI, event-loop isolation

## Problem

`nw watch` feels responsive most of the time, then freezes for stretches.

That matches the current architecture. The TUI, keyboard handler, render path, polling loop, and all orchestrator side effects run in the same Bun process. Whenever that process does synchronous `git`, `gh`, `cmux`, or heavier filesystem work, the terminal UI stops processing input until the blocking work finishes.

The user-facing requirement is stronger than "reduce stalls."

We need the TUI to stay responsive even while GitHub polling, local git maintenance, merge actions, workspace updates, and review/rebase actions are happening.

## Goals

1. Keep keyboard input and screen repaint responsive while orchestration work is running.
2. Remove hard coupling between TUI responsiveness and blocking subprocess calls.
3. Preserve the existing `nw watch` behavior, controls, and status views.
4. Reuse existing daemon/state infrastructure where it helps.
5. Ship this incrementally, with measurable before/after evidence.

## Non-goals

- Rewriting the orchestrator state machine.
- Replacing `gh`, `git`, or `cmux` with native library bindings.
- Perfect real-time streaming of every internal event before we have isolation.
- Changing JSON mode or non-TUI semantics unless needed for shared plumbing.

## Investigation

The freezes are explainable from current code.

### Blocking paths on the TUI thread today

1. `core/commands/orchestrate.ts:1995-2006`
   Once per minute, the main loop does synchronous `fetchOrigin()` and `ffMerge()` for the hub repo and every active cross-repo target. Both call `run()` -> `Bun.spawnSync(...)`.

2. `core/commands/orchestrate.ts:2158-2161` and `core/commands/orchestrate.ts:1305-1442`
   Every orchestrator action executes inline on the same thread as the TUI. Merge, rebase, workspace cleanup, review launch, commit status updates, and post-merge reconcile all happen synchronously from the watch loop.

3. `core/commands/orchestrate.ts:2186-2189` and `core/commands/orchestrate.ts:761-812`
   `syncWorkerDisplay()` runs after each poll and calls synchronous `cmux` status/progress updates per active item. That is up to two subprocesses per active worker on every cycle.

4. `core/external-review.ts:39-162`
   When external review is enabled, `processExternalReviews()` calls `scanExternalPRs()`, which uses a synchronous `gh api` request.

5. `core/schedule-processing.ts:56-269`
   Scheduled task monitoring does synchronous workspace listing on its 30s cadence.

6. `core/snapshot.ts:422-621`
   `buildSnapshotAsync()` improved GitHub polling by using async subprocesses, but it still runs inside the same event loop and still mixes in synchronous mux and filesystem work. It reduces stalls. It does not guarantee isolation.

### Important existing evidence in the code

- `core/gh.ts:205-209` explicitly says the async variants were added to keep the TUI responsive during poll cycles.
- `core/shell.ts:40-45` says the same for `runAsync()`.
- `core/commands/orchestrate.ts:3011-3023` already wires the loop to `buildSnapshotAsync()`, so the project has already tried the "make more polling async" direction.

That helps, but it is not enough for the stated requirement because any remaining synchronous work in the same process can still freeze input.

## Step 0 Findings

### What existing code already helps

- `core/daemon.ts`
  Already persists orchestrator state outside the repo and gives us a stable project-scoped runtime directory.
- `core/commands/orchestrate.ts:2892-2942`
  Already has an `onPollComplete()` hook that builds a TUI-facing state snapshot after each loop.
- `core/commands/orchestrate.ts:614-747`
  `runTUI()` already models the TUI as a consumer of status/log providers, not as the owner of orchestration logic.
- `forkDaemon`, `readStateFile`, and `writeStateFile`
  Give us a usable process boundary and persistence story.

### Minimum change that actually achieves the goal

The smallest change that gives a hard responsiveness guarantee is not "find and fix every blocking call."

It is: move orchestration off the TUI process.

If we keep one shared Bun event loop, the guarantee is always fragile. One missed `spawnSync`, one slow `cmux` command, one future helper using `execSync`, and the TUI freezes again.

### Complexity check

This plan touches more than 8 files, but it should introduce only one real new concept:

- a foreground orchestration child process plus a narrow control/event protocol

That is acceptable complexity because it removes a class of bugs instead of chasing individual call sites forever.

### Recommendation

Prefer a separate process boundary over a "convert more helpers to async" cleanup pass.

Why:
- Separate process gives a real guarantee.
- Reusing the existing daemon/state model is boring technology.
- Async-only cleanup would still leave the TUI vulnerable to future regressions.

## Decision Summary

Split interactive watch into two roles:

1. **Operator process**
   Owns raw stdin, render timers, overlays, and local view state.

2. **Engine process**
   Owns `orchestrateLoop`, polling, git/gh/cmux side effects, worker display sync, and runtime mutations.

The TUI becomes a thin client. The orchestrator engine can block, and the TUI still paints and handles keys.

## Why This Shape

This is the boring answer. Good.

We already know the codebase can persist and render state snapshots. We already know the daemon model works. The missing piece is using that separation for the foreground TUI instead of keeping orchestration and input in the same process.

Trying to "audit every sync call forever" is the kind of fix that works until the next refactor. Not great.

## Architecture

### 1. Process model

```text
terminal
  |
  +-- operator process (new foreground UI shell)
  |     - raw stdin
  |     - render loop
  |     - local selection / overlay state
  |     - sends control messages
  |     - receives snapshots + logs
  |
  +-- engine process (orchestrator runner)
        - orchestrateLoop
        - git / gh / cmux / filesystem side effects
        - worker display sync
        - state persistence
        - applies runtime controls
```

The operator process never calls `git`, `gh`, or `cmux` during normal interaction.

### 2. Communication model

Use a small IPC protocol for foreground interactive mode.

```text
operator -> engine
  set-merge-strategy
  set-review-mode
  set-collaboration-mode
  set-session-limit
  extend-timeout
  shutdown

engine -> operator
  snapshot
  log-entry
  control-applied
  warning
  fatal
```

Initial version should use a Bun/Node child-process IPC channel or stdio JSON lines.

Recommendation: use child-process IPC first if Bun supports it cleanly in this repo. If not, use JSON lines over stdout/stderr plus a control pipe/file in `userStateDir(projectRoot)`.

Do not introduce a network server or WebSocket for local foreground control. That spends an innovation token for no benefit.

### 3. Snapshot ownership

The engine remains the source of truth.

After each poll cycle, and after any applied control or important action result, the engine emits a full TUI snapshot. The payload should already be render-oriented: status rows, log entries, countdown metadata, selected-item-safe identifiers, and view metadata. Do not send raw `OrchestratorItem[]` and make the operator rebuild orchestration-derived state on every repaint.

The operator caches the latest snapshot and repaints independently on keypress or a short render timer.

```text
engine poll/action/control
  -> build latest runtime snapshot
  -> emit snapshot
  -> operator caches it
  -> operator renders at its own cadence
```

This means a slow engine cycle can make the data stale, but not the UI unresponsive. That is the right tradeoff.

### 4. Runtime control handling

Today runtime controls directly mutate the live `Orchestrator` from keyboard handlers.

After the split:
- keyboard handlers update local TUI presentation immediately
- operator sends a control command to the engine
- engine applies the change and emits `control-applied` plus an updated snapshot

The operator can show pending state for debounce-sensitive controls, the same way it already does for merge strategy.

### 5. Rendering model

The operator process should own a fixed repaint cadence independent of poll cadence.

Recommendation:
- repaint immediately on keypress
- repaint on snapshot arrival
- repaint on a low-frequency idle timer for countdowns and elapsed-time fields

The operator should never wait for a poll cycle before updating overlays, selection, or countdown visuals.

### 6. Failure handling

If the engine process dies or disconnects, the TUI must not hang in raw mode.

Show a foreground overlay like:

```text
Engine disconnected.

[r] Restart engine
[q] Quit watch
```

The operator remains alive long enough to restore terminal state cleanly.

### 7. Daemon mode relationship

Do not create a second orchestration architecture.

Instead, extract a shared engine runner that both of these use:
- existing detached daemon mode
- new foreground interactive engine child

That keeps one place where orchestration runs and one place where snapshots are emitted.

## Scope Boundaries

### In scope

- Foreground interactive watch isolation
- Runtime control protocol for the current TUI controls
- Snapshot/log streaming from engine to operator
- Clean engine disconnect handling
- Instrumentation proving reduced input stalls

### Not in scope

- Full remote-control API for third-party clients
- Reworking crew protocol beyond what is needed to forward current TUI controls and snapshots
- Replacing state-file persistence used by detached daemon/status commands

## Rollout Plan

### Phase 1. Measure and expose current stalls

Add instrumentation before refactor so we can prove the improvement.

Add:
- event-loop lag sampler in interactive mode
- per-stage timing around poll, action execution, main refresh, display sync, and render
- warning logs when a single synchronous stage exceeds a threshold like 100ms / 250ms / 1000ms

Acceptance:
- We can point to concrete log entries showing where freezes come from today.
- Tests cover stage timing aggregation and warning thresholds.

### Phase 2. Extract shared engine runner

Create a reusable engine entry that:
- accepts startup config
- runs `orchestrateLoop`
- emits snapshots/log events outward
- applies runtime control messages inward

Acceptance:
- Detached daemon mode and interactive child mode both use the same engine runner.
- Existing non-TUI behavior stays unchanged.

### Phase 3. Convert interactive watch to operator + engine

Change foreground `nw watch` so the parent process is only the operator shell and the child is the engine.

Acceptance:
- TUI key handling and repaint continue while the engine is busy.
- Ctrl-C, quit, completion prompt, and alt-screen teardown still work correctly.
- The operator renders from transport snapshots, not from live orchestrator state.

### Phase 4. Tighten the contract and clean up assumptions

After isolation lands, remove direct TUI-to-orchestrator mutation paths and any remaining interactive-only assumptions inside `orchestrate.ts`.

Acceptance:
- Runtime controls flow only through the protocol.
- No foreground TUI code path reaches into blocking git/gh/cmux helpers.

## Detailed Design Notes

### A. Where the operator should get data

Preferred order:

1. live IPC snapshots from the engine in foreground interactive mode
2. persisted daemon state file for detached/background status views

This avoids forcing the operator to read and parse state files on every keypress.

### B. What remains blocking after the split

The engine will still block internally. That is acceptable.

Examples:
- merge actions
- `fetchOrigin()` / `ffMerge()`
- `cmux set-status` and `set-progress`
- external PR review scans

Those no longer block the TUI because they run in the engine process.

### C. Why not just finish the async migration

Because that still leaves us with these failure modes:

- a future helper using `run()` or `execSync()`
- synchronous `cmux` helpers in a code path nobody remembered to audit
- CPU-heavy render or snapshot logic starving input on the same event loop

The requirement says the TUI should be decoupled from blocking work. Process separation is the cleanest way to satisfy that sentence literally.

## Risks and Mitigations

### Risk 1. Control/state drift between operator and engine

Failure scenario:
The user changes merge strategy or WIP in the TUI, but the engine does not apply it or applies it late, so the screen lies.

Mitigation:
- treat engine snapshot as authority
- mark local control changes as pending until acknowledged
- add tests for rejected, delayed, and reordered control messages

### Risk 2. Engine death leaves terminal broken

Failure scenario:
The child process crashes while stdin is in raw mode.

Mitigation:
- operator always owns raw mode and alt-screen lifecycle
- operator handles child exit and restores terminal state even on unexpected child death

### Risk 3. Two execution modes diverge

Failure scenario:
Detached daemon mode and interactive child mode slowly drift into different behavior.

Mitigation:
- one shared engine runner
- mode-specific wrappers only for transport/bootstrap
- regression tests that exercise both wrappers against the same fake engine hooks

### Risk 4. Snapshot volume or render churn gets noisy

Failure scenario:
The engine emits too often and the operator repaints excessively.

Mitigation:
- coalesce snapshot sends per poll cycle plus important immediate events
- keep operator render loop idempotent and cheap

## Test Diagram

```text
TUI ISOLATION TEST COVERAGE
===========================

[+] operator process
    |
    +-- receives keypress while engine is blocked
    |     -> selection/help/overlay updates still render
    |
    +-- receives delayed snapshot
    |     -> paints latest known state, no raw-mode breakage
    |
    +-- engine exits unexpectedly
    |     -> disconnect overlay, clean terminal restore
    |
    +-- pending control update
          -> optimistic UI state, then engine ack or rollback

[+] engine process
    |
    +-- blocking refresh/action path
    |     -> snapshot emission resumes after completion
    |
    +-- control message while busy
    |     -> applied in order, reflected in next snapshot
    |
    +-- detached daemon wrapper
          -> still writes state file and runs shared engine path

[+] end-to-end
    |
    +-- foreground watch with fake blocked git/cmux call
    |     -> keyboard quit/help/detail remains responsive
    |
    +-- merge strategy / WIP / timeout extension controls
    |     -> flow through IPC and persist correctly
    |
    +-- engine crash during watch
          -> user sees recovery overlay, no stuck terminal
```

## Test Plan

- Add operator/engine protocol unit tests covering message encoding, pending control state, ack handling, and disconnect handling.
- Add foreground watch integration tests with a fake engine that intentionally blocks before sending the next snapshot, proving the operator still handles keypresses and repaint.
- Add regression tests for runtime controls: merge strategy, review mode, collaboration mode, WIP changes, and timeout extension through the protocol.
- Add daemon-wrapper tests proving detached daemon mode still uses the shared engine runner and still writes persisted state.
- Add instrumentation tests for event-loop lag sampling and long-stage warning thresholds.

Acceptance: During a simulated multi-second blocking engine task, the operator process still responds to `q`, `?`, navigation keys, and overlay toggles without waiting for the engine task to finish. Existing watch semantics remain intact, detached daemon mode still works, and timing logs show blocking work moved out of the operator process.

## Key Files

- `core/commands/orchestrate.ts`
- `core/daemon.ts`
- `core/tui-keyboard.ts`
- `core/status-render.ts`
- `core/shell.ts`
- `core/gh.ts`
- `core/git.ts`
- `core/cmux.ts`
- `test/orchestrate.test.ts`
- `test/tui-keyboard.test.ts`

## Proposed Work Breakdown

1. Add responsiveness instrumentation and stage timing around the current interactive watch loop.
2. Extract a shared orchestration engine runner with snapshot emission and control-message intake.
3. Move foreground interactive watch to an operator parent process plus engine child process.
4. Route runtime controls and shutdown/recovery handling through the operator-engine protocol.
5. Add regression and integration coverage for blocked-engine responsiveness, disconnect handling, and shared daemon behavior.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | - | - |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | - | - |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | Completed | 3 findings resolved in plan: choose process isolation over async-only cleanup, keep one shared engine runner, emit render-oriented snapshots rather than raw orchestrator state |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | - | - |

**VERDICT:** ENG REVIEW COMPLETE. Recommended direction is to split foreground watch into an operator process and a shared orchestration engine child, ship instrumentation first, and prove responsiveness with blocked-engine regression tests.
