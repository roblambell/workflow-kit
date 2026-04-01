// Scenario test: crew coordination -- multi-daemon coordination through
// the real orchestrateLoop with a CrewBroker injected.
// Uses a lightweight in-memory stub implementing the CrewBroker interface
// (not the full MockBroker WebSocket server) so tests run fast and deterministic.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator, type OrchestratorItem } from "../../core/orchestrator.ts";
import {
  orchestrateLoop,
  orchestratorItemsToStatusItems,
  crewStatusToRemoteItemSnapshots,
} from "../../core/commands/orchestrate.ts";
import type { CrewBroker, SyncItem, CrewStatus, CrewRemoteItemSnapshot } from "../../core/crew.ts";
import { serializeOrchestratorState } from "../../core/daemon.ts";
import { daemonStateToStatusItems } from "../../core/status-render.ts";
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
  /** Crew status returned by getCrewStatus(). */
  private _crewStatus: CrewStatus | null = null;

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
    return this._crewStatus;
  }

  report(
    _event: string,
    _todoPath: string,
    _metadata: Record<string, unknown>,
    _opts?: { model?: string; tokenUsage?: { inputTokens: number; outputTokens: number; cacheTokens?: number } },
  ): void {
    // no-op
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

  /** Set the crew status returned by getCrewStatus(). */
  setCrewStatus(status: CrewStatus | null): void {
    this._crewStatus = status;
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
      fixForward: false,
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
      fixForward: false,
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

  // ── Scenario 3: Broker decides which item to launch ──

  it("broker-assigned item is launched even when different from processTransitions choice", async () => {
    const broker = new StubCrewBroker();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      fixForward: false,
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

    // C-4 should complete (broker assigned it, daemon launched it)
    const c4 = orch.getItem("C-4")!;
    expect(c4.state).toBe("done");

    // C-3 should remain queued/ready (never assigned by broker)
    const c3 = orch.getItem("C-3")!;
    expect(c3.state).not.toBe("done");
    expect(["ready", "queued"]).toContain(c3.state);

    // Assert: crew launches were resolved
    const resolvedLogs = loopDeps.__logs.filter(
      (l) => (l as Record<string, unknown>).event === "crew_launches_resolved",
    );
    expect(resolvedLogs.length).toBeGreaterThanOrEqual(1);

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
      fixForward: false,
    });

    // DEP-1 must be tracked in the orchestrator so it's included in the sync
    // (untracked deps are filtered out -- they're treated as already delivered)
    const dep = makeWorkItem("DEP-1", [], "medium");
    orch.addItem(dep);
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

  it("sync filters out untracked dependencies (already delivered)", async () => {
    const broker = new StubCrewBroker();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      fixForward: false,
    });

    // C-6 depends on GONE-1 which is NOT in the orchestrator (delivered/removed)
    const item = makeWorkItem("C-6", ["GONE-1"], "medium");
    orch.addItem(item);

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);
    loopDeps.crewBroker = broker;

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 2 });

    expect(broker.syncs.length).toBeGreaterThanOrEqual(1);
    const syncedItem = broker.syncs[0]!.find((s) => s.id === "C-6");
    expect(syncedItem).toBeDefined();
    // Untracked dep GONE-1 should be filtered out of the sync payload
    expect(syncedItem!.dependencies).toEqual([]);
  });

  it("broker reconnect mid-run: items resume after reconnection", async () => {
    // Start disconnected so initial launches are blocked, then reconnect
    const broker = new StubCrewBroker({ disconnected: true });

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      fixForward: false,
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

  // ── Remote state rendering regression coverage ────────────────────

  function makeCrewStatusWith(
    remoteItems: CrewRemoteItemSnapshot[],
  ): CrewStatus {
    return {
      crewCode: "ABCD-EFGH",
      daemonCount: 2,
      availableCount: 1,
      claimedCount: remoteItems.filter((i) => i.ownerDaemonId !== null).length,
      completedCount: 0,
      daemonNames: ["local", "remote-host"],
      claimedItems: remoteItems
        .filter((i) => i.ownerDaemonId !== null)
        .map((i) => i.id),
      remoteItems,
    };
  }

  it("remote implementing/review/queued states flow truthfully through broker, TUI, and persisted views", async () => {
    const broker = new StubCrewBroker();
    broker.setClaimOverride(null); // block launches

    broker.setCrewStatus(
      makeCrewStatusWith([
        {
          id: "RIMPL-1",
          state: "implementing",
          ownerDaemonId: "daemon-2",
          ownerName: "remote-host",
        },
        {
          id: "RREV-1",
          state: "review",
          ownerDaemonId: "daemon-3",
          ownerName: "review-host",
          prNumber: 42,
        },
        {
          id: "RQUEUE-1",
          state: "queued",
          ownerDaemonId: null,
          ownerName: null,
        },
      ]),
    );

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      fixForward: false,
    });

    orch.addItem(makeWorkItem("RIMPL-1"));
    orch.addItem(makeWorkItem("RREV-1"));
    orch.addItem(makeWorkItem("RQUEUE-1"));

    const capturedItems: OrchestratorItem[][] = [];
    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);
    loopDeps.crewBroker = broker;
    loopDeps.onPollComplete = (items) => capturedItems.push(items.map((i) => ({ ...i })));

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 3 });

    expect(capturedItems.length).toBeGreaterThanOrEqual(1);
    const lastItems = capturedItems[capturedItems.length - 1]!;

    // ── TUI path: orchestratorItemsToStatusItems with broker snapshots ──
    const remoteSnapshots = crewStatusToRemoteItemSnapshots(broker.getCrewStatus());
    const tuiItems = orchestratorItemsToStatusItems(lastItems, remoteSnapshots);

    const tuiImpl = tuiItems.find((i) => i.id === "RIMPL-1")!;
    expect(tuiImpl.state).toBe("implementing");
    expect(tuiImpl.remote).toBe(true);

    const tuiRev = tuiItems.find((i) => i.id === "RREV-1")!;
    expect(tuiRev.state).toBe("review");
    expect(tuiRev.remote).toBe(true);
    expect(tuiRev.prNumber).toBe(42);

    const tuiQueue = tuiItems.find((i) => i.id === "RQUEUE-1")!;
    expect(tuiQueue.state).toBe("queued");
    expect(tuiQueue.remote).toBe(false);

    // ── Persisted path: serializeOrchestratorState → daemonStateToStatusItems ──
    const daemonState = serializeOrchestratorState(lastItems, 9999, "2026-04-01T00:00:00Z", {
      remoteItemSnapshots: remoteSnapshots,
    });
    const persItems = daemonStateToStatusItems(daemonState);

    const persImpl = persItems.find((i) => i.id === "RIMPL-1")!;
    expect(persImpl.state).toBe("implementing");
    expect(persImpl.remote).toBe(true);

    const persRev = persItems.find((i) => i.id === "RREV-1")!;
    expect(persRev.state).toBe("review");
    expect(persRev.remote).toBe(true);
    expect(persRev.prNumber).toBe(42);

    const persQueue = persItems.find((i) => i.id === "RQUEUE-1")!;
    expect(persQueue.state).toBe("queued");
    expect(persQueue.remote).toBe(false);

    // ── Agreement: TUI and persisted views must agree ──
    for (const id of ["RIMPL-1", "RREV-1", "RQUEUE-1"]) {
      const tui = tuiItems.find((i) => i.id === id)!;
      const pers = persItems.find((i) => i.id === id)!;
      expect(tui.state).toBe(pers.state);
      expect(tui.remote).toBe(pers.remote);
      expect(tui.prNumber).toBe(pers.prNumber);
    }
  });

  it("last broker update wins: stale remote state replaced without residue", async () => {
    const broker = new StubCrewBroker();
    broker.setClaimOverride(null);

    // Initial: RACE-1 implementing by daemon-2
    broker.setCrewStatus(
      makeCrewStatusWith([
        {
          id: "RACE-1",
          state: "implementing",
          ownerDaemonId: "daemon-2",
          ownerName: "host-2",
        },
      ]),
    );

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      fixForward: false,
    });
    orch.addItem(makeWorkItem("RACE-1"));

    const capturedItems: OrchestratorItem[][] = [];
    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);
    loopDeps.crewBroker = broker;
    loopDeps.onPollComplete = (items) => capturedItems.push(items.map((i) => ({ ...i })));

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;
      if (cycle === 3) {
        // Simulate daemon-2 disconnect -- item released to queue
        broker.setCrewStatus(
          makeCrewStatusWith([
            {
              id: "RACE-1",
              state: "queued",
              ownerDaemonId: null,
              ownerName: null,
            },
          ]),
        );
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 6 });

    const lastItems = capturedItems[capturedItems.length - 1]!;

    // Both views should show the LATEST broker state (queued), not stale implementing
    const remoteSnapshots = crewStatusToRemoteItemSnapshots(broker.getCrewStatus());
    const tuiItems = orchestratorItemsToStatusItems(lastItems, remoteSnapshots);
    expect(tuiItems[0]!.state).toBe("queued");
    expect(tuiItems[0]!.remote).toBe(false);

    const daemonState = serializeOrchestratorState(lastItems, 9999, "2026-04-01T00:00:00Z", {
      remoteItemSnapshots: remoteSnapshots,
    });
    const persItems = daemonStateToStatusItems(daemonState);
    expect(persItems[0]!.state).toBe("queued");
    expect(persItems[0]!.remote).toBe(false);
  });

  it("remote item returns to queued after daemon release preserves truthful rendering", async () => {
    const broker = new StubCrewBroker();
    broker.setClaimOverride(null);

    // Item starts in review by daemon-2
    broker.setCrewStatus(
      makeCrewStatusWith([
        {
          id: "REL-1",
          state: "review",
          ownerDaemonId: "daemon-2",
          ownerName: "host-2",
          prNumber: 55,
        },
      ]),
    );

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      fixForward: false,
    });
    orch.addItem(makeWorkItem("REL-1"));

    const capturedItems: OrchestratorItem[][] = [];
    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);
    loopDeps.crewBroker = broker;
    loopDeps.onPollComplete = (items) => capturedItems.push(items.map((i) => ({ ...i })));

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;
      if (cycle === 2) {
        // daemon-2 disconnects, broker releases item
        broker.setCrewStatus(
          makeCrewStatusWith([
            {
              id: "REL-1",
              state: "queued",
              ownerDaemonId: null,
              ownerName: null,
            },
          ]),
        );
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 5 });

    const lastItems = capturedItems[capturedItems.length - 1]!;
    const remoteSnapshots = crewStatusToRemoteItemSnapshots(broker.getCrewStatus());

    // TUI: should show queued (not stale review)
    const tuiItems = orchestratorItemsToStatusItems(lastItems, remoteSnapshots);
    expect(tuiItems[0]!.state).toBe("queued");
    expect(tuiItems[0]!.remote).toBe(false);
    expect(tuiItems[0]!.prNumber).toBeNull();

    // Persisted: same result
    const daemonState = serializeOrchestratorState(lastItems, 9999, "2026-04-01T00:00:00Z", {
      remoteItemSnapshots: remoteSnapshots,
    });
    const persItems = daemonStateToStatusItems(daemonState);
    expect(persItems[0]!.state).toBe("queued");
    expect(persItems[0]!.remote).toBe(false);
  });
});
