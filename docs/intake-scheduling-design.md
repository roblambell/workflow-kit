# Intake Scheduling Design

## Problem

The orchestrator's session management conflates three concerns:

1. **Resource estimation** -- auto-reducing the limit based on free RAM (unreliable, consumption varies wildly per workspace)
2. **Concurrency control** -- how many items can be in flight at once
3. **Flow control** -- whether to accept new work at all

We want to separate these cleanly: remove the resource estimation, keep concurrency control explicit, and add a proper flow control toggle.

## Current Model

```
sessionLimit = 5
  + calculateMemorySessionLimit()  --> effectiveSessionLimit (auto-reduced by RAM)
  + activeSessionCount             --> counts items with workspace refs
  + availableSessionSlots          --> effectiveSessionLimit - activeSessionCount
```

Problems:

- **Memory auto-adjustment is unreliable.** Each workspace's actual consumption depends on the AI tool, the project, what tests run, etc. The auto-reduction adds complexity without trustworthy results.
- **effectiveSessionLimit indirection.** Extra getter/setter machinery that exists only to support memory adjustment. Once that's gone, this layer has no purpose.
- **Workspace-ref counting misses dead workers.** If a worker dies but the item is still in an active state, it should count -- it's a commitment the orchestrator will recover.
- **No drain mode.** Minimum is clamped to 1. There's no way to say "finish what's in flight, don't start new work."
- **Setting limit to 0 loses your number.** If drain mode were `maxInflight = 0`, resuming means the user has to remember their preferred concurrency level.

## Proposed Model

Two orthogonal controls:

### 1. `maxInflight` (number, default 1, min 1)

How many work items can be concurrently in active states. Replaces `sessionLimit`.

