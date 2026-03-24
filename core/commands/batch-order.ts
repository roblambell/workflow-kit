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

/** Result of computing batch assignments. */
export interface BatchResult {
  /** Map from item ID to its batch number (1-indexed). */
  assignments: Map<string, number>;
  /** Total number of batches. */
  batchCount: number;
}

/** Thrown when a circular dependency is detected during batch computation. */
export class CircularDependencyError extends Error {
  /** Partial assignments computed before the cycle was detected. */
  assignments: Map<string, number>;
  /** Number of batches successfully computed before the cycle. */
  batchCount: number;
  /** IDs of items involved in the circular dependency. */
  circularItems: string[];

  constructor(
    assignments: Map<string, number>,
    batchCount: number,
    circularItems: string[],
  ) {
    super(
      `Circular dependency detected among: ${circularItems.join(", ")}`,
    );
    this.name = "CircularDependencyError";
    this.assignments = assignments;
    this.batchCount = batchCount;
    this.circularItems = circularItems;
  }
}

/**
 * Compute topological batch assignments for a set of TODO items.
 *
 * Items are grouped into batches where all dependencies of each item in a
 * batch have been assigned to earlier batches. Items with no internal
 * dependencies (among the selected set) land in batch 1.
 *
 * @param items - All parsed TODO items (used to look up dependencies).
 * @param selectedIds - IDs of items to batch. Unknown IDs are silently skipped.
 * @returns BatchResult with assignments map (ID → batch number) and batch count.
 * @throws CircularDependencyError if a cycle prevents full resolution.
 */
export function computeBatches(
  items: TodoItem[],
  selectedIds: string[],
): BatchResult {
  const itemMap = new Map<string, TodoItem>();
  for (const item of items) {
    itemMap.set(item.id, item);
  }

  const selectedSet = new Set(selectedIds);

  // Resolve valid IDs and their internal dependencies
  const validIds: string[] = [];
  const itemInternalDeps = new Map<string, string[]>();

  for (const id of selectedIds) {
    const item = itemMap.get(id);
    if (!item) continue;

    const internalDeps = item.dependencies.filter((depId) =>
      selectedSet.has(depId),
    );

    validIds.push(id);
    itemInternalDeps.set(id, internalDeps);
  }

  // Topological sort into batches
  let batchNum = 0;
  let remaining = [...validIds];
  const assigned = new Set<string>();
  const assignments = new Map<string, number>();

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
      throw new CircularDependencyError(
        assignments,
        batchNum - 1,
        [...remaining],
      );
    }

    for (const id of batchItems) {
      assigned.add(id);
      assignments.set(id, batchNum);
    }

    remaining = remaining.filter((id) => !assigned.has(id));
  }

  return { assignments, batchCount: batchNum };
}

export function cmdBatchOrder(
  args: string[],
  todosDir: string,
  worktreeDir: string,
): void {
  if (args.length < 1)
    die("Usage: ninthwave batch-order <ID1> [ID2...]");

  const ids = args;
  const items = parseTodos(todosDir, worktreeDir);

  // Build lookup for display metadata
  const itemMap = new Map<string, TodoItem>();
  for (const item of items) {
    itemMap.set(item.id, item);
  }

  // Warn about unknown IDs
  for (const id of ids) {
    if (!itemMap.has(id)) {
      warn(`Item ${id} not found, skipping`);
    }
  }

  // Compute internal deps for display (needed for dep column)
  const selectedSet = new Set(ids);
  const itemInternalDeps = new Map<string, string[]>();
  for (const id of ids) {
    const item = itemMap.get(id);
    if (!item) continue;
    itemInternalDeps.set(
      id,
      item.dependencies.filter((depId) => selectedSet.has(depId)),
    );
  }

  let assignments: Map<string, number>;
  let batchCount: number;
  let circularItems: string[] | undefined;

  try {
    const result = computeBatches(items, ids);
    assignments = result.assignments;
    batchCount = result.batchCount;
  } catch (e) {
    if (e instanceof CircularDependencyError) {
      assignments = e.assignments;
      batchCount = e.batchCount;
      circularItems = e.circularItems;
    } else {
      throw e;
    }
  }

  console.log(`${BOLD}Dependency batch order:${RESET}`);
  console.log();

  // Print assigned batches
  for (let b = 1; b <= batchCount; b++) {
    const batchItems = [...assignments.entries()]
      .filter(([, batch]) => batch === b)
      .map(([id]) => id);

    console.log(
      `  ${BOLD}Batch ${b}${RESET} (${batchItems.length} items, parallel):`,
    );

    for (const id of batchItems) {
      const item = itemMap.get(id)!;
      let pcolor = "";
      switch (item.priority) {
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

      let displayTitle = item.title;
      if (displayTitle.length > 55) {
        displayTitle = displayTitle.slice(0, 52) + "...";
      }

      const deps = itemInternalDeps.get(id) ?? [];
      const displayDeps = deps.length > 0 ? deps.join(", ") : "-";

      console.log(
        `    ${pad(id, 12)} ${pcolor}${pad(item.priority, 10)}${RESET} ${pad(displayTitle, 55)} deps: ${displayDeps}`,
      );
    }
    console.log();
  }

  // Print circular dependency error if detected
  if (circularItems) {
    console.log(
      `  ${RED}ERROR:${RESET} Circular dependency detected among remaining items:`,
    );
    for (const id of circularItems) {
      const deps = itemInternalDeps.get(id) ?? [];
      console.log(
        `    ${id} (depends on: ${deps.length > 0 ? deps.join(", ") : "none"})`,
      );
    }
    process.exit(1);
  }

  const totalItems = assignments.size;
  console.log(
    `${DIM}Total: ${totalItems} items in ${batchCount} batch(es)${RESET}`,
  );
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}
