// Tests for alphabetic suffix support in work item ID parsing.
// Verifies that IDs like H-CP-7a, H-CP-7b are recognized across all patterns.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ID_PATTERN,
  ID_PATTERN_GLOBAL,
  ID_IN_PARENS,
  ID_IN_FILENAME,
  ID_PATTERN_SOURCE,
} from "../core/types.ts";
import { parseWorkItemFile, listWorkItems, readWorkItem } from "../core/work-item-files.ts";
import { normalizeTitleForComparison } from "../core/work-item-files.ts";
import { setupTempRepoWithRemote, commitAndPushWorkItem, cleanupTempRepos } from "./helpers.ts";

// Track temp dirs for cleanup
const tempDirs: string[] = [];

function makeTempDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "nw-idsuffix-"));
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

// --- ID_PATTERN ---

describe("ID_PATTERN with suffixes", () => {
  it("matches plain ID (no suffix)", () => {
    expect("H-CP-7".match(ID_PATTERN)?.[0]).toBe("H-CP-7");
  });

  it("matches single-letter suffix", () => {
    expect("H-CP-7a".match(ID_PATTERN)?.[0]).toBe("H-CP-7a");
  });

  it("matches second suffix letter", () => {
    expect("H-CP-7b".match(ID_PATTERN)?.[0]).toBe("H-CP-7b");
  });

  it("matches multi-letter suffix", () => {
    expect("H-CP-7ab".match(ID_PATTERN)?.[0]).toBe("H-CP-7ab");
  });

  it("does not match uppercase suffix", () => {
    // Uppercase after the number is NOT part of the suffix
    const m = "H-CP-7A".match(ID_PATTERN);
    expect(m?.[0]).toBe("H-CP-7");
  });
});

// --- ID_PATTERN_GLOBAL ---

describe("ID_PATTERN_GLOBAL with suffixes", () => {
  it("matches multiple suffixed IDs in a string", () => {
    const text = "Depends on: H-CP-7a, H-CP-7b, M-WRK-3";
    const matches = text.match(ID_PATTERN_GLOBAL);
    expect(matches).toEqual(["H-CP-7a", "H-CP-7b", "M-WRK-3"]);
  });

  it("matches mix of suffixed and plain IDs", () => {
    const text = "H-CP-7a and H-CP-7 and H-CP-7b";
    const matches = text.match(ID_PATTERN_GLOBAL);
    expect(matches).toEqual(["H-CP-7a", "H-CP-7", "H-CP-7b"]);
  });
});

// --- ID_IN_PARENS ---

describe("ID_IN_PARENS with suffixes", () => {
  it("captures suffixed ID in parentheses", () => {
    const line = "# Fix: Support suffixes (H-CP-7a)";
    const m = line.match(ID_IN_PARENS);
    expect(m?.[1]).toBe("H-CP-7a");
  });

  it("captures plain ID in parentheses", () => {
    const line = "# Fix: Support suffixes (H-CP-7)";
    const m = line.match(ID_IN_PARENS);
    expect(m?.[1]).toBe("H-CP-7");
  });

  it("captures multi-letter suffix in parentheses", () => {
    const line = "# Fix: Support suffixes (H-CP-7ab)";
    const m = line.match(ID_IN_PARENS);
    expect(m?.[1]).toBe("H-CP-7ab");
  });
});

// --- ID_IN_FILENAME ---

describe("ID_IN_FILENAME with suffixes", () => {
  it("extracts suffixed ID from filename", () => {
    const m = "1-cli-parsing--H-CP-7a.md".match(ID_IN_FILENAME);
    expect(m?.[1]).toBe("H-CP-7a");
  });

  it("extracts plain ID from filename", () => {
    const m = "2-worker-reliability--M-WRK-8.md".match(ID_IN_FILENAME);
    expect(m?.[1]).toBe("M-WRK-8");
  });

  it("extracts multi-letter suffix from filename", () => {
    const m = "1-domain--H-CP-7ab.md".match(ID_IN_FILENAME);
    expect(m?.[1]).toBe("H-CP-7ab");
  });

  it("does not match filename without .md extension", () => {
    const m = "1-domain--H-CP-7a.txt".match(ID_IN_FILENAME);
    expect(m).toBeNull();
  });

  it("does not match filename without -- delimiter", () => {
    const m = "1-domain-H-CP-7a.md".match(ID_IN_FILENAME);
    expect(m).toBeNull();
  });
});

// --- ID_PATTERN_SOURCE ---

