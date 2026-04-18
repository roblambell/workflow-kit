// Tests for the directory-based work item parser.

import { describe, it, expect, afterEach } from "vitest";
import { join, dirname } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { parseWorkItems, extractFilePaths, extractTestPlan, normalizeDomain, truncateSlug, expandWildcardDeps } from "../core/parser.ts";
import { writeWorkItemFile, workItemFilename } from "../core/work-item-files.ts";
import type { WorkItem, Priority } from "../core/types.ts";
import {
  setupTempRepoWithRemote,
  cleanupTempRepos,
} from "./helpers.ts";

afterEach(() => {
  cleanupTempRepos();
});

/**
 * Helper: set up a repo whose `origin/main` already exists (via a bare
 * remote seeded by {@link setupTempRepoWithRemote}) and return its
 * `.ninthwave/work/` path. All parseWorkItems tests now source items from
 * origin/main via `git ls-tree` / `git show`, so tests stage files with
 * {@link writeRawWorkItemFile}, which commits and pushes.
 */
function setupTempRepo(): string {
  return setupTempRepoWithRemote();
}

function setupWorkItemsDir(repo: string): string {
  const workDir = join(repo, ".ninthwave", "work");
  mkdirSync(workDir, { recursive: true });
  return workDir;
}

/**
 * Write a work item file and commit+push it to origin/main so the
 * origin-main-only readers can see it. Kept under the old name so the
 * test bodies below remain near-identical to their pre-refactor shape.
 */
function writeRawWorkItemFile(workDir: string, filename: string, content: string): void {
  const repo = dirname(dirname(workDir));
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, filename), content);
  spawnSync("git", ["-C", repo, "add", join(".ninthwave", "work", filename)], { stdio: "pipe" });
  spawnSync(
    "git",
    ["-C", repo, "commit", "-m", `test: add ${filename}`, "--quiet"],
    { stdio: "pipe" },
  );
  spawnSync("git", ["-C", repo, "push", "--quiet"], { stdio: "pipe" });
}

/** Helper: create a WorkItem for writeWorkItemFile. */
function makeWorkItem(overrides: Partial<WorkItem> & { id: string; priority: Priority; domain: string; title: string }): WorkItem {
  return {
    dependencies: [],
    bundleWith: [],
    status: "open",
    filePath: "",
    rawText: "",
    filePaths: [],
    testPlan: "",
    ...overrides,
  };
}

