// Tests for the origin-main-only work item and config readers.
// Verifies that the daemon's view of work items and config is sourced from
// `origin/main` via git plumbing, independent of the user's working tree
// (stale, dirty, or locally modified).

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  setupTempRepoWithRemote,
  setupTempRepoWithoutRemote,
  registerCleanup,
  commitAndPushWorkItem,
  commitAndPushPath,
} from "./helpers.ts";
import {
  assertOriginMain,
  originMainResolves,
  listOriginMainFiles,
  readOriginMainFile,
} from "../core/git.ts";
import { parseWorkItems } from "../core/parser.ts";
import {
  listWorkItemsFromOriginMain,
  readWorkItemFromOriginMain,
} from "../core/work-item-files.ts";
import { loadConfig, loadConfigFromOriginMain } from "../core/config.ts";

const WORK_REL = ".ninthwave/work";

describe("originMainResolves / assertOriginMain", () => {
  registerCleanup();

  it("returns true when origin/main exists", () => {
    const repo = setupTempRepoWithRemote();
    expect(originMainResolves(repo)).toBe(true);
    // assertOriginMain must not throw in this case
    expect(() => assertOriginMain(repo, "ctx")).not.toThrow();
  });

  it("returns false when origin/main does not resolve", () => {
    const repo = setupTempRepoWithoutRemote();
    expect(originMainResolves(repo)).toBe(false);
  });

  it("throws an actionable error naming the missing ref and remediation", () => {
    const repo = setupTempRepoWithoutRemote();
    let caught: Error | undefined;
    try {
      assertOriginMain(repo, "my-context");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("origin/main");
    expect(caught!.message).toContain("my-context");
    expect(caught!.message).toContain("git push");
  });
});

describe("listOriginMainFiles + readOriginMainFile", () => {
  registerCleanup();

  it("lists files on origin/main and reads their contents", () => {
    const repo = setupTempRepoWithRemote();
    commitAndPushWorkItem(
      repo,
      "1-core--H-1-1.md",
      "# Item one (H-1-1)\n**Priority:** High\n**Domain:** core\n",
    );

    const files = listOriginMainFiles(repo, `${WORK_REL}/`);
    expect(files).toEqual([`${WORK_REL}/1-core--H-1-1.md`]);

    const content = readOriginMainFile(repo, `${WORK_REL}/1-core--H-1-1.md`);
    expect(content).not.toBeNull();
    expect(content!).toContain("Item one (H-1-1)");
  });

  it("returns null when the file does not exist on origin/main", () => {
    const repo = setupTempRepoWithRemote();
    const content = readOriginMainFile(repo, `${WORK_REL}/does-not-exist.md`);
    expect(content).toBeNull();
  });

  it("throws when origin/main does not resolve", () => {
    const repo = setupTempRepoWithoutRemote();
    expect(() => listOriginMainFiles(repo, `${WORK_REL}/`)).toThrow(/origin\/main/);
    expect(() => readOriginMainFile(repo, `${WORK_REL}/anything.md`)).toThrow(/origin\/main/);
  });
});

describe("parseWorkItems / listWorkItems -- origin-main sourcing", () => {
  registerCleanup();

  it("returns the exact set of items present on origin/main", () => {
    const repo = setupTempRepoWithRemote();
    commitAndPushWorkItem(
      repo,
      "1-core--H-1-1.md",
      "# One (H-1-1)\n**Priority:** High\n**Domain:** core\n",
    );
    commitAndPushWorkItem(
      repo,
      "2-tui--M-2-1.md",
      "# Two (M-2-1)\n**Priority:** Medium\n**Domain:** tui\n",
    );

    const workDir = join(repo, ".ninthwave", "work");
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    const items = parseWorkItems(workDir, worktreeDir);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["H-1-1", "M-2-1"]);
  });

  it("ignores a locally modified work item, returning the origin/main contents", () => {
    const repo = setupTempRepoWithRemote();
    commitAndPushWorkItem(
      repo,
      "1-core--H-1-1.md",
      "# Original title (H-1-1)\n**Priority:** High\n**Domain:** core\n",
    );

    // Dirty the working tree with a different title and priority
    const workDir = join(repo, ".ninthwave", "work");
    writeFileSync(
      join(workDir, "1-core--H-1-1.md"),
      "# Locally edited title (H-1-1)\n**Priority:** Low\n**Domain:** core\n",
    );

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Original title");
    expect(items[0]!.priority).toBe("high");
  });

  it("ignores a local-only work item not yet pushed to origin/main", () => {
    const repo = setupTempRepoWithRemote();
    commitAndPushWorkItem(
      repo,
      "1-core--H-1-1.md",
      "# Pushed (H-1-1)\n**Priority:** High\n**Domain:** core\n",
    );

    const workDir = join(repo, ".ninthwave", "work");
    writeFileSync(
      join(workDir, "2-local--M-9-1.md"),
      "# Local-only (M-9-1)\n**Priority:** Medium\n**Domain:** local\n",
    );

    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items.map((i) => i.id)).toEqual(["H-1-1"]);
  });

  it("still sees an item that was deleted from the working tree but exists on origin/main", () => {
    const repo = setupTempRepoWithRemote();
    commitAndPushWorkItem(
      repo,
      "1-core--H-1-1.md",
      "# Still on origin (H-1-1)\n**Priority:** High\n**Domain:** core\n",
    );

    // Delete the local copy
    unlinkSync(join(repo, ".ninthwave", "work", "1-core--H-1-1.md"));

    const workDir = join(repo, ".ninthwave", "work");
    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items.map((i) => i.id)).toEqual(["H-1-1"]);
  });

  it("returns the same items regardless of which branch the working tree is on", () => {
    const repo = setupTempRepoWithRemote();
    commitAndPushWorkItem(
      repo,
      "1-core--H-1-1.md",
      "# Shared (H-1-1)\n**Priority:** High\n**Domain:** core\n",
    );

    // Switch to a feature branch with no work items committed
    spawnSync("git", ["-C", repo, "checkout", "-b", "feature/wip", "--quiet"], { stdio: "pipe" });
    // Drop the local work item file on the feature branch
    unlinkSync(join(repo, ".ninthwave", "work", "1-core--H-1-1.md"));

    const workDir = join(repo, ".ninthwave", "work");
    const items = parseWorkItems(workDir, join(repo, ".ninthwave", ".worktrees"));
    expect(items.map((i) => i.id)).toEqual(["H-1-1"]);
  });

  it("throws an actionable error when origin/main does not resolve", () => {
    const repo = setupTempRepoWithoutRemote(); // no remote, no origin/main
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, "1-core--H-1-1.md"),
      "# Hi (H-1-1)\n**Priority:** High\n**Domain:** core\n",
    );

    let caught: Error | undefined;
    try {
      listWorkItemsFromOriginMain(workDir, join(repo, ".ninthwave", ".worktrees"));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("origin/main");
    expect(caught!.message).toContain("listWorkItems");
  });
});

