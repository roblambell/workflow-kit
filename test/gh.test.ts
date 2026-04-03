// Tests for core/gh.ts -- prMerge, prComment, and GitHub token resolution.
// Uses vi.spyOn (not vi.mock) to avoid global module pollution in bun test.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as shell from "../core/shell.ts";
import {
  prMerge,
  prComment,
  getRepoOwner,
  resolveGithubToken,
  applyGithubToken,
  setCommitStatus,
  prHeadSha,
  ensureDomainLabels,
  getPrBaseBranch,
  retargetPrBase,
  findOpenPrByHeadBranch,
  updatePrBody,
  upsertDeletedFileReviewComment,
  deletedFileReviewCommentMarker,
} from "../core/gh.ts";
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

    prMerge("/repo", 10, { method: "merge" });

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "10", "--merge", "--delete-branch"],
      { cwd: "/repo" },
    );
  });

  it("supports rebase method", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    prMerge("/repo", 10, { method: "rebase" });

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "10", "--rebase", "--delete-branch"],
      { cwd: "/repo" },
    );
  });

  it("passes --admin flag when admin option is true", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    prMerge("/repo", 10, { admin: true });

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "10", "--squash", "--delete-branch", "--admin"],
      { cwd: "/repo" },
    );
  });

  it("does not pass --admin flag when admin option is false", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    prMerge("/repo", 10, { admin: false });

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "10", "--squash", "--delete-branch"],
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

describe("getPrBaseBranch", () => {
  it("returns the current base branch when gh pr view succeeds", () => {
    runSpy.mockReturnValue({
      stdout: JSON.stringify({ baseRefName: "main" }),
      stderr: "",
      exitCode: 0,
    });

    const result = getPrBaseBranch("/repo", 42);

    expect(result).toBe("main");
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", "42", "--json", "baseRefName"],
      { cwd: "/repo" },
    );
  });

  it("returns null when gh pr view fails", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "boom", exitCode: 1 });
    expect(getPrBaseBranch("/repo", 42)).toBeNull();
  });
});

describe("retargetPrBase", () => {
  it("returns true when gh pr edit succeeds", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    const result = retargetPrBase("/repo", 42, "main");

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "edit", "42", "--base", "main"],
      { cwd: "/repo" },
    );
  });

  it("returns false when gh pr edit fails", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "boom", exitCode: 1 });
    expect(retargetPrBase("/repo", 42, "main")).toBe(false);
  });
});

describe("findOpenPrByHeadBranch", () => {
  it("returns the oldest open PR for the head branch", () => {
    runSpy.mockReturnValue({
      stdout: JSON.stringify([
        { number: 91, title: "newer", body: "new" },
        { number: 74, title: "older", body: "old" },
      ]),
      stderr: "",
      exitCode: 0,
    });

    const result = findOpenPrByHeadBranch("/repo", "review/core");

    expect(result).toEqual({ number: 74, title: "older", body: "old" });
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "list", "--head", "review/core", "--state", "open", "--json", "number,title,body", "--limit", "100"],
      { cwd: "/repo" },
    );
  });

  it("returns null when no open PR exists for the head branch", () => {
    runSpy.mockReturnValue({
      stdout: "[]",
      stderr: "",
      exitCode: 0,
    });

    expect(findOpenPrByHeadBranch("/repo", "review/core")).toBeNull();
  });
});

describe("updatePrBody", () => {
  it("replaces the body of an existing PR", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    const body = "## Summary\nUpdated review body";
    const result = updatePrBody("/repo", 42, body);

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["pr", "edit", "42", "--body", body],
      { cwd: "/repo" },
    );
  });

  it("returns false when gh pr edit fails", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "boom", exitCode: 1 });
    expect(updatePrBody("/repo", 42, "body")).toBe(false);
  });
});

