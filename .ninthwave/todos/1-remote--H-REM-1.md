# Feat: Add cloudflared tunnel management module (H-REM-1)

**Priority:** High
**Source:** Vision L-VIS-7 — remote session access foundation
**Depends on:** None
**Domain:** remote

Implement `core/tunnel.ts` — a module for managing cloudflared quick tunnels that expose local services to the internet. This is the transport layer for remote session access (Phase C in vision.md).

**Design:**
- Use cloudflared's quick tunnel mode (`cloudflared tunnel --url <local-url>`) which requires no Cloudflare account and auto-generates a `*.trycloudflare.com` URL.
- Each worker session gets its own tunnel, managed by the orchestrator.
- The tunnel process runs as a child of the orchestrator. When the orchestrator cleans up a worker, the tunnel is killed.

**API (exported functions):**

```typescript
interface TunnelHandle {
  url: string;           // Public URL (e.g., https://abc-123.trycloudflare.com)
  localPort: number;     // The local port being tunneled
  process: ChildProcess; // For lifecycle management
  itemId: string;        // Associated work item
}

/** Check if cloudflared is installed. */
function isCloudflaredAvailable(runner?: ShellRunner): boolean;

/** Start a quick tunnel for a local port. Returns the public URL once established. */
function startTunnel(localPort: number, itemId: string, deps?: TunnelDeps): Promise<TunnelHandle>;

/** Stop a tunnel and clean up the process. */
function stopTunnel(handle: TunnelHandle): void;

/** Stop all active tunnels. */
function stopAllTunnels(): void;
```

**Implementation details:**
- `startTunnel` spawns `cloudflared tunnel --url http://localhost:<port>` as a background process.
- Parse stdout for the generated URL (cloudflared prints `https://*.trycloudflare.com` to stderr during startup).
- Use a Promise with timeout (30s) — reject if URL isn't detected within the timeout.
- Track active tunnels in a module-level Map for cleanup.
- `stopTunnel` sends SIGTERM, then SIGKILL after 5s grace period.
- Injectable `ShellRunner` and `SpawnFn` for testing (no `vi.mock`).

**Error handling:**
- If cloudflared is not installed, log a warning and return null (graceful degradation — no tunnel, no session URL, everything else works).
- If the tunnel process exits unexpectedly, log the event and remove from tracking.
- Retry once on startup failure before giving up.

Acceptance: `isCloudflaredAvailable()` correctly detects cloudflared. `startTunnel()` spawns cloudflared, parses the public URL, and returns a TunnelHandle. `stopTunnel()` kills the process. Tests cover: detection, URL parsing, startup timeout, graceful degradation when cloudflared is missing.

**Test plan:**
- Unit test `isCloudflaredAvailable` with mock runner (installed and not installed)
- Unit test URL parsing from cloudflared stderr output (mock the output format)
- Unit test `stopTunnel` sends SIGTERM
- Unit test graceful degradation (return null when cloudflared unavailable)
- Unit test timeout handling when URL never appears

Key files: `core/tunnel.ts`, `test/tunnel.test.ts`
