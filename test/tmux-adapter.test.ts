// Tests for TmuxAdapter — uses dependency-injected shell runner (no vi.mock).

import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../core/mux.ts";
import type { RunResult } from "../core/types.ts";

/** Helper: create a shell runner that records calls and returns canned results. */
function fakeRunner(results: RunResult[] = []) {
  const calls: { cmd: string; args: string[] }[] = [];
  let callIndex = 0;

  const defaultOk: RunResult = { stdout: "", stderr: "", exitCode: 0 };

  const runner = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    return results[callIndex++] ?? defaultOk;
  };

  return { runner, calls };
}

describe("TmuxAdapter", () => {
  describe("isAvailable", () => {
    it("returns true when tmux -V succeeds", () => {
      const { runner } = fakeRunner([
        { stdout: "tmux 3.4", stderr: "", exitCode: 0 },
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.isAvailable()).toBe(true);
    });

    it("returns false when tmux is not installed", () => {
      const { runner } = fakeRunner([
        { stdout: "", stderr: "command not found: tmux", exitCode: 127 },
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.isAvailable()).toBe(false);
    });
  });

  describe("launchWorkspace", () => {
    it("calls tmux new-session with correct args", () => {
      const { runner, calls } = fakeRunner([
        { stdout: "", stderr: "", exitCode: 0 },
      ]);
      const adapter = new TmuxAdapter(runner);

      const ref = adapter.launchWorkspace("/tmp/work", "claude --name test");

      expect(ref).toBe("nw-1");
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual([
        "new-session",
        "-d",
        "-s",
        "nw-1",
        "-c",
        "/tmp/work",
        "claude --name test",
      ]);
    });

    it("increments session counter on successive launches", () => {
      const { runner } = fakeRunner();
      const adapter = new TmuxAdapter(runner);

      expect(adapter.launchWorkspace("/a", "cmd1")).toBe("nw-1");
      expect(adapter.launchWorkspace("/b", "cmd2")).toBe("nw-2");
      expect(adapter.launchWorkspace("/c", "cmd3")).toBe("nw-3");
    });

    it("returns null when tmux new-session fails", () => {
      const { runner } = fakeRunner([
        { stdout: "", stderr: "server not running", exitCode: 1 },
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.launchWorkspace("/tmp", "cmd")).toBeNull();
    });

    it("uses nw- prefix for session names", () => {
      const { runner, calls } = fakeRunner();
      const adapter = new TmuxAdapter(runner);

      adapter.launchWorkspace("/tmp", "cmd");

      const sessionName = calls[0].args[3]; // -s <name>
      expect(sessionName).toMatch(/^nw-/);
    });
  });

  describe("sendMessage", () => {
    it("calls tmux send-keys with -l for literal text then Enter", () => {
      const { runner, calls } = fakeRunner();
      const adapter = new TmuxAdapter(runner);

      const result = adapter.sendMessage("nw-1", "hello world");

      expect(result).toBe(true);
      expect(calls).toHaveLength(2);
      // First call: literal text
      expect(calls[0].args).toEqual([
        "send-keys",
        "-t",
        "nw-1",
        "-l",
        "hello world",
      ]);
      // Second call: Enter key
      expect(calls[1].args).toEqual(["send-keys", "-t", "nw-1", "Enter"]);
    });

    it("escapes special characters via -l flag", () => {
      const { runner, calls } = fakeRunner();
      const adapter = new TmuxAdapter(runner);

      const msg = 'echo "hello $USER" && exit';
      adapter.sendMessage("nw-1", msg);

      // -l ensures literal interpretation — the raw text is passed through
      expect(calls[0].args[4]).toBe(msg);
    });

    it("returns false when send-keys fails", () => {
      const { runner } = fakeRunner([
        { stdout: "", stderr: "session not found", exitCode: 1 },
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.sendMessage("nw-99", "text")).toBe(false);
    });

    it("returns false when Enter key send fails", () => {
      const { runner } = fakeRunner([
        { stdout: "", stderr: "", exitCode: 0 }, // text succeeds
        { stdout: "", stderr: "session not found", exitCode: 1 }, // Enter fails
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.sendMessage("nw-1", "text")).toBe(false);
    });
  });

  describe("readScreen", () => {
    it("calls tmux capture-pane with correct args", () => {
      const { runner, calls } = fakeRunner([
        { stdout: "line1\nline2\nline3", stderr: "", exitCode: 0 },
      ]);
      const adapter = new TmuxAdapter(runner);

      const screen = adapter.readScreen("nw-1", 5);

      expect(screen).toBe("line1\nline2\nline3");
      expect(calls[0].args).toEqual([
        "capture-pane",
        "-t",
        "nw-1",
        "-p",
        "-S",
        "-5",
      ]);
    });

    it("omits -S flag when lines is not specified", () => {
      const { runner, calls } = fakeRunner([
        { stdout: "content", stderr: "", exitCode: 0 },
      ]);
      const adapter = new TmuxAdapter(runner);

      adapter.readScreen("nw-1");

      expect(calls[0].args).toEqual(["capture-pane", "-t", "nw-1", "-p"]);
    });

    it("returns empty string when capture-pane fails", () => {
      const { runner } = fakeRunner([
        { stdout: "", stderr: "no session", exitCode: 1 },
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.readScreen("nw-1")).toBe("");
    });
  });

  describe("listWorkspaces", () => {
    it("parses tmux session list and filters to nw- sessions", () => {
      const { runner } = fakeRunner([
        {
          stdout: "nw-1\nuser-session\nnw-2\nwork",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.listWorkspaces()).toBe("nw-1\nnw-2");
    });

    it("calls tmux list-sessions with format flag", () => {
      const { runner, calls } = fakeRunner([
        { stdout: "nw-1", stderr: "", exitCode: 0 },
      ]);
      const adapter = new TmuxAdapter(runner);

      adapter.listWorkspaces();

      expect(calls[0].args).toEqual([
        "list-sessions",
        "-F",
        "#{session_name}",
      ]);
    });

    it("returns empty string when tmux is not running", () => {
      const { runner } = fakeRunner([
        { stdout: "", stderr: "no server running", exitCode: 1 },
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.listWorkspaces()).toBe("");
    });

    it("returns empty string when no nw- sessions exist", () => {
      const { runner } = fakeRunner([
        { stdout: "my-session\nwork", stderr: "", exitCode: 0 },
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.listWorkspaces()).toBe("");
    });
  });

  describe("closeWorkspace", () => {
    it("calls tmux kill-session with correct session name", () => {
      const { runner, calls } = fakeRunner([
        { stdout: "", stderr: "", exitCode: 0 },
      ]);
      const adapter = new TmuxAdapter(runner);

      const result = adapter.closeWorkspace("nw-1");

      expect(result).toBe(true);
      expect(calls[0].args).toEqual(["kill-session", "-t", "nw-1"]);
    });

    it("returns false when session does not exist", () => {
      const { runner } = fakeRunner([
        { stdout: "", stderr: "session not found: nw-99", exitCode: 1 },
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.closeWorkspace("nw-99")).toBe(false);
    });
  });

  describe("Multiplexer interface compliance", () => {
    it("implements all Multiplexer methods", () => {
      const { runner } = fakeRunner();
      const adapter = new TmuxAdapter(runner);

      expect(typeof adapter.isAvailable).toBe("function");
      expect(typeof adapter.launchWorkspace).toBe("function");
      expect(typeof adapter.sendMessage).toBe("function");
      expect(typeof adapter.readScreen).toBe("function");
      expect(typeof adapter.listWorkspaces).toBe("function");
      expect(typeof adapter.closeWorkspace).toBe("function");
    });
  });
});
