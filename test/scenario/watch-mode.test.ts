// Scenario test: watch mode loop discovers new work items after initial items complete.
// Exercises orchestrateLoop with config.watch=true and an injected scanWorkItems function.

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

function makeOrch(): Orchestrator {
  return new Orchestrator({
    wipLimit: 5,
    mergeStrategy: "auto",
    bypassEnabled: false,
    enableStacking: false,
    verifyMain: false,
  });
}

describe("scenario: watch mode", () => {
  it("initial items complete, scanWorkItems returns new items, new items proceed to done", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();
    const orch = makeOrch();

    // Start with one initial item
    orch.addItem(makeWorkItem("W-1"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    // Track scanWorkItems calls
    let scanCallCount = 0;
    const scanWorkItems = vi.fn(() => {
      scanCallCount++;
      // On the first scan call, return a new work item
      if (scanCallCount === 1) {
        return [makeWorkItem("W-1"), makeWorkItem("W-2")];
      }
      // Subsequent scans: return all known items (W-1 and W-2)
      return [makeWorkItem("W-1"), makeWorkItem("W-2")];
    });
    loopDeps.scanWorkItems = scanWorkItems;

    // Auto-complete items as they reach implementing state
    loopDeps.sleep = async () => {
      for (const id of ["W-1", "W-2"]) {
        const orchItem = orch.getItem(id);
        if (orchItem?.state === "implementing" && !fakeGh.getPR(`ninthwave/${id}`)) {
          completeItem(id, fakeGh, orch);
        }
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, {
      maxIterations: 80,
      watch: true,
    });

    // Both items should reach done
    expect(orch.getItem("W-1")!.state).toBe("done");
    expect(orch.getItem("W-2")!.state).toBe("done");

    // scanWorkItems must have been called
    expect(scanWorkItems).toHaveBeenCalled();

    // Verify watch_new_items log event with correct newIds
    const watchNewLog = loopDeps.__logs.find(
      (l) => l.event === "watch_new_items",
    );
    expect(watchNewLog).toBeDefined();
    expect(watchNewLog!.newIds).toEqual(["W-2"]);
    expect(watchNewLog!.count).toBe(1);
  });

  it("scanWorkItems returns empty repeatedly, loop continues polling until maxIterations", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();
    const orch = makeOrch();

    // Start with one item that will complete quickly
    orch.addItem(makeWorkItem("W-3"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    // scanWorkItems always returns the same item (no new items)
    const scanWorkItems = vi.fn(() => [makeWorkItem("W-3")]);
    loopDeps.scanWorkItems = scanWorkItems;

    // Auto-complete W-3
    loopDeps.sleep = async () => {
      const orchItem = orch.getItem("W-3");
      if (orchItem?.state === "implementing" && !fakeGh.getPR("ninthwave/W-3")) {
        completeItem("W-3", fakeGh, orch);
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, {
      maxIterations: 30,
      watch: true,
    });

    // W-3 should be done
    expect(orch.getItem("W-3")!.state).toBe("done");

    // Verify watch mode entered waiting state
    const watchWaitLog = loopDeps.__logs.find(
      (l) => l.event === "watch_mode_waiting",
    );
    expect(watchWaitLog).toBeDefined();

    // scanWorkItems was called multiple times during polling (no new items ever found)
    expect(scanWorkItems.mock.calls.length).toBeGreaterThan(1);

    // No watch_new_items event (nothing was discovered)
    const watchNewLog = loopDeps.__logs.find(
      (l) => l.event === "watch_new_items",
    );
    expect(watchNewLog).toBeUndefined();
  });

  it("new items with deps on completed items launch immediately", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();
    const orch = makeOrch();

    // Start with one initial item
    orch.addItem(makeWorkItem("D-1"));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    // Track launch order
    const launchOrder: string[] = [];
    const origLaunch = actionDeps.launchSingleItem;
    actionDeps.launchSingleItem = vi.fn((item, wd, wtd, pr, ai, bb) => {
      launchOrder.push(item.id);
      return (origLaunch as Function)(item, wd, wtd, pr, ai, bb);
    });

    // After initial items complete, return a new item that depends on D-1
    let scanCallCount = 0;
    const scanWorkItems = vi.fn(() => {
      scanCallCount++;
      if (scanCallCount === 1) {
        // Return D-1 (existing) + D-2 (new, depends on D-1)
        return [makeWorkItem("D-1"), makeWorkItem("D-2", ["D-1"])];
      }
      return [makeWorkItem("D-1"), makeWorkItem("D-2", ["D-1"])];
    });
    loopDeps.scanWorkItems = scanWorkItems;

    // Auto-complete items as they reach implementing state
    loopDeps.sleep = async () => {
      for (const id of ["D-1", "D-2"]) {
        const orchItem = orch.getItem(id);
        if (orchItem?.state === "implementing" && !fakeGh.getPR(`ninthwave/${id}`)) {
          completeItem(id, fakeGh, orch);
        }
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, {
      maxIterations: 80,
      watch: true,
    });

    // Both items should reach done
    expect(orch.getItem("D-1")!.state).toBe("done");
    expect(orch.getItem("D-2")!.state).toBe("done");

    // D-1 launched first, D-2 launched after (dependency already satisfied)
    expect(launchOrder).toContain("D-1");
    expect(launchOrder).toContain("D-2");
    expect(launchOrder.indexOf("D-1")).toBeLessThan(launchOrder.indexOf("D-2"));

    // D-2 should have been added via the watch scan
    const watchNewLog = loopDeps.__logs.find(
      (l) => l.event === "watch_new_items",
    );
    expect(watchNewLog).toBeDefined();
    expect(watchNewLog!.newIds).toEqual(["D-2"]);
  });
});
