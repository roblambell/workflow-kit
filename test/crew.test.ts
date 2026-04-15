// Tests for core/crew.ts -- CrewBroker interface, WebSocket client,
// daemonId persistence, claim timeout, reconnect reconciliation,
// and protocol error handling.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  WebSocketCrewBroker,
  getOrCreateDaemonId,
  daemonIdPath,
  type CrewBrokerDeps,
  type ReconnectState,
  type ClientMessage,
  type ServerMessage,
} from "../core/crew.ts";
import { hashRepoUrl } from "../core/repo-ref.ts";
import { makeBrokerHasher } from "../core/broker-hash.ts";

/**
 * Deterministic 32-byte test secret in canonical base64 form (as accepted by
 * `makeBrokerHasher`). Used by WebSocketCrewBroker constructors throughout
 * the suite; tests do not care which secret is used, only that one is valid.
 */
const TEST_BROKER_SECRET = Buffer.alloc(32, 1).toString("base64");

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a temp dir that mimics a project root (daemon-id goes in ~/.ninthwave/projects/<slug>). */
function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "crew-test-"));
}

/** Simple log collector for deps. */
function createLogCollector(): {
  logs: { level: string; msg: string }[];
  log: (level: "info" | "warn" | "error", msg: string) => void;
} {
  const logs: { level: string; msg: string }[] = [];
  return {
    logs,
    log: (level, msg) => logs.push({ level, msg }),
  };
}

/**
 * Start a minimal Bun WebSocket server for testing.
 * Returns the server and a helper to send messages to connected clients.
 */
function startTestServer(opts?: {
  /** Handler called when a client message is received. */
  onMessage?: (ws: any, msg: ClientMessage) => void;
  /** If set, automatically send this on client connection. */
  autoReply?: ServerMessage;
  /** If set, delay sync_ack by this many ms. */
  syncAckDelayMs?: number;
  /** Override the default sync_ack payload. */
  syncAck?: ServerMessage;
}): {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  clients: Set<any>;
  broadcast: (msg: ServerMessage) => void;
  sendTo: (ws: any, msg: ServerMessage) => void;
} {
  const clients = new Set<any>();
  // lint-ignore: no-leaked-server
  const server = Bun.serve({
    port: 0, // random available port
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname.includes("/api/crews/") && url.pathname.endsWith("/ws")) {
        const upgraded = server.upgrade(req);
        if (upgraded) return undefined;
        return new Response("Upgrade failed", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws: any) {
        clients.add(ws);
      },
      message(ws: any, raw: string | Buffer) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          return;
        }

        // Auto-reply with sync_ack on sync messages
        if (msg.type === "sync") {
          const reply: ServerMessage = opts?.syncAck ?? {
            type: "sync_ack",
            workItemIds: [],
          };
          if (opts?.syncAckDelayMs) {
            setTimeout(() => ws.send(JSON.stringify(reply)), opts.syncAckDelayMs);
          } else {
            ws.send(JSON.stringify(reply));
          }
        }

        if (opts?.onMessage) {
          opts.onMessage(ws, msg);
        }

        if (opts?.autoReply && msg.type !== "sync") {
          ws.send(JSON.stringify(opts.autoReply));
        }
      },
      close(ws: any) {
        clients.delete(ws);
      },
    },
  });

  return {
    server,
    port: server.port ?? 0,
    clients,
    broadcast: (msg) => {
      const data = JSON.stringify(msg);
      for (const ws of clients) ws.send(data);
    },
    sendTo: (ws, msg) => ws.send(JSON.stringify(msg)),
  };
}

// ── DaemonId persistence ────────────────────────────────────────────

