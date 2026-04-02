import { parseWorkItems } from "./parser.ts";
import type { WorkItem } from "./types.ts";
import { classifyPrMetadataMatch, type PrMetadataMatchMode } from "./work-item-files.ts";
import { checkPrStatusDetailed, type PrStatusPollResult } from "./commands/pr-monitor.ts";

export interface StartupReplayPrune {
  id: string;
  prNumber?: number;
  matchMode: PrMetadataMatchMode;
}

export interface StartupReplayPruneResult {
  activeItems: WorkItem[];
  prunedItems: StartupReplayPrune[];
}

function normalizePrPollResult(result: string | null | PrStatusPollResult): PrStatusPollResult {
  if (typeof result === "string" || result == null) {
    return { statusLine: result ?? "" };
  }
  return result;
}

export function pruneMergedStartupReplayItems(
  workItems: WorkItem[],
  projectRoot: string,
  checkPr: (id: string, projectRoot: string) => string | null | PrStatusPollResult = checkPrStatusDetailed,
): StartupReplayPruneResult {
  const activeItems: WorkItem[] = [];
  const prunedItems: StartupReplayPrune[] = [];

  for (const item of workItems) {
    const statusLine = normalizePrPollResult(checkPr(item.id, projectRoot)).statusLine;
    if (!statusLine) {
      activeItems.push(item);
      continue;
    }

    const parts = statusLine.split("\t");
    const status = parts[2];
    if (status !== "merged") {
      activeItems.push(item);
      continue;
    }

    const prNumber = parts[1] ? parseInt(parts[1]!, 10) : undefined;
    const match = classifyPrMetadataMatch(
      {
        title: parts[5] ?? "",
        lineageToken: parts[6] ?? "",
      },
      item,
    );

    if (!match.matches) {
      activeItems.push(item);
      continue;
    }

    prunedItems.push({
      id: item.id,
      ...(prNumber != null ? { prNumber } : {}),
      matchMode: match.mode,
    });
  }

  return { activeItems, prunedItems };
}

export function loadRunnableStartupItems(
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
  checkPr: (id: string, projectRoot: string) => string | null | PrStatusPollResult = checkPrStatusDetailed,
): StartupReplayPruneResult {
  const parsedItems = parseWorkItems(workDir, worktreeDir, projectRoot);
  return pruneMergedStartupReplayItems(parsedItems, projectRoot, checkPr);
}
