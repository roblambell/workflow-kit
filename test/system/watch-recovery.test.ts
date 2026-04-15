import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import type { DaemonState } from "../../core/daemon.ts";
import {
  TEST_ORCH_ACTIVITY_TIMEOUT_MS_ENV,
  TEST_ORCH_GRACE_PERIOD_MS_ENV,
  TEST_ORCH_LAUNCH_TIMEOUT_MS_ENV,
} from "../../core/commands/orchestrate.ts";
import { TEST_LAUNCH_OVERRIDE_COMMAND_ENV } from "../../core/commands/launch.ts";
import { cleanupTempRepos } from "../helpers.ts";
import { CliHarness } from "./helpers/cli-harness.ts";
import {
  DEFAULT_FAKE_AI_SCRIPT,
  FAKE_AI_RUN_ID_ENV,
  FAKE_AI_SCENARIO_ENV,
  createFakeAiRun,
  fakeAiHeartbeatPath,
  fakeAiHangScenario,
  fakeAiExitScenario,
  readFakeAiLaunches,
} from "./helpers/fake-ai-scenario.ts";
import { waitFor } from "../helpers.ts";
import { writeHeadlessPhase, readHeadlessPhase } from "../../core/headless.ts";

const TEST_BIN_DIR = join(import.meta.dirname, "..", "bin");

const RECOVERY_ITEM = `
## Watch Recovery

### Recover and retry a persisted headless watch worker (H-WRR-1)
**Priority:** High
**Source:** Test
**Domain:** watch-recovery-tests
**Lineage:** 33333333-cccc-4ccc-8ccc-333333333333

Recovery coverage for shutdown, restart, and timeout retry behavior.

Acceptance: Persisted watch state resumes without duplicate launches and retries hung workers deterministically.

Key files: \`test/system/watch-recovery.test.ts\`
`;

