// list command: display TODO items with optional filters.

import { parseTodos } from "../parser.ts";
import { die, BOLD, RED, YELLOW, CYAN, DIM, RESET } from "../output.ts";
import { ID_PATTERN_GLOBAL } from "../types.ts";
import type { TodoItem } from "../types.ts";

export function cmdList(
  args: string[],
  todosFile: string,
  worktreeDir: string,
): void {
  let filterPriority = "";
  let filterDomain = "";
  let filterFeature = "";
  let showReady = false;

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
      default:
        die(`Unknown option: ${args[i]}`);
    }
  }

  let items = parseTodos(todosFile, worktreeDir);

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

  // Ready filter: only items whose deps are all satisfied (not in TODOS.md)
  if (showReady) {
    const allIds = new Set(
      parseTodos(todosFile, worktreeDir).map((it) => it.id),
    );
    items = items.filter((item) => {
      if (item.dependencies.length === 0) return true;
      return item.dependencies.every((depId) => !allIds.has(depId));
    });
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

    // Truncate title, add repo suffix
    let displayTitle = item.title;
    let repoSuffix = "";
    if (
      item.repoAlias &&
      item.repoAlias !== "self" &&
      item.repoAlias !== "hub"
    ) {
      repoSuffix = ` [${item.repoAlias}]`;
    }
    const maxTitleLen = 53 - repoSuffix.length;
    if (displayTitle.length > maxTitleLen) {
      displayTitle = displayTitle.slice(0, maxTitleLen - 3) + "...";
    }
    displayTitle = displayTitle + repoSuffix;

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
