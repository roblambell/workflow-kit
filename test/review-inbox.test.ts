import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  cleanupTempRepos,
  captureOutput,
  setupTempRepo,
} from "./helpers.ts";
import { cmdReviewInbox } from "../core/commands/review-inbox.ts";
import { lookupCommand } from "../core/help.ts";
import {
  reviewInboxBranchName,
  runReviewInbox,
  type ReviewBranchSyncResult,
  type ReviewInboxDeps,
  type ReviewInboxDomain,
} from "../core/review-inbox.ts";

function ensureInboxDir(repo: string, domain: ReviewInboxDomain): string {
  const dir = join(repo, ".ninthwave", domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitkeep"), "");
  return dir;
}

function writeInboxEntry(
  repo: string,
  domain: ReviewInboxDomain,
  filename: string,
  content: string,
): string {
  const dir = ensureInboxDir(repo, domain);
  const path = join(dir, filename);
  writeFileSync(path, content);
  return path;
}

function makeDeps(
  overrides: Partial<ReviewInboxDeps> = {},
): ReviewInboxDeps & {
  ensureDomainLabels: ReturnType<typeof vi.fn>;
  findOpenPrByHeadBranch: ReturnType<typeof vi.fn>;
  updatePrBody: ReturnType<typeof vi.fn>;
  getDefaultBranch: ReturnType<typeof vi.fn>;
  createPullRequest: ReturnType<typeof vi.fn>;
  closePullRequest: ReturnType<typeof vi.fn>;
  syncReviewBranch: ReturnType<typeof vi.fn>;
} {
  const ensureDomainLabels = vi.fn();
  const findOpenPrByHeadBranch = vi.fn(() => null);
  const updatePrBody = vi.fn(() => true);
  const getDefaultBranch = vi.fn(() => "main");
  const createPullRequest = vi.fn(() => ({ number: 101, url: "https://example.test/pr/101" }));
  const closePullRequest = vi.fn(() => true);
  const syncReviewBranch = vi.fn(
    (
      _repoRoot: string,
      domain: ReviewInboxDomain,
      _baseBranch: string,
      relativePaths: string[],
    ): ReviewBranchSyncResult => ({
      branchName: reviewInboxBranchName(domain),
      worktreePath: `/tmp/${domain}`,
      deletedPaths: relativePaths,
      changed: relativePaths.length > 0,
    }),
  );

  return {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    run: vi.fn(),
    ensureDomainLabels,
    findOpenPrByHeadBranch,
    updatePrBody,
    getDefaultBranch,
    findWorktreeForBranch: vi.fn(() => null),
    createPullRequest,
    closePullRequest,
    syncReviewBranch,
    ...overrides,
  } as ReviewInboxDeps & {
    ensureDomainLabels: ReturnType<typeof vi.fn>;
    findOpenPrByHeadBranch: ReturnType<typeof vi.fn>;
    updatePrBody: ReturnType<typeof vi.fn>;
    getDefaultBranch: ReturnType<typeof vi.fn>;
    createPullRequest: ReturnType<typeof vi.fn>;
    closePullRequest: ReturnType<typeof vi.fn>;
    syncReviewBranch: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => cleanupTempRepos());

describe("runReviewInbox", () => {
  it("reuses an open friction PR, renders details prompts, and deletes reviewed files on the review branch", () => {
    const repo = setupTempRepo();
    writeInboxEntry(
      repo,
      "friction",
      "2026-04-03T10-00-00Z--H-CLI-1.md",
      `item: H-CLI-1
date: 2026-04-03T10:00:00Z
severity: high
description: nw inbox --wait timed out without telling the worker to rerun the wait command.
`,
    );
    writeInboxEntry(
      repo,
      "friction",
      "2026-04-03T11-00-00Z--H-CLI-2.md",
      `item: H-CLI-2
date: 2026-04-03T11:00:00Z
severity: low
description: review sessions did not make it obvious which branch owned the PR.
`,
    );

    const deps = makeDeps();
    deps.findOpenPrByHeadBranch.mockReturnValue({
      number: 42,
      title: "chore: review friction inbox",
      body: "stale body",
    });

    const result = runReviewInbox(repo, "friction", deps);

    expect(result.action).toBe("updated");
    expect(result.prNumber).toBe(42);
    expect(result.reviewedPaths).toEqual([
      ".ninthwave/friction/2026-04-03T10-00-00Z--H-CLI-1.md",
      ".ninthwave/friction/2026-04-03T11-00-00Z--H-CLI-2.md",
    ]);
    expect(deps.syncReviewBranch).toHaveBeenCalledWith(
      repo,
      "friction",
      "main",
      result.reviewedPaths,
    );
    expect(deps.updatePrBody).toHaveBeenCalledWith(
      repo,
      42,
      expect.stringContaining("Manual review required."),
    );
    const renderedBody = deps.updatePrBody.mock.calls[0]?.[2] ?? "";
    expect(renderedBody).toContain("<details>");
    expect(renderedBody).toContain("Copy-pasteable work-item prompt");
    expect(renderedBody).toContain("Recommendation:");
    expect(renderedBody).toContain("Hard question:");
    expect(renderedBody).toContain("Do not enable auto-merge on this PR.");
    expect(renderedBody).toContain("timed out without telling the worker");
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.closePullRequest).not.toHaveBeenCalled();
    expect(deps.ensureDomainLabels).toHaveBeenCalledWith(repo, ["friction"]);
  });

  it("creates a decisions review PR with manual-review messaging and the domain label", () => {
    const repo = setupTempRepo();
    writeInboxEntry(
      repo,
      "decisions",
      "2026-04-03T12-00-00Z--H-ARCH-1.md",
      `item: H-ARCH-1
date: 2026-04-03T12:00:00Z
summary: Keep review automation deterministic.
context: The command must not rely on an LLM in the hot path.
decision: Render deterministic prompts and recommendations from the inbox entry fields.
rationale: The review workflow has to stay auditable.
`,
    );

    const deps = makeDeps();
    const result = runReviewInbox(repo, "decisions", deps);

    expect(result.action).toBe("created");
    expect(result.prNumber).toBe(101);
    expect(deps.createPullRequest).toHaveBeenCalledWith(
      repo,
      expect.objectContaining({
        headBranch: "review/decisions",
        baseBranch: "main",
        title: "chore: review decisions inbox",
        label: "domain:decisions",
      }),
    );
    const createArgs = deps.createPullRequest.mock.calls[0]?.[1];
    expect(createArgs.body).toContain("Keep review automation deterministic.");
    expect(createArgs.body).toContain("Manual review required.");
    expect(createArgs.body).toContain("Do not enable auto-merge on this PR.");
    expect(createArgs.body).toContain("What evidence or constraint is still missing");
  });

  it("closes the existing review PR when the inbox only contains .gitkeep", () => {
    const repo = setupTempRepo();
    ensureInboxDir(repo, "friction");

    const deps = makeDeps();
    deps.findOpenPrByHeadBranch.mockReturnValue({
      number: 77,
      title: "chore: review friction inbox",
      body: "",
    });

    const result = runReviewInbox(repo, "friction", deps);

    expect(result.action).toBe("closed");
    expect(result.prNumber).toBe(77);
    expect(deps.closePullRequest).toHaveBeenCalledWith(
      repo,
      77,
      expect.stringContaining("friction inbox is empty"),
    );
    expect(deps.syncReviewBranch).not.toHaveBeenCalled();
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.updatePrBody).not.toHaveBeenCalled();
  });

  it("no-ops when only one domain has entries and the target inbox is otherwise empty", () => {
    const repo = setupTempRepo();
    ensureInboxDir(repo, "decisions");
    writeInboxEntry(
      repo,
      "friction",
      "2026-04-03T13-00-00Z--H-CLI-3.md",
      `item: H-CLI-3
date: 2026-04-03T13:00:00Z
severity: medium
description: another friction note that belongs to the other domain.
`,
    );

    const deps = makeDeps();
    const result = runReviewInbox(repo, "decisions", deps);

    expect(result.action).toBe("noop");
    expect(result.entryCount).toBe(0);
    expect(deps.closePullRequest).not.toHaveBeenCalled();
    expect(deps.syncReviewBranch).not.toHaveBeenCalled();
  });
});

describe("cmdReviewInbox", () => {
  it("dispatches to the review-inbox runner and prints a concise status line", () => {
    const runReviewInbox = vi.fn(() => ({
      action: "created" as const,
      domain: "friction" as const,
      entryCount: 1,
      reviewedPaths: [".ninthwave/friction/example.md"],
      branchName: "review/friction",
      baseBranch: "main",
      prNumber: 22,
      prBody: "body",
    }));

    const output = captureOutput(() =>
      cmdReviewInbox(["friction"], "/repo", { runReviewInbox }),
    );

    expect(runReviewInbox).toHaveBeenCalledWith("/repo", "friction");
    expect(output).toContain("Opened review PR #22 for friction.");
  });

  it("registers the review-inbox command in the help registry", () => {
    const entry = lookupCommand("review-inbox");
    expect(entry).toBeDefined();
    expect(entry?.usage).toBe("review-inbox <friction|decisions>");
  });
});
