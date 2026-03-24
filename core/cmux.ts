import { run } from "./shell.ts";
import { sendMessageImpl } from "./send-message.ts";
export type { SendMessageDeps, Runner, Sleeper } from "./send-message.ts";
export { verifyDelivery } from "./send-message.ts";

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

/**
 * Send a message to a cmux workspace. Returns true on success.
 *
 * Uses paste-then-submit to avoid the race condition where `cmux send`
 * types text character-by-character and fires Return before the text is
 * fully entered. Verifies delivery and retries with exponential backoff.
 */
export function sendMessage(
  workspaceRef: string,
  message: string,
): boolean {
  return sendMessageImpl(workspaceRef, message, {
    runner: (cmd, args) => run(cmd, args),
    sleep: (ms) => Bun.sleepSync(ms),
  });
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
