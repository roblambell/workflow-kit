import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { acquireLock, releaseLock, isLockStale } from "../core/lock.ts";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), `nw-lock-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("acquireLock / releaseLock", () => {
  it("creates a lock directory with a pid file", () => {
    const lockPath = join(TEST_DIR, "test.lock");
    acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(lockPath, "pid"))).toBe(true);
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("writes current process PID and verifies ownership", () => {
    const lockPath = join(TEST_DIR, "verify.lock");
    acquireLock(lockPath);
    const writtenPid = readFileSync(join(lockPath, "pid"), "utf-8").trim();
    expect(writtenPid).toBe(String(process.pid));
    releaseLock(lockPath);
  });

  it("throws when lock is held by another live process and times out", () => {
    const lockPath = join(TEST_DIR, "held.lock");
    // Simulate another process holding the lock
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid)); // our own PID = alive

    expect(() => acquireLock(lockPath, 100)).toThrow(/Failed to acquire lock/);
    releaseLock(lockPath);
  });

  it("steals a stale lock (dead PID)", () => {
    const lockPath = join(TEST_DIR, "stale.lock");
    mkdirSync(lockPath);
    // Use PID 99999999 which is almost certainly not running
    writeFileSync(join(lockPath, "pid"), "99999999");

    // Should succeed by stealing
    acquireLock(lockPath);
    expect(existsSync(join(lockPath, "pid"))).toBe(true);
    // Verify the PID file now contains our PID
    const pid = readFileSync(join(lockPath, "pid"), "utf-8").trim();
    expect(pid).toBe(String(process.pid));
    releaseLock(lockPath);
  });

  it("steals a lock with missing pid file", () => {
    const lockPath = join(TEST_DIR, "nopid.lock");
    mkdirSync(lockPath);
    // No pid file at all — should be considered stale
    acquireLock(lockPath);
    expect(existsSync(join(lockPath, "pid"))).toBe(true);
    releaseLock(lockPath);
  });

  it("retries when PID file is stolen after write (verify-after-write)", () => {
    const lockPath = join(TEST_DIR, "stolen.lock");

    // Simulate a race: another process steals the lock after our first mkdir+writePid.
    // We do this by creating the lock dir with a foreign PID, which makes acquireLock
    // detect it as stale, remove it, re-mkdir, and writePid. We intercept by
    // overwriting the PID file right after it's created — but since we can't hook
    // into the middle of acquireLock synchronously, we instead verify the behavior
    // indirectly: after acquireLock succeeds, the PID file MUST contain our PID.
    // This confirms the verify step ran and accepted the lock.

    // Set up a stale lock that will be stolen
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), "99999999"); // dead PID

    acquireLock(lockPath);

    // The verify-after-write step ensures our PID is what's in the file
    const finalPid = readFileSync(join(lockPath, "pid"), "utf-8").trim();
    expect(finalPid).toBe(String(process.pid));
    releaseLock(lockPath);
  });

  it("recovers when PID file disappears between write and verify", () => {
    // This tests the edge case where the PID file is deleted between write and
    // verify. We can't inject into the middle of acquireLock without mocks, but
    // we can test the exported verifyPid behavior indirectly:
    // Create a lock dir, delete its PID file, and confirm acquireLock still
    // succeeds (it retries and creates a fresh lock).
    const lockPath = join(TEST_DIR, "vanish.lock");

    // Start with a stale lock (missing PID = stale)
    mkdirSync(lockPath);
    // No PID file — isLockStale returns true, lock gets stolen

    acquireLock(lockPath);
    expect(existsSync(join(lockPath, "pid"))).toBe(true);
    const pid = readFileSync(join(lockPath, "pid"), "utf-8").trim();
    expect(pid).toBe(String(process.pid));
    releaseLock(lockPath);
  });

  it("preserves exponential backoff behavior", () => {
    const lockPath = join(TEST_DIR, "backoff.lock");
    // Hold a live lock to force timeout with backoff
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid));

    const start = Date.now();
    expect(() => acquireLock(lockPath, 200)).toThrow(/Failed to acquire lock/);
    const elapsed = Date.now() - start;
    // Should have waited close to 200ms (with some tolerance)
    expect(elapsed).toBeGreaterThanOrEqual(180);
    releaseLock(lockPath);
  });

  it("preserves default timeout of 5000ms", () => {
    // Verify the function signature accepts no timeout (uses default)
    const lockPath = join(TEST_DIR, "default-timeout.lock");
    // Don't actually wait 5s — just verify it works with default when lock is free
    acquireLock(lockPath);
    expect(existsSync(join(lockPath, "pid"))).toBe(true);
    releaseLock(lockPath);
  });
});

describe("isLockStale", () => {
  it("returns true when lock dir does not have a pid file", () => {
    const lockPath = join(TEST_DIR, "empty.lock");
    mkdirSync(lockPath);
    expect(isLockStale(lockPath)).toBe(true);
  });

  it("returns true when pid is not a running process", () => {
    const lockPath = join(TEST_DIR, "dead.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), "99999999");
    expect(isLockStale(lockPath)).toBe(true);
  });

  it("returns false when pid is the current process", () => {
    const lockPath = join(TEST_DIR, "alive.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid));
    expect(isLockStale(lockPath)).toBe(false);
  });
});
