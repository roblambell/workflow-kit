# Fix: Keep startup settings options fixed while changing selection (H-STUI-1)

**Priority:** High
**Source:** Approved decompose plan `1775213510597-hidden-tiger`
**Depends on:** None
**Domain:** cli-ux
**Lineage:** 111b00df-9436-4bfa-84b7-7a81b52bb304

Update the startup orchestration settings screen so moving left or right between options does not make neighboring labels shift horizontally. Render selected values as `[label]` and unselected values as ` label ` so each chip keeps the same visible width in both states. Keep the existing row layout, navigation, descriptions, and truncation behavior unchanged while landing the regression coverage in the same PR.

**Test plan:**
- Add or update `test/tui-widgets.test.ts` to assert startup settings rows render the selected value as `[label]` and unselected values with reserved bracket slots as ` label `.
- Add or update `test/tui-widgets.test.ts` to compare stripped output before and after left/right movement and verify neighboring option start columns stay fixed on at least one startup row.
- Cover a row with mixed label lengths, such as `Backend` or `Collaboration`, so the alignment assertion protects against regressions beyond the merge row.
- Run `bun run test test/tui-widgets.test.ts` and `bun run test`.

Acceptance: On the startup orchestration screen, moving horizontally between options no longer shifts any option text left or right. The selected option shows visible brackets, unselected options preserve those columns with spaces, existing key handling and descriptions still behave the same, and the targeted plus full test suites pass.

Key files: `core/tui-widgets.ts`, `test/tui-widgets.test.ts`
