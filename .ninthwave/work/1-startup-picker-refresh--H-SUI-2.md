# Feat: Refresh the startup picker in place after first paint (H-SUI-2)

**Priority:** High
**Source:** Spec `.opencode/plans/1775113783118-mighty-squid.md`
**Depends on:** H-SUI-1
**Domain:** startup-picker-refresh
**Lineage:** 6e05e107-113b-467d-a739-347572acb123

Update the plain `nw` startup path to render from local work items immediately, then perform a one-shot async refresh once the picker is already visible. Add the minimal selection-screen plumbing needed to replace the list in place, preserve surviving selections, clear removed selections explicitly, and show a short notice when GitHub pruning changes what the user can launch.

**Test plan:**
- Add `test/onboard.test.ts` coverage that the picker starts with local items immediately and swaps to refreshed items when the async pass resolves
- Add `test/tui-widgets.test.ts` coverage for replacing checkbox items after first render, including selection preservation and explicit clearing when a selected item disappears
- Verify cancellation safety: if the user exits before the refresh resolves, the result is ignored and no late redraw or stale notice is emitted

Acceptance: Running plain `nw` paints the picker before GitHub startup checks finish, refreshed items replace the list without rebuilding the whole flow, and removed selections are cleared with visible notice text instead of changing silently.

Key files: `core/commands/onboard.ts`, `core/interactive.ts`, `core/tui-widgets.ts`, `test/onboard.test.ts`, `test/tui-widgets.test.ts`
