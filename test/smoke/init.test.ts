// Smoke test: `nw init --yes` creates .ninthwave/ directory structure.

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
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
    expect(existsSync(join(repo, ".ninthwave", "config.json"))).toBe(true);
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

  it("creates .ninthwave/.gitignore with deny-by-default pattern", () => {
    const repo = setupTempRepo();

    const result = runCli(repo, "init", "--yes");

    expect(result.exitCode).toBe(0);

    const nwGitignorePath = join(repo, ".ninthwave", ".gitignore");
    expect(existsSync(nwGitignorePath)).toBe(true);

    const content = require("fs").readFileSync(nwGitignorePath, "utf-8");
    expect(content).toContain("*");
    expect(content).toContain("!config.json");
  });

  it("produces no unhandled exceptions in stderr", () => {
    const repo = setupTempRepo();

    const result = runCli(repo, "init", "--yes");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unhandled");
    expect(result.stderr).not.toContain("TypeError");
    expect(result.stderr).not.toContain("ReferenceError");
  });

  // --- --broker-secret / --skip-broker ----------------------------------

  // 32 zero bytes base64-encoded -- a syntactically valid broker secret.
  const TEAM_SECRET = Buffer.from(new Uint8Array(32)).toString("base64");

  it("--broker-secret writes the provided value to config.local.json", () => {
    const repo = setupTempRepo();

    const result = runCli(
      repo,
      "init",
      "--yes",
      "--broker-secret",
      TEAM_SECRET,
    );

    expect(result.exitCode).toBe(0);

    const localPath = join(repo, ".ninthwave", "config.local.json");
    expect(existsSync(localPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(localPath, "utf-8"));
    expect(parsed.broker_secret).toBe(TEAM_SECRET);
  });

  it("--broker-secret <invalid> exits non-zero with a validation error", () => {
    const repo = setupTempRepo();

    const result = runCli(
      repo,
      "init",
      "--yes",
      "--broker-secret",
      "not-a-valid-base64-secret",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--broker-secret");
    // Init must not have run; no .ninthwave/ artifacts should exist.
    expect(existsSync(join(repo, ".ninthwave", "config.local.json"))).toBe(
      false,
    );
  });

  it("--skip-broker suppresses secret generation even with --yes", () => {
    const repo = setupTempRepo();

    const result = runCli(repo, "init", "--yes", "--skip-broker");

    expect(result.exitCode).toBe(0);
    // config.local.json is only written when we provision a secret; the
    // skip path leaves the project local-only.
    expect(existsSync(join(repo, ".ninthwave", "config.local.json"))).toBe(
      false,
    );
    // The committed config must not carry a broker_secret either. Strip
    // the JSONC header comment before parsing.
    const configPath = join(repo, ".ninthwave", "config.json");
    const configRaw = readFileSync(configPath, "utf-8");
    const configBody = configRaw.replace(/^\/\/[^\n]*\n/gm, "");
    const parsedConfig = JSON.parse(configBody);
    expect(parsedConfig).not.toHaveProperty("broker_secret");
  });

  it("--broker-secret with --skip-broker errors out on mutual exclusion", () => {
    const repo = setupTempRepo();

    const result = runCli(
      repo,
      "init",
      "--yes",
      "--broker-secret",
      TEAM_SECRET,
      "--skip-broker",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("mutually exclusive");
  });

  it("--broker-secret works without --yes (skips the prompt non-interactively)", () => {
    const repo = setupTempRepo();

    // Piped stdio in spawnSync already makes stdin non-TTY. The flag path
    // must bypass the prompt and write the provided secret regardless.
    const result = runCli(repo, "init", "--broker-secret", TEAM_SECRET);

    expect(result.exitCode).toBe(0);

    const localPath = join(repo, ".ninthwave", "config.local.json");
    expect(existsSync(localPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(localPath, "utf-8"));
    expect(parsed.broker_secret).toBe(TEAM_SECRET);
  });
});
