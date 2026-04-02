import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { TEST_LAUNCH_OVERRIDE_COMMAND_ENV } from "../../core/commands/launch.ts";
import { cleanupTempRepos, resolveProjectStateDir, waitFor } from "../helpers.ts";
import {
  CliHarness,
  type FakeGhCheckRun,
  type FakeGhState,
} from "./helpers/cli-harness.ts";
import {
  DEFAULT_FAKE_AI_SCRIPT,
  FAKE_AI_SCENARIO_ENV,
  createFakeAiRun,
  fakeAiArtifactDir,
  fakeAiDefaultRunId,
  fakeAiSuccessScenario,
  readFakeAiContext,
  readFakeAiPrompt,
} from "./helpers/fake-ai-scenario.ts";

const TEST_BIN_DIR = join(import.meta.dirname, "..", "bin");

const WORK_ITEMS = `
## Secondary Workers

### Reviewer approve flow stays deterministic (H-SWW-1)
**Priority:** High
**Source:** Test
**Domain:** secondary-worker-tests
**Lineage:** 11111111-1111-4111-8111-111111111111

Approval path coverage.

Acceptance: Reviewer approval is consumed through the real watch loop.

Key files: \`test/system/watch-secondary-workers.test.ts\`

### Reviewer request-changes flow stays deterministic (H-SWW-2)
**Priority:** High
**Source:** Test
**Domain:** secondary-worker-tests
**Lineage:** 22222222-2222-4222-8222-222222222222

Requested-changes path coverage.

Acceptance: Reviewer requested changes are consumed through the real watch loop.

Key files: \`test/system/watch-secondary-workers.test.ts\`

### CI conflicts escalate to a rebaser worker (H-SWW-3)
**Priority:** High
**Source:** Test
**Domain:** secondary-worker-tests
**Lineage:** 33333333-3333-4333-8333-333333333333

Rebaser path coverage.

Acceptance: Merge-conflict CI failures launch the rebaser path through the real watch loop.

Key files: \`test/system/watch-secondary-workers.test.ts\`

### Forward fixer can recover a failed merge commit (H-SWW-4)
**Priority:** High
**Source:** Test
**Domain:** secondary-worker-tests
**Lineage:** 44444444-4444-4444-8444-444444444444

Forward-fixer happy path coverage.

Acceptance: Post-merge CI recovery uses the forward-fixer path through the real watch loop.

Key files: \`test/system/watch-secondary-workers.test.ts\`

### Forward fixer failure is surfaced deterministically (H-SWW-5)
**Priority:** High
**Source:** Test
**Domain:** secondary-worker-tests
**Lineage:** 55555555-5555-4555-8555-555555555555

Forward-fixer failure path coverage.

Acceptance: Post-merge CI failure without recovery reaches a deterministic stuck state.

Key files: \`test/system/watch-secondary-workers.test.ts\`
`;

type Verdict = "approve" | "request-changes";
type CommitCheckStatus = "pass" | "fail" | "pending";

function buildCliEnv(
  harness: CliHarness,
  scenarioPath: string,
  options: { defaultCommitChecks?: CommitCheckStatus; autoCreatePrs?: boolean } = {},
): Record<string, string> {
  return {
    PATH: `${TEST_BIN_DIR}:${process.env.PATH ?? ""}`,
    [TEST_LAUNCH_OVERRIDE_COMMAND_ENV]: DEFAULT_FAKE_AI_SCRIPT,
    [FAKE_AI_SCENARIO_ENV]: scenarioPath,
    NINTHWAVE_FAKE_GH_STATE_PATH: harness.fakeGhStatePath(),
    NINTHWAVE_FAKE_GH_REPO: "ninthwave-sh/ninthwave-system-test",
    ...(options.defaultCommitChecks
      ? { NINTHWAVE_FAKE_GH_DEFAULT_COMMIT_CHECKS: options.defaultCommitChecks }
      : {}),
    ...(options.autoCreatePrs === false
      ? { NINTHWAVE_FAKE_GH_AUTO_CREATE_PRS: "0" }
      : {}),
  };
}