describe("upsertDeletedFileReviewComment", () => {
  it("creates a deleted-file review comment when no managed comment exists", () => {
    const marker = deletedFileReviewCommentMarker(".ninthwave/inbox/foo.md");
    runSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "repo") {
        return { stdout: "owner/repo", stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/42/comments") {
        return { stdout: "[]", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const body = "Deleted inbox file rationale";
    const result = upsertDeletedFileReviewComment("/repo", 42, "abc123", ".ninthwave/inbox/foo.md", body);

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--method",
        "POST",
        "repos/owner/repo/pulls/42/comments",
        "-f",
        `body=${marker}\n${body}`,
        "-f",
        "commit_id=abc123",
        "-f",
        "path=.ninthwave/inbox/foo.md",
        "-f",
        "subject_type=file",
      ],
      { cwd: "/repo" },
    );
  });

  it("updates the existing deleted-file review comment when the marker exists", () => {
    const path = ".ninthwave/inbox/foo.md";
    const marker = deletedFileReviewCommentMarker(path);
    runSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "repo") {
        return { stdout: "owner/repo", stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/42/comments") {
        return {
          stdout: JSON.stringify([
            { id: 200, body: `${marker}\nold`, path },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const body = "Updated rationale";
    const result = upsertDeletedFileReviewComment("/repo", 42, "abc123", path, body);

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--method",
        "PATCH",
        "repos/owner/repo/pulls/comments/200",
        "-f",
        `body=${marker}\n${body}`,
      ],
      { cwd: "/repo" },
    );
  });

  it("creates a new deleted-file review comment when only unrelated comments exist", () => {
    const path = ".ninthwave/inbox/foo.md";
    const marker = deletedFileReviewCommentMarker(path);
    runSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "repo") {
        return { stdout: "owner/repo", stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/42/comments") {
        return {
          stdout: JSON.stringify([
            { id: 200, body: "plain comment", path },
            { id: 201, body: `${deletedFileReviewCommentMarker("other/file.md")}\nother`, path: "other/file.md" },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const body = "Deleted inbox file rationale";
    const result = upsertDeletedFileReviewComment("/repo", 42, "abc123", path, body);

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--method",
        "POST",
        "repos/owner/repo/pulls/42/comments",
        "-f",
        `body=${marker}\n${body}`,
        "-f",
        "commit_id=abc123",
        "-f",
        "path=.ninthwave/inbox/foo.md",
        "-f",
        "subject_type=file",
      ],
      { cwd: "/repo" },
    );
  });

  it("updates the oldest matching comment when duplicate markers already exist", () => {
    const path = ".ninthwave/inbox/foo.md";
    const marker = deletedFileReviewCommentMarker(path);
    runSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "repo") {
        return { stdout: "owner/repo", stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/42/comments") {
        return {
          stdout: JSON.stringify([
            { id: 301, body: `${marker}\nnewer duplicate`, path },
            { id: 205, body: `${marker}\nolder duplicate`, path },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = upsertDeletedFileReviewComment("/repo", 42, "abc123", path, "Consolidated rationale");

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--method",
        "PATCH",
        "repos/owner/repo/pulls/comments/205",
        "-f",
        `body=${marker}\nConsolidated rationale`,
      ],
      { cwd: "/repo" },
    );
    expect(runSpy).not.toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["--method", "POST", "repos/owner/repo/pulls/42/comments"]),
      { cwd: "/repo" },
    );
  });
});

// ── setCommitStatus ────────────────────────────────────────────────

describe("setCommitStatus", () => {
  it("calls gh api with correct arguments", () => {
    runSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "repo") {
        return { stdout: "owner/repo", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = setCommitStatus("/repo", "abc123", "pending", "Ninthwave / Review", "Review in progress");

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--method",
        "POST",
        "repos/owner/repo/statuses/abc123",
        "-f", "state=pending",
        "-f", "context=Ninthwave / Review",
        "-f", "description=Review in progress",
      ],
      { cwd: "/repo" },
    );
  });

  it("includes target_url when provided", () => {
    runSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "repo") {
        return { stdout: "owner/repo", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    setCommitStatus("/repo", "abc123", "success", "Ninthwave / Review", "Review passed", "https://example.com");

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--method",
        "POST",
        "repos/owner/repo/statuses/abc123",
        "-f", "state=success",
        "-f", "context=Ninthwave / Review",
        "-f", "description=Review passed",
        "-f", "target_url=https://example.com",
      ],
      { cwd: "/repo" },
    );
  });

  it("returns false when gh api fails", () => {
    runSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "repo") {
        return { stdout: "owner/repo", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "403 Forbidden", exitCode: 1 };
    });

    const result = setCommitStatus("/repo", "abc123", "failure", "Ninthwave / Review", "Review failed");

    expect(result).toBe(false);
  });

  it("returns false when getRepoOwner fails", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "not a repo", exitCode: 1 });

    const result = setCommitStatus("/repo", "abc123", "pending", "Ninthwave / Review", "Review in progress");

    expect(result).toBe(false);
  });
});

// ── prHeadSha ──────────────────────────────────────────────────────

describe("prHeadSha", () => {
  it("returns null when prView fails", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "not found", exitCode: 1 });

    const sha = prHeadSha("/repo", 99);

    expect(sha).toBeNull();
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

  it("returns undefined when env var is not set", () => {
    const repo = setupTempRepo();
    const token = resolveGithubToken(repo);
    expect(token).toBeUndefined();
  });

  it("env var is the only source", () => {
    process.env.NINTHWAVE_GITHUB_TOKEN = "ghp_env_wins";
    const repo = setupTempRepo();
    const token = resolveGithubToken(repo);
    expect(token).toBe("ghp_env_wins");
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

// ── ensureDomainLabels ─────────────────────────────────────────────

describe("ensureDomainLabels", () => {
  it("creates one label per unique domain", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });

    ensureDomainLabels("/repo", ["core", "tui", "core"]); // "core" duplicated

    expect(runSpy).toHaveBeenCalledTimes(2); // deduplicated
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["label", "create", "domain:core", "--color", "0E8A16", "--force"],
      { cwd: "/repo" },
    );
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      ["label", "create", "domain:tui", "--color", "0E8A16", "--force"],
      { cwd: "/repo" },
    );
  });

  it("does not throw when label creation fails", () => {
    runSpy.mockReturnValue({ stdout: "", stderr: "error", exitCode: 1 });

    expect(() => ensureDomainLabels("/repo", ["bad"])).not.toThrow();
  });

  it("handles empty domain list", () => {
    ensureDomainLabels("/repo", []);
    expect(runSpy).not.toHaveBeenCalled();
  });
});

// ── GhResult type contract ──────────────────────────────────────────
// NOTE: prList/prView/prChecks GhResult contract tests are in
// test/gh-async.test.ts (via shell.runAsync spy) and
// test/contract/gh-pr-status.test.ts (via gh module spies).
// Cannot test sync variants here because watch.test.ts's vi.mock leaks
// (bun test shared-process model -- see CLAUDE.md).
