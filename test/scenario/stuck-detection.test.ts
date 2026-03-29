// Scenario test: stuck detection -- worker death, debounce, retry, and exhaustion.
// Exercises the real orchestrateLoop with FakeGitHub and FakeMux to simulate
// worker crashes via FakeMux.setAlive(ref, false).

import { describe, it, expect } from "vitest";
import {
  Orchestrator,
  NOT_ALIVE_THRESHOLD,
} from "../../core/orchestrator.ts";
import { orchestrateLoop } from "../../core/commands/orchestrate.ts";
import { FakeGitHub } from "../fakes/fake-github.ts";
import { FakeMux } from "../fakes/fake-mux.ts";
import {
  makeWorkItem,
  defaultCtx,
  buildActionDeps,
  buildLoopDeps,
  completeItem,
} from "./helpers.ts";

describe("scenario: stuck detection", () => {
  it("worker dies during implementing, debounce triggers retry, item recovers", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxRetries: 1,
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("S-1"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    let workerKilled = false;
    let prCreated = false;

    loopDeps.sleep = async () => {
      const item = orch.getItem("S-1")!;

      // Kill the worker once it reaches implementing (first attempt)
      if (item.state === "implementing" && !workerKilled && item.workspaceRef) {
        fakeMux.setAlive(item.workspaceRef, false);
        workerKilled = true;
      }

      // After retry succeeds and item is implementing again, create PR to complete
      if (
        item.state === "implementing" &&
        item.retryCount === 1 &&
        !prCreated
      ) {
        completeItem("S-1", fakeGh, orch);
        prCreated = true;
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 30 });

    const item = orch.getItem("S-1")!;
    expect(item.state).toBe("done");
    expect(item.retryCount).toBe(1);
    // Launch called twice: initial + retry relaunch
    expect(actionDeps.launchSingleItem).toHaveBeenCalledTimes(2);
  });

  it("worker dies and retry exhausted, item goes stuck with failureReason", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxRetries: 1,
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("S-2"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    loopDeps.sleep = async () => {
      const item = orch.getItem("S-2")!;

      // Kill every worker that reaches implementing
      if (item.state === "implementing" && item.workspaceRef) {
        const ws = fakeMux.getWorkspace(item.workspaceRef);
        if (ws && ws.alive) {
          fakeMux.setAlive(item.workspaceRef, false);
        }
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 30 });

    const item = orch.getItem("S-2")!;
    expect(item.state).toBe("stuck");
    expect(item.failureReason).toContain("worker-crashed");
    expect(item.retryCount).toBe(1);
    // workspace-close action emitted on stuck transition
    expect(actionDeps.closeWorkspace).toHaveBeenCalled();
  });

  it("worker dies during launching state, debounce and retry logic applies", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxRetries: 1,
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("S-3"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    let launchKilled = false;
    let prCreated = false;

    loopDeps.sleep = async () => {
      const item = orch.getItem("S-3")!;

      // Kill worker during launching state (before it can transition to implementing)
      if (item.state === "launching" && item.workspaceRef && !launchKilled) {
        fakeMux.setAlive(item.workspaceRef, false);
        launchKilled = true;
      }

      // After retry succeeds and item is implementing, create PR to complete
      if (
        item.state === "implementing" &&
        item.retryCount === 1 &&
        !prCreated
      ) {
        completeItem("S-3", fakeGh, orch);
        prCreated = true;
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 30 });

    const item = orch.getItem("S-3")!;
    expect(item.state).toBe("done");
    expect(item.retryCount).toBe(1);
    // Launch called twice: initial + retry relaunch
    expect(actionDeps.launchSingleItem).toHaveBeenCalledTimes(2);
  });

  it("debounce: single not-alive poll does NOT trigger stuck", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxRetries: 0, // no retries -- would go straight to stuck if threshold hit
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("S-4"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    let killCycle = 0;

    loopDeps.sleep = async () => {
      const item = orch.getItem("S-4")!;

      // Kill worker once it reaches implementing
      if (item.state === "implementing" && item.workspaceRef && killCycle === 0) {
        fakeMux.setAlive(item.workspaceRef, false);
        killCycle = 1;
      } else if (killCycle > 0) {
        killCycle++;
      }
    };

    // Run for just enough cycles to get to implementing + a few not-alive polls,
    // but NOT enough for the threshold. Cycle budget:
    // Cycle 1: queued→ready→launching (launch action)
    // Cycle 2: launching→implementing
    // Cycle 3-5: implementing, worker dead (notAliveCount 1-3)
    // Stop at 5 cycles: notAliveCount should be 3 (< NOT_ALIVE_THRESHOLD of 5)
    const cyclesForLaunch = 2;
    const notAlivePollsBeforeThreshold = NOT_ALIVE_THRESHOLD - 2; // 3 polls, safely below threshold
    await orchestrateLoop(orch, defaultCtx, loopDeps, {
      maxIterations: cyclesForLaunch + notAlivePollsBeforeThreshold,
    });

    const item = orch.getItem("S-4")!;
    // Item should still be implementing, NOT stuck
    expect(item.state).toBe("implementing");
    expect(item.notAliveCount).toBeGreaterThan(0);
    expect(item.notAliveCount).toBeLessThan(NOT_ALIVE_THRESHOLD);
  });

  it("notAliveCount resets when worker comes back alive", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxRetries: 0,
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("S-5"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    let cycle = 0;
    let wsRef: string | undefined;

    loopDeps.sleep = async () => {
      cycle++;
      const item = orch.getItem("S-5")!;

      if (item.state === "implementing" && item.workspaceRef) {
        wsRef = item.workspaceRef;
      }

      // Kill worker for 2 cycles, then revive it
      if (cycle === 3 && wsRef) {
        fakeMux.setAlive(wsRef, false);
      }
      if (cycle === 5 && wsRef) {
        // Revive worker before reaching threshold
        fakeMux.setAlive(wsRef, true);
      }
    };

    // Run enough cycles: 2 to launch + 4 more to kill/revive + 2 buffer
    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 8 });

    const item = orch.getItem("S-5")!;
    // Item should still be implementing (worker came back alive)
    expect(item.state).toBe("implementing");
    // notAliveCount should be reset to 0 after worker came back alive
    expect(item.notAliveCount).toBe(0);
  });
});
