// Smoke test: `nw status --once` renders a status table in a temp repo.

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";
import { mkdirSync, writeFileSync, realpathSync, rmSync } from "fs";
import { setupTempRepo, cleanupTempRepos } from "../helpers.ts";

const CLI_PATH = join(import.meta.dirname, "..", "..", "core", "cli.ts");

function runCli(cwd: string, env: Record<string, string>, ...args: string[]) {
  const result = spawnSync("bun", ["run", CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? 1,
  };
}

describe("smoke: nw status", () => {
  afterEach(() => cleanupTempRepos());

  it("exits 0 and renders status header with no active items", () => {
    const repo = setupTempRepo();

    // Create .worktrees dir so status has something to check
    mkdirSync(join(repo, ".ninthwave", ".worktrees"), { recursive: true });

    const result = runCli(repo, {}, "status", "--once");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ninthwave");
    expect(result.stdout).toContain("No active items");
    expect(result.stderr).not.toContain("Error");
  });

  it("renders a status table from a pre-written daemon state file", () => {
    const repo = setupTempRepo();

    // Resolve the real path (macOS: /var → /private/var) to match
    // what git rev-parse returns inside the subprocess.
    const realRepo = realpathSync(repo);

    // Compute the user state directory path matching daemon.ts logic:
    // userStateDir = $HOME/.ninthwave/projects/<slug>
    // where slug = projectRoot.replace(/\//g, "-")
    const slug = realRepo.replace(/\//g, "-");
    const home = process.env.HOME ?? "/tmp";
    const stateDir = join(home, ".ninthwave", "projects", slug);
    mkdirSync(stateDir, { recursive: true });

    // Write a daemon state file with items
    const stateFile = join(stateDir, "orchestrator.state.json");
    const state = {
      pid: 99999,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxInflight: 3,
      items: [
        {
          id: "H-SMOKE-1",
          state: "implementing",
          prNumber: null,
          title: "Smoke test item alpha",
          lastTransition: new Date().toISOString(),
          ciFailCount: 0,
          retryCount: 0,
        },
        {
          id: "M-SMOKE-2",
          state: "ci-pending",
          prNumber: 42,
          title: "Smoke test item beta",
          lastTransition: new Date().toISOString(),
          ciFailCount: 0,
          retryCount: 0,
        },
      ],
    };
    writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const result = runCli(repo, {}, "status", "--once");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ninthwave");
    expect(result.stdout).toContain("H-SMOKE-1");
    expect(result.stdout).toContain("M-SMOKE-2");
    expect(result.stderr).not.toContain("Error");

    // Clean up the state file
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("produces no unhandled exceptions in stderr", () => {
    const repo = setupTempRepo();

    const result = runCli(repo, {}, "status", "--once");

    expect(result.exitCode).toBe(0);
    // No unhandled exception traces
    expect(result.stderr).not.toContain("Unhandled");
    expect(result.stderr).not.toContain("TypeError");
    expect(result.stderr).not.toContain("ReferenceError");
  });
});
