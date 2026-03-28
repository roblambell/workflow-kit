// Tests for the command registry, CLI dispatch, and help output.

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";
import { COMMAND_REGISTRY, lookupCommand } from "../core/help.ts";

const CLI_PATH = join(import.meta.dirname, "..", "core", "cli.ts");

function runCli(...args: string[]) {
  const result = spawnSync("bun", ["run", CLI_PATH, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? 1,
  };
}

describe("COMMAND_REGISTRY", () => {
  it("contains at least 27 commands", () => {
    expect(COMMAND_REGISTRY.length).toBeGreaterThanOrEqual(27);
  });

  it("has unique command names", () => {
    const names = COMMAND_REGISTRY.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry has required fields", () => {
    for (const entry of COMMAND_REGISTRY) {
      expect(entry.name).toBeTruthy();
      expect(entry.usage).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(["workflow", "diagnostic", "advanced"]).toContain(entry.group);
      expect(typeof entry.needsRoot).toBe("boolean");
      expect(typeof entry.needsWork).toBe("boolean");
      expect(typeof entry.handler).toBe("function");
      expect(typeof entry.flags).toBe("object");
      expect(entry.flags).not.toBeNull();
      expect(Array.isArray(entry.examples)).toBe(true);
    }
  });

  it("needsWork implies needsRoot", () => {
    for (const entry of COMMAND_REGISTRY) {
      if (entry.needsWork) {
        expect(entry.needsRoot).toBe(true);
      }
    }
  });

  it("usage starts with command name", () => {
    for (const entry of COMMAND_REGISTRY) {
      expect(entry.usage.startsWith(entry.name)).toBe(true);
    }
  });

  it("every command has a group assignment", () => {
    const validGroups = ["workflow", "diagnostic", "advanced"];
    for (const entry of COMMAND_REGISTRY) {
      expect(validGroups).toContain(entry.group);
    }
  });

  it("no uncategorized commands (all groups accounted for)", () => {
    const grouped = {
      workflow: COMMAND_REGISTRY.filter((c) => c.group === "workflow"),
      diagnostic: COMMAND_REGISTRY.filter((c) => c.group === "diagnostic"),
      advanced: COMMAND_REGISTRY.filter((c) => c.group === "advanced"),
    };
    const total = grouped.workflow.length + grouped.diagnostic.length + grouped.advanced.length;
    expect(total).toBe(COMMAND_REGISTRY.length);
  });

  it("workflow group contains expected commands", () => {
    const workflow = COMMAND_REGISTRY.filter((c) => c.group === "workflow").map((c) => c.name);
    expect(workflow).toContain("init");
    expect(workflow).toContain("watch");
    expect(workflow).toContain("status");
    expect(workflow).toContain("stop");
  });

  it("diagnostic group contains expected commands", () => {
    const diagnostic = COMMAND_REGISTRY.filter((c) => c.group === "diagnostic").map((c) => c.name);
    expect(diagnostic).toContain("doctor");
    expect(diagnostic).toContain("list");
    expect(diagnostic).toContain("deps");
    expect(diagnostic).toContain("conflicts");
    expect(diagnostic).toContain("batch-order");
    expect(diagnostic).toContain("analytics");
  });

  it("flags are records with string values", () => {
    for (const entry of COMMAND_REGISTRY) {
      for (const [key, val] of Object.entries(entry.flags)) {
        expect(typeof key).toBe("string");
        expect(key.startsWith("-")).toBe(true);
        expect(typeof val).toBe("string");
        expect(val.length).toBeGreaterThan(0);
      }
    }
  });

  it("every command has at least one example", () => {
    for (const entry of COMMAND_REGISTRY) {
      expect(entry.examples.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("lookupCommand", () => {
  it("finds existing commands", () => {
    expect(lookupCommand("list")).toBeDefined();
    expect(lookupCommand("list")!.name).toBe("list");
  });

  it("returns undefined for unknown commands", () => {
    expect(lookupCommand("nonexistent")).toBeUndefined();
    expect(lookupCommand("")).toBeUndefined();
  });

  it("finds all registered commands", () => {
    for (const entry of COMMAND_REGISTRY) {
      const found = lookupCommand(entry.name);
      expect(found).toBeDefined();
      expect(found!.name).toBe(entry.name);
    }
  });
});

describe("CLI dispatch", () => {
  it("rejects unknown commands", () => {
    const result = runCli("nonexistent-command");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown command: nonexistent-command");
  });

  it("dispatches version command without project root", () => {
    const result = runCli("version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("dispatches --version flag", () => {
    const flag = runCli("--version");
    const subcommand = runCli("version");
    expect(flag.stdout).toBe(subcommand.stdout);
    expect(flag.exitCode).toBe(0);
  });
});

describe("grouped help (nw --help)", () => {
  it("shows grouped format with Workflow section", () => {
    const result = runCli("--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workflow:");
  });

  it("shows grouped format with Diagnostics section", () => {
    const result = runCli("--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Diagnostics:");
  });

  it("does not show Advanced section", () => {
    const result = runCli("--help");
    expect(result.stdout).not.toContain("Advanced:");
  });

  it("shows workflow commands", () => {
    const result = runCli("--help");
    expect(result.stdout).toContain("watch");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("stop");
  });

  it("shows diagnostic commands", () => {
    const result = runCli("--help");
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("analytics");
  });

  it("shows hint to use --help-all", () => {
    const result = runCli("--help");
    expect(result.stdout).toContain("nw --help-all");
  });

  it("shows Usage header", () => {
    const result = runCli("--help");
    expect(result.stdout).toContain("Usage:");
  });

  it("help output snapshot format", () => {
    const result = runCli("--help");
    // Verify key structural elements
    const lines = result.stdout.split("\n");
    expect(lines[0]).toContain("Usage: nw <command>");
    // Find Workflow section
    const workflowIdx = lines.findIndex((l) => l.startsWith("Workflow:"));
    expect(workflowIdx).toBeGreaterThan(0);
    // Find Diagnostics section after Workflow
    const diagIdx = lines.findIndex((l) => l.startsWith("Diagnostics:"));
    expect(diagIdx).toBeGreaterThan(workflowIdx);
    // Last line should be the hint
    expect(lines[lines.length - 1]).toContain("--help-all");
  });
});

describe("full help (nw --help-all)", () => {
  it("shows all three sections", () => {
    const result = runCli("--help-all");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workflow:");
    expect(result.stdout).toContain("Diagnostics:");
    expect(result.stdout).toContain("Advanced:");
  });

  it("includes advanced commands", () => {
    const result = runCli("--help-all");
    const advanced = COMMAND_REGISTRY.filter((c) => c.group === "advanced");
    for (const cmd of advanced) {
      expect(result.stdout).toContain(cmd.name);
    }
  });

  it("includes all registered commands", () => {
    const result = runCli("--help-all");
    for (const entry of COMMAND_REGISTRY) {
      expect(result.stdout).toContain(entry.name);
    }
  });

  it("shows per-command help hint", () => {
    const result = runCli("--help-all");
    expect(result.stdout).toContain("nw <command> --help");
  });

  it("help-all output snapshot format", () => {
    const result = runCli("--help-all");
    const lines = result.stdout.split("\n");
    // Sections appear in order: Workflow, Diagnostics, Advanced
    const workflowIdx = lines.findIndex((l) => l.startsWith("Workflow:"));
    const diagIdx = lines.findIndex((l) => l.startsWith("Diagnostics:"));
    const advIdx = lines.findIndex((l) => l.startsWith("Advanced:"));
    expect(workflowIdx).toBeGreaterThan(0);
    expect(diagIdx).toBeGreaterThan(workflowIdx);
    expect(advIdx).toBeGreaterThan(diagIdx);
  });
});

describe("per-command rich help (nw <command> --help)", () => {
  it("shows description for watch", () => {
    const result = runCli("watch", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Run the full pipeline");
  });

  it("shows usage line for watch", () => {
    const result = runCli("watch", "--help");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("nw watch");
  });

  it("shows flags for watch", () => {
    const result = runCli("watch", "--help");
    expect(result.stdout).toContain("Flags:");
    expect(result.stdout).toContain("--items");
    expect(result.stdout).toContain("--daemon");
  });

  it("shows flag descriptions for watch", () => {
    const result = runCli("watch", "--help");
    expect(result.stdout).toContain("TODO item IDs to process");
    expect(result.stdout).toContain("Run in daemon mode");
  });

  it("shows examples for watch", () => {
    const result = runCli("watch", "--help");
    expect(result.stdout).toContain("Examples:");
    expect(result.stdout).toContain("nw watch");
    expect(result.stdout).toContain("nw watch --daemon");
  });

  it("shows rich help for list with flags", () => {
    const result = runCli("list", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Flags:");
    expect(result.stdout).toContain("--ready");
    expect(result.stdout).toContain("--domain");
  });

  it("shows rich help for commands without flags", () => {
    const result = runCli("doctor", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nw doctor");
    expect(result.stdout).toContain("Check prerequisites");
    // No Flags section since doctor has no flags
    expect(result.stdout).not.toContain("Flags:");
  });

  it("shows rich help header format", () => {
    const result = runCli("status", "--help");
    // Header line: "nw status — <description>"
    const firstLine = result.stdout.split("\n")[0];
    expect(firstLine).toMatch(/^nw status/);
    expect(firstLine).toContain("—");
  });

  it("every command has working --help", () => {
    for (const entry of COMMAND_REGISTRY) {
      const result = runCli(entry.name, "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(entry.name);
      expect(result.stdout).toContain(entry.description);
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("Examples:");
    }
  });
});
