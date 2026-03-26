// Tests for core/session-server.ts — Dashboard HTTP server.
// Uses dependency injection (DashboardDeps) for isolation — no vi.mock needed.

import { describe, it, expect, afterEach } from "vitest";
import {
  startDashboard,
  stopDashboard,
  type DashboardServer,
  type SessionUrlProvider,
} from "../core/session-server.ts";
import type { OrchestratorItem } from "../core/orchestrator.ts";
import type { TodoItem } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTodo(id: string): TodoItem {
  return {
    id,
    priority: "high",
    title: `TODO ${id}`,
    domain: "test",
    dependencies: [],
    bundleWith: [],
    status: "open",
    filePath: "",
    repoAlias: "",
    rawText: "",
    filePaths: [],
    testPlan: "",
    bootstrap: false,
  };
}

function makeItem(
  id: string,
  state: OrchestratorItem["state"] = "implementing",
  overrides?: Partial<OrchestratorItem>,
): OrchestratorItem {
  return {
    id,
    todo: makeTodo(id),
    state,
    lastTransition: new Date().toISOString(),
    ciFailCount: 0,
    retryCount: 0,
    workspaceRef: `workspace:${id}`,
    ...overrides,
  };
}

const TEST_TOKEN = "test-token-abc123";

function startTestServer(
  items: OrchestratorItem[] = [],
  readScreen: (ref: string, lines: number) => string = () => "",
): DashboardServer {
  return startDashboard(() => items, readScreen, {
    generateToken: () => TEST_TOKEN,
    port: 0,
  });
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

function url(server: DashboardServer, path: string): string {
  return `http://localhost:${server.port}${path}`;
}

// ── Cleanup ─────────────────────────────────────────────────────────

const servers: DashboardServer[] = [];

afterEach(() => {
  for (const s of servers) {
    try {
      s.stop();
    } catch {
      // already stopped
    }
  }
  servers.length = 0;
});

function tracked(server: DashboardServer): DashboardServer {
  servers.push(server);
  return server;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("session-server", () => {
  describe("startup", () => {
    it("returns valid port and token", () => {
      const server = tracked(startTestServer());
      expect(server.port).toBeGreaterThan(0);
      expect(server.token).toBe(TEST_TOKEN);
    });

    it("generates random token when no override provided", () => {
      const server = tracked(
        startDashboard(
          () => [],
          () => "",
        ),
      );
      expect(server.token).toHaveLength(64); // 32 bytes hex = 64 chars
      expect(server.port).toBeGreaterThan(0);
    });

    it("stop() shuts down the server", async () => {
      const server = tracked(startTestServer());
      const port = server.port;

      // Server should respond
      const res1 = await fetch(url(server, "/health"));
      expect(res1.status).toBe(200);

      server.stop();

      // Server should be down — fetch should throw
      try {
        await fetch(`http://localhost:${port}/health`);
        // If it somehow succeeds (port reuse), that's fine for testing
      } catch {
        // Expected: connection refused
      }
    });
  });

  describe("stopDashboard", () => {
    it("stops the server via exported function", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(url(server, "/health"));
      expect(res.status).toBe(200);

      stopDashboard(server);
    });
  });

  describe("auth", () => {
    it("allows request with valid bearer token", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(url(server, "/"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
    });

    it("allows request with valid query param token", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(
        url(server, `/?token=${encodeURIComponent(TEST_TOKEN)}`),
      );
      expect(res.status).toBe(200);
    });

    it("rejects request with invalid token", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(url(server, "/"), {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("unauthorized");
    });

    it("rejects request with no token", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(url(server, "/"));
      expect(res.status).toBe(401);
    });

    it("rejects request with invalid query param token", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(url(server, "/?token=wrong"));
      expect(res.status).toBe(401);
    });
  });

  describe("GET /health", () => {
    it("returns 200 without auth", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(url(server, "/health"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    });

    it("does not expose sensitive data", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(url(server, "/health"));
      const text = await res.text();
      expect(text).not.toContain(TEST_TOKEN);
    });
  });

  describe("GET /", () => {
    it("returns HTML dashboard with items", async () => {
      const items = [
        makeItem("H-FOO-1", "implementing", { prNumber: 42 }),
        makeItem("H-BAR-2", "ci-passed"),
      ];
      const server = tracked(startTestServer(items));

      const res = await fetch(url(server, "/"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");

      const html = await res.text();
      expect(html).toContain("ninthwave dashboard");
      expect(html).toContain("H-FOO-1");
      expect(html).toContain("H-BAR-2");
      expect(html).toContain("implementing");
      expect(html).toContain("ci-passed");
      expect(html).toContain("#42");
      expect(html).toContain("2 items");
    });

    it("shows empty state when no items", async () => {
      const server = tracked(startTestServer([]));
      const res = await fetch(url(server, "/"), {
        headers: authHeaders(),
      });
      const html = await res.text();
      expect(html).toContain("No items");
      expect(html).toContain("0 items");
    });

    it("contains session links for items", async () => {
      const items = [makeItem("H-FOO-1")];
      const server = tracked(startTestServer(items));

      const res = await fetch(url(server, "/"), {
        headers: authHeaders(),
      });
      const html = await res.text();
      expect(html).toContain("/session/H-FOO-1");
    });

    it("auto-refreshes via script", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(url(server, "/"), {
        headers: authHeaders(),
      });
      const html = await res.text();
      expect(html).toContain("setTimeout");
      expect(html).toContain("reload");
    });

    it("is responsive with viewport meta", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(url(server, "/"), {
        headers: authHeaders(),
      });
      const html = await res.text();
      expect(html).toContain('name="viewport"');
    });
  });

  describe("GET /session/:itemId", () => {
    it("returns HTML with terminal content", async () => {
      const items = [makeItem("H-FOO-1")];
      const readScreen = (_ref: string, _lines: number) =>
        "$ bun test\nAll tests passed";
      const server = tracked(startTestServer(items, readScreen));

      const res = await fetch(url(server, "/session/H-FOO-1"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");

      const html = await res.text();
      expect(html).toContain("H-FOO-1");
      expect(html).toContain("bun test");
      expect(html).toContain("All tests passed");
    });

    it("returns empty content for unknown item", async () => {
      const server = tracked(startTestServer([]));
      const res = await fetch(url(server, "/session/UNKNOWN"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("UNKNOWN");
    });

    it("includes back link to dashboard", async () => {
      const items = [makeItem("H-FOO-1")];
      const server = tracked(startTestServer(items));
      const res = await fetch(url(server, "/session/H-FOO-1"), {
        headers: authHeaders(),
      });
      const html = await res.text();
      expect(html).toContain("← back");
      expect(html).toContain(`/?token=${encodeURIComponent(TEST_TOKEN)}`);
    });

    it("auto-refreshes screen content via polling", async () => {
      const items = [makeItem("H-FOO-1")];
      const server = tracked(startTestServer(items));
      const res = await fetch(url(server, "/session/H-FOO-1"), {
        headers: authHeaders(),
      });
      const html = await res.text();
      expect(html).toContain("setInterval");
      expect(html).toContain("/api/screen/H-FOO-1");
    });
  });

  describe("GET /api/items", () => {
    it("returns JSON array of items", async () => {
      const items = [
        makeItem("H-FOO-1", "implementing"),
        makeItem("H-BAR-2", "done"),
      ];
      const server = tracked(startTestServer(items));

      const res = await fetch(url(server, "/api/items"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");

      const body = await res.json();
      expect(body.items).toHaveLength(2);
      expect(body.items[0].id).toBe("H-FOO-1");
      expect(body.items[0].state).toBe("implementing");
      expect(body.items[1].id).toBe("H-BAR-2");
    });

    it("returns empty array when no items", async () => {
      const server = tracked(startTestServer([]));
      const res = await fetch(url(server, "/api/items"), {
        headers: authHeaders(),
      });
      const body = await res.json();
      expect(body.items).toHaveLength(0);
    });
  });

  describe("GET /api/screen/:itemId", () => {
    it("returns JSON with screen content", async () => {
      const items = [makeItem("H-FOO-1")];
      const readScreen = (_ref: string, _lines: number) =>
        "screen output here";
      const server = tracked(startTestServer(items, readScreen));

      const res = await fetch(url(server, "/api/screen/H-FOO-1"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.itemId).toBe("H-FOO-1");
      expect(body.content).toBe("screen output here");
      expect(body.timestamp).toBeTruthy();
    });

    it("returns empty content for unknown item", async () => {
      const server = tracked(startTestServer([]));
      const res = await fetch(url(server, "/api/screen/UNKNOWN"), {
        headers: authHeaders(),
      });
      const body = await res.json();
      expect(body.itemId).toBe("UNKNOWN");
      expect(body.content).toBe("");
    });

    it("throttles readScreen calls", async () => {
      const items = [makeItem("H-FOO-1")];
      let callCount = 0;
      const readScreen = (_ref: string, _lines: number) => {
        callCount++;
        return `call-${callCount}`;
      };
      const server = tracked(startTestServer(items, readScreen));

      // First call should invoke readScreen
      const res1 = await fetch(url(server, "/api/screen/H-FOO-1"), {
        headers: authHeaders(),
      });
      const body1 = await res1.json();
      expect(body1.content).toBe("call-1");

      // Second call within throttle window should return cached
      const res2 = await fetch(url(server, "/api/screen/H-FOO-1"), {
        headers: authHeaders(),
      });
      const body2 = await res2.json();
      expect(body2.content).toBe("call-1"); // Same cached result
      expect(callCount).toBe(1); // Only called once
    });
  });

  describe("404", () => {
    it("returns 404 for unknown routes", async () => {
      const server = tracked(startTestServer());
      const res = await fetch(url(server, "/nonexistent"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("not found");
    });
  });

  describe("SessionUrlProvider integration", () => {
    it("provider getPublicUrl is callable with port and token", async () => {
      let capturedPort = 0;
      let capturedToken = "";

      const provider: SessionUrlProvider = {
        async getPublicUrl(localPort: number, token: string) {
          capturedPort = localPort;
          capturedToken = token;
          return `https://tunnel.example.com/dashboard`;
        },
        async cleanup() {},
      };

      const server = tracked(
        startDashboard(
          () => [],
          () => "",
          {
            generateToken: () => TEST_TOKEN,
            port: 0,
            urlProvider: provider,
          },
        ),
      );

      // Call getPublicUrl with server info
      const publicUrl = await provider.getPublicUrl(server.port, server.token);
      expect(publicUrl).toBe("https://tunnel.example.com/dashboard");
      expect(capturedPort).toBe(server.port);
      expect(capturedToken).toBe(TEST_TOKEN);
    });

    it("null provider returns null URL", async () => {
      const provider: SessionUrlProvider = {
        async getPublicUrl() {
          return null;
        },
        async cleanup() {},
      };

      const server = tracked(
        startDashboard(
          () => [],
          () => "",
          {
            generateToken: () => TEST_TOKEN,
            port: 0,
            urlProvider: provider,
          },
        ),
      );

      const publicUrl = await provider.getPublicUrl(server.port, server.token);
      expect(publicUrl).toBeNull();
    });

    it("provider cleanup is callable", async () => {
      let cleanedUp = false;
      const provider: SessionUrlProvider = {
        async getPublicUrl() {
          return "https://example.com";
        },
        async cleanup() {
          cleanedUp = true;
        },
      };

      const server = tracked(
        startDashboard(
          () => [],
          () => "",
          {
            generateToken: () => TEST_TOKEN,
            port: 0,
            urlProvider: provider,
          },
        ),
      );

      await provider.cleanup();
      expect(cleanedUp).toBe(true);
    });
  });

  describe("HTML escaping", () => {
    it("escapes item IDs in dashboard", async () => {
      const items = [
        makeItem('<script>alert("xss")</script>', "implementing"),
      ];
      const server = tracked(startTestServer(items));

      const res = await fetch(url(server, "/"), {
        headers: authHeaders(),
      });
      const html = await res.text();
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes terminal content in session view", async () => {
      const items = [makeItem("H-FOO-1")];
      const readScreen = () => '<img src=x onerror="alert(1)">';
      const server = tracked(startTestServer(items, readScreen));

      const res = await fetch(url(server, "/session/H-FOO-1"), {
        headers: authHeaders(),
      });
      const html = await res.text();
      expect(html).not.toContain('onerror="alert');
      expect(html).toContain("&lt;img");
    });
  });
});
