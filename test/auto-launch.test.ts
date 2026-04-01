// Tests for auto-launch logic: checkAutoLaunch and ensureMuxOrAutoLaunch.
// Uses dependency injection -- no vi.mock needed.

import { describe, it, expect, vi } from "vitest";
import {
  checkAutoLaunch,
  ensureMuxOrAutoLaunch,
  ensureMuxInteractiveOrDie,
  type AutoLaunchDeps,
  type InteractiveMuxDeps,
} from "../core/mux.ts";

// ── Helper: build injectable AutoLaunchDeps ─────────────────────────

function makeDeps(overrides: Partial<AutoLaunchDeps> = {}): AutoLaunchDeps {
  return {
    env: {},
    checkBinary: () => false,
    ...overrides,
  };
}

// ── checkAutoLaunch (pure detection logic) ──────────────────────────

describe("checkAutoLaunch", () => {
  it("returns proceed when CMUX_WORKSPACE_ID is set", () => {
    const deps = makeDeps({
      env: { CMUX_WORKSPACE_ID: "workspace:1" },
      checkBinary: () => true,
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("returns proceed when cmux is installed but not in a session", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("returns proceed when nothing available (headless fallback)", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: () => false,
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("returns proceed when NINTHWAVE_MUX=headless", () => {
    const deps = makeDeps({
      env: { NINTHWAVE_MUX: "headless" },
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("prioritizes CMUX_WORKSPACE_ID over missing binary", () => {
    const deps = makeDeps({
      env: { CMUX_WORKSPACE_ID: "workspace:1" },
      checkBinary: () => false,
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("does not need binary checks when override already resolves", () => {
    const checkBinary = vi.fn(() => false);
    const deps = makeDeps({
      env: { NINTHWAVE_MUX: "headless" },
      checkBinary,
    });
    checkAutoLaunch(deps);
    expect(checkBinary).not.toHaveBeenCalled();
  });

  // ── tmux detection tests ───────────────────────────────────────────

  it("returns proceed when $TMUX is set (inside tmux session)", () => {
    const deps = makeDeps({
      env: { TMUX: "/tmp/tmux-501/default,12345,0" },
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("returns proceed when tmux available outside session", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "tmux",
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("cmux available outside session still returns proceed", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  // ── NINTHWAVE_MUX override tests ──────────────────────────────────

  it("returns proceed when NINTHWAVE_MUX=tmux", () => {
    const deps = makeDeps({
      env: { NINTHWAVE_MUX: "tmux" },
      checkBinary: () => false,
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("NINTHWAVE_MUX=cmux returns proceed when inside cmux session", () => {
    const deps = makeDeps({
      env: { NINTHWAVE_MUX: "cmux", CMUX_WORKSPACE_ID: "workspace:1" },
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("NINTHWAVE_MUX=cmux returns proceed even when not inside cmux session", () => {
    const deps = makeDeps({
      env: { NINTHWAVE_MUX: "cmux" },
      checkBinary: () => false,
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });

  it("invalid NINTHWAVE_MUX warns and falls through to auto-detect", () => {
    const warnings: string[] = [];
    const deps = makeDeps({
      env: { NINTHWAVE_MUX: "garbage" },
      checkBinary: (name) => name === "tmux",
      warn: (msg) => warnings.push(msg),
    });
    const result = checkAutoLaunch(deps);
    expect(result).toEqual({ action: "proceed" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Invalid NINTHWAVE_MUX");
    expect(warnings[0]).toContain("garbage");
  });

  it("NINTHWAVE_MUX=tmux takes precedence over CMUX_WORKSPACE_ID", () => {
    const deps = makeDeps({
      env: { NINTHWAVE_MUX: "tmux", CMUX_WORKSPACE_ID: "workspace:1" },
    });
    expect(checkAutoLaunch(deps)).toEqual({ action: "proceed" });
  });
});

// ── ensureMuxOrAutoLaunch (side-effectful wrapper) ──────────────────

describe("ensureMuxOrAutoLaunch", () => {
  it("returns normally when inside cmux", () => {
    const deps = makeDeps({
      env: { CMUX_WORKSPACE_ID: "workspace:1" },
    });

    // Should not throw
    ensureMuxOrAutoLaunch(["watch"], deps);
  });

  it("returns normally when cmux is installed but not in session", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "cmux",
    });

    ensureMuxOrAutoLaunch(["watch"], deps);
  });

  it("returns normally when nothing is available (headless fallback)", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: () => false,
    });

    ensureMuxOrAutoLaunch(["watch"], deps);
  });

  it("returns normally when tmux available outside session", () => {
    const deps = makeDeps({
      env: {},
      checkBinary: (name) => name === "tmux",
    });

    // Should not throw -- tmux creates its own session
    ensureMuxOrAutoLaunch(["watch"], deps);
  });

  it("returns normally when NINTHWAVE_MUX=tmux", () => {
    const deps = makeDeps({
      env: { NINTHWAVE_MUX: "tmux" },
    });

    ensureMuxOrAutoLaunch(["watch"], deps);
  });
});

// ── ensureMuxInteractiveOrDie ────────────────────────────────────────

function makeInteractiveDeps(
  overrides: Partial<InteractiveMuxDeps> & {
    promptAnswers?: string[];
    installExitCode?: number;
  } = {},
): InteractiveMuxDeps & { output: string[]; installed: string[][]; relaunched: string[][] | null; opened: string[] } {
  const output: string[] = [];
  const installed: string[][] = [];
  const relaunched: string[][] | null = [];
  const opened: string[] = [];
  const promptAnswers = overrides.promptAnswers ?? [];
  let promptIdx = 0;

  return {
    env: overrides.env ?? {},
    checkBinary: overrides.checkBinary ?? (() => false),
    isTTY: overrides.isTTY ?? true,
    platform: overrides.platform ?? "darwin",
    prompt: async (_q: string) => {
      const answer = promptAnswers[promptIdx] ?? "";
      promptIdx++;
      return answer;
    },
    runInstall: (cmd: string, args: string[]) => {
      installed.push([cmd, ...args]);
      return { exitCode: overrides.installExitCode ?? 0 };
    },
    relaunch: (args: string[]) => {
      relaunched.push(args);
    },
    openApp: (app: string) => {
      opened.push(app);
    },
    output,
    installed,
    relaunched,
    opened,
  };
}

describe("ensureMuxInteractiveOrDie", () => {
  it("returns normally when inside cmux session", async () => {
    const deps = makeInteractiveDeps({ env: { CMUX_WORKSPACE_ID: "workspace:1" } });
    await ensureMuxInteractiveOrDie([], deps);
    // No error expected
  });

  it("returns normally when tmux is available", async () => {
    const deps = makeInteractiveDeps({ checkBinary: (n) => n === "tmux" });
    await ensureMuxInteractiveOrDie([], deps);
  });

  it("non-TTY: returns normally when nothing installed (headless fallback)", async () => {
    const deps = makeInteractiveDeps({ isTTY: false, checkBinary: () => false });
    await ensureMuxInteractiveOrDie([], deps);
  });

  it("returns normally when cmux is installed but not in session", async () => {
    const deps = makeInteractiveDeps({
      checkBinary: (n) => n === "cmux",
      platform: "darwin",
    });
    await ensureMuxInteractiveOrDie([], deps);
    expect(deps.opened).toHaveLength(0);
    expect(deps.installed).toHaveLength(0);
  });

  it("nothing-installed does not prompt for install", async () => {
    const deps = makeInteractiveDeps({
      checkBinary: () => false,
      platform: "darwin",
    });
    await ensureMuxInteractiveOrDie([], deps);
    expect(deps.installed).toHaveLength(0);
    expect(deps.opened).toHaveLength(0);
  });
});
