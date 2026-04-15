// Tests for the persistent self-hosted broker runtime.
// Covers: auto-join on unknown crew ids, persistence across restart,
// reconnect resume, grace-period release, and rich remoteItems snapshots.

import { describe, it, expect, afterEach } from "vitest";
import { BrokerServer } from "../core/broker-server.ts";
import { FileBrokerStore } from "../core/broker-store.ts";
import { existsSync, rmSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * A base64url token that satisfies the new permissive crew-id regex
 * (`[A-Za-z0-9_-]{16,64}`). Two daemons auto-join to the same crew just
 * by using the same id; there is no POST handshake anymore.
 */
const TEST_CREW_ID = "ABCDEFGHIJKLMNOPQRSTUV";
const ALT_CREW_ID = "ZYXWVUTSRQPONMLKJIHGFE";

// ── Helpers ─────────────────────────────────────────────────────────

let servers: BrokerServer[] = [];
let tmpDirs: string[] = [];

function createTmpDir(): string {
  const dir = join(tmpdir(), `nw-broker-rt-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function startServer(opts: {
  heartbeatTimeoutMs?: number;
  gracePeriodMs?: number;
  checkIntervalMs?: number;
  dataDir?: string;
} = {}): {
  server: BrokerServer;
  port: number;
  dataDir: string;
  eventLogPath: string;
} {
  const tmpDir = createTmpDir();
  const dataDir = opts.dataDir ?? join(tmpDir, "crews");
  const eventLogPath = join(tmpDir, ".ninthwave", "crew-events.jsonl");
  const server = new BrokerServer({
    port: 0,
    dataDir,
    eventLogPath,
    checkIntervalMs: 50,
    ...opts,
  });
  const port = server.start();
  servers.push(server);
  return { server, port, dataDir, eventLogPath };
}

/**
 * Synthesize a fresh crew id. Each call returns a unique 22-char token
 * within the allowed charset so tests don't cross-contaminate.
 */
function freshCrewId(prefix = ""): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const base = prefix + Math.random().toString(36).slice(2);
  let out = base;
  while (out.length < 22) out += chars[Math.floor(Math.random() * chars.length)];
  return out.slice(0, 22).replace(/[^A-Za-z0-9_-]/g, "A");
}

function connectWs(
  port: number,
  crewId: string,
  daemonId: string,
  name: string,
  opts?: { operatorId?: string },
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let url = `ws://localhost:${port}/api/crews/${crewId}/ws?daemonId=${daemonId}&name=${name}`;
    if (opts?.operatorId) url += `&operatorId=${encodeURIComponent(opts.operatorId)}`;
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(e));
  });
}

