# Fix: Keep startup settings content inside the terminal viewport (H-TUW-2)

**Priority:** High
**Source:** Decomposed from eager-squid plan 2026-04-01
**Depends on:** H-TUW-1
**Domain:** tui-widget-layout

Apply the same viewport discipline to `runStartupSettingsScreen(...)` so long summaries and descriptions cannot push the settings rows or footer off-screen. Wrap summary and active-description text to the available width, keep title and footer pinned, and scroll the body region just enough to keep the active settings row visible while the operator navigates. Build on the width and layout helpers introduced in H-TUW-1 instead of creating a second formatting path.

**Test plan:**
- Add startup-screen tests with long `summaryLines` in a short terminal and verify the active row remains visible as navigation moves through all four settings rows
- Assert wrapped summary and description output stays within terminal width and total rendered height stays within `io.getRows()`
- Re-run existing startup interaction tests to confirm merge, review, collaboration, and WIP controls still behave the same after the viewport changes

Acceptance: The startup settings screen keeps its title and footer visible in short terminals, wraps long summary and description text instead of slicing or overflowing it, and preserves visibility of the active settings row while navigating. Existing setting values and confirm/cancel behavior remain intact.

Key files: `core/tui-widgets.ts`, `test/tui-widgets.test.ts`
