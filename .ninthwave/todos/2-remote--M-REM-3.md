# Feat: Wire tunnels and session viewer into orchestrator workflow (M-REM-3)

**Priority:** Medium
**Source:** Vision L-VIS-7 — remote session access foundation
**Depends on:** H-REM-1, H-REM-2
**Domain:** remote

Integrate the tunnel management module (H-REM-1) and session viewer server (H-REM-2) into the orchestrator's worker lifecycle. When a worker launches, automatically start a session viewer + tunnel and post the URL on the PR.

**Changes to orchestrator:**

1. **Extend OrchestratorItem** with optional remote session fields:
   ```typescript
   sessionUrl?: string;      // Public tunnel URL
   sessionServer?: SessionServer;  // Local server handle
   tunnelHandle?: TunnelHandle;    // Cloudflared process handle
   ```

2. **On worker launch** (`handleLaunching` → `implementing` transition):
   - Start a session viewer server for the worker's workspace ref
   - Start a cloudflared tunnel for the server's local port
   - Store `sessionUrl`, `sessionServer`, `tunnelHandle` on the item

3. **On PR creation** (when `prNumber` is first detected):
   - Post a PR comment with the session URL: `**[Worker: {id}]** Live session: {url}`
   - Only post if `sessionUrl` is non-null (graceful degradation)

4. **On worker cleanup** (`executeClean`):
   - Stop the tunnel (`stopTunnel`)
   - Stop the session server (`stopSessionServer`)
   - Clear session fields on the item

5. **On orchestrator shutdown** (`stopAllTunnels` in cleanup handler):
   - Kill all active tunnels and servers

**Opt-in behavior:**
- Remote sessions are opt-in via `--remote` flag on `ninthwave orchestrate` or `remote_sessions=true` in `.ninthwave/config`.
- When not enabled, no servers or tunnels are started. Zero overhead.
- `ninthwave doctor` reports cloudflared status but doesn't require it.

**Status display:**
- `ninthwave status` shows session URL next to each worker when available.
- Format: `H-REM-1  implementing  PR #42  https://abc-123.trycloudflare.com`

**Graceful degradation chain:**
- cloudflared not installed → no tunnel, no URL, server still runs locally
- Tunnel fails to start → log warning, continue without URL
- Server fails to start → log warning, continue without session viewer
- Everything else works exactly as before

Acceptance: When `--remote` flag is set and cloudflared is available, each worker gets a session viewer + tunnel. Session URL is posted on the PR as a comment. Cleanup kills tunnels and servers. Without `--remote` or without cloudflared, behavior is unchanged. Tests cover: full lifecycle (launch → URL → cleanup), graceful degradation, opt-in gating.

**Test plan:**
- Unit test orchestrator launches session server + tunnel on worker start
- Unit test PR comment is posted with session URL
- Unit test cleanup stops tunnel and server
- Unit test graceful degradation when cloudflared unavailable
- Unit test `--remote` flag gating (no servers when flag is off)
- Unit test status display includes session URL

Key files: `core/orchestrator.ts`, `core/commands/orchestrate.ts`, `core/commands/status.ts`, `test/orchestrator.test.ts`
