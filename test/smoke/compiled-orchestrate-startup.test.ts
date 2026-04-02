import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync } from "fs";
import { join } from "path";
import {
  cleanupTempRepos,
  setupTempDir,
  setupTempRepoWithRemote,
  startCompiledCli,
  stopProcess,
  waitForCapturedOutput,
  writeWorkItemFiles,
} from "../helpers.ts";

describe("smoke: compiled orchestration startup", () => {
  afterEach(() => cleanupTempRepos());

  it("arms future-only watch through the packaged respawn path without bunfs startup disconnects", async () => {
    const repo = setupTempRepoWithRemote();
    const homeDir = setupTempDir("nw-smoke-home-");
    mkdirSync(join(repo, ".ninthwave", ".worktrees"), { recursive: true });
    writeWorkItemFiles(repo, `
## Smoke

### Repro packaged startup seam (H-SMK-1)
**Priority:** High
**Source:** Smoke test
**Domain:** packaged-smoke-tests

Exercise the packaged watch startup seam.

Acceptance: The packaged startup path reaches a live snapshot without disconnecting.

Key files: \`test/smoke/compiled-orchestrate-startup.test.ts\`
`);
    Bun.spawnSync(["git", "-C", repo, "add", ".ninthwave"]);
    Bun.spawnSync(["git", "-C", repo, "commit", "-m", "Add smoke work item", "--quiet"]);
    Bun.spawnSync(["git", "-C", repo, "push", "-u", "origin", "main", "--quiet"]);

    const handle = startCompiledCli(repo, [
      "--tool", "codex",
      "--items", "H-SMK-1",
      "--watch",
      "--future-only-startup",
      "--skip-preflight",
    ], {
      env: { HOME: homeDir },
    });

    try {
      const output = await waitForCapturedOutput(handle, "Restoring runtime state", {
        timeoutMs: 20_000,
      });

      expect(output).toContain("Preparing runtime");
      expect(output).toContain("Preparing work queue");
      expect(output).toContain("Restoring runtime state");
      expect(output).not.toContain("Engine disconnected");
      expect(output).not.toContain('Module not found "/$bunfs/root/ninthwave"');
    } finally {
      await stopProcess(handle);
    }
  }, 30_000);
});
