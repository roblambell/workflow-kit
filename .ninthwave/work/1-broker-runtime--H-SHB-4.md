# Feat: Add persistent self-hosted broker runtime on shared core (H-SHB-4)

**Priority:** High
**Source:** Spec `.opencode/plans/1775207598126-tidy-cactus.md`
**Depends on:** H-SHB-1, H-SHB-2, H-SHB-3
**Domain:** broker-runtime
**Lineage:** 666e8b00-e1ee-4aea-b7ff-46520a147a67

Build the Bun server runtime that exposes `POST /api/crews` and crew websocket connections on top of the extracted broker core, backed by file persistence instead of in-memory state. The runtime should restore crews, daemons, work item state, schedule claims, and reconnect or release behavior across restarts while enforcing repo-reference matching during crew creation and join.

**Test plan:**
- Add `test/broker-runtime.test.ts` covering create crew, join, repo mismatch rejection, persistence across restart, reconnect resume, grace-period release, and rich `remoteItems` snapshots.
- Verify file-backed store load and save behavior for crew state, daemon state, and schedule claims without corrupting restarts or duplicate claims.
- Exercise HTTP route handling and websocket lifecycle wiring together so runtime behavior matches the existing `MockBroker` contract where expected.

Acceptance: `core/broker-server.ts` starts a persistent broker backed by the shared store, runtime restarts preserve broker state that should survive process exit, repo mismatches are rejected, and the new runtime test suite plus the full suite pass.

Key files: `core/broker-server.ts`, `core/broker-store.ts`, `core/broker-state.ts`, `test/broker-runtime.test.ts`
