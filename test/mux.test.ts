// Tests for core/mux.ts -- Multiplexer interface, CmuxAdapter,
// detectMuxType auto-detection, and getMux factory.

import { describe, it, expect, vi } from "vitest";

// lint-ignore: no-leaked-mock
vi.mock("../core/cmux.ts", () => ({
  isAvailable: vi.fn(() => true),
  launchWorkspace: vi.fn(() => "workspace:42"),
  splitPane: vi.fn(() => "surface:3"),
  readScreen: vi.fn(() => "line1\nline2\nline3\n"),
  listWorkspaces: vi.fn(() => "workspace:1 work item T-1 test"),
  closeWorkspace: vi.fn(() => true),
  setStatus: vi.fn(() => true),
  setProgress: vi.fn(() => true),
}));

import * as cmux from "../core/cmux.ts";
import { HeadlessAdapter } from "../core/headless.ts";
import {
  CmuxAdapter,
  createMux,
  detectMuxType,
  getMux,
  muxTypeForWorkspaceRef,
  resolveBackend,
  type DetectMuxDeps,
  type Multiplexer,
} from "../core/mux.ts";
import { TmuxAdapter } from "../core/tmux.ts";

// ── Helper: build injectable DetectMuxDeps ──────────────────────────

function makeDeps(
  env: Record<string, string | undefined> = {},
  binaries: string[] = [],
  warn?: (msg: string) => void,
  savedBackendMode?: DetectMuxDeps["savedBackendMode"],
): DetectMuxDeps {
  return {
    env,
    checkBinary: (name: string) => binaries.includes(name),
    warn,
    savedBackendMode,
  };
}

// ── CmuxAdapter tests ───────────────────────────────────────────────

describe("CmuxAdapter", () => {
  it("delegates isAvailable to cmux.isAvailable", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.isAvailable();
    expect(result).toBe(true);
    expect(cmux.isAvailable).toHaveBeenCalled();
  });

  it("delegates launchWorkspace to cmux.launchWorkspace", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.launchWorkspace("/tmp/test", "claude --name test");
    expect(result).toBe("workspace:42");
    expect(cmux.launchWorkspace).toHaveBeenCalledWith("/tmp/test", "claude --name test");
  });

  it("delegates listWorkspaces to cmux.listWorkspaces", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.listWorkspaces();
    expect(result).toBe("workspace:1 work item T-1 test");
    expect(cmux.listWorkspaces).toHaveBeenCalled();
  });

  it("delegates closeWorkspace to cmux.closeWorkspace", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.closeWorkspace("workspace:1");
    expect(result).toBe(true);
    expect(cmux.closeWorkspace).toHaveBeenCalledWith("workspace:1");
  });

  it("delegates readScreen to cmux.readScreen", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.readScreen("workspace:1", 5);
    expect(result).toBe("line1\nline2\nline3\n");
    expect(cmux.readScreen).toHaveBeenCalledWith("workspace:1", 5);
  });

  it("delegates splitPane to cmux.splitPane", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.splitPane("ninthwave status --watch");
    expect(result).toBe("surface:3");
    expect(cmux.splitPane).toHaveBeenCalledWith("ninthwave status --watch");
  });

  it("delegates setStatus to cmux.setStatus", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.setStatus("workspace:1", "build", "Building", "hammer.fill", "#b45309");
    expect(result).toBe(true);
    expect(cmux.setStatus).toHaveBeenCalledWith("workspace:1", "build", "Building", "hammer.fill", "#b45309");
  });

  it("delegates setProgress to cmux.setProgress", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.setProgress("workspace:1", 75, "3/4 done");
    expect(result).toBe(true);
    expect(cmux.setProgress).toHaveBeenCalledWith("workspace:1", 75, "3/4 done");
  });

  it("delegates setProgress without label to cmux.setProgress", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.setProgress("workspace:1", 50);
    expect(result).toBe(true);
    expect(cmux.setProgress).toHaveBeenCalledWith("workspace:1", 50, undefined);
  });

  it("has type 'cmux'", () => {
    const adapter = new CmuxAdapter();
    expect(adapter.type).toBe("cmux");
  });

  it("diagnoseUnavailable reports cmux not available", () => {
    const adapter = new CmuxAdapter();
    const msg = adapter.diagnoseUnavailable();
    expect(msg).toContain("cmux");
    expect(msg).toContain("not available");
  });
});

// ── detectMuxType tests ─────────────────────────────────────────────

