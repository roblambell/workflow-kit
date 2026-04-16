import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "fs";
import { join } from "path";
import { TEST_LAUNCH_OVERRIDE_COMMAND_ENV } from "../../core/commands/launch.ts";
import { cleanupTempRepos, waitFor } from "../helpers.ts";
import { CliHarness } from "./helpers/cli-harness.ts";
import {
  DEFAULT_FAKE_AI_SCRIPT,
  FAKE_AI_RUN_ID_ENV,
  FAKE_AI_SCENARIO_ENV,
  createFakeAiRun,
  fakeAiSuccessScenario,
  readFakeAiLaunches,
  readFakeAiState,
} from "./helpers/fake-ai-scenario.ts";

const TEST_BIN_DIR = join(import.meta.dirname, "..", "bin");

const RUNTIME_ITEMS = `
## Watch Runtime Controls

### Apply live runtime control changes to queued work (H-WRC-1)
**Priority:** High
**Source:** Test
**Domain:** watch-recovery-tests
**Lineage:** 11111111-aaaa-4aaa-8aaa-111111111111

Runtime control coverage for the first item.

Acceptance: Live runtime control changes take effect without restarting the watch engine.

Key files: \`test/system/watch-runtime-controls.test.ts\`

### Apply live runtime control changes to a second item (H-WRC-2)
**Priority:** High
**Source:** Test
**Domain:** watch-recovery-tests
**Lineage:** 22222222-bbbb-4bbb-8bbb-222222222222

Runtime control coverage for the second item.

Acceptance: Session limit changes can launch queued work during a live run.

Key files: \`test/system/watch-runtime-controls.test.ts\`
`;

function buildCliEnv(harness: CliHarness, runId: string, scenarioPath: string): Record<string, string> {
  return {
    PATH: `${TEST_BIN_DIR}:${process.env.PATH ?? ""}`,
    [TEST_LAUNCH_OVERRIDE_COMMAND_ENV]: DEFAULT_FAKE_AI_SCRIPT,
    [FAKE_AI_SCENARIO_ENV]: scenarioPath,
    [FAKE_AI_RUN_ID_ENV]: runId,
    NINTHWAVE_FAKE_GH_STATE_PATH: join(harness.stateDir, "fake-gh.json"),
    NINTHWAVE_FAKE_GH_REPO: "ninthwave-io/ninthwave-system-test",
    NINTHWAVE_MUX: "headless",
  };
}

