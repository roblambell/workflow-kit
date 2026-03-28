# Feat: Help modal overlay with ? key (M-TUI-5)

**Priority:** Medium
**Source:** TUI status improvements plan 2026-03-28, refined by CEO review 2026-03-28
**Depends on:** H-TUI-4
**Ships with:** H-TUI-4 (must ship together -- footer shortcuts are only discoverable here)
**Domain:** cli-ux

Add a `?` keyboard shortcut that toggles a full-screen help overlay in the TUI. The overlay replaces the normal frame content (not a transparent overlay) and shows explanations of metrics, merge strategies, keyboard shortcuts, and credits. Press `?` again or Escape to dismiss.

**Important:** This item must ship alongside H-TUI-4. H-TUI-4 removes all keyboard shortcuts from the footer (replaced by strategy indicator). This help overlay is now the **only place** users can discover `q`, `d`, `↑/↓`, and other shortcuts.

Help content sections:
- Metrics: Lead time (median duration from start to merge), Throughput (merged items per hour), Session (time since orchestrator started)
- Merge strategies (reuse `strategyIndicator()` from H-TUI-4 for icon/color display):
  - `› auto` — AI review + CI → auto-merge (respects branch protection)
  - `‖ manual` — AI review + CI run, human merges
  - `» bypass` — AI review + CI → admin-override merge (skip human review gate)
- Keyboard shortcuts: Shift+Tab cycle strategy, ? toggle help, Ctrl+C (×2) quit, q quit, d toggle deps, ↑/↓ scroll
- Credits: ninthwave, Apache-2.0, ninthwave.dev

Escape handling: raw Escape is `\x1b` (length 1) while arrow keys start with `\x1b[`. Only treat length-1 `\x1b` as Escape to avoid interfering with arrow key sequences.

**Test plan:**
- Test `renderHelpOverlay(termWidth, termRows)` as a pure function: verify it returns expected number of lines, box-drawing characters are correct, content fits within termWidth
- Test keyboard handler: verify `?` toggles showHelp boolean, verify Escape (single `\x1b`) sets showHelp to false, verify arrow keys (`\x1b[A`) do NOT dismiss help
- Test renderTuiFrame with showHelp=true: verify help overlay is rendered instead of normal frame
- Test strategy section uses strategyIndicator() with correct icons and colors

Acceptance: Pressing `?` in TUI shows centered help overlay with metrics, strategies (with icons/colors from strategyIndicator()), shortcuts, and credits. Pressing `?` again or Escape dismisses it. Arrow keys still work while help is shown (they dismiss help and scroll, or are ignored). Help content is ASCII-only (except strategy icons ›/‖/»). All keyboard shortcuts that were removed from the footer in H-TUI-4 are documented here.

Key files: `core/status-render.ts`, `core/commands/orchestrate.ts:1576-1658`
