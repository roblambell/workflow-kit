# TUI rendering: show/edit eligibility clearly on main page and detail modal (M-TQI-3)

**Priority:** Medium
**Source:** Follow-up on cue/ignore runtime plan feedback (2026-04-12)
**Depends on:** H-TQI-1, H-TQI-2
**Domain:** tui-rendering
**Lineage:** 22dc5a8a-fbfd-4e98-b4a3-0af9f4ccde60

Expose eligibility state directly in the main status list (ignored badge + styling) and in the detail modal, with discoverable shortcut hints (`i`) in footer/help/modal text.

**Test plan:**
- Verify ignored rows render with expected badge/style and remain selectable.
- Verify detail modal shows current eligibility and `i` hint.
- Verify help/footer copy includes cue/ignore toggle shortcut.

Acceptance: Eligibility is visibly discoverable and editable without leaving the status workflow.

Key files: `core/status-render.ts`, `core/tui-widgets.ts`, `test/status-render.test.ts`, `test/tui-keyboard.test.ts`
