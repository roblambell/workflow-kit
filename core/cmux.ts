import { run } from "./shell.ts";

/** Check if the cmux binary is available. */
export function isAvailable(): boolean {
  const result = run("cmux", ["--version"]);
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
  const result = run("cmux", [
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

/** Send a message/text to a cmux workspace. Returns true on success. */
export function sendMessage(
  workspaceRef: string,
  message: string,
): boolean {
  const result = run("cmux", [
    "send",
    "--workspace",
    workspaceRef,
    message,
  ]);
  return result.exitCode === 0;
}

/** List all cmux workspaces. Returns the raw output string. */
export function listWorkspaces(): string {
  const result = run("cmux", ["list-workspaces"]);
  if (result.exitCode !== 0) return "";
  return result.stdout;
}

/** Close a cmux workspace. Returns true on success. */
export function closeWorkspace(workspaceRef: string): boolean {
  const result = run("cmux", [
    "close-workspace",
    "--workspace",
    workspaceRef,
  ]);
  return result.exitCode === 0;
}
