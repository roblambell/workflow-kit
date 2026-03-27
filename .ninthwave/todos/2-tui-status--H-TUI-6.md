# Feat: Live countdown timer decoupled from poll loop (H-TUI-6)

**Priority:** High
**Source:** TUI status display improvements
**Depends on:** H-TUI-5
**Domain:** tui-status

The status display currently shows "updated <1m ago" which is not very useful. Replace it with a live countdown timer that shows seconds until the next data refresh (e.g., "Refresh: 3s") and counts down every second.

Decouple the render tick from the data poll: add a 1-second `setInterval` that re-renders the footer region (or full frame) to tick the countdown. The poll loop continues at its normal interval (5s for status --watch, adaptive 5-30s for daemon TUI). When the countdown reaches 0, briefly show "Refreshing..." then reset after data loads.

Implementation:
- In `cmdStatusWatch` (status.ts): track `nextRefreshAt` timestamp, compute remaining seconds each tick
- In daemon TUI (orchestrate.ts): use adaptive poll interval as the countdown target
- The 1s interval only needs to re-render the footer line (or full frame if simpler)
- Clean up the interval in the finally/cleanup block
- Clear interval on `q` quit or abort signal

**Test plan:**
- Unit test countdown computation: given a `nextRefreshAt` timestamp and current time, returns correct seconds remaining
- Unit test countdown never shows negative values (clamp to 0)
- Unit test interval cleanup: verify `clearInterval` is called on quit/abort
- Integration: run `ninthwave status --watch`, observe countdown ticking down each second and resetting after refresh

Acceptance: Footer shows "Refresh: Ns" counting down each second. Countdown resets after each data refresh. "Refreshing..." shows briefly at 0. No stale intervals after quit. Works in both status --watch and daemon TUI modes.

Key files: `core/commands/status.ts:248-352`, `core/commands/orchestrate.ts:128-139`, `core/commands/orchestrate.ts:1433-1462`
