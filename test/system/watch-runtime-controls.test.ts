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

Acceptance: WIP changes can launch queued work during a live run.

Key files: \`test/system/watch-runtime-controls.test.ts\`
`;

function buildCliEnv(harness: CliHarness, runId: string, scenarioPath: string): Record<string, string> {
  return {
    PATH: `${TEST_BIN_DIR}:${process.env.PATH ?? ""}`,
    [TEST_LAUNCH_OVERRIDE_COMMAND_ENV]: DEFAULT_FAKE_AI_SCRIPT,
    [FAKE_AI_SCENARIO_ENV]: scenarioPath,
    [FAKE_AI_RUN_ID_ENV]: runId,
    NINTHWAVE_FAKE_GH_STATE_PATH: join(harness.stateDir, "fake-gh.json"),
    NINTHWAVE_FAKE_GH_REPO: "ninthwave-sh/ninthwave-system-test",
  };
}

describe("system: watch runtime controls", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("applies live WIP, review, and merge strategy changes during a headless watch run", async () => {
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
      "--backend-mode", "headless",
      "--tool", "codex",
      "--merge-strategy", "manual",
      "--session-limit", "1",
      "--review",
      "--skip-preflight",
      "--poll-interval", "0",
      "--watch-interval", "0",
    ], {
      env: buildCliEnv(harness, run.runId, run.scenarioPath),
      keepStdinOpen: true,
    });

    try {
      await harness.waitForOrchestratorState((state) => {
        const first = state.items.find((entry) => entry.id === "H-WRC-1");
        const second = state.items.find((entry) => entry.id === "H-WRC-2");
        return first?.state === "implementing" && second?.state === "ready" ? state : false;
      }, 15_000);

      expect(existsSync(join(harness.worktreeDir, "ninthwave-H-WRC-1"))).toBe(true);
      expect(existsSync(join(harness.worktreeDir, "ninthwave-H-WRC-2"))).toBe(false);

      harness.writeToProcess(processHandle, `${JSON.stringify({
        type: "set-session-limit",
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

      await harness.waitForProcessOutput(processHandle, /"event":"session_limit_changed"/, {
        timeoutMs: 10_000,
      });
      await harness.waitForProcessOutput(processHandle, /"event":"review_mode_changed"/, {
        timeoutMs: 10_000,
      });

      const concurrentState = await harness.waitForOrchestratorState((state) => {
        const first = state.items.find((entry) => entry.id === "H-WRC-1");
        const second = state.items.find((entry) => entry.id === "H-WRC-2");
        const firstActive = first && ["implementing", "merged", "forward-fix-pending"].includes(first.state);
        const secondActive = second && ["launching", "implementing"].includes(second.state);
        return firstActive && secondActive ? state : false;
      }, 15_000);
      expect(concurrentState.sessionLimit).toBe(2);
      expect(existsSync(join(harness.worktreeDir, "ninthwave-H-WRC-2"))).toBe(true);

      const settledState = await harness.waitForOrchestratorState((state) => {
        const first = state.items.find((entry) => entry.id === "H-WRC-1");
        const second = state.items.find((entry) => entry.id === "H-WRC-2");
        return first?.prNumber === 1
          && ["merged", "forward-fix-pending", "done"].includes(first.state)
          && second != null
          && second.state !== "ready"
          ? state
          : false;
      }, 20_000);

      expect(settledState.items.find((entry) => entry.id === "H-WRC-1")?.prNumber).toBe(1);
      expect(settledState.items.find((entry) => entry.id === "H-WRC-2")?.state).not.toBe("ready");
      expect(readFakeAiState(harness.stateDir, run.runId).status).toBe("completed");

      const launches = await waitFor(() => {
        const records = readFakeAiLaunches(harness.stateDir, run.runId);
        return records.length === 2 ? records : false;
      }, {
        timeoutMs: 15_000,
        description: "runtime-control implementer launches",
      });
      expect(launches).toHaveLength(2);
      expect(launches.every((entry) => entry.agent === "ninthwave-implementer")).toBe(true);
    } finally {
      await harness.stop(processHandle, "SIGKILL");
    }
  }, 30_000);
});