describe("parseWorkItems -- valid items", () => {
  it("parses all 4 items from directory", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-cloud-infrastructure--M-CI-1.md", `# Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Source:** Manual request 2026-03-22
**Depends on:** None
**Domain:** cloud-infrastructure

Upgrade test CI runners from 2 to 4 vCPUs for faster execution.

**Test plan:**
- Verify updated workflow YAML specifies 4 vCPU runner labels
- Check deploy workflows still reference 2 vCPU runners
- Edge case: ensure ARM vs x86 platform is unchanged

Acceptance: Test workflows use 4 vCPU runners. Deploy workflows remain on 2 vCPU.

Key files: \`.github/workflows/test-api.yml\`, \`.github/workflows/ci.yml\`
`);

    writeRawWorkItemFile(workDir, "1-cloud-infrastructure--H-CI-2.md", `# Flaky connection pool timeout (H-CI-2)

**Priority:** High
**Source:** Eng review 2026-03-22
**Depends on:** M-CI-1
**Domain:** cloud-infrastructure

Fix intermittent connection pool timeout errors in test suite by increasing pool size.

**Test plan:**
- Add unit test for pool size env var override
- Run full test suite to confirm no more timeout errors

Acceptance: No more timeout errors in CI. Pool size configurable via env var.

Key files: \`config/test.exs\`
`);

    writeRawWorkItemFile(workDir, "0-user-onboarding--C-UO-1.md", `# Add welcome email (C-UO-1)

**Priority:** Critical
**Source:** Product review 2026-03-20
**Depends on:** None
**Domain:** user-onboarding

Send a welcome email when a new user completes onboarding.

Acceptance: Email sent within 30s of onboarding completion. Email contains user name.

Key files: \`lib/onboarding/email.ex\`, \`lib/mailer.ex\`
`);

    writeRawWorkItemFile(workDir, "1-user-onboarding--H-UO-2.md", `# Add onboarding checklist (H-UO-2)

**Priority:** High
**Source:** Product review 2026-03-20
**Depends on:** C-UO-1, M-CI-1
**Bundle with:** H-CI-2
**Domain:** user-onboarding

Display an onboarding checklist on the dashboard after signup.

Acceptance: Checklist shows on first login. Items check off as completed.

Key files: \`lib/onboarding/checklist.ex\`, \`assets/js/checklist.tsx\`
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items).toHaveLength(4);
  });

  it("extracts correct IDs", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-cloud-infrastructure--M-CI-1.md", `# Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** cloud-infrastructure

Acceptance: Runners upgraded.
`);

    writeRawWorkItemFile(workDir, "1-cloud-infrastructure--H-CI-2.md", `# Flaky connection pool timeout (H-CI-2)

**Priority:** High
**Depends on:** M-CI-1
**Domain:** cloud-infrastructure

Acceptance: Fixed.
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const ids = items.map((i) => i.id);
    expect(ids).toContain("M-CI-1");
    expect(ids).toContain("H-CI-2");
  });

  it("extracts correct priorities", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-test--M-CI-1.md", `# Item (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** test
`);

    writeRawWorkItemFile(workDir, "1-test--H-CI-2.md", `# Item (H-CI-2)

**Priority:** High
**Depends on:** None
**Domain:** test
`);

    writeRawWorkItemFile(workDir, "0-test--C-UO-1.md", `# Item (C-UO-1)

**Priority:** Critical
**Depends on:** None
**Domain:** test
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-CI-1")!.priority).toBe("medium");
    expect(byId.get("H-CI-2")!.priority).toBe("high");
    expect(byId.get("C-UO-1")!.priority).toBe("critical");
  });

  it("extracts correct titles", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-test--M-CI-1.md", `# Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** test
`);

    writeRawWorkItemFile(workDir, "1-test--H-CI-2.md", `# Flaky connection pool timeout (H-CI-2)

**Priority:** High
**Depends on:** None
**Domain:** test
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-CI-1")!.title).toContain("Upgrade CI runners");
    expect(byId.get("H-CI-2")!.title).toContain("Flaky connection pool timeout");
  });

  it("extracts correct domains", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-cloud-infrastructure--M-CI-1.md", `# Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** cloud-infrastructure
`);

    writeRawWorkItemFile(workDir, "1-user-onboarding--H-UO-2.md", `# Add onboarding checklist (H-UO-2)

**Priority:** High
**Depends on:** None
**Domain:** user-onboarding
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-CI-1")!.domain).toBe("cloud-infrastructure");
    expect(byId.get("H-UO-2")!.domain).toBe("user-onboarding");
  });

  it("extracts dependencies", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-test--M-CI-1.md", `# Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** test
`);

    writeRawWorkItemFile(workDir, "1-test--H-CI-2.md", `# Flaky connection pool timeout (H-CI-2)

**Priority:** High
**Depends on:** M-CI-1
**Domain:** test
`);

    writeRawWorkItemFile(workDir, "1-test--H-UO-2.md", `# Add onboarding checklist (H-UO-2)

**Priority:** High
**Depends on:** C-UO-1, M-CI-1
**Domain:** test
`);

    writeRawWorkItemFile(workDir, "0-test--C-UO-1.md", `# Add welcome email (C-UO-1)

**Priority:** Critical
**Depends on:** None
**Domain:** test
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("H-CI-2")!.dependencies).toContain("M-CI-1");
    expect(byId.get("H-UO-2")!.dependencies).toContain("C-UO-1");
    expect(byId.get("H-UO-2")!.dependencies).toContain("M-CI-1");
  });

  it("extracts bundle-with", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "1-test--H-UO-2.md", `# Add onboarding checklist (H-UO-2)

**Priority:** High
**Depends on:** None
**Bundle with:** H-CI-2
**Domain:** test
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items[0]!.bundleWith).toContain("H-CI-2");
  });

  it("all items have open status when no worktrees exist", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-test--M-CI-1.md", `# Item (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** test
`);

    writeRawWorkItemFile(workDir, "1-test--H-CI-2.md", `# Item (H-CI-2)

**Priority:** High
**Depends on:** None
**Domain:** test
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));

    for (const item of items) {
      expect(item.status).toBe("open");
    }
  });

  it("extracts file paths from Key files line", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-test--M-CI-1.md", `# Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** test

Acceptance: Runners upgraded.

Key files: \`.github/workflows/test-api.yml\`, \`.github/workflows/ci.yml\`
`);

    writeRawWorkItemFile(workDir, "1-test--H-CI-2.md", `# Flaky connection pool timeout (H-CI-2)

**Priority:** High
**Depends on:** None
**Domain:** test

Acceptance: Fixed.

Key files: \`config/test.exs\`
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    const mci1Paths = byId.get("M-CI-1")!.filePaths;
    expect(mci1Paths).toContain(".github/workflows/test-api.yml");
    expect(mci1Paths).toContain(".github/workflows/ci.yml");

    const hci2Paths = byId.get("H-CI-2")!.filePaths;
    expect(hci2Paths).toContain("config/test.exs");
  });

  it("stores raw markdown text per item", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-test--M-CI-1.md", `# Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** test

Acceptance: Runners upgraded.
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items[0]!.rawText).toContain("Upgrade CI runners");
    expect(items[0]!.rawText).toContain("**Priority:** Medium");
  });

  it("sets filePath to the work item file path", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-test--M-CI-1.md", `# Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** test
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items[0]!.filePath).toBe(join(workDir, "2-test--M-CI-1.md"));
  });
});

