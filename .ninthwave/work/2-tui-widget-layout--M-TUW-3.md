# Fix: Clamp and scroll long confirm summaries (M-TUW-3)

**Priority:** Medium
**Source:** Decomposed from eager-squid plan 2026-04-01
**Depends on:** H-TUW-1
**Domain:** tui-widget-layout

Update `runConfirm(...)` so long summary content cannot displace the confirmation controls off-screen. Wrap or clamp summary lines to terminal width, reserve a scrollable body region, and add minimal overflow navigation with arrow keys and `j/k` while keeping the existing Enter, `y`, `n`, and Escape semantics unchanged. Keep the change limited to confirm-body layout rather than redesigning the dialog flow.

**Test plan:**
- Add confirm-dialog tests for long summary lines in a short terminal and verify the footer instructions remain visible
- Cover overflow scrolling with `j/k` and arrow keys while preserving existing confirm and cancel key behavior
- Assert ANSI-stripped rendered lines stay within terminal width and the rendered frame does not exceed `io.getRows()`

Acceptance: Long confirm summaries wrap or scroll within a bounded body area, the confirm footer stays visible in short terminals, and operators can review overflowing content without losing the existing confirmation and cancellation controls.

Key files: `core/tui-widgets.ts`, `test/tui-widgets.test.ts`
