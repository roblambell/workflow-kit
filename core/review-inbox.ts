import {
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readdirSync as defaultReaddirSync,
  readFileSync as defaultReadFileSync,
  rmSync as defaultRmSync,
} from "fs";
import { basename, dirname, join, relative } from "path";
import { ensureWorktreeExcluded } from "./cross-repo.ts";
import {
  ensureDomainLabels as defaultEnsureDomainLabels,
  findOpenPrByHeadBranch as defaultFindOpenPrByHeadBranch,
  getDefaultBranch as defaultGetDefaultBranch,
  updatePrBody as defaultUpdatePrBody,
} from "./gh.ts";
import { findWorktreeForBranch as defaultFindWorktreeForBranch } from "./git.ts";
import { renderReviewInboxPullRequest } from "./review-inbox-render.ts";
import {
  GH_TIMEOUT,
  GIT_TIMEOUT,
  run as defaultRun,
} from "./shell.ts";
import type { RunResult } from "./types.ts";

export const REVIEW_INBOX_DOMAINS = ["friction", "decisions"] as const;
export type ReviewInboxDomain = (typeof REVIEW_INBOX_DOMAINS)[number];
export type ReviewInboxAction = "created" | "updated" | "closed" | "noop";

type SuggestedPriority = "High" | "Medium" | "Low";

export interface ReviewInboxEntry {
  domain: ReviewInboxDomain;
  filePath: string;
  relativePath: string;
  itemId: string | null;
  recordedAt: string | null;
  title: string;
  summary: string;
  recommendation: string;
  hardQuestion: string;
  suggestedPriority: SuggestedPriority;
  prompt: string;
}

export interface ReviewBranchSyncResult {
  branchName: string;
  worktreePath: string;
  deletedPaths: string[];
  changed: boolean;
}

export interface ReviewInboxRunResult {
  action: ReviewInboxAction;
  domain: ReviewInboxDomain;
  entryCount: number;
  reviewedPaths: string[];
  branchName: string;
  baseBranch: string;
  prNumber?: number;
  prBody?: string;
}

export interface ReviewInboxDeps {
  existsSync: typeof defaultExistsSync;
  mkdirSync: typeof defaultMkdirSync;
  readdirSync: typeof defaultReaddirSync;
  readFileSync: typeof defaultReadFileSync;
  rmSync: typeof defaultRmSync;
  run: typeof defaultRun;
  ensureDomainLabels: typeof defaultEnsureDomainLabels;
  findOpenPrByHeadBranch: typeof defaultFindOpenPrByHeadBranch;
  updatePrBody: typeof defaultUpdatePrBody;
  getDefaultBranch: typeof defaultGetDefaultBranch;
  findWorktreeForBranch: typeof defaultFindWorktreeForBranch;
  createPullRequest: (
    repoRoot: string,
    options: {
      headBranch: string;
      baseBranch: string;
      title: string;
      body: string;
      label: string;
    },
  ) => { number: number; url?: string } | null;
  closePullRequest: (
    repoRoot: string,
    prNumber: number,
    comment: string,
  ) => boolean;
  syncReviewBranch: (
    repoRoot: string,
    domain: ReviewInboxDomain,
    baseBranch: string,
    relativePaths: string[],
  ) => ReviewBranchSyncResult;
}

function defaultCreatePullRequest(
  repoRoot: string,
  options: {
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
    label: string;
  },
): { number: number; url?: string } | null {
  const result = defaultRun(
    "gh",
    [
      "pr",
      "create",
      "--head",
      options.headBranch,
      "--base",
      options.baseBranch,
      "--title",
      options.title,
      "--body",
      options.body,
      "--label",
      options.label,
    ],
    { cwd: repoRoot, timeout: GH_TIMEOUT },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `gh pr create failed for ${options.headBranch}`);
  }

  const pr = defaultFindOpenPrByHeadBranch(repoRoot, options.headBranch);
  if (!pr) {
    throw new Error(`Could not resolve PR number for ${options.headBranch}`);
  }

  return { number: pr.number, url: result.stdout || undefined };
}

function defaultClosePullRequest(
  repoRoot: string,
  prNumber: number,
  comment: string,
): boolean {
  const result = defaultRun(
    "gh",
    [
      "pr",
      "close",
      String(prNumber),
      "--comment",
      comment,
    ],
    { cwd: repoRoot, timeout: GH_TIMEOUT },
  );
  return result.exitCode === 0;
}

function reviewInboxDir(projectRoot: string, domain: ReviewInboxDomain): string {
  return join(projectRoot, ".ninthwave", domain);
}

