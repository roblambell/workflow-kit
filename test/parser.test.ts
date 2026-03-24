// Tests for the TODOS.md parser — ported from test/test_parse_todos.sh.

import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { parseTodos, extractFilePaths, extractTestPlan, normalizeDomain, truncateSlug, expandWildcardDeps } from "../core/parser.ts";
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

describe("parseTodos — warn callback on skipped items", () => {
  it("invokes warn with line number when an item has no ID", () => {
    const repo = setupTempRepo();
    useFixture(repo, "malformed.md");
    const warnings: Array<{ message: string; lineNumber: number }> = [];
    const warn = (message: string, lineNumber: number) => {
      warnings.push({ message, lineNumber });
    };

    parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"), { warn });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.lineNumber).toBe(5); // "### Feat: Item with no ID in header" is line 5
    expect(warnings[0]!.message).toContain("no ID");
    expect(warnings[0]!.message).toContain("line 5");
  });

  it("parsing continues correctly after warning", () => {
    const repo = setupTempRepo();
    useFixture(repo, "malformed.md");
    const warnings: Array<{ message: string; lineNumber: number }> = [];
    const warn = (message: string, lineNumber: number) => {
      warnings.push({ message, lineNumber });
    };

    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"), { warn });

    // The no-ID item is skipped but both valid items are still parsed
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id)).toContain("H-BK-2");
    expect(items.map((i) => i.id)).toContain("M-BK-3");
  });

  it("warn is not called for valid items", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const warnings: Array<{ message: string; lineNumber: number }> = [];
    const warn = (message: string, lineNumber: number) => {
      warnings.push({ message, lineNumber });
    };

    parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"), { warn });

    expect(warnings).toHaveLength(0);
  });

  it("no warn callback does not change behavior", () => {
    const repo = setupTempRepo();
    useFixture(repo, "malformed.md");

    // No warn option — should not throw
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    expect(items).toHaveLength(2);
  });

  it("warn message includes the item title", () => {
    const repo = setupTempRepo();
    useFixture(repo, "malformed.md");
    const warnings: Array<{ message: string; lineNumber: number }> = [];
    const warn = (message: string, lineNumber: number) => {
      warnings.push({ message, lineNumber });
    };

    parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"), { warn });

    expect(warnings[0]!.message).toContain("Item with no ID in header");
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

  it("returns short slugs unchanged (<= 40 chars)", () => {
    expect(normalizeDomain("Cloud Infrastructure")).toBe(
      "cloud-infrastructure",
    );
    expect(normalizeDomain("Cloud Infrastructure").length).toBeLessThanOrEqual(40);
  });

  it("truncates long slugs at hyphen boundary to max 40 chars", () => {
    // This header auto-slugifies to > 40 chars
    const long = "Architecture Design Review And Implementation Planning Session Notes";
    const result = normalizeDomain(long);
    expect(result.length).toBeLessThanOrEqual(40);
    // Should not cut mid-word — must end at a hyphen boundary
    expect(result).not.toMatch(/-$/);
    // Should be a prefix of the full slug
    const fullSlug = "architecture-design-review-and-implementation-planning-session-notes";
    expect(fullSlug.startsWith(result)).toBe(true);
  });

  it("does not truncate slug of exactly 40 chars", () => {
    // Build a header that produces exactly 40 chars when slugified
    // "abcdefghij-abcdefghij-abcdefghij-abcdefg" = 40 chars (10+1+10+1+10+1+7)
    const header = "abcdefghij abcdefghij abcdefghij abcdefg";
    const result = normalizeDomain(header);
    expect(result).toBe("abcdefghij-abcdefghij-abcdefghij-abcdefg");
    expect(result.length).toBe(40);
  });

  it("custom domain mappings take priority over truncation", () => {
    // Create a temp domains.conf that maps a long header to a short domain
    const { writeFileSync, mkdirSync } = require("fs");
    const { join } = require("path");
    const tmpDir = join(require("os").tmpdir(), `nw-test-domains-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const domainsFile = join(tmpDir, "domains.conf");
    writeFileSync(
      domainsFile,
      "architecture design review=arch-review\n",
    );

    const long = "Architecture Design Review And Implementation Planning Session Notes";
    const result = normalizeDomain(long, domainsFile);
    expect(result).toBe("arch-review");

    // Cleanup
    require("fs").rmSync(tmpDir, { recursive: true });
  });
});

describe("truncateSlug", () => {
  it("returns short slugs unchanged", () => {
    expect(truncateSlug("cloud-infrastructure", 40)).toBe("cloud-infrastructure");
  });

  it("truncates at last hyphen boundary within limit", () => {
    const slug = "architecture-design-review-and-implementation-planning";
    const result = truncateSlug(slug, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toBe("architecture-design-review-and");
    // Verify no trailing hyphen
    expect(result).not.toMatch(/-$/);
  });

  it("does not truncate slug of exactly maxLen", () => {
    const slug = "abcdefghij-abcdefghij-abcdefghij-abcdef"; // 40 chars
    expect(truncateSlug(slug, 40)).toBe(slug);
  });

  it("handles single long word with no hyphens", () => {
    const slug = "a".repeat(50);
    const result = truncateSlug(slug, 40);
    expect(result.length).toBe(40);
  });
});

describe("extractFilePaths", () => {
  it("extracts backtick-quoted paths with extensions from Key files line", () => {
    const item = fakeItem(
      "Key files: `lib/gateway/rate_limiter.ex`, `config/test.exs`",
    );
    const paths = extractFilePaths(item);
    expect(paths).toContain("lib/gateway/rate_limiter.ex");
    expect(paths).toContain("config/test.exs");
  });

  it("extracts file:line patterns from Key files line", () => {
    const item = fakeItem("Key files: lib/foo.ex:123, lib/bar.py:45-67");
    const paths = extractFilePaths(item);
    expect(paths).toContain("lib/foo.ex");
    expect(paths).toContain("lib/bar.py");
  });

  it("extracts directory paths in backticks from Key files line", () => {
    const item = fakeItem("Key files: `src/components/Onboarding`");
    const paths = extractFilePaths(item);
    expect(paths).toContain("src/components/Onboarding");
  });

  it("deduplicates paths", () => {
    const item = fakeItem(
      "Key files: `lib/foo.ex` and `lib/foo.ex` mentioned twice",
    );
    const paths = extractFilePaths(item);
    const fooCount = paths.filter((p) => p === "lib/foo.ex").length;
    expect(fooCount).toBe(1);
  });

  it("ignores paths mentioned only in description text", () => {
    const item = fakeItem(
      "### Fix: Something (X-TEST-1)\n\nThis invokes `core/cli.ts` internally.\n\nKey files: `lib/other.ts`",
    );
    const paths = extractFilePaths(item);
    expect(paths).not.toContain("core/cli.ts");
    expect(paths).toContain("lib/other.ts");
  });

  it("ignores paths in acceptance text", () => {
    const item = fakeItem(
      "### Fix: Something (X-TEST-1)\n\nAcceptance: Changes to `core/parser.ts` should not break.\n\nKey files: `lib/handler.ex`",
    );
    const paths = extractFilePaths(item);
    expect(paths).not.toContain("core/parser.ts");
    expect(paths).toContain("lib/handler.ex");
  });

  it("returns empty when no Key files line exists", () => {
    const item = fakeItem(
      "### Fix: Something (X-TEST-1)\n\nDescription mentions `core/cli.ts` but no Key files line.",
    );
    const paths = extractFilePaths(item);
    expect(paths).toHaveLength(0);
  });
});

describe("parseTodos — test plan extraction from fixture", () => {
  it("extracts test plan from items that have one", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    // M-CI-1 has a test plan
    const mci1Plan = byId.get("M-CI-1")!.testPlan;
    expect(mci1Plan).toContain("4 vCPU runner labels");
    expect(mci1Plan).toContain("ARM vs x86");

    // H-CI-2 has a test plan
    const hci2Plan = byId.get("H-CI-2")!.testPlan;
    expect(hci2Plan).toContain("pool size env var");
  });

  it("returns empty string for items without test plan", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    // C-UO-1 has no test plan
    expect(byId.get("C-UO-1")!.testPlan).toBe("");
  });
});

describe("extractTestPlan", () => {
  it("extracts bullet-point test plan", () => {
    const raw = [
      "### Feat: Something (X-TP-1)",
      "",
      "Description of the feature.",
      "",
      "**Test plan:**",
      "- Write unit test for parseTodos with new field",
      "- Verify existing integration tests still pass",
      "- Edge case: missing test plan defaults to empty",
      "",
      "Acceptance: Tests pass.",
    ].join("\n");

    const plan = extractTestPlan(raw);
    expect(plan).toContain("Write unit test for parseTodos");
    expect(plan).toContain("Edge case: missing test plan");
    expect(plan).not.toContain("Acceptance");
  });

  it("returns empty string when no test plan present", () => {
    const raw = [
      "### Feat: No plan (X-TP-2)",
      "",
      "Description only.",
      "",
      "Acceptance: Something works.",
    ].join("\n");

    expect(extractTestPlan(raw)).toBe("");
  });

  it("stops at Acceptance: line", () => {
    const raw = [
      "**Test plan:**",
      "- Test the thing",
      "Acceptance: Done when thing works.",
    ].join("\n");

    const plan = extractTestPlan(raw);
    expect(plan).toContain("Test the thing");
    expect(plan).not.toContain("Acceptance");
  });

  it("stops at Key files: line", () => {
    const raw = [
      "**Test plan:**",
      "- Verify output format",
      "Key files: `lib/foo.ts`",
    ].join("\n");

    const plan = extractTestPlan(raw);
    expect(plan).toContain("Verify output format");
    expect(plan).not.toContain("Key files");
  });

  it("stops at next metadata field", () => {
    const raw = [
      "**Test plan:**",
      "- Check behavior",
      "**Priority:** High",
    ].join("\n");

    const plan = extractTestPlan(raw);
    expect(plan).toContain("Check behavior");
    expect(plan).not.toContain("Priority");
  });

  it("handles inline content after header", () => {
    const raw = "**Test plan:** Manual review";
    const plan = extractTestPlan(raw);
    expect(plan).toBe("Manual review");
  });

  it("handles multi-line plan with blank lines between bullets", () => {
    const raw = [
      "**Test plan:**",
      "- First bullet",
      "",
      "- Second bullet",
      "",
      "Acceptance: Done.",
    ].join("\n");

    const plan = extractTestPlan(raw);
    expect(plan).toContain("First bullet");
    expect(plan).toContain("Second bullet");
  });
});

describe("expandWildcardDeps", () => {
  const allIds = ["H-MUX-1", "M-MUX-2", "L-MUX-3", "H-DF-1", "M-DF-2", "H-INI-1"];

  it("domain wildcard matches all items with that domain code", () => {
    const result = expandWildcardDeps("MUX-*", allIds, "H-INI-1");
    expect(result).toContain("H-MUX-1");
    expect(result).toContain("M-MUX-2");
    expect(result).toContain("L-MUX-3");
    expect(result).not.toContain("H-DF-1");
    expect(result).not.toContain("H-INI-1");
  });

  it("priority-prefixed wildcard matches only that priority", () => {
    const result = expandWildcardDeps("H-MUX-*", allIds, "H-INI-1");
    expect(result).toContain("H-MUX-1");
    expect(result).not.toContain("M-MUX-2");
    expect(result).not.toContain("L-MUX-3");
  });

  it("multiple wildcards in one string", () => {
    const result = expandWildcardDeps("MUX-*, DF-*", allIds, "H-INI-1");
    expect(result).toContain("H-MUX-1");
    expect(result).toContain("M-MUX-2");
    expect(result).toContain("H-DF-1");
    expect(result).toContain("M-DF-2");
    expect(result).not.toContain("H-INI-1");
  });

  it("does not include self in expanded deps", () => {
    const result = expandWildcardDeps("MUX-*", allIds, "H-MUX-1");
    expect(result).not.toContain("H-MUX-1");
    expect(result).toContain("M-MUX-2");
  });

  it("returns empty array when no wildcards match", () => {
    const result = expandWildcardDeps("ZZZ-*", allIds, "H-INI-1");
    expect(result).toHaveLength(0);
  });

  it("returns empty array when no wildcards present", () => {
    const result = expandWildcardDeps("H-MUX-1, H-DF-1", allIds, "H-INI-1");
    expect(result).toHaveLength(0);
  });
});

describe("parseTodos — wildcard dependencies", () => {
  it("expands wildcard deps during parsing", () => {
    const repo = setupTempRepo();
    const content = [
      "## Test Domain",
      "",
      "### Feat: First item (H-TD-1)",
      "**Priority:** High",
      "**Depends on:** None",
      "",
      "---",
      "",
      "### Feat: Second item (H-TD-2)",
      "**Priority:** High",
      "**Depends on:** None",
      "",
      "---",
      "",
      "## Other Domain",
      "",
      "### Feat: Depends on all TD items (M-OT-1)",
      "**Priority:** Medium",
      "**Depends on:** TD-*",
      "",
      "---",
    ].join("\n");
    writeFileSync(join(repo, "TODOS.md"), content);

    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    const mot1 = byId.get("M-OT-1")!;
    expect(mot1.dependencies).toContain("H-TD-1");
    expect(mot1.dependencies).toContain("H-TD-2");
  });

  it("mixes literal and wildcard deps", () => {
    const repo = setupTempRepo();
    const content = [
      "## Alpha",
      "",
      "### Feat: A1 (H-AL-1)",
      "**Priority:** High",
      "**Depends on:** None",
      "",
      "---",
      "",
      "### Feat: A2 (M-AL-2)",
      "**Priority:** Medium",
      "**Depends on:** None",
      "",
      "---",
      "",
      "## Beta",
      "",
      "### Feat: B1 (H-BE-1)",
      "**Priority:** High",
      "**Depends on:** None",
      "",
      "---",
      "",
      "### Feat: Depends on A1 and all Beta (M-GA-1)",
      "**Priority:** Medium",
      "**Depends on:** H-AL-1, BE-*",
      "",
      "---",
    ].join("\n");
    writeFileSync(join(repo, "TODOS.md"), content);

    const items = parseTodos(join(repo, "TODOS.md"), join(repo, ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    const mga1 = byId.get("M-GA-1")!;
    expect(mga1.dependencies).toContain("H-AL-1"); // literal
    expect(mga1.dependencies).toContain("H-BE-1"); // wildcard expanded
    expect(mga1.dependencies).not.toContain("M-AL-2"); // not matched
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
