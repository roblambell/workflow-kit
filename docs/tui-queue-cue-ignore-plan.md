# TUI Runtime Queue Control Plan (Cue vs Ignore)

## Objective

Allow operators to control queue eligibility while `nw` is already running, directly from the live status TUI and the item detail modal:

- **Cued**: item is eligible to be launched when dependencies and slots allow.
- **Ignored**: item remains visible in the queue but is excluded from launch decisions until re-cued.

This adds an explicit "in queue / out of queue" control without requiring daemon restart, file edits, or removing work items.

## Why this matters

Today, queued work is mostly controlled implicitly by dependency readiness and orchestration state. Operators need a fast way to:

1. Park noisy or risky items during an active run.
2. Keep the daemon running while triaging priorities.
3. Re-introduce ignored items instantly when conditions change.

## Scope

### In scope

- Runtime TUI action to toggle selected item between **cued** and **ignored**.
- Single-key toggle available directly on the main status page.
- Same toggle available while item detail modal is open.
- New per-item runtime eligibility flag in daemon/orchestrator state.
- Scheduler gate so ignored items never transition into launch.
- Visual status signal in the main list and detail surface.
- Persistence across daemon restarts for the same repo session state.

### Out of scope (first iteration)

- Editing cue/ignore state from non-TUI commands.
- Multi-item bulk operations.
- Automatic re-cue policies (time-based, dependency-based, etc.).

## UX proposal (status page + detail modal)

## 1) Selection model

Reuse existing item selection in the status panel (already tracked via `selectedItemId`) and apply cue/ignore to the currently highlighted row.

If detail modal is open, apply toggle to the modal's focused item (`detailItemId`).

## 2) Keyboard action

Use one key only for runtime editing:

- `i` → toggle selected/focused item between **cued** and **ignored**

No separate key for "unignore". Pressing `i` again reverses the state.

## 3) Visible state from the main page

Main status list should show eligibility inline so operators do not need to open detail to inspect:

- ignored rows render DIM + `(ignored)` badge,
- cued rows render normally (optional subtle `(cued)` only if needed for clarity),
- selected-row highlighting still works for both states.

## 4) Detail modal parity

Detail modal should expose the same eligibility state and same edit affordance:

- show current value near metadata/status,
- show `i` shortcut hint inside modal,
- pressing `i` updates eligibility immediately and reflects in the background list when modal closes.

## 5) Controls/help discoverability

Update:

- footer shortcut hints on the main page,
- `?` help overlay keymap,
- detail modal shortcut hints.

## Runtime data model

Introduce a per-item eligibility field in runtime state.

Suggested shape:

```ts
queueEligibility?: "cued" | "ignored";
```

Rules:

- missing/undefined defaults to `"cued"` for backward compatibility,
- state is item-local and independent of lifecycle state (`queued`, `ready`, `in-progress`, etc.),
- toggling is idempotent.

## Scheduler/orchestrator behavior

Apply a gate before launch candidacy:

1. If `queueEligibility === "ignored"`, item must not be promoted/launched.
2. Item remains in current lifecycle state unless explicit transition policy says otherwise.
3. If ignoring an already active item (`implementing`, `review`, etc.), do **not** kill in-flight work in v1; the flag only affects future launch eligibility.

Recommended transition handling:

- If state is `queued`/`ready`, toggle to ignored keeps item non-launchable immediately.
- If state is active, set ignored flag and let current pass complete; future retries/requeues respect ignored.

## Persistence

Persist `queueEligibility` in the same state file(s) used for daemon snapshot/state continuity so operator intent survives daemon restarts.

Backward compatibility:

- old snapshots load as `cued` by default,
- serialization omits field when `cued` (optional) to reduce churn.

## Crew/shared mode semantics

Define deterministic authority:

- In single-daemon local mode: local operator controls eligibility.
- In crew/shared mode: host daemon is source of truth; broker sync broadcasts item eligibility.

Conflict policy:

- last-write-wins with monotonic timestamp in broker payload,
- include eligibility in sync payload so remote status views stay truthful.

## Failure and edge cases

1. **No selection in main view**: `i` no-op with brief footer hint.
2. **No detail item** (race while modal open): `i` no-op + warning log.
3. **Unknown item ID** (race/deletion): toggle safely dropped with warning log.
4. **Item completed while ignored**: ignore flag becomes irrelevant; cleanup removes item as today.
5. **Dependency transitions while ignored**: readiness can update internally, but launch remains blocked.
6. **Retry command**: retry to `queued` should preserve `ignored` unless operator explicitly toggles back.

## Implementation slices

## Slice 1 — state + engine gate

- Add eligibility field to item/runtime types.
- Default missing to `cued` on read.
- Block launch selection for ignored items.

## Slice 2 — single-key toggle plumbing

- Add `i` handler in keyboard layer for status-page selection.
- Reuse same `i` handler when detail modal is open (`detailItemId` target).
- Wire callback from TUI to orchestrator command channel.

## Slice 3 — rendering + discoverability

- Add `(ignored)` badge + dim styling in status list.
- Add eligibility display in detail modal.
- Update footer/help/modal shortcut hints.

## Slice 4 — persistence + crew sync

- Persist field in snapshots.
- Include eligibility in broker state/sync payloads.
- Resolve concurrent updates deterministically.

## Test plan

## Unit tests

1. Keyboard handler: `i` toggles eligibility for selected row.
2. Keyboard handler: `i` toggles eligibility for `detailItemId` while modal open.
3. Orchestrator gate: ignored items never chosen for launch.
4. Defaulting: missing field loads as `cued`.
5. Renderer: ignored badge/styles appear correctly and remain selectable.
6. Detail modal: eligibility line and shortcut hint render correctly.

## Integration/scenario tests

1. Live daemon run: toggle queued item to ignored, verify it is skipped while others continue.
2. Toggle same item again, verify it becomes launchable without restart.
3. Toggle from detail modal, verify effect matches main-page toggle.
4. Restart daemon, verify ignored state persists.
5. Crew sync: toggle on one daemon, verify others render and honor same eligibility.

## Rollout recommendation

1. Ship behind an internal flag first (e.g., `runtimeQueueEligibility`).
2. Validate with real triage workflows.
3. Enable by default once keyboard UX and sync behavior are stable.

## Open decisions

1. Should ignoring a `ready` item force it back to `queued`, or keep it `ready but ignored`?
2. Do we want a compact eligibility column (`Q`/`I`) instead of text badge?
3. Should CLI parity (`nw queue ignore <id>`) be part of v1 or follow-up?
