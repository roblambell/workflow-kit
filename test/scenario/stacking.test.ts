// Scenario test: stacked branch lifecycle through the real orchestrateLoop.
// Exercises stacking scenarios with enableStacking: true:
// 1. Item B depends on A; A reaches ci-passed → B promotes from queued with baseBranch set, launch includes baseBranch
// 2. When A goes stuck, pre-session stacked B rolls back to queued with baseBranch cleared
// 3. When A's CI recovers from ci-failed to ci-pending, stacked implementing B receives a resume/rebase message
// 4. sync-stack-comments action is emitted when a stacked PR opens

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
} from "./helpers.ts";

describe("scenario: stacking", () => {
  it("dep in ci-passed promotes stacked item from queued with baseBranch, launch includes baseBranch", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      maxInflight: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: true,
      fixForward: false,
    });

    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    // Track launch calls to verify baseBranch parameter
    const launchCalls: Array<{ id: string; baseBranch?: string }> = [];
    const origLaunch = actionDeps.workers.launchSingleItem;
    actionDeps.workers.launchSingleItem = vi.fn((item, wd, wtd, pr, ai, bb) => {
      launchCalls.push({ id: item.id, baseBranch: bb });
      return (origLaunch as Function)(item, wd, wtd, pr, ai, bb);
    });

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;

      // Cycle 2: A creates PR, CI passes → next iteration detects ci-passed → B promoted
      if (cycle === 2) {
        fakeGh.createPR("ninthwave/A-1", "Item A-1");
        fakeGh.setCIStatus("ninthwave/A-1", "pass");
        fakeGh.setMergeable("ninthwave/A-1", "MERGEABLE");
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 15 });

    // B should have baseBranch set to A's branch
    const itemB = orch.getItem("B-1")!;
    expect(itemB).toBeDefined();
    expect(itemB.baseBranch).toBe("ninthwave/A-1");

    // B should have been promoted past queued (launched)
    expect(itemB.state).not.toBe("queued");

    // Launch call for B should include baseBranch
    const bLaunch = launchCalls.find((c) => c.id === "B-1");
    expect(bLaunch).toBeDefined();
    expect(bLaunch!.baseBranch).toBe("ninthwave/A-1");

    // A should have launched without baseBranch (no deps)
    const aLaunch = launchCalls.find((c) => c.id === "A-1");
    expect(aLaunch).toBeDefined();
    expect(aLaunch!.baseBranch).toBeUndefined();
  });

  it("stacked item rolls back to queued with baseBranch cleared when dep goes stuck", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    // maxInflight = 1: B gets promoted to ready but can't launch (sessions full with A).
    // maxCiRetries = 0: A goes stuck when CI failure is re-evaluated next cycle.
    const orch = new Orchestrator({
      maxInflight: 1,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: true,
      fixForward: false,
      maxCiRetries: 0,
    });

    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    // Verify B was actually promoted before being rolled back
    let bWasPromoted = false;
    orch.config.onTransition = (_itemId, from, to) => {
      if (_itemId === "B-1" && from === "queued" && to === "ready") {
        bWasPromoted = true;
      }
    };

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;

      // Cycle 2: A creates PR, CI passes → next iteration: A → ci-passed, B → ready (stacked)
      if (cycle === 2) {
        fakeGh.createPR("ninthwave/A-1", "Item A-1");
        fakeGh.setCIStatus("ninthwave/A-1", "pass");
        fakeGh.setMergeable("ninthwave/A-1", "MERGEABLE");
      }

      // Cycle 3: A's CI fails → next iteration: A → ci-failed (ciFailCount=1)
      // Iteration after that: ci-failed + ciFailCount > maxCiRetries(0) → stuck → B rollback
      if (cycle === 3) {
        fakeGh.setCIStatus("ninthwave/A-1", "fail");
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 15 });

    // B was promoted (stacked) before rollback
    expect(bWasPromoted).toBe(true);

    // A should be stuck (CI failed, maxCiRetries = 0)
    expect(orch.getItem("A-1")!.state).toBe("stuck");

    // B should have been rolled back to queued with baseBranch cleared
    const itemB = orch.getItem("B-1")!;
    expect(itemB.state).toBe("queued");
    expect(itemB.baseBranch).toBeUndefined();
  });

  it("stacked dependent receives resume message when dep CI recovers from ci-failed to ci-pending", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      maxInflight: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: true,
      fixForward: false,
      maxCiRetries: 5, // High limit so A doesn't go stuck
    });

    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    const actionDeps = buildActionDeps(fakeGh, fakeMux);
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;

      // Cycle 2: A creates PR, CI passes → A enters ci-passed → B promoted + launched (stacked)
      if (cycle === 2) {
        fakeGh.createPR("ninthwave/A-1", "Item A-1");
        fakeGh.setCIStatus("ninthwave/A-1", "pass");
        fakeGh.setMergeable("ninthwave/A-1", "MERGEABLE");
      }

      // Cycle 4: A's CI fails → A enters ci-failed
      if (cycle === 4) {
        fakeGh.setCIStatus("ninthwave/A-1", "fail");
      }

      // Cycle 6: A's CI goes back to pending (worker pushed fix) → A ci-failed → ci-pending → resume B
      if (cycle === 6) {
        const item = orch.getItem("A-1");
        if (item) item.lastCommitTime = new Date().toISOString();
        fakeGh.setCIStatus("ninthwave/A-1", "pending");
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 15 });

    // B should have been launched (has workspaceRef) and stacked
    const itemB = orch.getItem("B-1")!;
    expect(itemB.workspaceRef).toBeDefined();
    expect(itemB.baseBranch).toBe("ninthwave/A-1");

    // Inbox delivery should queue a resume message for B
    const inboxCalls = (actionDeps.io.writeInbox as ReturnType<typeof vi.fn>).mock.calls;
    const resumeMessages = inboxCalls.filter(
      (call) => {
        const [projectRoot, itemId, msg] = call as [string, string, string];
        return projectRoot === itemB.worktreePath
          && itemId === "B-1"
          && typeof msg === "string"
          && msg.includes("Resume")
          && msg.includes("A-1");
      },
    );
    expect(resumeMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("sync-stack-comments action is emitted when stacked PR opens", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      maxInflight: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: true,
      fixForward: false,
    });

    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    const syncStackComments = vi.fn();
    const actionDeps = buildActionDeps(fakeGh, fakeMux, { io: { syncStackComments } });
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;

      // Cycle 2: A creates PR, CI passes → A ci-passed → B promoted + launched (stacked)
      if (cycle === 2) {
        fakeGh.createPR("ninthwave/A-1", "Item A-1");
        fakeGh.setCIStatus("ninthwave/A-1", "pass");
        fakeGh.setMergeable("ninthwave/A-1", "MERGEABLE");
      }

      // Cycle 4: B creates its stacked PR → next iteration: B implementing → ci-pending with baseBranch → sync-stack-comments
      if (cycle === 4) {
        fakeGh.createPR("ninthwave/B-1", "Item B-1");
        fakeGh.setCIStatus("ninthwave/B-1", "pending");
        fakeGh.setMergeable("ninthwave/B-1", "MERGEABLE");
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 15 });

    // B should have baseBranch set
    const itemB = orch.getItem("B-1")!;
    expect(itemB.baseBranch).toBe("ninthwave/A-1");
    expect(itemB.prNumber).toBeDefined();

    // syncStackComments should have been called when B's stacked PR opened
    expect(syncStackComments).toHaveBeenCalled();
  });

  it("manual mode syncs the full stack onto earlier PRs as new stacked PRs open", async () => {
    const fakeGh = new FakeGitHub();
    const fakeMux = new FakeMux();

    const orch = new Orchestrator({
      maxInflight: 5,
      mergeStrategy: "manual",
      bypassEnabled: false,
      enableStacking: true,
      fixForward: false,
    });

    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));
    orch.addItem(makeWorkItem("C-1", ["B-1"]));

    // Simulate AI review already complete so manual mode parks items in review-pending.
    orch.getItem("A-1")!.reviewCompleted = true;
    orch.getItem("B-1")!.reviewCompleted = true;

    const syncStackComments = vi.fn();
    const actionDeps = buildActionDeps(fakeGh, fakeMux, { io: { syncStackComments } });
    const loopDeps = buildLoopDeps(fakeGh, fakeMux, actionDeps);

    let cycle = 0;
    loopDeps.sleep = async () => {
      cycle++;

      if (cycle === 2) {
        fakeGh.createPR("ninthwave/A-1", "Item A-1");
        fakeGh.setCIStatus("ninthwave/A-1", "pass");
        fakeGh.setMergeable("ninthwave/A-1", "MERGEABLE");
      }

      if (cycle === 4) {
        fakeGh.createPR("ninthwave/B-1", "Item B-1");
        fakeGh.setCIStatus("ninthwave/B-1", "pass");
        fakeGh.setMergeable("ninthwave/B-1", "MERGEABLE");
      }

      if (cycle === 6) {
        fakeGh.createPR("ninthwave/C-1", "Item C-1");
        fakeGh.setCIStatus("ninthwave/C-1", "pass");
        fakeGh.setMergeable("ninthwave/C-1", "MERGEABLE");
      }
    };

    await orchestrateLoop(orch, defaultCtx, loopDeps, { maxIterations: 18 });

    expect(syncStackComments).toHaveBeenCalledTimes(2);
    expect(syncStackComments).toHaveBeenNthCalledWith(
      1,
      "main",
      [
        { id: "A-1", prNumber: 1, title: "Item A-1" },
        { id: "B-1", prNumber: 2, title: "Item B-1" },
      ],
    );
    expect(syncStackComments).toHaveBeenNthCalledWith(
      2,
      "main",
      [
        { id: "A-1", prNumber: 1, title: "Item A-1" },
        { id: "B-1", prNumber: 2, title: "Item B-1" },
        { id: "C-1", prNumber: 3, title: "Item C-1" },
      ],
    );

    expect(orch.getItem("A-1")!.state).toBe("review-pending");
    expect(orch.getItem("B-1")!.state).toBe("review-pending");
  });
});