describe("parseWorkItems -- items with missing optional fields", () => {
  it("parses item with no dependencies line (defaults to empty array)", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "1-test--H-BK-1.md", `# Some item (H-BK-1)

**Priority:** High
**Domain:** test

Description only.
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items).toHaveLength(1);
    expect(items[0]!.dependencies).toEqual([]);
  });

  it("skips files without priority (returns null from parseWorkItemFile)", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    // No priority line -- parseWorkItemFile returns null
    writeRawWorkItemFile(workDir, "2-test--M-BK-1.md", `# No priority item (M-BK-1)

**Depends on:** None
**Domain:** test

This item has no Priority line.
`);

    writeRawWorkItemFile(workDir, "2-test--M-BK-2.md", `# Valid item (M-BK-2)

**Priority:** Medium
**Depends on:** None
**Domain:** test

This is valid.
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    // Only the valid item is returned
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("M-BK-2");
  });

  it("skips files without ID in heading", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    // No ID in heading -- parseWorkItemFile returns null
    writeRawWorkItemFile(workDir, "2-test--no-id.md", `# Item with no ID

**Priority:** Medium
**Depends on:** None
**Domain:** test
`);

    writeRawWorkItemFile(workDir, "2-test--M-BK-3.md", `# Valid item after bad one (M-BK-3)

**Priority:** Medium
**Depends on:** None
**Domain:** test
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("M-BK-3");
  });
});

describe("parseWorkItems -- empty directory", () => {
  it("empty work items directory produces no items", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items).toHaveLength(0);
  });

  it("non-existent directory produces no items", () => {
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    // Don't create the directory

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items).toHaveLength(0);
  });
});

describe("parseWorkItems -- multi-domain items", () => {
  it("parses items with different domains", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "1-section-alpha--H-AL-1.md", `# Alpha item one (H-AL-1)

**Priority:** High
**Depends on:** None
**Domain:** section-alpha
`);

    writeRawWorkItemFile(workDir, "2-section-alpha--M-AL-2.md", `# Alpha item two (M-AL-2)

**Priority:** Medium
**Depends on:** H-AL-1
**Domain:** section-alpha
`);

    writeRawWorkItemFile(workDir, "1-section-beta--H-BE-1.md", `# Beta item one (H-BE-1)

**Priority:** High
**Depends on:** None
**Domain:** section-beta
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items).toHaveLength(3);

    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("H-AL-1")!.domain).toBe("section-alpha");
    expect(byId.get("M-AL-2")!.domain).toBe("section-alpha");
    expect(byId.get("H-BE-1")!.domain).toBe("section-beta");
  });

  it("extracts cross-domain dependencies", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "1-alpha--H-AL-1.md", `# Alpha item (H-AL-1)

**Priority:** High
**Depends on:** None
**Domain:** alpha
`);

    writeRawWorkItemFile(workDir, "2-alpha--M-AL-2.md", `# Alpha item two (M-AL-2)

**Priority:** Medium
**Depends on:** H-AL-1
**Domain:** alpha
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-AL-2")!.dependencies).toContain("H-AL-1");
  });
});

describe("parseWorkItems -- in-progress detection", () => {
  it("detects in-progress from worktree directories", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-test--M-CI-1.md", `# Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** test
`);

    writeRawWorkItemFile(workDir, "1-test--H-CI-2.md", `# Flaky timeout (H-CI-2)

**Priority:** High
**Depends on:** M-CI-1
**Domain:** test
`);

    // Create a worktree dir for M-CI-1
    const wtDir = join(repo, ".ninthwave", ".worktrees", "ninthwave-M-CI-1");
    mkdirSync(wtDir, { recursive: true });

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("M-CI-1")!.status).toBe("in-progress");
    expect(byId.get("H-CI-2")!.status).toBe("open");
  });

});

describe("parseWorkItems -- circular deps", () => {
  it("parses all 3 circular dep items", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "1-circular--H-CC-1.md", `# Item A depends on B (H-CC-1)

**Priority:** High
**Depends on:** H-CC-2
**Domain:** circular
`);

    writeRawWorkItemFile(workDir, "1-circular--H-CC-2.md", `# Item B depends on C (H-CC-2)

**Priority:** High
**Depends on:** H-CC-3
**Domain:** circular
`);

    writeRawWorkItemFile(workDir, "1-circular--H-CC-3.md", `# Item C depends on A (H-CC-3)

**Priority:** High
**Depends on:** H-CC-1
**Domain:** circular
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items).toHaveLength(3);
  });

  it("captures circular dependency references", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "1-circular--H-CC-1.md", `# Item A (H-CC-1)

**Priority:** High
**Depends on:** H-CC-2
**Domain:** circular
`);

    writeRawWorkItemFile(workDir, "1-circular--H-CC-2.md", `# Item B (H-CC-2)

**Priority:** High
**Depends on:** H-CC-3
**Domain:** circular
`);

    writeRawWorkItemFile(workDir, "1-circular--H-CC-3.md", `# Item C (H-CC-3)

**Priority:** High
**Depends on:** H-CC-1
**Domain:** circular
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
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

  it("strips parenthetical annotations -- v2 rewrite", () => {
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
    // Should not cut mid-word -- must end at a hyphen boundary
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

  it("returns auto-slug for all inputs (no custom mappings)", () => {
    expect(normalizeDomain("Cloud Infrastructure")).toBe("cloud-infrastructure");
    expect(normalizeDomain("Authentication Service")).toBe("authentication-service");
    expect(normalizeDomain("User Onboarding")).toBe("user-onboarding");
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

describe("parseWorkItems -- test plan extraction", () => {
  it("extracts test plan from items that have one", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "2-test--M-CI-1.md", `# Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Depends on:** None
**Domain:** test

**Test plan:**
- Verify updated workflow YAML specifies 4 vCPU runner labels
- Check deploy workflows still reference 2 vCPU runners
- Edge case: ensure ARM vs x86 platform is unchanged

Acceptance: Test workflows use 4 vCPU runners.
`);

    writeRawWorkItemFile(workDir, "1-test--H-CI-2.md", `# Flaky timeout (H-CI-2)

**Priority:** High
**Depends on:** None
**Domain:** test

**Test plan:**
- Add unit test for pool size env var override
- Run full test suite to confirm no more timeout errors

Acceptance: Fixed.
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    const mci1Plan = byId.get("M-CI-1")!.testPlan;
    expect(mci1Plan).toContain("4 vCPU runner labels");
    expect(mci1Plan).toContain("ARM vs x86");

    const hci2Plan = byId.get("H-CI-2")!.testPlan;
    expect(hci2Plan).toContain("pool size env var");
  });

  it("returns empty string for items without test plan", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "0-test--C-UO-1.md", `# Add welcome email (C-UO-1)

**Priority:** Critical
**Depends on:** None
**Domain:** test

Acceptance: Email sent.
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items[0]!.testPlan).toBe("");
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
      "- Write unit test for parseWorkItems with new field",
      "- Verify existing integration tests still pass",
      "- Edge case: missing test plan defaults to empty",
      "",
      "Acceptance: Tests pass.",
    ].join("\n");

    const plan = extractTestPlan(raw);
    expect(plan).toContain("Write unit test for parseWorkItems");
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

describe("parseWorkItems -- wildcard dependencies", () => {
  it("expands wildcard deps during parsing", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "1-test-domain--H-TD-1.md", `# First item (H-TD-1)

**Priority:** High
**Depends on:** None
**Domain:** test-domain
`);

    writeRawWorkItemFile(workDir, "1-test-domain--H-TD-2.md", `# Second item (H-TD-2)

**Priority:** High
**Depends on:** None
**Domain:** test-domain
`);

    writeRawWorkItemFile(workDir, "2-other-domain--M-OT-1.md", `# Depends on all TD items (M-OT-1)

**Priority:** Medium
**Depends on:** TD-*
**Domain:** other-domain
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    const mot1 = byId.get("M-OT-1")!;
    expect(mot1.dependencies).toContain("H-TD-1");
    expect(mot1.dependencies).toContain("H-TD-2");
  });

  it("mixes literal and wildcard deps", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    writeRawWorkItemFile(workDir, "1-alpha--H-AL-1.md", `# A1 (H-AL-1)

**Priority:** High
**Depends on:** None
**Domain:** alpha
`);

    writeRawWorkItemFile(workDir, "2-alpha--M-AL-2.md", `# A2 (M-AL-2)

**Priority:** Medium
**Depends on:** None
**Domain:** alpha
`);

    writeRawWorkItemFile(workDir, "1-beta--H-BE-1.md", `# B1 (H-BE-1)

**Priority:** High
**Depends on:** None
**Domain:** beta
`);

    writeRawWorkItemFile(workDir, "2-gamma--M-GA-1.md", `# Depends on A1 and all Beta (M-GA-1)

**Priority:** Medium
**Depends on:** H-AL-1, BE-*
**Domain:** gamma
`);

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    const byId = new Map(items.map((i) => [i.id, i]));

    const mga1 = byId.get("M-GA-1")!;
    expect(mga1.dependencies).toContain("H-AL-1"); // literal
    expect(mga1.dependencies).toContain("H-BE-1"); // wildcard expanded
    expect(mga1.dependencies).not.toContain("M-AL-2"); // not matched
  });
});

