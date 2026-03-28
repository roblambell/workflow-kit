// stop command: terminate the watch daemon gracefully.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import {
  readPidFile,
  cleanPidFile,
  cleanStateFile,
  processExists,
  type DaemonIO,
  type ProcessExistsCheck,
} from "../daemon.ts";

export interface StopDeps {
  io: DaemonIO;
  check: ProcessExistsCheck;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

const defaultDeps: StopDeps = {
  io: { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync },
  check: processExists,
  kill: (pid, signal) => process.kill(pid, signal),
};

/**
 * Stop the watch daemon.
 * Returns a status message for the caller.
 */
export function cmdStop(
  projectRoot: string,
  deps: StopDeps = defaultDeps,
): string {
  const pid = readPidFile(projectRoot, deps.io);

  if (pid === null) {
    const msg = "No watch daemon is running.";
    console.log(msg);
    return msg;
  }

  if (!deps.check(pid)) {
    // Stale PID file — clean up
    cleanPidFile(projectRoot, deps.io);
    cleanStateFile(projectRoot, deps.io);
    const msg = `Watch daemon is not running (stale PID file, PID ${pid}). Cleaned up.`;
    console.log(msg);
    return msg;
  }

  // Send SIGTERM for graceful shutdown
  deps.kill(pid, "SIGTERM");
  const msg = `Sent SIGTERM to watch daemon (PID ${pid}). Shutting down gracefully.`;
  console.log(msg);
  return msg;
}
