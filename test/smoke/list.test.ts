// Smoke test: `nw list` outputs a parseable work item list.

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { setupTempRepo, cleanupTempRepos } from "../helpers.ts";

const CLI_PATH = join(import.meta.dirname, "..", "..", "core", "cli.ts");

function runCli(cwd: string, ...args: string[]) {
  const result = spawnSync("bun", ["run", CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
    env: { ...process.env },
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? 1,
  };
}

/** Create a minimal work item file in the work directory. */
function writeWorkItem(
  workDir: string,
  id: string,
  priority: string,
  domain: string,
  title: string,
): void {
  const priorityNum = { critical: 0, high: 1, medium: 2, low: 3 }[priority] ?? 2;
  const filename = `${priorityNum}-${domain}--${id}.md`;
  const content = `# ${title} (${id})

**Priority:** ${priority.charAt(0).toUpperCase() + priority.slice(1)}
**Source:** Smoke test
**Depends on:** None
**Domain:** ${domain}

Test work item for CLI smoke tests.

Acceptance: Item exists and is parseable.

Key files: \`test/smoke/list.test.ts\`
`;
  writeFileSync(join(workDir, filename), content);
}

describe("smoke: nw list", () => {
  afterEach(() => cleanupTempRepos());

  it("exits 0 and lists work items with table header", () => {
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeWorkItem(workDir, "H-TEST-1", "high", "core", "First test item");
    writeWorkItem(workDir, "M-TEST-2", "medium", "api", "Second test item");

    // Commit so git is clean
    spawnSync("git", ["-C", repo, "add", ".ninthwave"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "commit", "-m", "Add work items", "--quiet"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "push", "--quiet"], { stdio: "pipe" });

    const result = runCli(repo, "list");

    expect(result.exitCode).toBe(0);
    // Table header should contain column names
    expect(result.stdout).toContain("ID");
    expect(result.stdout).toContain("PRIORITY");
    expect(result.stdout).toContain("TITLE");
    expect(result.stdout).toContain("DOMAIN");
  });

  it("displays work item IDs in output", () => {
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeWorkItem(workDir, "H-SMOKE-1", "high", "core", "Smoke item alpha");
    writeWorkItem(workDir, "L-SMOKE-2", "low", "testing", "Smoke item beta");

    spawnSync("git", ["-C", repo, "add", ".ninthwave"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "commit", "-m", "Add work items", "--quiet"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "push", "--quiet"], { stdio: "pipe" });

    const result = runCli(repo, "list");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("H-SMOKE-1");
    expect(result.stdout).toContain("L-SMOKE-2");
    // Item count at bottom
    expect(result.stdout).toContain("2 items");
  });

  it("exits non-zero when work dir is missing", () => {
    const repo = setupTempRepo();
    // No .ninthwave/work/ directory -- list should fail

    const result = runCli(repo, "list");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not found");
  });

  it("handles empty work directory", () => {
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, ".gitkeep"), "");

    spawnSync("git", ["-C", repo, "add", ".ninthwave"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "commit", "-m", "Init ninthwave", "--quiet"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "push", "--quiet"], { stdio: "pipe" });

    const result = runCli(repo, "list");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("0 items");
  });

  it("produces no unhandled exceptions in stderr", () => {
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeWorkItem(workDir, "H-ERR-1", "high", "core", "Error check item");

    spawnSync("git", ["-C", repo, "add", ".ninthwave"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "commit", "-m", "Add work items", "--quiet"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "push", "--quiet"], { stdio: "pipe" });

    const result = runCli(repo, "list");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unhandled");
    expect(result.stderr).not.toContain("TypeError");
    expect(result.stderr).not.toContain("ReferenceError");
  });
});
