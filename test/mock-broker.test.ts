// Tests for the mock crew coordination broker.
// Covers: crew creation, WebSocket protocol, creator affinity scheduling,
// duplicate claim prevention, disconnect/release/reconnect, and JSONL logging.

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
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${port}/api/crews/${crewCode}/ws?daemonId=${daemonId}&name=${name}`,
    );
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

/** Send sync and wait for sync_ack. */
async function sendSync(ws: WebSocket, daemonId: string, todoIds: string[]): Promise<void> {
  ws.send(JSON.stringify({ type: "sync", daemonId, activeItemIds: todoIds }));
  await waitForMessageByType(ws, "sync_ack");
}

/** Send claim and wait for claim_response. Returns todoId or null. */
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
        // Expected — the upgrade should fail
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
  });

  describe("sync and claim with creator affinity", () => {
    it("assigns creator-synced TODOs back to the creator", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");

      // d1 syncs TODO-A and TODO-B
      await sendSync(ws1, "d1", ["todo-A", "todo-B"]);

      // d2 syncs TODO-C and TODO-D
      await sendSync(ws2, "d2", ["todo-C", "todo-D"]);

      // d1 claims — should get its own TODO first (creator affinity)
      const claim1 = await sendClaim(ws1, "d1");
      expect(["todo-A", "todo-B"]).toContain(claim1.todoId);

      // d2 claims — should get its own TODO first
      const claim2 = await sendClaim(ws2, "d2");
      expect(["todo-C", "todo-D"]).toContain(claim2.todoId);

      ws1.close();
      ws2.close();
    });

    it("falls back to pool scheduling when creator TODOs are exhausted", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");

      // d1 syncs 1 TODO
      await sendSync(ws1, "d1", ["todo-A"]);

      // d2 syncs 1 TODO
      await sendSync(ws2, "d2", ["todo-B"]);

      // d1 claims its own TODO
      const claim1 = await sendClaim(ws1, "d1");
      expect(claim1.todoId).toBe("todo-A");

      // d1 claims again — should get todo-B from pool
      const claim2 = await sendClaim(ws1, "d1");
      expect(claim2.todoId).toBe("todo-B");

      ws1.close();
      ws2.close();
    });

    it("respects priority ordering (lower number = higher priority)", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      // Sync all TODOs (priority comes from default; order is stable by syncedAt)
      await sendSync(ws, "d1", ["low-pri", "high-pri", "med-pri"]);

      // All have same default priority (1), so claim order is by syncedAt (insertion order)
      const claim1 = await sendClaim(ws, "d1");
      expect(claim1.todoId).toBe("low-pri");

      const claim2 = await sendClaim(ws, "d1");
      expect(claim2.todoId).toBe("high-pri");

      const claim3 = await sendClaim(ws, "d1");
      expect(claim3.todoId).toBe("med-pri");

      ws.close();
    });

    it("returns null todoId when all TODOs are claimed", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["todo-A"]);

      // Claim the only TODO
      const claim1 = await sendClaim(ws, "d1");
      expect(claim1.todoId).toBe("todo-A");

      // Try again — should get null (no work)
      const claim2 = await sendClaim(ws, "d1");
      expect(claim2.todoId).toBeNull();

      ws.close();
    });
  });

  describe("no duplicate claims", () => {
    it("10 TODOs across 2 clients yields zero overlap", async () => {
      const { port } = startBroker();
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");

      // d1 syncs 5 TODOs, d2 syncs 5 TODOs
      const d1TodoIds = Array.from({ length: 5 }, (_, i) => `d1-todo-${i}`);
      const d2TodoIds = Array.from({ length: 5 }, (_, i) => `d2-todo-${i}`);

      await sendSync(ws1, "d1", d1TodoIds);
      await sendSync(ws2, "d2", d2TodoIds);

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
    it("marks a TODO as completed and allows new claims", async () => {
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

      // Completed TODO should not be available for claim
      const noWork = await sendClaim(ws, "d1");
      expect(noWork.todoId).toBeNull();

      ws.close();
    });
  });

  describe("disconnect and release", () => {
    it("releases TODOs after heartbeat timeout + grace period", async () => {
      // Use very short timeouts for testing
      const { port, broker } = startBroker({
        heartbeatTimeoutMs: 100,
        gracePeriodMs: 100,
      });
      const code = await createCrew(port);

      const ws1 = await connectWs(port, code, "d1", "worker-1");
      const ws2 = await connectWs(port, code, "d2", "worker-2");

      // d1 syncs and claims a TODO
      await sendSync(ws1, "d1", ["todo-A"]);
      const claimed = await sendClaim(ws1, "d1");
      expect(claimed.todoId).toBe("todo-A");

      // d2 syncs so it exists in the crew
      await sendSync(ws2, "d2", []);

      // d1 disconnects
      ws1.close();

      // Wait for heartbeat timeout (100ms) + grace period (100ms) + buffer
      await tick(350);

      // d2 should now be able to claim the released TODO
      const reClaim = await sendClaim(ws2, "d2");
      expect(reClaim.todoId).toBe("todo-A");

      ws2.close();
    });

    it("does NOT release TODOs during grace period", async () => {
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

      // Sync and claim 2 TODOs
      await sendSync(ws1, "d1", ["todo-A", "todo-B"]);
      await sendClaim(ws1, "d1");
      await sendClaim(ws1, "d1");

      // Disconnect d1
      ws1.close();

      // Wait for grace period to expire
      await tick(250);

      // Connect d2 and claim one of the released TODOs
      const ws2 = await connectWs(port, code, "d2", "worker-2");
      const d2Claim = await sendClaim(ws2, "d2");
      expect(d2Claim.todoId).toBeTruthy();
      const reclaimedPath = d2Claim.todoId!;

      // Reconnect d1 — should get reconnect_state
      const ws1b = await connectWs(port, code, "d1", "worker-1");
      const state = await waitForMessage<{
        type: string;
        resumed: string[];
        released: string[];
        reclaimed: string[];
      }>(ws1b);

      expect(state.type).toBe("reconnect_state");
      // Both TODOs were released (grace expired), one was reclaimed by d2
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

      // Sync another TODO
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
        expect(["creator", "pool"]).toContain((ce.metadata as { affinity: string }).affinity);
      }

      // Verify sync events have affinity metadata
      const syncEvents = events.filter((e) => e.event === "sync");
      expect(syncEvents.length).toBeGreaterThan(0);
      for (const se of syncEvents) {
        expect((se.metadata as { affinity: string }).affinity).toBe("creator");
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

  describe("edge cases", () => {
    it("ignores duplicate syncs of the same path", async () => {
      const { port, broker } = startBroker();
      const code = await createCrew(port);
      const ws = await connectWs(port, code, "d1", "worker-1");

      await sendSync(ws, "d1", ["todo-A"]);

      // Sync same path again from different daemon — should not overwrite
      const ws2 = await connectWs(port, code, "d2", "worker-2");
      await sendSync(ws2, "d2", ["todo-A"]);

      // Creator should still be d1
      const crew = broker.getCrew(code);
      expect(crew).toBeDefined();
      const todo = crew!.items.get("todo-A");
      expect(todo).toBeDefined();
      expect(todo!.creatorDaemonId).toBe("d1");

      ws.close();
      ws2.close();
    });

    it("returns error for completing unclaimed TODO", async () => {
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
