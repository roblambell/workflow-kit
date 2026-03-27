# Feat: Mock crew coordination broker (H-CRW-1)

**Priority:** High
**Source:** Crew mock broker plan (CEO + eng reviewed 2026-03-27)
**Depends on:** None
**Domain:** crew-coordination

Implement a mock localhost WebSocket broker for crew coordination. The broker runs in-process via Bun.serve() and implements the full design doc protocol: crew creation (POST /api/crews returning 6-char alphanumeric code in XXX-XXX format), WebSocket upgrade at /api/crews/:code/ws with daemonId/name query params, and the claim/sync/complete/heartbeat message flow. The scheduling algorithm uses creator affinity first (daemon that synced a TODO as creator gets priority), then highest priority, oldest first on ties. Disconnected daemons (90s no heartbeat) enter a 60s grace period before their claimed TODOs are released back to the pool. On recognized returning daemonId, send reconnect_state listing still-claimed TODOs and which were released/re-claimed. Write every event (claim, sync, complete, disconnect, reconnect, abandon) as JSONL to .ninthwave/crew-events.jsonl matching the D1 events schema with ts, crew_id, daemon_id, event, todo_path, and metadata.affinity (creator or pool).

**Test plan:**
- Test crew creation via HTTP POST, verify 6-char code format
- Test 2 clients connect, sync TODOs, claim with creator affinity verified (creator daemon gets its own TODOs)
- Test no duplicate claims: 10 TODOs across 2 clients, verify zero overlap
- Test disconnect timeout (90s) + grace period (60s) releases TODOs back to available
- Test reconnect with daemonId: reconnect_state sent with correct claimed/released lists
- Test JSONL event log contains correct entries for all event types
- All tests must clean up Bun.serve() on teardown (lint rule: no-leaked-server)

Acceptance: Mock broker passes all protocol tests. Creator affinity scheduling works correctly. Disconnect/release/reconnect cycle handles all cases. JSONL event log matches D1 schema. No leaked servers in tests.

Key files: `core/mock-broker.ts`, `test/mock-broker.test.ts`
