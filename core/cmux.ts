import { run } from "./shell.ts";
import { setStatusImpl, setProgressImpl } from "./cmux-status.ts";
import { resolveCmuxBinary } from "./cmux-resolve.ts";
import type { RunResult } from "./types.ts";

/** Shell runner signature for dependency injection. */
export type ShellRunner = (cmd: string, args: string[]) => RunResult;

/** Resolved cmux binary path (cached at module load). */
let _cmuxBin: string | null | undefined;
function cmuxBin(): string {
  if (_cmuxBin === undefined) _cmuxBin = resolveCmuxBinary();
  return _cmuxBin ?? "cmux";
}

/** Check if the cmux binary is available. */
export function isAvailable(): boolean {
  const result = run(cmuxBin(), ["version"]);
  return result.exitCode === 0;
}

/**
 * Launch a new cmux workspace.
 * Returns the workspace ref (e.g., "workspace:1") or null on failure.
 */
export function launchWorkspace(
  cwd: string,
  command: string,
): string | null {
  const result = run(cmuxBin(), [
    "new-workspace",
    "--cwd",
    cwd,
    "--command",
    command,
  ]);
  if (result.exitCode !== 0) return null;
  const match = result.stdout.match(/workspace:\d+/);
  return match ? match[0] : null;
}

/** Read screen content from a cmux workspace. Returns raw text or "" on failure. */
export function readScreen(
  workspaceRef: string,
  lines: number = 10,
): string {
  const result = run(cmuxBin(), [
    "read-screen",
    "--workspace",
    workspaceRef,
    "--lines",
    String(lines),
  ]);
  if (result.exitCode !== 0) return "";
  return result.stdout;
}

/** List all cmux workspaces. Returns the raw output string. */
export function listWorkspaces(): string {
  const result = run(cmuxBin(), ["list-workspaces"]);
  if (result.exitCode !== 0) return "";
  return result.stdout;
}

/** Close a cmux workspace. Returns true on success. */
export function closeWorkspace(workspaceRef: string): boolean {
  const result = run(cmuxBin(), [
    "close-workspace",
    "--workspace",
    workspaceRef,
  ]);
  return result.exitCode === 0;
}

/**
 * Set status text, icon, and color for a cmux workspace.
 * Best-effort -- returns true on success, false on failure.
 *
 * Wraps: `cmux set-status <key> <text> --icon <icon> --color <color> --workspace <ref>`
 */
export function setStatus(
  ref: string,
  key: string,
  text: string,
  icon: string,
  color: string,
): boolean {
  return setStatusImpl(ref, key, text, icon, color, (_cmd, args) => run(cmuxBin(), args));
}

/**
 * Set progress value (0.0–1.0) and optional label for a cmux workspace.
 * Best-effort -- returns true on success, false on failure.
 *
 * Wraps: `cmux set-progress <value> [--label <label>] --workspace <ref>`
 */
export function setProgress(
  ref: string,
  value: number,
  label?: string,
): boolean {
  return setProgressImpl(ref, value, label, (_cmd, args) => run(cmuxBin(), args));
}

/**
 * Split a pane in the current cmux workspace and run a command in it.
 * Uses the CMUX_WORKSPACE_ID env var to target the current workspace.
 * Returns the surface ref (e.g., "surface:3") or null on failure.
 *
 * Two-step process: `cmux new-split right` creates the split, then
 * `cmux send` delivers the command text (with trailing `\n` for Enter).
 */
export function splitPane(command: string): string | null {
  return splitPaneImpl(command, (_cmd, args) => run(cmuxBin(), args));
}

/**
 * Injectable implementation of splitPane -- testable without vi.mock.
 * @internal Exported for testing only.
 */
export function splitPaneImpl(
  command: string,
  runner: ShellRunner,
): string | null {
  const result = runner("cmux", ["new-split", "right"]);
  if (result.exitCode !== 0) return null;

  // new-split returns a ref -- surface:N, pane:N, or similar
  const match = result.stdout.match(/(?:surface|pane):\d+/);
  const ref = match ? match[0] : null;
  if (!ref) return null;

  // Send the command to the new surface (cmux send interprets \n as Enter)
  const sendResult = runner("cmux", [
    "send",
    "--surface",
    ref,
    `${command}\n`,
  ]);
  if (sendResult.exitCode !== 0) return ref; // split succeeded, send failed -- return ref anyway

  return ref;
}
