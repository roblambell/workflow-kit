// Tests for core/mux.ts — Multiplexer interface, CmuxAdapter, TmuxAdapter,
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
  TmuxAdapter,
  ZellijAdapter,
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
});

// ── TmuxAdapter tests ─────────────────────────────────────────────

describe("TmuxAdapter", () => {
  /** Helper: build a ShellRunner mock that returns canned results by command. */
  function mockRunner(
    responses: Record<string, { exitCode: number; stdout: string; stderr: string }>,
  ) {
    return (cmd: string, args: string[]) => {
      // Key on the first tmux subcommand (e.g., "split-window", "display-message")
      const subcommand = args[0] ?? cmd;
      return responses[subcommand] ?? { exitCode: 1, stdout: "", stderr: "unknown" };
    };
  }

  /**
   * Helper: build a call-tracking ShellRunner that records every call and
   * returns canned responses keyed by subcommand. When multiple calls use
   * the same subcommand, responses can be provided as an array (consumed
   * in order).
   */
  function trackingRunner(
    responses: Record<
      string,
      | { exitCode: number; stdout: string; stderr: string }
      | Array<{ exitCode: number; stdout: string; stderr: string }>
    >,
  ) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const counters: Record<string, number> = {};

    const runner = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const subcommand = args[0] ?? cmd;
      const resp = responses[subcommand];
      if (Array.isArray(resp)) {
        const idx = counters[subcommand] ?? 0;
        counters[subcommand] = idx + 1;
        return resp[idx] ?? { exitCode: 1, stdout: "", stderr: "exhausted" };
      }
      return resp ?? { exitCode: 1, stdout: "", stderr: "unknown" };
    };

    return { runner, calls };
  }

  // ── isAvailable ─────────────────────────────────────────────────

  describe("isAvailable", () => {
    it("returns true when tmux -V succeeds and TMUX is set", () => {
      const runner = mockRunner({
        "-V": { exitCode: 0, stdout: "tmux 3.4", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner, { env: { TMUX: "/tmp/tmux-501/default,12345,0" } });
      expect(adapter.isAvailable()).toBe(true);
    });

    it("returns false when tmux -V fails", () => {
      const runner = mockRunner({
        "-V": { exitCode: 1, stdout: "", stderr: "not found" },
      });
      const adapter = new TmuxAdapter(runner, { env: {} });
      expect(adapter.isAvailable()).toBe(false);
    });

    it("calls tmux with -V flag", () => {
      const { runner, calls } = trackingRunner({
        "-V": { exitCode: 0, stdout: "tmux 3.4", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner, { env: { TMUX: "/tmp/tmux-501/default" } });
      adapter.isAvailable();

      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual(["-V"]);
    });
  });

  // ── launchWorkspace ─────────────────────────────────────────────

  describe("launchWorkspace", () => {
    it("returns session name on success", () => {
      const runner = mockRunner({
        "new-session": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.launchWorkspace("/tmp/project", "claude --name test");
      expect(result).toBe("nw-1");
    });

    it("generates incrementing nw-N session names", () => {
      const runner = mockRunner({
        "new-session": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);

      const first = adapter.launchWorkspace("/tmp/a", "cmd1");
      const second = adapter.launchWorkspace("/tmp/b", "cmd2");
      const third = adapter.launchWorkspace("/tmp/c", "cmd3");

      expect(first).toBe("nw-1");
      expect(second).toBe("nw-2");
      expect(third).toBe("nw-3");
    });

    it("returns null when new-session fails", () => {
      const runner = mockRunner({
        "new-session": { exitCode: 1, stdout: "", stderr: "duplicate session" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.launchWorkspace("/tmp/project", "claude");
      expect(result).toBeNull();
    });

    it("passes correct args to tmux new-session", () => {
      const { runner, calls } = trackingRunner({
        "new-session": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      adapter.launchWorkspace("/home/user/code", "claude --resume");

      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual([
        "new-session",
        "-d",
        "-s",
        "nw-1",
        "-c",
        "/home/user/code",
        "claude --resume",
      ]);
    });

    it("includes TODO ID in session name when provided", () => {
      const runner = mockRunner({
        "new-session": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.launchWorkspace("/tmp/project", "claude", "H-WRK-1");
      expect(result).toBe("nw-H-WRK-1-1");
    });

    it("generates incrementing names with TODO ID", () => {
      const runner = mockRunner({
        "new-session": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);

      const first = adapter.launchWorkspace("/tmp/a", "cmd1", "H-WRK-1");
      const second = adapter.launchWorkspace("/tmp/b", "cmd2", "M-CI-2");

      expect(first).toBe("nw-H-WRK-1-1");
      expect(second).toBe("nw-M-CI-2-2");
    });

    it("passes TODO-ID-based name to tmux new-session", () => {
      const { runner, calls } = trackingRunner({
        "new-session": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      adapter.launchWorkspace("/home/user/code", "claude --resume", "H-WRK-1");

      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual([
        "new-session",
        "-d",
        "-s",
        "nw-H-WRK-1-1",
        "-c",
        "/home/user/code",
        "claude --resume",
      ]);
    });

    it("falls back to nw-N when no TODO ID is provided", () => {
      const runner = mockRunner({
        "new-session": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.launchWorkspace("/tmp/project", "claude");
      expect(result).toBe("nw-1");
    });
  });

  // ── readScreen ──────────────────────────────────────────────────

  describe("readScreen", () => {
    it("returns stdout on success", () => {
      const runner = mockRunner({
        "capture-pane": { exitCode: 0, stdout: "line1\nline2\nline3", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.readScreen("nw-1");
      expect(result).toBe("line1\nline2\nline3");
    });

    it("returns empty string on failure", () => {
      const runner = mockRunner({
        "capture-pane": { exitCode: 1, stdout: "", stderr: "no session" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.readScreen("nw-1");
      expect(result).toBe("");
    });

    it("passes -S flag when lines parameter is provided", () => {
      const { runner, calls } = trackingRunner({
        "capture-pane": { exitCode: 0, stdout: "content", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      adapter.readScreen("nw-1", 5);

      expect(calls[0].args).toEqual(["capture-pane", "-t", "nw-1", "-p", "-S", "-5"]);
    });

    it("omits -S flag when lines parameter is not provided", () => {
      const { runner, calls } = trackingRunner({
        "capture-pane": { exitCode: 0, stdout: "content", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      adapter.readScreen("nw-1");

      expect(calls[0].args).toEqual(["capture-pane", "-t", "nw-1", "-p"]);
    });
  });

  // ── listWorkspaces ──────────────────────────────────────────────

  describe("listWorkspaces", () => {
    it("returns only nw- prefixed sessions", () => {
      const runner = mockRunner({
        "list-sessions": {
          exitCode: 0,
          stdout: "nw-1\nuser-session\nnw-2\nmy-project\nnw-3",
          stderr: "",
        },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.listWorkspaces();
      expect(result).toBe("nw-1\nnw-2\nnw-3");
    });

    it("returns empty string when list-sessions fails", () => {
      const runner = mockRunner({
        "list-sessions": { exitCode: 1, stdout: "", stderr: "no server running" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.listWorkspaces();
      expect(result).toBe("");
    });

    it("filters out all non-nw- sessions", () => {
      const runner = mockRunner({
        "list-sessions": {
          exitCode: 0,
          stdout: "personal\nwork\ndefault",
          stderr: "",
        },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.listWorkspaces();
      expect(result).toBe("");
    });

    it("handles empty session list", () => {
      const runner = mockRunner({
        "list-sessions": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.listWorkspaces();
      expect(result).toBe("");
    });

    it("passes correct format flag to list-sessions", () => {
      const { runner, calls } = trackingRunner({
        "list-sessions": { exitCode: 0, stdout: "nw-1", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      adapter.listWorkspaces();

      expect(calls[0].args).toEqual(["list-sessions", "-F", "#{session_name}"]);
    });
  });

  // ── closeWorkspace ──────────────────────────────────────────────

  describe("closeWorkspace", () => {
    it("returns true when kill-session succeeds", () => {
      const runner = mockRunner({
        "kill-session": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      expect(adapter.closeWorkspace("nw-1")).toBe(true);
    });

    it("returns false when kill-session fails", () => {
      const runner = mockRunner({
        "kill-session": { exitCode: 1, stdout: "", stderr: "no session: nw-99" },
      });
      const adapter = new TmuxAdapter(runner);
      expect(adapter.closeWorkspace("nw-99")).toBe(false);
    });

    it("passes correct args to kill-session", () => {
      const { runner, calls } = trackingRunner({
        "kill-session": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      adapter.closeWorkspace("nw-5");

      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual(["kill-session", "-t", "nw-5"]);
    });
  });

  // ── sendMessage ─────────────────────────────────────────────────

  describe("sendMessage", () => {
    it("sends via atomic paste (set-buffer + paste-buffer + Enter) on success", () => {
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      const { runner, calls } = trackingRunner({
        "set-buffer": ok,
        "paste-buffer": ok,
        "send-keys": ok,
        // readScreen for verification — return content that doesn't contain the message
        "capture-pane": { exitCode: 0, stdout: "$ \n\n", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner, { sleep: () => {} });
      const result = adapter.sendMessage("nw-1", "hello world");

      expect(result).toBe(true);
      // Should have called: set-buffer, paste-buffer, send-keys (Enter), capture-pane (verify)
      const subcommands = calls.map((c) => c.args[0]);
      expect(subcommands).toContain("set-buffer");
      expect(subcommands).toContain("paste-buffer");
      expect(subcommands).toContain("send-keys");
      expect(subcommands).toContain("capture-pane");
    });

    it("falls back to send-keys -l when set-buffer fails", () => {
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      const { runner, calls } = trackingRunner({
        "set-buffer": { exitCode: 1, stdout: "", stderr: "error" },
        "send-keys": [ok, ok], // first for literal text, second for Enter
        "capture-pane": { exitCode: 0, stdout: "$ \n\n", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner, { sleep: () => {} });
      const result = adapter.sendMessage("nw-1", "hello");

      expect(result).toBe(true);
      // Should have: set-buffer (failed), send-keys -l, send-keys Enter, capture-pane
      const sendKeysCalls = calls.filter((c) => c.args[0] === "send-keys");
      expect(sendKeysCalls.length).toBeGreaterThanOrEqual(2);
      // First send-keys should have -l flag (literal text)
      expect(sendKeysCalls[0].args).toContain("-l");
      // Second send-keys should have "Enter"
      expect(sendKeysCalls[1].args).toContain("Enter");
    });

    it("falls back to send-keys -l when paste-buffer fails", () => {
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      const { runner, calls } = trackingRunner({
        "set-buffer": ok,
        "paste-buffer": { exitCode: 1, stdout: "", stderr: "no session" },
        "send-keys": [ok, ok],
        "capture-pane": { exitCode: 0, stdout: "$ \n\n", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner, { sleep: () => {} });
      const result = adapter.sendMessage("nw-1", "test message");

      expect(result).toBe(true);
      // Fallback path: send-keys -l + send-keys Enter
      const sendKeysCalls = calls.filter((c) => c.args[0] === "send-keys");
      expect(sendKeysCalls[0].args).toContain("-l");
    });

    it("returns false when all send attempts fail", () => {
      const fail = { exitCode: 1, stdout: "", stderr: "error" };
      const runner = (_cmd: string, _args: string[]) => fail;
      const adapter = new TmuxAdapter(runner, {
        sleep: () => {},
        maxRetries: 0,
      });
      const result = adapter.sendMessage("nw-1", "hello");
      expect(result).toBe(false);
    });

    it("retries on delivery verification failure", () => {
      let attemptCount = 0;
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      // Alternate: first attempt verification fails (message stuck on screen),
      // second attempt succeeds
      const runner = (cmd: string, args: string[]) => {
        const sub = args[0] ?? cmd;
        if (sub === "set-buffer") return ok;
        if (sub === "paste-buffer") return ok;
        if (sub === "send-keys") return ok;
        if (sub === "capture-pane") {
          attemptCount++;
          // First verify: message still in input line -> delivery failed
          if (attemptCount <= 2) return { exitCode: 0, stdout: "hello world", stderr: "" };
          // Subsequent: message submitted -> delivery succeeded
          return { exitCode: 0, stdout: "$ \n\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "" };
      };
      const adapter = new TmuxAdapter(runner, {
        sleep: () => {},
        maxRetries: 3,
      });
      const result = adapter.sendMessage("nw-1", "hello world");
      expect(result).toBe(true);
      // Should have attempted more than once
      expect(attemptCount).toBeGreaterThan(2);
    });
  });

  // ── splitPane (existing tests) ──────────────────────────────────

  describe("splitPane", () => {
    it("returns the pane ID from split-window -P -F output", () => {
      const runner = mockRunner({
        "split-window": { exitCode: 0, stdout: "%42\n", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.splitPane("echo hello");
      expect(result).toBe("%42");
    });

    it("passes -P -F '#{pane_id}' and the command to split-window", () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const runner = (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { exitCode: 0, stdout: "%99\n", stderr: "" };
      };
      const adapter = new TmuxAdapter(runner);
      adapter.splitPane("my-command");

      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual([
        "split-window",
        "-P",
        "-F",
        "#{pane_id}",
        "my-command",
      ]);
    });

    it("returns fallback when -P flag output is empty", () => {
      const runner = mockRunner({
        "split-window": { exitCode: 0, stdout: "", stderr: "" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.splitPane("echo hello");
      // Falls back to nw-pane-<counter> pattern
      expect(result).toMatch(/^nw-pane-\d+$/);
    });

    it("returns null when split-window fails", () => {
      const runner = mockRunner({
        "split-window": { exitCode: 1, stdout: "", stderr: "no server" },
      });
      const adapter = new TmuxAdapter(runner);
      const result = adapter.splitPane("echo hello");
      expect(result).toBeNull();
    });

    it("does not call display-message (single command only)", () => {
      const calls: string[] = [];
      const runner = (cmd: string, args: string[]) => {
        calls.push(args[0]);
        return { exitCode: 0, stdout: "%10\n", stderr: "" };
      };
      const adapter = new TmuxAdapter(runner);
      adapter.splitPane("test-cmd");

      expect(calls).toEqual(["split-window"]);
      expect(calls).not.toContain("display-message");
    });
  });
});

// ── detectMuxType tests ─────────────────────────────────────────────

describe("detectMuxType", () => {
  it("returns cmux when NINTHWAVE_MUX=cmux", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "cmux" });
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("returns tmux when NINTHWAVE_MUX=tmux", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "tmux" });
    expect(detectMuxType(deps)).toBe("tmux");
  });

  it("returns zellij when NINTHWAVE_MUX=zellij", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "zellij" });
    expect(detectMuxType(deps)).toBe("zellij");
  });

  it("throws on invalid NINTHWAVE_MUX value", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "screen" });
    expect(() => detectMuxType(deps)).toThrow(
      'Invalid NINTHWAVE_MUX value: "screen"',
    );
  });

  it("NINTHWAVE_MUX overrides session env vars", () => {
    // Even when inside a cmux session, explicit override wins
    const deps = makeDeps(
      { NINTHWAVE_MUX: "tmux", CMUX_WORKSPACE_ID: "some-id" },
      ["cmux", "tmux"],
    );
    expect(detectMuxType(deps)).toBe("tmux");
  });

  it("picks cmux when CMUX_WORKSPACE_ID is set", () => {
    const deps = makeDeps({ CMUX_WORKSPACE_ID: "abc-123" });
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("picks zellij when ZELLIJ_SESSION_NAME is set", () => {
    const deps = makeDeps({ ZELLIJ_SESSION_NAME: "my-session" });
    expect(detectMuxType(deps)).toBe("zellij");
  });

  it("picks tmux when TMUX env var is set", () => {
    const deps = makeDeps({ TMUX: "/tmp/tmux-501/default,12345,0" });
    expect(detectMuxType(deps)).toBe("tmux");
  });

  it("prefers cmux session over zellij session when both present", () => {
    const deps = makeDeps({
      CMUX_WORKSPACE_ID: "abc",
      ZELLIJ_SESSION_NAME: "my-session",
    });
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("prefers zellij session over tmux session when both present", () => {
    const deps = makeDeps({
      ZELLIJ_SESSION_NAME: "my-session",
      TMUX: "/tmp/tmux-501/default",
    });
    expect(detectMuxType(deps)).toBe("zellij");
  });

  it("prefers cmux session over tmux session when both present", () => {
    const deps = makeDeps({
      CMUX_WORKSPACE_ID: "abc",
      TMUX: "/tmp/tmux-501/default",
    });
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("falls back to cmux binary when no session env vars", () => {
    const deps = makeDeps({}, ["cmux"]);
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("falls back to zellij binary when cmux is not available", () => {
    const deps = makeDeps({}, ["zellij"]);
    expect(detectMuxType(deps)).toBe("zellij");
  });

  it("falls back to tmux binary when cmux and zellij are not available", () => {
    const deps = makeDeps({}, ["tmux"]);
    expect(detectMuxType(deps)).toBe("tmux");
  });

  it("prefers cmux binary over zellij and tmux binaries", () => {
    const deps = makeDeps({}, ["cmux", "zellij", "tmux"]);
    expect(detectMuxType(deps)).toBe("cmux");
  });

  it("prefers zellij binary over tmux binary", () => {
    const deps = makeDeps({}, ["zellij", "tmux"]);
    expect(detectMuxType(deps)).toBe("zellij");
  });

  it("throws when no multiplexer is available", () => {
    const deps = makeDeps({}, []);
    expect(() => detectMuxType(deps)).toThrow(
      "No multiplexer available",
    );
  });
});

// ── getMux tests ────────────────────────────────────────────────────

describe("getMux", () => {
  it("returns CmuxAdapter when detection picks cmux", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "cmux" });
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(CmuxAdapter);
  });

  it("returns TmuxAdapter when detection picks tmux", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "tmux" });
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(TmuxAdapter);
  });

  it("returns ZellijAdapter when detection picks zellij", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "zellij" });
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(ZellijAdapter);
  });

  it("returns TmuxAdapter when inside a tmux session", () => {
    const deps = makeDeps({ TMUX: "/tmp/tmux-501/default,12345,0" });
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(TmuxAdapter);
  });

  it("returns ZellijAdapter when inside a zellij session", () => {
    const deps = makeDeps({ ZELLIJ_SESSION_NAME: "my-session" });
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(ZellijAdapter);
  });

  it("returns CmuxAdapter when inside a cmux session", () => {
    const deps = makeDeps({ CMUX_WORKSPACE_ID: "abc-123" }, ["cmux"]);
    const mux = getMux(deps);
    expect(mux).toBeInstanceOf(CmuxAdapter);
  });

  it("returns an object satisfying the Multiplexer interface", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "cmux" });
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

  it("still throws on invalid NINTHWAVE_MUX value", () => {
    const deps = makeDeps({ NINTHWAVE_MUX: "screen" });
    expect(() => getMux(deps)).toThrow('Invalid NINTHWAVE_MUX value: "screen"');
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
