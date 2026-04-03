import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "fs";
import { CliHarness } from "./helpers/cli-harness.ts";
import {
  createFakeAiRun,
  fakeAiArtifactDir,
  fakeAiExitScenario,
  fakeAiHangScenario,
  fakeAiHeartbeatPath,
  fakeAiSuccessScenario,
  readFakeAiContext,
  readFakeAiPrompt,
  readFakeAiState,
} from "./helpers/fake-ai-scenario.ts";
import { cleanupTempRepos, waitFor } from "../helpers.ts";

const WORK_ITEMS = `
## System Harness

### Build deterministic harness helper (H-SYS-1)
**Priority:** High
**Source:** Test
**Domain:** system-test-harness
**Lineage:** 11111111-1111-4111-8111-111111111111

Primary system harness item.

### Exercise secondary worker path (H-SYS-2)
**Priority:** High
**Source:** Test
**Domain:** system-test-harness
**Lineage:** 22222222-2222-4222-8222-222222222222

Secondary worker harness item.

### Capture non-zero exits (H-SYS-3)
**Priority:** High
**Source:** Test
**Domain:** system-test-harness
**Lineage:** 33333333-3333-4333-8333-333333333333

Failing worker harness item.
`;

describe("system harness helpers", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("captures item, tool, agent, prompt, and state context from a headless implementation launch", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(WORK_ITEMS);

    const run = createFakeAiRun(
      harness.projectRoot,
      fakeAiSuccessScenario({
        stdout: ["fake worker started", "fake worker finished"],
        heartbeat: { progress: 0.3, label: "Writing code" },
      }),
      { runId: "impl-success" },
    );

    const launched = harness.launchHeadlessItem("H-SYS-1", run, { tool: "codex" });
    expect(launched).not.toBeNull();
    expect(launched!.workspaceRef).toBe("headless:H-SYS-1");

    await harness.waitForHeadlessExit(launched!.workspaceRef);
    await harness.waitForHeadlessLog(launched!.workspaceRef, "fake worker finished");
    await waitFor(() => existsSync(fakeAiArtifactDir(harness.stateDir, run.runId)), {
      description: "fake AI artifacts",
    });

    const context = readFakeAiContext(harness.stateDir, run.runId);
    const state = readFakeAiState(harness.stateDir, run.runId);
    const prompt = readFakeAiPrompt(harness.stateDir, run.runId);

    expect(context.itemId).toBe("H-SYS-1");
    expect(context.tool).toBe("codex");
    expect(context.mode).toBe("headless");
    expect(context.agent).toBe("ninthwave-implementer");
    expect(context.stateDir).toBe(harness.stateDir);
    expect(context.projectRoot).toBe(harness.projectRoot);
    expect(context.workspaceName).toContain("H-SYS-1");
    expect(prompt).toContain("YOUR_WORK_ITEM_ID: H-SYS-1");
    expect(prompt).toContain("YOUR_PARTITION:");
    expect(prompt).toContain("PROJECT_ROOT:");
    expect(state.status).toBe("completed");
    expect(state.behavior).toBe("success");
    expect(harness.readHeadlessLog(launched!.workspaceRef)).toContain("fake worker started");
    expect(existsSync(fakeAiHeartbeatPath(harness.stateDir, "H-SYS-1"))).toBe(true);
  });

  it("captures deterministic failure artifacts and headless logs for non-zero exits", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(WORK_ITEMS);

    const run = createFakeAiRun(
      harness.projectRoot,
      fakeAiExitScenario(17, {
        stdout: ["about to fail"],
        stderr: ["simulated failure"],
      }),
      { runId: "impl-failure" },
    );

    const launched = harness.launchHeadlessItem("H-SYS-3", run, { tool: "claude" });
    expect(launched).not.toBeNull();

    await harness.waitForHeadlessExit(launched!.workspaceRef);
    await harness.waitForHeadlessLog(launched!.workspaceRef, "simulated failure");

    const state = readFakeAiState(harness.stateDir, run.runId);
    expect(state.status).toBe("failed");
    expect(state.exitCode).toBe(17);
    expect(harness.readHeadlessLog(launched!.workspaceRef)).toContain("about to fail");
  });

  it("supports hanging secondary-worker launches and cleans them up deterministically", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(WORK_ITEMS);

    const implementerRun = createFakeAiRun(
      harness.projectRoot,
      fakeAiSuccessScenario({ stdout: ["seed implementer"] }),
      { runId: "seed-implementer" },
    );
    const implementer = harness.launchHeadlessItem("H-SYS-2", implementerRun);
    expect(implementer).not.toBeNull();
    await harness.waitForHeadlessExit(implementer!.workspaceRef);

    const reviewerRun = createFakeAiRun(
      harness.projectRoot,
      fakeAiHangScenario({ stdout: ["review worker hanging"] }),
      { runId: "review-hang" },
    );

    const reviewer = harness.launchHeadlessReview(42, "H-SYS-2", reviewerRun, {
      autoFixMode: "off",
      tool: "claude",
    });
    expect(reviewer).not.toBeNull();

    await harness.waitForHeadlessLog(reviewer!.workspaceRef, "review worker hanging");
    await waitFor(() => {
      const state = readFakeAiState(harness.stateDir, reviewerRun.runId);
      return state.status === "hanging" ? state : false;
    }, { description: "review worker to enter hanging state" });

    const context = readFakeAiContext(harness.stateDir, reviewerRun.runId);
    expect(context.agent).toBe("ninthwave-reviewer");
    expect(context.itemId).toBe("H-SYS-2");

    expect(harness.closeHeadlessWorkspace(reviewer!.workspaceRef)).toBe(true);
    await harness.waitForHeadlessExit(reviewer!.workspaceRef);

    const finalState = readFakeAiState(harness.stateDir, reviewerRun.runId);
    expect(finalState.behavior).toBe("hang");
  });

  it("smoke-tests temp repo setup plus CLI invocation through the harness", () => {
    const harness = new CliHarness();

    const result = harness.run(["status", "--once"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ninthwave");
    expect(result.stderr).not.toContain("Error");
  });
});
