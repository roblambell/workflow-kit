// Tests for the TODOS.md parser — ported from test/test_parse_todos.sh.

import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { parseTodos, extractFilePaths, normalizeDomain } from "../core/parser.ts";
import {
  setupTempRepo,
  setupTempRepoPair,
  useFixture,
  cleanupTempRepos,
} from "./helpers.ts";

afterEach(() => {
  cleanupTempRepos();
});

describe("parseTodos — valid fixture", () => {
  it("parses all 4 items from valid fixture", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    expect(items).toHaveLength(4);
  });

  it("extracts correct IDs", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const ids = items.map((i) => i.id);
    expect(ids).toContain("M-CI-1");
    expect(ids).toContain("H-CI-2");
    expect(ids).toContain("C-UO-1");
    expect(ids).toContain("H-UO-2");
  });

  it("extracts correct priorities", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-CI-1")!.priority).toBe("medium");
    expect(byId.get("H-CI-2")!.priority).toBe("high");
    expect(byId.get("C-UO-1")!.priority).toBe("critical");
    expect(byId.get("H-UO-2")!.priority).toBe("high");
  });

  it("extracts correct titles", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-CI-1")!.title).toContain("Upgrade CI runners");
    expect(byId.get("H-CI-2")!.title).toContain(
      "Flaky connection pool timeout",
    );
  });

  it("extracts correct domains", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-CI-1")!.domain).toBe("cloud-infrastructure");
    expect(byId.get("H-CI-2")!.domain).toBe("cloud-infrastructure");
    expect(byId.get("C-UO-1")!.domain).toBe("user-onboarding");
    expect(byId.get("H-UO-2")!.domain).toBe("user-onboarding");
  });

  it("extracts dependencies", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("H-CI-2")!.dependencies).toContain("M-CI-1");
    expect(byId.get("H-UO-2")!.dependencies).toContain("C-UO-1");
    expect(byId.get("H-UO-2")!.dependencies).toContain("M-CI-1");
  });

  it("extracts bundle-with", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("H-UO-2")!.bundleWith).toContain("H-CI-2");
  });

  it("all items have open status when no worktrees exist", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));

    for (const item of items) {
      expect(item.status).toBe("open");
    }
  });

  it("extracts file paths from valid fixture", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    const mci1Paths = byId.get("M-CI-1")!.filePaths;
    expect(mci1Paths).toContain(".github/workflows/test-api.yml");
    expect(mci1Paths).toContain(".github/workflows/ci.yml");

    const hci2Paths = byId.get("H-CI-2")!.filePaths;
    expect(hci2Paths).toContain("config/test.exs");
  });

  it("stores raw markdown text per item", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-CI-1")!.rawText).toContain("Upgrade CI runners");
    expect(byId.get("M-CI-1")!.rawText).toContain("**Priority:** Medium");
  });

  it("records line numbers", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));

    // First item starts at line 5 (### header)
    expect(items[0]!.lineNumber).toBe(5);
    expect(items[0]!.lineEndNumber).toBeGreaterThan(items[0]!.lineNumber);
  });
});

