// Scenario test: crew coordination -- multi-daemon coordination through
// the real orchestrateLoop with a CrewBroker injected.
// Uses a lightweight in-memory stub implementing the CrewBroker interface
// (not the full MockBroker WebSocket server) so tests run fast and deterministic.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "../../core/orchestrator.ts";
import { orchestrateLoop } from "../../core/commands/orchestrate.ts";
import type { CrewBroker, SyncItem, CrewStatus } from "../../core/crew.ts";
import { FakeGitHub } from "../fakes/fake-github.ts";
import { FakeMux } from "../fakes/fake-mux.ts";
import {
  makeWorkItem,
  defaultCtx,
  buildActionDeps,
  buildLoopDeps,
  completeItem,
  type ScenarioLoopDeps,
} from "./helpers.ts";

// ── Stub CrewBroker ─────────────────────────────────────────────────
// Lightweight in-process broker stub implementing the CrewBroker interface.
// Keeps sync/claim/complete call history for assertions without needing a
// real WebSocket server.

interface StubCrewBrokerOpts {
  /** When set, claim() returns this id instead of the requested item. */
  claimOverride?: string | null;
  /** When true, isConnected() returns false. */
  disconnected?: boolean;
}

class StubCrewBroker implements CrewBroker {
  /** All sync calls recorded. */
  readonly syncs: SyncItem[][] = [];
  /** All claim calls recorded (resolved item ids). */
  readonly claims: Array<string | null> = [];
  /** All complete calls recorded. */
  readonly completes: string[] = [];

  private _connected: boolean;
  private _claimOverride: string | null | undefined;
  /** Items available for claim (populated from sync). */
  private _available: string[] = [];
  /** Index for round-robin claim serving. */
  private _claimIdx = 0;

  constructor(opts: StubCrewBrokerOpts = {}) {
    this._connected = !opts.disconnected;
    this._claimOverride = opts.claimOverride;
  }

  async connect(): Promise<void> {
    this._connected = true;
  }

  sync(items: SyncItem[]): void {
    this.syncs.push(items);
    // Track available item IDs for claim scheduling
    this._available = items.map((i) => i.id);
    this._claimIdx = 0;
  }

  async claim(): Promise<string | null> {
    if (this._claimOverride !== undefined) {
      const result = this._claimOverride;
      this.claims.push(result);
      return result;
    }
    // Return the next available item in order
    if (this._claimIdx < this._available.length) {
      const id = this._available[this._claimIdx]!;
      this._claimIdx++;
      this.claims.push(id);
      return id;
    }
    this.claims.push(null);
    return null;
  }

  complete(todoId: string): void {
    this.completes.push(todoId);
  }

  async scheduleClaim(_taskId: string, _scheduleTime: string): Promise<boolean> {
    return true;
  }

  heartbeat(): void {
    // no-op
  }

