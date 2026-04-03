// Tests for TmuxAdapter -- injectable runner pattern, no vi.mock.
// Covers all Multiplexer interface methods, session resolution, and sanitization.

import { describe, it, expect, vi } from "vitest";
import {
  TmuxAdapter,
  resolveSessionName,
  sanitizeName,
  type TmuxAdapterDeps,
} from "../core/tmux.ts";
import type { RunResult } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function ok(stdout = ""): RunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "error"): RunResult {
  return { stdout: "", stderr, exitCode: 1 };
}

function makeDeps(overrides?: Partial<TmuxAdapterDeps>): TmuxAdapterDeps {
  return {
    runner: vi.fn(() => ok()),
    sleep: vi.fn(),
    env: {},
    cwd: () => "/Users/me/code/myproject",
    ...overrides,
  };
}

// ── sanitizeName ────────────────────────────────────────────────────

describe("sanitizeName", () => {
  it("keeps alphanumeric, underscore, and dash", () => {
    expect(sanitizeName("H-TM-1")).toBe("H-TM-1");
    expect(sanitizeName("abc_123")).toBe("abc_123");
  });

  it("replaces special characters with underscore", () => {
    expect(sanitizeName("hello:world/foo@bar")).toBe("hello_world_foo_bar");
  });

  it("replaces spaces with underscore", () => {
    expect(sanitizeName("my project")).toBe("my_project");
  });

  it("handles empty string", () => {
    expect(sanitizeName("")).toBe("");
  });

  it("sanitizes shell injection attempts", () => {
    expect(sanitizeName("$(rm -rf /)")).toBe("__rm_-rf___");
    expect(sanitizeName("`evil`")).toBe("_evil_");
    expect(sanitizeName("foo;bar")).toBe("foo_bar");
    expect(sanitizeName("foo|bar")).toBe("foo_bar");
    expect(sanitizeName("foo&bar")).toBe("foo_bar");
    expect(sanitizeName("foo'bar")).toBe("foo_bar");
    expect(sanitizeName('foo"bar')).toBe("foo_bar");
  });
});

// ── resolveSessionName ──────────────────────────────────────────────

describe("resolveSessionName", () => {
  it("uses tmux display-message when inside tmux ($TMUX set)", () => {
    const runner = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === "display-message") return ok("my-session");
      return ok();
    });

    const result = resolveSessionName({
      runner,
      env: { TMUX: "/tmp/tmux-501/default,12345,0" },
      cwd: () => "/Users/me/code/myproject",
    });

    expect(result).toBe("my-session");
    expect(runner).toHaveBeenCalledWith("tmux", [
      "display-message",
      "-p",
      "#S",
    ]);
  });

  it("falls back to nw-{dirname} when outside tmux", () => {
    const runner = vi.fn(() => ok());

    const result = resolveSessionName({
      runner,
      env: {},
      cwd: () => "/Users/me/code/myproject",
    });

    expect(result).toBe("nw-myproject");
    // Should not call tmux at all when not in tmux
    expect(runner).not.toHaveBeenCalled();
  });

  it("sanitizes dirname with special characters", () => {
    const result = resolveSessionName({
      runner: vi.fn(() => ok()),
      env: {},
      cwd: () => "/Users/me/code/my project!",
    });

    expect(result).toBe("nw-my_project_");
  });

  it("falls back to nw-nw for root directory", () => {
    const result = resolveSessionName({
      runner: vi.fn(() => ok()),
      env: {},
      cwd: () => "/",
    });

    // basename("/") returns "" → fallback to "nw"
    expect(result).toBe("nw-nw");
  });

  it("falls back to dirname when display-message fails inside tmux", () => {
    const runner = vi.fn(() => fail("not connected"));

    const result = resolveSessionName({
      runner,
      env: { TMUX: "/tmp/tmux-501/default,12345,0" },
      cwd: () => "/Users/me/myproject",
    });

    expect(result).toBe("nw-myproject");
  });

  it("falls back to dirname when display-message returns empty", () => {
    const runner = vi.fn(() => ok(""));

    const result = resolveSessionName({
      runner,
      env: { TMUX: "/tmp/tmux-501/default,12345,0" },
      cwd: () => "/Users/me/myproject",
    });

    expect(result).toBe("nw-myproject");
  });
});

