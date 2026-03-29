// Scenario test: items with dependencies execute in correct order.
// Exercises the real orchestrateLoop with dependency gating.

import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../../core/orchestrator.ts";
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

describe("scenario: dependency chain", () => {
  it("A -> B -> C: items launch and merge in order", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
    });
    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));
    orch.addItem(makeWorkItem("C-1", ["B-1"]));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    // Track launch order
    const launchOrder: string[] = [];
    const origLaunch = actionDeps.launchSingleItem;
    actionDeps.launchSingleItem = vi.fn((item, wd, wtd, pr, ai, bb) => {
      launchOrder.push(item.id);
      return (origLaunch as Function)(item, wd, wtd, pr, ai, bb);
    });

    loopDeps.sleep = async () => {
      // Simulate each item's lifecycle: create PR + pass CI once implementing
      for (const id of ["A-1", "B-1", "C-1"]) {
        const orchItem = orch.getItem(id);
        if (orchItem?.state === "implementing" && !fakeGh.getPR(`ninthwave/${id}`)) {
          completeItem(id, fakeGh, orch);
        }
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 60 });

    // All items should be done
    expect(orch.getItem("A-1")!.state).toBe("done");
    expect(orch.getItem("B-1")!.state).toBe("done");
    expect(orch.getItem("C-1")!.state).toBe("done");

    // Items must launch in dependency order
    expect(launchOrder).toEqual(["A-1", "B-1", "C-1"]);
  });

  it("parallel items with same dependency both launch after dep completes", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    // A has no deps, B and C both depend on A (fan-out)
    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
    });
    orch.addItem(makeWorkItem("A-1", [], "critical"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));
    orch.addItem(makeWorkItem("C-1", ["A-1"]));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    const launchOrder: string[] = [];
    const origLaunch = actionDeps.launchSingleItem;
    actionDeps.launchSingleItem = vi.fn((item, wd, wtd, pr, ai, bb) => {
      launchOrder.push(item.id);
      return (origLaunch as Function)(item, wd, wtd, pr, ai, bb);
    });

    loopDeps.sleep = async () => {
      for (const id of ["A-1", "B-1", "C-1"]) {
        const orchItem = orch.getItem(id);
        if (orchItem?.state === "implementing" && !fakeGh.getPR(`ninthwave/${id}`)) {
          completeItem(id, fakeGh, orch);
        }
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 60 });

    expect(orch.getItem("A-1")!.state).toBe("done");
    expect(orch.getItem("B-1")!.state).toBe("done");
    expect(orch.getItem("C-1")!.state).toBe("done");

    // A must launch first; B and C can be in either order
    expect(launchOrder[0]).toBe("A-1");
    expect(launchOrder).toContain("B-1");
    expect(launchOrder).toContain("C-1");
  });

  it("blocked item stays queued when dependency is stuck", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
      maxRetries: 0, // first failure = stuck
    });
    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    // Make launch fail so A goes stuck
    const actionDeps = buildActionDeps(fakeGh, fakeMux, {
      launchSingleItem: vi.fn(() => null),
    });
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 10 });

    expect(orch.getItem("A-1")!.state).toBe("stuck");
    expect(orch.getItem("B-1")!.state).toBe("queued");
  });
});