describe("getOrCreateDaemonId", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempProject();
  });

  afterEach(() => {
    // Clean up the user state dir (which is based on the tempDir slug)
    const stateDir = daemonIdPath(tempDir);
    try {
      // Clean up the temp project dir
      rmSync(tempDir, { recursive: true, force: true });
      // Clean up the user state dir (under ~/.ninthwave/projects/...)
      const dirPath = join(stateDir, "..");
      rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("generates a UUID on first call", () => {
    const id = getOrCreateDaemonId(tempDir);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returns the same ID on second call (persistence)", () => {
    const id1 = getOrCreateDaemonId(tempDir);
    const id2 = getOrCreateDaemonId(tempDir);
    expect(id1).toBe(id2);
  });

  it("writes the ID to the daemon-id file", () => {
    const id = getOrCreateDaemonId(tempDir);
    const filePath = daemonIdPath(tempDir);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8").trim()).toBe(id);
  });

  it("reuses an existing daemon-id file", () => {
    const filePath = daemonIdPath(tempDir);
    const dir = join(filePath, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, "pre-existing-id", "utf-8");
    const id = getOrCreateDaemonId(tempDir);
    expect(id).toBe("pre-existing-id");
  });
});

// ── Connect/disconnect lifecycle ────────────────────────────────────

describe("WebSocketCrewBroker", () => {
  let server: ReturnType<typeof startTestServer>;
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempProject();
  });

  afterEach(() => {
    if (server?.server) server.server.stop();
    try {
      rmSync(tempDir, { recursive: true, force: true });
      const stateDir = daemonIdPath(tempDir);
      rmSync(join(stateDir, ".."), { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("connects and disconnects", async () => {
    server = startTestServer();
    const { log } = createLogCollector();
    const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${server.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
      log,
      heartbeatIntervalMs: 60_000, // don't fire during test
    });

    // Connect -- server auto-sends sync_ack on sync
    // But we need to trigger sync. The connect() resolves when sync_ack is received.
    // Let's make the server auto-reply sync_ack on open
    broker.disconnect();

    // Use a server that sends sync_ack right away
    server.server.stop();
    server = startTestServer();

    const broker2 = new WebSocketCrewBroker(tempDir, `ws://localhost:${server.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
      log,
      heartbeatIntervalMs: 60_000,
    });

    // We need to trigger sync after connect. The connect promise resolves on sync_ack.
    // The server auto-replies sync_ack when it receives a sync message.
    const connectPromise = broker2.connect();
    // Wait a tick for WS to open, then send sync
    await new Promise((r) => setTimeout(r, 50));
    broker2.sync([{ id: "H-TEST-1", dependencies: [], priority: 1, author: "" }]);
    await connectPromise;

    expect(broker2.isConnected()).toBe(true);
    broker2.disconnect();
    expect(broker2.isConnected()).toBe(false);
  });

  it("sends hashed daemonId, operatorId, and name query params on connect (no repoUrl)", async () => {
    let receivedDaemonId: string | null = null;
    let receivedRepoUrl: string | null = null;
    let receivedRepoHash: string | null = null;
    let receivedOperatorId: string | null = null;
    let receivedName: string | null = null;
    // lint-ignore: no-leaked-server
    const customServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname.includes("/ws")) {
          receivedDaemonId = url.searchParams.get("daemonId");
          receivedRepoUrl = url.searchParams.get("repoUrl");
          receivedRepoHash = url.searchParams.get("repoHash");
          receivedOperatorId = url.searchParams.get("operatorId");
          receivedName = url.searchParams.get("name");
          const upgraded = srv.upgrade(req);
          if (upgraded) return undefined;
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open() {},
        message(ws: any, raw: string | Buffer) {
          const msg = JSON.parse(String(raw));
          if (msg.type === "sync") {
            ws.send(JSON.stringify({ type: "sync_ack", workItemIds: [] }));
          }
        },
        close() {},
      },
    });

    try {
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${customServer.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
        log,
        heartbeatIntervalMs: 60_000,
      }, "machine-name");
      const connectPromise = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectPromise;

      const hash = makeBrokerHasher(TEST_BROKER_SECRET);
      // daemonId on the wire is the hashed local daemonId; cleartext never leaves.
      expect(receivedDaemonId).toBe(hash(broker.getDaemonId()));
      expect(receivedDaemonId).not.toBe(broker.getDaemonId());
      // name is hashed too.
      expect(receivedName).toBe(hash("machine-name"));
      // repoUrl / repoHash are intentionally absent under the anonymized protocol.
      expect(receivedRepoUrl).toBeNull();
      expect(receivedRepoHash).toBeNull();
      // operatorId may be empty (no git email in the test env) or hashed if present.
      const operator = broker.getOperatorId();
      expect(receivedOperatorId).toBe(operator === "" ? "" : hash(operator));
      broker.disconnect();
    } finally {
      customServer.stop();
    }
  });

  it("isConnected() returns false when WS drops, true after reconnect", async () => {
    server = startTestServer();
    const { log } = createLogCollector();
    const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${server.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
      log,
      reconnectIntervalMs: 100, // fast reconnect for test
      heartbeatIntervalMs: 60_000,
    });

    // Connect
    const connectP = broker.connect();
    await new Promise((r) => setTimeout(r, 50));
    broker.sync([]);
    await connectP;
    expect(broker.isConnected()).toBe(true);

    // Drop all server connections
    for (const ws of server.clients) {
      ws.close();
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(broker.isConnected()).toBe(false);

    // Wait for reconnect (100ms interval)
    // After reconnect the client connects but needs to send sync to get sync_ack
    await new Promise((r) => setTimeout(r, 200));
    // The reconnect doConnect() will wait for sync_ack; we need to manually sync
    // Actually the reconnect timer calls doConnect which creates a new WS. The server
    // auto-replies sync_ack when it gets a sync message. But the client doesn't auto-sync.
    // The connect promise will hang. Let's just verify it reconnected at the WS level.
    // The connected flag is set to true on ws.onopen.
    expect(broker.isConnected()).toBe(true);

    broker.disconnect();
  });

  // ── Claim with timeout ──────────────────────────────────────────

  describe("claim", () => {
    it("returns itemId on successful claim", async () => {
      // The client only recognizes hashed work item ids coming back from the
      // broker, so the mock server replies with the hash the client would
      // have generated for "H-TEST-1" and the client maps it back to the
      // local id before resolving the claim.
      const hashedTest1 = makeBrokerHasher(TEST_BROKER_SECRET)("H-TEST-1");
      server = startTestServer({
        onMessage: (ws, msg) => {
          if (msg.type === "claim") {
            ws.send(JSON.stringify({
              type: "claim_response",
              requestId: msg.requestId,
              workItemId: hashedTest1,
            }));
          }
        },
      });
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${server.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
        log,
        claimTimeoutMs: 2_000,
        heartbeatIntervalMs: 60_000,
      });

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      // Sync the id so the reverse map learns the hash → local mapping.
      broker.sync([{ id: "H-TEST-1", dependencies: [], priority: 1, author: "" }]);
      await connectP;

      const workItemId = await broker.claim();
      expect(workItemId).toBe("H-TEST-1");
      broker.disconnect();
    });

    it("returns null on claim with no available items", async () => {
      server = startTestServer({
        onMessage: (ws, msg) => {
          if (msg.type === "claim") {
            ws.send(JSON.stringify({
              type: "claim_response",
              requestId: msg.requestId,
              workItemId: null,
            }));
          }
        },
      });
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${server.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
        log,
        claimTimeoutMs: 2_000,
        heartbeatIntervalMs: 60_000,
      });

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectP;

      const workItemId = await broker.claim();
      expect(workItemId).toBeNull();
      broker.disconnect();
    });

    it("returns null when claim times out (server delays response)", async () => {
      // Server doesn't reply to claim at all
      server = startTestServer();
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${server.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
        log,
        claimTimeoutMs: 200, // 200ms timeout for fast test
        heartbeatIntervalMs: 60_000,
      });

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectP;

      const start = Date.now();
      const workItemId = await broker.claim();
      const elapsed = Date.now() - start;

      expect(workItemId).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(150); // close to 200ms
      expect(elapsed).toBeLessThan(1_000);
      broker.disconnect();
    });

    it("returns null when not connected", async () => {
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(tempDir, "ws://localhost:9999", "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
        log,
        heartbeatIntervalMs: 60_000,
      });
      // Never connected
      const workItemId = await broker.claim();
      expect(workItemId).toBeNull();
    });
  });

  // ── Protocol error handling ───────────────────────────────────────

  describe("protocol errors", () => {
    it("logs warning on unknown message type (does not crash)", async () => {
      server = startTestServer();
      const { logs, log } = createLogCollector();
      const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${server.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
        log,
        heartbeatIntervalMs: 60_000,
      });

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectP;

      // Server sends unknown message type
      for (const ws of server.clients) {
        ws.send(JSON.stringify({ type: "unknown_type", data: "test" }));
      }
      await new Promise((r) => setTimeout(r, 50));

      const warnLogs = logs.filter((l) => l.level === "warn" && l.msg.includes("Unknown message type"));
      expect(warnLogs.length).toBeGreaterThan(0);
      expect(broker.isConnected()).toBe(true); // still connected
      broker.disconnect();
    });

    it("logs warning on malformed JSON (does not crash)", async () => {
      server = startTestServer();
      const { logs, log } = createLogCollector();
      const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${server.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
        log,
        heartbeatIntervalMs: 60_000,
      });

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectP;

      // Server sends malformed JSON
      for (const ws of server.clients) {
        ws.send("not valid json {{{");
      }
      await new Promise((r) => setTimeout(r, 50));

      const warnLogs = logs.filter((l) => l.level === "warn" && l.msg.includes("Malformed JSON"));
      expect(warnLogs.length).toBeGreaterThan(0);
      expect(broker.isConnected()).toBe(true); // still connected
      broker.disconnect();
    });
  });

  // ── Reconnect reconciliation ──────────────────────────────────────

  describe("reconnect reconciliation", () => {
    it("handles reconnect_state with resumed/released/reclaimed items", async () => {
      let reconnectState: ReconnectState | null = null;

      // Track connections on server side so we can close them and detect reconnects
      const serverClients = new Set<any>();
      let syncCount = 0;
      // lint-ignore: no-leaked-server
      const customServer = Bun.serve({
        port: 0,
        fetch(req, srv) {
          const url = new URL(req.url);
          if (url.pathname.includes("/ws")) {
            const upgraded = srv.upgrade(req);
            if (upgraded) return undefined;
          }
          return new Response("Not found", { status: 404 });
        },
        websocket: {
          open(ws: any) {
            serverClients.add(ws);
          },
          message(ws: any, raw: string | Buffer) {
            const msg = JSON.parse(String(raw));
            if (msg.type === "sync") {
              syncCount++;
              if (syncCount <= 1) {
                // First sync: send sync_ack
                ws.send(JSON.stringify({ type: "sync_ack", workItemIds: [] }));
              } else {
                // Subsequent sync (reconnect): send reconnect_state
                ws.send(JSON.stringify({
                  type: "reconnect_state",
                  resumed: ["H-TEST-1"],
                  released: ["H-TEST-2"],
                  reclaimed: ["H-TEST-3"],
                }));
              }
            }
          },
          close(ws: any) {
            serverClients.delete(ws);
          },
        },
      });

      try {
        const { log } = createLogCollector();
        const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${customServer.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
          log,
          reconnectIntervalMs: 100,
          heartbeatIntervalMs: 60_000,
          onReconnect: (state) => {
            reconnectState = state;
          },
        });

        // First connect
        const connectP = broker.connect();
        await new Promise((r) => setTimeout(r, 50));
        broker.sync([]);
        await connectP;
        expect(broker.isConnected()).toBe(true);

        // Drop all connections from server side
        for (const ws of serverClients) {
          ws.close();
        }
        await new Promise((r) => setTimeout(r, 50));
        expect(broker.isConnected()).toBe(false);

        // Wait for reconnect (100ms interval) + WS open + send sync
        await new Promise((r) => setTimeout(r, 200));
        // After reconnect, ws.onopen fires → connected=true. Then we need sync for reconciliation.
        broker.sync([{ id: "H-TEST-1", dependencies: [], priority: 1, author: "" }]);
        await new Promise((r) => setTimeout(r, 100));

        expect(reconnectState).not.toBeNull();
        expect(reconnectState!.resumed).toEqual(["H-TEST-1"]);
        expect(reconnectState!.released).toEqual(["H-TEST-2"]);
        expect(reconnectState!.reclaimed).toEqual(["H-TEST-3"]);
        broker.disconnect();
      } finally {
        customServer.stop();
      }
    });
  });

  // ── Complete ───────────────────────────────────────────────────────

  describe("complete", () => {
    it("sends complete message to server", async () => {
      let receivedComplete: any = null;
      server = startTestServer({
        onMessage: (ws, msg) => {
          if (msg.type === "complete") {
            receivedComplete = msg;
            ws.send(JSON.stringify({ type: "complete_ack", workItemId: msg.workItemId }));
          }
        },
      });
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${server.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
        log,
        heartbeatIntervalMs: 60_000,
      });

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectP;

      broker.complete("H-TEST-1");
      await new Promise((r) => setTimeout(r, 50));

      const hash = makeBrokerHasher(TEST_BROKER_SECRET);
      expect(receivedComplete).not.toBeNull();
      // Wire carries hashed ids only; cleartext "H-TEST-1" must never appear.
      expect(receivedComplete.workItemId).toBe(hash("H-TEST-1"));
      expect(receivedComplete.daemonId).toBe(hash(broker.getDaemonId()));
      expect(JSON.stringify(receivedComplete)).not.toContain("H-TEST-1");
      broker.disconnect();
    });
  });

  // ── Heartbeat ──────────────────────────────────────────────────────

  describe("heartbeat", () => {
    it("sends heartbeat message", async () => {
      let receivedHeartbeat: any = null;
      server = startTestServer({
        onMessage: (ws, msg) => {
          if (msg.type === "heartbeat") {
            receivedHeartbeat = msg;
            ws.send(JSON.stringify({ type: "heartbeat_ack", ts: new Date().toISOString() }));
          }
        },
      });
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(tempDir, `ws://localhost:${server.port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET, {
        log,
        heartbeatIntervalMs: 60_000,
      });

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectP;

      broker.heartbeat();
      await new Promise((r) => setTimeout(r, 50));

      const hash = makeBrokerHasher(TEST_BROKER_SECRET);
      expect(receivedHeartbeat).not.toBeNull();
      expect(receivedHeartbeat.daemonId).toBe(hash(broker.getDaemonId()));
      expect(receivedHeartbeat.daemonId).not.toBe(broker.getDaemonId());
      expect(receivedHeartbeat.ts).toBeDefined();
      broker.disconnect();
    });
  });
});

