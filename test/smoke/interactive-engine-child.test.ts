import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";
import {
  TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_ENV,
  TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_MESSAGE,
} from "../../core/commands/orchestrate.ts";
import { cleanupTempRepos, setupTempRepo, writeWorkItemFiles } from "../helpers.ts";

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
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("smoke: interactive engine child startup failure reporting", () => {
  afterEach(() => cleanupTempRepos());

  it("emits a fatal transport message with the startup failure detail", () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave", ".worktrees"), { recursive: true });
    writeWorkItemFiles(repo, `
## Systems

### Repro startup crash (H-SMK-1)
**Priority:** High

Make the engine fail before its first snapshot.
`);

    const result = runCli(repo, {
      [TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_ENV]: "1",
    }, "--_interactive-engine-child", "--items", "H-SMK-1", "--watch", "--future-only-startup", "--skip-preflight");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"type":"fatal"');
    expect(result.stdout).toContain(TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_MESSAGE);
    expect(result.stdout).not.toContain("Unknown command: orchestrate");
  });
});
