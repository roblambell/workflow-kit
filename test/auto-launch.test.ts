// Tests for auto-launch logic: checkAutoLaunch and ensureMuxOrAutoLaunch.
// Uses dependency injection — no vi.mock needed.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkAutoLaunch,
  ensureMuxOrAutoLaunch,
  type AutoLaunchDeps,
  type SpawnFn,
} from "../core/mux.ts";

// ── Helper: build injectable AutoLaunchDeps ─────────────────────────

function makeDeps(overrides: Partial<AutoLaunchDeps> = {}): AutoLaunchDeps {
  return {
    env: {},
    isTTY: true,
    checkBinary: () => false,
    ...overrides,
  };
}

// ── Helper: capture console.error + mock process.exit ───────────────

function withMockedExit(fn: () => void): { exitCode: number | null; stderr: string } {
  const errors: string[] = [];
  const origError = console.error;
  const origExit = process.exit;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  process.exit = ((code?: number) => {
    throw new Error(`EXIT:${code ?? 0}`);
  }) as never;

  let exitCode: number | null = null;
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith("EXIT:")) {
      exitCode = parseInt(e.message.slice(5), 10);
    } else {
      throw e;
    }
  } finally {
    console.error = origError;
    process.exit = origExit;
  }

  return { exitCode, stderr: errors.join("\n") };
}

// ── checkAutoLaunch (pure detection logic) ──────────────────────────

describe("checkAutoLaunch", () => {
  it("returns proceed when CMUX_WORKSPACE_ID is set", () => {
    const deps = makeDeps({
      env: { CMUX_WORKSPACE_ID: "workspace:1" },
      checkBinary: () => true,
      isTTY: true,
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("returns error when NINTHWAVE_AUTO_LAUNCHED=1 (recursive guard)", () => {
    const deps = makeDeps({
      env: { NINTHWAVE_AUTO_LAUNCHED: "1" },
      checkBinary: () => true,
      isTTY: true,
    });
    const result = checkAutoLaunch(deps);
    expect(result.action).toBe("error");
    expect((result as { message: string }).message).toContain("Recursive");
  });

  it("returns auto-launch when cmux available + TTY", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
      isTTY: true,
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "auto-launch" });
  });

  it("returns error when cmux available + non-TTY", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
      isTTY: false,
    });
    const result = checkAutoLaunch(deps);
    expect(result.action).toBe("error");
    expect((result as { message: string }).message).toContain("TTY");
  });

  it("returns error with install prompt when cmux not available", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: () => false,
      isTTY: true,
    });
    const result = checkAutoLaunch(deps);
    expect(result.action).toBe("error");
    expect((result as { message: string }).message).toContain("Install cmux");
  });

  it("returns error with install prompt when cmux not available + non-TTY", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: () => false,
      isTTY: false,
    });
    const result = checkAutoLaunch(deps);
    expect(result.action).toBe("error");
    expect((result as { message: string }).message).toContain("Install cmux");
  });

  it("prioritizes CMUX_WORKSPACE_ID over NINTHWAVE_AUTO_LAUNCHED", () => {
    const deps = makeDeps({
      env: { CMUX_WORKSPACE_ID: "workspace:1", NINTHWAVE_AUTO_LAUNCHED: "1" },
      checkBinary: () => true,
      isTTY: true,
    });
    // Inside cmux wins — no recursive guard
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("does not check binary when CMUX_WORKSPACE_ID is set", () => {
    const checkBinary = vi.fn(() => false);
    const deps = makeDeps({
      env: { CMUX_WORKSPACE_ID: "workspace:1" },
      checkBinary,
      isTTY: true,
    });
    checkAutoLaunch(deps);
    expect(checkBinary).not.toHaveBeenCalled();
  });
});

// ── ensureMuxOrAutoLaunch (side-effectful wrapper) ──────────────────

