// Scenario test: CI failure and recovery loops through the real orchestrateLoop.
// Exercises scenarios:
// 1. CI fails → worker pushes fix → CI re-runs and passes → item merges → done
// 2. CI fails repeatedly beyond maxCiRetries → item goes stuck
// 3. CI fails with merge conflicts (CONFLICTING) → daemon-rebase action emitted
// 4. CI fails with dead worker → orchestrator detects and respawns
// 5. CI fails with unresponsive worker (ack timeout) → orchestrator detects and respawns

import { describe, it, expect } from "vitest";
import { Orchestrator, NOT_ALIVE_THRESHOLD, TIMEOUTS } from "../../core/orchestrator.ts";
import { orchestrateLoop, buildSnapshot } from "../../core/commands/orchestrate.ts";
import { FakeGitHub } from "../fakes/fake-github.ts";
import { FakeMux } from "../fakes/fake-mux.ts";
import {
  makeWorkItem,
  defaultCtx,
  buildActionDeps,
  buildLoopDeps,
} from "./helpers.ts";

describe("scenario: CI failure recovery", () => {
  it("CI fails, worker pushes fix, CI re-runs and passes, item merges and reaches done", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      sessionLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxCiRetries: 3,
      maxRetries: 3,
      enableStacking: false,
      fixForward: false,
      ciPendingFailGraceMs: 0,
    });

    orch.addItem(makeWorkItem("CF-1"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    // Track states visited for transition verification
    const statesVisited = new Set<string>();
    orch.config.onTransition = (_itemId, _from, to) => {
      statesVisited.add(to);
    };

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;

      // Cycle 2: worker creates PR, CI fails
      if (cycle === 2) {
        fakeGh.createPR("ninthwave/CF-1", "Item CF-1");
        fakeGh.setCIStatus("ninthwave/CF-1", "fail");
        fakeGh.setMergeable("ninthwave/CF-1", "MERGEABLE");
      }

      // Cycle 4: worker pushes a fix commit, CI goes pending
      if (cycle === 4) {
        // Simulate new commit by updating lastCommitTime
        const item = orch.getItem("CF-1");
        if (item) item.lastCommitTime = new Date().toISOString();
        fakeGh.setCIStatus("ninthwave/CF-1", "pending");
      }

      // Cycle 5: CI passes, review pre-approved
      if (cycle === 5) {
        fakeGh.setCIStatus("ninthwave/CF-1", "pass");
        fakeGh.setReviewDecision("ninthwave/CF-1", "APPROVED");
        const item = orch.getItem("CF-1");
        if (item) item.reviewCompleted = true;
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 30 });

    const finalItem = orch.getItem("CF-1");
    expect(finalItem).toBeDefined();
    expect(finalItem!.state).toBe("done");

    // Verify key state transitions occurred
    expect(statesVisited).toContain("implementing");
    expect(statesVisited).toContain("ci-failed");
    expect(statesVisited).toContain("ci-pending");
    expect(statesVisited).toContain("ci-passed");
    expect(statesVisited).toContain("merging");
    expect(statesVisited).toContain("done");

    // CI fail count should be at least 1 from the failure
    expect(finalItem!.ciFailCount).toBeGreaterThanOrEqual(1);

    // notify-ci-failure action should have queued an inbox message for the worker
    expect(actionDeps.writeInbox).toHaveBeenCalled();
    expect(actionDeps.prMerge).toHaveBeenCalled();
  });

  it("CI fails repeatedly beyond maxCiRetries, item goes stuck", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const maxCiRetries = 2;
    const orch = new Orchestrator({
      sessionLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxCiRetries,
      maxRetries: 3,
      enableStacking: false,
      fixForward: false,
      ciPendingFailGraceMs: 0,
    });

    orch.addItem(makeWorkItem("CF-2"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;

      // Cycle 2: worker creates PR, CI fails the first time
      if (cycle === 2) {
        fakeGh.createPR("ninthwave/CF-2", "Item CF-2");
        fakeGh.setCIStatus("ninthwave/CF-2", "fail");
        fakeGh.setMergeable("ninthwave/CF-2", "MERGEABLE");
      }

      // Keep CI failing -- each loop cycle where CI is "fail" and the item is
      // in ci-failed will cause the orchestrator to check ciFailCount > maxCiRetries.
      // We need ciFailCount to exceed maxCiRetries, so we simulate the worker
      // pushing new commits (resetting ciFailureNotified) so the orchestrator
      // re-enters the failure path and increments ciFailCount each time.

      // Cycle 4+: simulate worker pushing fix attempts that still fail.
      // Each time the CI goes pending->fail, ciFailCount increments.
      if (cycle === 4) {
        const item = orch.getItem("CF-2");
        if (item) item.lastCommitTime = new Date().toISOString();
        fakeGh.setCIStatus("ninthwave/CF-2", "pending");
      }
      if (cycle === 5) {
        fakeGh.setCIStatus("ninthwave/CF-2", "fail");
      }

      if (cycle === 7) {
        const item = orch.getItem("CF-2");
        if (item) item.lastCommitTime = new Date().toISOString();
        fakeGh.setCIStatus("ninthwave/CF-2", "pending");
      }
      if (cycle === 8) {
        fakeGh.setCIStatus("ninthwave/CF-2", "fail");
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 40 });

    const finalItem = orch.getItem("CF-2");
    expect(finalItem).toBeDefined();
    expect(finalItem!.state).toBe("stuck");
    expect(finalItem!.ciFailCount).toBeGreaterThan(maxCiRetries);
    expect(finalItem!.failureReason).toContain("ci-failed");
    expect(finalItem!.failureReason).toContain("max CI retries");
  });

  it("CI fails due to merge conflicts (CONFLICTING), daemon-rebase action is emitted", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      sessionLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxCiRetries: 3,
      maxRetries: 3,
      enableStacking: false,
      fixForward: false,
      ciPendingFailGraceMs: 0,
    });

    orch.addItem(makeWorkItem("CF-3"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    // Track emitted actions by capturing log entries
    const logEntries = loopDeps.__logs;

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;

      // Cycle 2: worker creates PR, CI fails with merge conflicts
      if (cycle === 2) {
        fakeGh.createPR("ninthwave/CF-3", "Item CF-3");
        fakeGh.setCIStatus("ninthwave/CF-3", "fail");
        fakeGh.setMergeable("ninthwave/CF-3", "CONFLICTING");
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 15 });

    const finalItem = orch.getItem("CF-3");
    expect(finalItem).toBeDefined();

    // Item should be in ci-failed state (daemon-rebase was emitted, but we
    // don't have a daemonRebase dep to actually resolve the conflict)
    expect(finalItem!.state).toBe("ci-failed");
    expect(finalItem!.ciFailCount).toBeGreaterThanOrEqual(1);
    expect(finalItem!.failureReason).toContain("merge conflicts");

    // Verify daemon-rebase action queued a rebase message for the live worker.
    const inboxCalls = (actionDeps.writeInbox as ReturnType<typeof import("vitest").vi.fn>).mock.calls;
    const rebaseMessages = inboxCalls.filter(
      (call) => {
        const [projectRoot, itemId, msg] = call as [string, string, string];
        return projectRoot === finalItem!.worktreePath
          && itemId === "CF-3"
          && typeof msg === "string"
          && msg.includes("Rebase");
      },
    );
    expect(rebaseMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("ciFailCount increments on each failure cycle", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      sessionLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxCiRetries: 10, // High limit so we don't hit stuck
      maxRetries: 3,
      enableStacking: false,
      fixForward: false,
      ciPendingFailGraceMs: 0,
    });

    orch.addItem(makeWorkItem("CF-4"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;

      // Cycle 2: create PR, CI fails (ciFailCount -> 1)
      if (cycle === 2) {
        fakeGh.createPR("ninthwave/CF-4", "Item CF-4");
        fakeGh.setCIStatus("ninthwave/CF-4", "fail");
        fakeGh.setMergeable("ninthwave/CF-4", "MERGEABLE");
      }

      // Cycle 4: worker pushes fix, CI goes pending
      if (cycle === 4) {
        const item = orch.getItem("CF-4");
        if (item) item.lastCommitTime = new Date().toISOString();
        fakeGh.setCIStatus("ninthwave/CF-4", "pending");
      }

      // Cycle 5: CI fails again (ciFailCount -> 2)
      if (cycle === 5) {
        fakeGh.setCIStatus("ninthwave/CF-4", "fail");
      }

      // Cycle 7: worker pushes another fix, CI goes pending
      if (cycle === 7) {
        const item = orch.getItem("CF-4");
        if (item) item.lastCommitTime = new Date().toISOString();
        fakeGh.setCIStatus("ninthwave/CF-4", "pending");
      }

      // Cycle 8: CI fails again (ciFailCount -> 3)
      if (cycle === 8) {
        fakeGh.setCIStatus("ninthwave/CF-4", "fail");
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 20 });

    const finalItem = orch.getItem("CF-4");
    expect(finalItem).toBeDefined();
    // ciFailCount should be at least 3 (three failure cycles)
    expect(finalItem!.ciFailCount).toBeGreaterThanOrEqual(3);
  });

  it("notify-ci-failure action is emitted on first failure", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      sessionLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxCiRetries: 3,
      maxRetries: 3,
      enableStacking: false,
      fixForward: false,
      ciPendingFailGraceMs: 0,
    });

    orch.addItem(makeWorkItem("CF-5"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;

      // Cycle 2: worker creates PR, CI fails (MERGEABLE, not a conflict)
      if (cycle === 2) {
        fakeGh.createPR("ninthwave/CF-5", "Item CF-5");
        fakeGh.setCIStatus("ninthwave/CF-5", "fail");
        fakeGh.setMergeable("ninthwave/CF-5", "MERGEABLE");
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 10 });

    const finalItem = orch.getItem("CF-5");
    expect(finalItem).toBeDefined();
    expect(finalItem!.state).toBe("ci-failed");

    // Inbox should have been queued with a CI failure message
    const inboxCalls = (actionDeps.writeInbox as ReturnType<typeof import("vitest").vi.fn>).mock.calls;
    const ciFailureMessages = inboxCalls.filter(
      (call) => {
        const [projectRoot, itemId, msg] = call as [string, string, string];
        return projectRoot === finalItem!.worktreePath
          && itemId === "CF-5"
          && typeof msg === "string"
          && msg.includes("CI");
      },
    );
    expect(ciFailureMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("dead worker in ci-failed state is detected and respawned after debounce", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      sessionLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxCiRetries: 10,
      maxRetries: 3,
      enableStacking: false,
      fixForward: false,
      ciPendingFailGraceMs: 0,
    });

    orch.addItem(makeWorkItem("CF-6"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    const statesVisited: string[] = [];
    orch.config.onTransition = (_itemId, _from, to) => {
      statesVisited.push(to);
    };

    let cycle = 0;
    let workerRef: string | undefined;
    loopDeps.sleep = async () => {
      cycle++;

      // Cycle 2: worker creates PR, CI fails.
      // Set lastCommitTime so ciFailureNotifiedAt comparison is stable.
      if (cycle === 2) {
        const item = orch.getItem("CF-6");
        if (item) item.lastCommitTime = new Date().toISOString();
        fakeGh.createPR("ninthwave/CF-6", "Item CF-6");
        fakeGh.setCIStatus("ninthwave/CF-6", "fail");
        fakeGh.setMergeable("ninthwave/CF-6", "MERGEABLE");
      }

      // Cycle 4: kill the worker process (simulate headless worker dying)
      if (cycle === 4) {
        const item = orch.getItem("CF-6");
        workerRef = item?.workspaceRef;
        if (workerRef) fakeMux.setAlive(workerRef, false);
      }

      // After respawn (cycle ~10+): new worker fixes CI
      if (cycle === 12) {
        const item = orch.getItem("CF-6");
        if (item && item.state === "ci-failed") {
          // New worker pushes fix
          item.lastCommitTime = new Date().toISOString();
          fakeGh.setCIStatus("ninthwave/CF-6", "pending");
        }
      }

      if (cycle === 13) {
        fakeGh.setCIStatus("ninthwave/CF-6", "pass");
        fakeGh.setReviewDecision("ninthwave/CF-6", "APPROVED");
        const item = orch.getItem("CF-6");
        if (item) item.reviewCompleted = true;
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 40 });

    const finalItem = orch.getItem("CF-6");
    expect(finalItem).toBeDefined();
    expect(finalItem!.state).toBe("done");

    // Verify the item went through ready (respawn) after ci-failed
    expect(statesVisited).toContain("ci-failed");
    expect(statesVisited).toContain("done");

    // needsCiFix should have been set then cleared
    expect(finalItem!.needsCiFix).toBe(false);

    // closeWorkspace should have been called (cleanup before respawn)
    expect(actionDeps.closeWorkspace).toHaveBeenCalled();
  });

  it("unresponsive worker detected via ack timeout and respawned", () => {
    const orch = new Orchestrator({
      sessionLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxCiRetries: 10,
      maxRetries: 3,
      enableStacking: false,
      fixForward: false,
    });

    orch.addItem(makeWorkItem("CF-7"));
    const item = orch.getItem("CF-7")!;

    // Set up ci-failed state with notification sent and ack expired.
    // This tests the Layer 2 detection directly, avoiding orchestrateLoop timing issues.
    const commitTime = "2026-01-01T00:00:00Z";
    item.state = "ci-failed" as typeof item.state;
    item.prNumber = 1;
    item.ciFailCount = 1;
    item.ciFailureNotified = true;
    item.ciFailureNotifiedAt = commitTime;
    item.lastCommitTime = commitTime;
    item.ciNotifyWallAt = new Date(Date.now() - TIMEOUTS.ciFixAck - 60_000).toISOString();
    item.workspaceRef = "workspace:1";

    const snapshot = {
      items: [{
        id: "CF-7",
        ciStatus: "fail" as const,
        prNumber: 1,
        prState: "open" as const,
        isMergeable: true,
        workerAlive: true,  // TUI: process alive but AI exited
        lastHeartbeat: null,  // No heartbeat ack
        lastCommitTime: commitTime,
      }],
      readyIds: [],
    };

    const actions = orch.processTransitions(snapshot);

    // Ack timeout should trigger respawn (ready → launching in same processTransitions call)
    expect(item.state).toBe("launching");
    expect(item.needsCiFix).toBe(true);
    expect(actions.some(a => a.type === "retry" && a.itemId === "CF-7")).toBe(true);
  });

  it("worker that heartbeats after notification is NOT respawned (Layer 2 negative)", () => {
    const orch = new Orchestrator({
      sessionLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxCiRetries: 10,
      maxRetries: 3,
      enableStacking: false,
      fixForward: false,
    });

    orch.addItem(makeWorkItem("CF-8"));
    const item = orch.getItem("CF-8")!;

    // Set up ci-failed state with notification sent and ack timeout passed,
    // BUT the worker heartbeated AFTER the notification (worker is responsive).
    const commitTime = "2026-01-01T00:00:00Z";
    const notifyTime = new Date(Date.now() - TIMEOUTS.ciFixAck - 60_000);
    const heartbeatTime = new Date(notifyTime.getTime() + 30_000); // 30s after notification

    item.state = "ci-failed" as typeof item.state;
    item.prNumber = 1;
    item.ciFailCount = 1;
    item.ciFailureNotified = true;
    item.ciFailureNotifiedAt = commitTime;
    item.lastCommitTime = commitTime;
    item.ciNotifyWallAt = notifyTime.toISOString();
    item.workspaceRef = "workspace:1";

    const snapshot = {
      items: [{
        id: "CF-8",
        ciStatus: "fail" as const,
        prNumber: 1,
        prState: "open" as const,
        isMergeable: true,
        workerAlive: true,
        lastHeartbeat: { ts: heartbeatTime.toISOString(), progress: 0.5, label: "Fixing CI" },
        lastCommitTime: commitTime,
      }],
      readyIds: [],
    };

    orch.processTransitions(snapshot);

    // Worker should NOT be respawned -- it heartbeated after the notification
    expect(item.state).toBe("ci-failed");
    expect(item.needsCiFix).toBeUndefined();
  });

  // Note: respawnCiFixWorker does NOT consume retryCount. The guard against
  // infinite loops comes from ciFailCount/maxCiRetries (checked before detection)
  // and stuckOrRetry in the implementing handler (catches workers that die after relaunch).
});
