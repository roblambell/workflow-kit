import { describe, it, expect, afterEach } from "vitest";
import {
  setupTempRepo,
  setupTempRepoPair,
  useFixtureDir,
  cleanupTempRepos,
} from "./helpers.ts";
import { join, dirname, basename } from "path";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { parseWorkItems } from "../core/parser.ts";
import {
  resolveRepo,
  writeCrossRepoIndex,
  removeCrossRepoIndex,
  getWorktreeInfo,
} from "../core/cross-repo.ts";

describe("cross-repo", () => {
  afterEach(() => cleanupTempRepos());

  // Group 1: parse_todos() Repo field extraction
  describe("repo field parsing", () => {
    it("parses all 4 items from cross_repo fixture", () => {
      const repo = setupTempRepo();
      const workDir = useFixtureDir(repo, "cross_repo.md");
      const items = parseWorkItems(
        workDir,
        join(repo, ".worktrees"),
      );

      expect(items).toHaveLength(4);
    });

    it("parses repo alias for cross-repo items", () => {
      const repo = setupTempRepo();
      const workDir = useFixtureDir(repo, "cross_repo.md");
      const items = parseWorkItems(
        workDir,
        join(repo, ".worktrees"),
      );

      const apiItem = items.find((i) => i.id === "H-API-1");
      expect(apiItem?.repoAlias).toBe("target-repo-a");

      const waItem = items.find((i) => i.id === "H-WA-1");
      expect(waItem?.repoAlias).toBe("target-repo-b");
    });

    it("hub-local items have empty repo alias", () => {
      const repo = setupTempRepo();
      const workDir = useFixtureDir(repo, "cross_repo.md");
      const items = parseWorkItems(
        workDir,
        join(repo, ".worktrees"),
      );

      const docItem = items.find((i) => i.id === "M-DOC-1");
      expect(docItem?.repoAlias).toBe("");
    });

    it("valid.md (no Repo fields) still parses 4 items", () => {
      const repo = setupTempRepo();
      const workDir = useFixtureDir(repo, "valid.md");
      const items = parseWorkItems(
        workDir,
        join(repo, ".worktrees"),
      );

      expect(items).toHaveLength(4);
    });

    it("M-CI-1 still has correct priority in valid.md", () => {
      const repo = setupTempRepo();
      const workDir = useFixtureDir(repo, "valid.md");
      const items = parseWorkItems(
        workDir,
        join(repo, ".worktrees"),
      );

      const item = items.find((i) => i.id === "M-CI-1");
      expect(item?.priority).toBe("medium");
    });
  });

  // Group 2: Sibling directory resolution
  describe("sibling directory discovery", () => {
    it("setup_temp_repo_pair creates sibling repos", () => {
      const hub = setupTempRepoPair();
      const parent = dirname(hub);

      expect(existsSync(join(parent, "target-repo-a", ".git"))).toBe(true);
      expect(existsSync(join(parent, "target-repo-b", ".git"))).toBe(true);
    }, 15000);
  });

  // Group 3: Cross-repo index read/write
  describe("cross-repo index CRUD", () => {
    it("index can be written and read", { timeout: 15000 }, () => {
      const hub = setupTempRepoPair();
      const parent = dirname(hub);
      mkdirSync(join(hub, ".worktrees"), { recursive: true });

      const indexFile = join(hub, ".worktrees", ".cross-repo-index");
      writeFileSync(
        indexFile,
        `H-API-1\t${parent}/target-repo-a\t${parent}/target-repo-a/.worktrees/ninthwave-H-API-1\nH-WA-1\t${parent}/target-repo-b\t${parent}/target-repo-b/.worktrees/ninthwave-H-WA-1\n`,
      );

      expect(existsSync(indexFile)).toBe(true);
      const content = readFileSync(indexFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(content).toContain("H-API-1");
      expect(content).toContain("H-WA-1");
    });

    it("entry can be removed from index", { timeout: 15000 }, () => {
      const hub = setupTempRepoPair();
      const parent = dirname(hub);
      mkdirSync(join(hub, ".worktrees"), { recursive: true });

      const indexFile = join(hub, ".worktrees", ".cross-repo-index");
      writeFileSync(
        indexFile,
        `H-API-1\t${parent}/target-repo-a\t${parent}/target-repo-a/.worktrees/ninthwave-H-API-1\nH-WA-1\t${parent}/target-repo-b\t${parent}/target-repo-b/.worktrees/ninthwave-H-WA-1\n`,
      );

      // Simulate removal: filter out H-API-1
      const content = readFileSync(indexFile, "utf-8");
      const filtered = content
        .split("\n")
        .filter((line) => !line.startsWith("H-API-1\t"))
        .join("\n");
      writeFileSync(indexFile, filtered);

      const updated = readFileSync(indexFile, "utf-8");
      expect(updated).not.toContain("H-API-1");
      expect(updated).toContain("H-WA-1");
    });
  });

  // Group 4: writeCrossRepoIndex deduplication
  describe("writeCrossRepoIndex deduplication", () => {
    it("writing same ID twice results in one entry", () => {
      const repo = setupTempRepo();
      const indexFile = join(repo, ".worktrees", ".cross-repo-index");

      writeCrossRepoIndex(indexFile, "T-1", "/repo-a", "/repo-a/.worktrees/ninthwave-T-1");
      writeCrossRepoIndex(indexFile, "T-1", "/repo-a", "/repo-a/.worktrees/ninthwave-T-1-v2");

      const content = readFileSync(indexFile, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("ninthwave-T-1-v2");
    });

    it("writing different IDs produces separate entries", () => {
      const repo = setupTempRepo();
      const indexFile = join(repo, ".worktrees", ".cross-repo-index");

      writeCrossRepoIndex(indexFile, "T-1", "/repo-a", "/repo-a/.worktrees/ninthwave-T-1");
      writeCrossRepoIndex(indexFile, "T-2", "/repo-b", "/repo-b/.worktrees/ninthwave-T-2");

      const content = readFileSync(indexFile, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      expect(lines).toHaveLength(2);
      expect(content).toContain("T-1");
      expect(content).toContain("T-2");
    });

    it("existing index operations still work after dedup write", () => {
      const repo = setupTempRepo();
      const indexFile = join(repo, ".worktrees", ".cross-repo-index");
      mkdirSync(join(repo, ".worktrees"), { recursive: true });

      // Write two entries
      writeCrossRepoIndex(indexFile, "T-1", "/repo-a", "/repo-a/.worktrees/ninthwave-T-1");
      writeCrossRepoIndex(indexFile, "T-2", "/repo-b", "/repo-b/.worktrees/ninthwave-T-2");

      // getWorktreeInfo should find them
      const info1 = getWorktreeInfo("T-1", indexFile, join(repo, ".worktrees"));
      expect(info1).not.toBeNull();
      expect(info1!.itemId).toBe("T-1");
      expect(info1!.repoRoot).toBe("/repo-a");

      // Remove one
      removeCrossRepoIndex(indexFile, "T-1");
      const content = readFileSync(indexFile, "utf-8");
      expect(content).not.toContain("T-1");
      expect(content).toContain("T-2");
    });
  });

  // Group 5: resolveRepo error handling
  describe("resolveRepo error handling", () => {
    it("returns projectRoot for empty alias", () => {
      const repo = setupTempRepo();
      expect(resolveRepo("", repo)).toBe(repo);
    });

    it("returns projectRoot for 'self' alias", () => {
      const repo = setupTempRepo();
      expect(resolveRepo("self", repo)).toBe(repo);
    });

    it("returns projectRoot for 'hub' alias", () => {
      const repo = setupTempRepo();
      expect(resolveRepo("hub", repo)).toBe(repo);
    });

    it("resolves sibling repo via convention", () => {
      const hub = setupTempRepoPair();
      const parent = dirname(hub);
      expect(resolveRepo("target-repo-a", hub)).toBe(
        join(parent, "target-repo-a"),
      );
    });

    it("throws on unresolvable alias (no sibling, no repos.conf)", () => {
      const repo = setupTempRepo();
      expect(() => resolveRepo("nonexistent-repo", repo)).toThrow(
        /not found/i,
      );
    });

    it("throws when repos.conf maps alias to non-git directory", () => {
      const repo = setupTempRepo();
      const confDir = join(repo, ".ninthwave");
      mkdirSync(confDir, { recursive: true });
      // Create a directory that is NOT a git repo
      const fakePath = join(dirname(repo), "not-a-repo");
      mkdirSync(fakePath, { recursive: true });
      writeFileSync(
        join(confDir, "repos.conf"),
        `my-alias = ${fakePath}\n`,
      );
      expect(() => resolveRepo("my-alias", repo)).toThrow(
        /not a git repository/i,
      );
    });

    it("callers can catch the error and continue", () => {
      const repo = setupTempRepo();
      let caught = false;
      try {
        resolveRepo("nonexistent-repo", repo);
      } catch {
        caught = true;
      }
      expect(caught).toBe(true);
      // Caller can continue after catching
      const result = resolveRepo("", repo);
      expect(result).toBe(repo);
    });
  });

  // Group 6: Hub fallback behavior
  describe("hub fallback", () => {
    it("items without Repo field default to empty alias", () => {
      const repo = setupTempRepo();
      const workDir = useFixtureDir(repo, "valid.md");
      const items = parseWorkItems(
        workDir,
        join(repo, ".worktrees"),
      );

      for (const item of items) {
        expect(item.repoAlias).toBe("");
      }
    });
  });
});
