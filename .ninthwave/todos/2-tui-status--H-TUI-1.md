# Fix: Duration column -- hide for queued items, remove redundant elapsed suffix (H-TUI-1)

**Priority:** High
**Source:** TUI status display improvements
**Depends on:** None
**Domain:** tui-status

The duration column currently shows a value for all items including queued ones, which is misleading -- queued items haven't started work yet. Additionally, active workers show "elapsed: XhYm" in parentheses after the title, which is redundant with the duration column itself.

Fix `formatDuration()` in status-render.ts to return `-` when the item state is `queued`. Remove the "elapsed:" portion from `formatTelemetrySuffix()` -- keep the "exit:" and "stderr:" suffixes for failed items since those provide unique diagnostic info not shown elsewhere.

**Test plan:**
- Unit test `formatDuration()` returns `-` for items with state `queued`
- Unit test `formatDuration()` returns real duration for `implementing`, `ci-pending`, `merged` states
- Unit test `formatTelemetrySuffix()` no longer includes "elapsed:" for active items
- Unit test `formatTelemetrySuffix()` still includes "exit:" and "stderr:" for failed items
- Verify full table render shows `-` in duration column for queued rows

Acceptance: Queued items display `-` in the duration column. Active/merged items display their real elapsed time. The "elapsed:" parenthetical no longer appears after titles. Failed item diagnostics (exit code, stderr) still appear.

Key files: `core/status-render.ts:240-281`