function buildCliEnv(harness: CliHarness, runId: string, scenarioPath: string, extraEnv: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${TEST_BIN_DIR}:${process.env.PATH ?? ""}`,
    [TEST_LAUNCH_OVERRIDE_COMMAND_ENV]: DEFAULT_FAKE_AI_SCRIPT,
    [FAKE_AI_SCENARIO_ENV]: scenarioPath,
    [FAKE_AI_RUN_ID_ENV]: runId,
    NINTHWAVE_FAKE_GH_STATE_PATH: join(harness.stateDir, "fake-gh.json"),
    NINTHWAVE_FAKE_GH_REPO: "ninthwave-io/ninthwave-system-test",
    NINTHWAVE_FAKE_GH_AUTO_CREATE_PRS: "0",
    NINTHWAVE_MUX: "headless",
    ...extraEnv,
  };
}

function startRecoveryChild(
  harness: CliHarness,
  env: Record<string, string>,
) {
  return harness.start([
    "--_interactive-engine-child",
    "--items", "H-WRR-1",
    "--watch",
    "--tool", "codex",
    "--merge-strategy", "auto",
    "--session-limit", "1",
    "--no-review",
    "--skip-preflight",
    "--poll-interval", "0",
    "--watch-interval", "0",
  ], {
    env,
    keepStdinOpen: true,
  });
}

function readRecoveryItemState(harness: CliHarness): DaemonState["items"][number] | undefined {
  return harness.readOrchestratorState()?.items.find((entry) => entry.id === "H-WRR-1");
}

describe("system: watch recovery", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("resumes a gracefully shut down run from persisted state without relaunching the worker", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(RECOVERY_ITEM);
    harness.commitAndPushWorkItems("Add watch recovery test item");

    const run = createFakeAiRun(
      harness.projectRoot,
      fakeAiHangScenario({
        stdout: ["recovery worker hanging"],
      }),
      { runId: "watch-recovery-graceful" },
    );
    const env = buildCliEnv(harness, run.runId, run.scenarioPath);
    const processHandle = startRecoveryChild(harness, env);

    try {
      await harness.waitForOrchestratorState((state) => {
        const item = state.items.find((entry) => entry.id === "H-WRR-1");
        return item?.state === "implementing" ? item : false;
      }, 10_000);
      await harness.waitForHeadlessLog("headless:H-WRR-1", "recovery worker hanging");

      expect(readFakeAiLaunches(harness.stateDir, run.runId)).toHaveLength(1);
      expect(readRecoveryItemState(harness)?.state).toBe("implementing");
      expect(readRecoveryItemState(harness)?.workspaceRef).toBe("headless:H-WRR-1");

      harness.writeToProcess(processHandle, `${JSON.stringify({
        type: "shutdown",
        source: "system-test",
      })}\n`);
      await harness.waitForProcessOutput(processHandle, /"event":"shutdown_requested"/, {
        timeoutMs: 10_000,
      });
      await harness.waitForExit(processHandle, 10_000);

      const persistedState = harness.readOrchestratorState();
      expect(persistedState?.items.find((entry) => entry.id === "H-WRR-1")?.state).toBe("implementing");
      expect(existsSync(join(harness.stateDir, "orchestrator.pid"))).toBe(false);

      const restarted = startRecoveryChild(harness, env);
      try {
        await harness.waitForOrchestratorState((state) => {
          const item = state.items.find((entry) => entry.id === "H-WRR-1");
          return item?.state === "implementing" ? item : false;
        }, 10_000);

        expect(readFakeAiLaunches(harness.stateDir, run.runId)).toHaveLength(1);
        expect(readRecoveryItemState(harness)?.workspaceRef).toBe("headless:H-WRR-1");
      } finally {
        await harness.stop(restarted, "SIGKILL");
      }
    } finally {
      await harness.stop(processHandle, "SIGKILL");
    }
  }, 30_000);

  it("persists timeout-extension state across crash recovery", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(RECOVERY_ITEM);
    harness.commitAndPushWorkItems("Add watch recovery timeout-extension item");

    const run = createFakeAiRun(
      harness.projectRoot,
      fakeAiHangScenario({
        stdout: ["retry worker hanging"],
      }),
      { runId: "watch-recovery-retry" },
    );
    const env = buildCliEnv(harness, run.runId, run.scenarioPath, {
      [TEST_ORCH_LAUNCH_TIMEOUT_MS_ENV]: "100",
      [TEST_ORCH_ACTIVITY_TIMEOUT_MS_ENV]: "100",
      [TEST_ORCH_GRACE_PERIOD_MS_ENV]: "1250",
    });
    const processHandle = startRecoveryChild(harness, env);

    try {
      await harness.waitForOrchestratorState((state) => {
        const item = state.items.find((entry) => entry.id === "H-WRR-1");
        return item?.state === "implementing" ? item : false;
      }, 15_000);
      await harness.waitForHeadlessLog("headless:H-WRR-1", "retry worker hanging");
      rmSync(fakeAiHeartbeatPath(harness.stateDir, "H-WRR-1"), { force: true });

      const timedOutState = await harness.waitForOrchestratorState((state) => {
        const item = state.items.find((entry) => entry.id === "H-WRR-1");
        return item?.timeoutDeadline ? item : false;
      }, 10_000);
      const firstDeadline = timedOutState.timeoutDeadline!;

      harness.writeToProcess(processHandle, `${JSON.stringify({
        type: "extend-timeout",
        itemId: "H-WRR-1",
        source: "system-test",
      })}\n`);
      await harness.waitForProcessOutput(processHandle, /"event":"timeout_extended"/, {
        timeoutMs: 10_000,
      });

      const extendedState = await harness.waitForOrchestratorState((state) => {
        const item = state.items.find((entry) => entry.id === "H-WRR-1");
        return item?.timeoutExtensionCount === 1 ? item : false;
      }, 15_000);
      expect(new Date(extendedState.timeoutDeadline!).getTime()).toBeGreaterThan(new Date(firstDeadline).getTime());
      expect(readFakeAiLaunches(harness.stateDir, run.runId)).toHaveLength(1);

      await harness.stop(processHandle, "SIGKILL");
      const persistedAfterCrash = readRecoveryItemState(harness);
      expect(persistedAfterCrash?.state).toBe("implementing");
      expect(persistedAfterCrash?.timeoutDeadline).toBe(extendedState.timeoutDeadline);
      expect(persistedAfterCrash?.timeoutExtensionCount).toBe(1);

      const restarted = startRecoveryChild(harness, env);
      try {
        const restoredState = await harness.waitForOrchestratorState((state) => {
          const item = state.items.find((entry) => entry.id === "H-WRR-1");
          return item?.timeoutExtensionCount === 1 ? item : false;
        }, 15_000);
        expect(restoredState.state).toBe("implementing");
        expect(restoredState.timeoutDeadline).toBe(extendedState.timeoutDeadline);
        expect(readFakeAiLaunches(harness.stateDir, run.runId)).toHaveLength(1);
      } finally {
        await harness.stop(restarted, "SIGKILL");
      }
    } finally {
      await harness.stop(processHandle, "SIGKILL");
    }
  }, 30_000);

  it("auto-relaunches an unresolved restarted worker after restart", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(RECOVERY_ITEM);
    harness.commitAndPushWorkItems("Add watch recovery retry test item");

    const run = createFakeAiRun(
      harness.projectRoot,
      fakeAiHangScenario({
        stdout: ["retry worker hanging"],
      }),
      { runId: "watch-recovery-retry" },
    );
    const env = buildCliEnv(harness, run.runId, run.scenarioPath, {
      [TEST_ORCH_LAUNCH_TIMEOUT_MS_ENV]: "100",
      [TEST_ORCH_ACTIVITY_TIMEOUT_MS_ENV]: "100",
      [TEST_ORCH_GRACE_PERIOD_MS_ENV]: "100",
    });
    const processHandle = startRecoveryChild(harness, env);

    try {
      await harness.waitForOrchestratorState((state) => {
        const item = state.items.find((entry) => entry.id === "H-WRR-1");
        return item?.state === "implementing" ? item : false;
      }, 15_000);
      await harness.waitForHeadlessLog("headless:H-WRR-1", "retry worker hanging");
      rmSync(fakeAiHeartbeatPath(harness.stateDir, "H-WRR-1"), { force: true });

      await harness.waitForOrchestratorState((state) => {
        const item = state.items.find((entry) => entry.id === "H-WRR-1");
        return item?.timeoutDeadline ? item : false;
      }, 15_000);

      await harness.stop(processHandle, "SIGKILL");
      expect(harness.closeHeadlessWorkspace("headless:H-WRR-1")).toBe(true);
      await harness.waitForHeadlessExit("headless:H-WRR-1", 10_000);
      expect(readFakeAiLaunches(harness.stateDir, run.runId)).toHaveLength(1);
      await Bun.sleep(250);

      const restarted = startRecoveryChild(harness, env);
      try {
        // After restart, item should be auto-relaunched (not held as blocked).
        // Wait for the second launch to appear rather than polling the state file,
        // which still shows "implementing" from the pre-crash state and would
        // match the predicate before the new orchestrator has started its event loop.
        await waitFor(
          () => readFakeAiLaunches(harness.stateDir, run.runId).length >= 2 || false,
          { timeoutMs: 15_000, description: "second fake-AI launch" },
        );
        expect(readFakeAiLaunches(harness.stateDir, run.runId)).toHaveLength(2);
      } finally {
        await harness.stop(restarted, "SIGKILL");
      }
    } finally {
      await harness.stop(processHandle, "SIGKILL");
    }
  }, 45_000);

  it("relaunches a headless worker that stopped with waiting phase without consuming retry budget", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(RECOVERY_ITEM);
    harness.commitAndPushWorkItems("Add headless recovery test item");

    // First launch hangs, will be manually stopped to simulate wait-exit
    const run = createFakeAiRun(
      harness.projectRoot,
      fakeAiHangScenario({
        stdout: ["headless-recovery worker hanging"],
        heartbeat: { progress: 0.5, label: "implementing" },
      }),
      { runId: "watch-recovery-headless" },
    );
    const env = buildCliEnv(harness, run.runId, run.scenarioPath, {
      [TEST_ORCH_LAUNCH_TIMEOUT_MS_ENV]: "500",
      [TEST_ORCH_ACTIVITY_TIMEOUT_MS_ENV]: "500",
      [TEST_ORCH_GRACE_PERIOD_MS_ENV]: "0",
    });
    const processHandle = startRecoveryChild(harness, env);

    try {
      // Wait for worker to reach implementing state
      await harness.waitForOrchestratorState((state) => {
        const item = state.items.find((entry) => entry.id === "H-WRR-1");
        return item?.state === "implementing" ? item : false;
      }, 10_000);
      await harness.waitForHeadlessLog("headless:H-WRR-1", "headless-recovery worker hanging");

      // Simulate worker reaching wait mode by writing phase file
      // Must use harness HOME so the orchestrator child process reads the same path
      const origHome = process.env.HOME;
      process.env.HOME = harness.homeDir;
      writeHeadlessPhase(harness.projectRoot, "H-WRR-1", "waiting");
      process.env.HOME = origHome;

      // Kill the worker to simulate a stopped headless worker
      expect(harness.closeHeadlessWorkspace("headless:H-WRR-1")).toBe(true);
      await harness.waitForHeadlessExit("headless:H-WRR-1", 10_000);

      // Remove heartbeat so the orchestrator falls through to timeout checks
      rmSync(fakeAiHeartbeatPath(harness.stateDir, "H-WRR-1"), { force: true });

      // Wait for second launch (recovery relaunch)
      await waitFor(
        () => readFakeAiLaunches(harness.stateDir, run.runId).length >= 2 || false,
        { timeoutMs: 15_000, description: "headless recovery relaunch" },
      );
      expect(readFakeAiLaunches(harness.stateDir, run.runId)).toHaveLength(2);

      // Verify retry budget was NOT consumed (retryCount stays 0)
      const item = readRecoveryItemState(harness);
      expect(item?.retryCount).toBe(0);
    } finally {
      await harness.stop(processHandle, "SIGKILL");
    }
  }, 45_000);

  it("consumes retry budget when headless worker stops with starting phase (no progress)", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(RECOVERY_ITEM);
    harness.commitAndPushWorkItems("Add headless fatal stop test item");

    const run = createFakeAiRun(
      harness.projectRoot,
      fakeAiHangScenario({
        stdout: ["headless-fatal worker hanging"],
      }),
      { runId: "watch-recovery-headless-fatal" },
    );
    const env = buildCliEnv(harness, run.runId, run.scenarioPath, {
      [TEST_ORCH_LAUNCH_TIMEOUT_MS_ENV]: "500",
      [TEST_ORCH_ACTIVITY_TIMEOUT_MS_ENV]: "500",
      [TEST_ORCH_GRACE_PERIOD_MS_ENV]: "0",
    });
    const processHandle = startRecoveryChild(harness, env);

    try {
      await harness.waitForOrchestratorState((state) => {
        const item = state.items.find((entry) => entry.id === "H-WRR-1");
        return item?.state === "implementing" ? item : false;
      }, 10_000);
      await harness.waitForHeadlessLog("headless:H-WRR-1", "headless-fatal worker hanging");

      // Phase stays "starting" (no heartbeat -> no phase update)
      // Kill the worker to simulate a crashed headless worker
      expect(harness.closeHeadlessWorkspace("headless:H-WRR-1")).toBe(true);
      await harness.waitForHeadlessExit("headless:H-WRR-1", 10_000);

      // Wait for second launch (stuckOrRetry consumed 1 retry)
      await waitFor(
        () => readFakeAiLaunches(harness.stateDir, run.runId).length >= 2 || false,
        { timeoutMs: 15_000, description: "headless retry relaunch" },
      );

      // Verify retry budget WAS consumed (retryCount = 1)
      const item = readRecoveryItemState(harness);
      expect(item?.retryCount).toBe(1);
    } finally {
      await harness.stop(processHandle, "SIGKILL");
    }
  }, 45_000);
});