// ── Report method ──────────────────────────────────────────────────

describe("report method", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "crew-report-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("report sends message for an active shared session", async () => {
    let receivedReport: any = null;
    const { server, port } = startTestServer({
      onMessage: (_ws, msg) => {
        if (msg.type === "report") {
          receivedReport = msg;
        }
      },
    });

    try {
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(
        tempDir, `ws://localhost:${port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET,
        { log, heartbeatIntervalMs: 60_000 },
        "test-daemon",
      );

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectP;

      broker.report("pr_opened", "test-item", { prNumber: 42, branch: "ninthwave/test-item" });
      await new Promise((r) => setTimeout(r, 50));

      const hash = makeBrokerHasher(TEST_BROKER_SECRET);
      expect(receivedReport).not.toBeNull();
      expect(receivedReport.type).toBe("report");
      // Event-name vocabulary is on the cleartext allowlist.
      expect(receivedReport.event).toBe("pr_opened");
      // Work item path is hashed before the wire.
      expect(receivedReport.workItemPath).toBe(hash("test-item"));
      // Numeric metadata survives cleartext; branch (a non-allowlisted string) is hashed.
      expect(receivedReport.metadata.prNumber).toBe(42);
      expect(receivedReport.metadata.branch).toBe(hash("ninthwave/test-item"));
      // Session id is hashed too -- no raw UUID on the wire.
      expect(receivedReport.sessionId).not.toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(receivedReport)).not.toContain("test-item");
      expect(JSON.stringify(receivedReport)).not.toContain("ninthwave/test-item");
      broker.disconnect();
    } finally {
      server.stop(true);
    }
  });

  it("includes model and tokenUsage when broker telemetry settings allow it", async () => {
    let receivedReport: any = null;
    const { server, port } = startTestServer({
      syncAck: {
        type: "sync_ack",
        workItemIds: [],
        telemetrySettings: { sendTokenUsage: true },
        privacySettings: { allowHostedRelay: false },
      },
      onMessage: (_ws, msg) => {
        if (msg.type === "report") {
          receivedReport = msg;
        }
      },
    });

    try {
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(
        tempDir, `ws://localhost:${port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET,
        { log, heartbeatIntervalMs: 60_000 },
        "test-daemon",
      );

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectP;

      broker.report(
        "complete",
        "test-item",
        { state: "done" },
        {
          model: "claude-sonnet-4-6",
          tokenUsage: { inputTokens: 100, outputTokens: 50, cacheTokens: 25 },
        },
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedReport.model).toBe("claude-sonnet-4-6");
      expect(receivedReport.tokenUsage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cacheTokens: 25,
      });
      broker.disconnect();
    } finally {
      server.stop(true);
    }
  });

  it("omits tokenUsage when broker telemetry settings do not allow it", async () => {
    let receivedReport: any = null;
    const { server, port } = startTestServer({
      onMessage: (_ws, msg) => {
        if (msg.type === "report") {
          receivedReport = msg;
        }
      },
    });

    try {
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(
        tempDir, `ws://localhost:${port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET,
        { log, heartbeatIntervalMs: 60_000 },
        "test-daemon",
      );

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectP;

      broker.report(
        "complete",
        "test-item",
        { state: "done" },
        {
          model: "claude-sonnet-4-6",
          tokenUsage: { inputTokens: 100, outputTokens: 50, cacheTokens: 25 },
        },
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedReport.model).toBe("claude-sonnet-4-6");
      expect(receivedReport).not.toHaveProperty("tokenUsage");
      broker.disconnect();
    } finally {
      server.stop(true);
    }
  });

  it("sends session_end before disconnecting", async () => {
    const receivedEvents: string[] = [];
    let sessionEndReport: any = null;
    const { server, port } = startTestServer({
      onMessage: (_ws, msg) => {
        if (msg.type === "report") {
          receivedEvents.push(msg.event);
          if (msg.event === "session_end") {
            sessionEndReport = msg;
          }
        }
      },
    });

    try {
      const { log } = createLogCollector();
      const broker = new WebSocketCrewBroker(
        tempDir, `ws://localhost:${port}`, "ABCD-EFGH-IJKL-MNOP", TEST_BROKER_SECRET,
        { log, heartbeatIntervalMs: 60_000 },
        "test-daemon",
      );

      const connectP = broker.connect();
      await new Promise((r) => setTimeout(r, 50));
      broker.sync([]);
      await connectP;

      broker.report("session_started", "test-item", { model: "claude-sonnet-4-6" }, { model: "claude-sonnet-4-6" });
      await new Promise((r) => setTimeout(r, 50));

      broker.disconnect();
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedEvents).toContain("session_end");
      expect(sessionEndReport.model).toBe("claude-sonnet-4-6");
      // Empty workItemPath passes through unchanged (not hashed).
      expect(sessionEndReport.workItemPath).toBe("");
      expect(sessionEndReport.metadata).toEqual({});
      // Session id is hashed -- expose only that it's present, not its shape.
      expect(sessionEndReport.sessionId).toBeDefined();
    } finally {
      server.stop(true);
    }
  });
});