describe("parseWorkItems -- writeWorkItemFile round-trip", () => {
  it("items written with writeWorkItemFile can be parsed back", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);

    const item = makeWorkItem({
      id: "H-RT-1",
      priority: "high",
      domain: "round-trip",
      title: "Round trip test",
      dependencies: ["M-RT-2"],
      rawText: `# Round trip test (H-RT-1)

**Priority:** High
**Source:** local
**Depends on:** M-RT-2
**Domain:** round-trip

Description of the item.

Acceptance: Item round-trips correctly.
`,
    });

    writeWorkItemFile(workDir, item);
    // Land the file on origin/main so parseWorkItems (which sources from
    // origin-main via git plumbing) can see it.
    spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "commit", "-m", "round-trip", "--quiet"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "push", "--quiet"], { stdio: "pipe" });

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("H-RT-1");
    expect(items[0]!.priority).toBe("high");
    expect(items[0]!.domain).toBe("round-trip");
    expect(items[0]!.dependencies).toContain("M-RT-2");
  });
});

// Helper: create a minimal WorkItem with the given rawText
function fakeItem(rawText: string) {
  return {
    id: "X-TEST-1",
    priority: "medium" as const,
    title: "Test",
    domain: "test",
    dependencies: [],
    bundleWith: [],
    status: "open" as const,
    filePath: "",
    rawText,
    filePaths: [],
  };
}
