// batch-order command: topological sort of TODO items into dependency batches.

import { parseTodos } from "../parser.ts";
import {
  die,
  warn,
  BOLD,
  RED,
  YELLOW,
  CYAN,
  DIM,
  RESET,
} from "../output.ts";
import type { TodoItem } from "../types.ts";

export function cmdBatchOrder(
  args: string[],
  todosFile: string,
  worktreeDir: string,
): void {
  if (args.length < 1)
    die("Usage: ninthwave batch-order <ID1> [ID2...]");

  const ids = args;
  const items = parseTodos(todosFile, worktreeDir);
  const itemMap = new Map<string, TodoItem>();
  for (const item of items) {
    itemMap.set(item.id, item);
  }

  // Validate IDs and compute internal dependencies
  const validIds: string[] = [];
  const itemInternalDeps = new Map<string, string[]>();
  const itemTitles = new Map<string, string>();
  const itemPriorities = new Map<string, string>();

  const selectedSet = new Set(ids);

  for (const id of ids) {
    const item = itemMap.get(id);
    if (!item) {
      warn(`Item ${id} not found, skipping`);
      continue;
    }

    // Find internal deps (deps that are also in the selected set)
    const internalDeps = item.dependencies.filter((depId) =>
      selectedSet.has(depId),
    );

    validIds.push(id);
    itemInternalDeps.set(id, internalDeps);
    itemTitles.set(id, item.title);
    itemPriorities.set(id, item.priority);
  }

  // Topological sort into batches
  let batchNum = 0;
  let remaining = [...validIds];
  const assigned = new Set<string>();

  console.log(`${BOLD}Dependency batch order:${RESET}`);
  console.log();

  while (remaining.length > 0) {
    batchNum++;
    const batchItems: string[] = [];

    for (const id of remaining) {
      const deps = itemInternalDeps.get(id) ?? [];
      const allMet = deps.every((depId) => assigned.has(depId));
      if (allMet) {
        batchItems.push(id);
      }
    }

    // Circular dependency detection: no progress
    if (batchItems.length === 0) {
      console.log(
        `  ${RED}ERROR:${RESET} Circular dependency detected among remaining items:`,
      );
      for (const id of remaining) {
        const deps = itemInternalDeps.get(id) ?? [];
        console.log(
          `    ${id} (depends on: ${deps.length > 0 ? deps.join(", ") : "none"})`,
        );
      }
      process.exit(1);
    }

    console.log(
      `  ${BOLD}Batch ${batchNum}${RESET} (${batchItems.length} items, parallel):`,
    );

    for (const id of batchItems) {
      let pcolor = "";
      const priority = itemPriorities.get(id) ?? "";
      switch (priority) {
        case "critical":
          pcolor = RED;
          break;
        case "high":
          pcolor = YELLOW;
          break;
        case "medium":
          pcolor = CYAN;
          break;
        case "low":
          pcolor = DIM;
          break;
      }

      let displayTitle = itemTitles.get(id) ?? "";
      if (displayTitle.length > 55) {
        displayTitle = displayTitle.slice(0, 52) + "...";
      }

      const deps = itemInternalDeps.get(id) ?? [];
      const displayDeps = deps.length > 0 ? deps.join(", ") : "-";

      console.log(
        `    ${pad(id, 12)} ${pcolor}${pad(priority, 10)}${RESET} ${pad(displayTitle, 55)} deps: ${displayDeps}`,
      );

      assigned.add(id);
    }
    console.log();

    remaining = remaining.filter((id) => !assigned.has(id));
  }

  console.log(
    `${DIM}Total: ${validIds.length} items in ${batchNum} batch(es)${RESET}`,
  );
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}
