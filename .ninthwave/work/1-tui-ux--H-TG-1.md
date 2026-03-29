# Feat: Visible selection highlight + scroll-follows-selection (H-TG-1)

**Priority:** High
**Source:** Dogfood friction -- TUI selection is invisible, Enter/i feels random, Up/Down feels stuck at boundaries
**Depends on:** None
**Domain:** tui-ux

The TUI tracks `selectedIndex` via Up/Down arrows but never renders a visual indicator on the selected row. Users cannot tell which item Enter/i will open, and the "stuck at top/bottom" feeling comes from scroll offset clamping while the invisible selection keeps moving. Fix both: add a `>` prefix on the selected row, and make scroll follow selection so the highlighted item stays in view.

**Selection highlight:**
- Add `isSelected?: boolean` param to `formatItemRow()` in `core/status-render.ts`. When true, replace the leading 2-space indent with a bold `>` prefix.
- Add `selectedItemId?: string` param to `buildStatusLayout()`. Resolve `selectedIndex` to item ID in `buildPanelLayout()` using the non-queued item list, then pass through.
- Apply `isSelected` at all 4 `formatItemRow` call sites in `buildStatusLayout` (active/merged items in both deps and no-deps branches). Do not highlight queued items.

**Scroll-follows-selection:**
- In `core/tui-keyboard.ts`, update Up/Down arrow handlers so `scrollOffset` tracks `selectedIndex` instead of moving independently. Simplest: set `scrollOffset = Math.min(scrollOffset, selectedIndex)` on Up, and `scrollOffset = selectedIndex` on Down.

**Test plan:**
- Add tests in `test/status-render.test.ts` for `formatItemRow` with `isSelected: true` -- verify stripped output contains `>` prefix
- Add test for `buildStatusLayout` with `selectedItemId` -- verify only the matching row has `>` prefix
- Verify existing `formatItemRow` tests still pass (no regressions from new optional param)

Acceptance: Up/Down arrows show a `>` indicator on the selected row. The selected item is always visible in the viewport (scroll follows selection). Enter/i opens the detail panel for the visually highlighted item. Existing tests pass.

Key files: `core/status-render.ts:458`, `core/status-render.ts:1215`, `core/tui-keyboard.ts:227`, `core/commands/orchestrate.ts:262`, `test/status-render.test.ts`
