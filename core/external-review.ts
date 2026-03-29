// External PR review processing: scanning non-ninthwave PRs and managing review workers.
// Extracted from core/commands/orchestrate.ts for modularity.

import type { LogEntry } from "./types.ts";
import type { ExternalReviewItem } from "./daemon.ts";
import type { ExternalPR } from "./commands/pr-monitor.ts";

// ── External PR review processing ─────────────────────────────────

/** Author associations with write access -- only review PRs from trusted contributors. */
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** Label that causes a PR to be skipped for external review. */
const SKIP_REVIEW_LABEL = "ninthwave: skip-review";

/** Dependencies for processExternalReviews, injectable for testing. */
export interface ExternalReviewDeps {
  scanExternalPRs: (repoRoot: string) => ExternalPR[];
  launchReview: (prNumber: number, repoRoot: string) => { workspaceRef: string } | null;
  cleanReview: (reviewWorkspaceRef: string) => boolean;
  log: (entry: LogEntry) => void;
}

/**
 * Process external (non-ninthwave) PRs for review.
 *
 * 1. Scans for open external PRs
 * 2. Filters: skip drafts, skip labeled PRs, only trusted contributors
 * 3. Detects new PRs and re-reviews (HEAD commit changed)
 * 4. Launches review workers within WIP limit
 * 5. Cleans up reviews for closed/merged PRs
 *
 * Returns the updated external review items list.
 */
export function processExternalReviews(
  repoRoot: string,
  externalReviews: ExternalReviewItem[],
  availableWipSlots: number,
  deps: ExternalReviewDeps,
): ExternalReviewItem[] {
  // 1. Scan for external PRs
  const externalPRs = deps.scanExternalPRs(repoRoot);

  // 2. Filter: skip drafts, skip labeled PRs, only trusted contributors
  const eligiblePRs = externalPRs.filter((pr) => {
    if (pr.isDraft) return false;
    if (pr.labels.includes(SKIP_REVIEW_LABEL)) return false;
    if (!TRUSTED_AUTHOR_ASSOCIATIONS.has(pr.authorAssociation)) return false;
    return true;
  });

  // Build lookup of currently-open external PR numbers for cleanup
  const openPrNumbers = new Set(externalPRs.map((pr) => pr.prNumber));
  const eligibleByPr = new Map(eligiblePRs.map((pr) => [pr.prNumber, pr]));

  // 3. Update tracked reviews: detect new PRs and HEAD changes
  const trackedByPr = new Map(externalReviews.map((r) => [r.prNumber, r]));
  const updatedReviews = [...externalReviews];

  for (const pr of eligiblePRs) {
    const existing = trackedByPr.get(pr.prNumber);

    if (existing) {
      // HEAD commit changed on an already-reviewed PR → re-review
      if (
        existing.state === "reviewed" &&
        existing.lastReviewedCommit !== pr.headSha
      ) {
        existing.state = "detected";
        existing.lastTransition = new Date().toISOString();
        deps.log({
          ts: new Date().toISOString(),
          level: "info",
          event: "external_review_head_changed",
          prNumber: pr.prNumber,
          oldCommit: existing.lastReviewedCommit,
          newCommit: pr.headSha,
        });
      }
      continue;
    }

    // New PR -- add to tracking
    const newItem: ExternalReviewItem = {
      prNumber: pr.prNumber,
      headBranch: pr.headBranch,
      author: pr.author,
      state: "detected",
      lastTransition: new Date().toISOString(),
    };
    updatedReviews.push(newItem);
    trackedByPr.set(pr.prNumber, newItem);

    deps.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "external_pr_detected",
      prNumber: pr.prNumber,
      author: pr.author,
      headBranch: pr.headBranch,
    });
  }

  // 4. Launch review workers for detected PRs, respecting the unified WIP limit.
  // availableWipSlots already accounts for internal reviewing items. Subtract
  // external reviews that are already running to get net available slots.
  const reviewingCount = updatedReviews.filter((r) => r.state === "reviewing").length;
  let availableSlots = availableWipSlots - reviewingCount;

  for (const review of updatedReviews) {
    if (review.state !== "detected") continue;
    if (availableSlots <= 0) break;

    const pr = eligibleByPr.get(review.prNumber);
    const result = deps.launchReview(review.prNumber, repoRoot);

    if (result) {
      review.state = "reviewing";
      review.reviewWorkspaceRef = result.workspaceRef;
      review.lastReviewedCommit = pr?.headSha;
      review.lastTransition = new Date().toISOString();
      availableSlots--;

      deps.log({
        ts: new Date().toISOString(),
        level: "info",
        event: "external_review_launched",
        prNumber: review.prNumber,
        workspaceRef: result.workspaceRef,
      });
    }
  }

  // 5. Clean up reviews for closed/merged PRs (no longer in the open PR list)
  for (let i = updatedReviews.length - 1; i >= 0; i--) {
    const review = updatedReviews[i]!;
    if (!openPrNumbers.has(review.prNumber)) {
      // PR was closed or merged -- clean up
      if (review.reviewWorkspaceRef) {
        try {
          deps.cleanReview(review.reviewWorkspaceRef);
        } catch {
          // best-effort
        }
      }
      deps.log({
        ts: new Date().toISOString(),
        level: "info",
        event: "external_review_cleaned",
        prNumber: review.prNumber,
        reason: "pr_closed",
      });
      updatedReviews.splice(i, 1);
    }
  }

  return updatedReviews;
}