- Counts items in `ACTIVE_SESSION_STATES` (state-based, not workspace-based)
- An item with a dead worker still counts (it's a commitment the orchestrator will recover)
- No memory auto-adjustment -- the user sets the number they're comfortable with
- No effectiveSessionLimit indirection -- the configured value is the value
- Adjustable at runtime via TUI hotkeys (`+`/`-`)
- Persisted in config as `max_inflight`
- CLI flag: `--max-inflight`

### 2. `acceptingWork` (boolean, default true, runtime-only)

Whether the orchestrator accepts new work. When not accepting work:

- No new items are launched (launchReadyItems returns early)
- In-flight items continue through their full lifecycle normally
- Workers keep running: CI, review, rebase, fix-forward all proceed
- TUI shows a clear NOT ACCEPTING WORK indicator
- `+`/`-` still adjust maxInflight (so when you resume accepting, the right limit is ready)
- Toggle via TUI hotkey

acceptingWork is NOT persisted to config. Each `nw` session starts accepting work. This is an in-session flow control, not a preference.

### Combined Behavior

| Scenario | maxInflight | acceptingWork | Effect |
|----------|-----------|--------|--------|
| Normal operation | 3 | true | Launch items while activeItemCount < 3 |
| At capacity | 3 | true | No launches (3 items already in flight) |
| Draining | 3 | false | No launches; in-flight items finish normally |
| Fully drained | 3 | false | Idle; orchestrator is quiet |
| Resume after drain | 3 | true | Launches resume immediately; limit remembered |

### Why Two Controls

A single `maxInflight = 0` for drain mode loses information. The user's preferred concurrency level disappears when they drain. With a separate toggle:

- Drain: press `p`. Limit stays at 3. Items finish.
- Resume: press `p` again. Limit is still 3. New items launch immediately.
- Adjust while draining: press `+`. Limit moves to 4. When you resume accepting work, you get 4 slots.

The limit is a preference. The toggle is an action.

## What Changes

### Remove

| What | Where | Why |
|------|-------|-----|
| `calculateMemorySessionLimit()` | `core/orchestrator-types.ts` | Unreliable, adds complexity |
| `BYTES_PER_WORKER` | `core/orchestrator-types.ts` | Only used by memory calc |
| `_effectiveSessionLimit` | `core/orchestrator.ts` | Indirection layer for memory calc |
| `setEffectiveSessionLimit()` | `core/orchestrator.ts` | Sets the indirection value |
| `effectiveSessionLimit` getter | `core/orchestrator.ts` | Reads the indirection value |
| Memory adjustment block | `core/orchestrate-event-loop.ts` (lines ~999-1013) | Per-cycle RAM check |
| Memory calc in run-items | `core/commands/run-items.ts` | Batch launch limit |

### Rename

| Before | After | Scope |
|--------|-------|-------|
| `sessionLimit` | `maxInflight` | TypeScript properties everywhere |
| `session_limit` | `max_inflight` | Config key, JSON schema |
| `--session-limit` | `--max-inflight` | CLI flag |
| `activeSessionCount` | `activeItemCount` | Orchestrator property |
| `availableSessionSlots` | `availableInflightSlots` | Orchestrator property |
| `setSessionLimit()` | `setMaxInflight()` | Orchestrator method |
| `computeDefaultSessionLimit()` | `computeDefaultMaxInflight()` | Event loop helper |
| `pendingSessionLimit` | `pendingMaxInflight` | TUI state |

### Change

| What | Before | After |
|------|--------|-------|
| Counting method | Items with any workspace ref | Items in `ACTIVE_SESSION_STATES` |
| Minimum value | `Math.max(1, ...)` | `Math.max(1, ...)` (stays 1; drain is via acceptingWork) |
| Launch gating | `activeSessionCount < effectiveSessionLimit` | `acceptingWork && activeItemCount < maxInflight` |

### Add

| What | Where | Details |
|------|-------|---------|
| `acceptingWork` state | `core/orchestrator.ts` | Boolean, runtime-only, default true |
| Accept-work toggle | `core/tui-keyboard.ts` | TUI hotkey |
| Not-accepting indicator | `core/status-render.ts` | Visual feedback in TUI |
| Config migration | `core/config.ts` | Read old `session_limit` key as fallback |

## What Stays the Same

- Per-item counting (one item = one slot, regardless of subsidiary workers)
- Review priority ordering (`transitionItem` before `launchReadyItems` in `processTransitions`)
- Green-idle parking in manual mode
- Human feedback routing to implementer
- All orchestrator state machine transitions
- Manual mode: review done --> workspace closed, slot freed, respawns on human feedback

## Interaction with Other Controls

### Merge strategy

- **auto/bypass**: Items flow through automatically. Not accepting work stops new launches but lets in-flight items merge.
- **manual**: Items stop at review-pending for human review. Not accepting work is additive -- stops new launches AND in-flight items still stop at the manual gate.

### AI reviews

Orthogonal. Whether reviews are AI-powered or skipped doesn't affect intake scheduling. Reviews are "free" in slot terms (per-item counting, not per-workspace).

### Collaboration mode

Orthogonal. Whether the session is local or collaborative doesn't change how intake scheduling works.

## Blast Radius

~180 references in `core/`, ~420 in `test/` across ~40 files. Most work is mechanical rename. Behavioral changes (remove memory calc, add state-based counting, add acceptingWork toggle) touch ~5 core files.

### Key files

- `core/orchestrator-types.ts` -- type definitions, config, defaults
- `core/orchestrator.ts` -- state machine, counting, launch gating
- `core/orchestrate-event-loop.ts` -- poll loop, memory adjustment removal
- `core/tui-keyboard.ts` -- hotkey handling, accept-work toggle
- `core/status-render.ts` -- TUI display, not-accepting indicator
- `core/config.ts` -- config schema, migration
- `core/commands/orchestrate.ts` -- CLI flag handling
- `core/commands/run-items.ts` -- batch launch path

### Related docs

- `docs/local-first-runtime-controls-spec.md` -- references "session limit" in startup flow and runtime controls; will need updating

## Open Questions

1. **Accept-work toggle hotkey.** `p` for "pause"? Space bar? Something else? Must not conflict with existing TUI hotkeys.

2. **TUI not-accepting display.** How prominent should the indicator be? Options: a label in the status bar, a color change on the active count, a full-width banner.

3. **Start not accepting from CLI?** `--no-new-work` flag to start in drain mode? Useful for "spin up the TUI to monitor, but don't launch anything." May not be needed for v1.

4. **Backward compat for CLI flag.** Accept `--session-limit` as a deprecated alias? Or break cleanly since we're pre-1.0?

5. **Status bar label.** Current format is `X/Y active sessions`. New format could be `X/Y active` or `X/Y in flight` or `X/Y items`. What reads best?

6. **Accept-work persistence across restart.** Currently proposed as runtime-only (not persisted). If a user always wants to start not accepting (e.g., monitoring-only use case), they'd have to toggle every time. Is that acceptable?
