// Tests for cmux setStatus and setProgress.
// Imports from core/cmux-status.ts (not core/cmux.ts) to avoid vi.mock leaks
// from mux.test.ts. Uses dependency injection per project conventions.

import { describe, it, expect, vi } from "vitest";
import { setStatusImpl, setProgressImpl } from "../core/cmux-status.ts";
import type { RunResult } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function ok(stdout = ""): RunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "error"): RunResult {
  return { stdout: "", stderr, exitCode: 1 };
}

// ── setStatusImpl ────────────────────────────────────────────────────

describe("setStatusImpl", () => {
  it("calls cmux set-status with correct args", () => {
    const runner = vi.fn(() => ok());

    const result = setStatusImpl(
      "workspace:1",
      "build",
      "Building...",
      "hammer.fill",
      "#b45309",
      runner,
    );

    expect(result).toBe(true);
    expect(runner).toHaveBeenCalledWith("cmux", [
      "set-status",
      "build",
      "Building...",
      "--icon",
      "hammer.fill",
      "--color",
      "#b45309",
      "--workspace",
      "workspace:1",
    ]);
  });

  it("returns false on non-zero exit code", () => {
    const runner = vi.fn(() => fail("cmux not running"));

    const result = setStatusImpl(
      "workspace:2",
      "test",
      "Testing",
      "checkmark.circle",
      "#22c55e",
      runner,
    );

    expect(result).toBe(false);
  });
});

// ── setProgressImpl ──────────────────────────────────────────────────

describe("setProgressImpl", () => {
  it("calls cmux set-progress with correct args including label", () => {
    const runner = vi.fn(() => ok());

    const result = setProgressImpl("workspace:1", 75, "3/4 tests", runner);

    expect(result).toBe(true);
    expect(runner).toHaveBeenCalledWith("cmux", [
      "set-progress",
      "75",
      "--label",
      "3/4 tests",
      "--workspace",
      "workspace:1",
    ]);
  });

  it("omits --label when label is not provided", () => {
    const runner = vi.fn(() => ok());

    const result = setProgressImpl("workspace:1", 50, undefined, runner);

    expect(result).toBe(true);
    expect(runner).toHaveBeenCalledWith("cmux", [
      "set-progress",
      "50",
      "--workspace",
      "workspace:1",
    ]);
  });

  it("returns false on non-zero exit code", () => {
    const runner = vi.fn(() => fail("socket error"));

    const result = setProgressImpl("workspace:3", 100, "Done", runner);

    expect(result).toBe(false);
  });
});
