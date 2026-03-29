# Feat: Grace period TUI countdown and extend key (H-TG-3)

**Priority:** High
**Source:** Dogfood friction -- no visible warning before timeout kill, no way to defer
**Depends on:** H-TG-1, H-TG-2
**Domain:** tui-ux

Wire the grace period state machine (H-TG-2) into the TUI rendering and keyboard handling. Show a countdown in the duration column when a worker is in its grace period, and add an `x` key to extend the deadline for the selected item (using the selection highlight from H-TG-1).

**StatusItem changes** (`core/status-render.ts`):
- Add `timeoutRemainingMs?: number` and `timeoutExtensions?: string` to `StatusItem` interface

**Data plumbing** (`core/commands/orchestrate.ts`):
- In `orchestratorItemsToStatusItems`, compute `timeoutRemainingMs` from `item.timeoutDeadline` and pass `timeoutExtensions` as `"N/M"` string
- Add `maxTimeoutExtensions` param (or pass orchestrator config)
- Set `gracePeriodMs: 0` when constructing Orchestrator in non-TUI mode (JSON/daemon)

**Rendering** (`core/status-render.ts`):
- `formatDuration()`: when `timeoutRemainingMs` is set, return countdown format (e.g., "4m 31s") instead of elapsed time. Add `formatCountdown(ms)` helper.
- `formatItemRow()`: when grace period is active (`timeoutRemainingMs !== undefined`), override icon to warning sign, color duration column RED, append extension count in DIM (e.g., "(1/3)")

**Keyboard** (`core/tui-keyboard.ts`):
- Add `onExtendTimeout?: (itemId: string) => boolean` callback to `TuiState`
- Add `case "x"` in the switch: resolve selected item via `getSelectedItemId`, call `onExtendTimeout`

**Wiring** (`core/commands/orchestrate.ts`):
- Wire `onExtendTimeout: (itemId) => orch.extendTimeout(itemId)` in TuiState initialization

**Help overlay** (`core/status-render.ts`):
- Add `x           Extend worker timeout` to keyboard shortcuts section in `renderHelpOverlay()`

**Test plan:**
- Test `formatDuration` returns countdown format when `timeoutRemainingMs` is set (e.g., 270000 -> "4m 30s")
- Test `formatItemRow` with `timeoutRemainingMs` set: verify warning icon and RED duration in output
- Test `orchestratorItemsToStatusItems` passes through timeout fields correctly
- Test help overlay includes "Extend worker timeout" text

Acceptance: When a worker enters grace period, its duration column shows a red countdown (e.g., "4m 31s") with a warning icon. Pressing `x` on the selected item extends the deadline (up to 3 times). The help overlay documents `x`. JSON/daemon mode kills immediately with no grace period. All tests pass.

Key files: `core/status-render.ts:92`, `core/status-render.ts:410`, `core/status-render.ts:458`, `core/status-render.ts:2002`, `core/tui-keyboard.ts:75`, `core/commands/orchestrate.ts:156`, `core/commands/orchestrate.ts:1721`
