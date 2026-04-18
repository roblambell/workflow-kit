// Tests for core/work-item-files.ts -- file-per-item operations.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  workItemFilename,
  parseWorkItemFile,
  parseWorkItemReferenceBlock,
  prMetadataMatchesWorkItem,
  writeWorkItemFile,
  listWorkItems,
  readWorkItem,
  deleteWorkItemFile,
  priorityNum,
  isPriority,
  extractBody,
  extractDescriptionSnippet,
} from "../core/work-item-files.ts";
import type { WorkItem, Priority } from "../core/types.ts";
import {
  setupTempRepoWithRemote,
  cleanupTempRepos,
  commitAndPushWorkItem,
} from "./helpers.ts";

// Track temp dirs for cleanup
const tempDirs: string[] = [];
const FIXTURE_LINEAGE = "8d641d84-5065-4e72-8b72-c087812ef2cb";

function makeTempDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "nw-todofiles-"));
  tempDirs.push(tmp);
  return tmp;
}

afterEach(() => {
  for (const d of tempDirs) {
    if (existsSync(d)) {
      rmSync(d, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
  cleanupTempRepos();
});

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "M-WRK-8",
    priority: "medium",
    title: "Improve worker reliability",
    domain: "worker-reliability",
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

function writeWellFormedFile(dir: string, filename: string): string {
  const content = `# Improve worker reliability (M-WRK-8)

**Priority:** Medium
**Source:** local
**Depends on:** None
**Domain:** worker-reliability
**Lineage:** ${FIXTURE_LINEAGE}

Description of the work to do.

**Test plan:**
- Run unit tests
- Check edge cases

Acceptance: all tests pass

Key files: \`core/worker.ts\`, \`core/retry.ts\`
`;
  const fp = join(dir, filename);
  writeFileSync(fp, content);
  return fp;
}

// --- workItemFilename ---

describe("workItemFilename", () => {
  it("produces correct format", () => {
    const name = workItemFilename({
      id: "M-WRK-8",
      priority: "medium",
      domain: "worker-reliability",
    });
    expect(name).toBe("2-worker-reliability--M-WRK-8.md");
  });

  it("uses correct priority numbers", () => {
    expect(workItemFilename({ id: "C-X-1", priority: "critical", domain: "d" })).toBe(
      "0-d--C-X-1.md",
    );
    expect(workItemFilename({ id: "H-X-1", priority: "high", domain: "d" })).toBe(
      "1-d--H-X-1.md",
    );
    expect(workItemFilename({ id: "M-X-1", priority: "medium", domain: "d" })).toBe(
      "2-d--M-X-1.md",
    );
    expect(workItemFilename({ id: "L-X-1", priority: "low", domain: "d" })).toBe(
      "3-d--L-X-1.md",
    );
  });
});

// --- priorityNum ---

describe("priorityNum", () => {
  it("returns correct numbers", () => {
    expect(priorityNum("critical")).toBe(0);
    expect(priorityNum("high")).toBe(1);
    expect(priorityNum("medium")).toBe(2);
    expect(priorityNum("low")).toBe(3);
  });
});

// --- parseWorkItemFile ---

describe("parseWorkItemFile", () => {
  it("extracts all fields from a well-formed file", () => {
    const dir = makeTempDir();
    const fp = writeWellFormedFile(dir, "2-worker-reliability--M-WRK-8.md");

    const item = parseWorkItemFile(fp);
    expect(item).not.toBeNull();
    expect(item!.id).toBe("M-WRK-8");
    expect(item!.priority).toBe("medium");
    expect(item!.title).toBe("Improve worker reliability");
    expect(item!.domain).toBe("worker-reliability");
    expect(item!.lineageToken).toBe(FIXTURE_LINEAGE);
    expect(item!.dependencies).toEqual([]);
    expect(item!.bundleWith).toEqual([]);
    expect(item!.status).toBe("open");
    expect(item!.filePath).toBe(fp);
    expect(item!.testPlan).toContain("Run unit tests");
    expect(item!.filePaths).toContain("core/worker.ts");
    expect(item!.filePaths).toContain("core/retry.ts");
    expect(item!.descriptionSnippet).toBe("Description of the work to do.");
  });

  it("extracts dependencies", () => {
    const dir = makeTempDir();
    const content = `# Fix bug (H-BUG-3)

**Priority:** High
**Source:** local
**Depends on:** M-WRK-8, H-BUG-1
**Domain:** bugs
`;
    const fp = join(dir, "1-bugs--H-BUG-3.md");
    writeFileSync(fp, content);

    const item = parseWorkItemFile(fp);
    expect(item).not.toBeNull();
    expect(item!.dependencies).toEqual(["M-WRK-8", "H-BUG-1"]);
  });

  it("extracts bundle-with", () => {
    const dir = makeTempDir();
    const content = `# Feature A (M-FT-1)

**Priority:** Medium
**Source:** local
**Depends on:** None
**Domain:** features
**Bundle with:** M-FT-2, M-FT-3
`;
    const fp = join(dir, "2-features--M-FT-1.md");
    writeFileSync(fp, content);

    const item = parseWorkItemFile(fp);
    expect(item).not.toBeNull();
    expect(item!.bundleWith).toEqual(["M-FT-2", "M-FT-3"]);
  });

  it("extracts requires-manual-review when explicitly enabled", () => {
    const dir = makeTempDir();
    const content = `# Sensitive change (H-SEC-1)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** security
**Requires manual review:** true
`;
    const fp = join(dir, "1-security--H-SEC-1.md");
    writeFileSync(fp, content);

    const item = parseWorkItemFile(fp);
    expect(item).not.toBeNull();
    expect(item!.requiresManualReview).toBe(true);
  });

  it("handles missing optional fields (no test plan, no key files, no bundle)", () => {
    const dir = makeTempDir();
    const content = `# Minimal item (L-MIN-1)

**Priority:** Low
**Source:** local
**Depends on:** None
**Domain:** minimal

Just a description.
`;
    const fp = join(dir, "3-minimal--L-MIN-1.md");
    writeFileSync(fp, content);

    const item = parseWorkItemFile(fp);
    expect(item).not.toBeNull();
    expect(item!.id).toBe("L-MIN-1");
    expect(item!.priority).toBe("low");
    expect(item!.lineageToken).toBeUndefined();
    expect(item!.testPlan).toBe("");
    expect(item!.filePaths).toEqual([]);
    expect(item!.bundleWith).toEqual([]);
  });

  it("returns null for invalid lineage token", () => {
    const dir = makeTempDir();
    const content = `# Invalid lineage (H-LIN-1)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** test
**Lineage:** not-a-token
`;
    const fp = join(dir, "1-test--H-LIN-1.md");
    writeFileSync(fp, content);

    expect(parseWorkItemFile(fp)).toBeNull();
  });

  it("returns null for file with no ID", () => {
    const dir = makeTempDir();
    const content = `# Some heading with no ID

**Priority:** Medium
**Domain:** broken
`;
    const fp = join(dir, "broken.md");
    writeFileSync(fp, content);

    expect(parseWorkItemFile(fp)).toBeNull();
  });

  it("returns null for file with no priority", () => {
    const dir = makeTempDir();
    const content = `# Missing priority (M-MP-1)

**Domain:** broken
`;
    const fp = join(dir, "broken2.md");
    writeFileSync(fp, content);

    expect(parseWorkItemFile(fp)).toBeNull();
  });

  it("returns null for nonexistent file", () => {
    expect(parseWorkItemFile("/tmp/does-not-exist-nw-test.md")).toBeNull();
  });

  it("returns null for invalid priority value", () => {
    const dir = makeTempDir();
    const content = `# Typo priority (M-TP-1)

**Priority:** Hgh
**Domain:** broken
`;
    const fp = join(dir, "broken3.md");
    writeFileSync(fp, content);

    expect(parseWorkItemFile(fp)).toBeNull();
  });

  it("returns null for explicit false manual-review override", () => {
    const dir = makeTempDir();
    const content = `# Invalid override (H-REV-1)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** security
**Requires manual review:** false
`;
    const fp = join(dir, "1-security--H-REV-1.md");
    writeFileSync(fp, content);

    expect(parseWorkItemFile(fp)).toBeNull();
  });
});

describe("extractDescriptionSnippet", () => {
  it("returns undefined when the body has no descriptive text", () => {
    const raw = [
      "# Title (H-T-1)",
      "",
      "**Priority:** High",
      "**Source:** local",
      "**Depends on:** None",
      "**Domain:** test",
      "",
      "**Test plan:**",
      "- Run tests",
      "",
      "Acceptance: it works",
    ].join("\n");

    expect(extractDescriptionSnippet(raw)).toBeUndefined();
  });

  it("returns the descriptive body without trailing sections", () => {
    const raw = [
      "# Title (H-T-2)",
      "",
      "**Priority:** High",
      "**Source:** local",
      "**Depends on:** None",
      "**Domain:** test",
      "",
      "Add description data to the detail model.",
      "Keep daemon payloads compact.",
      "",
      "**Test plan:**",
      "- Run parser tests",
      "",
      "Acceptance: status shows description",
    ].join("\n");

    expect(extractDescriptionSnippet(raw)).toBe(
      "Add description data to the detail model. Keep daemon payloads compact.",
    );
  });

  it("truncates long bodies to a stable snippet", () => {
    const longSentence = "This description sentence is intentionally long so the snippet extractor has to trim it cleanly at a word boundary without pulling in structured sections.";
    const raw = [
      "# Title (H-T-3)",
      "",
      "**Priority:** High",
      "**Source:** local",
      "**Depends on:** None",
      "**Domain:** test",
      "",
      longSentence,
      longSentence,
      longSentence,
    ].join("\n");

    const snippet = extractDescriptionSnippet(raw, 120);
    expect(snippet).toBeDefined();
    expect(snippet!.length).toBeLessThanOrEqual(120);
    expect(snippet).toMatch(/\.\.\.$/);
  });
});

describe("parseWorkItemReferenceBlock", () => {
  it("extracts ID and lineage token from PR metadata", () => {
    const body = [
      "## Summary",
      "Test PR",
      "",
      "## Work Item Reference",
      "ID: H-LIN-1",
      `Lineage: ${FIXTURE_LINEAGE}`,
      "Priority: High",
      "Source: Manual request",
    ].join("\n");

    expect(parseWorkItemReferenceBlock(body)).toEqual({
      id: "H-LIN-1",
      lineageToken: FIXTURE_LINEAGE,
      priority: "High",
      source: "Manual request",
    });
  });
});

describe("prMetadataMatchesWorkItem", () => {
  it("matches tokenized items by lineage token instead of title", () => {
    const item = makeWorkItem({ id: "H-LIN-1", title: "New title", lineageToken: FIXTURE_LINEAGE });
    expect(
      prMetadataMatchesWorkItem(
        { title: "old title", lineageToken: FIXTURE_LINEAGE },
        item,
      ),
    ).toBe(true);
  });

  it("rejects tokenized items when merged PR metadata lacks the lineage token", () => {
    const item = makeWorkItem({ id: "H-LIN-1", title: "New title", lineageToken: FIXTURE_LINEAGE });
    expect(
      prMetadataMatchesWorkItem(
        { title: "New title" },
        item,
      ),
    ).toBe(false);
  });

  it("keeps legacy fallback for token-less items", () => {
    const item = makeWorkItem({ id: "H-LEG-1", title: "Legacy title" });
    expect(
      prMetadataMatchesWorkItem(
        { title: "fix: legacy title (H-LEG-1)" },
        item,
      ),
    ).toBe(true);
  });
});

// --- writeWorkItemFile + parseWorkItemFile round-trip ---

describe("writeWorkItemFile + parseWorkItemFile round-trip", () => {
  it("round-trips a full item", () => {
    const dir = makeTempDir();
    const workDir = join(dir, "work");
    mkdirSync(workDir);

    const original = makeWorkItem({
      lineageToken: FIXTURE_LINEAGE,
      requiresManualReview: true,
      rawText: `# Improve worker reliability (M-WRK-8)

**Priority:** Medium
**Source:** local
**Depends on:** None
**Domain:** worker-reliability
**Requires manual review:** true

Description text here.

**Test plan:**
- Test something

Acceptance: criteria met

Key files: \`core/worker.ts\`
`,
      testPlan: "Test something",
      filePaths: ["core/worker.ts"],
      dependencies: ["H-DEP-1"],
      bundleWith: ["M-BND-2"],
    });

    writeWorkItemFile(workDir, original);

    expect(original.filePath).toBe(
      join(workDir, "2-worker-reliability--M-WRK-8.md"),
    );
    expect(existsSync(original.filePath)).toBe(true);

    const parsed = parseWorkItemFile(original.filePath);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe("M-WRK-8");
    expect(parsed!.priority).toBe("medium");
    expect(parsed!.title).toBe("Improve worker reliability");
    expect(parsed!.domain).toBe("worker-reliability");
    expect(parsed!.lineageToken).toBe(FIXTURE_LINEAGE);
    expect(parsed!.dependencies).toEqual(["H-DEP-1"]);
    expect(parsed!.bundleWith).toEqual(["M-BND-2"]);
    expect(parsed!.requiresManualReview).toBe(true);
  });

  it("stamps a lineage token for newly created items and preserves it on read", () => {
    const dir = makeTempDir();
    const workDir = join(dir, "work");
    mkdirSync(workDir);

    const original = makeWorkItem({
      id: "L-SIM-1",
      priority: "low",
      domain: "simple",
      rawText: `# Simple item (L-SIM-1)

**Priority:** Low
**Source:** local
**Depends on:** None
**Domain:** simple

Just do the thing.
`,
    });

    writeWorkItemFile(workDir, original, () => FIXTURE_LINEAGE);
    const parsed = parseWorkItemFile(original.filePath);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe("L-SIM-1");
    expect(parsed!.priority).toBe("low");
    expect(parsed!.domain).toBe("simple");
    expect(parsed!.lineageToken).toBe(FIXTURE_LINEAGE);
    expect(original.lineageToken).toBe(FIXTURE_LINEAGE);
    expect(parsed!.testPlan).toBe("");
    expect(parsed!.filePaths).toEqual([]);
  });

  it("extractBody strips the manual-review metadata line", () => {
    const raw = [
      "# Title (H-T-4)",
      "",
      "**Priority:** High",
      "**Source:** local",
      "**Depends on:** None",
      "**Domain:** test",
      "**Requires manual review:** true",
      "",
      "Do the sensitive thing.",
    ].join("\n");

    expect(extractBody(raw)).toEqual(["Do the sensitive thing."]);
  });
});

// --- listWorkItems ---

describe("listWorkItems", () => {
  it("reads work item files from origin/main", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    const worktreeDir = join(repo, ".ninthwave", "worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    commitAndPushWorkItem(
      repo,
      "1-bugs--H-BUG-1.md",
      `# Fix crash (H-BUG-1)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** bugs

Fix the crash.
`,
    );

    commitAndPushWorkItem(
      repo,
      "2-features--M-FT-1.md",
      `# Add feature (M-FT-1)

**Priority:** Medium
**Source:** local
**Depends on:** H-BUG-1
**Domain:** features

Add the feature.
`,
    );

    const items = listWorkItems(workDir, worktreeDir);
    expect(items).toHaveLength(2);

    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["H-BUG-1", "M-FT-1"]);

    const ft = items.find((i) => i.id === "M-FT-1")!;
    expect(ft.dependencies).toEqual(["H-BUG-1"]);
  });

  it("expands wildcard dependencies", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    const worktreeDir = join(repo, ".ninthwave", "worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    commitAndPushWorkItem(
      repo,
      "1-bugs--H-BUG-1.md",
      `# Fix A (H-BUG-1)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** bugs
`,
    );

    commitAndPushWorkItem(
      repo,
      "1-bugs--H-BUG-2.md",
      `# Fix B (H-BUG-2)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** bugs
`,
    );

    commitAndPushWorkItem(
      repo,
      "2-features--M-FT-1.md",
      `# Feature (M-FT-1)

**Priority:** Medium
**Source:** local
**Depends on:** BUG-*
**Domain:** features
`,
    );

    const items = listWorkItems(workDir, worktreeDir);
    const ft = items.find((i) => i.id === "M-FT-1")!;
    expect(ft.dependencies).toContain("H-BUG-1");
    expect(ft.dependencies).toContain("H-BUG-2");
  });

  it("detects in-progress status from worktree dirs", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    const worktreeDir = join(repo, ".ninthwave", "worktrees");
    mkdirSync(worktreeDir, { recursive: true });
    mkdirSync(join(worktreeDir, "ninthwave-H-BUG-1"));

    commitAndPushWorkItem(
      repo,
      "1-bugs--H-BUG-1.md",
      `# Fix crash (H-BUG-1)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** bugs
`,
    );

    commitAndPushWorkItem(
      repo,
      "2-features--M-FT-1.md",
      `# Feature (M-FT-1)

**Priority:** Medium
**Source:** local
**Depends on:** None
**Domain:** features
`,
    );

    const items = listWorkItems(workDir, worktreeDir);
    const bug = items.find((i) => i.id === "H-BUG-1")!;
    const ft = items.find((i) => i.id === "M-FT-1")!;
    expect(bug.status).toBe("in-progress");
    expect(ft.status).toBe("open");
  });

  it("returns empty array when no work items are on origin/main", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    const worktreeDir = join(repo, ".ninthwave", "worktrees");
    mkdirSync(worktreeDir, { recursive: true });
    expect(listWorkItems(workDir, worktreeDir)).toEqual([]);
  });

  it("skips malformed files on origin/main", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    const worktreeDir = join(repo, ".ninthwave", "worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    commitAndPushWorkItem(repo, "bad.md", "Not a valid work item file.");
    commitAndPushWorkItem(
      repo,
      "1-good--H-OK-1.md",
      `# Good item (H-OK-1)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** good
`,
    );

    const items = listWorkItems(workDir, worktreeDir);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("H-OK-1");
  });
});

