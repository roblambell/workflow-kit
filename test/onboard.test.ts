// Tests for `ninthwave` first-run onboarding and no-args flows (core/commands/onboard.ts).

import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { setupTempRepo, cleanupTempRepos, commitAndPushWorkItem } from "./helpers.ts";
import { stripJsonComments } from "../core/config.ts";
import {
  detectInstalledMuxes,
  detectInstalledAITools,
  promptChoice,
  shouldOnboard,
  onboard,
  cmdNoArgs,
  maybeRunStartupUpdatePrompt,
  MUX_OPTIONS,
  type CommandChecker,
  type OnboardDeps,
  type NoArgsDeps,
} from "../core/commands/onboard.ts";
import { loadLocalStartupItems } from "../core/startup-items.ts";
import type { WorkItem } from "../core/types.ts";
import type { InteractiveResult } from "../core/interactive.ts";
import type { MergeStrategy } from "../core/orchestrator.ts";
import type { CheckboxItem } from "../core/tui-widgets.ts";
import type { StartupItemsRefreshResult } from "../core/startup-items.ts";
import type {
  PassiveUpdateStartupState,
  PassiveUpdateState,
} from "../core/update-check.ts";
import type { UpdateRunResult } from "../core/commands/update.ts";

/**
 * Default injection for cmdNoArgs tests that do not exercise the startup
 * update prompt. We never want these tests to read the developer's real
 * `~/.ninthwave/update-check.json`, which could fire an interactive prompt
 * and hang the suite on a machine where an update happens to be available.
 */
const NO_UPDATE_PROMPT: Pick<NoArgsDeps, "getUpdateStartupState"> = {
  getUpdateStartupState: () => ({ cachedState: null, shouldRefresh: false }),
};

function makeAvailableUpdate(
  overrides: Partial<PassiveUpdateState> = {},
): PassiveUpdateState {
  return {
    status: "update-available",
    currentVersion: "0.3.9",
    latestVersion: "0.4.0",
    checkedAt: 1_712_000_000_000,
    installSource: "homebrew",
    updateCommand: {
      executable: "brew",
      args: ["upgrade", "ninthwave"],
      display: "brew upgrade ninthwave",
    },
    promptSuppressed: false,
    ...overrides,
  };
}

function makeStartupState(
  cachedState: PassiveUpdateState | null,
): PassiveUpdateStartupState {
  return { cachedState, shouldRefresh: false };
}

function successfulUpdateResult(): UpdateRunResult {
  return { installSource: "homebrew", exitCode: 0, outcome: "updated" };
}

afterEach(() => {
  cleanupTempRepos();
});

// ── detectInstalledMuxes ────────────────────────────────────────────

describe("detectInstalledMuxes", () => {
  it("returns empty when no muxes are installed", () => {
    const result = detectInstalledMuxes(() => false, () => null);
    expect(result).toEqual([]);
  });

  it("returns cmux when cmux is installed", () => {
    const result = detectInstalledMuxes(() => false, () => "cmux");

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("cmux");
  });
});

// ── detectInstalledAITools ──────────────────────────────────────────

describe("detectInstalledAITools", () => {
  it("returns empty when no tools are installed", () => {
    const result = detectInstalledAITools(() => false);
    expect(result).toEqual([]);
  });

  it("returns only claude when claude is installed", () => {
    const commandExists: CommandChecker = (cmd) => cmd === "claude";
    const result = detectInstalledAITools(commandExists);

    expect(result).toHaveLength(1);
    expect(result[0]!.command).toBe("claude");
    expect(result[0]!.displayName).toBe("Claude Code");
  });

  it("returns only opencode when opencode is installed", () => {
    const commandExists: CommandChecker = (cmd) => cmd === "opencode";
    const result = detectInstalledAITools(commandExists);

    expect(result).toHaveLength(1);
    expect(result[0]!.command).toBe("opencode");
  });

  it("returns only copilot when copilot is installed", () => {
    const commandExists: CommandChecker = (cmd) => cmd === "copilot";
    const result = detectInstalledAITools(commandExists);

    expect(result).toHaveLength(1);
    expect(result[0]!.command).toBe("copilot");
  });

  it("returns only codex when codex is installed", () => {
    const commandExists: CommandChecker = (cmd) => cmd === "codex";
    const result = detectInstalledAITools(commandExists);

    expect(result).toHaveLength(1);
    expect(result[0]!.command).toBe("codex");
  });

  it("returns all four when all are installed", () => {
    const result = detectInstalledAITools(() => true);

    expect(result).toHaveLength(4);
    expect(result.map((t) => t.command)).toEqual([
      "claude",
      "opencode",
      "codex",
      "copilot",
    ]);
  });

  it("returns claude and copilot when both are installed", () => {
    const commandExists: CommandChecker = (cmd) =>
      cmd === "claude" || cmd === "copilot";
    const result = detectInstalledAITools(commandExists);

    expect(result).toHaveLength(2);
    expect(result.map((t) => t.command)).toEqual(["claude", "copilot"]);
  });

  it("preserves preference order (claude > opencode > codex > copilot)", () => {
    const result = detectInstalledAITools(() => true);

    expect(result[0]!.command).toBe("claude");
    expect(result[1]!.command).toBe("opencode");
    expect(result[2]!.command).toBe("codex");
    expect(result[3]!.command).toBe("copilot");
  });
});

