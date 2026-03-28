# Feat: Operator and author identity infrastructure (H-CA-2)

**Priority:** High
**Source:** Creator affinity scheduling refinement (2026-03-28)
**Depends on:** None
**Domain:** crew-scheduling

Add identity resolution so creator affinity can match on the human (git author) rather than daemon UUID. Two pieces: (1) Operator identity -- on daemon startup, resolve the operator's git email via `git config user.email` and persist alongside the daemon ID in the state directory. Include operator ID in the WebSocket connect/register handshake. Add `operatorId` field to DaemonState in the broker. (2) Author resolution -- add a utility function that resolves the git author email of a TODO file via `git log --format='%ae' -1 -- <path>`. Cache results per sync cycle to avoid repeated git calls. Wire author into the enriched sync data from H-CA-1 (the author field on SyncMessage items). The daemon calls the author resolution utility during sync preparation in the orchestrate loop.

**Test plan:**
- Unit test for git author resolution utility: mock git log output, verify email extraction
- Unit test for operator identity resolution: mock git config output, verify persistence to state dir
- Test that DaemonState includes operatorId after daemon connect
- Test that re-resolving operator identity on restart reads from persisted file
- Edge case: git config user.email not set -- should fall back to daemon ID or empty string

Acceptance: Operator identity is resolved from `git config user.email` on daemon startup and persisted in the state directory. The broker stores `operatorId` on DaemonState from the connect handshake. A utility resolves git author email per TODO file path. Author data is available for the sync protocol (consumed by H-CA-1's enriched SyncMessage).

Key files: `core/daemon.ts`, `core/crew.ts:274-294`, `core/mock-broker.ts:39-48`, `core/commands/orchestrate.ts:1478-1486`
