// Tests for cmux helpers that remain after send-message removal.
// Uses dependency injection via splitPaneImpl's runner argument.

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
 * Create a runner that dispatches on cmux subcommand.
 * Each key maps a subcommand to a result or function.
 */
function dispatchRunner(
  handlers: Record<string, RunResult | (() => RunResult)>,
): ReturnType<typeof vi.fn<ShellRunner>> {
  return vi.fn((_cmd: string, args: string[]): RunResult => {
    const subcommand = args[0] ?? "";
    const handler = handlers[subcommand];
    if (!handler) return ok();
    return typeof handler === "function" ? handler() : handler;
  });
}

describe("splitPaneImpl", () => {
  it("creates a split and sends the command with a trailing newline", () => {
    const runner = dispatchRunner({
      "new-split": ok("surface:3"),
      send: ok(),
    });

    const result = splitPaneImpl("ninthwave status --watch", runner);

    expect(result).toBe("surface:3");
    expect(runner.mock.calls).toEqual([
      ["cmux", ["new-split", "right"]],
      ["cmux", ["send", "--surface", "surface:3", "ninthwave status --watch\n"]],
    ]);
  });

  it("returns null when cmux cannot create a split", () => {
    const runner = dispatchRunner({
      "new-split": fail("no workspace"),
    });

    expect(splitPaneImpl("ninthwave status --watch", runner)).toBeNull();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("returns the split ref even when sending the command fails", () => {
    const runner = dispatchRunner({
      "new-split": ok("pane:7"),
      send: fail("surface not ready"),
    });

    expect(splitPaneImpl("echo hello", runner)).toBe("pane:7");
  });
});
