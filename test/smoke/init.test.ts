// Smoke test: `nw init --yes` creates .ninthwave/ directory structure.

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { setupTempRepo, cleanupTempRepos } from "../helpers.ts";

const CLI_PATH = join(import.meta.dirname, "..", "..", "core", "cli.ts");

function runCli(cwd: string, ...args: string[]) {
  const result = spawnSync("bun", ["run", CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
    env: { ...process.env },
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? 1,
  };
}

describe("smoke: nw init", () => {
  afterEach(() => cleanupTempRepos());

  it("exits 0 and creates .ninthwave/ directory structure", () => {
    const repo = setupTempRepo();

    const result = runCli(repo, "init", "--yes");

    expect(result.exitCode).toBe(0);

    // Verify directory structure was created
    expect(existsSync(join(repo, ".ninthwave"))).toBe(true);
    expect(existsSync(join(repo, ".ninthwave", "work"))).toBe(true);
    expect(existsSync(join(repo, ".ninthwave", "config"))).toBe(true);
    expect(existsSync(join(repo, ".ninthwave", "friction"))).toBe(true);
  });

  it("prints initialization output with summary", () => {
    const repo = setupTempRepo();

    const result = runCli(repo, "init", "--yes");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Initializing ninthwave");
    expect(result.stdout).toContain("Detected:");
    expect(result.stdout).toContain("Done!");
  });

  it("creates .gitignore with worktrees entry", () => {
    const repo = setupTempRepo();

    const result = runCli(repo, "init", "--yes");

    expect(result.exitCode).toBe(0);

    const gitignorePath = join(repo, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);

    const content = require("fs").readFileSync(gitignorePath, "utf-8");
    expect(content).toContain(".worktrees/");
  });

  it("produces no unhandled exceptions in stderr", () => {
    const repo = setupTempRepo();

    const result = runCli(repo, "init", "--yes");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unhandled");
    expect(result.stderr).not.toContain("TypeError");
    expect(result.stderr).not.toContain("ReferenceError");
  });
});
