# Feat: Shift+Tab merge strategy cycling in TUI (H-TUI-4)

**Priority:** High
**Source:** TUI status improvements plan 2026-03-28, refined by CEO review 2026-03-28
**Depends on:** H-MS-3
**Ships with:** M-TUI-5 (help overlay must exist before shortcuts are removed from footer)
**Domain:** cli-ux

Add Shift+Tab (`\x1B[Z`) keyboard shortcut to cycle through merge strategies during a `nw watch` TUI session, inspired by Claude Code's mode switcher. Each strategy has a distinct icon and color. The strategy indicator replaces the old shortcuts footer line entirely.

## Footer format

Single footer line, strategy indicator on the **far left**:

```
  › auto (shift+tab to cycle) · ? for help
  ‖ manual (shift+tab to cycle) · ? for help
  » bypass (shift+tab to cycle) · ? for help
```

This **replaces the old shortcuts line** (`q quit  d deps  ↑/↓ scroll`). Those shortcuts still work but are only discoverable in the `?` help overlay (M-TUI-5).

## Icon + color mapping

| Strategy | Icon | Color | ANSI | Rationale |
|----------|------|-------|------|-----------|
| `auto` | `›` | DIM | `\x1b[2m` | Default, blends in. Things flow. |
| `manual` | `‖` | YELLOW | `\x1b[0;33m` | Pause = human must act. |
| `bypass` | `»` | RED | `\x1b[0;31m` | Overriding safety gate. |

Implementation: add `strategyIndicator(strategy: MergeStrategy): string` helper in `status-render.ts`. This function is reused by M-TUI-5 help overlay to show the icon/color mapping.

Footer rendering: base text stays DIM, then RESET, then strategy badge applies its own color:
```typescript
const badge = strategyIndicator(strategy);
footerLines.push(`  ${badge} (shift+tab to cycle) · ? for help`);
```

## Strategy cycling

Cycle order: `auto → manual → [bypass if --dangerously-bypass] → repeat`

Wrap behavior: last strategy → shift+tab → back to `auto`.

`bypassEnabled` in TuiState controls whether bypass appears in the cycle. Set from `OrchestratorConfig.bypassEnabled` (populated by `--dangerously-bypass` CLI flag in H-TUI-3).

Strategy change takes effect on next poll cycle. Forward-only -- existing PRs keep their auto-merge state.

## Exit behavior

Ctrl+C double-tap to exit:
1. First Ctrl+C: footer changes to `Press Ctrl-C again to exit`
2. Second Ctrl+C within ~2s: exits via AbortController
3. If no second press within ~2s: footer reverts to strategy display

Implementation: add `ctrlCPending: boolean` and `ctrlCTimestamp: number` to TuiState. The render pipeline checks `ctrlCPending` to decide which footer text to show. A `setTimeout` clears `ctrlCPending` after ~2s.

Note: `q` shortcut still works for immediate exit, documented in `?` help only.

## TuiState additions

```typescript
interface TuiState {
  // existing fields...
  mergeStrategy: MergeStrategy;
  bypassEnabled: boolean;
  ctrlCPending: boolean;
  ctrlCTimestamp: number;
  onStrategyChange?: (strategy: MergeStrategy) => void;
}
```

## Per-daemon scope

Strategy is per-daemon, not per-crew (when crew mode is active). Each daemon independently tracks and cycles its own merge strategy.

**Test plan:**
- Test keyboard handler: verify `\x1B[Z` triggers strategy cycle callback and rotates through auto → manual correctly
- Test with bypassEnabled: verify cycle includes bypass as 3rd option
- Test cycle wrap: manual → shift+tab → auto (or bypass → auto when bypass enabled)
- Test bypass excluded from cycle when bypassEnabled: false
- Test Orchestrator.setMergeStrategy(): verify it changes strategy and subsequent evaluateMerge uses new strategy
- Test footer rendering: verify `strategyIndicator()` returns correct icon + ANSI color for each of 3 strategies
- Test footer renders strategy on far left with correct format string
- Test Ctrl+C double-tap: first press sets ctrlCPending, second exits
- Test Ctrl+C timeout: ctrlCPending clears after ~2s, footer reverts to strategy display

Acceptance: Shift+Tab cycles merge strategy in TUI. Current strategy shown on far left of footer with distinct icon and color (›/DIM, ‖/YELLOW, »/RED). When --dangerously-bypass active, bypass option appears in red in the cycle. Strategy changes are logged as structured events (old strategy, new strategy, timestamp). Ctrl+C requires double-tap with 2s window. Old shortcuts (q, d, scroll) removed from footer but still functional. `strategyIndicator()` exists in status-render.ts for reuse. M-TUI-5 ships in same batch.

Key files: `core/commands/orchestrate.ts:1576-1658,2243-2261`, `core/status-render.ts:1238-1247`, `core/orchestrator.ts:430-440`
