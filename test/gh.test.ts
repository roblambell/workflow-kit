// Tests for core/gh.ts — prMerge and prComment functions.
// Uses vi.spyOn (not vi.mock) to avoid global module pollution in bun test.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as shell from "../core/shell.ts";
import { prMerge, prComment, prLock, getRepoOwner } from "../core/gh.ts";

const runSpy = vi.spyOn(shell, "run");

beforeEach(() => runSpy.mockReset());
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
