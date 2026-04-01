# Fix: Make checkbox picker rows width-safe and line-aware (H-TUW-1)

**Priority:** High
**Source:** Decomposed from eager-squid plan 2026-04-01
**Depends on:** None
**Domain:** tui-widget-layout

Tighten the checkbox picker layout in `core/tui-widgets.ts` without broadening this into a shared TUI framework refactor. Keep the main selectable row to a single width-safe line, move dependency text into an optional aligned `subline`, and switch viewport math from item-count scrolling to rendered-line scrolling so mixed 1-line and 2-line rows stay fully visible. Reuse `stripAnsiForWidth(...)` from `core/status-render.ts` if that reduces duplicate width logic, but keep new truncation behavior local to this widget path.

**Test plan:**
- Update `toCheckboxItems(...)` tests to verify dependency text moves from inline `detail` into `subline` while priority stays on the main row
- Add `runCheckboxList(...)` coverage for a rendered dependency sub-line, ANSI-stripped width limits, and mixed 1-line/2-line row scrolling in a short terminal
- Assert the checkbox frame stays within constrained terminal height and existing toggle, sentinel, and confirm behavior still work

Acceptance: Checkbox rows no longer overflow narrow terminals, dependency text renders on an aligned second line when present, and scrolling keeps the active item fully visible even when neighboring rows consume different line counts. Existing selection semantics, `__ALL__` handling, and footer controls remain unchanged.

Key files: `core/tui-widgets.ts`, `core/status-render.ts`, `test/tui-widgets.test.ts`