// ── promptChoice ────────────────────────────────────────────────────

describe("promptChoice", () => {
  it("returns the correct index for a valid choice", async () => {
    const items = ["apple", "banana", "cherry"];
    const mockPrompt = async () => "2";

    const result = await promptChoice(
      items,
      (item) => item,
      mockPrompt,
    );

    expect(result).toBe(1); // 0-based index for "2"
  });

  it("returns 0-based index for first item", async () => {
    const items = ["a", "b"];
    const mockPrompt = async () => "1";

    const result = await promptChoice(items, (i) => i, mockPrompt);

    expect(result).toBe(0);
  });

  it("retries on invalid input then accepts valid choice", async () => {
    const items = ["x", "y"];
    let calls = 0;
    const mockPrompt = async () => {
      calls++;
      if (calls === 1) return "invalid";
      if (calls === 2) return "0"; // out of range
      return "1"; // valid
    };

    const result = await promptChoice(items, (i) => i, mockPrompt);

    expect(result).toBe(0);
    expect(calls).toBe(3);
  });
});

// ── shouldOnboard ───────────────────────────────────────────────────

describe("shouldOnboard", () => {
  it("returns false when projectDir is null", () => {
    expect(shouldOnboard(null)).toBe(false);
  });

  it("returns true when .ninthwave/ does not exist", () => {
    const projectDir = setupTempRepo();
    expect(shouldOnboard(projectDir)).toBe(true);
  });

  it("returns false when .ninthwave/ already exists", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    expect(shouldOnboard(projectDir)).toBe(false);
  });
});

