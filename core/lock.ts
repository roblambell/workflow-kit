import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { join } from "path";

const PID_FILE = "pid";

/** Check if the process holding the lock is still alive. */
export function isLockStale(lockPath: string): boolean {
  const pidFile = join(lockPath, PID_FILE);
  if (!existsSync(pidFile)) return true;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return true;
    // kill -0 checks process existence without sending a signal
    process.kill(pid, 0);
    return false; // process is alive
  } catch {
    return true; // process is dead or we can't signal it
  }
}

function tryMkdir(lockPath: string): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch {
    return false; // already exists
  }
}

function writePid(lockPath: string): void {
  writeFileSync(join(lockPath, PID_FILE), String(process.pid));
}

/**
 * Verify that we still own the lock by re-reading the PID file.
 * Guards against TOCTOU race: two processes both detect a stale lock,
 * one acquires it, then the other removes it (thinking it's still stale)
 * and acquires its own. By verifying after write, the first process
 * detects the theft on its next retry.
 */
function verifyPid(lockPath: string): boolean {
  try {
    const contents = readFileSync(join(lockPath, PID_FILE), "utf-8").trim();
    return contents === String(process.pid);
  } catch {
    // PID file was deleted between write and verify — lock was stolen
    return false;
  }
}

function removeLockDir(lockPath: string): void {
  const pidFile = join(lockPath, PID_FILE);
  try {
    unlinkSync(pidFile);
  } catch {
    // pid file may not exist
  }
  try {
    rmdirSync(lockPath);
  } catch {
    // lock dir may not exist
  }
}

/**
 * Acquire a mkdir-based atomic file lock.
 * If the lock exists but the holding process is dead, steal the lock.
 * Retries with exponential backoff up to timeoutMs (default 5000).
 */
export function acquireLock(lockPath: string, timeoutMs = 5000): void {
  const start = Date.now();
  let backoff = 10;

  while (true) {
    if (tryMkdir(lockPath)) {
      writePid(lockPath);
      // Verify we still own the lock (guards against concurrent stale-lock recovery)
      if (verifyPid(lockPath)) {
        return;
      }
      // Another process stole the lock between write and verify — retry
    }

    // Lock exists — check for staleness
    if (isLockStale(lockPath)) {
      removeLockDir(lockPath);
      if (tryMkdir(lockPath)) {
        writePid(lockPath);
        if (verifyPid(lockPath)) {
          return;
        }
        // Stolen between write and verify — retry
      }
    }

    // Check timeout
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `Failed to acquire lock at ${lockPath} after ${timeoutMs}ms`,
      );
    }

    // Busy-wait with backoff (Bun.sleepSync is synchronous)
    Bun.sleepSync(backoff);
    backoff = Math.min(backoff * 2, 200);
  }
}

/** Release a previously acquired lock. */
export function releaseLock(lockPath: string): void {
  removeLockDir(lockPath);
}