describe("detectMuxType", () => {
  it("uses saved backend_mode when no env override is present", () => {
    const deps = makeDeps({}, ["tmux", "cmux"], undefined, "cmux");
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("picks cmux when CMUX_WORKSPACE_ID is set", () => {
    const deps = makeDeps({ CMUX_WORKSPACE_ID: "abc-123" });
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("falls back to cmux binary when no session env vars", () => {
    const deps = makeDeps({}, ["cmux"]);
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("falls back to headless when no multiplexer is available", () => {
    const deps = makeDeps({}, []);
    expect(detectMuxType(deps)).toBe("headless");
  });

  it("prefers session env var over binary detection", () => {
    const deps = makeDeps({ CMUX_WORKSPACE_ID: "abc" }, ["cmux"]);
    expect(detectMuxType(deps)).toBe("cmux");
  });

  // ── NINTHWAVE_MUX override tests ───────────────────────────────────

  it("returns tmux when NINTHWAVE_MUX=tmux", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "tmux" }, ["tmux"]);
    expect(detectMuxType(deps)).toBe("tmux");
  });

  it("returns cmux when NINTHWAVE_MUX=cmux", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "cmux" }, ["cmux"]);
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("returns headless when NINTHWAVE_MUX=headless", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "headless" });
    expect(detectMuxType(deps)).toBe("headless");
  });

  it("warns and falls through on invalid NINTHWAVE_MUX", () => {
    const warnings: string[] = [];
    const deps = makeDeps(
      { NINTHWAVE_MUX: "garbage" },
      ["tmux"],
      (msg) => warnings.push(msg),
    );
    expect(detectMuxType(deps)).toBe("tmux");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Invalid NINTHWAVE_MUX");
    expect(warnings[0]).toContain("garbage");
  });

  it("NINTHWAVE_MUX overrides session env vars", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "tmux", CMUX_WORKSPACE_ID: "abc" }, ["tmux"]);
    expect(detectMuxType(deps)).toBe("tmux");
  });

  it("NINTHWAVE_MUX=cmux overrides $TMUX", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "cmux", TMUX: "/tmp/tmux-501/default,12345,0" }, ["cmux"]);
    expect(detectMuxType(deps)).toBe("cmux");
  });

  // ── tmux detection tests ───────────────────────────────────────────

  it("returns tmux when $TMUX is set", () => {
    const deps = makeDeps({ TMUX: "/tmp/tmux-501/default,12345,0" });
    expect(detectMuxType(deps)).toBe("tmux");
  });

  it("recognizes tmux pane refs", () => {
    expect(muxTypeForWorkspaceRef("%12")).toBe("tmux");
  });

  it("returns tmux when tmux binary available (no session)", () => {
    const deps = makeDeps({}, ["tmux"]);
    expect(detectMuxType(deps)).toBe("tmux");
  });

  it("prefers tmux over cmux when both binaries available", () => {
    const deps = makeDeps({}, ["tmux", "cmux"]);
    expect(detectMuxType(deps)).toBe("tmux");
  });

  it("CMUX_WORKSPACE_ID takes precedence over $TMUX", () => {
    const deps = makeDeps({
      CMUX_WORKSPACE_ID: "workspace:1",
      TMUX: "/tmp/tmux-501/default,12345,0",
    });
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("override precedence: NINTHWAVE_MUX > session env > binary", () => {
    // NINTHWAVE_MUX wins over everything
    const deps = makeDeps(
      { NINTHWAVE_MUX: "cmux", CMUX_WORKSPACE_ID: "abc", TMUX: "/tmp/tmux" },
      ["tmux", "cmux"],
    );
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("override precedence: NINTHWAVE_MUX > saved backend_mode > auto", () => {
    const deps = makeDeps(
      { NINTHWAVE_MUX: "cmux", TMUX: "/tmp/tmux" },
      ["tmux", "cmux"],
      undefined,
      "tmux",
    );
    expect(resolveBackend(deps)).toMatchObject({
      requested: "cmux",
      source: "env",
      effective: "cmux",
    });
  });

  it("uses saved backend_mode ahead of auto detection", () => {
    const deps = makeDeps(
      { CMUX_WORKSPACE_ID: "workspace:1" },
      ["tmux", "cmux"],
      undefined,
      "tmux",
    );
    expect(resolveBackend(deps)).toMatchObject({
      requested: "tmux",
      source: "user-config",
      effective: "tmux",
    });
  });

  it("keeps explicit cmux selection inside a tmux session", () => {
    const deps = makeDeps(
      { TMUX: "/tmp/tmux" },
      ["tmux", "cmux"],
      undefined,
      "cmux",
    );
    expect(resolveBackend(deps)).toMatchObject({
      requested: "cmux",
      source: "user-config",
      effective: "cmux",
    });
  });

  it("falls back from auto to headless when no mux exists", () => {
    const deps = makeDeps({}, []);
    expect(resolveBackend(deps)).toEqual({
      requested: "auto",
      source: "auto",
      effective: "headless",
      fallback: {
        from: "auto",
        to: "headless",
        reason: "No tmux or cmux session/binary detected. Falling back to headless.",
      },
    });
  });

  it("downgrades unsupported explicit backend choices to headless with a reason", () => {
    const deps = makeDeps({ TMUX: "/tmp/tmux" }, ["tmux"], undefined, "cmux");
    const resolved = resolveBackend(deps);
    expect(resolved.effective).toBe("headless");
    expect(resolved.fallback).toEqual({
      from: "cmux",
      to: "headless",
      reason: expect.stringContaining("saved backend_mode"),
    });
  });

  it("invalid NINTHWAVE_MUX falls through to full detection chain", () => {
    const warnings: string[] = [];
    // Invalid override, but CMUX_WORKSPACE_ID is set
    const deps = makeDeps(
      { NINTHWAVE_MUX: "invalid", CMUX_WORKSPACE_ID: "abc" },
      [],
      (msg) => warnings.push(msg),
    );
    expect(detectMuxType(deps)).toBe("cmux");
    expect(warnings).toHaveLength(1);
  });
});

// ── getMux tests ────────────────────────────────────────────────────

describe("getMux", () => {
  it("returns CmuxAdapter when detection picks cmux", () => {
    const deps = makeDeps({ CMUX_WORKSPACE_ID: "abc-123" }, ["cmux"]);
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(CmuxAdapter);
  });

  it("returns CmuxAdapter when inside a cmux session", () => {
    const deps = makeDeps({ CMUX_WORKSPACE_ID: "abc-123" }, ["cmux"]);
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(CmuxAdapter);
  });

  it("returns an object satisfying the Multiplexer interface", () => {
    const deps = makeDeps({ CMUX_WORKSPACE_ID: "abc-123" });
    const mux: Multiplexer = getMux(deps);
    expect(typeof mux.isAvailable).toBe("function");
    expect(typeof mux.launchWorkspace).toBe("function");
    expect(typeof mux.splitPane).toBe("function");
    expect(typeof mux.readScreen).toBe("function");
    expect(typeof mux.listWorkspaces).toBe("function");
    expect(typeof mux.closeWorkspace).toBe("function");
    expect(typeof mux.setStatus).toBe("function");
    expect(typeof mux.setProgress).toBe("function");
  });

  it("returns HeadlessAdapter when no mux is available", () => {
    const deps = makeDeps({}, []);
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(HeadlessAdapter);
  });

  it("returns HeadlessAdapter when NINTHWAVE_MUX=headless", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "headless" });
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(HeadlessAdapter);
    expect(mux.type).toBe("headless");
  });

  it("returns TmuxAdapter when detection picks tmux", () => {
    const deps = makeDeps({ TMUX: "/tmp/tmux-501/default,12345,0" });
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(TmuxAdapter);
    expect(mux.type).toBe("tmux");
  });

  it("returns TmuxAdapter when NINTHWAVE_MUX=tmux", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "tmux" }, ["tmux"]);
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(TmuxAdapter);
  });

  it("returns CmuxAdapter when NINTHWAVE_MUX=cmux", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "cmux" }, ["cmux"]);
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(CmuxAdapter);
  });
});

describe("createMux", () => {
  it("returns HeadlessAdapter for headless type", () => {
    const mux = createMux("headless");
    expect(mux).toBeInstanceOf(HeadlessAdapter);
    expect(mux.type).toBe("headless");
  });

  it("returns TmuxAdapter for tmux type", () => {
    const mux = createMux("tmux");
    expect(mux).toBeInstanceOf(TmuxAdapter);
    expect(mux.type).toBe("tmux");
  });

  it("returns CmuxAdapter for cmux type", () => {
    const mux = createMux("cmux");
    expect(mux).toBeInstanceOf(CmuxAdapter);
    expect(mux.type).toBe("cmux");
  });
});

describe("muxTypeForWorkspaceRef", () => {
  it("classifies cmux refs", () => {
    expect(muxTypeForWorkspaceRef("workspace:7")).toBe("cmux");
  });

  it("classifies tmux refs", () => {
    expect(muxTypeForWorkspaceRef("nw-dev:1")).toBe("tmux");
  });

  it("classifies headless refs", () => {
    expect(muxTypeForWorkspaceRef("headless:H-BES-3")).toBe("headless");
    expect(muxTypeForWorkspaceRef("H-BES-3")).toBe("headless");
  });
});
