// Tests for cmux splitPaneImpl — verifies correct cmux CLI commands and ref parsing.
// Uses dependency injection (injectable runner) per project conventions.

import { describe, it, expect, vi } from "vitest";
import { splitPaneImpl, type ShellRunner } from "../core/cmux.ts";
import type { RunResult } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a successful RunResult. */
function ok(stdout = ""): RunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

/** Build a failed RunResult. */
function fail(stderr = "error"): RunResult {
  return { stdout: "", stderr, exitCode: 1 };
}

/**
 * Create a tracking runner that dispatches on cmux subcommand.
 * Records all calls for assertion.
 */
function trackingRunner(
  handlers: Record<string, RunResult | (() => RunResult)>,
) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: ShellRunner = (cmd, args) => {
    calls.push({ cmd, args });
    const subcommand = args[0] ?? "";
    const handler = handlers[subcommand];
    if (!handler) return ok();
    return typeof handler === "function" ? handler() : handler;
  };
  return { runner, calls };
}

// ── splitPaneImpl tests ──────────────────────────────────────────────

describe("splitPaneImpl", () => {
  it("calls 'cmux new-split right' (not 'split-pane')", () => {
    const { runner, calls } = trackingRunner({
      "new-split": ok("surface:3"),
      send: ok(),
    });

    splitPaneImpl("ninthwave status --watch", runner);

    expect(calls[0].cmd).toBe("cmux");
    expect(calls[0].args[0]).toBe("new-split");
    expect(calls[0].args[1]).toBe("right");
    // Verify it does NOT use split-pane
    const subcommands = calls.map((c) => c.args[0]);
    expect(subcommands).not.toContain("split-pane");
  });

  it("returns surface ref on success", () => {
    const { runner } = trackingRunner({
      "new-split": ok("surface:3"),
      send: ok(),
    });

    const ref = splitPaneImpl("ninthwave status --watch", runner);

    expect(ref).toBe("surface:3");
  });

  it("returns pane ref when cmux outputs pane:N format", () => {
    const { runner } = trackingRunner({
      "new-split": ok("pane:7"),
      send: ok(),
    });

    const ref = splitPaneImpl("echo hello", runner);

    expect(ref).toBe("pane:7");
  });

  it("returns null when new-split fails", () => {
    const { runner } = trackingRunner({
      "new-split": fail("no workspace"),
    });

    const ref = splitPaneImpl("ninthwave status --watch", runner);

    expect(ref).toBeNull();
  });

  it("returns null when new-split output has no recognizable ref", () => {
    const { runner } = trackingRunner({
      "new-split": ok("OK"),
    });

    const ref = splitPaneImpl("ninthwave status --watch", runner);

    expect(ref).toBeNull();
  });

  it("sends command to the new surface via 'cmux send'", () => {
    const { runner, calls } = trackingRunner({
      "new-split": ok("surface:5"),
      send: ok(),
    });

    splitPaneImpl("ninthwave status --watch", runner);

    // Second call should be cmux send
    expect(calls[1].cmd).toBe("cmux");
    expect(calls[1].args).toEqual([
      "send",
      "--surface",
      "surface:5",
      "ninthwave status --watch\n",
    ]);
  });

  it("appends newline to command for Enter key", () => {
    const { runner, calls } = trackingRunner({
      "new-split": ok("surface:1"),
      send: ok(),
    });

    splitPaneImpl("my-command --flag", runner);

    const sendArgs = calls[1].args;
    const text = sendArgs[sendArgs.length - 1];
    expect(text).toBe("my-command --flag\n");
  });

  it("returns ref even when send fails (split succeeded)", () => {
    const { runner } = trackingRunner({
      "new-split": ok("surface:8"),
      send: fail("surface not ready"),
    });

    const ref = splitPaneImpl("ninthwave status --watch", runner);

    // split succeeded so we return the ref even if send failed
    expect(ref).toBe("surface:8");
  });

  it("extracts ref from multi-line output", () => {
    const { runner } = trackingRunner({
      "new-split": ok("Created split\nsurface:12\nDone"),
      send: ok(),
    });

    const ref = splitPaneImpl("echo hi", runner);

    expect(ref).toBe("surface:12");
  });

  it("makes exactly 2 cmux calls on success (new-split + send)", () => {
    const { runner, calls } = trackingRunner({
      "new-split": ok("surface:1"),
      send: ok(),
    });

    splitPaneImpl("cmd", runner);

    expect(calls).toHaveLength(2);
  });

  it("makes only 1 cmux call when new-split fails", () => {
    const { runner, calls } = trackingRunner({
      "new-split": fail("no workspace"),
    });

    splitPaneImpl("cmd", runner);

    expect(calls).toHaveLength(1);
  });
});
