// Tests for the mock crew coordination broker.
// Covers: crew creation, WebSocket protocol, author-based affinity scheduling,
// dependency filtering, duplicate claim prevention, disconnect/release/reconnect,
// and JSONL logging.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { MockBroker, type CrewEvent } from "../core/mock-broker.ts";
import { readFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Helpers ─────────────────────────────────────────────────────────

let brokers: MockBroker[] = [];
let tmpDirs: string[] = [];

function createTmpDir(): string {
  const dir = join(tmpdir(), `nw-broker-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function startBroker(opts: { heartbeatTimeoutMs?: number; gracePeriodMs?: number; checkIntervalMs?: number } = {}): {
  broker: MockBroker;
  port: number;
  eventLogPath: string;
} {
  const tmpDir = createTmpDir();
  const eventLogPath = join(tmpDir, ".ninthwave", "crew-events.jsonl");
  const broker = new MockBroker({
    port: 0,
    eventLogPath,
    checkIntervalMs: 50, // Fast check interval for tests
    ...opts,
  });
  const port = broker.start();
  brokers.push(broker);
  return { broker, port, eventLogPath };
}

async function createCrew(port: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/crews`, { method: "POST" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { code: string };
  return body.code;
}

function connectWs(
  port: number,
  crewCode: string,
  daemonId: string,
  name: string,
  operatorId?: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let url = `ws://localhost:${port}/api/crews/${crewCode}/ws?daemonId=${daemonId}&name=${name}`;
    if (operatorId) url += `&operatorId=${encodeURIComponent(operatorId)}`;
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(e));
  });
}

function waitForMessage<T = unknown>(ws: WebSocket, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for message")), timeoutMs);
    ws.addEventListener(
      "message",
      (e) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(e.data)) as T);
      },
      { once: true },
    );
  });
}

/** Wait for a message of a specific type, skipping other message types (e.g., crew_update). */
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
      // else keep waiting (skip crew_update and other broadcast messages)
    };
    ws.addEventListener("message", handler);
  });
}

/** Build a SyncItem payload with defaults for testing convenience. */
function syncItem(id: string, opts?: { dependencies?: string[]; priority?: number; author?: string }) {
  return {
    id,
    dependencies: opts?.dependencies ?? [],
    priority: opts?.priority ?? 1,
    author: opts?.author ?? "",
  };
}

/** Send sync and wait for sync_ack. */
async function sendSync(ws: WebSocket, daemonId: string, todoIds: string[], itemOpts?: Record<string, { dependencies?: string[]; priority?: number; author?: string }>): Promise<void> {
  const items = todoIds.map((id) => syncItem(id, itemOpts?.[id]));
  ws.send(JSON.stringify({ type: "sync", daemonId, items }));
  await waitForMessageByType(ws, "sync_ack");
}

/** Send claim and wait for claim_response. Returns itemId or null. */
async function sendClaim(ws: WebSocket, daemonId: string): Promise<{ todoId: string | null; requestId: string }> {
  const requestId = `req-${Math.random().toString(36).slice(2, 8)}`;
  ws.send(JSON.stringify({ type: "claim", requestId, daemonId }));
  const resp = await waitForMessageByType<{ type: string; requestId: string; todoId: string | null }>(ws, "claim_response");
  return { todoId: resp.todoId, requestId: resp.requestId };
}

/** Send complete and wait for complete_ack or error. Skips crew_update broadcasts. */
async function sendComplete(ws: WebSocket, daemonId: string, todoId: string): Promise<{ type: string; todoId?: string; message?: string }> {
  ws.send(JSON.stringify({ type: "complete", todoId, daemonId }));
  // Wait for either complete_ack or error, skipping crew_update broadcasts
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

function readEventLog(path: string): CrewEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CrewEvent);
}

/** Small delay to let the event loop process messages. */
function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Setup / Teardown ────────────────────────────────────────────────

