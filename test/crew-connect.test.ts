// System test: WebSocketCrewBroker connects to MockBroker without hanging.
// Proves the full create → connect → sync → claim → complete cycle works end-to-end.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { MockBroker } from "../core/mock-broker.ts";
import { WebSocketCrewBroker } from "../core/crew.ts";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Helpers ─────────────────────────────────────────────────────────

let brokers: MockBroker[] = [];
let tmpDirs: string[] = [];
let clients: WebSocketCrewBroker[] = [];

function createTmpDir(): string {
  const dir = join(tmpdir(), `nw-crew-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

/** Create a fake project root with a daemon-id file so getOrCreateDaemonId works. */
function createFakeProjectRoot(daemonId: string): string {
  const dir = createTmpDir();
  const stateDir = join(dir, ".ninthwave", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "daemon-id"), daemonId);
  return dir;
}

function startBroker(): { broker: MockBroker; port: number } {
  const tmpDir = createTmpDir();
  const broker = new MockBroker({
    port: 0,
    eventLogPath: join(tmpDir, "events.jsonl"),
    checkIntervalMs: 50,
  });
  const port = broker.start();
  brokers.push(broker);
  return { broker, port };
}

async function createCrew(port: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/crews`, { method: "POST" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { code: string };
  return body.code;
}

beforeEach(() => {
  brokers = [];
  tmpDirs = [];
  clients = [];
});

afterEach(() => {
  for (const c of clients) {
    try { c.disconnect(); } catch { /* */ }
  }
  for (const b of brokers) {
    try { b.stop(); } catch { /* */ }
  }
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

// ── Tests ───────────────────────────────────────────────────────────

describe("WebSocketCrewBroker system test", () => {
  it("connect() resolves for a new daemon (does not hang)", async () => {
    const { port } = startBroker();
    const code = await createCrew(port);
    const projectRoot = createFakeProjectRoot("daemon-1");

    const broker = new WebSocketCrewBroker(
      projectRoot, `ws://localhost:${port}`, code, "https://github.com/test/repo",
      { log: () => {} },
      "test-machine",
    );
    clients.push(broker);

    // This was the bug: connect() hung forever because crew_update
    // didn't resolve the connect promise.
    await broker.connect();
    expect(broker.isConnected()).toBe(true);
  });

  it("connect() resolves and crew status is populated", async () => {
    const { port } = startBroker();
    const code = await createCrew(port);
    const projectRoot = createFakeProjectRoot("daemon-2");

    const broker = new WebSocketCrewBroker(
      projectRoot, `ws://localhost:${port}`, code, "https://github.com/test/repo",
      { log: () => {} },
      "test-machine-2",
    );
    clients.push(broker);

    await broker.connect();
    const status = broker.getCrewStatus();
    expect(status).not.toBeNull();
    expect(status!.daemonCount).toBe(1);
  });

  it("full cycle: connect → sync → claim → complete", async () => {
    const { port } = startBroker();
    const code = await createCrew(port);
    const projectRoot = createFakeProjectRoot("daemon-3");

    const broker = new WebSocketCrewBroker(
      projectRoot, `ws://localhost:${port}`, code, "https://github.com/test/repo",
      { log: () => {} },
      "test-machine-3",
    );
    clients.push(broker);

    await broker.connect();

    // Sync items
    broker.sync([
      { id: "TODO-1", dependencies: [], priority: 1, author: "" },
      { id: "TODO-2", dependencies: [], priority: 2, author: "" },
    ]);

    // Small delay for sync to be processed
    await new Promise((r) => setTimeout(r, 50));

    // Claim
    const claimed = await broker.claim();
    expect(claimed).toBe("TODO-1");

    // Complete
    broker.complete("TODO-1");

    // Claim next
    await new Promise((r) => setTimeout(r, 50));
    const claimed2 = await broker.claim();
    expect(claimed2).toBe("TODO-2");
  });

  it("two daemons can connect to the same crew", async () => {
    const { port } = startBroker();
    const code = await createCrew(port);

    const root1 = createFakeProjectRoot("daemon-a");
    const root2 = createFakeProjectRoot("daemon-b");

    const b1 = new WebSocketCrewBroker(
      root1, `ws://localhost:${port}`, code, "https://github.com/test/repo",
      { log: () => {} }, "machine-a",
    );
    const b2 = new WebSocketCrewBroker(
      root2, `ws://localhost:${port}`, code, "https://github.com/test/repo",
      { log: () => {} }, "machine-b",
    );
    clients.push(b1, b2);

    await b1.connect();
    await b2.connect();

    expect(b1.isConnected()).toBe(true);
    expect(b2.isConnected()).toBe(true);

    // Both see 2 daemons after a brief sync
    b1.sync([{ id: "T-1", dependencies: [], priority: 1, author: "" }]);
    await new Promise((r) => setTimeout(r, 100));

    const status = b2.getCrewStatus();
    expect(status).not.toBeNull();
    expect(status!.daemonCount).toBe(2);
  });

  it("two daemons claim different items (no overlap)", async () => {
    const { port } = startBroker();
    const code = await createCrew(port);

    const root1 = createFakeProjectRoot("daemon-x");
    const root2 = createFakeProjectRoot("daemon-y");

    const b1 = new WebSocketCrewBroker(
      root1, `ws://localhost:${port}`, code, "https://github.com/test/repo",
      { log: () => {} }, "machine-x",
    );
    const b2 = new WebSocketCrewBroker(
      root2, `ws://localhost:${port}`, code, "https://github.com/test/repo",
      { log: () => {} }, "machine-y",
    );
    clients.push(b1, b2);

    await b1.connect();
    await b2.connect();

    b1.sync([
      { id: "A-1", dependencies: [], priority: 1, author: "" },
      { id: "A-2", dependencies: [], priority: 2, author: "" },
    ]);
    await new Promise((r) => setTimeout(r, 50));

    const c1 = await b1.claim();
    const c2 = await b2.claim();

    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
    expect(c1).not.toBe(c2);
  });
});