describe("loadLocalStartupItems", () => {
  it("returns parsed runnable startup items without needing PR polling", () => {
    const projectDir = setupTempRepo();
    const workDir = join(projectDir, ".ninthwave", "work");
    const worktreeDir = join(projectDir, ".ninthwave", ".worktrees");

    mkdirSync(workDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    commitAndPushWorkItem(
      projectDir,
      "2-startup-items--H-LOCAL-1.md",
      [
        "# Refactor: Local startup item (H-LOCAL-1)",
        "",
        "**Priority:** High",
        "**Depends on:** None",
        "**Domain:** startup-items",
        "**Lineage:** 10000000-0000-4000-8000-000000000010",
        "",
        "Acceptance: Parsed locally",
      ].join("\n"),
    );

    const items = loadLocalStartupItems(workDir, worktreeDir, projectDir);

    expect(items.map((item) => item.id)).toEqual(["H-LOCAL-1"]);
    expect(items[0]!.title).toBe("Local startup item");
  });
});

// ── onboard (integration) ───────────────────────────────────────────

describe("onboard", () => {
  /**
   * Create a minimal fake bundle directory for setup.
   */
  function createFakeBundle(dir: string): string {
    const bundleDir = join(dir, "bundle");
    mkdirSync(bundleDir, { recursive: true });

    for (const skill of ["decompose"]) {
      const skillDir = join(bundleDir, "skills", skill);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `# ${skill}\n`);
    }

    mkdirSync(join(bundleDir, "agents"), { recursive: true });
    writeFileSync(
      join(bundleDir, "agents", "implementer.md"),
      "# Implementer Agent\n",
    );

    const { spawnSync } = require("child_process");
    spawnSync("git", ["-C", bundleDir, "init", "--quiet"]);
    spawnSync("git", ["-C", bundleDir, "config", "user.email", "test@test.com"]);
    spawnSync("git", ["-C", bundleDir, "config", "user.name", "Test"]);
    spawnSync("git", ["-C", bundleDir, "add", "."]);
    spawnSync("git", ["-C", bundleDir, "commit", "-m", "init", "--quiet"]);

    return bundleDir;
  }

  it("exits early when no AI tool is installed", async () => {
    const projectDir = setupTempRepo();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await onboard(projectDir, {
        commandExists: () => false,
        prompt: async () => "",
        getBundleDir: () => "/fake",
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("No AI coding tool found");
    expect(output).toContain("Install an AI tool");
    expect(output).toContain("Codex CLI:");
    expect(output).toContain("npm install -g @openai/codex");
  });

  it("runs full flow when an AI tool is found", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await onboard(projectDir, {
        commandExists: (cmd) => cmd === "claude",
        prompt: async () => "",
        getBundleDir: () => bundleDir,
        saveUserConfig: () => {},
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    // Should show welcome
    expect(output).toContain("Welcome to ninthwave");
    // Should detect AI tool
    expect(output).toContain("Claude Code");
    // Should run setup
    expect(output).toContain("Setting up ninthwave");
    // Should complete with guidance (no session launch)
    expect(output).toContain("You're all set!");
    expect(output).toContain("populate the live queue");
    expect(output).toContain("Completed items disappear from");
    expect(output).toContain("merged PRs");
    expect(output).toContain("nw history");
    expect(output).not.toContain("Launching");
    expect(output).not.toContain("Session started");
    // .ninthwave/ should now exist from setup
    expect(existsSync(join(projectDir, ".ninthwave"))).toBe(true);
  });

  it("auto-selects single detected AI tool without prompting", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await onboard(projectDir, {
        commandExists: (cmd) => cmd === "claude",
        prompt: async () => "",
        getBundleDir: () => bundleDir,
        saveUserConfig: () => {},
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    // Single tool should be auto-selected -- no "Choose" prompt for AI tool
    expect(output).not.toContain("Choose [1-");
    expect(output).toContain("You're all set!");
    expect(output).toContain("populate the live queue");
  });

  it("persists detected tools via user config instead of project config", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle");
    const savedUpdates: Array<Record<string, unknown>> = [];

    await onboard(projectDir, {
      commandExists: (cmd) => cmd === "claude",
      prompt: async () => "",
      getBundleDir: () => bundleDir,
      saveUserConfig: (updates) => savedUpdates.push(updates),
    });

    expect(savedUpdates).toEqual([{ ai_tools: ["claude"] }]);

    const projectConfig = JSON.parse(stripJsonComments(readFileSync(join(projectDir, ".ninthwave", "config.json"), "utf8")));
    expect(projectConfig).not.toHaveProperty("ai_tools");
  });

  it("shows Codex in the onboarding tool picker and persists the selection", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle");
    const savedUpdates: Array<Record<string, unknown>> = [];
    let renderedItems: CheckboxItem[] = [];

    await onboard(projectDir, {
      commandExists: (cmd) => cmd === "claude" || cmd === "codex",
      prompt: async () => "",
      getBundleDir: () => bundleDir,
      widgetIO: {
        write: () => {},
        onKey: () => {},
        offKey: () => {},
        getRows: () => 24,
        getCols: () => 80,
      },
      runCheckboxList: async (_io, items) => {
        renderedItems = items;
        return { cancelled: false, selectedIds: ["codex"], allSelected: false };
      },
      saveUserConfig: (updates) => savedUpdates.push(updates),
    });

    expect(renderedItems.map((item) => item.label)).toEqual(["Claude Code", "Codex CLI"]);
    expect(savedUpdates).toContainEqual({ ai_tools: ["codex"] });
  });
});

// ── cmdNoArgs ──────────────────────────────────────────────────────

describe("cmdNoArgs", () => {
  /** Helper to build a fake WorkItem */
  function fakeWorkItem(id: string, title: string): WorkItem {
    return {
      id,
      title,
      priority: "medium",
      domain: "test",
      dependencies: [],
      bundleWith: [],
      status: "open",
      filePath: `2-test--${id}.md`,
      rawText: "",
      filePaths: [],
      testPlan: "",
    };
  }

  it("prints help when not in a TTY", async () => {
    let helpCalled = false;
    let ensureMuxCalled = false;
    await cmdNoArgs("/some/project", {
      isTTY: false,
      printHelp: () => { helpCalled = true; },
      ensureMux: async () => { ensureMuxCalled = true; },
    });
    expect(helpCalled).toBe(true);
    expect(ensureMuxCalled).toBe(false);
  });

  it("prints help when projectRoot is null (no git repo)", async () => {
    let helpCalled = false;
    let ensureMuxCalled = false;
    await cmdNoArgs(null, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      printHelp: () => { helpCalled = true; },
      ensureMux: async () => { ensureMuxCalled = true; },
    });
    expect(helpCalled).toBe(true);
    expect(ensureMuxCalled).toBe(false);
  });

  it("runs onboarding when .ninthwave/ does not exist", async () => {
    const projectDir = setupTempRepo();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await cmdNoArgs(projectDir, {
        isTTY: true,
      ...NO_UPDATE_PROMPT,
        existsSync: (p) => typeof p === "string" && !p.includes(".ninthwave"),
        commandExists: () => false, // Will exit early at AI tool detection
        prompt: async () => "",
        getBundleDir: () => "/fake",
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    // Onboard flow starts with welcome message
    expect(output).toContain("Welcome to ninthwave");
  });

  it("routes zero items without a daemon into interactive startup without waiting", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let ensureMuxCalled = false;
    let interactiveFlowCalled = false;
    let receivedTodos: WorkItem[] | undefined;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [],
      isDaemonRunning: () => null,
      ensureMux: async () => { ensureMuxCalled = true; },
      sleep: async () => {
        throw new Error("old wait loop should not run");
      },
      runInteractiveFlow: async (todos) => {
        interactiveFlowCalled = true;
        receivedTodos = todos;
        return null;
      },
    });

    expect(ensureMuxCalled).toBe(true);
    expect(interactiveFlowCalled).toBe(true);
    expect(receivedTodos).toEqual([]);
  });

  it("routes zero items without a daemon into startup when work dir is missing", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });

    let parseCalled = false;
    let interactiveFlowCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      existsSync: (p) => {
        if (typeof p === "string" && p.endsWith("work")) return false;
        return true;
      },
      parseWorkItems: () => {
        parseCalled = true;
        return [fakeWorkItem("H-1", "Test item")];
      },
      isDaemonRunning: () => null,
      ensureMux: async () => {},
      runInteractiveFlow: async () => { interactiveFlowCalled = true; return null; },
    });

    expect(parseCalled).toBe(false);
    expect(interactiveFlowCalled).toBe(true);
  });

  it("routes zero items with a running daemon straight to status", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });

    let parseCalled = false;
    let ensureMuxCalled = false;
    let statusWatchCalled = false;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await cmdNoArgs(projectDir, {
        isTTY: true,
      ...NO_UPDATE_PROMPT,
        parseWorkItems: () => {
          parseCalled = true;
          return [];
        },
        isDaemonRunning: () => 12345,
        ensureMux: async () => { ensureMuxCalled = true; },
        runStatusWatch: async () => { statusWatchCalled = true; },
      });
    } finally {
      console.log = origLog;
    }

    expect(parseCalled).toBe(false);
    expect(ensureMuxCalled).toBe(false);
    expect(statusWatchCalled).toBe(true);
    const output = logs.join("\n");
    expect(output).toContain("Orchestrator is running");
    expect(output).toContain("12345");
  });

  it("calls cmdWatch with item IDs, merge strategy, and session limit", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const items = [
      fakeWorkItem("H-FOO-1", "First task"),
      fakeWorkItem("H-FOO-2", "Second task"),
    ];
    let watchArgs: string[] = [];
    let watchCalled = false;

    const interactiveResult: InteractiveResult = {
      itemIds: ["H-FOO-1", "H-FOO-2"],
      mergeStrategy: "auto" as MergeStrategy,
      maxInflight: 3,
      allSelected: false,
      reviewMode: "on",
      connectionAction: null,
    };

    let ensureMuxCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => items,
      isDaemonRunning: () => null,
      ensureMux: async () => { ensureMuxCalled = true; },
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: () => {},
      runInteractiveFlow: async () => interactiveResult,
      runWatch: async (args) => {
        watchCalled = true;
        watchArgs = args;
      },
    });

    expect(ensureMuxCalled).toBe(true);
    expect(watchCalled).toBe(true);
    expect(watchArgs).toContain("--items");
    expect(watchArgs).toContain("H-FOO-1");
    expect(watchArgs).toContain("H-FOO-2");
    expect(watchArgs).toContain("--merge-strategy");
    expect(watchArgs).toContain("auto");
    expect(watchArgs).toContain("--max-inflight");
    expect(watchArgs).toContain("3");
    // Should NOT have --watch when not all selected
    expect(watchArgs).not.toContain("--watch");
  });

  it("uses the runnable startup loader for the interactive picker", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const allItems = [
      fakeWorkItem("H-MERGED-1", "Merged task"),
      fakeWorkItem("H-ACTIVE-1", "Active task"),
    ];
    const runnableItems = [allItems[1]!];
    let seenTodos: WorkItem[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => allItems,
      loadStartupItems: () => runnableItems,
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      runInteractiveFlow: async (todos) => {
        seenTodos = todos;
        return null;
      },
    });

    expect(seenTodos.map((item) => item.id)).toEqual(["H-ACTIVE-1"]);
  });

  it("passes local items immediately and defers startup pruning refresh", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const localItems = [
      fakeWorkItem("H-LOCAL-1", "Local task"),
      fakeWorkItem("H-LOCAL-2", "Another task"),
    ];
    let resolveRefresh!: (result: StartupItemsRefreshResult) => void;
    const refreshPromise = new Promise<StartupItemsRefreshResult>((resolve) => {
      resolveRefresh = resolve;
    });
    let refreshCalled = false;
    let seenRefreshResult: StartupItemsRefreshResult | undefined;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => localItems,
      refreshStartupItems: async (_workDir, _worktreeDir, _projectRoot, previousItems) => {
        refreshCalled = true;
        expect(previousItems.map((item) => item.id)).toEqual(["H-LOCAL-1", "H-LOCAL-2"]);
        return refreshPromise;
      },
      isDaemonRunning: () => null,
      ensureMux: async () => {},
      loadConfig: () => ({ review_external: false } as any),
      runInteractiveFlow: async (todos, _defaultMaxInflight, deps) => {
        expect(todos.map((item) => item.id)).toEqual(["H-LOCAL-1", "H-LOCAL-2"]);
        expect(refreshCalled).toBe(false);

        const deferredRefresh = deps?.refreshStartupItems;
        expect(deferredRefresh).toBeTypeOf("function");

        const pendingRefresh = deferredRefresh!();
        expect(refreshCalled).toBe(true);

        resolveRefresh({
          localItems,
          activeItems: [localItems[1]!],
          prunedItems: [{ id: "H-LOCAL-1", prNumber: 42, matchMode: "lineage" }],
          diff: {
            keptItemIds: ["H-LOCAL-2"],
            removedItemIds: ["H-LOCAL-1"],
            addedItemIds: [],
          },
          changes: [
            {
              id: "H-LOCAL-1",
              type: "removed",
              reason: "merged-pruned",
              prNumber: 42,
              matchMode: "lineage",
            },
          ],
        });
        seenRefreshResult = await pendingRefresh;
        return null;
      },
    });

    expect(seenRefreshResult?.activeItems.map((item) => item.id)).toEqual(["H-LOCAL-2"]);
  });

  it("passes --watch when allSelected is true", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: () => {},
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        maxInflight: 4,
        allSelected: true,
        reviewMode: "on",
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--watch");
  });

  it("passes --watch without --items when futureOnly is true", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: () => {},
      runInteractiveFlow: async () => ({
        itemIds: [],
        mergeStrategy: "auto" as MergeStrategy,
        maxInflight: 4,
        allSelected: false,
        futureOnly: true,
        reviewMode: "on",
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--watch");
    expect(watchArgs).toContain("--future-only-startup");
    expect(watchArgs).not.toContain("--items");
  });

  it("passes --review-max-inflight 0 when reviewMode is 'off'", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: () => {},
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        maxInflight: 4,
        allSelected: false,
        reviewMode: "off" as const,
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--review-max-inflight");
    expect(watchArgs).toContain("0");
  });

  it("does not pass review flags when reviewMode is 'on'", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: () => {},
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        maxInflight: 4,
        allSelected: false,
        reviewMode: "on" as const,
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).not.toContain("--review-external");
    expect(watchArgs).not.toContain("--review-max-inflight");
  });

  it("passes --local when onboarding result has no connectionAction (explicit local intent)", async () => {
    // H-BS-4: orchestrator now auto-connects when broker_secret is configured.
    // Onboarding must forward the user's "local" choice explicitly so the
    // config-based default does not flip them into connect mode.
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: () => {},
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        maxInflight: 4,
        allSelected: false,
        reviewMode: "on" as const,
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--local");
    expect(watchArgs).not.toContain("--connect");
  });

  it("passes --connect for crew join action (auto-join via project config)", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: () => {},
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        maxInflight: 4,
        allSelected: false,
        reviewMode: "on" as const,
        connectionAction: { type: "connect" as const },
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--connect");
    expect(watchArgs).not.toContain("--crew");
  });

  it("passes --connect for crew connect action", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: () => {},
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        maxInflight: 4,
        allSelected: false,
        reviewMode: "on" as const,
        connectionAction: { type: "connect" as const },
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--connect");
  });

  it("exits gracefully when user cancels interactive flow", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      runInteractiveFlow: async () => null, // User cancelled
      runWatch: async () => { watchCalled = true; },
    });

    expect(watchCalled).toBe(false);
  });

  it("goes directly to TUI selection without mode prompt", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let interactiveCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: () => {},
      runInteractiveFlow: async () => {
        interactiveCalled = true;
        return {
          itemIds: ["H-1"],
          mergeStrategy: "auto" as MergeStrategy,
          maxInflight: 4,
          allSelected: false,
          reviewMode: "on" as const,
          connectionAction: null,
        };
      },
      runWatch: async () => {},
    });

    expect(interactiveCalled).toBe(true);
  });

  it("defaults review mode to off at startup", async () => {
    // Sessions always boot from the hardcoded safe defaults (manual /
    // reviews off / local), independent of whatever is on disk.
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let interactiveCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: true } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: () => {},
      runInteractiveFlow: async (_todos, _wip, deps) => {
        interactiveCalled = true;
        expect(deps?.defaultReviewMode).toBe("off");
        expect(deps?.defaultSettings?.reviewMode).toBe("off");
        return {
          itemIds: ["H-1"],
          mergeStrategy: "auto" as MergeStrategy,
          maxInflight: 4,
          allSelected: false,
          reviewMode: "on" as const,
          connectionAction: null,
        };
      },
      runWatch: async () => {},
    });

    expect(interactiveCalled).toBe(true);
  });

  it("reads saved tool IDs from user config but ignores legacy mode/review/collab fields", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: true, ai_tools: ["claude"] } as any),
      // Legacy fields in the user config must not leak into startup defaults.
      loadUserConfig: () => ({ ai_tools: ["opencode", "copilot"] } as any),
      runInteractiveFlow: async (_todos, _wip, deps) => {
        expect(deps?.defaultReviewMode).toBe("off");
        expect(deps?.defaultSettings).toEqual({
          mergeStrategy: "manual",
          reviewMode: "off",
          collaborationMode: "local",
        });
        expect(deps?.savedToolIds).toEqual(["opencode", "copilot"]);
        return null;
      },
      runWatch: async () => {
        throw new Error("runWatch should not be called when interactive flow cancels");
      },
    });
  });

  it("persists only durable startup prefs (max_inflight, ai_tools) -- never merge/review/collab", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const savedUpdates: Array<Record<string, unknown>> = [];
    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: (updates) => savedUpdates.push(updates as Record<string, unknown>),
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        maxInflight: 4,
        allSelected: false,
        reviewMode: "on" as const,
        connectionAction: { type: "connect" as const },
        aiTools: ["opencode", "copilot"],
        aiTool: "opencode",
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(savedUpdates).toHaveLength(1);
    expect(savedUpdates[0]).toMatchObject({
      max_inflight: 4,
      ai_tools: ["opencode", "copilot"],
    });
    // Mode / review / collaboration are ephemeral and never persisted.
    expect(savedUpdates[0]).not.toHaveProperty("merge_strategy");
    expect(savedUpdates[0]).not.toHaveProperty("review_mode");
    expect(savedUpdates[0]).not.toHaveProperty("collaboration_mode");
    expect(watchArgs).toContain("--connect");
    expect(watchArgs).toContain("--tool");
    expect(watchArgs).toContain("opencode,copilot");
  });

  it("passes join codes at runtime without saving them to config", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const savedUpdates: Array<Record<string, unknown>> = [];
    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      ...NO_UPDATE_PROMPT,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false } as any),
      loadUserConfig: () => ({}),
      saveUserConfig: (updates) => savedUpdates.push(updates as Record<string, unknown>),
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "manual" as MergeStrategy,
        maxInflight: 4,
        allSelected: false,
        reviewMode: "on" as const,
        connectionAction: { type: "connect" as const },
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--connect");
    expect(watchArgs).not.toContain("--crew");
    expect(savedUpdates).toHaveLength(1);
    // mergeStrategy "manual" and reviewMode "on" both match TUI defaults,
    // so neither is re-saved. Session limit 4 differs from computeDefaultMaxInflight() (1),
    // so it is persisted.
    expect(savedUpdates[0]).toMatchObject({
      max_inflight: 4,
    });
    expect(savedUpdates[0]).not.toHaveProperty("collaboration_mode");
    expect(savedUpdates[0]).not.toHaveProperty("backend_mode");
    expect(savedUpdates[0]).not.toHaveProperty("merge_strategy");
    expect(savedUpdates[0]).not.toHaveProperty("review_mode");
    expect(savedUpdates[0]).not.toHaveProperty("code");
    expect(JSON.stringify(savedUpdates[0])).not.toContain("K2F9-AB3X-7YPL-QM4N");
  });

  // ── Startup update prompt (H-UPD-3) ───────────────────────────────

  describe("startup update prompt", () => {
    /**
     * Swallow console output from cmdNoArgs during a startup-update-prompt
     * test. `maybeRunStartupUpdatePrompt` writes directly to console.log
     * (the `log` field is not plumbed through `NoArgsDeps`), so we redirect
     * it here to keep the test runner output clean.
     */
    async function runSilent<T>(fn: () => Promise<T>): Promise<T> {
      const origLog = console.log;
      console.log = () => {};
      try {
        return await fn();
      } finally {
        console.log = origLog;
      }
    }

    it("runs the update prompt before ensureMux and the interactive picker", async () => {
      const projectDir = setupTempRepo();
      mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

      const callOrder: string[] = [];
      let promptRendered = false;

      await runSilent(() => cmdNoArgs(projectDir, {
        isTTY: true,
        parseWorkItems: () => [],
        isDaemonRunning: () => null,
        loadConfig: () => ({ review_external: false } as any),
        loadUserConfig: () => ({}),
        saveUserConfig: () => {},
        getUpdateStartupState: () => {
          callOrder.push("update-check");
          return makeStartupState(makeAvailableUpdate());
        },
        prompt: async (question) => {
          // The Codex-style prompt ends with "Choose [1-3]: ".
          promptRendered = question.includes("Choose");
          return "2"; // Skip
        },
        ensureMux: async () => { callOrder.push("mux"); },
        runInteractiveFlow: async () => {
          callOrder.push("interactive");
          return null;
        },
        runWatch: async () => { callOrder.push("watch"); },
      }));

      expect(promptRendered).toBe(true);
      expect(callOrder[0]).toBe("update-check");
      expect(callOrder.indexOf("update-check")).toBeLessThan(callOrder.indexOf("mux"));
      expect(callOrder.indexOf("mux")).toBeLessThan(callOrder.indexOf("interactive"));
    });

    it("does not show the prompt when no update is cached", async () => {
      const projectDir = setupTempRepo();
      mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

      let promptCalls = 0;
      let interactiveCalled = false;

      await runSilent(() => cmdNoArgs(projectDir, {
        isTTY: true,
        parseWorkItems: () => [],
        isDaemonRunning: () => null,
        loadConfig: () => ({ review_external: false } as any),
        loadUserConfig: () => ({}),
        saveUserConfig: () => {},
        getUpdateStartupState: () => makeStartupState(null),
        prompt: async () => { promptCalls++; return ""; },
        runInteractiveFlow: async () => {
          interactiveCalled = true;
          return null;
        },
      }));

      expect(promptCalls).toBe(0);
      expect(interactiveCalled).toBe(true);
    });

    it("does not show the prompt when the cached version is already dismissed", async () => {
      const projectDir = setupTempRepo();
      mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

      let promptCalls = 0;

      await runSilent(() => cmdNoArgs(projectDir, {
        isTTY: true,
        parseWorkItems: () => [],
        isDaemonRunning: () => null,
        loadConfig: () => ({ review_external: false } as any),
        loadUserConfig: () => ({}),
        saveUserConfig: () => {},
        getUpdateStartupState: () =>
          makeStartupState(makeAvailableUpdate({ promptSuppressed: true })),
        prompt: async () => { promptCalls++; return ""; },
        runInteractiveFlow: async () => null,
      }));

      expect(promptCalls).toBe(0);
    });

    it("Skip continues into normal startup without persisting any new user config", async () => {
      const projectDir = setupTempRepo();
      mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

      const savedUpdates: Array<Record<string, unknown>> = [];
      let interactiveCalled = false;
      let runUpdateCalled = false;

      await runSilent(() => cmdNoArgs(projectDir, {
        isTTY: true,
        parseWorkItems: () => [],
        isDaemonRunning: () => null,
        loadConfig: () => ({ review_external: false } as any),
        loadUserConfig: () => ({}),
        saveUserConfig: (updates) => savedUpdates.push(updates as Record<string, unknown>),
        getUpdateStartupState: () => makeStartupState(makeAvailableUpdate()),
        runUpdate: () => {
          runUpdateCalled = true;
          return successfulUpdateResult();
        },
        prompt: async () => "2",
        runInteractiveFlow: async () => {
          interactiveCalled = true;
          return null;
        },
      }));

      expect(runUpdateCalled).toBe(false);
      expect(interactiveCalled).toBe(true);
      // "Skip" must not persist anything about the update. saveUserConfig is
      // still invoked for normal startup persistence, but never with the
      // skipped_update_version key.
      for (const update of savedUpdates) {
        expect(update).not.toHaveProperty("skipped_update_version");
      }
    });

    it("Skip until next version persists the dismissed version and continues startup", async () => {
      const projectDir = setupTempRepo();
      mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

      const savedUpdates: Array<Record<string, unknown>> = [];
      let interactiveCalled = false;

      await runSilent(() => cmdNoArgs(projectDir, {
        isTTY: true,
        parseWorkItems: () => [],
        isDaemonRunning: () => null,
        loadConfig: () => ({ review_external: false } as any),
        loadUserConfig: () => ({}),
        saveUserConfig: (updates) => savedUpdates.push(updates as Record<string, unknown>),
        getUpdateStartupState: () =>
          makeStartupState(makeAvailableUpdate({ latestVersion: "0.5.2" })),
        prompt: async () => "3",
        runInteractiveFlow: async () => {
          interactiveCalled = true;
          return null;
        },
      }));

      expect(interactiveCalled).toBe(true);
      const dismissSave = savedUpdates.find(
        (update) => update.skipped_update_version === "0.5.2",
      );
      expect(dismissSave).toBeDefined();
    });

    it("Skip until next version re-shows the prompt once the dismissed version is superseded", async () => {
      // Simulate a user who dismissed 0.4.0 and now has a cache reporting 0.4.1.
      // The passive cache builder in getPassiveUpdateStartupState clears
      // `promptSuppressed` when the skipped version no longer matches, so the
      // startup prompt should run again.
      const projectDir = setupTempRepo();
      mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

      let promptShown = false;

      await runSilent(() => cmdNoArgs(projectDir, {
        isTTY: true,
        parseWorkItems: () => [],
        isDaemonRunning: () => null,
        loadConfig: () => ({ review_external: false } as any),
        loadUserConfig: () => ({ skipped_update_version: "0.4.0" }),
        saveUserConfig: () => {},
        // A cache whose latestVersion is newer than the dismissed version
        // arrives with promptSuppressed: false.
        getUpdateStartupState: () =>
          makeStartupState(
            makeAvailableUpdate({
              latestVersion: "0.4.1",
              promptSuppressed: false,
            }),
          ),
        prompt: async () => {
          promptShown = true;
          return "2"; // skip once
        },
        runInteractiveFlow: async () => null,
      }));

      expect(promptShown).toBe(true);
    });

    it("Update now runs the shared updater and exits startup instead of falling through", async () => {
      const projectDir = setupTempRepo();
      mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

      let runUpdateCalled = false;
      let ensureMuxCalled = false;
      let interactiveCalled = false;
      let watchCalled = false;

      await runSilent(() => cmdNoArgs(projectDir, {
        isTTY: true,
        parseWorkItems: () => [],
        isDaemonRunning: () => null,
        loadConfig: () => ({ review_external: false } as any),
        loadUserConfig: () => ({}),
        saveUserConfig: () => {},
        getUpdateStartupState: () => makeStartupState(makeAvailableUpdate()),
        runUpdate: () => {
          runUpdateCalled = true;
          return successfulUpdateResult();
        },
        prompt: async () => "1",
        ensureMux: async () => { ensureMuxCalled = true; },
        runInteractiveFlow: async () => {
          interactiveCalled = true;
          return null;
        },
        runWatch: async () => { watchCalled = true; },
      }));

      expect(runUpdateCalled).toBe(true);
      expect(ensureMuxCalled).toBe(false);
      expect(interactiveCalled).toBe(false);
      expect(watchCalled).toBe(false);
    });

    it("does not show the update prompt when a daemon is already running", async () => {
      const projectDir = setupTempRepo();
      mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });

      let updateCheckCalled = false;
      let statusWatchCalled = false;

      await runSilent(() => cmdNoArgs(projectDir, {
        isTTY: true,
        parseWorkItems: () => [],
        isDaemonRunning: () => 12345,
        getUpdateStartupState: () => {
          updateCheckCalled = true;
          return makeStartupState(makeAvailableUpdate());
        },
        runStatusWatch: async () => { statusWatchCalled = true; },
      }));

      expect(updateCheckCalled).toBe(false);
      expect(statusWatchCalled).toBe(true);
    });

    it("does not show the update prompt on a fresh onboarding", async () => {
      // When `.ninthwave/` is missing we route into onboard(), which exits
      // early because no AI tool is installed. We must not fall through into
      // the update prompt in that case (a brand-new install does not need to
      // be nagged about updates).
      const projectDir = setupTempRepo();
      let updateCheckCalled = false;

      await runSilent(() => cmdNoArgs(projectDir, {
        isTTY: true,
        existsSync: (p) => typeof p === "string" && !p.includes(".ninthwave"),
        commandExists: () => false,
        prompt: async () => "",
        getBundleDir: () => "/fake",
        getUpdateStartupState: () => {
          updateCheckCalled = true;
          return makeStartupState(makeAvailableUpdate());
        },
      }));

      expect(updateCheckCalled).toBe(false);
    });
  });
});