function waitForMessageByType<T = unknown>(ws: WebSocket, type: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for message type: ${type}`)), timeoutMs);
    const handler = (e: MessageEvent) => {
      const data = JSON.parse(String(e.data));
      if (data.type === type) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(data as T);
      }
    };
    ws.addEventListener("message", handler);
  });
}

function syncItem(id: string, opts?: { dependencies?: string[]; priority?: number; author?: string }) {
  return {
    id,
    dependencies: opts?.dependencies ?? [],
    priority: opts?.priority ?? 1,
    author: opts?.author ?? "",
  };
}

async function sendSync(ws: WebSocket, daemonId: string, workItemIds: string[], itemOpts?: Record<string, { dependencies?: string[]; priority?: number; author?: string }>): Promise<void> {
  const items = workItemIds.map((id) => syncItem(id, itemOpts?.[id]));
  ws.send(JSON.stringify({ type: "sync", daemonId, items }));
  await waitForMessageByType(ws, "sync_ack");
}

async function sendClaim(ws: WebSocket, daemonId: string): Promise<{ workItemId: string | null; requestId: string }> {
  const requestId = `req-${Math.random().toString(36).slice(2, 8)}`;
  ws.send(JSON.stringify({ type: "claim", requestId, daemonId }));
  const resp = await waitForMessageByType<{ type: string; requestId: string; workItemId: string | null }>(ws, "claim_response");
  return { workItemId: resp.workItemId, requestId: resp.requestId };
}

async function sendComplete(ws: WebSocket, daemonId: string, workItemId: string): Promise<{ type: string; workItemId?: string; message?: string }> {
  ws.send(JSON.stringify({ type: "complete", workItemId, daemonId }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for complete response")), 2000);
    const handler = (e: MessageEvent) => {
      const data = JSON.parse(String(e.data));
      if (data.type === "complete_ack" || data.type === "error") {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
  });
}

function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Setup / Teardown ────────────────────────────────────────────────

afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── Tests ───────────────────────────────────────────────────────────

describe("broker-runtime", () => {
  describe("auto-join", () => {
    it("auto-creates a crew on first connection with a new id", async () => {
      const { server, port } = startServer();
      const code = freshCrewId("auto");
      // No POST precedes the connection; the broker should create an empty
      // crew on the fly and upgrade the WebSocket successfully.
      const ws = await connectWs(port, code, "d1", "worker-1");

      const update = await waitForMessageByType<{
        type: string;
        daemonCount: number;
      }>(ws, "crew_update");

      expect(update.daemonCount).toBe(1);
      expect(server.getCrew(code)).toBeDefined();
      ws.close();
    });

    it("rejects WebSocket paths that do not match the crew-id regex", async () => {
      const { port } = startServer();
      try {
        // Too short -- regex requires 16-64 base64url chars.
        const ws = await connectWs(port, "shortid", "d1", "worker-1");
        ws.close();
        expect.unreachable("Should have failed");
      } catch {
        // Expected -- the upgrade is rejected (404).
      }
    });

    it("no longer exposes a POST /api/crews endpoint", async () => {
      const { port } = startServer();
      const res = await fetch(`http://localhost:${port}/api/crews`, { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("persistence across restart", () => {
    it("restores crew state after server restart", async () => {
      const tmpDir = createTmpDir();
      const dataDir = join(tmpDir, "crews");

      const code = freshCrewId("restart");
      const { server: s1, port: p1 } = startServer({ dataDir });
      const ws1 = await connectWs(p1, code, "d1", "worker-1");
      await sendSync(ws1, "d1", ["item-A", "item-B"]);
      const claim = await sendClaim(ws1, "d1");
      expect(claim.workItemId).toBe("item-A");
      ws1.close();
      await tick();
      s1.stop();
      servers = servers.filter((s) => s !== s1);

      // Verify files were written
      const files = readdirSync(dataDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);

      // Start server 2 with the same data dir
      const { server: s2, port: p2 } = startServer({ dataDir });

      // Crew should exist
      const crew = s2.getCrew(code);
      expect(crew).toBeDefined();
      expect(crew!.code).toBe(code);

      // Items should be restored
      expect(crew!.items.size).toBe(2);
      expect(crew!.items.get("item-A")?.claimedBy).toBe("d1");
      expect(crew!.items.get("item-B")?.claimedBy).toBeNull();

      // Daemon state should be restored (ws=null since no active connection)
      expect(crew!.daemons.size).toBe(1);
      const daemon = crew!.daemons.get("d1");
      expect(daemon).toBeDefined();
      expect(daemon!.ws).toBeNull();
      expect(daemon!.claimedItems.has("item-A")).toBe(true);
    });

  });

  describe("reconnect resume", () => {
    it("resumes claimed work items on reconnect before grace period", async () => {
      const { port } = startServer({ gracePeriodMs: 5000 });
      const code = freshCrewId("resume");

      // Connect, sync, and claim
      const ws1 = await connectWs(port, code, "d1", "worker-1");
      await sendSync(ws1, "d1", ["item-A", "item-B"]);
      const claim = await sendClaim(ws1, "d1");
      expect(claim.workItemId).toBe("item-A");

      // Disconnect
      ws1.close();
      await tick(100);

      // Reconnect -- should get reconnect_state with resumed items
      const ws2 = await connectWs(port, code, "d1", "worker-1");
      const reconnectState = await waitForMessageByType<{
        type: string;
        resumed: string[];
        released: string[];
        reclaimed: string[];
      }>(ws2, "reconnect_state");

      expect(reconnectState.resumed).toEqual(["item-A"]);
      expect(reconnectState.released).toEqual([]);
      expect(reconnectState.reclaimed).toEqual([]);
      ws2.close();
    });
  });

  describe("grace-period release", () => {
    it("releases claimed items after grace period expires", async () => {
      const { server, port } = startServer({
        heartbeatTimeoutMs: 50,
        gracePeriodMs: 100,
        checkIntervalMs: 25,
      });
      const code = freshCrewId();

      // d1 connects, syncs, and claims
      const ws1 = await connectWs(port, code, "d1", "worker-1");
      await sendSync(ws1, "d1", ["item-A"]);
      const claim1 = await sendClaim(ws1, "d1");
      expect(claim1.workItemId).toBe("item-A");

      // d2 connects
      const ws2 = await connectWs(port, code, "d2", "worker-2");

      // d1 disconnects
      ws1.close();

      // Wait for heartbeat timeout + grace period
      await tick(300);

      // d2 should now be able to claim item-A (released from d1)
      const claim2 = await sendClaim(ws2, "d2");
      expect(claim2.workItemId).toBe("item-A");

      ws2.close();
    });
  });

  describe("remoteItems snapshots", () => {
    it("includes remoteItems in crew_update broadcasts", async () => {
      const { port } = startServer();
      const code = freshCrewId();
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["item-A", "item-B"]);

      // Claim item-A
      await sendClaim(ws, "d1");

      // Wait for the crew_update triggered by claim
      const update = await waitForMessageByType<{
        type: string;
        remoteItems: Array<{
          id: string;
          state: string;
          ownerDaemonId: string | null;
          ownerName: string | null;
        }>;
      }>(ws, "crew_update");

      expect(update.remoteItems).toBeDefined();
      expect(update.remoteItems.length).toBe(2);

      const itemA = update.remoteItems.find((i) => i.id === "item-A");
      expect(itemA).toBeDefined();
      expect(itemA!.state).toBe("in-progress");
      expect(itemA!.ownerDaemonId).toBe("d1");
      expect(itemA!.ownerName).toBe("worker-1");

      const itemB = update.remoteItems.find((i) => i.id === "item-B");
      expect(itemB).toBeDefined();
      expect(itemB!.state).toBe("queued");
      expect(itemB!.ownerDaemonId).toBeNull();

      ws.close();
    });

    it("shows completed items as done in remoteItems", async () => {
      const { port } = startServer();
      const code = freshCrewId();
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["item-A"]);
      await sendClaim(ws, "d1");
      await sendComplete(ws, "d1", "item-A");

      // Wait for the crew_update triggered by complete
      const update = await waitForMessageByType<{
        type: string;
        remoteItems: Array<{ id: string; state: string }>;
      }>(ws, "crew_update");

      const itemA = update.remoteItems.find((i) => i.id === "item-A");
      expect(itemA).toBeDefined();
      expect(itemA!.state).toBe("done");

      ws.close();
    });

    it("shows blocked items correctly in remoteItems", async () => {
      const { port } = startServer();
      const code = freshCrewId();
      const ws = await connectWs(port, code, "d1", "worker-1");

      // item-B depends on item-A
      await sendSync(ws, "d1", ["item-A", "item-B"], {
        "item-B": { dependencies: ["item-A"] },
      });

      // Get the crew_update after sync
      const update = await waitForMessageByType<{
        type: string;
        remoteItems: Array<{ id: string; state: string }>;
      }>(ws, "crew_update");

      const itemB = update.remoteItems.find((i) => i.id === "item-B");
      expect(itemB).toBeDefined();
      expect(itemB!.state).toBe("blocked");

      ws.close();
    });
  });

  describe("file-backed store", () => {
    it("loads and saves crew state without corruption", () => {
      const tmpDir = createTmpDir();
      const dataDir = join(tmpDir, "store-test");

      // Create store and add crew
      const store1 = new FileBrokerStore(dataDir);
      const crew = store1.createCrew("TEST-CODE-1234", "abc123");
      crew.items.set("item-1", {
        path: "item-1",
        priority: 1,
        dependencies: [],
        author: "alice@example.com",
        syncedAt: 100,
        creatorDaemonId: "d1",
        claimedBy: "d1",
        completedBy: null,
      });
      crew.daemons.set("d1", {
        id: "d1",
        name: "worker-1",
        operatorId: "alice@example.com",
        ws: null,
        lastHeartbeat: 200,
        disconnectedAt: null,
        claimedItems: new Set(["item-1"]),
        released: false,
      });
      store1.saveCrew(crew);

      // Create a new store from the same dir
      const store2 = new FileBrokerStore(dataDir);
      expect(store2.hasCrew("TEST-CODE-1234")).toBe(true);

      const loaded = store2.getCrew("TEST-CODE-1234")!;
      expect(loaded.code).toBe("TEST-CODE-1234");
      expect(loaded.repoRef).toBe("abc123");
      expect(loaded.items.size).toBe(1);
      expect(loaded.items.get("item-1")?.claimedBy).toBe("d1");
      expect(loaded.items.get("item-1")?.author).toBe("alice@example.com");

      expect(loaded.daemons.size).toBe(1);
      const daemon = loaded.daemons.get("d1")!;
      expect(daemon.ws).toBeNull();
      expect(daemon.name).toBe("worker-1");
      expect(daemon.operatorId).toBe("alice@example.com");
      expect(daemon.claimedItems.has("item-1")).toBe(true);

    });

    it("handles empty data directory gracefully", () => {
      const tmpDir = createTmpDir();
      const dataDir = join(tmpDir, "empty-store");
      const store = new FileBrokerStore(dataDir);
      expect(Array.from(store.listCrews())).toEqual([]);
    });

    it("skips corrupt JSON files without crashing", () => {
      const tmpDir = createTmpDir();
      const dataDir = join(tmpDir, "corrupt-store");
      mkdirSync(dataDir, { recursive: true });

      // Write a corrupt file
      const { writeFileSync } = require("fs");
      writeFileSync(join(dataDir, "CORRUPT.json"), "not valid json {{{");

      // Should load without error
      const store = new FileBrokerStore(dataDir);
      expect(store.hasCrew("CORRUPT")).toBe(false);
    });

    it("removes crew from disk", () => {
      const tmpDir = createTmpDir();
      const dataDir = join(tmpDir, "remove-test");
      const store = new FileBrokerStore(dataDir);
      store.createCrew("TO-REMOVE-1234");
      expect(existsSync(join(dataDir, "TO-REMOVE-1234.json"))).toBe(true);
      store.removeCrew("TO-REMOVE-1234");
      expect(existsSync(join(dataDir, "TO-REMOVE-1234.json"))).toBe(false);
      expect(store.hasCrew("TO-REMOVE-1234")).toBe(false);
    });
  });

  describe("full workflow", () => {
    it("handles create, sync, claim, complete across WebSocket lifecycle", async () => {
      const { port } = startServer();
      const code = freshCrewId();
      const ws = await connectWs(port, code, "d1", "worker-1");

      // Sync items
      await sendSync(ws, "d1", ["item-A", "item-B", "item-C"]);

      // Claim and complete them in order
      const c1 = await sendClaim(ws, "d1");
      expect(c1.workItemId).toBe("item-A");
      await sendComplete(ws, "d1", "item-A");

      const c2 = await sendClaim(ws, "d1");
      expect(c2.workItemId).toBe("item-B");
      await sendComplete(ws, "d1", "item-B");

      const c3 = await sendClaim(ws, "d1");
      expect(c3.workItemId).toBe("item-C");
      await sendComplete(ws, "d1", "item-C");

      // No more items
      const c4 = await sendClaim(ws, "d1");
      expect(c4.workItemId).toBeNull();

      ws.close();
    });

    it("handles heartbeat ack", async () => {
      const { port } = startServer();
      const code = freshCrewId();
      const ws = await connectWs(port, code, "d1", "worker-1");

      const ts = new Date().toISOString();
      ws.send(JSON.stringify({ type: "heartbeat", daemonId: "d1", ts }));
      const ack = await waitForMessageByType<{ type: string; ts: string }>(ws, "heartbeat_ack");
      expect(ack.ts).toBe(ts);

      ws.close();
    });
  });
});
