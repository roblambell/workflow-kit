// Author-affinity under anonymization (H-BAJ-3).
//
// Author-based affinity scheduling relies on matching `SyncItem.author`
// against the requesting daemon's `operatorId`. Both values are hashed
// with the same project secret before leaving the daemon, so if the
// hashing is consistent the broker's equality check still lands the
// item on the intended operator without ever seeing their git email.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BrokerServer } from "../core/broker-server.ts";
import { WebSocketCrewBroker } from "../core/crew.ts";
import { createCrewBrokerInstance } from "../core/orchestrate-crew.ts";
import type { LogEntry } from "../core/types.ts";

const TEST_CONFIG = {
  project_id: "33333333-3333-4333-8333-333333333333",
  broker_secret: Buffer.alloc(32, 11).toString("base64"),
};

let servers: BrokerServer[] = [];
let tmpDirs: string[] = [];
let brokers: WebSocketCrewBroker[] = [];

function createTmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `nw-affinity-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function createFakeProjectRoot(label: string, operatorEmail: string): string {
  const dir = createTmpDir(label);
  // Daemon/operator ids are persisted under `~/.ninthwave/projects/<slug>`
  // (see `userStateDir`), NOT inside the project dir. Write to the slug path
  // directly so `resolveOperatorId` reads our chosen email instead of
  // falling back to `git config user.email` from the surrounding env.
  const home = process.env.HOME ?? "/tmp";
  const slug = dir.replace(/\//g, "-");
  const stateDir = join(home, ".ninthwave", "projects", slug);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "daemon-id"), `daemon-${label}`);
  writeFileSync(join(stateDir, "operator-id"), operatorEmail);
  tmpDirs.push(stateDir);
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

describe("author-affinity under hashed identifiers", () => {
  it("routes an item authored by alice to alice's daemon even after hashing", async () => {
    const { port } = startBroker();

    // alice's machine has git user.email = alice@example.com (persisted via
    // the operator-id file). bob's machine has bob@example.com. Both sync
    // the same work queue; a single item is authored by alice.
    const rootAlice = createFakeProjectRoot("alice", "alice@example.com");
    const rootBob = createFakeProjectRoot("bob", "bob@example.com");

    const log = (_entry: LogEntry) => {};
    const bAlice = createCrewBrokerInstance(
      rootAlice,
      `ws://localhost:${port}`,
      TEST_CONFIG,
      log,
      "alice-box",
    ) as WebSocketCrewBroker;
    const bBob = createCrewBrokerInstance(
      rootBob,
      `ws://localhost:${port}`,
      TEST_CONFIG,
      log,
      "bob-box",
    ) as WebSocketCrewBroker;
    brokers.push(bAlice, bBob);

    await bAlice.connect();
    await bBob.connect();

    const items = [
      { id: "ALICE-ITEM", dependencies: [], priority: 5, author: "alice@example.com" },
      { id: "POOL-ITEM", dependencies: [], priority: 5, author: "bob@example.com" },
    ];
    bAlice.sync(items);
    bBob.sync(items);
    await new Promise((r) => setTimeout(r, 50));

    // bob is allowed to claim first. Because author affinity places
    // alice-authored items at the bottom of bob's priority list (not his
    // author hash), bob should pick up POOL-ITEM first. Then alice
    // claims and lands on ALICE-ITEM.
    const bobClaim = await bBob.claim();
    const aliceClaim = await bAlice.claim();

    expect(bobClaim).toBe("POOL-ITEM");
    expect(aliceClaim).toBe("ALICE-ITEM");
  });
});
