# Feat: Add --remote flag to nw list (M-RF-2)

**Priority:** Medium
**Source:** Decomp backlog 2026-03-28
**Depends on:** H-RF-1
**Domain:** remote-filtering

Add a `--remote` flag to `nw list` that shows which work items are pushed to origin/main vs local-only. When the flag is set, add a status indicator (e.g., "remote" or "local") to each item in the output table. This helps users understand which items the orchestrator will process and which need to be pushed.

Uses `getCleanRemoteWorkItemFiles()` from H-RF-1 to determine remote status. Without the flag, `nw list` behaves exactly as before.

**Test plan:**
- Test `--remote` flag parsing in list command args
- Test output includes remote/local indicator when flag is set
- Test output unchanged when flag is omitted
- Edge case: no remote configured -- graceful fallback (show all as local)

Acceptance: `nw list --remote` shows a remote/local status per item. `nw list` without the flag is unchanged. Items on origin/main show "remote", items only local show "local".

Key files: `core/commands/list.ts`
