# Feat: Crew WebSocket client with reconnect (H-CRW-2)

**Priority:** High
**Source:** Crew mock broker plan (CEO + eng reviewed 2026-03-27)
**Depends on:** None
**Domain:** crew-coordination

Implement the daemon-side crew client module behind a CrewBroker interface with methods: connect(), sync(), claim(), complete(), heartbeat(), disconnect(), isConnected(). The WebSocketCrewBroker implementation connects to ws://localhost:PORT/api/crews/:code/ws. Persist daemonId as a UUID in ~/.ninthwave/projects/<slug>/daemon-id (following existing userStateDir() convention from daemon.ts) -- generate on first connect, reuse on reconnect. When disconnected: set isConnected()=false (the orchestrator integration in H-CRW-3 uses this to block all launches). Attempt reconnect every 30s on a dedicated timer (separate from the file-based worker heartbeat). On reconnect: send daemonId as query param, receive reconnect_state, reconcile -- TODOs still claimed by this daemon resume as-is, TODOs released but unclaimed get re-claimed, TODOs re-claimed by another daemon trigger worker kill (close workspace + clean worktree). WebSocket heartbeat every 30s for broker timeout detection. Claim has a 5s timeout -- if no response, return null (treated as no_todos_available by caller). Unknown message types or malformed JSON: log warning, continue. Define shared message types (SyncMessage, ClaimMessage, etc.) in this file for import by mock-broker.ts.

**Test plan:**
- Test connect/disconnect lifecycle with a test Bun.serve() WebSocket server
- Test daemonId persistence: first connect generates UUID, second connect reads it
- Test claim with 5s timeout: mock server that delays response beyond 5s, verify null return
- Test protocol error handling: send unknown message type, verify warning logged (not crashed)
- Test reconnect reconciliation: reconnect_state with resumed/re-claimed/released TODOs, verify correct actions for each case
- Test isConnected() returns false when WS drops, true after reconnect
- All tests must clean up Bun.serve() on teardown (lint rule: no-leaked-server)

Acceptance: CrewBroker interface is clean and testable. daemonId persists correctly in userStateDir. Claim timeout works. Reconnect reconciliation handles all three cases (resume, re-claim, kill). Protocol errors don't crash the client. All tests pass.

Key files: `core/crew.ts`, `test/crew.test.ts`, `core/daemon.ts` (for userStateDir import)
