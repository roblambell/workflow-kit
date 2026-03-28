import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  allocatePartition,
  releasePartition,
  getPartitionFor,
  cleanupStalePartitions,
} from "../core/partitions.ts";
import type { WorktreeInfo } from "../core/types.ts";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), `nw-partition-test-${process.pid}`);
const PARTITION_DIR = join(TEST_DIR, ".partitions");
const WORKTREE_DIR = join(TEST_DIR, ".worktrees");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(WORKTREE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("allocatePartition", () => {
  it("allocates partition 1 for the first item", () => {
    const n = allocatePartition(PARTITION_DIR, "H-BF5-1");
    expect(n).toBe(1);
    expect(existsSync(join(PARTITION_DIR, "1"))).toBe(true);
  });

  it("allocates the lowest available number", () => {
    allocatePartition(PARTITION_DIR, "H-BF5-1"); // gets 1
    allocatePartition(PARTITION_DIR, "H-BF5-2"); // gets 2
    releasePartition(PARTITION_DIR, "H-BF5-1"); // frees 1
    const n = allocatePartition(PARTITION_DIR, "H-BF5-3"); // should get 1
    expect(n).toBe(1);
  });

  it("increments when all lower slots are taken", () => {
    allocatePartition(PARTITION_DIR, "A-1-1"); // 1
    allocatePartition(PARTITION_DIR, "A-1-2"); // 2
    const n = allocatePartition(PARTITION_DIR, "A-1-3");
    expect(n).toBe(3);
  });
});

describe("releasePartition", () => {
  it("removes the partition file for the given ID", () => {
    allocatePartition(PARTITION_DIR, "H-BF5-1");
    releasePartition(PARTITION_DIR, "H-BF5-1");
    expect(existsSync(join(PARTITION_DIR, "1"))).toBe(false);
  });

  it("does nothing if partition dir does not exist", () => {
    expect(() => releasePartition("/nonexistent", "H-BF5-1")).not.toThrow();
  });

  it("does nothing if ID is not allocated", () => {
    allocatePartition(PARTITION_DIR, "H-BF5-1");
    releasePartition(PARTITION_DIR, "H-BF5-999");
    // Original should still be there
    expect(existsSync(join(PARTITION_DIR, "1"))).toBe(true);
  });
});

describe("getPartitionFor", () => {
  it("returns the partition number for an allocated ID", () => {
    allocatePartition(PARTITION_DIR, "H-BF5-1");
    allocatePartition(PARTITION_DIR, "H-BF5-2");
    expect(getPartitionFor(PARTITION_DIR, "H-BF5-2")).toBe(2);
  });

  it("returns null when ID is not allocated", () => {
    expect(getPartitionFor(PARTITION_DIR, "H-BF5-99")).toBeNull();
  });

  it("returns null when partition dir does not exist", () => {
    expect(getPartitionFor("/nonexistent", "H-BF5-1")).toBeNull();
  });
});

describe("cleanupStalePartitions", () => {
  it("removes partitions for items with no worktree on disk", () => {
    allocatePartition(PARTITION_DIR, "H-GONE-1");
    // No worktree exists for H-GONE-1

    cleanupStalePartitions(PARTITION_DIR, WORKTREE_DIR, () => null);

    expect(existsSync(join(PARTITION_DIR, "1"))).toBe(false);
  });

  it("keeps partitions for items with a hub worktree", () => {
    allocatePartition(PARTITION_DIR, "H-KEEP-1");
    mkdirSync(join(WORKTREE_DIR, "ninthwave-H-KEEP-1"), { recursive: true });

    cleanupStalePartitions(PARTITION_DIR, WORKTREE_DIR, () => null);

    expect(existsSync(join(PARTITION_DIR, "1"))).toBe(true);
  });

  it("keeps partitions for items with a cross-repo worktree", () => {
    allocatePartition(PARTITION_DIR, "X-CR-1");
    const crossRepoPath = join(TEST_DIR, "other-repo", ".worktrees", "ninthwave-X-CR-1");
    mkdirSync(crossRepoPath, { recursive: true });

    const getInfo = (todoId: string): WorktreeInfo | null => {
      if (todoId === "X-CR-1") {
        return {
          todoId: "X-CR-1",
          repoRoot: join(TEST_DIR, "other-repo"),
          worktreePath: crossRepoPath,
        };
      }
      return null;
    };

    cleanupStalePartitions(PARTITION_DIR, WORKTREE_DIR, getInfo);

    expect(existsSync(join(PARTITION_DIR, "1"))).toBe(true);
  });

  it("removes partitions for cross-repo items where worktree path is gone", () => {
    allocatePartition(PARTITION_DIR, "X-GONE-1");

    const getInfo = (todoId: string): WorktreeInfo | null => {
      if (todoId === "X-GONE-1") {
        return {
          todoId: "X-GONE-1",
          repoRoot: "/nonexistent/repo",
          worktreePath: "/nonexistent/path",
        };
      }
      return null;
    };

    cleanupStalePartitions(PARTITION_DIR, WORKTREE_DIR, getInfo);

    expect(existsSync(join(PARTITION_DIR, "1"))).toBe(false);
  });
});
