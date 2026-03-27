# Feat: Full-screen scrollable layout with pinned header and footer (H-TUI-5)

**Priority:** High
**Source:** TUI status display improvements
**Depends on:** H-TUI-2, H-TUI-4
**Domain:** tui-status

The TUI currently renders content without regard to terminal height -- it flows naturally and can overflow the screen. Implement a full-screen layout where the header (column headers, summary line) and footer (compact metrics, keyboard shortcuts) are always visible, and the middle section (item rows) scrolls when it exceeds the viewport.

Implementation:
- Add `getTerminalHeight()` (like existing `getTerminalWidth()` but for `process.stdout.rows`)
- Create a `FrameLayout` type with `headerLines`, `itemLines`, `footerLines` arrays
- New `buildStatusLayout()` produces a FrameLayout (pure function, testable)
- New `renderFullScreenFrame(layout, termRows, termCols, scrollOffset)` produces final output by slicing itemLines to fit the viewport, adding scroll indicators ("^ N more" / "v N more")
- Track `scrollOffset` state in both `cmdStatusWatch` and daemon TUI
- Add up/down arrow key handling (`\x1b[A`/`\x1b[B`) to keyboard handlers in status.ts and orchestrate.ts
- Handle `process.stdout.on('resize')` to trigger re-render and clamp scroll offset
- Fallback: terminals < 10 rows use current non-fullscreen behavior
- Compact single-line metrics for footer: "check 2 merged  arrow 2 active  dot 3 queued    Lead: 5m  Thru: 4.2/hr"
- Always show keyboard shortcuts: "q quit  m metrics  d deps  up/down scroll  ? help"

**Test plan:**
- Unit test `buildStatusLayout()` returns correct header/item/footer structure
- Unit test `renderFullScreenFrame()` with viewport smaller than items: verify slicing and scroll indicators
- Unit test `renderFullScreenFrame()` with viewport larger than items: no scroll indicators, items centered or top-aligned
- Unit test scroll offset clamping: offset cannot exceed item count minus viewport height
- Unit test terminal resize handler resets scroll offset if it exceeds new bounds
- Unit test compact metrics line formatting
- Unit test fallback behavior for small terminals (< 10 rows)

Acceptance: TUI fills the terminal screen. Header and footer are always visible regardless of item count. Middle section scrolls with up/down arrow keys. Scroll indicators show when items overflow. Terminal resize is handled gracefully. Keyboard shortcuts are always displayed at the bottom.

Key files: `core/status-render.ts`, `core/commands/status.ts:248-352`, `core/commands/orchestrate.ts:128-139`, `core/commands/orchestrate.ts:1433-1462`
