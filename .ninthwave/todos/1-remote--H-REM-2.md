# Feat: Add session viewer HTTP server (H-REM-2)

**Priority:** High
**Source:** Vision L-VIS-7 — remote session access foundation
**Depends on:** None
**Domain:** remote

Implement `core/session-server.ts` — a lightweight HTTP server (Bun.serve) that serves a read-only view of a worker's terminal session. This is the presentation layer for remote session access.

**Design:**
- Uses `Bun.serve` for zero-dependency HTTP serving.
- Reads terminal content via `readScreen()` from the multiplexer adapter.
- Serves a single HTML page with auto-refreshing terminal output.
- One server instance per worker, bound to a dynamic local port.

**API (exported functions):**

```typescript
interface SessionServer {
  port: number;          // Local port the server is bound to
  itemId: string;        // Associated work item
  stop: () => void;      // Shutdown the server
}

/** Start a session viewer server for a worker. */
function startSessionServer(
  itemId: string,
  workspaceRef: string,
  readScreen: (ref: string, lines: number) => string,
  deps?: SessionServerDeps,
): SessionServer;

/** Stop a session server. */
function stopSessionServer(server: SessionServer): void;
```

**Routes:**
- `GET /` — HTML page with terminal output, auto-refresh via meta tag (2s interval) or optional Server-Sent Events (SSE) for live updates.
- `GET /api/screen` — JSON endpoint returning `{ itemId, content, timestamp }` for the current screen content.
- `GET /health` — Health check endpoint returning 200.

**HTML page design:**
- Inline CSS + JS (single self-contained HTML response, no external assets).
- Dark terminal theme (black background, green/white text, monospace font).
- Header showing item ID, worker state, last update time.
- Pre-formatted terminal content in a `<pre>` block.
- Auto-scroll to bottom on refresh.
- Responsive — readable on mobile (phone-sized screen).
- Read-only — no input capability in v1. Interactive mode deferred to future iteration.

**Implementation details:**
- Bind to port 0 (OS-assigned) to avoid conflicts. Return the assigned port.
- Use partition-based port selection as fallback: `19000 + (partition * 10) + offset`.
- `readScreen` calls are throttled to max 1/second to avoid hammering the multiplexer.
- Server stops automatically if `readScreen` throws 5 consecutive errors (workspace closed).

Acceptance: `startSessionServer()` starts a Bun HTTP server on a dynamic port. `GET /` returns an HTML page with terminal content. `GET /api/screen` returns JSON with current screen. `GET /health` returns 200. Server auto-stops when workspace is gone. Tests cover: server startup, all three routes, auto-stop on consecutive errors.

**Test plan:**
- Unit test server startup returns a valid port
- Unit test `GET /` returns HTML with terminal content from mock readScreen
- Unit test `GET /api/screen` returns JSON with expected shape
- Unit test `GET /health` returns 200
- Unit test auto-stop after 5 consecutive readScreen errors
- Unit test throttling (readScreen not called more than 1/s)

Key files: `core/session-server.ts`, `test/session-server.test.ts`
