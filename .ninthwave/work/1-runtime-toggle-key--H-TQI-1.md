# Runtime TUI: one-key cue/ignore toggle from status + detail modal (H-TQI-1)

**Priority:** High
**Source:** Follow-up on cue/ignore runtime plan feedback (2026-04-12)
**Depends on:** None
**Domain:** tui-runtime
**Lineage:** 2df1f123-b0f2-4f43-a6c2-8f5894f56c2a

Implement a single-key (`i`) runtime toggle that flips queue eligibility (`cued` <-> `ignored`) for the currently selected item on the main status page, and for the focused item while the detail modal is open.

**Test plan:**
- Verify `i` toggles selected row eligibility on status page.
- Verify `i` toggles `detailItemId` eligibility while detail modal is open.
- Verify no-op + hint behavior when no target item is available.

Acceptance: Operators can toggle item eligibility in-place using one key from either main status or detail modal, with immediate runtime effect.

Key files: `core/tui-keyboard.ts`, `core/commands/orchestrate.ts`
