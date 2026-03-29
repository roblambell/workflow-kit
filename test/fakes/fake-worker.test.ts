// Unit tests for FakeWorker: verify script-driven events fire at correct cycles.

import { describe, it, expect } from "vitest";
import { FakeGitHub } from "./fake-github.ts";
import { FakeMux } from "./fake-mux.ts";
import { FakeWorker, type ScriptEntry } from "./fake-worker.ts";

describe("FakeWorker", () => {
  it("fires setScreen and createPR at correct cycles", async () => {
    const gh = new FakeGitHub();
    const mux = new FakeMux();
    const ref = mux.launchWorkspace("/tmp", "claude", "H-1")!;

    const script: ScriptEntry[] = [
      {
        cycle: 2,
        events: [{ type: "setScreen", ref, content: "spinner..." }],
      },
      {
        cycle: 4,
        events: [
          { type: "createPR", branch: "ninthwave/H-1", title: "Item H-1" },
        ],
      },
    ];

    const worker = new FakeWorker(gh, mux, null, script);

    // Cycle 1: no events
    await worker.sleep();
    expect(mux.readScreen(ref)).toBe("❯ "); // unchanged default
    expect(gh.getPR("ninthwave/H-1")).toBeUndefined();

    // Cycle 2: setScreen fires
    await worker.sleep();
    expect(mux.readScreen(ref)).toBe("spinner...");
    expect(gh.getPR("ninthwave/H-1")).toBeUndefined();

    // Cycle 3: no events
    await worker.sleep();
    expect(gh.getPR("ninthwave/H-1")).toBeUndefined();

    // Cycle 4: createPR fires
    await worker.sleep();
    const pr = gh.getPR("ninthwave/H-1");
    expect(pr).toBeDefined();
    expect(pr!.title).toBe("Item H-1");
    expect(pr!.state).toBe("open");

    expect(worker.firedAt).toEqual([2, 4]);
    expect(worker.currentCycle).toBe(4);
  });

  it("fires setCIStatus, setReviewDecision, setMergeable at correct cycles", async () => {
    const gh = new FakeGitHub();
    const mux = new FakeMux();

    gh.createPR("ninthwave/X-1", "Item X-1");

    const script: ScriptEntry[] = [
      {
        cycle: 1,
        events: [
          { type: "setCIStatus", branch: "ninthwave/X-1", status: "pending" },
          { type: "setMergeable", branch: "ninthwave/X-1", mergeable: "MERGEABLE" },
        ],
      },
      {
        cycle: 3,
        events: [
          { type: "setCIStatus", branch: "ninthwave/X-1", status: "pass" },
          { type: "setReviewDecision", branch: "ninthwave/X-1", decision: "APPROVED" },
        ],
      },
    ];

    const worker = new FakeWorker(gh, mux, null, script);

    await worker.sleep(); // cycle 1
    expect(gh.getPR("ninthwave/X-1")!.ciStatus).toBe("pending");
    expect(gh.getPR("ninthwave/X-1")!.mergeable).toBe("MERGEABLE");

    await worker.sleep(); // cycle 2: no events
    expect(gh.getPR("ninthwave/X-1")!.ciStatus).toBe("pending");

    await worker.sleep(); // cycle 3
    expect(gh.getPR("ninthwave/X-1")!.ciStatus).toBe("pass");
    expect(gh.getPR("ninthwave/X-1")!.reviewDecision).toBe("APPROVED");
  });

  it("fires markReviewCompleted with orchestrator", async () => {
    const gh = new FakeGitHub();
    const mux = new FakeMux();

    // Minimal orchestrator mock with getItem
    const orchItem = { reviewCompleted: false };
    const orch = {
      getItem: (id: string) => (id === "H-1" ? orchItem : undefined),
    } as any;

    const script: ScriptEntry[] = [
      {
        cycle: 2,
        events: [{ type: "markReviewCompleted", itemId: "H-1" }],
      },
    ];

    const worker = new FakeWorker(gh, mux, orch, script);

    await worker.sleep(); // cycle 1
    expect(orchItem.reviewCompleted).toBe(false);

    await worker.sleep(); // cycle 2
    expect(orchItem.reviewCompleted).toBe(true);
  });

  it("empty script is a no-op", async () => {
    const gh = new FakeGitHub();
    const mux = new FakeMux();

    const worker = new FakeWorker(gh, mux, null, []);

    // Run several cycles -- nothing should happen
    await worker.sleep();
    await worker.sleep();
    await worker.sleep();

    expect(worker.firedAt).toEqual([]);
    expect(worker.currentCycle).toBe(3);
  });

  it("multiple events at same cycle all fire", async () => {
    const gh = new FakeGitHub();
    const mux = new FakeMux();
    const ref = mux.launchWorkspace("/tmp", "claude")!;

    const script: ScriptEntry[] = [
      {
        cycle: 1,
        events: [
          { type: "setScreen", ref, content: "working..." },
          { type: "createPR", branch: "ninthwave/Z-1", title: "Item Z-1" },
        ],
      },
    ];

    const worker = new FakeWorker(gh, mux, null, script);
    await worker.sleep();

    expect(mux.readScreen(ref)).toBe("working...");
    expect(gh.getPR("ninthwave/Z-1")).toBeDefined();
    expect(worker.firedAt).toEqual([1]);
  });

  it("multiple script entries at same cycle are merged", async () => {
    const gh = new FakeGitHub();
    const mux = new FakeMux();
    const ref = mux.launchWorkspace("/tmp", "claude")!;

    // Two separate ScriptEntry objects targeting the same cycle
    const script: ScriptEntry[] = [
      {
        cycle: 2,
        events: [{ type: "setScreen", ref, content: "step1" }],
      },
      {
        cycle: 2,
        events: [{ type: "createPR", branch: "ninthwave/M-1", title: "Item M-1" }],
      },
    ];

    const worker = new FakeWorker(gh, mux, null, script);
    await worker.sleep(); // cycle 1: nothing
    await worker.sleep(); // cycle 2: both entries fire

    expect(mux.readScreen(ref)).toBe("step1");
    expect(gh.getPR("ninthwave/M-1")).toBeDefined();
  });
});