// ── maybeRunStartupUpdatePrompt (unit) ─────────────────────────────

describe("maybeRunStartupUpdatePrompt", () => {
  it("returns action:none when there is no cached update state", async () => {
    const outcome = await maybeRunStartupUpdatePrompt({
      getUpdateStartupState: () => ({ cachedState: null, shouldRefresh: false }),
      prompt: async () => "1",
      runUpdate: () => successfulUpdateResult(),
      saveUserConfig: () => {},
      log: () => {},
    });
    expect(outcome).toEqual({ action: "none" });
  });

  it("returns action:none when the prompt is suppressed for the dismissed version", async () => {
    const outcome = await maybeRunStartupUpdatePrompt({
      getUpdateStartupState: () =>
        makeStartupState(makeAvailableUpdate({ promptSuppressed: true })),
      prompt: async () => "1",
      runUpdate: () => successfulUpdateResult(),
      saveUserConfig: () => {},
      log: () => {},
    });
    expect(outcome).toEqual({ action: "none" });
  });

  it("returns action:none when the status is up-to-date", async () => {
    const outcome = await maybeRunStartupUpdatePrompt({
      getUpdateStartupState: () =>
        makeStartupState(
          makeAvailableUpdate({
            status: "up-to-date",
            currentVersion: "0.4.0",
            latestVersion: "0.4.0",
          }),
        ),
      prompt: async () => "1",
      runUpdate: () => successfulUpdateResult(),
      saveUserConfig: () => {},
      log: () => {},
    });
    expect(outcome).toEqual({ action: "none" });
  });

  it("skip returns action:skip without persisting anything", async () => {
    const savedUpdates: Array<Record<string, unknown>> = [];
    const outcome = await maybeRunStartupUpdatePrompt({
      getUpdateStartupState: () => makeStartupState(makeAvailableUpdate()),
      prompt: async () => "2",
      runUpdate: () => successfulUpdateResult(),
      saveUserConfig: (updates) => savedUpdates.push(updates as Record<string, unknown>),
      log: () => {},
    });
    expect(outcome).toEqual({ action: "skip" });
    expect(savedUpdates).toEqual([]);
  });

  it("skip-forever persists skipped_update_version and reports the dismissed version", async () => {
    const savedUpdates: Array<Record<string, unknown>> = [];
    const outcome = await maybeRunStartupUpdatePrompt({
      getUpdateStartupState: () =>
        makeStartupState(makeAvailableUpdate({ latestVersion: "0.7.1" })),
      prompt: async () => "3",
      runUpdate: () => successfulUpdateResult(),
      saveUserConfig: (updates) => savedUpdates.push(updates as Record<string, unknown>),
      log: () => {},
    });
    expect(outcome).toEqual({ action: "skip-forever", dismissedVersion: "0.7.1" });
    expect(savedUpdates).toEqual([{ skipped_update_version: "0.7.1" }]);
  });

  it("Update now invokes runUpdate and returns its result", async () => {
    let runUpdateCalled = 0;
    const result: UpdateRunResult = { installSource: "direct", exitCode: 0, outcome: "updated" };
    const outcome = await maybeRunStartupUpdatePrompt({
      getUpdateStartupState: () => makeStartupState(makeAvailableUpdate()),
      prompt: async () => "1",
      runUpdate: () => {
        runUpdateCalled += 1;
        return result;
      },
      saveUserConfig: () => {},
      log: () => {},
    });
    expect(runUpdateCalled).toBe(1);
    expect(outcome).toEqual({ action: "updated", result });
  });

  it("re-prompts when the answer is not 1, 2, or 3", async () => {
    const answers = ["", "q", "4", "2"];
    let index = 0;
    const logs: string[] = [];
    const outcome = await maybeRunStartupUpdatePrompt({
      getUpdateStartupState: () => makeStartupState(makeAvailableUpdate()),
      prompt: async () => answers[index++]!,
      runUpdate: () => successfulUpdateResult(),
      saveUserConfig: () => {},
      log: (line) => logs.push(line),
    });
    expect(outcome).toEqual({ action: "skip" });
    // Three invalid answers -> three retry messages.
    expect(logs.filter((line) => line.includes("Please enter 1, 2, or 3"))).toHaveLength(3);
  });

  it("renders the current and latest versions and the release-notes URL", async () => {
    const logs: string[] = [];
    await maybeRunStartupUpdatePrompt({
      getUpdateStartupState: () =>
        makeStartupState(
          makeAvailableUpdate({ currentVersion: "0.3.9", latestVersion: "0.4.0" }),
        ),
      prompt: async () => "2",
      runUpdate: () => successfulUpdateResult(),
      saveUserConfig: () => {},
      log: (line) => logs.push(line),
    });
    const joined = logs.join("\n");
    expect(joined).toContain("v0.3.9");
    expect(joined).toContain("v0.4.0");
    expect(joined).toContain(
      "https://github.com/ninthwave-io/ninthwave/releases/tag/v0.4.0",
    );
    expect(joined).toContain("1. Update now");
    expect(joined).toContain("2. Skip");
    expect(joined).toContain("3. Skip until next version");
  });
});
