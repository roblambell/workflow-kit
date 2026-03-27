# Refactor: Remove PR column, inline PR as clickable suffix on state (H-TUI-4)

**Priority:** High
**Source:** TUI status display improvements
**Depends on:** H-TUI-1
**Domain:** tui-status

The dedicated 7-char PR column wastes horizontal space when most items have no PR, and is redundant once the PR number can be shown inline with the state. Remove the PR column and display the PR number as a suffix on the state label: e.g., "CI-Pending (#265)", "Merged (#263)".

Make the PR number a clickable OSC 8 hyperlink so it opens in the browser when clicked in supported terminals (iTerm2, Kitty, Windows Terminal, GNOME Terminal). Format: `\x1b]8;;URL\x07#265\x1b]8;;\x07`. Unsupported terminals show plain text -- graceful degradation.

The state column width should be dynamic: 14ch when no items have PRs, expanding up to ~24ch when PR numbers are present (computed per render from actual items). Pass `repoUrl` into `formatStatusTable()` and `formatItemRow()` for link construction.

**Test plan:**
- Unit test `formatItemRow()` with no PR: state column shows state only, no extra padding
- Unit test `formatItemRow()` with PR: state shows "CI-Pending (#265)" format
- Unit test OSC 8 escape sequences are present in TTY output and absent in non-TTY
- Unit test dynamic state column width: verify header aligns with rows when PR widths vary
- Verify ANSI-stripping helpers handle OSC 8 sequences (update strip regex if needed)

Acceptance: PR column removed from the table. PR numbers appear inline with state labels. PR numbers are OSC 8 hyperlinks on TTY. Column widths adjust dynamically based on whether items have PRs. Header alignment matches row alignment.

Key files: `core/status-render.ts:288-302`, `core/status-render.ts:636-789`
