// Tests for core/mux.ts — Multiplexer interface, CmuxAdapter,
// detectMuxType auto-detection, and getMux factory.

import { describe, it, expect, vi } from "vitest";

vi.mock("../core/cmux.ts", () => ({
  isAvailable: vi.fn(() => true),
  launchWorkspace: vi.fn(() => "workspace:42"),
  splitPane: vi.fn(() => "surface:3"),
  sendMessage: vi.fn(() => true),
  readScreen: vi.fn(() => "line1\nline2\nline3\n"),
  listWorkspaces: vi.fn(() => "workspace:1 TODO T-1 test"),
  closeWorkspace: vi.fn(() => true),
}));

import * as cmux from "../core/cmux.ts";
import {
  CmuxAdapter,
  detectMuxType,
  getMux,
  waitForReady,
  type DetectMuxDeps,
  type Multiplexer,
} from "../core/mux.ts";

// ── Helper: build injectable DetectMuxDeps ──────────────────────────

function makeDeps(
  env: Record<string, string | undefined> = {},
  binaries: string[] = [],
): DetectMuxDeps {
  return {
    env,
    checkBinary: (name: string) => binaries.includes(name),
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

  it("delegates sendMessage to cmux.sendMessage", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.sendMessage("workspace:1", "hello");
    expect(result).toBe(true);
    expect(cmux.sendMessage).toHaveBeenCalledWith("workspace:1", "hello");
  });

  it("delegates listWorkspaces to cmux.listWorkspaces", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.listWorkspaces();
    expect(result).toBe("workspace:1 TODO T-1 test");
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
  it("picks cmux when CMUX_WORKSPACE_ID is set", () => {
    const deps = makeDeps({ CMUX_WORKSPACE_ID: "abc-123" });
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("falls back to cmux binary when no session env vars", () => {
    const deps = makeDeps({}, ["cmux"]);
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("throws when no multiplexer is available", () => {
    const deps = makeDeps({}, []);
    expect(() => detectMuxType(deps)).toThrow(
      "No multiplexer available",
    );
  });

  it("prefers session env var over binary detection", () => {
    const deps = makeDeps({ CMUX_WORKSPACE_ID: "abc" }, ["cmux"]);
    expect(detectMuxType(deps)).toBe("cmux");
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
    expect(typeof mux.sendMessage).toBe("function");
    expect(typeof mux.readScreen).toBe("function");
    expect(typeof mux.listWorkspaces).toBe("function");
    expect(typeof mux.closeWorkspace).toBe("function");
  });

  it("falls back to CmuxAdapter when no mux available", () => {
    const deps = makeDeps({}, []);
    const mux = getMux(deps);
    // Falls back gracefully — caller can check isAvailable()
    expect(mux).toBeInstanceOf(CmuxAdapter);
  });
});

// ── waitForReady tests ──────────────────────────────────────────────

describe("waitForReady", () => {
  it("returns true when screen has stable, substantial content", () => {
    const fakeMux: Multiplexer = {
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "Welcome to Claude\nReady for input\nType your message\n>",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => sleepCalls.push(ms);

    const result = waitForReady(fakeMux, "workspace:1", sleep, 5, 1000);

    // Needs 2 consecutive identical reads, so at least 2 sleep calls
    expect(result).toBe(true);
    expect(sleepCalls.length).toBe(2);
  });

  it("returns false when screen never stabilizes", () => {
    let callCount = 0;
    const fakeMux: Multiplexer = {
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => `changing content ${callCount++}\nline2\nline3`,
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };
    const sleep = () => {};

    const result = waitForReady(fakeMux, "workspace:1", sleep, 3, 100);

    expect(result).toBe(false);
  });

  it("returns false when screen has fewer than 3 lines", () => {
    const fakeMux: Multiplexer = {
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "just one line",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };
    const sleep = () => {};

    const result = waitForReady(fakeMux, "workspace:1", sleep, 3, 100);

    expect(result).toBe(false);
  });

  it("waits through empty screens until content appears", () => {
    let callCount = 0;
    const fakeMux: Multiplexer = {
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => {
        callCount++;
        if (callCount <= 2) return ""; // Empty during boot
        return "Welcome\nReady\nPrompt\n>";
      },
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => sleepCalls.push(ms);

    const result = waitForReady(fakeMux, "workspace:1", sleep, 10, 1000);

    expect(result).toBe(true);
    // 2 empty + 2 with content (need 2 stable reads)
    expect(sleepCalls.length).toBe(4);
  });
});