function inboxMessagesForProject(projectRoot: string, homeDir: string, itemId: string): string[] {
  const stateDir = resolveProjectStateDir(projectRoot, homeDir);
  const dir = join(stateDir, "inbox", itemId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".msg"))
    .sort()
    .map((entry) => readFileSync(join(dir, entry), "utf-8"));
}

function watchArgs(
  itemIds: string | string[],
  options: { mergeStrategy: "auto" | "manual"; noReview?: boolean },
): string[] {
  const items = Array.isArray(itemIds) ? itemIds : [itemIds];
  const args = [
    "--items", ...items,
    "--watch",
    "--backend-mode", "headless",
    "--tool", "codex",
    "--merge-strategy", options.mergeStrategy,
    "--skip-preflight",
    "--poll-interval", "0",
    "--watch-interval", "0",
  ];
  if (options.noReview) args.push("--no-review");
  return args;
}

function waitForItemState(
  harness: CliHarness,
  itemId: string,
  expectedState: string,
  timeoutMs = 10_000,
) {
  return harness.waitForOrchestratorState((state) => {
    const item = state.items.find((entry) => entry.id === itemId);
    return item?.state === expectedState ? item : false;
  }, timeoutMs);
}

function defaultPrChecks(status: CommitCheckStatus): FakeGhCheckRun[] {
  const completedAt = "2026-04-02T12:00:00Z";
  switch (status) {
    case "pending":
      return [{ state: "PENDING", name: "test", link: "https://example.invalid/checks/test" }];
    case "fail":
      return [{ state: "FAILURE", name: "test", link: "https://example.invalid/checks/test", completedAt }];
    default:
      return [{ state: "SUCCESS", name: "test", link: "https://example.invalid/checks/test", completedAt }];
  }
}

function setPrStatus(
  harness: CliHarness,
  branch: string,
  options: { checks?: CommitCheckStatus; mergeable?: "MERGEABLE" | "CONFLICTING" },
): void {
  harness.updateFakeGhState((state) => {
    const pr = state.prs.find((entry) => entry.branch === branch);
    if (!pr) {
      throw new Error(`PR for branch ${branch} not found`);
    }
    if (options.checks) {
      pr.checks = defaultPrChecks(options.checks);
      pr.updatedAt = "2026-04-02T12:00:00Z";
    }
    if (options.mergeable) {
      pr.mergeable = options.mergeable;
      pr.updatedAt = "2026-04-02T12:00:00Z";
    }
  });
}

function setCommitCheckStatus(
  harness: CliHarness,
  sha: string,
  status: CommitCheckStatus,
): void {
  harness.updateFakeGhState((state) => {
    state.commitChecks ??= {};
    switch (status) {
      case "pending":
        state.commitChecks[sha] = [{ name: "test", status: "in_progress", conclusion: null }];
        break;
      case "fail":
        state.commitChecks[sha] = [{ name: "test", status: "completed", conclusion: "failure" }];
        break;
      default:
        state.commitChecks[sha] = [{ name: "test", status: "completed", conclusion: "success" }];
        break;
    }
  });
}