  disconnect(): void {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getCrewStatus(): CrewStatus | null {
    return null;
  }

  // ── Test helpers ──────────────────────────────────────────────────

  /** Simulate broker disconnection. */
  setConnected(connected: boolean): void {
    this._connected = connected;
  }

  /** Override what claim() returns. Set to undefined to resume normal behaviour. */
  setClaimOverride(override: string | null | undefined): void {
    this._claimOverride = override;
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("scenario: crew coordination", () => {
  let fakeGh: FakeGitHub;
  let fakeMux: FakeMux;

  beforeEach(() => {
    fakeGh = new FakeGitHub();
    fakeMux = new FakeMux();
  });

  // ── Scenario 1: Single daemon claims and completes items via the broker ──

  it("single daemon claims and completes items via the broker", async () => {
    const broker = new StubCrewBroker();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("C-1"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);
    loopDeps.crewBroker = broker;

    let prCreated = false;

    loopDeps.sleep = async () => {
      const item = orch.getItem("C-1")!;
      if (item.state === "implementing" && !prCreated) {
        completeItem("C-1", fakeGh, orch);
        prCreated = true;
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 20 });

    const item = orch.getItem("C-1")!;
    expect(item.state).toBe("done");

    // Assert: sync messages sent each poll cycle with active items
    expect(broker.syncs.length).toBeGreaterThanOrEqual(1);
    // First sync should contain C-1
    const firstSync = broker.syncs[0]!;
    expect(firstSync.some((s) => s.id === "C-1")).toBe(true);

    // Assert: claim called before each launch action
    expect(broker.claims.length).toBeGreaterThanOrEqual(1);
    expect(broker.claims).toContain("C-1");

    // Assert: complete notification sent after merge
    expect(broker.completes).toContain("C-1");

    // Assert: launch was executed
    expect(actionDeps.launchSingleItem).toHaveBeenCalledTimes(1);
  });

  // ── Scenario 2: Broker disconnects -- launches blocked, resume on reconnect ──

  it("all launches blocked when broker disconnected, resume when reconnected", async () => {
    const broker = new StubCrewBroker({ disconnected: true });

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("C-2"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);
    loopDeps.crewBroker = broker;

    let cycle = 0;
    let prCreated = false;

    loopDeps.sleep = async () => {
      cycle++;
      const item = orch.getItem("C-2")!;

      // After 3 cycles of blocked launches, reconnect the broker
      if (cycle === 3) {
        broker.setConnected(true);
      }

      // After reconnect and launch completes, create PR
      if (item.state === "implementing" && !prCreated) {
        completeItem("C-2", fakeGh, orch);
        prCreated = true;
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 20 });

    // During disconnected phase, item should have been rolled back to ready
    // (visible in logs) and no launch executed. After reconnect, it proceeds.
    const item = orch.getItem("C-2")!;
    expect(item.state).toBe("done");

    // Assert: all launches blocked when broker.isConnected() returns false
    // The first few cycles should have no launch calls because broker was disconnected.
    // Sync still happens even when disconnected.
    const syncsBeforeReconnect = broker.syncs.length;
    expect(syncsBeforeReconnect).toBeGreaterThanOrEqual(1);

    // Verify launch was eventually called (after reconnect)
    expect(actionDeps.launchSingleItem).toHaveBeenCalledTimes(1);

    // Check blocked launches were logged
    const blockedLogs = loopDeps.__logs.filter(
      (l) => (l as Record<string, unknown>).event === "crew_launches_blocked",
    );
    expect(blockedLogs.length).toBeGreaterThanOrEqual(1);

    // Assert: complete notification sent after merge
    expect(broker.completes).toContain("C-2");
  });

  // ── Scenario 3: Claim returns different item -- denied launches roll back ──

  it("claim returns different item than requested -- denied launches roll back to ready", async () => {
    const broker = new StubCrewBroker();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
    });

    // Add two items; the broker will only grant claims for C-4
    orch.addItem(makeWorkItem("C-3"));
    orch.addItem(makeWorkItem("C-4"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);
    loopDeps.crewBroker = broker;

    let prCreated = false;

    // Override claim to always return C-4 (simulating the broker assigning
    // a different item than what the daemon requested for each launch slot).
    broker.setClaimOverride("C-4");

    loopDeps.sleep = async () => {
      const c4 = orch.getItem("C-4")!;
      if (c4.state === "implementing" && !prCreated) {
        completeItem("C-4", fakeGh, orch);
        prCreated = true;
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 25 });

    // C-4 should complete (it was granted by claim)
    const c4 = orch.getItem("C-4")!;
    expect(c4.state).toBe("done");

    // C-3 should be rolled back to ready (denied by broker since claim
    // only ever returned C-4 but processTransitions may try to launch C-3 too)
    const c3 = orch.getItem("C-3")!;
    // C-3 stays ready or gets repeatedly rolled back -- it should never reach done
    expect(c3.state).not.toBe("done");
    // It should be in ready state (rolled back from launching)
    expect(["ready", "queued"]).toContain(c3.state);

    // Assert: denied launches were logged
    const filteredLogs = loopDeps.__logs.filter(
      (l) => (l as Record<string, unknown>).event === "crew_launches_filtered",
    );
    expect(filteredLogs.length).toBeGreaterThanOrEqual(1);

    // Assert: complete notification sent for C-4
    expect(broker.completes).toContain("C-4");
    // C-3 was never completed
    expect(broker.completes).not.toContain("C-3");
  });

  // ── Additional assertions from test plan ──────────────────────────

  it("sync messages include priority, dependencies, and author metadata", async () => {
    const broker = new StubCrewBroker();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
    });

    const item = makeWorkItem("C-5", ["DEP-1"], "medium");
    orch.addItem(item);

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);
    loopDeps.crewBroker = broker;

    // Run just enough to get one sync
    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 2 });

    expect(broker.syncs.length).toBeGreaterThanOrEqual(1);
    const syncedItem = broker.syncs[0]!.find((s) => s.id === "C-5");
    expect(syncedItem).toBeDefined();
    expect(syncedItem!.dependencies).toEqual(["DEP-1"]);
    // Priority: medium maps to 2
    expect(syncedItem!.priority).toBe(2);
    // Author field is present (may be empty string since test items have no real git path)
    expect(syncedItem!).toHaveProperty("author");
  });

  it("broker reconnect mid-run: items resume after reconnection", async () => {
    // Start disconnected so initial launches are blocked, then reconnect
    const broker = new StubCrewBroker({ disconnected: true });

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("C-6"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);
    loopDeps.crewBroker = broker;

    let cycle = 0;
    let prCreated = false;

    loopDeps.sleep = async () => {
      cycle++;
      const item = orch.getItem("C-6")!;

      // Reconnect after a few blocked cycles
      if (cycle === 4) {
        broker.setConnected(true);
      }

      // Complete after reconnect and launch
      if (item.state === "implementing" && !prCreated) {
        completeItem("C-6", fakeGh, orch);
        prCreated = true;
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 20 });

    const item = orch.getItem("C-6")!;
    expect(item.state).toBe("done");

    // Blocked-launch logs should exist from the disconnected window
    const blockedLogs = loopDeps.__logs.filter(
      (l) => (l as Record<string, unknown>).event === "crew_launches_blocked",
    );
    expect(blockedLogs.length).toBeGreaterThanOrEqual(1);

    // After reconnect, launch and complete should succeed
    expect(actionDeps.launchSingleItem).toHaveBeenCalledTimes(1);
    expect(broker.completes).toContain("C-6");
  });
});