describe("ensureMuxOrAutoLaunch", () => {
  it("returns normally when inside cmux", () => {
    const deps = makeDeps({
      env: { CMUX_WORKSPACE_ID: "workspace:1" },
    });
    const spawn = vi.fn();

    // Should not throw or call spawn
    ensureMuxOrAutoLaunch(["watch"], deps, spawn as unknown as SpawnFn);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns cmux with correct args on auto-launch", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
      isTTY: true,
    });

    const spawn = vi.fn(() => ({ exitCode: 0 }));
    const { exitCode } = withMockedExit(() => {
      ensureMuxOrAutoLaunch(["watch"], deps, spawn);
    });

    expect(spawn).toHaveBeenCalledWith(
      ["cmux", "--", "nw", "watch"],
      { NINTHWAVE_AUTO_LAUNCHED: "1" },
    );
    expect(exitCode).toBe(0);
  });

  it("passes through all original args on auto-launch", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
      isTTY: true,
    });

    const spawn = vi.fn(() => ({ exitCode: 0 }));
    withMockedExit(() => {
      ensureMuxOrAutoLaunch(["watch", "--items", "H-FOO-1", "H-FOO-2"], deps, spawn);
    });

    expect(spawn).toHaveBeenCalledWith(
      ["cmux", "--", "nw", "watch", "--items", "H-FOO-1", "H-FOO-2"],
      { NINTHWAVE_AUTO_LAUNCHED: "1" },
    );
  });

  it("passes through work item IDs on auto-launch", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
      isTTY: true,
    });

    const spawn = vi.fn(() => ({ exitCode: 0 }));
    withMockedExit(() => {
      ensureMuxOrAutoLaunch(["H-FOO-1", "H-FOO-2"], deps, spawn);
    });

    expect(spawn).toHaveBeenCalledWith(
      ["cmux", "--", "nw", "H-FOO-1", "H-FOO-2"],
      { NINTHWAVE_AUTO_LAUNCHED: "1" },
    );
  });

  it("exits with spawn exit code", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
      isTTY: true,
    });

    const spawn = vi.fn(() => ({ exitCode: 42 }));
    const { exitCode } = withMockedExit(() => {
      ensureMuxOrAutoLaunch(["watch"], deps, spawn);
    });

    expect(exitCode).toBe(42);
  });

  it("exits with 1 when spawn returns null exitCode", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
      isTTY: true,
    });

    const spawn = vi.fn(() => ({ exitCode: null }));
    const { exitCode } = withMockedExit(() => {
      ensureMuxOrAutoLaunch(["watch"], deps, spawn);
    });

    expect(exitCode).toBe(1);
  });

  it("dies on recursive launch", () => {
    const deps = makeDeps({
      env: { NINTHWAVE_AUTO_LAUNCHED: "1" },
      checkBinary: () => true,
      isTTY: true,
    });
    const spawn = vi.fn();

    const { exitCode, stderr } = withMockedExit(() => {
      ensureMuxOrAutoLaunch(["watch"], deps, spawn as unknown as SpawnFn);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Recursive");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("dies with install prompt when cmux not available", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: () => false,
      isTTY: true,
    });
    const spawn = vi.fn();

    const { exitCode, stderr } = withMockedExit(() => {
      ensureMuxOrAutoLaunch(["watch"], deps, spawn as unknown as SpawnFn);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Install cmux");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("dies with TTY error when cmux available but no TTY", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
      isTTY: false,
    });
    const spawn = vi.fn();

    const { exitCode, stderr } = withMockedExit(() => {
      ensureMuxOrAutoLaunch(["watch"], deps, spawn as unknown as SpawnFn);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("TTY");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("handles empty args (no-args invocation)", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
      isTTY: true,
    });

    const spawn = vi.fn(() => ({ exitCode: 0 }));
    withMockedExit(() => {
      ensureMuxOrAutoLaunch([], deps, spawn);
    });

    // nw with no args → cmux -- nw
    expect(spawn).toHaveBeenCalledWith(
      ["cmux", "--", "nw"],
      { NINTHWAVE_AUTO_LAUNCHED: "1" },
    );
  });
});
