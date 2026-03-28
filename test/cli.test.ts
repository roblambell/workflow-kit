// Tests for the command registry and CLI dispatch.

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
      expect(typeof entry.needsTodos).toBe("boolean");
      expect(typeof entry.handler).toBe("function");
      expect(Array.isArray(entry.flags)).toBe(true);
      expect(Array.isArray(entry.examples)).toBe(true);
    }
  });

  it("needsTodos implies needsRoot", () => {
    for (const entry of COMMAND_REGISTRY) {
      if (entry.needsTodos) {
        expect(entry.needsRoot).toBe(true);
      }
    }
  });

  it("usage starts with command name", () => {
    for (const entry of COMMAND_REGISTRY) {
      expect(entry.usage.startsWith(entry.name)).toBe(true);
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

  it("shows help with --help flag", () => {
    const result = runCli("--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("Commands:");
  });

  it("shows per-command help with <command> --help", () => {
    const result = runCli("list", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: ninthwave list");
    expect(result.stdout).toContain("List TODO items");
  });

  it("help output includes all registered commands", () => {
    const result = runCli("--help");
    for (const entry of COMMAND_REGISTRY) {
      expect(result.stdout).toContain(entry.name);
    }
  });
});
