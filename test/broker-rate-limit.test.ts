// Broker capacity / rate-limiting (H-BAJ-3).
//
// The auto-join protocol lets any peer with a well-formed crew-id path
// allocate a crew in the broker. That makes the public broker trivial
// to DoS via random id spray, so both in-memory and file-backed stores
// enforce a ceiling:
//   * InMemoryBrokerStore: LRU cap (default 10k, configurable for tests).
//   * FileBrokerStore: hard ceiling (default 100k), refuses new crews.
//
// This suite exercises the bounds at small limits so the test runs in
// under a second and still proves the invariants.

import { describe, it, expect } from "vitest";
import {
  InMemoryBrokerStore,
  FileBrokerStore,
  BrokerStoreCapacityError,
  IN_MEMORY_CREW_LIMIT,
  FILE_STORE_CREW_LIMIT,
} from "../core/broker-store.ts";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("InMemoryBrokerStore LRU cap", () => {
  it("evicts the oldest crews past the configured limit", () => {
    const store = new InMemoryBrokerStore(100);
    for (let i = 0; i < 150; i++) {
      store.createCrew(`crew-${i.toString().padStart(4, "0")}`);
    }
    // Oldest 50 crews evicted; newest 100 retained.
    expect(store.size()).toBe(100);
    expect(store.hasCrew("crew-0000")).toBe(false);
    expect(store.hasCrew("crew-0049")).toBe(false);
    expect(store.hasCrew("crew-0050")).toBe(true);
    expect(store.hasCrew("crew-0149")).toBe(true);
  });

  it("touches a crew on getCrew so it survives LRU pressure", () => {
    const store = new InMemoryBrokerStore(10);
    for (let i = 0; i < 10; i++) {
      store.createCrew(`crew-${i}`);
    }
    // Touch crew-0 so it moves to the end of the LRU chain.
    store.getCrew("crew-0");
    // Insert 5 more crews -- crew-1..crew-5 should be evicted, not crew-0.
    for (let i = 10; i < 15; i++) {
      store.createCrew(`crew-${i}`);
    }
    expect(store.hasCrew("crew-0")).toBe(true);
    expect(store.hasCrew("crew-1")).toBe(false);
    expect(store.hasCrew("crew-5")).toBe(false);
    expect(store.hasCrew("crew-14")).toBe(true);
  });

  it("exposes a 10,000-crew default ceiling", () => {
    // The default is intended to be large enough for real workloads while
    // keeping memory bounded against an attacker spraying random ids.
    expect(IN_MEMORY_CREW_LIMIT).toBe(10_000);
  });

  it("handles bulk auto-join without unbounded memory growth", () => {
    const store = new InMemoryBrokerStore(10_000);
    for (let i = 0; i < 12_000; i++) {
      store.createCrew(`spray-${i}`);
    }
    expect(store.size()).toBe(10_000);
    // The most recent 10k are retained.
    expect(store.hasCrew("spray-11999")).toBe(true);
    expect(store.hasCrew("spray-0")).toBe(false);
  });
});

describe("FileBrokerStore capacity ceiling", () => {
  it("refuses to create a crew past the configured ceiling", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nw-file-cap-"));
    try {
      const store = new FileBrokerStore(dataDir, 5);
      for (let i = 0; i < 5; i++) {
        store.createCrew(`crew-${i}`);
      }
      expect(store.size()).toBe(5);
      expect(() => store.createCrew("crew-5")).toThrow(BrokerStoreCapacityError);
      // Existing crews still work; only new ones are refused.
      expect(store.hasCrew("crew-0")).toBe(true);
      expect(store.hasCrew("crew-5")).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("exposes a 100,000-crew default ceiling", () => {
    expect(FILE_STORE_CREW_LIMIT).toBe(100_000);
  });

  it("idempotent createCrew for existing ids even at capacity", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nw-file-cap-idem-"));
    try {
      const store = new FileBrokerStore(dataDir, 2);
      store.createCrew("crew-A");
      store.createCrew("crew-B");
      // Re-creating an existing crew returns the existing one without
      // throwing even though the store is at capacity.
      const existing = store.createCrew("crew-A");
      expect(existing.code).toBe("crew-A");
      expect(store.size()).toBe(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
