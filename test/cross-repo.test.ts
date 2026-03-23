import { describe, it, expect, afterEach } from "vitest";
import {
  setupTempRepo,
  setupTempRepoPair,
  useFixture,
  cleanupTempRepos,
} from "./helpers.ts";
import { join, dirname, basename } from "path";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { parseTodos } from "../core/parser.ts";

describe("cross-repo", () => {
  afterEach(() => cleanupTempRepos());

  // Group 1: parse_todos() Repo field extraction
  describe("repo field parsing", () => {
    it("parses all 4 items from cross_repo fixture", () => {
      const repo = setupTempRepo();
      useFixture(repo, "cross_repo.md");
      const items = parseTodos(
        join(repo, "TODOS.md"),
        join(repo, ".worktrees"),
      );

      expect(items).toHaveLength(4);
    });

    it("parses repo alias for cross-repo items", () => {
      const repo = setupTempRepo();
      useFixture(repo, "cross_repo.md");
      const items = parseTodos(
        join(repo, "TODOS.md"),
        join(repo, ".worktrees"),
      );

      const apiItem = items.find((i) => i.id === "H-API-1");
      expect(apiItem?.repoAlias).toBe("target-repo-a");

      const waItem = items.find((i) => i.id === "H-WA-1");
      expect(waItem?.repoAlias).toBe("target-repo-b");
    });

    it("hub-local items have empty repo alias", () => {
      const repo = setupTempRepo();
      useFixture(repo, "cross_repo.md");
      const items = parseTodos(
        join(repo, "TODOS.md"),
        join(repo, ".worktrees"),
      );

      const docItem = items.find((i) => i.id === "M-DOC-1");
      expect(docItem?.repoAlias).toBe("");
    });

    it("valid.md (no Repo fields) still parses 4 items", () => {
      const repo = setupTempRepo();
      useFixture(repo, "valid.md");
      const items = parseTodos(
        join(repo, "TODOS.md"),
        join(repo, ".worktrees"),
      );

      expect(items).toHaveLength(4);
    });

    it("M-CI-1 still has correct priority in valid.md", () => {
      const repo = setupTempRepo();
      useFixture(repo, "valid.md");
      const items = parseTodos(
        join(repo, "TODOS.md"),
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
        `H-API-1\t${parent}/target-repo-a\t${parent}/target-repo-a/.worktrees/todo-H-API-1\nH-WA-1\t${parent}/target-repo-b\t${parent}/target-repo-b/.worktrees/todo-H-WA-1\n`,
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
        `H-API-1\t${parent}/target-repo-a\t${parent}/target-repo-a/.worktrees/todo-H-API-1\nH-WA-1\t${parent}/target-repo-b\t${parent}/target-repo-b/.worktrees/todo-H-WA-1\n`,
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

  // Group 4: Hub fallback behavior
  describe("hub fallback", () => {
    it("items without Repo field default to empty alias", () => {
      const repo = setupTempRepo();
      useFixture(repo, "valid.md");
      const items = parseTodos(
        join(repo, "TODOS.md"),
        join(repo, ".worktrees"),
      );

      for (const item of items) {
        expect(item.repoAlias).toBe("");
      }
    });
  });
});
