// End-to-end auto-join + anonymization test (H-BAJ-3).
//
// Two `WebSocketCrewBroker` clients built from the same `project_id` +
// `broker_secret` should:
//   1. Derive the same `crew_id` and land in the same broker crew without
//      any preceding POST / handshake.
//   2. Observe each other's claims in `crew_update` broadcasts.
//   3. Send only hashed identifiers over the wire -- the broker must never
//      receive a known cleartext work item id or git email.
//
// All three guarantees are checked inside this single scenario so a future
// regression (e.g. accidentally sending a cleartext author) shows up as a
// failed expectation rather than a subtle protocol drift.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BrokerServer } from "../core/broker-server.ts";
import { WebSocketCrewBroker } from "../core/crew.ts";
import {
  resolveCrewId,
  createCrewBrokerInstance,
} from "../core/orchestrate-crew.ts";
import type { LogEntry } from "../core/types.ts";

const TEST_CONFIG = {
  project_id: "22222222-2222-4222-8222-222222222222",
  broker_secret: Buffer.alloc(32, 5).toString("base64"),
};

let servers: BrokerServer[] = [];
let tmpDirs: string[] = [];
let brokers: WebSocketCrewBroker[] = [];

function createTmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `nw-auto-join-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function createFakeProjectRoot(label: string, operatorEmail: string): string {
  const dir = createTmpDir(label);
  const stateDir = join(dir, ".ninthwave", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "daemon-id"), `daemon-${label}`);
  writeFileSync(join(stateDir, "operator-id"), operatorEmail);
  return dir;
}

function startBroker(): { server: BrokerServer; port: number } {
  const tmpDir = createTmpDir("broker");
  const server = new BrokerServer({
    port: 0,
    dataDir: join(tmpDir, "crews"),
    eventLogPath: join(tmpDir, "events.jsonl"),
    checkIntervalMs: 50,
  });
  const port = server.start();
  servers.push(server);
  return { server, port };
}

afterEach(() => {
  for (const b of brokers) {
    try { b.disconnect(); } catch { /* ignore */ }
  }
  brokers = [];
  for (const s of servers) {
    try { s.stop(); } catch { /* ignore */ }
  }
  servers = [];
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

describe("broker auto-join + anonymization", () => {
  it("two daemons sharing project_id + broker_secret land in the same crew and see each other's claims", async () => {
    const { server, port } = startBroker();

    const root1 = createFakeProjectRoot("d1", "alice@example.com");
    const root2 = createFakeProjectRoot("d2", "bob@example.com");

    // ── Record every raw message the broker actually receives, so we can
    // assert later that no cleartext identifier ever traveled upstream.
    const receivedOnWire: string[] = [];
    const recordingServer = server as unknown as {
      // Access the internal websocket handler via a monkey patch -- the
      // BrokerServer class exposes `handleMessage` but the raw message
      // handler is inline. Easier: tap the Bun server's websocket.message
      // by capturing via a proxy broker's `message` parse path in-side.
    };
    void recordingServer;

    // Capture inbound payloads at the transport level by intercepting
    // WebSocket.prototype.send on the client so we know exactly what the
    // daemons serialized before TLS / upgrade wrapping.
    const originalSend = WebSocket.prototype.send;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocket.prototype.send = function (this: WebSocket, data: any) {
      if (typeof data === "string") {
        receivedOnWire.push(data);
      } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        receivedOnWire.push(Buffer.from(data as ArrayBufferLike).toString("utf8"));
      }
      return originalSend.call(this, data);
    };

    try {
      const log = (_entry: LogEntry) => {};
      const b1 = createCrewBrokerInstance(
        root1,
        `ws://localhost:${port}`,
        TEST_CONFIG,
        log,
        "machine-1",
      ) as WebSocketCrewBroker;
      const b2 = createCrewBrokerInstance(
        root2,
        `ws://localhost:${port}`,
        TEST_CONFIG,
        log,
        "machine-2",
      ) as WebSocketCrewBroker;
      brokers.push(b1, b2);

      await b1.connect();
      await b2.connect();

      expect(b1.isConnected()).toBe(true);
      expect(b2.isConnected()).toBe(true);

      // Both resolved to the same crew via the shared secret.
      const derivedCrewId = resolveCrewId(TEST_CONFIG);
      expect(server.getCrew(derivedCrewId)).toBeDefined();
      expect(server.getCrew(derivedCrewId)!.daemons.size).toBe(2);

      // ── Sync + claim
      const items = [
        { id: "H-FOO-1", dependencies: [], priority: 1, author: "alice@example.com" },
        { id: "H-FOO-2", dependencies: [], priority: 2, author: "alice@example.com" },
      ];
      b1.sync(items);
      b2.sync(items);
      await new Promise((r) => setTimeout(r, 50));

      const claimed = await b1.claim();
      expect(claimed).toBe("H-FOO-1");

      // Give b2's crew_update a moment to arrive after the claim broadcast.
      await new Promise((r) => setTimeout(r, 100));
      const status = b2.getCrewStatus();
      expect(status).not.toBeNull();
      // b1 owns one item now; b2 sees it in the broadcast via the hashed
      // id that round-trips back through its local id map.
      const claimedIds = status!.claimedItems;
      expect(claimedIds).toContain("H-FOO-1");

      // ── Anonymization assertion
      // None of the raw wire payloads should contain a cleartext work item
      // id or git email. Both values are project-owned strings and the
      // protocol promises they never leave the daemon untransformed.
      const wireBlob = receivedOnWire.join("\n");
      expect(wireBlob).not.toContain("H-FOO-1");
      expect(wireBlob).not.toContain("H-FOO-2");
      expect(wireBlob).not.toContain("alice@example.com");
      expect(wireBlob).not.toContain("bob@example.com");
    } finally {
      WebSocket.prototype.send = originalSend;
    }
  });
});
