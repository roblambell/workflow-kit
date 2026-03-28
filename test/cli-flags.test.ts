// Tests for CLI --version/-v and --help/-h flag handling.

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";

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

describe("CLI flags", () => {
  describe("--version / -v", () => {
    it("prints version with --version flag", () => {
      const result = runCli("--version");
      expect(result.exitCode).toBe(0);
      // Should print something (version string or "unknown")
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("prints version with -v flag", () => {
      const result = runCli("-v");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("--version and -v produce the same output", () => {
      const long = runCli("--version");
      const short = runCli("-v");
      expect(long.stdout).toBe(short.stdout);
    });

    it("--version matches version subcommand", () => {
      const flag = runCli("--version");
      const subcommand = runCli("version");
      expect(flag.stdout).toBe(subcommand.stdout);
    });
  });

  describe("--help / -h", () => {
    it("prints help with --help flag", () => {
      const result = runCli("--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("Commands:");
    });

    it("prints help with -h flag", () => {
      const result = runCli("-h");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("Commands:");
    });

    it("--help and -h produce the same output", () => {
      const long = runCli("--help");
      const short = runCli("-h");
      expect(long.stdout).toBe(short.stdout);
    });

    it("--help matches no-args output", () => {
      const flag = runCli("--help");
      const noArgs = runCli();
      expect(flag.stdout).toBe(noArgs.stdout);
    });

    it("help output includes key commands", () => {
      const result = runCli("--help");
      expect(result.stdout).toContain("init");
      expect(result.stdout).toContain("setup");
      expect(result.stdout).toContain("version");
      expect(result.stdout).toContain("list");
      expect(result.stdout).toContain("watch");
    });
  });

  describe("<command> --help / -h", () => {
    it("shows command-specific help for list --help", () => {
      const result = runCli("list", "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: ninthwave list");
      expect(result.stdout).toContain("List TODO items");
    });

    it("shows command-specific help for list -h", () => {
      const result = runCli("list", "-h");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: ninthwave list");
    });

    it("shows command-specific help for start --help", () => {
      const result = runCli("start", "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: ninthwave start");
      expect(result.stdout).toContain("Launch parallel sessions");
    });

    it("shows command-specific help for watch --help", () => {
      const result = runCli("watch", "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: ninthwave watch");
      expect(result.stdout).toContain("Run the full pipeline");
    });

    it("rejects orchestrate as unknown command", () => {
      const result = runCli("orchestrate");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown command: orchestrate");
    });
  });
});