describe("parseTodos — malformed fixture", () => {
  it("skips item with no ID", () => {
    const repo = setupTempRepo();
    useFixture(repo, "malformed.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain("");
  });

  it("parses item with missing priority (defaults to medium)", () => {
    const repo = setupTempRepo();
    useFixture(repo, "malformed.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const hbk2 = items.find((i) => i.id === "H-BK-2");
    expect(hbk2).toBeDefined();
    // Missing priority defaults to medium
    expect(hbk2!.priority).toBe("medium");
  });

  it("parses valid item after malformed ones", () => {
    const repo = setupTempRepo();
    useFixture(repo, "malformed.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const mbk3 = items.find((i) => i.id === "M-BK-3");
    expect(mbk3).toBeDefined();
    expect(mbk3!.priority).toBe("medium");
  });

  it("only 2 items parsed from malformed fixture (no-ID item skipped)", () => {
    const repo = setupTempRepo();
    useFixture(repo, "malformed.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    expect(items).toHaveLength(2);
  });
});

describe("parseTodos — empty fixture", () => {
  it("empty TODOS.md produces no items", () => {
    const repo = setupTempRepo();
    useFixture(repo, "empty.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    expect(items).toHaveLength(0);
  });
});

describe("parseTodos — multi-section fixture", () => {
  it("parses items across multiple sections", () => {
    const repo = setupTempRepo();
    useFixture(repo, "multi_section.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    expect(items).toHaveLength(3);
  });

  it("assigns correct domains from different sections", () => {
    const repo = setupTempRepo();
    useFixture(repo, "multi_section.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("H-AL-1")!.domain).toBe("section-alpha");
    expect(byId.get("M-AL-2")!.domain).toBe("section-alpha");
    expect(byId.get("H-BE-1")!.domain).toBe("section-beta");
  });

  it("extracts cross-section dependencies", () => {
    const repo = setupTempRepo();
    useFixture(repo, "multi_section.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-AL-2")!.dependencies).toContain("H-AL-1");
  });
});

describe("parseTodos — cross-repo fixture", () => {
  it("parses repo aliases", () => {
    const repo = setupTempRepo();
    useFixture(repo, "cross_repo.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("H-API-1")!.repoAlias).toBe("target-repo-a");
    expect(byId.get("M-API-2")!.repoAlias).toBe("target-repo-a");
    expect(byId.get("H-WA-1")!.repoAlias).toBe("target-repo-b");
    // M-DOC-1 has no Repo line
    expect(byId.get("M-DOC-1")!.repoAlias).toBe("");
  });

  it("parses all 4 items from cross-repo fixture", () => {
    const repo = setupTempRepo();
    useFixture(repo, "cross_repo.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    expect(items).toHaveLength(4);
  });

  it("assigns domains correctly across sections", () => {
    const repo = setupTempRepo();
    useFixture(repo, "cross_repo.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("H-API-1")!.domain).toBe("api-service");
    expect(byId.get("H-WA-1")!.domain).toBe("web-app");
    expect(byId.get("M-DOC-1")!.domain).toBe("documentation");
  });
});

describe("parseTodos — in-progress detection", () => {
  it("detects in-progress from worktree directories", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");

    // Create a worktree dir for M-CI-1
    const wtDir = join(repo, ".worktrees", "todo-M-CI-1");
    mkdirSync(wtDir, { recursive: true });

    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-CI-1")!.status).toBe("in-progress");
    expect(byId.get("H-CI-2")!.status).toBe("open");
  });

  it("detects in-progress from cross-repo index", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");

    // Create the worktrees dir and cross-repo index
    const wtDir = join(repo, ".worktrees");
    mkdirSync(wtDir, { recursive: true });

    // Create a dummy target path that exists
    const targetPath = join(repo, ".worktrees", "todo-H-CI-2");
    mkdirSync(targetPath, { recursive: true });

    // Write cross-repo index pointing to the existing path
    writeFileSync(
      join(wtDir, ".cross-repo-index"),
      `H-CI-2\ttarget-repo\t${targetPath}\n`,
    );

    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("H-CI-2")!.status).toBe("in-progress");
  });
});

describe("parseTodos — circular deps fixture", () => {
  it("parses all 3 circular dep items", () => {
    const repo = setupTempRepo();
    useFixture(repo, "circular_deps.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    expect(items).toHaveLength(3);
  });

  it("captures circular dependency references", () => {
    const repo = setupTempRepo();
    useFixture(repo, "circular_deps.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("H-CC-1")!.dependencies).toContain("H-CC-2");
    expect(byId.get("H-CC-2")!.dependencies).toContain("H-CC-3");
    expect(byId.get("H-CC-3")!.dependencies).toContain("H-CC-1");
  });
});

describe("normalizeDomain", () => {
  it("lowercases and slugifies", () => {
    expect(normalizeDomain("Cloud Infrastructure")).toBe(
      "cloud-infrastructure",
    );
  });

  it("strips non-alphanumeric characters", () => {
    expect(normalizeDomain("User Onboarding!")).toBe("user-onboarding");
  });

  it("handles already-slugified input", () => {
    expect(normalizeDomain("api-service")).toBe("api-service");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeDomain("Section   Alpha")).toBe("section-alpha");
  });

  it("strips leading/trailing hyphens", () => {
    expect(normalizeDomain(" -test- ")).toBe("test");
  });

  it("strips parenthetical annotations from section headers", () => {
    expect(
      normalizeDomain(
        "CLI Migration (TypeScript migration completion, 2026-03-23)",
      ),
    ).toBe("cli-migration");
  });

  it("strips parenthetical annotations — v2 rewrite", () => {
    expect(normalizeDomain("API Service (v2 rewrite)")).toBe("api-service");
  });

  it("strips multiple parenthetical groups", () => {
    expect(normalizeDomain("Core (a) Utils (b)")).toBe("core-utils");
  });

  it("strips (from ...) parentheticals (subsumes old special case)", () => {
    expect(normalizeDomain("Infrastructure (from old-repo)")).toBe(
      "infrastructure",
    );
  });
});

describe("extractFilePaths", () => {
  it("extracts backtick-quoted paths with extensions", () => {
    const item = fakeItem(
      "Key files: `lib/gateway/rate_limiter.ex`, `config/test.exs`",
    );
    const paths = extractFilePaths(item);
    expect(paths).toContain("lib/gateway/rate_limiter.ex");
    expect(paths).toContain("config/test.exs");
  });

  it("extracts file:line patterns", () => {
    const item = fakeItem("See lib/foo.ex:123 and lib/bar.py:45-67");
    const paths = extractFilePaths(item);
    expect(paths).toContain("lib/foo.ex");
    expect(paths).toContain("lib/bar.py");
  });

  it("extracts directory paths in backticks", () => {
    const item = fakeItem("Look at `src/components/Onboarding`");
    const paths = extractFilePaths(item);
    expect(paths).toContain("src/components/Onboarding");
  });

  it("deduplicates paths", () => {
    const item = fakeItem(
      "`lib/foo.ex` and `lib/foo.ex` mentioned twice",
    );
    const paths = extractFilePaths(item);
    const fooCount = paths.filter((p) => p === "lib/foo.ex").length;
    expect(fooCount).toBe(1);
  });
});

// Helper: create a minimal TodoItem with the given rawText
function fakeItem(rawText: string) {
  return {
    id: "X-TEST-1",
    priority: "medium" as const,
    title: "Test",
    domain: "test",
    dependencies: [],
    bundleWith: [],
    status: "open" as const,
    lineNumber: 1,
    lineEndNumber: 1,
    repoAlias: "",
    rawText,
    filePaths: [],
  };
}
