// cmux set-status and set-progress implementations.
// Separated from cmux.ts so tests can import without vi.mock leaks
// (same pattern as send-message.ts).

import type { RunResult } from "./types.ts";

/** Shell runner signature for dependency injection. */
export type ShellRunner = (cmd: string, args: string[]) => RunResult;

/**
 * Set status text, icon, and color for a cmux workspace.
 * Best-effort — returns true on success, false on failure.
 *
 * Wraps: `cmux set-status <key> <text> --icon <icon> --color <color> --workspace <ref>`
 */
export function setStatusImpl(
  ref: string,
  key: string,
  text: string,
  icon: string,
  color: string,
  runner: ShellRunner,
): boolean {
  const result = runner("cmux", [
    "set-status",
    key,
    text,
    "--icon",
    icon,
    "--color",
    color,
    "--workspace",
    ref,
  ]);
  return result.exitCode === 0;
}

/**
 * Set progress value (0–100) and optional label for a cmux workspace.
 * Best-effort — returns true on success, false on failure.
 *
 * Wraps: `cmux set-progress <value> [--label <label>] --workspace <ref>`
 */
export function setProgressImpl(
  ref: string,
  value: number,
  label: string | undefined,
  runner: ShellRunner,
): boolean {
  const args = ["set-progress", String(value), "--workspace", ref];
  if (label !== undefined) {
    args.splice(2, 0, "--label", label);
  }
  const result = runner("cmux", args);
  return result.exitCode === 0;
}
