import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
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
