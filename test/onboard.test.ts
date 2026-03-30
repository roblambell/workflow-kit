// Tests for `ninthwave` first-run onboarding and no-args flows (core/commands/onboard.ts).

import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import {
  existsSync,
  mkdirSync,
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
import type { WorkItem } from "../core/types.ts";
import type { InteractiveResult } from "../core/interactive.ts";
import type { MergeStrategy } from "../core/orchestrator.ts";

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

  it("returns all three when all are installed", () => {
    const result = detectInstalledAITools(() => true);

    expect(result).toHaveLength(3);
    expect(result.map((t) => t.command)).toEqual([
      "claude",
      "opencode",
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

  it("preserves preference order (claude > opencode > copilot)", () => {
    const result = detectInstalledAITools(() => true);

    expect(result[0]!.command).toBe("claude");
    expect(result[1]!.command).toBe("opencode");
    expect(result[2]!.command).toBe("copilot");
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

// ── onboard (integration) ───────────────────────────────────────────

describe("onboard", () => {
  /**
   * Create a minimal fake bundle directory for setup.
   */
  function createFakeBundle(dir: string): string {
    const bundleDir = join(dir, "bundle");
    mkdirSync(bundleDir, { recursive: true });

    for (const skill of ["work", "decompose"]) {
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
      source: "test",
      domain: "test",
      description: "",
      dependencies: [],
      dependents: [],
      files: [],
      filename: `2-test--${id}.md`,
      inProgress: false,
    };
  }

  it("prints help when not in a TTY", async () => {
    let helpCalled = false;
    await cmdNoArgs("/some/project", {
      isTTY: false,
      printHelp: () => { helpCalled = true; },
    });
    expect(helpCalled).toBe(true);
  });

  it("prints help when projectRoot is null (no git repo)", async () => {
    let helpCalled = false;
    await cmdNoArgs(null, {
      isTTY: true,
      printHelp: () => { helpCalled = true; },
    });
    expect(helpCalled).toBe(true);
  });

  it("runs onboarding when .ninthwave/ does not exist", async () => {
    const projectDir = setupTempRepo();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await cmdNoArgs(projectDir, {
        isTTY: true,
        existsSync: (p: string) => !p.includes(".ninthwave"),
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

  it("waits for items and then routes to interactive flow when items appear", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let parseCallCount = 0;
    let interactiveFlowCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => {
        parseCallCount++;
        return parseCallCount > 1 ? [fakeWorkItem("H-1", "Test item")] : [];
      },
      sleep: async () => {},
      isDaemonRunning: () => null,
      runInteractiveFlow: async () => { interactiveFlowCalled = true; return null; },
    });

    expect(parseCallCount).toBeGreaterThan(1);
    expect(interactiveFlowCalled).toBe(true);
  });

  it("waits when work dir is missing until it appears", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    // No work/ subdirectory initially

    let existsCallCount = 0;
    let interactiveFlowCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      existsSync: (p: string) => {
        // .ninthwave/ always exists; work dir appears after first sleep
        if (typeof p === "string" && p.endsWith("work")) {
          existsCallCount++;
          return existsCallCount > 1;
        }
        return true;
      },
      parseWorkItems: () => [fakeWorkItem("H-1", "Test item")],
      sleep: async () => {},
      isDaemonRunning: () => null,
      runInteractiveFlow: async () => { interactiveFlowCalled = true; return null; },
    });

    expect(interactiveFlowCalled).toBe(true);
  });

  it("routes to status view when daemon is running", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let statusWatchCalled = false;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await cmdNoArgs(projectDir, {
        isTTY: true,
        parseWorkItems: () => [fakeWorkItem("H-1", "Test item")],
        isDaemonRunning: () => 12345,
        runStatusWatch: async () => { statusWatchCalled = true; },
      });
    } finally {
      console.log = origLog;
    }

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
      mergeStrategy: "auto" as MergeStrategy,
      wipLimit: 3,
      allSelected: false,
      reviewMode: "mine",
      connectionAction: null,
    };

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => items,
      isDaemonRunning: () => null,
      loadConfig: () => ({ review_external: false, schedule_enabled: false }),
      runInteractiveFlow: async () => interactiveResult,
      runWatch: async (args) => {
        watchCalled = true;
        watchArgs = args;
      },
    });

    expect(watchCalled).toBe(true);
    expect(watchArgs).toContain("--items");
    expect(watchArgs).toContain("H-FOO-1");
    expect(watchArgs).toContain("H-FOO-2");
    expect(watchArgs).toContain("--merge-strategy");
    expect(watchArgs).toContain("auto");
    expect(watchArgs).toContain("--wip-limit");
    expect(watchArgs).toContain("3");
    // Should NOT have --watch when not all selected
    expect(watchArgs).not.toContain("--watch");
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
        wipLimit: 4,
        allSelected: true,
        reviewMode: "mine",
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--watch");
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
        wipLimit: 4,
        allSelected: false,
        reviewMode: "all" as const,
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--review-external");
  });

  it("passes --review-wip-limit 0 when reviewMode is 'off'", async () => {
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
        wipLimit: 4,
        allSelected: false,
        reviewMode: "off" as const,
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).toContain("--review-wip-limit");
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
        wipLimit: 4,
        allSelected: false,
        reviewMode: "mine" as const,
        connectionAction: null,
      }),
      runWatch: async (args) => { watchArgs = args; },
    });

    expect(watchArgs).not.toContain("--review-external");
    expect(watchArgs).not.toContain("--review-wip-limit");
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
        wipLimit: 4,
        allSelected: false,
        reviewMode: "mine" as const,
        connectionAction: { type: "join" as const, code: "K2F9-AB3X-7YPL-QM4N" },
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
        wipLimit: 4,
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
          mergeStrategy: "auto" as MergeStrategy,
          wipLimit: 4,
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
      runInteractiveFlow: async (_todos, _wip, deps) => {
        interactiveCalled = true;
        // Verify that the deps include the correct defaultReviewMode
        expect(deps?.defaultReviewMode).toBe("all");
        return {
          itemIds: ["H-1"],
          mergeStrategy: "auto" as MergeStrategy,
          wipLimit: 4,
          allSelected: false,
          reviewMode: "all" as const,
          connectionAction: null,
        };
      },
      runWatch: async () => {},
    });

    expect(interactiveCalled).toBe(true);
  });
});
