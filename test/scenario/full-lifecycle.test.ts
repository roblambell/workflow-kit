// Scenario test: single work item from queued -> done.
// Exercises the real orchestrateLoop, buildSnapshot, processTransitions, and executeAction
// with FakeGitHub and FakeMux injected at the external boundaries.

import { describe, it, expect } from "vitest";
import { Orchestrator } from "../../core/orchestrator.ts";
import { orchestrateLoop } from "../../core/commands/orchestrate.ts";
import { FakeGitHub } from "../fakes/fake-github.ts";
import { FakeMux } from "../fakes/fake-mux.ts";
import { FakeWorker } from "../fakes/fake-worker.ts";
import {
  makeWorkItem,
  defaultCtx,
  buildActionDeps,
  buildLoopDeps,
} from "./helpers.ts";

describe("scenario: full lifecycle", () => {
  it("single item: queued -> ready -> launching -> implementing -> ci-pending -> ci-passed -> merging -> merged -> done", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      maxCiRetries: 3,
      maxRetries: 3,
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("H-1"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    // Use FakeWorker to drive the simulation via a declarative script
    const worker = new FakeWorker(fakeGh, fakeMux, orch, [
      {
        cycle: 2,
        events: [
          { type: "createPR", branch: "ninthwave/H-1", title: "Item H-1" },
          { type: "setCIStatus", branch: "ninthwave/H-1", status: "pending" },
          { type: "setMergeable", branch: "ninthwave/H-1", mergeable: "MERGEABLE" },
        ],
      },
      {
        cycle: 3,
        events: [
          { type: "setCIStatus", branch: "ninthwave/H-1", status: "pass" },
          { type: "setReviewDecision", branch: "ninthwave/H-1", decision: "APPROVED" },
          { type: "markReviewCompleted", itemId: "H-1" },
        ],
      },
    ]);
    loopDeps.sleep = worker.sleep;

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 20 });

    const finalItem = orch.getItem("H-1");
    expect(finalItem).toBeDefined();
    expect(finalItem!.state).toBe("done");
    expect(actionDeps.launchSingleItem).toHaveBeenCalledTimes(1);
    expect(actionDeps.prMerge).toHaveBeenCalled();
    expect(fakeGh.getPR("ninthwave/H-1")!.state).toBe("merged");
  });

  it("item with no PR stays implementing until PR appears", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("H-2"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 5 });

    const finalItem = orch.getItem("H-2");
    expect(finalItem).toBeDefined();
    // Not stuck yet -- within timeout, just no PR created
    expect(["launching", "implementing"]).toContain(finalItem!.state);
  });

  it("CI failure increments ciFailCount and moves to ci-failed", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
    });

    orch.addItem(makeWorkItem("H-3"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    // Use FakeWorker: PR appears with failing CI at cycle 2
    const worker = new FakeWorker(fakeGh, fakeMux, null, [
      {
        cycle: 2,
        events: [
          { type: "createPR", branch: "ninthwave/H-3", title: "Item H-3" },
          { type: "setCIStatus", branch: "ninthwave/H-3", status: "fail" },
          { type: "setMergeable", branch: "ninthwave/H-3", mergeable: "MERGEABLE" },
        ],
      },
    ]);
    loopDeps.sleep = worker.sleep;

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 8 });

    const finalItem = orch.getItem("H-3");
    expect(finalItem).toBeDefined();
    expect(finalItem!.state).toBe("ci-failed");
    expect(finalItem!.ciFailCount).toBeGreaterThanOrEqual(1);
  });
});