// ── TmuxAdapter ─────────────────────────────────────────────────────

describe("TmuxAdapter", () => {
  describe("isAvailable", () => {
    it("returns true when tmux -V succeeds", () => {
      const deps = makeDeps({
        runner: vi.fn(() => ok("tmux 3.4")),
      });
      const adapter = new TmuxAdapter(deps);
      expect(adapter.isAvailable()).toBe(true);
    });

    it("returns false when tmux -V fails", () => {
      const deps = makeDeps({
        runner: vi.fn(() => fail("command not found")),
      });
      const adapter = new TmuxAdapter(deps);
      expect(adapter.isAvailable()).toBe(false);
    });
  });

  describe("diagnoseUnavailable", () => {
    it("returns install instructions", () => {
      const adapter = new TmuxAdapter(makeDeps());
      const msg = adapter.diagnoseUnavailable();
      expect(msg).toContain("tmux");
      expect(msg).toContain("install");
    });
  });

  describe("launchWorkspace", () => {
    it("creates session if it does not exist, then creates window", () => {
      const calls: string[][] = [];
      const runner = vi.fn((_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "has-session") return fail("no session");
        return ok();
      });
      const deps = makeDeps({ runner, layout: "windows" });
      const adapter = new TmuxAdapter(deps);

      const ref = adapter.launchWorkspace(
        "/code/project",
        "claude --resume",
        "H-TM-1",
      );

      expect(ref).toBe("nw-myproject:nw_H-TM-1");
      expect(calls.some((a) => a[0] === "has-session")).toBe(true);
      expect(calls.some((a) => a[0] === "new-session")).toBe(true);
      expect(calls.some((a) => a[0] === "kill-window")).toBe(true);
      expect(calls.some((a) => a[0] === "new-window")).toBe(true);
    });

    it("reuses existing session (crash recovery)", () => {
      const calls: string[][] = [];
      const runner = vi.fn((_cmd: string, args: string[]) => {
        calls.push(args);
        return ok(); // has-session succeeds → session exists
      });
      const deps = makeDeps({ runner, layout: "windows" });
      const adapter = new TmuxAdapter(deps);

      const ref = adapter.launchWorkspace(
        "/code/project",
        "claude --resume",
        "H-TM-1",
      );

      expect(ref).toBe("nw-myproject:nw_H-TM-1");
      // Should NOT have created a new session
      expect(calls.some((a) => a[0] === "new-session")).toBe(false);
    });

    it("kills existing window before creating (retry scenario)", () => {
      const runner = vi.fn(() => ok());
      const deps = makeDeps({ runner, layout: "windows" });
      const adapter = new TmuxAdapter(deps);

      adapter.launchWorkspace("/code/project", "claude", "H-TM-1");

      // kill-window must be called before new-window
      const calls = runner.mock.calls as unknown as Array<[string, string[]]>;
      const callArgs = calls.map(([, args]) => args);
      const killIdx = callArgs.findIndex((a) => a[0] === "kill-window");
      const newIdx = callArgs.findIndex((a) => a[0] === "new-window");
      expect(killIdx).toBeGreaterThan(-1);
      expect(newIdx).toBeGreaterThan(-1);
      expect(killIdx).toBeLessThan(newIdx);
    });

    it("returns null when session creation fails", () => {
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "has-session") return fail();
        if (args[0] === "new-session") return fail("creation failed");
        return ok();
      });
      const deps = makeDeps({ runner, layout: "windows" });
      const adapter = new TmuxAdapter(deps);

      expect(
        adapter.launchWorkspace("/code/project", "claude", "H-TM-1"),
      ).toBeNull();
      expect(adapter.getLastLaunchError()).toBe("creation failed");
    });

    it("returns null when window creation fails", () => {
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "new-window") return fail("window failed");
        return ok();
      });
      const deps = makeDeps({ runner, layout: "windows" });
      const adapter = new TmuxAdapter(deps);

      expect(
        adapter.launchWorkspace("/code/project", "claude", "H-TM-1"),
      ).toBeNull();
      expect(adapter.getLastLaunchError()).toBe("window failed");
    });

    it("generates fallback window name when workItemId is not provided", () => {
      const runner = vi.fn(() => ok());
      const deps = makeDeps({ runner, layout: "windows" });
      const adapter = new TmuxAdapter(deps);

      const ref = adapter.launchWorkspace("/code/project", "claude");

      // Timestamp-based fallback
      expect(ref).toMatch(/^nw-myproject:nw_\d+$/);
    });

    it("sanitizes workItemId with special characters", () => {
      const runner = vi.fn(() => ok());
      const deps = makeDeps({ runner, layout: "windows" });
      const adapter = new TmuxAdapter(deps);

      const ref = adapter.launchWorkspace(
        "/code/project",
        "claude",
        "H-TM-1;rm -rf /",
      );

      expect(ref).toBe("nw-myproject:nw_H-TM-1_rm_-rf__");
    });

    it("passes cwd and command to new-window", () => {
      const runner = vi.fn(() => ok());
      const deps = makeDeps({ runner, layout: "windows" });
      const adapter = new TmuxAdapter(deps);

      adapter.launchWorkspace("/my/path", "claude --resume", "H-1");

      const calls = runner.mock.calls as unknown as Array<[string, string[]]>;
      const newWindowCall = calls.find(
        ([, args]) => args[0] === "new-window",
      );
      expect(newWindowCall).toBeTruthy();
      const args = newWindowCall![1];
      expect(args).toContain("-c");
      expect(args).toContain("/my/path");
      expect(args).toContain("claude --resume");
    });

    it("targets numeric tmux session names with a trailing colon", () => {
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "display-message") return ok("0");
        return ok();
      });
      const deps = makeDeps({
        runner,
        layout: "windows",
        env: { TMUX: "/tmp/tmux-501/default,12345,0" },
      });
      const adapter = new TmuxAdapter(deps);

      const ref = adapter.launchWorkspace("/code/project", "claude", "H-TM-1");

      expect(ref).toBe("0:nw_H-TM-1");
      expect(runner).toHaveBeenCalledWith("tmux", ["has-session", "-t", "0:"]);
      expect(runner).toHaveBeenCalledWith("tmux", [
        "new-window",
        "-t",
        "0:",
        "-n",
        "nw_H-TM-1",
        "-c",
        "/code/project",
        "claude",
      ]);
    });

    it("uses a dashboard pane layout by default and keeps a status pane present", () => {
      let listPanesCalls = 0;
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "list-panes") {
          listPanesCalls++;
          if (listPanesCalls === 1) return fail("no dashboard");
          return ok("%1 nw_status");
        }
        if (args[0] === "new-window") return ok("%1");
        if (args[0] === "split-window") return ok("%2");
        return ok();
      });
      const deps = makeDeps({ runner });
      const adapter = new TmuxAdapter(deps);

      const ref = adapter.launchWorkspace("/code/project", "claude --resume", "H-TM-1");
      const calls = runner.mock.calls as unknown as Array<[string, string[]]>;
      const statusWindowCall = calls.find(([, args]) => args[0] === "new-window");

      expect(ref).toBe("%2");
      expect(statusWindowCall).toBeTruthy();
      expect(statusWindowCall![1]).toContain("nw_dashboard");
      expect(statusWindowCall![1]).toContain("/Users/me/code/myproject");
      expect(statusWindowCall![1][statusWindowCall![1].length - 1]).toContain("status");
      expect(statusWindowCall![1][statusWindowCall![1].length - 1]).toContain("--watch");
      expect(runner).toHaveBeenCalledWith("tmux", [
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        "nw-myproject:nw_dashboard",
        "-c",
        "/code/project",
        "claude --resume",
      ]);
      expect(runner).toHaveBeenCalledWith("tmux", ["select-pane", "-t", "%1", "-T", "nw_status"]);
      expect(runner).toHaveBeenCalledWith("tmux", ["select-pane", "-t", "%2", "-T", "nw_H-TM-1"]);
    });
  });

  describe("readScreen", () => {
    it("reads screen content via capture-pane", () => {
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "capture-pane") return ok("line1\nline2\nline3");
        return ok();
      });
      const deps = makeDeps({ runner });
      const adapter = new TmuxAdapter(deps);

      expect(adapter.readScreen("session:window")).toBe("line1\nline2\nline3");
    });

    it("returns last N lines when lines count specified", () => {
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "capture-pane")
          return ok("line1\nline2\nline3\nline4\nline5");
        return ok();
      });
      const deps = makeDeps({ runner });
      const adapter = new TmuxAdapter(deps);

      expect(adapter.readScreen("session:window", 2)).toBe("line4\nline5");
    });

    it("returns empty string on failure", () => {
      const runner = vi.fn(() => fail("pane not found"));
      const deps = makeDeps({ runner });
      const adapter = new TmuxAdapter(deps);

      expect(adapter.readScreen("session:window")).toBe("");
    });
  });

  describe("listWorkspaces", () => {
    it("lists dashboard worker panes and excludes the status pane by default", () => {
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "list-panes") {
          return ok("%1 nw_status\n%2 nw_H-TM-1\n%3 shell\n%4 nw_H-TM-2");
        }
        return ok();
      });
      const deps = makeDeps({ runner });
      const adapter = new TmuxAdapter(deps);

      expect(adapter.listWorkspaces()).toBe("%2 nw_H-TM-1\n%4 nw_H-TM-2");
    });

    it("returns empty string when no dashboard worker panes exist", () => {
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "list-panes") return ok("%1 nw_status\n%2 shell");
        return ok();
      });
      const deps = makeDeps({ runner });
      const adapter = new TmuxAdapter(deps);

      expect(adapter.listWorkspaces()).toBe("");
    });

    it("returns empty string on failure", () => {
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "list-panes") return fail("no dashboard");
        return ok();
      });
      const deps = makeDeps({ runner });
      const adapter = new TmuxAdapter(deps);

      expect(adapter.listWorkspaces()).toBe("");
    });

    it("can still list legacy worker windows when windows layout is configured", () => {
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "list-windows") {
          return ok("nw_H-TM-1\nbash\nnw_H-TM-2\nvim");
        }
        return ok();
      });
      const deps = makeDeps({ runner, layout: "windows" });
      const adapter = new TmuxAdapter(deps);

      expect(adapter.listWorkspaces()).toBe("nw-myproject:nw_H-TM-1\nnw-myproject:nw_H-TM-2");
    });
  });

  describe("closeWorkspace", () => {
    it("kills pane refs in dashboard mode", () => {
      const deps = makeDeps({ runner: vi.fn(() => ok()) });
      const adapter = new TmuxAdapter(deps);
      expect(adapter.closeWorkspace("%12")).toBe(true);
    });

    it("returns true when kill-window succeeds", () => {
      const deps = makeDeps({ runner: vi.fn(() => ok()), layout: "windows" });
      const adapter = new TmuxAdapter(deps);
      expect(adapter.closeWorkspace("session:nw_H-TM-1")).toBe(true);
    });

    it("returns false when kill-window fails", () => {
      const runner = vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "kill-window") return fail("no window");
        return ok();
      });
      const deps = makeDeps({ runner, layout: "windows" });
      const adapter = new TmuxAdapter(deps);
      expect(adapter.closeWorkspace("session:nw_H-TM-1")).toBe(false);
    });
  });

  describe("setStatus", () => {
    it("returns false (no-op)", () => {
      const adapter = new TmuxAdapter(makeDeps());
      expect(adapter.setStatus("ref", "key", "text", "icon", "color")).toBe(
        false,
      );
    });
  });

  describe("setProgress", () => {
    it("returns false (no-op)", () => {
      const adapter = new TmuxAdapter(makeDeps());
      expect(adapter.setProgress("ref", 0.5, "label")).toBe(false);
    });

    it("returns false without label", () => {
      const adapter = new TmuxAdapter(makeDeps());
      expect(adapter.setProgress("ref", 0.5)).toBe(false);
    });
  });

  describe("splitPane", () => {
    it("returns null (not supported)", () => {
      const adapter = new TmuxAdapter(makeDeps());
      expect(adapter.splitPane("echo hello")).toBeNull();
    });
  });

  describe("type property", () => {
    it("is tmux", () => {
      const adapter = new TmuxAdapter(makeDeps());
      expect(adapter.type).toBe("tmux");
    });
  });
});