describe("readWorkItemFromOriginMain", () => {
  registerCleanup();

  it("reads a work item by ID from origin/main", () => {
    const repo = setupTempRepoWithRemote();
    commitAndPushWorkItem(
      repo,
      "1-core--H-1-1.md",
      "# On origin (H-1-1)\n**Priority:** High\n**Domain:** core\n",
    );

    const workDir = join(repo, ".ninthwave", "work");
    const item = readWorkItemFromOriginMain(workDir, "H-1-1");
    expect(item).toBeDefined();
    expect(item!.title).toBe("On origin");
  });

  it("returns undefined when the ID is not on origin/main", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    expect(readWorkItemFromOriginMain(workDir, "X-MISS-99")).toBeUndefined();
  });

  it("throws when origin/main does not resolve", () => {
    const repo = setupTempRepoWithoutRemote();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });
    expect(() => readWorkItemFromOriginMain(workDir, "H-1-1")).toThrow(/origin\/main/);
  });
});

describe("loadConfig -- origin-main sourcing", () => {
  registerCleanup();

  it("reads config.json from origin/main, ignoring the working tree", () => {
    const repo = setupTempRepoWithRemote();
    commitAndPushPath(
      repo,
      ".ninthwave/config.json",
      JSON.stringify({ project_id: "11111111-1111-4111-8111-111111111111" }, null, 2),
    );

    // Dirty the working tree with a different value
    writeFileSync(
      join(repo, ".ninthwave", "config.json"),
      JSON.stringify({ project_id: "22222222-2222-4222-8222-222222222222" }, null, 2),
    );

    const config = loadConfig(repo);
    expect(config.project_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("returns empty defaults when config.json is absent on origin/main", () => {
    const repo = setupTempRepoWithRemote();
    expect(loadConfig(repo)).toEqual({});
  });

  it("loadConfigFromOriginMain throws loudly when origin/main does not resolve", () => {
    const repo = setupTempRepoWithoutRemote();
    let caught: Error | undefined;
    try {
      loadConfigFromOriginMain(repo);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("origin/main");
    expect(caught!.message).toContain("loadConfig");
  });

  it("loadConfig falls back to the working tree when origin/main does not resolve", () => {
    const repo = setupTempRepoWithoutRemote();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(repo, ".ninthwave", "config.json"),
      JSON.stringify({ crew_url: "wss://wt.example/ws" }),
    );
    expect(loadConfig(repo).crew_url).toBe("wss://wt.example/ws");
  });
});
