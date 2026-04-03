import { die } from "../output.ts";
import {
  isReviewInboxDomain,
  runReviewInbox,
  type ReviewInboxRunResult,
} from "../review-inbox.ts";

export interface ReviewInboxCommandDeps {
  runReviewInbox: typeof runReviewInbox;
}

const defaultCommandDeps: ReviewInboxCommandDeps = {
  runReviewInbox,
};

export function cmdReviewInbox(
  args: string[],
  projectRoot: string,
  deps: ReviewInboxCommandDeps = defaultCommandDeps,
): ReviewInboxRunResult {
  if (args.length !== 1 || !isReviewInboxDomain(args[0] ?? "")) {
    die("Usage: nw review-inbox <friction|decisions>");
  }

  const domain = args[0]!;
  const result = deps.runReviewInbox(projectRoot, domain);

  switch (result.action) {
    case "created":
      console.log(`Opened review PR #${result.prNumber} for ${domain}.`);
      break;
    case "updated":
      console.log(`Updated review PR #${result.prNumber} for ${domain}.`);
      break;
    case "closed":
      console.log(`Closed review PR #${result.prNumber} for ${domain}: inbox is empty.`);
      break;
    case "noop":
      console.log(`No ${domain} inbox entries to review.`);
      break;
  }

  return result;
}
