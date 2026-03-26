// Tests for TmuxAdapter — uses dependency-injected shell runner (no vi.mock).

import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../core/mux.ts";
import type { RunResult } from "../core/types.ts";

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr = ""): RunResult => ({ stdout: "", stderr, exitCode: 1 });

/** Helper: create a shell runner that records calls and returns canned results. */
function fakeRunner(results: RunResult[] = []) {
  const calls: { cmd: string; args: string[] }[] = [];
  let callIndex = 0;

  const runner = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    return results[callIndex++] ?? ok();
  };

  return { runner, calls };
}

/** Create a TmuxAdapter with no retries for basic tests. */
function adapterNoRetry(runner: (cmd: string, args: string[]) => RunResult) {
  return new TmuxAdapter(runner, { sleep: () => {}, maxRetries: 0 });
}

/** Create a TmuxAdapter with custom retry options. */
function adapterWithRetry(
  runner: (cmd: string, args: string[]) => RunResult,
  maxRetries: number,
) {
  return new TmuxAdapter(runner, {
    sleep: () => {},
    maxRetries,
    baseDelayMs: 100,
  });
}

describe("TmuxAdapter", () => {
  describe("isAvailable", () => {
    it("returns true when tmux -V succeeds and TMUX env is set", () => {
      const { runner } = fakeRunner([ok("tmux 3.4")]);
      const adapter = new TmuxAdapter(runner, { env: { TMUX: "/tmp/tmux-501/default,12345,0" } });

      expect(adapter.isAvailable()).toBe(true);
    });

    it("returns false when tmux is not installed", () => {
      const { runner } = fakeRunner([fail("command not found: tmux")]);
      const adapter = new TmuxAdapter(runner, { env: {} });

      expect(adapter.isAvailable()).toBe(false);
    });

    it("returns false when tmux binary exists but no active session", () => {
      const { runner } = fakeRunner([ok("tmux 3.4")]);
      const adapter = new TmuxAdapter(runner, { env: {} });

      expect(adapter.isAvailable()).toBe(false);
    });
  });

  describe("launchWorkspace", () => {
    it("calls tmux new-session with correct args", () => {
      const { runner, calls } = fakeRunner([ok()]);
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
      const { runner } = fakeRunner([fail("server not running")]);
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

  // ── sendMessage: atomic paste path ─────────────────────────────────

  describe("sendMessage (atomic paste path)", () => {
    it("uses set-buffer + paste-buffer + Enter + verify on success", () => {
      const { runner, calls } = fakeRunner([
        ok(),                         // set-buffer
        ok(),                         // paste-buffer
        ok(),                         // send-keys Enter
        ok("Thinking...\nclaude> "),  // capture-pane (verify: no trace)
      ]);
      const adapter = adapterNoRetry(runner);

      const result = adapter.sendMessage("nw-1", "hello world");

      expect(result).toBe(true);
      expect(calls).toHaveLength(4);

      // 1. Set buffer
      expect(calls[0].args).toEqual([
        "set-buffer", "-b", "nw_send", "--", "hello world",
      ]);
      // 2. Paste buffer
      expect(calls[1].args).toEqual([
        "paste-buffer", "-b", "nw_send", "-t", "nw-1",
      ]);
      // 3. Enter key
      expect(calls[2].args).toEqual(["send-keys", "-t", "nw-1", "Enter"]);
      // 4. Verification read
      expect(calls[3].args).toEqual([
        "capture-pane", "-t", "nw-1", "-p", "-S", "-3",
      ]);
    });

    it("returns false when message is stuck on screen (verification fails)", () => {
      const { runner } = fakeRunner([
        ok(),                      // set-buffer
        ok(),                      // paste-buffer
        ok(),                      // send-keys Enter
        ok("output\nhello world"), // capture-pane: message still on last line
      ]);
      const adapter = adapterNoRetry(runner);

      expect(adapter.sendMessage("nw-1", "hello world")).toBe(false);
    });

    it("returns false when Enter key send fails", () => {
      const { runner } = fakeRunner([
        ok(),                    // set-buffer
        ok(),                    // paste-buffer
        fail("session gone"),    // send-keys Enter fails
      ]);
      const adapter = adapterNoRetry(runner);

      // Atomic paste path fails at Enter, falls through to fallback send-keys -l
      // Fallback also fails because next call returns ok() but we need to trace
      // Actually: Enter fails → attemptSend returns false (no retry)
      expect(adapter.sendMessage("nw-1", "text")).toBe(false);
    });

    it("assumes success when capture-pane fails (can't verify)", () => {
      const { runner } = fakeRunner([
        ok(),     // set-buffer
        ok(),     // paste-buffer
        ok(),     // send-keys Enter
        fail(),   // capture-pane fails → readScreen returns ""
      ]);
      const adapter = adapterNoRetry(runner);

      // Can't read screen → assumes success
      expect(adapter.sendMessage("nw-1", "hello")).toBe(true);
    });
  });

  // ── sendMessage: fallback send-keys path ───────────────────────────

  describe("sendMessage (fallback send-keys path)", () => {
    it("falls back to send-keys -l when set-buffer fails", () => {
      const { runner, calls } = fakeRunner([
        fail("no buffer support"), // set-buffer fails
        ok(),                      // send-keys -l (fallback)
        ok(),                      // send-keys Enter
        ok("claude> "),            // capture-pane (verify)
      ]);
      const adapter = adapterNoRetry(runner);

      const result = adapter.sendMessage("nw-1", "hello world");

      expect(result).toBe(true);
      expect(calls).toHaveLength(4);

      // Fell back to send-keys -l
      expect(calls[1].args).toEqual([
        "send-keys", "-t", "nw-1", "-l", "hello world",
      ]);
      expect(calls[2].args).toEqual(["send-keys", "-t", "nw-1", "Enter"]);
    });

    it("falls back to send-keys -l when paste-buffer fails", () => {
      const { runner, calls } = fakeRunner([
        ok(),                       // set-buffer OK
        fail("paste not supported"),// paste-buffer fails
        ok(),                       // send-keys -l (fallback)
        ok(),                       // send-keys Enter
        ok("claude> "),             // capture-pane (verify)
      ]);
      const adapter = adapterNoRetry(runner);

      const result = adapter.sendMessage("nw-1", "hello");

      expect(result).toBe(true);

      // Fell back to send-keys -l
      expect(calls[2].args).toEqual([
        "send-keys", "-t", "nw-1", "-l", "hello",
      ]);
    });

    it("returns false when fallback send-keys also fails", () => {
      const { runner } = fakeRunner([
        fail(),                  // set-buffer fails
        fail("session not found"), // send-keys -l fails
      ]);
      const adapter = adapterNoRetry(runner);

      expect(adapter.sendMessage("nw-99", "text")).toBe(false);
    });

    it("returns false when fallback Enter key fails", () => {
      const { runner } = fakeRunner([
        fail(),     // set-buffer fails
        ok(),       // send-keys -l OK
        fail(),     // send-keys Enter fails
      ]);
      const adapter = adapterNoRetry(runner);

      expect(adapter.sendMessage("nw-1", "text")).toBe(false);
    });

    it("preserves special characters via -l flag in fallback", () => {
      const { runner, calls } = fakeRunner([
        fail(),            // set-buffer fails
        ok(),              // send-keys -l
        ok(),              // send-keys Enter
        ok("claude> "),    // capture-pane
      ]);
      const adapter = adapterNoRetry(runner);
      const msg = 'echo "hello $USER" && exit';

      adapter.sendMessage("nw-1", msg);

      // -l ensures literal interpretation
      expect(calls[1].args[4]).toBe(msg);
    });
  });

  // ── sendMessage: retry behaviour ───────────────────────────────────

  describe("sendMessage (retry)", () => {
    it("retries on failed delivery verification", () => {
      const { runner, calls } = fakeRunner([
        // Attempt 1: atomic paste succeeds but verification fails (stuck)
        ok(),                       // set-buffer
        ok(),                       // paste-buffer
        ok(),                       // send-keys Enter
        ok("output\nhello world"),  // capture-pane: stuck

        // Attempt 2: atomic paste succeeds and verification passes
        ok(),                       // set-buffer
        ok(),                       // paste-buffer
        ok(),                       // send-keys Enter
        ok("Thinking...\nclaude> "), // capture-pane: delivered
      ]);
      const adapter = adapterWithRetry(runner, 1);

      const result = adapter.sendMessage("nw-1", "hello world");

      expect(result).toBe(true);
      expect(calls).toHaveLength(8); // 4 calls per attempt × 2 attempts
    });

    it("returns false after exhausting all retries", () => {
      // Every attempt: paste works but message stays stuck on screen
      const stuck = (msg: string): RunResult[] => [
        ok(),              // set-buffer
        ok(),              // paste-buffer
        ok(),              // send-keys Enter
        ok(`out\n${msg}`), // capture-pane: still stuck
      ];

      const { runner } = fakeRunner([
        ...stuck("fail msg"),
        ...stuck("fail msg"),
        ...stuck("fail msg"),
      ]);
      const adapter = adapterWithRetry(runner, 2);

      expect(adapter.sendMessage("nw-1", "fail msg")).toBe(false);
    });

    it("uses exponential backoff between retries", () => {
      const sleepCalls: number[] = [];
      const { runner } = fakeRunner([
        // All attempts fail via set-buffer
        fail(), fail(), // attempt 0: set-buffer fails → fallback send-keys fails
        fail(), fail(), // attempt 1
        fail(), fail(), // attempt 2
      ]);
      const adapter = new TmuxAdapter(runner, {
        sleep: (ms) => sleepCalls.push(ms),
        maxRetries: 2,
        baseDelayMs: 50,
      });

      adapter.sendMessage("nw-1", "text");

      // Only backoff sleeps (not the internal 50ms/100ms sleeps since
      // we're on the early-fail path where set-buffer and send-keys both fail)
      expect(sleepCalls).toEqual([50, 100]); // 50*2^0, 50*2^1
    });

    it("falls back gracefully when verification consistently fails", () => {
      // Every attempt: paste works, Enter works, but can't read screen
      const { runner } = fakeRunner([
        ok(),    // set-buffer
        ok(),    // paste-buffer
        ok(),    // send-keys Enter
        fail(),  // capture-pane fails → assumes success
      ]);
      const adapter = adapterWithRetry(runner, 2);

      // First attempt assumes success because readScreen returns ""
      expect(adapter.sendMessage("nw-1", "hello")).toBe(true);
    });
  });

  // ── readScreen tests ───────────────────────────────────────────────

  describe("readScreen", () => {
    it("calls tmux capture-pane with correct args", () => {
      const { runner, calls } = fakeRunner([
        ok("line1\nline2\nline3"),
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
      const { runner, calls } = fakeRunner([ok("content")]);
      const adapter = new TmuxAdapter(runner);

      adapter.readScreen("nw-1");

      expect(calls[0].args).toEqual(["capture-pane", "-t", "nw-1", "-p"]);
    });

    it("returns empty string when capture-pane fails", () => {
      const { runner } = fakeRunner([fail("no session")]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.readScreen("nw-1")).toBe("");
    });
  });

  // ── listWorkspaces tests ───────────────────────────────────────────

  describe("listWorkspaces", () => {
    it("parses tmux session list and filters to nw- sessions", () => {
      const { runner } = fakeRunner([
        ok("nw-1\nuser-session\nnw-2\nwork"),
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.listWorkspaces()).toBe("nw-1\nnw-2");
    });

    it("calls tmux list-sessions with format flag", () => {
      const { runner, calls } = fakeRunner([ok("nw-1")]);
      const adapter = new TmuxAdapter(runner);

      adapter.listWorkspaces();

      expect(calls[0].args).toEqual([
        "list-sessions",
        "-F",
        "#{session_name}",
      ]);
    });

    it("returns empty string when tmux is not running", () => {
      const { runner } = fakeRunner([fail("no server running")]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.listWorkspaces()).toBe("");
    });

    it("returns empty string when no nw- sessions exist", () => {
      const { runner } = fakeRunner([ok("my-session\nwork")]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.listWorkspaces()).toBe("");
    });
  });

  // ── splitPane tests ────────────────────────────────────────────────

  describe("splitPane", () => {
    it("uses split-window -P -F to get the new pane ID directly", () => {
      const { runner, calls } = fakeRunner([
        { stdout: "%5\n", stderr: "", exitCode: 0 }, // split-window -P -F
      ]);
      const adapter = new TmuxAdapter(runner);

      const ref = adapter.splitPane("ninthwave status --watch");

      expect(ref).toBe("%5");
      // Only one shell call — no separate display-message
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual([
        "split-window",
        "-P",
        "-F",
        "#{pane_id}",
        "ninthwave status --watch",
      ]);
    });

    it("returns null when split-window fails", () => {
      const { runner } = fakeRunner([fail("no session")]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.splitPane("cmd")).toBeNull();
    });

    it("returns fallback pane ref when -P output is empty", () => {
      const { runner } = fakeRunner([
        { stdout: "", stderr: "", exitCode: 0 }, // split-window succeeds but empty stdout
      ]);
      const adapter = new TmuxAdapter(runner);

      const ref = adapter.splitPane("cmd");
      // Falls back to counter-based name
      expect(ref).toMatch(/^nw-pane-/);
    });

    it("trims whitespace from pane ID output", () => {
      const { runner } = fakeRunner([
        { stdout: "  %12  \n", stderr: "", exitCode: 0 },
      ]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.splitPane("cmd")).toBe("%12");
    });
  });

  // ── closeWorkspace tests ───────────────────────────────────────────

  describe("closeWorkspace", () => {
    it("calls tmux kill-session with correct session name", () => {
      const { runner, calls } = fakeRunner([ok()]);
      const adapter = new TmuxAdapter(runner);

      const result = adapter.closeWorkspace("nw-1");

      expect(result).toBe(true);
      expect(calls[0].args).toEqual(["kill-session", "-t", "nw-1"]);
    });

    it("returns false when session does not exist", () => {
      const { runner } = fakeRunner([fail("session not found: nw-99")]);
      const adapter = new TmuxAdapter(runner);

      expect(adapter.closeWorkspace("nw-99")).toBe(false);
    });
  });

  // ── Interface compliance ───────────────────────────────────────────

  describe("Multiplexer interface compliance", () => {
    it("implements all Multiplexer methods", () => {
      const { runner } = fakeRunner();
      const adapter = new TmuxAdapter(runner);

      expect(typeof adapter.isAvailable).toBe("function");
      expect(typeof adapter.launchWorkspace).toBe("function");
      expect(typeof adapter.splitPane).toBe("function");
      expect(typeof adapter.sendMessage).toBe("function");
      expect(typeof adapter.readScreen).toBe("function");
      expect(typeof adapter.listWorkspaces).toBe("function");
      expect(typeof adapter.closeWorkspace).toBe("function");
    });
  });
});
