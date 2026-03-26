// Tests for ZellijAdapter — uses dependency-injected shell runner (no vi.mock).

import { describe, it, expect } from "vitest";
import { ZellijAdapter } from "../core/mux.ts";
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

/** Create a ZellijAdapter with no retries for basic tests. */
function adapterNoRetry(runner: (cmd: string, args: string[]) => RunResult) {
  return new ZellijAdapter(runner, { sleep: () => {}, maxRetries: 0 });
}

/** Create a ZellijAdapter with custom retry options. */
function adapterWithRetry(
  runner: (cmd: string, args: string[]) => RunResult,
  maxRetries: number,
) {
  return new ZellijAdapter(runner, {
    sleep: () => {},
    maxRetries,
    baseDelayMs: 100,
  });
}

describe("ZellijAdapter", () => {
  // ── isAvailable ─────────────────────────────────────────────────

  describe("isAvailable", () => {
    it("returns true when zellij --version succeeds and ZELLIJ_SESSION_NAME is set", () => {
      const { runner } = fakeRunner([ok("zellij 0.40.1")]);
      const adapter = new ZellijAdapter(runner, { env: { ZELLIJ_SESSION_NAME: "my-session" } });

      expect(adapter.isAvailable()).toBe(true);
    });

    it("returns false when zellij is not installed", () => {
      const { runner } = fakeRunner([fail("command not found: zellij")]);
      const adapter = new ZellijAdapter(runner, { env: {} });

      expect(adapter.isAvailable()).toBe(false);
    });

    it("returns false when zellij binary exists but no active session", () => {
      const { runner } = fakeRunner([ok("zellij 0.40.1")]);
      const adapter = new ZellijAdapter(runner, { env: {} });

      expect(adapter.isAvailable()).toBe(false);
    });

    it("calls zellij with --version flag", () => {
      const { runner, calls } = fakeRunner([ok("zellij 0.40.1")]);
      const adapter = new ZellijAdapter(runner, { env: { ZELLIJ_SESSION_NAME: "my-session" } });
      adapter.isAvailable();

      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("zellij");
      expect(calls[0].args).toEqual(["--version"]);
    });
  });

  // ── launchWorkspace ─────────────────────────────────────────────

  describe("launchWorkspace", () => {
    it("returns tab name on success", () => {
      const { runner } = fakeRunner([ok(), ok()]); // new-tab, write-chars
      const adapter = new ZellijAdapter(runner);
      const result = adapter.launchWorkspace("/tmp/project", "claude --name test");
      expect(result).toBe("nw-1");
    });

    it("generates incrementing nw-N tab names", () => {
      const { runner } = fakeRunner(); // all succeed
      const adapter = new ZellijAdapter(runner);

      const first = adapter.launchWorkspace("/tmp/a", "cmd1");
      const second = adapter.launchWorkspace("/tmp/b", "cmd2");
      const third = adapter.launchWorkspace("/tmp/c", "cmd3");

      expect(first).toBe("nw-1");
      expect(second).toBe("nw-2");
      expect(third).toBe("nw-3");
    });

    it("returns null when new-tab fails", () => {
      const { runner } = fakeRunner([fail("not in a zellij session")]);
      const adapter = new ZellijAdapter(runner);
      const result = adapter.launchWorkspace("/tmp/project", "claude");
      expect(result).toBeNull();
    });

    it("passes correct args to zellij action new-tab", () => {
      const { runner, calls } = fakeRunner([ok(), ok()]);
      const adapter = new ZellijAdapter(runner);
      adapter.launchWorkspace("/home/user/code", "claude --resume");

      expect(calls[0].cmd).toBe("zellij");
      expect(calls[0].args).toEqual([
        "action",
        "new-tab",
        "--name",
        "nw-1",
        "--cwd",
        "/home/user/code",
      ]);
    });

    it("sends command via write-chars after creating tab", () => {
      const { runner, calls } = fakeRunner([ok(), ok()]);
      const adapter = new ZellijAdapter(runner);
      adapter.launchWorkspace("/tmp/project", "claude --name test");

      expect(calls).toHaveLength(2);
      expect(calls[1].cmd).toBe("zellij");
      expect(calls[1].args).toEqual([
        "action",
        "write-chars",
        "claude --name test\n",
      ]);
    });

    it("includes TODO ID in tab name when provided", () => {
      const { runner } = fakeRunner(); // all succeed
      const adapter = new ZellijAdapter(runner);
      const result = adapter.launchWorkspace("/tmp/project", "claude", "H-WRK-1");
      expect(result).toBe("nw-H-WRK-1-1");
    });

    it("generates incrementing names with TODO ID", () => {
      const { runner } = fakeRunner(); // all succeed
      const adapter = new ZellijAdapter(runner);

      const first = adapter.launchWorkspace("/tmp/a", "cmd1", "H-WRK-1");
      const second = adapter.launchWorkspace("/tmp/b", "cmd2", "M-CI-2");

      expect(first).toBe("nw-H-WRK-1-1");
      expect(second).toBe("nw-M-CI-2-2");
    });

    it("still returns tab name when write-chars fails", () => {
      const { runner } = fakeRunner([
        ok(),  // new-tab succeeds
        fail("write-chars error"), // write-chars fails
      ]);
      const adapter = new ZellijAdapter(runner);
      const result = adapter.launchWorkspace("/tmp/project", "claude");
      // Tab was created even though command injection failed
      expect(result).toBe("nw-1");
    });
  });

  // ── splitPane ─────────────────────────────────────────────────

  describe("splitPane", () => {
    it("returns a pane ref on success", () => {
      const { runner } = fakeRunner([ok(), ok()]); // new-pane, write-chars
      const adapter = new ZellijAdapter(runner);
      const result = adapter.splitPane("ninthwave status --watch");
      expect(result).toMatch(/^nw-pane-\d+$/);
    });

    it("calls zellij action new-pane", () => {
      const { runner, calls } = fakeRunner([ok(), ok()]);
      const adapter = new ZellijAdapter(runner);
      adapter.splitPane("echo hello");

      expect(calls[0].cmd).toBe("zellij");
      expect(calls[0].args).toEqual(["action", "new-pane"]);
    });

    it("sends command via write-chars after creating pane", () => {
      const { runner, calls } = fakeRunner([ok(), ok()]);
      const adapter = new ZellijAdapter(runner);
      adapter.splitPane("echo hello");

      expect(calls[1].cmd).toBe("zellij");
      expect(calls[1].args).toEqual([
        "action",
        "write-chars",
        "echo hello\n",
      ]);
    });

    it("returns null when new-pane fails", () => {
      const { runner } = fakeRunner([fail("no session")]);
      const adapter = new ZellijAdapter(runner);
      expect(adapter.splitPane("cmd")).toBeNull();
    });
  });

  // ── readScreen ──────────────────────────────────────────────────

  describe("readScreen", () => {
    it("focuses tab, dumps screen, reads temp file, cleans up", () => {
      const { runner, calls } = fakeRunner([
        ok(),                      // go-to-tab-name
        ok(),                      // dump-screen
        ok("line1\nline2\nline3"), // cat
        ok(),                      // rm
      ]);
      const adapter = new ZellijAdapter(runner);
      const result = adapter.readScreen("nw-1");

      expect(result).toBe("line1\nline2\nline3");
      expect(calls[0].args).toEqual(["action", "go-to-tab-name", "nw-1"]);
      expect(calls[1].args[0]).toBe("action");
      expect(calls[1].args[1]).toBe("dump-screen");
      expect(calls[2].cmd).toBe("cat");
      expect(calls[3].cmd).toBe("rm");
    });

    it("returns last N lines when lines parameter is provided", () => {
      const { runner } = fakeRunner([
        ok(),                                  // go-to-tab-name
        ok(),                                  // dump-screen
        ok("line1\nline2\nline3\nline4\nline5"), // cat
        ok(),                                  // rm
      ]);
      const adapter = new ZellijAdapter(runner);
      const result = adapter.readScreen("nw-1", 3);

      expect(result).toBe("line3\nline4\nline5");
    });

    it("returns empty string when dump-screen fails", () => {
      const { runner } = fakeRunner([
        ok(),            // go-to-tab-name
        fail("no pane"), // dump-screen fails
      ]);
      const adapter = new ZellijAdapter(runner);
      expect(adapter.readScreen("nw-1")).toBe("");
    });

    it("returns empty string when cat fails", () => {
      const { runner } = fakeRunner([
        ok(),     // go-to-tab-name
        ok(),     // dump-screen
        fail(),   // cat fails
        ok(),     // rm
      ]);
      const adapter = new ZellijAdapter(runner);
      expect(adapter.readScreen("nw-1")).toBe("");
    });
  });

  // ── listWorkspaces ──────────────────────────────────────────────

  describe("listWorkspaces", () => {
    it("returns only nw- prefixed sessions", () => {
      const { runner } = fakeRunner([
        ok("nw-1\nuser-session\nnw-2\nmy-project\nnw-3"),
      ]);
      const adapter = new ZellijAdapter(runner);
      expect(adapter.listWorkspaces()).toBe("nw-1\nnw-2\nnw-3");
    });

    it("returns empty string when list-sessions fails", () => {
      const { runner } = fakeRunner([fail("no server running")]);
      const adapter = new ZellijAdapter(runner);
      expect(adapter.listWorkspaces()).toBe("");
    });

    it("filters out all non-nw- sessions", () => {
      const { runner } = fakeRunner([ok("personal\nwork\ndefault")]);
      const adapter = new ZellijAdapter(runner);
      expect(adapter.listWorkspaces()).toBe("");
    });

    it("handles empty session list", () => {
      const { runner } = fakeRunner([ok("")]);
      const adapter = new ZellijAdapter(runner);
      expect(adapter.listWorkspaces()).toBe("");
    });

    it("calls zellij list-sessions", () => {
      const { runner, calls } = fakeRunner([ok("nw-1")]);
      const adapter = new ZellijAdapter(runner);
      adapter.listWorkspaces();

      expect(calls[0].cmd).toBe("zellij");
      expect(calls[0].args).toEqual(["list-sessions"]);
    });
  });

  // ── closeWorkspace ──────────────────────────────────────────────

  describe("closeWorkspace", () => {
    it("focuses tab and closes it on success", () => {
      const { runner, calls } = fakeRunner([ok(), ok()]); // go-to-tab-name, close-tab
      const adapter = new ZellijAdapter(runner);
      expect(adapter.closeWorkspace("nw-1")).toBe(true);

      expect(calls[0].args).toEqual(["action", "go-to-tab-name", "nw-1"]);
      expect(calls[1].args).toEqual(["action", "close-tab"]);
    });

    it("returns false when tab focus fails — never calls delete-session", () => {
      const { runner, calls } = fakeRunner([
        fail("tab not found"), // go-to-tab-name fails
      ]);
      const adapter = new ZellijAdapter(runner);
      expect(adapter.closeWorkspace("nw-1")).toBe(false);

      // Must NOT issue delete-session (destructive — would kill the user's session)
      const deleteSessionCalls = calls.filter(
        (c) => c.cmd === "zellij" && c.args[0] === "delete-session",
      );
      expect(deleteSessionCalls).toHaveLength(0);
    });

    it("returns false when close-tab fails after successful focus", () => {
      const { runner } = fakeRunner([
        ok(),         // go-to-tab-name succeeds
        fail("error"), // close-tab fails
      ]);
      const adapter = new ZellijAdapter(runner);
      expect(adapter.closeWorkspace("nw-1")).toBe(false);
    });
  });

  // ── sendMessage ─────────────────────────────────────────────────

  describe("sendMessage", () => {
    it("focuses tab, writes chars, sends Enter, and verifies", () => {
      const { runner, calls } = fakeRunner([
        ok(),                       // go-to-tab-name (focus)
        ok(),                       // write-chars
        ok(),                       // write 10 (Enter)
        // readScreen verification:
        ok(),                       // go-to-tab-name
        ok(),                       // dump-screen
        ok("Thinking...\nclaude> "), // cat (verify: no trace)
        ok(),                       // rm
      ]);
      const adapter = adapterNoRetry(runner);

      const result = adapter.sendMessage("nw-1", "hello world");

      expect(result).toBe(true);
      // Focus
      expect(calls[0].args).toEqual(["action", "go-to-tab-name", "nw-1"]);
      // Write chars
      expect(calls[1].args).toEqual(["action", "write-chars", "hello world"]);
      // Enter
      expect(calls[2].args).toEqual(["action", "write", "10"]);
    });

    it("returns false when tab focus fails", () => {
      const { runner } = fakeRunner([
        fail("tab not found"), // go-to-tab-name fails
      ]);
      const adapter = adapterNoRetry(runner);
      expect(adapter.sendMessage("nw-99", "hello")).toBe(false);
    });

    it("returns false when write-chars fails", () => {
      const { runner } = fakeRunner([
        ok(),            // go-to-tab-name
        fail("error"),   // write-chars fails
      ]);
      const adapter = adapterNoRetry(runner);
      expect(adapter.sendMessage("nw-1", "hello")).toBe(false);
    });

    it("returns false when Enter key fails", () => {
      const { runner } = fakeRunner([
        ok(),          // go-to-tab-name
        ok(),          // write-chars
        fail("error"), // write 10 fails
      ]);
      const adapter = adapterNoRetry(runner);
      expect(adapter.sendMessage("nw-1", "hello")).toBe(false);
    });

    it("returns false when message is stuck on screen (verification fails)", () => {
      const { runner } = fakeRunner([
        ok(),                      // go-to-tab-name
        ok(),                      // write-chars
        ok(),                      // write 10 (Enter)
        // readScreen verification:
        ok(),                      // go-to-tab-name
        ok(),                      // dump-screen
        ok("output\nhello world"), // cat: message still on last line
        ok(),                      // rm
      ]);
      const adapter = adapterNoRetry(runner);
      expect(adapter.sendMessage("nw-1", "hello world")).toBe(false);
    });

    it("assumes success when screen can't be read", () => {
      const { runner } = fakeRunner([
        ok(),     // go-to-tab-name
        ok(),     // write-chars
        ok(),     // write 10 (Enter)
        // readScreen verification:
        ok(),     // go-to-tab-name
        fail(),   // dump-screen fails → readScreen returns ""
      ]);
      const adapter = adapterNoRetry(runner);
      expect(adapter.sendMessage("nw-1", "hello")).toBe(true);
    });
  });

  // ── sendMessage: retry behaviour ───────────────────────────────────

  describe("sendMessage (retry)", () => {
    it("retries on failed delivery verification", () => {
      const { runner, calls } = fakeRunner([
        // Attempt 1: sends OK but verification fails (stuck)
        ok(), ok(), ok(),                 // focus, write-chars, write 10
        ok(), ok(), ok("out\nhello world"), ok(), // readScreen: stuck

        // Attempt 2: sends OK and verification passes
        ok(), ok(), ok(),                       // focus, write-chars, write 10
        ok(), ok(), ok("Thinking...\nclaude> "), ok(), // readScreen: delivered
      ]);
      const adapter = adapterWithRetry(runner, 1);

      const result = adapter.sendMessage("nw-1", "hello world");

      expect(result).toBe(true);
      // Two full attempts
      expect(calls.length).toBeGreaterThan(7);
    });

    it("returns false after exhausting all retries", () => {
      // Every attempt: send works but message stays stuck on screen
      const stuckAttempt = (): RunResult[] => [
        ok(), ok(), ok(),                     // focus, write-chars, write 10
        ok(), ok(), ok("out\nfail msg"), ok(), // readScreen: stuck
      ];

      const { runner } = fakeRunner([
        ...stuckAttempt(),
        ...stuckAttempt(),
        ...stuckAttempt(),
      ]);
      const adapter = adapterWithRetry(runner, 2);

      expect(adapter.sendMessage("nw-1", "fail msg")).toBe(false);
    });

    it("uses exponential backoff between retries", () => {
      const sleepCalls: number[] = [];
      const { runner } = fakeRunner([
        // All attempts fail at focus
        fail(), // attempt 0: focus fails
        fail(), // attempt 1: focus fails
        fail(), // attempt 2: focus fails
      ]);
      const adapter = new ZellijAdapter(runner, {
        sleep: (ms) => sleepCalls.push(ms),
        maxRetries: 2,
        baseDelayMs: 50,
      });

      adapter.sendMessage("nw-1", "text");

      // Only backoff sleeps (no internal 100ms sleeps since focus fails early)
      expect(sleepCalls).toEqual([50, 100]); // 50*2^0, 50*2^1
    });
  });

  // ── Interface compliance ───────────────────────────────────────────

  describe("Multiplexer interface compliance", () => {
    it("implements all Multiplexer methods", () => {
      const { runner } = fakeRunner();
      const adapter = new ZellijAdapter(runner);

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
