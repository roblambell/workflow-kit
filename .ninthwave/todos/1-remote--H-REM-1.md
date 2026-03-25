# Feat: Add orchestrator dashboard HTTP server (H-REM-1)

**Priority:** High
**Source:** Vision L-VIS-7 — remote session access foundation (revised per CEO review 2026-03-25)
**Depends on:** None
**Domain:** remote

Implement `core/session-server.ts` — a single HTTP server (Bun.serve) that serves the orchestrator dashboard: a real-time view of all workers, with drill-down to individual session screens. This replaces the previous design of one server per worker.

**Architecture change (from CEO review):**
- **One server, one tunnel, one URL.** The dashboard is the entry point. Users navigate to individual worker sessions from there. No per-worker tunnels.
- **Secure by default.** The server requires a bearer token to access. Token is auto-generated on startup and printed to the console. No unauthenticated access.
- **Off by default.** The dashboard server only starts when explicitly enabled (`--remote` flag or `remote_sessions=true` in config).
- **OSS provides the server, user brings the tunnel.** ninthwave does not manage tunnels in the OSS CLI. The server binds to localhost. If the user wants remote access, they point their own tunneling tool (cloudflared, ngrok, zrok) at the local port. Cloud product will handle tunneling automatically via a provider pattern.

**API (exported functions):**

```typescript
interface DashboardServer {
  port: number;          // Local port the server is bound to
  token: string;         // Auto-generated bearer token for auth
  stop: () => void;      // Shutdown the server
}

/** Start the orchestrator dashboard server. */
function startDashboard(
  getItems: () => OrchestratorItem[],
  readScreen: (ref: string, lines: number) => string,
  deps?: DashboardDeps,
): DashboardServer;

/** Stop the dashboard server. */
function stopDashboard(server: DashboardServer): void;
```

**Routes (all require `Authorization: Bearer <token>` header or `?token=<token>` query param):**
- `GET /` — Dashboard page: list of all items with state, PR link, age. Click an item to view its session.
- `GET /session/:itemId` — Individual worker session view: terminal output, auto-refreshing.
- `GET /api/items` — JSON: all items with states.
- `GET /api/screen/:itemId` — JSON: `{ itemId, content, timestamp }` for a specific worker's screen.
- `GET /health` — Health check (unauthenticated, returns 200 with no sensitive data).

**Dashboard page design:**
- Single self-contained HTML response (inline CSS + JS, no external assets).
- Dark terminal theme. Header: orchestrator run info (items count, elapsed time).
- Table of items with: ID, state (color-coded), PR link, session link, age.
- Click item → drill into `/session/:itemId` for live terminal view.
- Auto-refresh via SSE or polling (2s interval).
- Responsive — usable on mobile.

**Security:**
- Bearer token generated via `crypto.randomBytes(32).toString('hex')`.
- Token printed to console on startup: `Dashboard: http://localhost:<port> (token: <token>)`.
- All routes except `/health` return 401 without valid token.
- No CORS headers (server is for direct browser access, not cross-origin API calls).

**Provider pattern (for cloud integration):**

```typescript
interface SessionUrlProvider {
  /** Called when dashboard starts. Returns the URL to post on PRs. */
  getPublicUrl(localPort: number, token: string): Promise<string | null>;
  /** Called on shutdown. */
  cleanup(): Promise<void>;
}

// OSS default: returns null (no public URL, user brings their own tunnel)
// Cloud: starts a managed tunnel and returns the persistent URL
```

The orchestrator accepts an optional `SessionUrlProvider`. If it returns a URL, that URL is posted on PRs. If null, only the local URL is shown in the console.

**Implementation details:**
- Bind to port 0 (OS-assigned) to avoid conflicts.
- `readScreen` calls throttled to max 1/second per worker.
- Server stops when orchestrator shuts down (wired into cleanup handler).

Acceptance: `startDashboard()` starts a Bun HTTP server with token auth. Dashboard shows all items. Drill-down shows live terminal content. Auth rejects unauthenticated requests. Provider pattern allows cloud to inject a URL provider. Tests cover: auth (valid/invalid/missing token), all routes, provider pattern integration.

**Test plan:**
- Unit test server startup returns valid port and token
- Unit test auth middleware (valid token, invalid token, missing token, query param token)
- Unit test `GET /` returns HTML dashboard with item list from mock data
- Unit test `GET /session/:itemId` returns HTML with terminal content
- Unit test `GET /api/items` returns JSON
- Unit test `GET /api/screen/:itemId` returns JSON
- Unit test `GET /health` works without auth
- Unit test `SessionUrlProvider` integration (mock provider returns URL, null provider)

Key files: `core/session-server.ts`, `test/session-server.test.ts`
