// conflicts command: file-level conflict analysis between TODO items.

import { parseTodos } from "../parser.ts";
import { die, BOLD, RED, YELLOW, GREEN, RESET } from "../output.ts";
import type { TodoItem } from "../types.ts";

export function cmdConflicts(
  args: string[],
  todosDir: string,
  worktreeDir: string,
): void {
  if (args.length < 2) die("Usage: ninthwave conflicts <ID1> <ID2> [ID3...]");

  const ids = args;
  const items = parseTodos(todosDir, worktreeDir);
  const itemMap = new Map<string, TodoItem>();
  for (const item of items) {
    itemMap.set(item.id, item);
  }

  // Validate all IDs exist
  for (const id of ids) {
    if (!itemMap.has(id)) die(`Item ${id} not found`);
  }

  let hasConflicts = false;

  console.log(`${BOLD}File-level conflict analysis:${RESET}`);
  console.log();

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const id1 = ids[i]!;
      const id2 = ids[j]!;
      const item1 = itemMap.get(id1)!;
      const item2 = itemMap.get(id2)!;

      // Normalize repo aliases for comparison
      const normRepo1 = normalizeRepo(item1.repoAlias);
      const normRepo2 = normalizeRepo(item2.repoAlias);

      // Items targeting different repos can never have file conflicts
      if (normRepo1 !== normRepo2) continue;

      // Check file overlap
      const files1 = new Set(item1.filePaths);
      const common = item2.filePaths.filter((f) => files1.has(f));

      if (common.length > 0) {
        console.log(
          `  ${RED}CONFLICT${RESET} ${id1} vs ${id2} -- overlapping files:`,
        );
        for (const f of common) {
          console.log(`    - ${f}`);
        }
        hasConflicts = true;
      }

      // Check domain overlap
      if (item1.domain === item2.domain) {
        console.log(
          `  ${YELLOW}POTENTIAL${RESET} ${id1} vs ${id2} -- same domain: ${item1.domain}`,
        );
        hasConflicts = true;
      }
    }
  }

  if (!hasConflicts) {
    console.log(
      `  ${GREEN}CLEAR${RESET} -- no file-level conflicts or domain overlaps detected`,
    );
  }
}

function normalizeRepo(alias: string): string {
  if (!alias || alias === "self" || alias === "hub") return "hub";
  return alias;
}
