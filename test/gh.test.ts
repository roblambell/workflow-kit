// Tests for core/gh.ts — prMerge, prComment, prLock, and GitHub token resolution.
// Uses vi.spyOn (not vi.mock) to avoid global module pollution in bun test.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import * as shell from "../core/shell.ts";
import { prMerge, prComment, prLock, getRepoOwner, resolveGithubToken, applyGithubToken } from "../core/gh.ts";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

const runSpy = vi.spyOn(shell, "run");

beforeEach(() => runSpy.mockReset());
afterEach(() => cleanupTempRepos());
afterAll(() => runSpy.mockRestore());

describe("prMerge", () => {
  it("returns true when gh pr merge succeeds", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    const result = prMerge("/repo", 42);

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "42", "--squash", "--delete-branch"],
      { cwd: "/repo" },
    );
  });

  it("returns false when gh pr merge fails", () => {
    runSpy.mockReturnValue({
      stdout: "",
      stderr: "not mergeable",
      exitCode: 1,
    });

    const result = prMerge("/repo", 99);

    expect(result).toBe(false);
  });

  it("defaults to squash merge method", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    prMerge("/repo", 10);

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "10", "--squash", "--delete-branch"],
      { cwd: "/repo" },
    );
  });

  it("supports merge method", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    prMerge("/repo", 10, "merge");

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "10", "--merge", "--delete-branch"],
      { cwd: "/repo" },
    );
  });

  it("supports rebase method", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    prMerge("/repo", 10, "rebase");

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "10", "--rebase", "--delete-branch"],
      { cwd: "/repo" },
    );
  });
});

describe("prComment", () => {
  it("returns true when gh pr comment succeeds", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    const result = prComment("/repo", 42, "LGTM!");

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "comment", "42", "--body", "LGTM!"],
      { cwd: "/repo" },
    );
  });

  it("returns false when gh pr comment fails", () => {
    runSpy.mockReturnValue({
      stdout: "",
      stderr: "GraphQL error",
      exitCode: 1,
    });

    const result = prComment("/repo", 7, "Nice work");

    expect(result).toBe(false);
  });

  it("passes multi-line body correctly", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    const body = "Line 1\nLine 2\nLine 3";
    prComment("/repo", 5, body);

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "comment", "5", "--body", body],
      { cwd: "/repo" },
    );
  });
});

describe("prLock", () => {
  it("returns true when gh api lock succeeds", () => {
    runSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "repo") {
        return { stdout: "owner/repo", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = prLock("/repo", 42);

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--method",
        "PUT",
        "repos/owner/repo/issues/42/lock",
        "-f",
        "lock_reason=resolved",
      ],
      { cwd: "/repo" },
    );
  });

  it("returns false when gh api lock fails", () => {
    runSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "repo") {
        return { stdout: "owner/repo", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "403 Forbidden", exitCode: 1 };
    });

    const result = prLock("/repo", 99);

    expect(result).toBe(false);
  });

  it("returns false when getRepoOwner fails", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "not a repo", exitCode: 1 });

    const result = prLock("/repo", 42);

    expect(result).toBe(false);
  });
});

// ── resolveGithubToken ──────────────────────────────────────────────

describe("resolveGithubToken", () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.NINTHWAVE_GITHUB_TOKEN;
    delete process.env.NINTHWAVE_GITHUB_TOKEN;
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.NINTHWAVE_GITHUB_TOKEN = origEnv;
    } else {
      delete process.env.NINTHWAVE_GITHUB_TOKEN;
    }
  });

  it("returns env var when NINTHWAVE_GITHUB_TOKEN is set", () => {
    process.env.NINTHWAVE_GITHUB_TOKEN = "ghp_env_token_123";
    const repo = setupTempRepo();
    const token = resolveGithubToken(repo);
    expect(token).toBe("ghp_env_token_123");
  });

  it("returns config file token when env var is not set", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config"), "github_token=ghp_config_token_456\n");

    const token = resolveGithubToken(repo);
    expect(token).toBe("ghp_config_token_456");
  });

  it("env var takes precedence over config file", () => {
    process.env.NINTHWAVE_GITHUB_TOKEN = "ghp_env_wins";
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config"), "github_token=ghp_config_loses\n");

    const token = resolveGithubToken(repo);
    expect(token).toBe("ghp_env_wins");
  });

  it("returns undefined when no custom token is configured", () => {
    const repo = setupTempRepo();
    const token = resolveGithubToken(repo);
    expect(token).toBeUndefined();
  });

  it("returns undefined when config exists but has no github_token key", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config"), "review_external=true\n");

    const token = resolveGithubToken(repo);
    expect(token).toBeUndefined();
  });
});

// ── applyGithubToken ────────────────────────────────────────────────

describe("applyGithubToken", () => {
  let origNwToken: string | undefined;
  let origGhToken: string | undefined;

  beforeEach(() => {
    origNwToken = process.env.NINTHWAVE_GITHUB_TOKEN;
    origGhToken = process.env.GH_TOKEN;
    delete process.env.NINTHWAVE_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    if (origNwToken !== undefined) {
      process.env.NINTHWAVE_GITHUB_TOKEN = origNwToken;
    } else {
      delete process.env.NINTHWAVE_GITHUB_TOKEN;
    }
    if (origGhToken !== undefined) {
      process.env.GH_TOKEN = origGhToken;
    } else {
      delete process.env.GH_TOKEN;
    }
  });

  it("sets GH_TOKEN when NINTHWAVE_GITHUB_TOKEN is set", () => {
    process.env.NINTHWAVE_GITHUB_TOKEN = "ghp_apply_test";
    const repo = setupTempRepo();

    applyGithubToken(repo);

    expect(process.env.GH_TOKEN).toBe("ghp_apply_test");
  });

  it("sets GH_TOKEN from config file", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config"), "github_token=ghp_from_config\n");

    applyGithubToken(repo);

    expect(process.env.GH_TOKEN).toBe("ghp_from_config");
  });

  it("does not set GH_TOKEN when no custom token is configured", () => {
    const repo = setupTempRepo();

    applyGithubToken(repo);

    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it("does not overwrite existing GH_TOKEN when no custom token", () => {
    process.env.GH_TOKEN = "ghp_existing";
    const repo = setupTempRepo();

    applyGithubToken(repo);

    expect(process.env.GH_TOKEN).toBe("ghp_existing");
  });
});