afterEach(() => {
  for (const b of brokers) b.stop();
  brokers = [];
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── Tests ───────────────────────────────────────────────────────────

describe("mock-broker", () => {
  describe("crew creation", () => {
    it("creates a crew with a 6-char XXX-XXX code", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);

      expect(code).toMatch(/^[A-Za-z0-9]{3}-[A-Za-z0-9]{3}$/);
      expect(code.replace("-", "")).toHaveLength(6);
    });

    it("creates unique crew codes", async () => {
      const { port } = startBroker();
      const codes = new Set<string>();
      for (let i = 0; i < 20; i++) {
        codes.add(await createCrew(port));
      }
      expect(codes.size).toBe(20);
    });
  });

  describe("WebSocket connection", () => {
    it("upgrades at /api/crews/:code/ws with daemonId and name", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "daemon-1", "worker-1");
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it("rejects connection to non-existent crew", async () => {
      const { port } = startBroker();
      try {
        const ws = await connectWs(port, "ABC-XYZ", "daemon-1", "worker-1");
        ws.close();
        expect.unreachable("Should have failed");
      } catch {
        // Expected -- the upgrade should fail
      }
    });

    it("rejects connection without daemonId param", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const res = await fetch(
        `http://localhost:${port}/api/crews/${code}/ws?name=worker-1`,
        { headers: { Upgrade: "websocket" } },
      );
      expect(res.status).toBe(400);
    });

    it("stores operatorId on DaemonState from connect handshake", async () => {
      const { broker, port } = startBroker();
      const code = await createCrew(port);

      // Connect with operatorId query param
      const ws = new WebSocket(
        `ws://localhost:${port}/api/crews/${code}/ws?daemonId=d1&name=worker-1&operatorId=${encodeURIComponent("dev@example.com")}`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", (e) => reject(e));
      });
      await tick();

      const crew = broker.getCrew(code);
      expect(crew).toBeDefined();
      const daemon = crew!.daemons.get("d1");
      expect(daemon).toBeDefined();
      expect(daemon!.operatorId).toBe("dev@example.com");
      ws.close();
    });

    it("defaults operatorId to empty string when not provided", async () => {
      const { broker, port } = startBroker();
      const code = await createCrew(port);

      const ws = await connectWs(port, code, "d2", "worker-2");
      await tick();

      const crew = broker.getCrew(code);
      const daemon = crew!.daemons.get("d2");
      expect(daemon).toBeDefined();
      expect(daemon!.operatorId).toBe("");
      ws.close();
    });
  });

  describe("sync and claim with author affinity", () => {
    it("assigns author-matched items to the daemon with matching operatorId", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1", "alice@example.com");
      const ws2 = await connectWs(port, code, "d2", "worker-2", "bob@example.com");

      // d1 syncs items authored by alice and bob
      await sendSync(ws1, "d1", ["todo-A", "todo-B"], {
        "todo-A": { author: "alice@example.com" },
        "todo-B": { author: "bob@example.com" },
      });

      // d1 (alice) claims -- should prefer alice-authored item (author affinity)
      const claim1 = await sendClaim(ws1, "d1");
      expect(claim1.todoId).toBe("todo-A");

      // d2 (bob) claims -- should get bob-authored item
      const claim2 = await sendClaim(ws2, "d2");
      expect(claim2.todoId).toBe("todo-B");

      ws1.close();
      ws2.close();
    });

    it("falls back to pool scheduling when author-matched items are exhausted", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1", "alice@example.com");

      // Sync two items: one by alice, one by bob
      await sendSync(ws1, "d1", ["todo-alice", "todo-bob"], {
        "todo-alice": { author: "alice@example.com" },
        "todo-bob": { author: "bob@example.com" },
      });

      // d1 claims -- should get alice's item first (author affinity)
      const claim1 = await sendClaim(ws1, "d1");
      expect(claim1.todoId).toBe("todo-alice");

      // d1 claims again -- should fall back to bob's item (pool)
      const claim2 = await sendClaim(ws1, "d1");
      expect(claim2.todoId).toBe("todo-bob");

      ws1.close();
    });

    it("uses pool scheduling when daemon has no operatorId", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);

      // No operatorId -- defaults to ""
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["todo-A", "todo-B"], {
        "todo-A": { author: "alice@example.com", priority: 2 },
        "todo-B": { author: "bob@example.com", priority: 1 },
      });

      // No operatorId means no author affinity -- should sort by priority
      const claim1 = await sendClaim(ws, "d1");
      expect(claim1.todoId).toBe("todo-B"); // priority 1 < 2

      ws.close();
    });

    it("respects priority ordering (lower number = higher priority)", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      // Sync with explicit priorities: high-pri=0, med-pri=2, low-pri=3
      await sendSync(ws, "d1", ["low-pri", "high-pri", "med-pri"], {
        "low-pri": { priority: 3 },
        "high-pri": { priority: 0 },
        "med-pri": { priority: 2 },
      });

      // Claim order should be by priority: 0 (high), 2 (med), 3 (low)
      const claim1 = await sendClaim(ws, "d1");
      expect(claim1.todoId).toBe("high-pri");

      const claim2 = await sendClaim(ws, "d1");
      expect(claim2.todoId).toBe("med-pri");

      const claim3 = await sendClaim(ws, "d1");
      expect(claim3.todoId).toBe("low-pri");

      ws.close();
    });

    it("returns null itemId when all items are claimed", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["todo-A"]);

      // Claim the only item
      const claim1 = await sendClaim(ws, "d1");
      expect(claim1.todoId).toBe("todo-A");

      // Try again -- should get null (no work)
      const claim2 = await sendClaim(ws, "d1");
      expect(claim2.todoId).toBeNull();

      ws.close();
    });
  });

  describe("no duplicate claims", () => {
    it("10 items across 2 clients yields zero overlap", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");

      // d1 syncs 5 items, d2 syncs 5 items
      const d1ItemIds = Array.from({ length: 5 }, (_, i) => `d1-todo-${i}`);
      const d2ItemIds = Array.from({ length: 5 }, (_, i) => `d2-todo-${i}`);

      await sendSync(ws1, "d1", d1ItemIds);
      await sendSync(ws2, "d2", d2ItemIds);

      const d1Claims: string[] = [];
      const d2Claims: string[] = [];

      // Alternate claims between the two daemons
      for (let i = 0; i < 5; i++) {
        const c1 = await sendClaim(ws1, "d1");
        if (c1.todoId) d1Claims.push(c1.todoId);

        const c2 = await sendClaim(ws2, "d2");
        if (c2.todoId) d2Claims.push(c2.todoId);
      }

      // Verify zero overlap
      const allClaims = [...d1Claims, ...d2Claims];
      const uniqueClaims = new Set(allClaims);
      expect(uniqueClaims.size).toBe(allClaims.length);
      expect(allClaims.length).toBe(10);

      ws1.close();
      ws2.close();
    });
  });

  describe("complete", () => {
    it("marks an item as completed and allows new claims", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["todo-A"]);

      // Claim it
      const claim = await sendClaim(ws, "d1");
      expect(claim.todoId).toBe("todo-A");

      // Complete it
      const ack = await sendComplete(ws, "d1", "todo-A");
      expect(ack.type).toBe("complete_ack");
      expect((ack as any).todoId).toBe("todo-A");

      // Completed item should not be available for claim
      const noWork = await sendClaim(ws, "d1");
      expect(noWork.todoId).toBeNull();

      ws.close();
    });
  });

  describe("disconnect and release", () => {
    it("releases items after heartbeat timeout + grace period", async () => {
      // Use very short timeouts for testing
      const { port, broker } = startBroker({
        heartbeatTimeoutMs: 100,
        gracePeriodMs: 100,
      });
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");

      // d1 syncs and claims an item
      await sendSync(ws1, "d1", ["todo-A"]);
      const claimed = await sendClaim(ws1, "d1");
      expect(claimed.todoId).toBe("todo-A");

      // d2 syncs so it exists in the crew
      await sendSync(ws2, "d2", []);

      // d1 disconnects
      ws1.close();

      // Wait for heartbeat timeout (100ms) + grace period (100ms) + buffer
      await tick(350);

      // d2 should now be able to claim the released item
      const reClaim = await sendClaim(ws2, "d2");
      expect(reClaim.todoId).toBe("todo-A");

      ws2.close();
    });

    it("does NOT release items during grace period", async () => {
      const { port } = startBroker({
        heartbeatTimeoutMs: 50,
        gracePeriodMs: 5000, // long grace period
      });
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");

      await sendSync(ws1, "d1", ["todo-A"]);
      await sendClaim(ws1, "d1");

      await sendSync(ws2, "d2", []);

      // d1 disconnects
      ws1.close();

      // Wait past heartbeat timeout but within grace period
      await tick(200);

      // d2 should NOT be able to claim (still in grace period)
      const noWork = await sendClaim(ws2, "d2");
      expect(noWork.todoId).toBeNull();

      ws2.close();
    });
  });

  describe("reconnect", () => {
    it("sends reconnect_state with correct resumed/released lists", async () => {
      const { port, broker } = startBroker({
        heartbeatTimeoutMs: 50,
        gracePeriodMs: 50,
      });
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1");

      // Sync and claim 2 items
      await sendSync(ws1, "d1", ["todo-A", "todo-B"]);
      await sendClaim(ws1, "d1");
      await sendClaim(ws1, "d1");

      // Disconnect d1
      ws1.close();

      // Wait for grace period to expire
      await tick(250);

      // Connect d2 and claim one of the released items
      const ws2 = await connectWs(port, code, "d2", "worker-2");
      const d2Claim = await sendClaim(ws2, "d2");
      expect(d2Claim.todoId).toBeTruthy();
      const reclaimedPath = d2Claim.todoId!;

      // Reconnect d1 -- should get reconnect_state
      const ws1b = await connectWs(port, code, "d1", "worker-1");
      const state = await waitForMessage<{
        type: string;
        resumed: string[];
        released: string[];
        reclaimed: string[];
      }>(ws1b);

      expect(state.type).toBe("reconnect_state");
      // Both items were released (grace expired), one was reclaimed by d2
      expect(state.reclaimed).toContain(reclaimedPath);
      // The other should be in released
      const otherPath = reclaimedPath === "todo-A" ? "todo-B" : "todo-A";
      expect(state.released).toContain(otherPath);
      // Nothing should be still resumed by d1
      expect(state.resumed).toHaveLength(0);

      ws1b.close();
      ws2.close();
    });

    it("reconnect during grace period preserves claims", async () => {
      const { port } = startBroker({
        heartbeatTimeoutMs: 50,
        gracePeriodMs: 5000, // long grace
      });
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws1, "d1", ["todo-A"]);
      await sendClaim(ws1, "d1");

      // Disconnect
      ws1.close();
      await tick(100); // past heartbeat timeout but within grace

      // Reconnect with same daemonId
      const ws1b = await connectWs(port, code, "d1", "worker-1");
      const state = await waitForMessage<{
        type: string;
        resumed: string[];
        released: string[];
        reclaimed: string[];
      }>(ws1b);

      expect(state.type).toBe("reconnect_state");
      expect(state.resumed).toContain("todo-A");
      expect(state.released).toHaveLength(0);
      expect(state.reclaimed).toHaveLength(0);

      ws1b.close();
    });
  });

  describe("JSONL event log", () => {
    it("contains correct entries for all event types", async () => {
      const { port, eventLogPath, broker } = startBroker({
        heartbeatTimeoutMs: 50,
        gracePeriodMs: 50,
      });
      const code = await createCrew(port);

      // Connect and sync
      const ws1 = await connectWs(port, code, "d1", "worker-1");
      await sendSync(ws1, "d1", ["todo-A"]);

      // Claim
      await sendClaim(ws1, "d1");

      // Complete
      await sendComplete(ws1, "d1", "todo-A");

      // Sync another item
      await sendSync(ws1, "d1", ["todo-B"]);

      // Claim and then disconnect
      await sendClaim(ws1, "d1");
      ws1.close();

      // Wait for disconnect + grace period + abandon
      await tick(250);

      // Reconnect
      const ws1b = await connectWs(port, code, "d1", "worker-1");
      await waitForMessage(ws1b); // reconnect_state
      ws1b.close();
      await tick(100);

      const events = readEventLog(eventLogPath);

      // Verify event types present
      const eventTypes = events.map((e) => e.event);
      expect(eventTypes).toContain("sync");
      expect(eventTypes).toContain("claim");
      expect(eventTypes).toContain("complete");
      expect(eventTypes).toContain("disconnect");
      expect(eventTypes).toContain("abandon");
      expect(eventTypes).toContain("reconnect");

      // Verify D1 schema fields on every event
      for (const event of events) {
        expect(event).toHaveProperty("ts");
        expect(event).toHaveProperty("crew_id");
        expect(event).toHaveProperty("daemon_id");
        expect(event).toHaveProperty("event");
        expect(event).toHaveProperty("todo_path");
        expect(event).toHaveProperty("metadata");
        // Validate ts is ISO format
        expect(new Date(event.ts).toISOString()).toBe(event.ts);
        expect(event.crew_id).toBe(code);
      }

      // Verify claim events have affinity metadata
      const claimEvents = events.filter((e) => e.event === "claim");
      expect(claimEvents.length).toBeGreaterThan(0);
      for (const ce of claimEvents) {
        expect(["author", "pool"]).toContain((ce.metadata as { affinity: string }).affinity);
      }

      // Verify sync events have affinity metadata
      const syncEvents = events.filter((e) => e.event === "sync");
      expect(syncEvents.length).toBeGreaterThan(0);
      for (const se of syncEvents) {
        expect((se.metadata as { affinity: string }).affinity).toBe("author");
      }
    });
  });

  describe("heartbeat", () => {
    it("keeps daemon alive when heartbeats are sent", async () => {
      const { port } = startBroker({
        heartbeatTimeoutMs: 200,
        gracePeriodMs: 100,
      });
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");

      await sendSync(ws1, "d1", ["todo-A"]);
      await sendClaim(ws1, "d1");

      await sendSync(ws2, "d2", []);

      // Send heartbeats to keep d1 alive past the timeout
      for (let i = 0; i < 3; i++) {
        await tick(80);
        ws1.send(JSON.stringify({ type: "heartbeat", daemonId: "d1", ts: new Date().toISOString() }));
      }

      // d2 should not be able to claim (d1 is still alive)
      const result = await sendClaim(ws2, "d2");
      expect(result.todoId).toBeNull();

      ws1.close();
      ws2.close();
    });
  });

  describe("enriched sync metadata", () => {
    it("stores dependencies, priority, and author from sync payload", async () => {
      const { port, broker } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["todo-A", "todo-B"], {
        "todo-A": { dependencies: ["todo-B"], priority: 0, author: "alice@example.com" },
        "todo-B": { dependencies: [], priority: 2, author: "bob@example.com" },
      });

      const crew = broker.getCrew(code);
      expect(crew).toBeDefined();

      const itemA = crew!.items.get("todo-A");
      expect(itemA).toBeDefined();
      expect(itemA!.dependencies).toEqual(["todo-B"]);
      expect(itemA!.priority).toBe(0);
      expect(itemA!.author).toBe("alice@example.com");

      const itemB = crew!.items.get("todo-B");
      expect(itemB).toBeDefined();
      expect(itemB!.dependencies).toEqual([]);
      expect(itemB!.priority).toBe(2);
      expect(itemB!.author).toBe("bob@example.com");

      ws.close();
    });

    it("re-sync with updated priority/deps updates the existing WorkEntry (idempotent upsert)", async () => {
      const { port, broker } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      // First sync: priority 2, no deps
      await sendSync(ws, "d1", ["todo-A"], {
        "todo-A": { dependencies: [], priority: 2, author: "alice@example.com" },
      });

      const crew = broker.getCrew(code);
      const itemAfterFirst = crew!.items.get("todo-A");
      expect(itemAfterFirst!.priority).toBe(2);
      expect(itemAfterFirst!.dependencies).toEqual([]);
      expect(itemAfterFirst!.author).toBe("alice@example.com");
      const originalSyncedAt = itemAfterFirst!.syncedAt;

      // Re-sync with updated priority, deps, and author
      await sendSync(ws, "d1", ["todo-A"], {
        "todo-A": { dependencies: ["todo-B"], priority: 0, author: "bob@example.com" },
      });

      const itemAfterSecond = crew!.items.get("todo-A");
      expect(itemAfterSecond!.priority).toBe(0);
      expect(itemAfterSecond!.dependencies).toEqual(["todo-B"]);
      expect(itemAfterSecond!.author).toBe("bob@example.com");
      // creatorDaemonId and syncedAt should not change on upsert
      expect(itemAfterSecond!.creatorDaemonId).toBe("d1");
      expect(itemAfterSecond!.syncedAt).toBe(originalSyncedAt);

      ws.close();
    });

    it("sync with empty dependencies array stores [], not undefined", async () => {
      const { port, broker } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["todo-A"], {
        "todo-A": { dependencies: [], priority: 1, author: "" },
      });

      const crew = broker.getCrew(code);
      const wi = crew!.items.get("todo-A");
      expect(wi).toBeDefined();
      expect(wi!.dependencies).toEqual([]);
      expect(Array.isArray(wi!.dependencies)).toBe(true);

      ws.close();
    });
  });

  describe("dependency filtering", () => {
    it("filters out items with unresolved dependencies", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      // todo-B depends on todo-A; todo-A has no dependencies
      await sendSync(ws, "d1", ["todo-A", "todo-B"], {
        "todo-A": { dependencies: [] },
        "todo-B": { dependencies: ["todo-A"] },
      });

      // Only todo-A should be claimable (todo-B has unresolved dep)
      const claim1 = await sendClaim(ws, "d1");
      expect(claim1.todoId).toBe("todo-A");

      // todo-B still blocked -- A is claimed but not completed
      const claim2 = await sendClaim(ws, "d1");
      expect(claim2.todoId).toBeNull();

      ws.close();
    });

    it("unblocks dependent items after dependency is completed", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["todo-A", "todo-B"], {
        "todo-A": { dependencies: [] },
        "todo-B": { dependencies: ["todo-A"] },
      });

      // Claim and complete todo-A
      const claim1 = await sendClaim(ws, "d1");
      expect(claim1.todoId).toBe("todo-A");
      await sendComplete(ws, "d1", "todo-A");

      // Now todo-B should be claimable
      const claim2 = await sendClaim(ws, "d1");
      expect(claim2.todoId).toBe("todo-B");

      ws.close();
    });

    it("treats dependencies not in the broker map as unresolved", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      // todo-A depends on "unknown-item" which is not synced
      await sendSync(ws, "d1", ["todo-A"], {
        "todo-A": { dependencies: ["unknown-item"] },
      });

      // Should not be claimable
      const claim = await sendClaim(ws, "d1");
      expect(claim.todoId).toBeNull();

      ws.close();
    });

    it("handles circular dependencies -- neither item is claimable", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      // A depends on B, B depends on A -- circular
      await sendSync(ws, "d1", ["todo-A", "todo-B"], {
        "todo-A": { dependencies: ["todo-B"] },
        "todo-B": { dependencies: ["todo-A"] },
      });

      // Neither should be claimable
      const claim = await sendClaim(ws, "d1");
      expect(claim.todoId).toBeNull();

      ws.close();
    });

    it("handles multi-level dependency chains", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      // C depends on B, B depends on A
      await sendSync(ws, "d1", ["todo-A", "todo-B", "todo-C"], {
        "todo-A": { dependencies: [] },
        "todo-B": { dependencies: ["todo-A"] },
        "todo-C": { dependencies: ["todo-B"] },
      });

      // Only A is claimable initially
      const claim1 = await sendClaim(ws, "d1");
      expect(claim1.todoId).toBe("todo-A");
      await sendComplete(ws, "d1", "todo-A");

      // Now B is claimable (A completed), but C is still blocked (B not completed)
      const claim2 = await sendClaim(ws, "d1");
      expect(claim2.todoId).toBe("todo-B");

      const claim3 = await sendClaim(ws, "d1");
      expect(claim3.todoId).toBeNull(); // C still blocked

      await sendComplete(ws, "d1", "todo-B");

      // Now C is claimable
      const claim4 = await sendClaim(ws, "d1");
      expect(claim4.todoId).toBe("todo-C");

      ws.close();
    });
  });

  describe("dependency filtering + author affinity combined", () => {
    it("author-affinity items with unresolved deps are still filtered out", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1", "alice@example.com");

      // todo-A: authored by alice, depends on todo-C (unresolved)
      // todo-B: authored by someone else, no deps
      await sendSync(ws, "d1", ["todo-A", "todo-B", "todo-C"], {
        "todo-A": { author: "alice@example.com", dependencies: ["todo-C"], priority: 0 },
        "todo-B": { author: "bob@example.com", dependencies: [], priority: 1 },
        "todo-C": { author: "alice@example.com", dependencies: [], priority: 2 },
      });

      // Despite alice-authored todo-A having highest priority, it's blocked by dep
      // d1 should get todo-C (alice-authored, no deps) first due to author affinity
      const claim1 = await sendClaim(ws, "d1");
      expect(claim1.todoId).toBe("todo-C");

      // Next: todo-B (only remaining unblocked item, pool)
      const claim2 = await sendClaim(ws, "d1");
      expect(claim2.todoId).toBe("todo-B");

      // todo-A still blocked (todo-C claimed but not completed)
      const claim3 = await sendClaim(ws, "d1");
      expect(claim3.todoId).toBeNull();

      // Complete todo-C, now todo-A is unblocked
      await sendComplete(ws, "d1", "todo-C");
      const claim4 = await sendClaim(ws, "d1");
      expect(claim4.todoId).toBe("todo-A");

      ws.close();
    });
  });

  describe("schedule claim", () => {
    /** Send schedule_claim and wait for schedule_claim_response. */
    async function sendScheduleClaim(
      ws: WebSocket,
      daemonId: string,
      taskId: string,
      scheduleTime: string,
    ): Promise<{ granted: boolean; requestId: string; taskId: string }> {
      const requestId = `req-sc-${Math.random().toString(36).slice(2, 8)}`;
      ws.send(JSON.stringify({ type: "schedule_claim", requestId, daemonId, taskId, scheduleTime }));
      const resp = await waitForMessageByType<{
        type: string;
        requestId: string;
        taskId: string;
        granted: boolean;
      }>(ws, "schedule_claim_response");
      return { granted: resp.granted, requestId: resp.requestId, taskId: resp.taskId };
    }

    it("first daemon claims schedule -> granted", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws1 = await connectWs(port, code, "d1", "worker-1");
      await sendSync(ws1, "d1", []);

      const result = await sendScheduleClaim(ws1, "d1", "daily-test", "2026-03-28T10:00:00.000Z");
      expect(result.granted).toBe(true);
      expect(result.taskId).toBe("daily-test");

      ws1.close();
    });

    it("second daemon claims same key -> denied", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");
      await sendSync(ws1, "d1", []);
      await sendSync(ws2, "d2", []);

      // d1 claims first
      const r1 = await sendScheduleClaim(ws1, "d1", "daily-test", "2026-03-28T10:00:00.000Z");
      expect(r1.granted).toBe(true);

      // d2 claims same key -> denied
      const r2 = await sendScheduleClaim(ws2, "d2", "daily-test", "2026-03-28T10:00:00.000Z");
      expect(r2.granted).toBe(false);

      ws1.close();
      ws2.close();
    });

    it("different schedule times are independent keys", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");
      await sendSync(ws1, "d1", []);
      await sendSync(ws2, "d2", []);

      const r1 = await sendScheduleClaim(ws1, "d1", "daily-test", "2026-03-28T10:00:00.000Z");
      expect(r1.granted).toBe(true);

      // Different schedule time -- different key, should be granted
      const r2 = await sendScheduleClaim(ws2, "d2", "daily-test", "2026-03-28T11:00:00.000Z");
      expect(r2.granted).toBe(true);

      ws1.close();
      ws2.close();
    });

    it("claim key expires after timeout -> re-claimable", async () => {
      // Use a broker with fast check interval to observe expiry
      const { port, broker } = startBroker({ checkIntervalMs: 50 });
      const code = await createCrew(port);
      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");
      await sendSync(ws1, "d1", []);
      await sendSync(ws2, "d2", []);

      // d1 claims
      const r1 = await sendScheduleClaim(ws1, "d1", "daily-test", "2026-03-28T10:00:00.000Z");
      expect(r1.granted).toBe(true);

      // Manually expire the claim by setting expiresAt in the past
      const crew = broker.getCrew(code);
      const entry = crew!.scheduleClaims.get("daily-test:2026-03-28T10:00:00.000Z");
      expect(entry).toBeDefined();
      entry!.expiresAt = Date.now() - 1;

      // Wait for cleanup cycle
      await tick(100);

      // d2 should now be able to claim the same key
      const r2 = await sendScheduleClaim(ws2, "d2", "daily-test", "2026-03-28T10:00:00.000Z");
      expect(r2.granted).toBe(true);

      ws1.close();
      ws2.close();
    });

    it("different task IDs at same time are independent", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");
      await sendSync(ws1, "d1", []);
      await sendSync(ws2, "d2", []);

      const r1 = await sendScheduleClaim(ws1, "d1", "task-a", "2026-03-28T10:00:00.000Z");
      expect(r1.granted).toBe(true);

      // Different task ID -- independent key
      const r2 = await sendScheduleClaim(ws2, "d2", "task-b", "2026-03-28T10:00:00.000Z");
      expect(r2.granted).toBe(true);

      ws1.close();
      ws2.close();
    });

    it("schedule_claim events are logged", async () => {
      const { port, eventLogPath } = startBroker();
      const code = await createCrew(port);
      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");
      await sendSync(ws1, "d1", []);
      await sendSync(ws2, "d2", []);

      await sendScheduleClaim(ws1, "d1", "daily-test", "2026-03-28T10:00:00.000Z");
      await sendScheduleClaim(ws2, "d2", "daily-test", "2026-03-28T10:00:00.000Z");

      await tick(50);

      const events = readEventLog(eventLogPath);
      const scEvents = events.filter((e) => e.event === "schedule_claim");
      expect(scEvents).toHaveLength(2);

      // First should be granted, second denied
      expect((scEvents[0]!.metadata as { granted: boolean }).granted).toBe(true);
      expect((scEvents[1]!.metadata as { granted: boolean }).granted).toBe(false);

      ws1.close();
      ws2.close();
    });
  });

  describe("edge cases", () => {
    it("ignores duplicate syncs of the same path (preserves creator)", async () => {
      const { port, broker } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["todo-A"]);

      // Sync same path again from different daemon -- should not overwrite creatorDaemonId
      const ws2 = await connectWs(port, code, "d2", "worker-2");
      await sendSync(ws2, "d2", ["todo-A"]);

      // Creator should still be d1
      const crew = broker.getCrew(code);
      expect(crew).toBeDefined();
      const wi = crew!.items.get("todo-A");
      expect(wi).toBeDefined();
      expect(wi!.creatorDaemonId).toBe("d1");

      ws.close();
      ws2.close();
    });

    it("returns error for completing unclaimed item", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["todo-A"]);

      // Try to complete without claiming
      const result = await sendComplete(ws, "d1", "todo-A");
      expect(result.type).toBe("error");

      ws.close();
    });

    it("handles invalid JSON gracefully", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      ws.send("not json at all");
      const err = await waitForMessage<{ type: string; message: string }>(ws);
      expect(err.type).toBe("error");
      expect(err.message).toBe("Invalid JSON");

      ws.close();
    });
  });
});
