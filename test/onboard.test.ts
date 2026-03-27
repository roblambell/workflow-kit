// Tests for `ninthwave` first-run onboarding flow (core/commands/onboard.ts).

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
  AI_TOOLS,
  MUX_OPTIONS,
  type CommandChecker,
  type OnboardDeps,
} from "../core/commands/onboard.ts";

afterEach(() => {
  cleanupTempRepos();
});

// ── detectInstalledMuxes ────────────────────────────────────────────

describe("detectInstalledMuxes", () => {
  it("returns empty when no muxes are installed", () => {
    const result = detectInstalledMuxes(() => false);
    expect(result).toEqual([]);
  });

  it("returns only cmux when cmux is installed", () => {
    const commandExists: CommandChecker = (cmd) => cmd === "cmux";
    const result = detectInstalledMuxes(commandExists);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("cmux");
  });

  it("returns only tmux when tmux is installed", () => {
    const commandExists: CommandChecker = (cmd) => cmd === "tmux";
    const result = detectInstalledMuxes(commandExists);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("tmux");
  });

  it("returns only zellij when zellij is installed", () => {
    const commandExists: CommandChecker = (cmd) => cmd === "zellij";
    const result = detectInstalledMuxes(commandExists);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("zellij");
  });

  it("returns all three when all are installed", () => {
    const result = detectInstalledMuxes(() => true);

    expect(result).toHaveLength(3);
    expect(result.map((m) => m.type)).toEqual(["cmux", "zellij", "tmux"]);
  });

  it("returns cmux and tmux when both are installed", () => {
    const commandExists: CommandChecker = (cmd) =>
      cmd === "cmux" || cmd === "tmux";
    const result = detectInstalledMuxes(commandExists);

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.type)).toEqual(["cmux", "tmux"]);
  });

  it("preserves preference order (cmux > zellij > tmux)", () => {
    const result = detectInstalledMuxes(() => true);

    expect(result[0]!.type).toBe("cmux");
    expect(result[1]!.type).toBe("zellij");
    expect(result[2]!.type).toBe("tmux");
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
    expect(result[0]!.name).toBe("Claude Code");
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

  it("launches tmux session and returns session name", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockRun = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const ref = launchSession("tmux", "claude", "/tmp/project", mockRun, () => {});

    expect(ref).toBe("ninthwave");
    expect(calls[0]!.cmd).toBe("tmux");
    expect(calls[0]!.args).toContain("new-session");
    expect(calls[0]!.args).toContain("ninthwave");
    expect(calls[0]!.args).toContain("claude");
  });

  it("sends pre-seed message to tmux after delay", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let sleptMs = 0;
    const mockRun = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const mockSleep = (ms: number) => {
      sleptMs += ms;
    };

    launchSession("tmux", "claude", "/tmp/project", mockRun, mockSleep);

    // Second call should be send-keys with the welcome message
    const sendCall = calls.find(
      (c) => c.cmd === "tmux" && c.args.includes("send-keys"),
    );
    expect(sendCall).toBeDefined();
    expect(sendCall!.args).toContain("ninthwave");
    expect(sleptMs).toBeGreaterThan(0);
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

  it("creates zellij layout file and returns ref with session and path", () => {
    const mockRun = () => ({ stdout: "", stderr: "", exitCode: 0 });

    const ref = launchSession("zellij", "claude", "/tmp/project", mockRun, () => {});

    expect(ref).toBeTruthy();
    expect(ref).toMatch(/^zellij:ninthwave:/);
    // Layout file should exist
    const layoutPath = ref!.split(":").slice(2).join(":");
    expect(existsSync(layoutPath)).toBe(true);
    // Clean up
    try {
      require("fs").unlinkSync(layoutPath);
    } catch {}
  });

  it("returns null when cmux workspace creation fails", () => {
    const mockRun = () => ({ stdout: "", stderr: "error", exitCode: 1 });

    const ref = launchSession("cmux", "claude", "/tmp/project", mockRun, () => {});

    expect(ref).toBeNull();
  });

  it("returns null when tmux session creation fails", () => {
    const mockRun = () => ({ stdout: "", stderr: "error", exitCode: 1 });

    const ref = launchSession("tmux", "claude", "/tmp/project", mockRun, () => {});

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

    for (const skill of ["work", "decompose", "todo-preview", "ninthwave-upgrade"]) {
      const skillDir = join(bundleDir, "skills", skill);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `# ${skill}\n`);
    }

    mkdirSync(join(bundleDir, "agents"), { recursive: true });
    writeFileSync(
      join(bundleDir, "agents", "todo-worker.md"),
      "# Todo Worker Agent\n",
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

  it("attaches to tmux session after launch", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle");
    let attachCmd: string | null = null;
    let attachArgs: string[] = [];

    const origLog = console.log;
    console.log = () => {};

    try {
      await onboard(projectDir, {
        commandExists: (cmd) => cmd === "tmux" || cmd === "claude",
        prompt: async () => "",
        runShell: () => ({ stdout: "", stderr: "", exitCode: 0 }),
        sleep: () => {},
        getBundleDir: () => bundleDir,
        execAttach: (cmd, args) => {
          attachCmd = cmd;
          attachArgs = args;
        },
      });
    } finally {
      console.log = origLog;
    }

    expect(attachCmd).toBe("tmux");
    expect(attachArgs).toContain("attach-session");
    expect(attachArgs).toContain("ninthwave");
  });

  it("attaches to zellij session after launch", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle");
    let attachCmd: string | null = null;
    let attachArgs: string[] = [];

    const origLog = console.log;
    console.log = () => {};

    try {
      await onboard(projectDir, {
        commandExists: (cmd) => cmd === "zellij" || cmd === "claude",
        prompt: async () => "",
        runShell: () => ({ stdout: "", stderr: "", exitCode: 0 }),
        sleep: () => {},
        getBundleDir: () => bundleDir,
        execAttach: (cmd, args) => {
          attachCmd = cmd;
          attachArgs = args;
        },
      });
    } finally {
      console.log = origLog;
    }

    expect(attachCmd).toBe("zellij");
    expect(attachArgs).toContain("-s");
    expect(attachArgs).toContain("ninthwave");
    expect(attachArgs).toContain("--layout");
  });

  it("exits when user declines single detected mux", async () => {
    const projectDir = setupTempRepo();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await onboard(projectDir, {
        commandExists: (cmd) => cmd === "tmux" || cmd === "claude",
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

  it("lets user choose from multiple muxes", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await onboard(projectDir, {
        commandExists: (cmd) =>
          cmd === "cmux" || cmd === "tmux" || cmd === "claude",
        prompt: async (q) => {
          // Choose tmux (second option) when presented with a choice
          if (q.includes("Choose")) return "2";
          return ""; // accept defaults
        },
        runShell: (cmd, args) => {
          // tmux new-session should be called since user chose tmux
          if (cmd === "tmux" && args[0] === "new-session") {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        sleep: () => {},
        getBundleDir: () => bundleDir,
        execAttach: () => {},
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("multiple multiplexers");
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