function writeVerdict(
  harness: CliHarness,
  itemId: string,
  verdict: Verdict,
): void {
  const path = harness.reviewVerdictPath(itemId);
  mkdirSync(join(harness.stateDir, "tmp"), { recursive: true });
  writeFileSync(path, JSON.stringify({
    verdict,
    summary: verdict === "approve" ? "No blockers." : "Please address the blockers.",
    blockingCount: verdict === "approve" ? 0 : 2,
    nonBlockingCount: verdict === "approve" ? 1 : 0,
    architectureScore: verdict === "approve" ? 8 : 5,
    codeQualityScore: verdict === "approve" ? 9 : 4,
    performanceScore: 7,
    testCoverageScore: verdict === "approve" ? 8 : 3,
    unresolvedDecisions: verdict === "approve" ? 0 : 2,
    criticalGaps: verdict === "approve" ? 0 : 2,
    confidence: verdict === "approve" ? 9 : 7,
  }, null, 2) + "\n", "utf-8");
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

function createConflictingHistory(
  harness: CliHarness,
  itemId: string,
  filename = "merge-conflict.txt",
): void {
  const worktreePath = join(harness.worktreeDir, `ninthwave-${itemId}`);
  writeFileSync(join(worktreePath, filename), "branch change\n", "utf-8");
  git(worktreePath, ["add", filename]);
  git(worktreePath, ["commit", "-m", "test: branch conflict", "--quiet"]);

  writeFileSync(join(harness.projectRoot, filename), "main change\n", "utf-8");
  git(harness.projectRoot, ["add", filename]);
  git(harness.projectRoot, ["commit", "-m", "test: main conflict", "--quiet"]);
  git(harness.projectRoot, ["push", "origin", "main", "--quiet"]);
}

function seedItemBranch(
  harness: CliHarness,
  itemId: string,
): { branch: string; headSha: string; worktreePath: string } {
  const branch = `ninthwave/${itemId}`;
  const worktreePath = join(harness.worktreeDir, `ninthwave-${itemId}`);
  git(harness.projectRoot, ["branch", "-f", branch, "HEAD"]);
  git(harness.projectRoot, ["worktree", "add", worktreePath, branch, "--quiet"]);
  git(harness.projectRoot, ["push", "origin", `+${branch}`, "--quiet"]);
  return {
    branch,
    headSha: git(worktreePath, ["rev-parse", "HEAD"]),
    worktreePath,
  };
}

function seedOpenPr(
  harness: CliHarness,
  itemId: string,
  branch: string,
  headSha: string,
  options: {
    prNumber?: number;
    checks?: CommitCheckStatus;
    mergeable?: "MERGEABLE" | "CONFLICTING";
  } = {},
): number {
  const prNumber = options.prNumber ?? 1;
  const item = harness.findItem(itemId);
  const now = "2026-04-02T12:00:00Z";
  harness.writeFakeGhState({
    nextPrNumber: prNumber + 1,
    prs: [{
      number: prNumber,
      branch,
      state: "open",
      title: item.title,
      body: `## Work Item Reference\nID: ${itemId}\nLineage: ${item.lineageToken}\n`,
      createdAt: now,
      updatedAt: now,
      headSha,
      mergeable: options.mergeable ?? "MERGEABLE",
      reviewDecision: "",
      checks: defaultPrChecks(options.checks ?? "pass"),
      baseRefName: "main",
    }],
  });
  return prNumber;
}

function seedPrLifecycleState(
  harness: CliHarness,
  itemId: string,
  state: "ci-passed" | "ci-pending",
  options: {
    prNumber?: number;
    worktreePath?: string;
  } = {},
): void {
  const item = harness.findItem(itemId);
  const now = "2026-04-02T12:00:00.000Z";
  harness.writeOrchestratorState({
    pid: 1,
    startedAt: now,
    updatedAt: now,
    items: [{
      id: itemId,
      state,
      prNumber: options.prNumber ?? 1,
      title: item.title,
      lastTransition: now,
      ciFailCount: 0,
      retryCount: 0,
      worktreePath: options.worktreePath,
    }],
  });
}

function seedForwardFixPendingStates(
  harness: CliHarness,
  itemIds: string[],
): Record<string, string> {
  const baseMergeCommitSha = git(harness.projectRoot, ["rev-parse", "HEAD"]);
  const now = "2026-04-02T12:00:00.000Z";
  const mergeShas = Object.fromEntries(
    itemIds.map((itemId, index) => [
      itemId,
      itemIds.length === 1
        ? baseMergeCommitSha
        : `${baseMergeCommitSha.slice(0, -1)}${index.toString(16)}`,
    ]),
  );
  harness.writeOrchestratorState({
    pid: 1,
    startedAt: now,
    updatedAt: now,
    items: itemIds.map((itemId) => {
      const item = harness.findItem(itemId);
      return {
        id: itemId,
        state: "forward-fix-pending",
        prNumber: 1,
        title: item.title,
        lastTransition: now,
        ciFailCount: 0,
        retryCount: 0,
        mergeCommitSha: mergeShas[itemId],
        defaultBranch: "main",
      };
    }),
  });
  return mergeShas;
}

async function readSecondaryWorkerContext(
  harness: CliHarness,
  itemId: string,
  agent: string,
): Promise<{ prompt: string; context: ReturnType<typeof readFakeAiContext> }> {
  const runId = fakeAiDefaultRunId(itemId, agent);
  return waitFor(() => {
    const artifactDir = fakeAiArtifactDir(harness.stateDir, runId);
    const contextPath = join(artifactDir, "context.env");
    const promptPath = join(artifactDir, "prompt.txt");
    if (!existsSync(contextPath) || !existsSync(promptPath)) return false;
    const context = readFakeAiContext(harness.stateDir, runId);
    const prompt = readFakeAiPrompt(harness.stateDir, runId);
    return context.agent === agent && context.itemId === itemId && prompt.length > 0
      ? { prompt, context }
      : false;
  }, {
    description: `${agent} fake worker artifacts`,
  });
}

function ensureBranchPrExists(harness: CliHarness, branch: string): Promise<FakeGhState> {
  return waitFor(() => {
    const state = harness.readFakeGhState();
    return state.prs.some((entry) => entry.branch === branch) ? state : false;
  }, { description: `fake gh PR for ${branch}` });
}

describe("system: watch secondary workers", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("covers reviewer verdict creation and consumption end to end", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(WORK_ITEMS);
    harness.commitAndPushWorkItems("Add secondary-worker test items");
    const approved = seedItemBranch(harness, "H-SWW-1");
    const approvedPrNumber = seedOpenPr(harness, "H-SWW-1", approved.branch, approved.headSha);
    seedPrLifecycleState(harness, "H-SWW-1", "ci-passed", {
      prNumber: approvedPrNumber,
      worktreePath: approved.worktreePath,
    });
    const requested = seedItemBranch(harness, "H-SWW-2");
    const requestedPrNumber = seedOpenPr(harness, "H-SWW-2", requested.branch, requested.headSha, {
      prNumber: 2,
    });
    seedPrLifecycleState(harness, "H-SWW-2", "ci-passed", {
      prNumber: requestedPrNumber,
      worktreePath: requested.worktreePath,
    });

    const processHandle = harness.start(
      watchArgs(["H-SWW-1", "H-SWW-2"], { mergeStrategy: "manual" }),
      { env: buildCliEnv(harness, "/dev/null") },
    );

    try {
      const reviewing = await waitForItemState(harness, "H-SWW-1", "reviewing", 30_000);
      expect(reviewing.prNumber).toBeGreaterThan(0);
      expect(reviewing.reviewWorkspaceRef).toBeDefined();

      const { context, prompt } = await readSecondaryWorkerContext(
        harness,
        "H-SWW-1",
        "ninthwave-reviewer",
      );
      expect(context.agent).toBe("ninthwave-reviewer");
      expect(context.itemId).toBe("H-SWW-1");
      expect(prompt).toContain(`YOUR_REVIEW_PR: ${reviewing.prNumber}`);
      expect(prompt).toContain(`VERDICT_FILE: ${harness.reviewVerdictPath("H-SWW-1")}`);

      writeVerdict(harness, "H-SWW-1", "approve");

      const reviewed = await waitForItemState(harness, "H-SWW-1", "review-pending", 30_000);
      expect(reviewed.reviewCompleted).toBe(true);
      expect(reviewed.reviewWorkspaceRef).toBeUndefined();
      expect(existsSync(harness.reviewVerdictPath("H-SWW-1"))).toBe(false);
      await waitForItemState(harness, "H-SWW-2", "reviewing", 30_000);

      writeVerdict(harness, "H-SWW-2", "request-changes");

      const reviewedWithChanges = await waitForItemState(harness, "H-SWW-2", "review-pending", 30_000);
      expect(reviewedWithChanges.reviewCompleted).toBeUndefined();
      expect(reviewedWithChanges.reviewWorkspaceRef).toBeUndefined();
      expect(existsSync(harness.reviewVerdictPath("H-SWW-2"))).toBe(false);

      const inboxMessages = await waitFor(() => {
        const messages = reviewedWithChanges.worktreePath
          ? inboxMessagesForProject(reviewedWithChanges.worktreePath, harness.homeDir, "H-SWW-2")
          : [];
        return messages.length > 0 ? messages : false;
      }, { timeoutMs: 20_000, description: "review feedback inbox messages" });
      expect(inboxMessages.join("\n")).toContain("[ORCHESTRATOR] Review Feedback (round 1): 2 blocking, 0 non-blocking.");
      expect(inboxMessages.join("\n")).toContain("Please address the blockers.");
    } finally {
      await harness.stop(processHandle);
    }
  }, 90_000);

  it("covers CI conflict escalation into a rebaser worker and recovery back to ci-pending", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(WORK_ITEMS);
    harness.commitAndPushWorkItems("Add secondary-worker test items");
    const seeded = seedItemBranch(harness, "H-SWW-3");
    const prNumber = seedOpenPr(harness, "H-SWW-3", seeded.branch, seeded.headSha, { checks: "pending" });
    seedPrLifecycleState(harness, "H-SWW-3", "ci-pending", {
      prNumber,
      worktreePath: seeded.worktreePath,
    });

    const rebaserRun = createFakeAiRun(
      harness.projectRoot,
      fakeAiSuccessScenario({
        sleepMs: 250,
        stdout: ["fake rebaser finished"],
      }),
      { runId: "secondary-rebaser-worker" },
    );

    const env = buildCliEnv(harness, rebaserRun.scenarioPath);
    const processHandle = harness.start(
      watchArgs("H-SWW-3", { mergeStrategy: "manual", noReview: true }),
      { env },
    );

    try {
      await waitForItemState(harness, "H-SWW-3", "ci-pending", 30_000);

      createConflictingHistory(harness, "H-SWW-3");
      setPrStatus(harness, "ninthwave/H-SWW-3", { checks: "fail", mergeable: "CONFLICTING" });

      const failed = await waitForItemState(harness, "H-SWW-3", "ci-failed");
      expect(failed.prNumber).toBe(prNumber);

      const launched = harness.launchHeadlessRebaser(
        prNumber,
        "H-SWW-3",
        rebaserRun,
        { tool: "codex" },
      );
      expect(launched).not.toBeNull();

      await waitFor(() => {
        const artifactDir = fakeAiArtifactDir(harness.stateDir, rebaserRun.runId);
        return existsSync(join(artifactDir, "context.env")) ? artifactDir : false;
      }, { description: "rebaser fake worker artifacts" });
      const context = readFakeAiContext(harness.stateDir, rebaserRun.runId);
      const prompt = readFakeAiPrompt(harness.stateDir, rebaserRun.runId);
      expect(context.agent).toBe("ninthwave-rebaser");
      expect(prompt).toContain("YOUR_REBASE_ITEM_ID: H-SWW-3");
      expect(prompt).toContain(`YOUR_REBASE_PR: ${failed.prNumber}`);

      setPrStatus(harness, "ninthwave/H-SWW-3", { checks: "pending", mergeable: "MERGEABLE" });

      const recovered = await waitForItemState(harness, "H-SWW-3", "ci-pending", 30_000);
      expect(recovered.rebaseRequested).toBeUndefined();
    } finally {
      await harness.stop(processHandle);
    }
  }, 60_000);

  it("covers the forward-fixer happy path after merge-commit CI failure", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(WORK_ITEMS);
    harness.commitAndPushWorkItems("Add secondary-worker test items");
    const mergeCommitSha = seedForwardFixPendingStates(harness, ["H-SWW-4"])["H-SWW-4"];

    const run = createFakeAiRun(
      harness.projectRoot,
      fakeAiSuccessScenario({
        sleepMs: 4_000,
        stdout: ["fake worker finished"],
        heartbeat: { progress: 1.0, label: "PR created", prNumber: 1 },
      }),
      { runId: "secondary-forward-fixer-worker" },
    );

    const processHandle = harness.start(
      watchArgs("H-SWW-4", { mergeStrategy: "auto", noReview: true }),
      { env: buildCliEnv(harness, run.scenarioPath, { defaultCommitChecks: "pending" }) },
    );

    try {
      const pending = await waitForItemState(harness, "H-SWW-4", "forward-fix-pending", 10_000);
      expect(pending.mergeCommitSha).toBe(mergeCommitSha);

      setCommitCheckStatus(harness, mergeCommitSha, "fail");

      const fixing = await waitForItemState(harness, "H-SWW-4", "fixing-forward", 30_000);
      expect(fixing.fixForwardWorkspaceRef).toBeDefined();

      const { context, prompt } = await readSecondaryWorkerContext(
        harness,
        "H-SWW-4",
        "ninthwave-forward-fixer",
      );
      expect(context.agent).toBe("ninthwave-forward-fixer");
      expect(prompt).toContain("YOUR_VERIFY_ITEM_ID: H-SWW-4");
      expect(prompt).toContain(`YOUR_VERIFY_MERGE_SHA: ${mergeCommitSha}`);
    } finally {
      await harness.stop(processHandle);
    }
  }, 70_000);

  it("covers the forward-fixer follow-up boundary when merge-commit CI stays failed", async () => {
    const harness = new CliHarness();
    harness.writeWorkItems(WORK_ITEMS);
    harness.commitAndPushWorkItems("Add secondary-worker test items");
    const mergeCommitSha = seedForwardFixPendingStates(harness, ["H-SWW-5"])["H-SWW-5"];

    const run = createFakeAiRun(
      harness.projectRoot,
      fakeAiSuccessScenario({
        sleepMs: 250,
        stdout: ["fake worker finished"],
        heartbeat: { progress: 1.0, label: "PR created", prNumber: 1 },
      }),
      { runId: "secondary-forward-fixer-failure" },
    );

    const processHandle = harness.start(
      watchArgs("H-SWW-5", { mergeStrategy: "auto", noReview: true }),
      { env: buildCliEnv(harness, run.scenarioPath, { defaultCommitChecks: "pending", autoCreatePrs: false }) },
    );

    try {
      const pending = await waitForItemState(harness, "H-SWW-5", "forward-fix-pending", 10_000);
      expect(pending.mergeCommitSha).toBe(mergeCommitSha);

      setCommitCheckStatus(harness, mergeCommitSha, "fail");

      const fixing = await waitForItemState(harness, "H-SWW-5", "fixing-forward", 30_000);
      expect(fixing.fixForwardWorkspaceRef).toBeDefined();

      const { context } = await readSecondaryWorkerContext(
        harness,
        "H-SWW-5",
        "ninthwave-forward-fixer",
      );
      expect(context.agent).toBe("ninthwave-forward-fixer");

      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const currentState = harness.readOrchestratorState();
      const item = currentState?.items.find((entry) => entry.id === "H-SWW-5");
      expect(item).toBeDefined();
      expect(["fixing-forward", "ci-pending", "merged"]).toContain(item?.state);
      expect(item?.state).not.toBe("done");
      expect(item?.state).not.toBe("stuck");
    } finally {
      await harness.stop(processHandle);
    }
  }, 70_000);
});
