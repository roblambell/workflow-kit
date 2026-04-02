import { parseWorkItems } from "./parser.ts";
import type { WorkItem } from "./types.ts";
import { classifyPrMetadataMatch, type PrMetadataMatchMode } from "./work-item-files.ts";
import {
  checkPrStatusDetailed,
  checkPrStatusDetailedAsync,
  type PrStatusPollResult,
} from "./commands/pr-monitor.ts";

export interface StartupReplayPrune {
  id: string;
  prNumber?: number;
  matchMode: PrMetadataMatchMode;
}

export interface StartupReplayPruneResult {
  activeItems: WorkItem[];
  prunedItems: StartupReplayPrune[];
}

export interface StartupItemIdDiff {
  keptItemIds: string[];
  removedItemIds: string[];
  addedItemIds: string[];
}

export interface StartupItemsRefreshChange {
  id: string;
  type: "added" | "removed";
  reason: "local-add" | "local-remove" | "merged-pruned";
  prNumber?: number;
  matchMode?: PrMetadataMatchMode;
}

export interface StartupItemsRefreshResult extends StartupReplayPruneResult {
  localItems: WorkItem[];
  diff: StartupItemIdDiff;
  changes: StartupItemsRefreshChange[];
}

type SyncPrCheck = (id: string, projectRoot: string) => string | null | PrStatusPollResult;
type AsyncPrCheck = (id: string, projectRoot: string) => Promise<string | null | PrStatusPollResult>;

function normalizePrPollResult(result: string | null | PrStatusPollResult): PrStatusPollResult {
  if (typeof result === "string" || result == null) {
    return { statusLine: result ?? "" };
  }
  return result;
}

function classifyStartupReplayItem(
  item: WorkItem,
  statusLine: string,
): { keep: true } | { keep: false; prune: StartupReplayPrune } {
  if (!statusLine) {
    return { keep: true };
  }

  const parts = statusLine.split("\t");
  const status = parts[2];
  if (status !== "merged") {
    return { keep: true };
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
    return { keep: true };
  }

  return {
    keep: false,
    prune: {
      id: item.id,
      ...(prNumber != null ? { prNumber } : {}),
      matchMode: match.mode,
    },
  };
}

function buildStartupReplayPruneResult(
  workItems: WorkItem[],
  resolveStatusLine: (item: WorkItem) => string,
): StartupReplayPruneResult {
  const activeItems: WorkItem[] = [];
  const prunedItems: StartupReplayPrune[] = [];

  for (const item of workItems) {
    const classification = classifyStartupReplayItem(item, resolveStatusLine(item));
    if (classification.keep) {
      activeItems.push(item);
      continue;
    }
    prunedItems.push(classification.prune);
  }

  return { activeItems, prunedItems };
}

export function pruneMergedStartupReplayItems(
  workItems: WorkItem[],
  projectRoot: string,
  checkPr: SyncPrCheck = checkPrStatusDetailed,
): StartupReplayPruneResult {
  return buildStartupReplayPruneResult(
    workItems,
    (item) => normalizePrPollResult(checkPr(item.id, projectRoot)).statusLine,
  );
}

export async function pruneMergedStartupReplayItemsAsync(
  workItems: WorkItem[],
  projectRoot: string,
  checkPr: AsyncPrCheck = checkPrStatusDetailedAsync,
): Promise<StartupReplayPruneResult> {
  const statusLines = new Map<string, string>();

  for (const item of workItems) {
    const result = await checkPr(item.id, projectRoot);
    statusLines.set(item.id, normalizePrPollResult(result).statusLine);
  }

  return buildStartupReplayPruneResult(workItems, (item) => statusLines.get(item.id) ?? "");
}

export function loadLocalStartupItems(
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
): WorkItem[] {
  return parseWorkItems(workDir, worktreeDir, projectRoot);
}

export function loadDiscoveryStartupItems(
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
): WorkItem[] {
  return loadLocalStartupItems(workDir, worktreeDir, projectRoot);
}

export function loadRunnableStartupItems(
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
  checkPr: SyncPrCheck = checkPrStatusDetailed,
): StartupReplayPruneResult {
  const parsedItems = loadDiscoveryStartupItems(workDir, worktreeDir, projectRoot);
  return pruneMergedStartupReplayItems(parsedItems, projectRoot, checkPr);
}

export function diffStartupItemIds(
  previousItems: ReadonlyArray<Pick<WorkItem, "id">>,
  nextItems: ReadonlyArray<Pick<WorkItem, "id">>,
): StartupItemIdDiff {
  const nextIdSet = new Set(nextItems.map((item) => item.id));
  const previousIdSet = new Set(previousItems.map((item) => item.id));
  const sortIds = (ids: string[]): string[] => ids.sort((a, b) => a.localeCompare(b));

  return {
    keptItemIds: sortIds(previousItems.map((item) => item.id).filter((id) => nextIdSet.has(id))),
    removedItemIds: sortIds(previousItems.map((item) => item.id).filter((id) => !nextIdSet.has(id))),
    addedItemIds: sortIds(nextItems.map((item) => item.id).filter((id) => !previousIdSet.has(id))),
  };
}

export async function refreshRunnableStartupItems(
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
  previousItems: ReadonlyArray<WorkItem>,
  checkPr: AsyncPrCheck = checkPrStatusDetailedAsync,
): Promise<StartupItemsRefreshResult> {
  const localItems = loadDiscoveryStartupItems(workDir, worktreeDir, projectRoot);
  const { activeItems, prunedItems } = await pruneMergedStartupReplayItemsAsync(localItems, projectRoot, checkPr);
  const diff = diffStartupItemIds(previousItems, activeItems);
  const prunedById = new Map(prunedItems.map((item) => [item.id, item] as const));

  const changes: StartupItemsRefreshChange[] = [
    ...diff.removedItemIds.map((id) => {
      const pruned = prunedById.get(id);
      if (pruned) {
        return {
          id,
          type: "removed" as const,
          reason: "merged-pruned" as const,
          ...(pruned.prNumber != null ? { prNumber: pruned.prNumber } : {}),
          matchMode: pruned.matchMode,
        };
      }

      return {
        id,
        type: "removed" as const,
        reason: "local-remove" as const,
      };
    }),
    ...diff.addedItemIds.map((id) => ({
      id,
      type: "added" as const,
      reason: "local-add" as const,
    })),
  ];

  return {
    localItems,
    activeItems,
    prunedItems,
    diff,
    changes,
  };
}
