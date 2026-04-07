# Feat: Add sessionParked plumbing and workspace-close fix (H-SP-1)

**Priority:** High
**Source:** Session parking plan (2026-04-07)
**Depends on:** None
**Domain:** orchestrator
**Lineage:** b20441ee-cba9-4c6b-a781-f33556653699

Add the `sessionParked?: boolean` field to `OrchestratorItem` and wire it through daemon state serialization and crash-recovery reconstruction. Also fix `executeWorkspaceClose` to clear `item.workspaceRef` after closing the workspace -- currently the reference is left dangling, which will break parking detection logic. This is pure plumbing with no behavioral change; consumers of `sessionParked` are added in H-SP-2.

**Test plan:**
- Add daemon state roundtrip test: serialize an item with `sessionParked: true`, reconstruct, verify the field is preserved
- Add unit test for `executeWorkspaceClose`: verify `item.workspaceRef` is `undefined` after successful close
- Verify existing `executeWorkspaceClose` callers (stuck items) still work correctly with the new clearing behavior

Acceptance: `sessionParked` field exists on `OrchestratorItem` and `DaemonStateItem`. Field is serialized in `serializeOrchestratorState` and restored in `reconstructState`. `executeWorkspaceClose` clears `workspaceRef` on success. All existing tests pass.

Key files: `core/orchestrator-types.ts`, `core/daemon.ts`, `core/reconstruct.ts`, `core/orchestrator-actions.ts`
