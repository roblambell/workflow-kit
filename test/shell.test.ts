// Tests for core/shell.ts — run() with timeout support.
// Uses real Bun.spawnSync (no mocking needed for shell integration tests).

import { describe, it, expect } from "vitest";
import { run, GIT_TIMEOUT, GH_TIMEOUT } from "../core/shell.ts";

describe("run()", () => {
  // ── Backward compatibility ──────────────────────────────────────────

  it("runs a command without timeout (backward compatible)", () => {
    const result = run("echo", ["hello"]);
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeUndefined();
  });

  it("passes cwd option correctly", () => {
    const result = run("pwd", [], { cwd: "/tmp" });
    // On macOS, /tmp is a symlink to /private/tmp
    expect(result.stdout).toMatch(/\/tmp$/);
    expect(result.exitCode).toBe(0);
  });

  it("passes input via stdin", () => {
    const result = run("cat", [], { input: "stdin data" });
    expect(result.stdout).toBe("stdin data");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr and non-zero exit code", () => {
    const result = run("ls", ["nonexistent-path-that-does-not-exist-12345"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toBe("");
    expect(result.timedOut).toBeUndefined();
  });

  // ── Whitespace trimming ─────────────────────────────────────────────

  it("trims leading and trailing whitespace from stdout", () => {
    // printf outputs exact bytes with no trailing newline of its own,
    // so we can control whitespace precisely
    const result = run("printf", ["  hello  \\n"]);
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("trims leading and trailing whitespace from stderr", () => {
    // Redirect a padded string to stderr via sh -c
    const result = run("sh", ["-c", "printf '  oops  \\n' >&2; exit 1"]);
    expect(result.stderr).toBe("oops");
    expect(result.exitCode).toBe(1);
  });

  it("trims multiline stdout preserving inner content", () => {
    const result = run("printf", ["\\n  line1\\n  line2\\n\\n"]);
    expect(result.stdout).toBe("line1\n  line2");
  });

  // ── Timeout behavior ────────────────────────────────────────────────

  it("kills process and returns timeout error when timeout exceeded", () => {
    // sleep 10 with a 500ms timeout should always time out
    const result = run("sleep", ["10"], { timeout: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("TIMEOUT");
    expect(result.stderr).toContain("500ms");
    expect(result.stderr).toContain("sleep");
  });

  it("does not time out when command completes within timeout", () => {
    const result = run("echo", ["fast"], { timeout: 10_000 });
    expect(result.timedOut).toBeUndefined();
    expect(result.stdout).toBe("fast");
    expect(result.exitCode).toBe(0);
  });

  it("timeout error message is distinguishable from normal errors", () => {
    // Normal failure
    const normalFail = run("false", []);
    expect(normalFail.exitCode).not.toBe(0);
    expect(normalFail.timedOut).toBeUndefined();
    expect(normalFail.stderr).not.toContain("TIMEOUT");

    // Timeout failure
    const timeoutFail = run("sleep", ["10"], { timeout: 500 });
    expect(timeoutFail.timedOut).toBe(true);
    expect(timeoutFail.stderr).toContain("TIMEOUT");
  });

  // ── Edge case: very short timeout ───────────────────────────────────

  it("very short timeout (1ms) does not cause flaky behavior", () => {
    // With 1ms timeout, sleep should always time out — but the key test
    // is that it doesn't throw or crash, and returns a valid RunResult.
    const result = run("sleep", ["1"], { timeout: 1 });
    // It should either time out or (very rarely) complete
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    // If it timed out, verify the shape
    if (result.timedOut) {
      expect(result.stderr).toContain("TIMEOUT");
      expect(result.exitCode).not.toBe(0);
    }
  });

  // ── Timeout constants ───────────────────────────────────────────────

  it("exports recommended timeout constants", () => {
    expect(GIT_TIMEOUT).toBe(30_000);
    expect(GH_TIMEOUT).toBe(60_000);
  });
});
