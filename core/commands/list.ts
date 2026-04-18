// list command: display work items with optional filters.

import { parseWorkItems } from "../parser.ts";
import { die, BOLD, RED, YELLOW, CYAN, DIM, RESET } from "../output.ts";
import type { WorkItem } from "../types.ts";

export function cmdList(
  args: string[],
  workDir: string,
  worktreeDir: string,
): void {
  let filterPriority = "";
  let filterDomain = "";
  let filterFeature = "";
  let showReady = false;
  let depth = 0; // 0 = no depth limit (when used with --ready, depth 1 is default)

  // Parse args
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--priority":
        filterPriority = args[i + 1] ?? "";
        i += 2;
        break;
      case "--domain":
        filterDomain = args[i + 1] ?? "";
        i += 2;
        break;
      case "--feature":
        filterFeature = args[i + 1] ?? "";
        i += 2;
        break;
      case "--ready":
        showReady = true;
        i += 1;
        break;
      case "--depth": {
        const v = parseInt(args[i + 1] ?? "", 10);
        if (isNaN(v) || v < 1) die("--depth requires a positive integer");
        depth = v;
        showReady = true; // --depth implies --ready
        i += 2;
        break;
      }
      default:
        die(`Unknown option: ${args[i]}`);
    }
  }

  // Build items list -- always sourced from origin/main by parseWorkItems.
  let items: WorkItem[] = parseWorkItems(workDir, worktreeDir);

  // Apply filters
  if (filterPriority) {
    items = items.filter((item) => item.priority === filterPriority);
  }
  if (filterDomain) {
    items = items.filter((item) => item.domain === filterDomain);
  }
  if (filterFeature) {
    items = items.filter((item) => item.id.includes(filterFeature));
  }

  // Ready filter: items whose deps are satisfied, with optional depth traversal.
  // --ready alone (depth=0): only items whose deps are all done (depth 1 behavior).
  // --depth N: walk the dependency graph N levels from ready roots.
  if (showReady) {
    const allItems = parseWorkItems(workDir, worktreeDir);
    const allIds = new Set(allItems.map((it) => it.id));

    // Effective depth: --ready alone = 1, --depth N = N
    const maxDepth = depth || 1;

    // Iteratively find items reachable within maxDepth batches
    const included = new Set<string>(); // IDs selected so far
    const done = new Set<string>(); // IDs not in work item files (already done)

    // Seed "done" with all IDs referenced as deps but not in work item files
    for (const item of allItems) {
      for (const depId of item.dependencies) {
        if (!allIds.has(depId)) done.add(depId);
      }
    }

    for (let d = 0; d < maxDepth; d++) {
      const satisfiedIds = new Set([...done, ...included]);
      let foundNew = false;
      for (const item of allItems) {
        if (included.has(item.id)) continue;
        const depsOk =
          item.dependencies.length === 0 ||
          item.dependencies.every((depId) => satisfiedIds.has(depId));
        if (depsOk) {
          included.add(item.id);
          foundNew = true;
        }
      }
      if (!foundNew) break; // no more items reachable
    }

    items = items.filter((item) => included.has(item.id));
  }

  // Print table header
  console.log(
    `${BOLD}${pad("ID", 12)} ${pad("PRIORITY", 10)} ${pad("TITLE", 55)} ${pad("DOMAIN", 14)} ${pad("DEPENDS ON", 18)} ${pad("STATUS", 12)}${RESET}`,
  );
  console.log("-".repeat(120));

  let count = 0;
  for (const item of items) {
    if (!item.id) continue;

    // Color-code priority
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

    // Color-code status
    let scolor = "";
    if (item.status === "in-progress") scolor = YELLOW;

    // Truncate title
    let displayTitle = item.title;
    const maxTitleLen = 53;
    if (displayTitle.length > maxTitleLen) {
      displayTitle = displayTitle.slice(0, maxTitleLen - 3) + "...";
    }

    // Format deps
    let displayDeps = "-";
    if (item.dependencies.length > 0) {
      displayDeps = item.dependencies.join(",");
      if (displayDeps.length > 16) {
        displayDeps = displayDeps.slice(0, 13) + "...";
      }
    }

    console.log(
      `${pad(item.id, 12)} ${pcolor}${pad(item.priority, 10)}${RESET} ${pad(displayTitle, 55)} ${pad(item.domain, 14)} ${pad(displayDeps, 18)} ${scolor}${pad(item.status, 12)}${RESET}`,
    );

    count++;
  }

  console.log();
  console.log(`${DIM}${count} items${RESET}`);
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}