describe("ID_PATTERN_SOURCE for composite regexes", () => {
  it("can build a regex that matches suffixed IDs", () => {
    const re = new RegExp(`\\(${ID_PATTERN_SOURCE}\\)`);
    expect("(H-CP-7a)".match(re)?.[0]).toBe("(H-CP-7a)");
    expect("(H-CP-7)".match(re)?.[0]).toBe("(H-CP-7)");
  });
});

// --- parseWorkItemFile with suffixed IDs ---

describe("parseWorkItemFile with suffixed IDs", () => {
  it("parses a work item file with a single-letter suffix", () => {
    const dir = makeTempDir();
    const content = `# Fix: Support suffixed IDs (H-CP-7a)

**Priority:** High
**Source:** friction report
**Depends on:** None
**Domain:** cli-parsing

Fix ID parsing to support suffixes.

Acceptance: suffixed IDs are recognized
`;
    const fp = join(dir, "1-cli-parsing--H-CP-7a.md");
    writeFileSync(fp, content);

    const item = parseWorkItemFile(fp);
    expect(item).not.toBeNull();
    expect(item!.id).toBe("H-CP-7a");
    expect(item!.title).toBe("Support suffixed IDs");
    expect(item!.priority).toBe("high");
    expect(item!.domain).toBe("cli-parsing");
  });

  it("parses dependencies with suffixed IDs", () => {
    const dir = makeTempDir();
    const content = `# Feat: Follow-up work (M-FT-2)

**Priority:** Medium
**Source:** local
**Depends on:** H-CP-7a, H-CP-7b
**Domain:** features

Follow-up after the suffixed items.
`;
    const fp = join(dir, "2-features--M-FT-2.md");
    writeFileSync(fp, content);

    const item = parseWorkItemFile(fp);
    expect(item).not.toBeNull();
    expect(item!.dependencies).toEqual(["H-CP-7a", "H-CP-7b"]);
  });

  it("parses multi-letter suffix", () => {
    const dir = makeTempDir();
    const content = `# Fix: Multi-suffix (H-CP-7ab)

**Priority:** High
**Source:** test
**Depends on:** None
**Domain:** testing
`;
    const fp = join(dir, "1-testing--H-CP-7ab.md");
    writeFileSync(fp, content);

    const item = parseWorkItemFile(fp);
    expect(item).not.toBeNull();
    expect(item!.id).toBe("H-CP-7ab");
  });
});

// --- listWorkItems with suffixed IDs ---

describe("listWorkItems with suffixed IDs", () => {
  it("lists both suffixed and plain IDs correctly", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    const worktreeDir = join(repo, ".ninthwave", "worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    commitAndPushWorkItem(
      repo,
      "1-parsing--H-CP-7a.md",
      `# Fix A (H-CP-7a)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** parsing
`,
    );

    commitAndPushWorkItem(
      repo,
      "1-parsing--H-CP-7b.md",
      `# Fix B (H-CP-7b)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** parsing
`,
    );

    commitAndPushWorkItem(
      repo,
      "2-features--M-FT-1.md",
      `# Feature (M-FT-1)

**Priority:** Medium
**Source:** local
**Depends on:** H-CP-7a, H-CP-7b
**Domain:** features
`,
    );

    const items = listWorkItems(workDir, worktreeDir);
    expect(items).toHaveLength(3);

    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["H-CP-7a", "H-CP-7b", "M-FT-1"]);

    const ft = items.find((i) => i.id === "M-FT-1")!;
    expect(ft.dependencies).toEqual(["H-CP-7a", "H-CP-7b"]);
  });
});

// --- readWorkItem with suffixed IDs ---

describe("readWorkItem with suffixed IDs", () => {
  it("finds item by suffixed ID", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");

    commitAndPushWorkItem(
      repo,
      "1-parsing--H-CP-7a.md",
      `# Fix A (H-CP-7a)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** parsing
`,
    );

    const item = readWorkItem(workDir, "H-CP-7a");
    expect(item).toBeDefined();
    expect(item!.id).toBe("H-CP-7a");
  });
});

// --- normalizeTitleForComparison with suffixed IDs ---

describe("normalizeTitleForComparison strips suffixed IDs in parens", () => {
  it("strips suffixed ID in parens", () => {
    const result = normalizeTitleForComparison("Fix: Support suffixes (H-CP-7a)");
    expect(result).toBe("support suffixes");
  });

  it("strips plain ID in parens (regression)", () => {
    const result = normalizeTitleForComparison("Fix: Support suffixes (H-CP-7)");
    expect(result).toBe("support suffixes");
  });

  it("strips multi-letter suffix in parens", () => {
    const result = normalizeTitleForComparison("Fix: Multi (H-CP-7ab)");
    expect(result).toBe("multi");
  });
});
