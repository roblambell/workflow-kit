// Tests for `ninthwave` first-run onboarding and no-args flows (core/commands/onboard.ts).

import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";
import {
  detectInstalledMuxes,
  detectInstalledAITools,
  promptChoice,
  shouldOnboard,
  onboard,
  cmdNoArgs,
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
    writeFileSync(
      join(workDir, "2-startup-items--H-LOCAL-1.md"),
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

    const projectConfig = JSON.parse(readFileSync(join(projectDir, ".ninthwave", "config.json"), "utf8"));
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
      repoAlias: "self",
      rawText: "",
      filePaths: [],
      testPlan: "",
      bootstrap: false,
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

  it("calls cmdWatch with item IDs, merge strategy, and WIP limit", async () => {
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
      backendMode: "cmux",
      mergeStrategy: "auto" as MergeStrategy,
      sessionLimit: 3,
      allSelected: false,
      reviewMode: "mine",
      connectionAction: null,
    };

    let ensureMuxCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => items,
      isDaemonRunning: () => null,
      ensureMux: async () => { ensureMuxCalled = true; },
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
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
    expect(watchArgs).toContain("--backend-mode");
    expect(watchArgs).toContain("cmux");
    expect(watchArgs).toContain("--session-limit");
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
      parseWorkItems: () => allItems,
      loadStartupItems: () => runnableItems,
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
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
      parseWorkItems: () => localItems,
      refreshStartupItems: async (_workDir, _worktreeDir, _projectRoot, previousItems) => {
        refreshCalled = true;
        expect(previousItems.map((item) => item.id)).toEqual(["H-LOCAL-1", "H-LOCAL-2"]);
        return refreshPromise;
      },
      isDaemonRunning: () => null,
      ensureMux: async () => {},
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      runInteractiveFlow: async (todos, _defaultSessionLimit, deps) => {
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
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        sessionLimit: 4,
        allSelected: true,
        reviewMode: "mine",
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
      parseWorkItems: () => [],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      runInteractiveFlow: async () => ({
        itemIds: [],
        mergeStrategy: "auto" as MergeStrategy,
        sessionLimit: 4,
        allSelected: false,
        futureOnly: true,
        reviewMode: "mine",
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--watch");
    expect(watchArgs).toContain("--future-only-startup");
    expect(watchArgs).not.toContain("--items");
  });

  it("passes --review-external when reviewMode is 'all'", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        sessionLimit: 4,
        allSelected: false,
        reviewMode: "all" as const,
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--review-external");
  });

  it("passes --review-session-limit 0 when reviewMode is 'off'", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        sessionLimit: 4,
        allSelected: false,
        reviewMode: "off" as const,
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--review-session-limit");
    expect(watchArgs).toContain("0");
  });

  it("does not pass review flags when reviewMode is 'mine'", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        sessionLimit: 4,
        allSelected: false,
        reviewMode: "mine" as const,
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).not.toContain("--review-external");
    expect(watchArgs).not.toContain("--review-session-limit");
  });

  it("passes --crew <code> for crew join action", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        sessionLimit: 4,
        allSelected: false,
        reviewMode: "mine" as const,
        connectionAction: { type: "join" as const, code: "k2f9ab3x7yplqm4n" },
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--crew");
    expect(watchArgs).toContain("K2F9-AB3X-7YPL-QM4N");
  });

  it("passes --connect for crew connect action", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        sessionLimit: 4,
        allSelected: false,
        reviewMode: "mine" as const,
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
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
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
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      runInteractiveFlow: async () => {
        interactiveCalled = true;
        return {
          itemIds: ["H-1"],
          backendMode: "auto",
          mergeStrategy: "auto" as MergeStrategy,
          sessionLimit: 4,
          allSelected: false,
          reviewMode: "mine" as const,
          connectionAction: null,
        };
      },
      runWatch: async () => {},
    });

    expect(interactiveCalled).toBe(true);
  });

  it("reads review_external from project config to set default review mode", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let interactiveCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: true, schedule_enabled: false }),
      loadUserConfig: () => ({}),
      runInteractiveFlow: async (_todos, _wip, deps) => {
        interactiveCalled = true;
        // Verify that the deps include the correct defaultReviewMode
        expect(deps?.defaultReviewMode).toBe("all");
        expect(deps?.defaultSettings?.reviewMode).toBe("all");
        expect(deps?.defaultSettings?.backendMode).toBe("auto");
        return {
          itemIds: ["H-1"],
          backendMode: "auto",
          mergeStrategy: "auto" as MergeStrategy,
          sessionLimit: 4,
          allSelected: false,
          reviewMode: "all" as const,
          connectionAction: null,
        };
      },
      runWatch: async () => {},
    });

    expect(interactiveCalled).toBe(true);
  });

  it("reads saved tool IDs and startup collaboration defaults from user config", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: true, schedule_enabled: false, ai_tools: ["claude"] }),
      loadUserConfig: () => ({ ai_tools: ["opencode", "copilot"], merge_strategy: "auto", collaboration_mode: "share" }),
      runInteractiveFlow: async (_todos, _wip, deps) => {
        expect(deps?.defaultReviewMode).toBe("all");
        expect(deps?.defaultSettings).toEqual({
          backendMode: "auto",
          mergeStrategy: "auto",
          reviewMode: "all",
          collaborationMode: "share",
          scheduleEnabled: false,
        });
        expect(deps?.savedToolIds).toEqual(["opencode", "copilot"]);
        return null;
      },
      runWatch: async () => {
        throw new Error("runWatch should not be called when interactive flow cancels");
      },
    });
  });

  it("persists the full durable startup payload before launching watch", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const savedUpdates: Array<Record<string, unknown>> = [];
    let watchArgs: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      saveUserConfig: (updates) => savedUpdates.push(updates as Record<string, unknown>),
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        backendMode: "headless",
        mergeStrategy: "auto" as MergeStrategy,
        sessionLimit: 4,
        allSelected: false,
        reviewMode: "all" as const,
        connectionAction: { type: "connect" as const },
        aiTools: ["opencode", "copilot"],
        aiTool: "opencode",
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(savedUpdates).toHaveLength(1);
    expect(savedUpdates[0]).toMatchObject({
      backend_mode: "headless",
      merge_strategy: "auto",
      review_mode: "all",
      session_limit: 4,
      collaboration_mode: "share",
      ai_tools: ["opencode", "copilot"],
      schedule_enabled_projects: {
        [projectDir.replace(/\//g, "-")]: false,
      },
    });
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
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      saveUserConfig: (updates) => savedUpdates.push(updates as Record<string, unknown>),
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        backendMode: "auto",
        mergeStrategy: "manual" as MergeStrategy,
        sessionLimit: 4,
        allSelected: false,
        reviewMode: "mine" as const,
        connectionAction: { type: "join" as const, code: "k2f9ab3x7yplqm4n" },
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--crew");
    expect(watchArgs).toContain("K2F9-AB3X-7YPL-QM4N");
    expect(savedUpdates).toHaveLength(1);
    expect(savedUpdates[0]).toMatchObject({
      backend_mode: "auto",
      merge_strategy: "manual",
      review_mode: "mine",
      session_limit: 4,
      collaboration_mode: "join",
      schedule_enabled_projects: {
        [projectDir.replace(/\//g, "-")]: false,
      },
    });
    expect(savedUpdates[0]).not.toHaveProperty("code");
    expect(JSON.stringify(savedUpdates[0])).not.toContain("K2F9-AB3X-7YPL-QM4N");
  });
});