describe("system: watch runtime controls", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("applies live session limit, review, and merge strategy changes during a headless watch run", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(RUNTIME_ITEMS);
    harness.commitAndPushWorkItems("Add watch runtime control test items");

    const run = createFakeAiRun(
      harness.projectRoot,
      fakeAiSuccessScenario({
        sleepMs: 2_500,
        stdout: ["runtime worker started", "runtime worker finished"],
        heartbeat: { progress: 1.0, label: "PR created", prNumber: 1 },
      }),
      { runId: "watch-runtime-controls" },
    );

    const processHandle = harness.start([
      "--_interactive-engine-child",
      "--items", "H-WRC-1", "H-WRC-2",
      "--watch",
      "--tool", "codex",
      "--merge-strategy", "manual",
      "--max-inflight", "1",
      "--review",
      "--skip-preflight",
      // Use 1-second intervals rather than 0 to avoid busy-loop behavior in CI.
      // Under GitHub Actions load, --watch-interval 0 appears to starve the main
      // event loop enough that state writes stall and the orchestrator can't
      // persist runtime-control changes before the next wait predicate polls.
      "--poll-interval", "1",
      "--watch-interval", "1",
    ], {
      env: buildCliEnv(harness, run.runId, run.scenarioPath),
      keepStdinOpen: true,
    });
    const firstWorktreePath = join(harness.worktreeDir, "ninthwave-H-WRC-1");
    const secondWorktreePath = join(harness.worktreeDir, "ninthwave-H-WRC-2");

    try {
      const firstWorktreePath = join(harness.worktreeDir, "ninthwave-H-WRC-1");
      try {
        await harness.waitForOrchestratorState((state) => {
          const first = state.items.find((entry) => entry.id === "H-WRC-1");
          const second = state.items.find((entry) => entry.id === "H-WRC-2");
          // Accept any state that indicates the first item has been picked up from the ready queue.
          // The fake worker heartbeats at progress=1.0 with prNumber=1 and exits in 2.5s, so it can
          // race past implementing/ci-pending into ci-passed/review-pending (with --review) before
          // the first poll observes the state. The invariant we care about is "first was picked up,
          // second wasn't yet" -- max-inflight=1 guarantees second stays in ready/queued.
          const firstPickedUp = first && first.state !== "queued" && first.state !== "ready";
          return firstPickedUp
            && second?.state === "ready"
            && existsSync(firstWorktreePath)
            && !existsSync(secondWorktreePath)
            ? state
            : false;
        }, 60_000);
      } catch (err) {
        const state = harness.readOrchestratorState();
        const log = harness.readOrchestratorLog();
        const stdout = processHandle.stdout.slice(-4000);
        const stderr = processHandle.stderr.slice(-4000);
        // eslint-disable-next-line no-console
        console.error("[diagnostic] first waitForOrchestratorState failed.\n" +
          `state=${JSON.stringify(state, null, 2)}\n` +
          `orchestrator.log tail:\n${log.slice(-4000)}\n` +
          `stdout tail:\n${stdout}\n` +
          `stderr tail:\n${stderr}\n`);
        throw err;
      }

      expect(existsSync(firstWorktreePath)).toBe(true);
      expect(existsSync(secondWorktreePath)).toBe(false);

      harness.writeToProcess(processHandle, `${JSON.stringify({
        type: "set-max-inflight",
        limit: 2,
        source: "system-test",
      })}\n`);
      harness.writeToProcess(processHandle, `${JSON.stringify({
        type: "set-review-mode",
        mode: "off",
        source: "system-test",
      })}\n`);
      harness.writeToProcess(processHandle, `${JSON.stringify({
        type: "set-merge-strategy",
        strategy: "auto",
        source: "system-test",
      })}\n`);

      await harness.waitForProcessOutput(processHandle, /"event":"max_inflight_changed"/, {
        timeoutMs: 30_000,
      });
      await harness.waitForProcessOutput(processHandle, /"event":"review_mode_changed"/, {
        timeoutMs: 30_000,
      });

      let concurrentState;
      try {
        concurrentState = await harness.waitForOrchestratorState((state) => {
          const first = state.items.find((entry) => entry.id === "H-WRC-1");
          const second = state.items.find((entry) => entry.id === "H-WRC-2");
          // H-WRC-1 may be in any post-launch active state by this point (review-pending while
          // waiting for the review-mode flip to apply, ci-passed/merging while auto-merge runs,
          // or merged after). We just need first to still be picked up, not done/stuck.
          const firstActive = first
            && first.state !== "queued"
            && first.state !== "ready"
            && first.state !== "stuck"
            && first.state !== "blocked";
          const secondActive = second && ["launching", "implementing"].includes(second.state);
          return firstActive && secondActive && existsSync(secondWorktreePath) ? state : false;
        }, 60_000);
      } catch (err) {
        const state = harness.readOrchestratorState();
        const log = harness.readOrchestratorLog();
        // eslint-disable-next-line no-console
        console.error("[diagnostic] concurrent waitForOrchestratorState failed.\n" +
          `state=${JSON.stringify(state, null, 2)}\n` +
          `orchestrator.log tail:\n${log.slice(-4000)}\n` +
          `stdout tail:\n${processHandle.stdout.slice(-4000)}\n` +
          `stderr tail:\n${processHandle.stderr.slice(-4000)}\n`);
        throw err;
      }
      expect(concurrentState.maxInflight).toBe(2);
      expect(existsSync(secondWorktreePath)).toBe(true);

      const settledState = await harness.waitForOrchestratorState((state) => {
        const first = state.items.find((entry) => entry.id === "H-WRC-1");
        const second = state.items.find((entry) => entry.id === "H-WRC-2");
        return first?.prNumber === 1
          && ["merged", "forward-fix-pending", "done"].includes(first.state)
          && second != null
          && second.state !== "ready"
          ? state
          : false;
      }, 60_000);

      expect(settledState.items.find((entry) => entry.id === "H-WRC-1")?.prNumber).toBe(1);
      expect(settledState.items.find((entry) => entry.id === "H-WRC-2")?.state).not.toBe("ready");
      // The fake AI writes state.env right before exit. With auto-merge closing
      // H-WRC-1's workspace quickly after merge, the orchestrator may SIGTERM
      // the worker before the shell trap writes signaled state. Wait briefly
      // for the latest worker to settle into either completed or signaled.
      const fakeAiStatus = await waitFor(() => {
        try {
          const status = readFakeAiState(harness.stateDir, run.runId).status;
          return status === "completed" || status === "signaled" ? status : false;
        } catch { return false; }
      }, { timeoutMs: 10_000, description: "fake AI terminal state" });
      expect(["completed", "signaled"]).toContain(fakeAiStatus);

      const launches = await waitFor(() => {
        const records = readFakeAiLaunches(harness.stateDir, run.runId);
        return records.length === 2 ? records : false;
      }, {
        timeoutMs: 60_000,
        description: "runtime-control implementer launches",
      });
      expect(launches).toHaveLength(2);
      expect(launches.every((entry) => entry.agent === "ninthwave-implementer")).toBe(true);
    } finally {
      await harness.stop(processHandle, "SIGKILL");
    }
  }, 120_000);
});