export function reviewInboxBranchName(domain: ReviewInboxDomain): string {
  return `review/${domain}`;
}

export function reviewInboxPrTitle(domain: ReviewInboxDomain): string {
  return `chore: review ${domain} inbox`;
}

export function isReviewInboxDomain(value: string): value is ReviewInboxDomain {
  return (REVIEW_INBOX_DOMAINS as readonly string[]).includes(value);
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstSentence(value: string, fallback: string): string {
  const text = compactText(value);
  if (!text) return fallback;
  const sentence = text.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? text;
  return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}...` : sentence;
}

function titleCaseFrom(value: string, fallback: string): string {
  const text = compactText(value || fallback);
  if (!text) return fallback;
  return text.length > 96 ? `${text.slice(0, 93).trimEnd()}...` : text;
}

function parseInboxFields(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    const match = line.match(/^([a-z0-9_-]+):\s*(.*)$/i);
    if (match) {
      currentKey = match[1]!.toLowerCase();
      fields[currentKey] = match[2]!.trim();
      continue;
    }

    if (!currentKey) continue;
    const continuation = line.trim();
    if (!continuation) continue;
    fields[currentKey] = fields[currentKey]
      ? `${fields[currentKey]}\n${continuation}`
      : continuation;
  }

  return fields;
}

function suggestedPriority(
  domain: ReviewInboxDomain,
  fields: Record<string, string>,
): SuggestedPriority {
  if (domain === "friction") {
    const severity = compactText(fields.severity ?? "").toLowerCase();
    if (severity === "high") return "High";
    if (severity === "low") return "Low";
  }
  return "Medium";
}

function buildRecommendation(
  domain: ReviewInboxDomain,
  title: string,
): string {
  if (domain === "friction") {
    return `Land the smallest durable change that removes "${title}" for the next operator or worker.`;
  }
  return `Turn "${title}" into an explicit follow-up item that captures the tradeoff, owner, and missing guardrails.`;
}

function buildHardQuestion(
  domain: ReviewInboxDomain,
  title: string,
): string {
  if (domain === "friction") {
    return `Should "${title}" be solved in product behavior, workflow guidance, or documentation?`;
  }
  return `What evidence or constraint is still missing before "${title}" should be treated as settled?`;
}

function buildPrompt(
  entry: Omit<ReviewInboxEntry, "prompt">,
): string {
  const lines: string[] = [
    `Title: ${entry.domain === "friction" ? "Address friction" : "Follow up decision"}: ${entry.title}`,
    `Priority: ${entry.suggestedPriority}`,
    `Domain: ${entry.domain}`,
    `Source: ${entry.domain} inbox entry ${entry.relativePath}`,
  ];

  if (entry.itemId) {
    lines.push(`Related item: ${entry.itemId}`);
  }

  lines.push("");
  lines.push(entry.summary);
  lines.push("");
  lines.push("Acceptance:");
  lines.push(`- ${entry.recommendation}`);
  lines.push(`- The follow-up explicitly answers: ${entry.hardQuestion}`);
  lines.push(`- The reviewed inbox entry ${entry.relativePath} is superseded by the follow-up plan.`);
  lines.push("");
  lines.push("Key files: `<fill in relevant paths>`");

  return lines.join("\n");
}

function parseReviewInboxEntry(
  projectRoot: string,
  domain: ReviewInboxDomain,
  filePath: string,
  readFileSync: typeof defaultReadFileSync,
): ReviewInboxEntry {
  const raw = readFileSync(filePath, "utf-8");
  const fields = parseInboxFields(raw);
  const relativePath = relative(projectRoot, filePath) || filePath;
  const fallbackTitle = basename(filePath, ".md");
  const titleSource = domain === "friction"
    ? fields.description || fields.summary || fallbackTitle
    : fields.summary || fields.decision || fallbackTitle;
  const title = titleCaseFrom(titleSource, fallbackTitle);
  const summarySource = domain === "friction"
    ? fields.description || title
    : [fields.summary, fields.context, fields.decision].filter(Boolean).join(" ");
  const summary = firstSentence(summarySource, title);
  const itemId = compactText(fields.item ?? "") || null;
  const recordedAt = compactText(fields.date ?? "") || null;
  const recommendation = buildRecommendation(domain, title);
  const hardQuestion = buildHardQuestion(domain, title);

  const baseEntry = {
    domain,
    filePath,
    relativePath,
    itemId,
    recordedAt,
    title,
    summary,
    recommendation,
    hardQuestion,
    suggestedPriority: suggestedPriority(domain, fields),
  };

  return {
    ...baseEntry,
    prompt: buildPrompt(baseEntry),
  };
}

export function loadReviewInboxEntries(
  projectRoot: string,
  domain: ReviewInboxDomain,
  deps: Pick<ReviewInboxDeps, "existsSync" | "readdirSync" | "readFileSync"> = {
    existsSync: defaultExistsSync,
    readdirSync: defaultReaddirSync,
    readFileSync: defaultReadFileSync,
  },
): ReviewInboxEntry[] {
  const dir = reviewInboxDir(projectRoot, domain);
  if (!deps.existsSync(dir)) return [];

  return deps.readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== ".gitkeep")
    .sort()
    .map((name) => parseReviewInboxEntry(projectRoot, domain, join(dir, name), deps.readFileSync));
}

function gitOrThrow(
  repoRoot: string,
  run: typeof defaultRun,
  args: string[],
  cwd: string = repoRoot,
): RunResult {
  const result = run("git", args, { cwd, timeout: GIT_TIMEOUT });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result;
}

function gitRefExists(
  repoRoot: string,
  run: typeof defaultRun,
  ref: string,
): boolean {
  return run(
    "git",
    ["show-ref", "--verify", "--quiet", ref],
    { cwd: repoRoot, timeout: GIT_TIMEOUT },
  ).exitCode === 0;
}

function remoteBranchExists(
  repoRoot: string,
  run: typeof defaultRun,
  branchName: string,
): boolean {
  return run(
    "git",
    ["ls-remote", "--exit-code", "--heads", "origin", branchName],
    { cwd: repoRoot, timeout: GIT_TIMEOUT },
  ).exitCode === 0;
}

function prepareReviewWorktree(
  repoRoot: string,
  domain: ReviewInboxDomain,
  baseBranch: string,
  deps: Pick<
    ReviewInboxDeps,
    "existsSync" | "mkdirSync" | "run" | "findWorktreeForBranch"
  >,
): { branchName: string; worktreePath: string } {
  const branchName = reviewInboxBranchName(domain);
  const worktreePath = join(repoRoot, ".ninthwave", ".worktrees", `review-${domain}`);

  deps.mkdirSync(dirname(worktreePath), { recursive: true });
  ensureWorktreeExcluded(repoRoot);
  gitOrThrow(repoRoot, deps.run, ["fetch", "origin", baseBranch, "--quiet"]);

  const existingWorktree = deps.findWorktreeForBranch(repoRoot, branchName);
  if (existingWorktree) {
    if (remoteBranchExists(repoRoot, deps.run, branchName)) {
      gitOrThrow(repoRoot, deps.run, ["fetch", "origin", branchName, "--quiet"]);
      gitOrThrow(repoRoot, deps.run, ["reset", "--hard", `origin/${branchName}`], existingWorktree);
    } else {
      gitOrThrow(repoRoot, deps.run, ["reset", "--hard", `origin/${baseBranch}`], existingWorktree);
    }
    return { branchName, worktreePath: existingWorktree };
  }

  if (deps.existsSync(worktreePath)) {
    gitOrThrow(repoRoot, deps.run, ["worktree", "remove", "--force", worktreePath]);
  }

  if (gitRefExists(repoRoot, deps.run, `refs/heads/${branchName}`)) {
    gitOrThrow(repoRoot, deps.run, ["worktree", "add", worktreePath, branchName]);
  } else if (remoteBranchExists(repoRoot, deps.run, branchName)) {
    gitOrThrow(repoRoot, deps.run, ["fetch", "origin", `${branchName}:${branchName}`, "--quiet"]);
    gitOrThrow(repoRoot, deps.run, ["worktree", "add", worktreePath, branchName]);
  } else {
    gitOrThrow(repoRoot, deps.run, ["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`]);
  }

  if (remoteBranchExists(repoRoot, deps.run, branchName)) {
    gitOrThrow(repoRoot, deps.run, ["fetch", "origin", branchName, "--quiet"]);
    gitOrThrow(repoRoot, deps.run, ["reset", "--hard", `origin/${branchName}`], worktreePath);
  } else {
    gitOrThrow(repoRoot, deps.run, ["reset", "--hard", `origin/${baseBranch}`], worktreePath);
  }

  return { branchName, worktreePath };
}