// --- readWorkItem ---

describe("readWorkItem", () => {
  it("finds item by ID on origin/main", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");

    commitAndPushWorkItem(
      repo,
      "2-test--M-TST-1.md",
      `# Test item (M-TST-1)

**Priority:** Medium
**Source:** local
**Depends on:** None
**Domain:** test
`,
    );

    const item = readWorkItem(workDir, "M-TST-1");
    expect(item).toBeDefined();
    expect(item!.id).toBe("M-TST-1");
    expect(item!.priority).toBe("medium");
  });

  it("returns undefined for missing ID", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    expect(readWorkItem(workDir, "X-MISS-99")).toBeUndefined();
  });

  it("returns undefined when there are no work items on origin/main", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    expect(readWorkItem(workDir, "X-X-1")).toBeUndefined();
  });
});

// --- deleteWorkItemFile ---

describe("deleteWorkItemFile", () => {
  it("removes file and returns true", () => {
    const dir = makeTempDir();
    const workDir = join(dir, "work");
    mkdirSync(workDir);

    const fp = join(workDir, "2-test--M-TST-1.md");
    writeFileSync(fp, "# Item (M-TST-1)\n\n**Priority:** Medium\n**Domain:** test\n");

    expect(existsSync(fp)).toBe(true);
    const result = deleteWorkItemFile(workDir, "M-TST-1");
    expect(result).toBe(true);
    expect(existsSync(fp)).toBe(false);
  });

  it("returns false for missing ID", () => {
    const dir = makeTempDir();
    const workDir = join(dir, "work");
    mkdirSync(workDir);

    expect(deleteWorkItemFile(workDir, "X-MISS-99")).toBe(false);
  });

  it("returns false for nonexistent directory", () => {
    expect(deleteWorkItemFile("/tmp/nw-does-not-exist", "X-X-1")).toBe(false);
  });
});

