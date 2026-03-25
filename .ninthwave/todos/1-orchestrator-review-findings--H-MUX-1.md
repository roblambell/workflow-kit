# Fix: Status pane opens as separate workspace instead of split pane in cmux (H-MUX-1)

**Priority:** High
**Source:** Dogfooding observation — status pane should split in orchestrator's workspace
**Depends on:** None
**Domain:** orchestrator-review-findings

`cmux.ts:splitPane()` calls `cmux split-pane --command <cmd>` but cmux has no `split-pane` command. The correct command is `cmux new-split <direction>` or `cmux new-pane --direction <direction> --type terminal`. The call silently fails (exit code != 0), `launchStatusPane()` falls through to `launchWorkspace()`, and the status pane opens as a separate workspace instead of a split in the orchestrator's workspace.

Fix `splitPane()` in `core/cmux.ts` to use the correct cmux API:
- `cmux new-split right` to split the current workspace's pane to the right
- The command to run in the new split should be passed via `--command` or by sending it after creation
- Check `cmux new-split --help` or `cmux new-pane --help` for the exact flags
- The `CMUX_WORKSPACE_ID` env var is already set and auto-targets the current workspace

Also update the ref parsing — `new-split` likely returns a pane or surface ref, not `pane:N`.

**Test plan:**
- Unit test: splitPane calls `cmux new-split` (not `split-pane`)
- Unit test: splitPane returns pane/surface ref on success
- Unit test: splitPane returns null on failure
- Manual test: orchestrator status pane opens as a split in the current workspace

Acceptance: `splitPane` uses the correct cmux command. Status pane opens as a split in the orchestrator's workspace, not a separate workspace. Tests pass.

Key files: `core/cmux.ts`, `core/commands/orchestrate.ts`, `test/orchestrate.test.ts`