function defaultSyncReviewBranch(
  repoRoot: string,
  domain: ReviewInboxDomain,
  baseBranch: string,
  relativePaths: string[],
): ReviewBranchSyncResult {
  const deps = {
    existsSync: defaultExistsSync,
    mkdirSync: defaultMkdirSync,
    rmSync: defaultRmSync,
    run: defaultRun,
    findWorktreeForBranch: defaultFindWorktreeForBranch,
  };
  const prepared = prepareReviewWorktree(repoRoot, domain, baseBranch, deps);
  const deletedPaths: string[] = [];

  for (const relPath of relativePaths) {
    const targetPath = join(prepared.worktreePath, relPath);
    if (!deps.existsSync(targetPath)) continue;
    deps.rmSync(targetPath);
    deletedPaths.push(relPath);
  }

  let changed = false;
  if (deletedPaths.length > 0) {
    gitOrThrow(repoRoot, deps.run, ["add", "--", ...deletedPaths], prepared.worktreePath);
    const staged = deps.run(
      "git",
      ["diff", "--cached", "--name-only"],
      { cwd: prepared.worktreePath, timeout: GIT_TIMEOUT },
    );
    if (staged.exitCode === 0 && staged.stdout.trim()) {
      gitOrThrow(
        repoRoot,
        deps.run,
        ["commit", "-m", `chore: review ${domain} inbox`],
        prepared.worktreePath,
      );
      changed = true;
    }
  }

  gitOrThrow(
    repoRoot,
    deps.run,
    ["push", "-u", "origin", prepared.branchName],
    prepared.worktreePath,
  );

  return { ...prepared, deletedPaths, changed };
}