// --- isPriority ---

describe("isPriority", () => {
  it("returns true for valid priorities", () => {
    expect(isPriority("critical")).toBe(true);
    expect(isPriority("high")).toBe(true);
    expect(isPriority("medium")).toBe(true);
    expect(isPriority("low")).toBe(true);
  });

  it("returns false for invalid strings", () => {
    expect(isPriority("urgent")).toBe(false);
    expect(isPriority("")).toBe(false);
    expect(isPriority("HIGH")).toBe(false);
    expect(isPriority("Critical")).toBe(false);
    expect(isPriority("none")).toBe(false);
  });

  it("rejects priority in parseWorkItemFile for unknown values", () => {
    const dir = makeTempDir();
    const fp = join(dir, "test.md");
    writeFileSync(
      fp,
      "# Test item (H-T-1)\n\n**Priority:** Urgent\n**Domain:** test\n",
    );
    expect(parseWorkItemFile(fp)).toBeNull();
  });
});

// --- extractBody ---

describe("extractBody", () => {
  it("strips metadata prefixes including Lineage", () => {
    const raw = [
      "# Title (H-T-1)",
      "",
      "**Priority:** High",
      "**Source:** local",
      "**Depends on:** None",
      "**Domain:** test",
      `**Lineage:** ${FIXTURE_LINEAGE}`,
      "",
      "Body text here.",
    ].join("\n");
    const body = extractBody(raw);
    expect(body).toEqual(["Body text here."]);
  });
});
