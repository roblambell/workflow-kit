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
  launchSession,
  shouldOnboard,
  onboard,
  cmdNoArgs,
  MUX_OPTIONS,
  type CommandChecker,
  type OnboardDeps,
  type NoArgsDeps,
} from "../core/commands/onboard.ts";
import type { WorkItem } from "../core/types.ts";
import type { MergeStrategy } from "../core/orchestrator.ts";

afterEach(() => {
  cleanupTempRepos();
});

// ── detectInstalledMuxes ────────────────────────────────────────────

describe("detectInstalledMuxes", () => {
  it("returns empty when no muxes are installed", () => {
    const result = detectInstalledMuxes(() => false);
    expect(result).toEqual([]);
  });

  it("returns cmux when cmux is installed", () => {
    const commandExists: CommandChecker = (cmd) => cmd === "cmux";
    const result = detectInstalledMuxes(commandExists);

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

// ── launchSession ───────────────────────────────────────────────────

describe("launchSession", () => {
  it("launches cmux workspace and returns ref", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockRun = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === "new-workspace") {
        return { stdout: "workspace:1", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const ref = launchSession("cmux", "claude", "/tmp/project", mockRun, () => {});

    expect(ref).toBe("workspace:1");
    expect(calls[0]!.cmd).toBe("cmux");
    expect(calls[0]!.args).toContain("new-workspace");
    expect(calls[0]!.args).toContain("claude");
  });

  it("sends pre-seed message to cmux workspace after delay", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let sleptMs = 0;
    const mockRun = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === "new-workspace") {
        return { stdout: "workspace:5", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    launchSession("cmux", "claude", "/tmp/project", mockRun, (ms) => {
      sleptMs += ms;
    });

    const sendCall = calls.find(
      (c) => c.cmd === "cmux" && c.args.includes("send"),
    );
    expect(sendCall).toBeDefined();
    expect(sendCall!.args).toContain("--workspace");
    expect(sendCall!.args).toContain("workspace:5");
    expect(sleptMs).toBeGreaterThan(0);
  });

  it("returns null when cmux workspace creation fails", () => {
    const mockRun = () => ({ stdout: "", stderr: "error", exitCode: 1 });

    const ref = launchSession("cmux", "claude", "/tmp/project", mockRun, () => {});

    expect(ref).toBeNull();
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

    for (const skill of ["work", "decompose", "ninthwave-upgrade"]) {
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

  it("exits early when no multiplexer is installed", async () => {
    const projectDir = setupTempRepo();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await onboard(projectDir, {
        commandExists: () => false,
        prompt: async () => "",
        runShell: () => ({ stdout: "", stderr: "", exitCode: 0 }),
        sleep: () => {},
        getBundleDir: () => "/fake",
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("No multiplexer found");
    expect(output).toContain("Install a multiplexer");
    // Should not reach AI tool detection
    expect(output).not.toContain("AI coding tools");
  });

  it("exits early when no AI tool is installed", async () => {
    const projectDir = setupTempRepo();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await onboard(projectDir, {
        commandExists: (cmd) => cmd === "cmux",
        prompt: async () => "", // accept default (Y)
        runShell: () => ({ stdout: "", stderr: "", exitCode: 0 }),
        sleep: () => {},
        getBundleDir: () => "/fake",
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("No AI coding tool found");
    expect(output).toContain("Install an AI tool");
  });

  it("runs full flow when one mux and one AI tool are found", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    const shellCalls: Array<{ cmd: string; args: string[] }> = [];
    let attachCalled = false;

    try {
      await onboard(projectDir, {
        commandExists: (cmd) => cmd === "cmux" || cmd === "claude",
        prompt: async () => "", // accept defaults
        runShell: (cmd, args) => {
          shellCalls.push({ cmd, args });
          if (args[0] === "new-workspace") {
            return { stdout: "workspace:1", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        sleep: () => {},
        getBundleDir: () => bundleDir,
        execAttach: () => {
          attachCalled = true;
        },
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    // Should show welcome
    expect(output).toContain("Welcome to ninthwave");
    // Should detect tools
    expect(output).toContain("cmux");
    expect(output).toContain("Claude Code");
    // Should run setup
    expect(output).toContain("Setting up ninthwave");
    // Should launch session
    expect(output).toContain("Session started");
    // Should complete
    expect(output).toContain("You're all set!");
    // cmux doesn't need attach
    expect(attachCalled).toBe(false);
    // .ninthwave/ should now exist from setup
    expect(existsSync(join(projectDir, ".ninthwave"))).toBe(true);
  });

  it("exits when user declines single detected mux", async () => {
    const projectDir = setupTempRepo();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await onboard(projectDir, {
        commandExists: (cmd) => cmd === "cmux" || cmd === "claude",
        prompt: async () => "n",
        runShell: () => ({ stdout: "", stderr: "", exitCode: 0 }),
        sleep: () => {},
        getBundleDir: () => "/fake",
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Install a different multiplexer");
    // Should not reach AI tool detection
    expect(output).not.toContain("AI coding tools");
  });

  it("exits when user declines single detected AI tool", async () => {
    const projectDir = setupTempRepo();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    let promptCount = 0;

    try {
      await onboard(projectDir, {
        commandExists: (cmd) => cmd === "cmux" || cmd === "claude",
        prompt: async () => {
          promptCount++;
          // First prompt: accept mux, second prompt: decline AI tool
          return promptCount <= 1 ? "" : "n";
        },
        runShell: () => ({ stdout: "", stderr: "", exitCode: 0 }),
        sleep: () => {},
        getBundleDir: () => "/fake",
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Install a different AI tool");
  });

  it("handles session launch failure gracefully", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await onboard(projectDir, {
        commandExists: (cmd) => cmd === "cmux" || cmd === "claude",
        prompt: async () => "",
        runShell: () => ({ stdout: "", stderr: "error", exitCode: 1 }),
        sleep: () => {},
        getBundleDir: () => bundleDir,
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Failed to launch session");
    expect(output).toContain("Try manually");
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
        commandExists: () => false, // Will exit early at mux detection
        prompt: async () => "",
        runShell: () => ({ stdout: "", stderr: "", exitCode: 0 }),
        sleep: () => {},
        getBundleDir: () => "/fake",
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    // Onboard flow starts with welcome message
    expect(output).toContain("Welcome to ninthwave");
  });

  it("shows guidance when .ninthwave/ exists but no work items", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await cmdNoArgs(projectDir, {
        isTTY: true,
        parseWorkItems: () => [],
        isDaemonRunning: () => null,
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("No work items found");
    expect(output).toContain("/decompose");
  });

  it("shows guidance when .ninthwave/ exists but work dir missing", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    // No work/ subdirectory

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await cmdNoArgs(projectDir, {
        isTTY: true,
        isDaemonRunning: () => null,
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("No work items found");
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

  it("orchestrate path: calls cmdWatch with all item IDs, merge strategy, and WIP limit", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const items = [
      fakeWorkItem("H-FOO-1", "First task"),
      fakeWorkItem("H-FOO-2", "Second task"),
    ];
    let summaryCalled = false;
    let watchArgs: string[] = [];
    let watchCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => items,
      isDaemonRunning: () => null,
      displayItemsSummary: () => { summaryCalled = true; },
      promptMode: async () => "orchestrate",
      runInteractiveFlow: async () => ({
        itemIds: ["H-FOO-1", "H-FOO-2"],
        mergeStrategy: "approved" as MergeStrategy,
        wipLimit: 3,
      }),
      runWatch: async (args) => {
        watchCalled = true;
        watchArgs = args;
      },
    });

    expect(summaryCalled).toBe(true);
    expect(watchCalled).toBe(true);
    // Should pass all item IDs, merge strategy, and WIP limit as CLI args
    expect(watchArgs).toContain("--items");
    expect(watchArgs).toContain("H-FOO-1");
    expect(watchArgs).toContain("H-FOO-2");
    expect(watchArgs).toContain("--merge-strategy");
    expect(watchArgs).toContain("approved");
    expect(watchArgs).toContain("--wip-limit");
    expect(watchArgs).toContain("3");
  });

  it("launch subset path: calls runInteractiveFlow then cmdRunItems with selected IDs", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const items = [
      fakeWorkItem("H-FOO-1", "First task"),
      fakeWorkItem("H-FOO-2", "Second task"),
    ];
    let interactiveCalled = false;
    let runSelectedCalled = false;
    let runSelectedIds: string[] = [];

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => items,
      isDaemonRunning: () => null,
      displayItemsSummary: () => {},
      promptMode: async () => "launch",
      runInteractiveFlow: async () => {
        interactiveCalled = true;
        return {
          itemIds: ["H-FOO-1"],
          mergeStrategy: "auto" as MergeStrategy,
          wipLimit: 4,
        };
      },
      runSelected: async (ids) => {
        runSelectedCalled = true;
        runSelectedIds = ids;
      },
    });

    expect(interactiveCalled).toBe(true);
    expect(runSelectedCalled).toBe(true);
    expect(runSelectedIds).toEqual(["H-FOO-1"]);
  });

  it("defaults to orchestrate on empty input at mode prompt", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const items = [fakeWorkItem("H-1", "Task")];
    let watchCalled = false;

    // promptMode returning "orchestrate" simulates the default behavior
    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => items,
      isDaemonRunning: () => null,
      displayItemsSummary: () => {},
      promptMode: async () => "orchestrate",
      runInteractiveFlow: async () => ({
        itemIds: ["H-1"],
        mergeStrategy: "auto" as MergeStrategy,
        wipLimit: 4,
      }),
      runWatch: async () => { watchCalled = true; },
    });

    expect(watchCalled).toBe(true);
  });

  it("exits gracefully when user quits at mode prompt", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let runCalled = false;
    let watchCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      displayItemsSummary: () => {},
      promptMode: async () => "quit",
      runSelected: async () => { runCalled = true; },
      runWatch: async () => { watchCalled = true; },
    });

    expect(runCalled).toBe(false);
    expect(watchCalled).toBe(false);
  });

  it("exits gracefully when user quits at item selection in launch subset path", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    let runCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => [fakeWorkItem("H-1", "Task")],
      isDaemonRunning: () => null,
      displayItemsSummary: () => {},
      promptMode: async () => "launch",
      runInteractiveFlow: async () => null, // User cancelled
      runSelected: async () => { runCalled = true; },
    });

    expect(runCalled).toBe(false);
  });

  it("orchestrate path uses runInteractiveFlow (no separate readline prompts)", async () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".ninthwave", "work"), { recursive: true });

    const items = [
      fakeWorkItem("H-FOO-1", "First task"),
      fakeWorkItem("H-FOO-2", "Second task"),
    ];
    let interactiveCalled = false;
    let promptItemsCalled = false;

    await cmdNoArgs(projectDir, {
      isTTY: true,
      parseWorkItems: () => items,
      isDaemonRunning: () => null,
      displayItemsSummary: () => {},
      promptMode: async () => "orchestrate",
      runInteractiveFlow: async () => {
        interactiveCalled = true;
        return {
          itemIds: ["H-FOO-1", "H-FOO-2"],
          mergeStrategy: "auto" as MergeStrategy,
          wipLimit: 4,
        };
      },
      promptItems: async () => {
        promptItemsCalled = true;
        return ["H-FOO-1"];
      },
      runWatch: async () => {},
    });

    expect(interactiveCalled).toBe(true);
    expect(promptItemsCalled).toBe(false);
  });
});