export const defaultReviewInboxDeps: ReviewInboxDeps = {
  existsSync: defaultExistsSync,
  mkdirSync: defaultMkdirSync,
  readdirSync: defaultReaddirSync,
  readFileSync: defaultReadFileSync,
  rmSync: defaultRmSync,
  run: defaultRun,
  ensureDomainLabels: defaultEnsureDomainLabels,
  findOpenPrByHeadBranch: defaultFindOpenPrByHeadBranch,
  updatePrBody: defaultUpdatePrBody,
  getDefaultBranch: defaultGetDefaultBranch,
  findWorktreeForBranch: defaultFindWorktreeForBranch,
  createPullRequest: defaultCreatePullRequest,
  closePullRequest: defaultClosePullRequest,
  syncReviewBranch: defaultSyncReviewBranch,
};

export function runReviewInbox(
  projectRoot: string,
  domain: ReviewInboxDomain,
  deps: ReviewInboxDeps = defaultReviewInboxDeps,
): ReviewInboxRunResult {
  const entries = loadReviewInboxEntries(projectRoot, domain, deps);
  const branchName = reviewInboxBranchName(domain);
  const existingPr = deps.findOpenPrByHeadBranch(projectRoot, branchName);
  const baseBranch = deps.getDefaultBranch(projectRoot) ?? "main";

  if (entries.length === 0) {
    if (existingPr) {
      const comment = `Closing ${domain} review PR because the ${domain} inbox is empty on ${baseBranch}.`;
      if (!deps.closePullRequest(projectRoot, existingPr.number, comment)) {
        throw new Error(`Failed to close review PR #${existingPr.number} for ${domain}`);
      }
      return {
        action: "closed",
        domain,
        entryCount: 0,
        reviewedPaths: [],
        branchName,
        baseBranch,
        prNumber: existingPr.number,
      };
    }

    return {
      action: "noop",
      domain,
      entryCount: 0,
      reviewedPaths: [],
      branchName,
      baseBranch,
    };
  }

  const body = renderReviewInboxPullRequest(domain, entries);
  const reviewedPaths = entries.map((entry) => entry.relativePath);
  deps.ensureDomainLabels(projectRoot, [domain]);
  deps.syncReviewBranch(projectRoot, domain, baseBranch, reviewedPaths);

  if (existingPr) {
    if (!deps.updatePrBody(projectRoot, existingPr.number, body)) {
      throw new Error(`Failed to update review PR #${existingPr.number} for ${domain}`);
    }
    return {
      action: "updated",
      domain,
      entryCount: entries.length,
      reviewedPaths,
      branchName,
      baseBranch,
      prNumber: existingPr.number,
      prBody: body,
    };
  }

  const createdPr = deps.createPullRequest(projectRoot, {
    headBranch: branchName,
    baseBranch,
    title: reviewInboxPrTitle(domain),
    body,
    label: `domain:${domain}`,
  });
  if (!createdPr) {
    throw new Error(`Failed to create review PR for ${domain}`);
  }

  return {
    action: "created",
    domain,
    entryCount: entries.length,
    reviewedPaths,
    branchName,
    baseBranch,
    prNumber: createdPr.number,
    prBody: body,
  };
}
