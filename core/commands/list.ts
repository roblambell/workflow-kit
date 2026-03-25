// list command: display TODO items with optional filters.

import { parseTodos } from "../parser.ts";
import { die, warn, BOLD, RED, YELLOW, CYAN, DIM, RESET } from "../output.ts";
import type { TodoItem } from "../types.ts";
import { GitHubIssuesBackend } from "../backends/github-issues.ts";
import { ClickUpBackend, resolveClickUpConfig } from "../backends/clickup.ts";
import { SentryBackend, resolveSentryConfig } from "../backends/sentry.ts";
import {
  PagerDutyBackend,
  resolvePagerDutyConfig,
} from "../backends/pagerduty.ts";
import { ghInRepo } from "../gh.ts";
import { loadConfig } from "../config.ts";
import {
  discoverBackends,
  type DiscoveredBackend,
} from "../backend-registry.ts";

/** Dependency injection for testability. */
export interface ListDeps {
  discoverBackends?: (projectRoot: string) => DiscoveredBackend[];
}

export function cmdList(
  args: string[],
  todosDir: string,
  worktreeDir: string,
  projectRoot?: string,
  deps?: ListDeps,
): void {
  let filterPriority = "";
  let filterDomain = "";
  let filterFeature = "";
  let showReady = false;
  let depth = 0; // 0 = no depth limit (when used with --ready, depth 1 is default)
  let backend = "";
  let clickupListId = "";

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
      case "--backend":
        backend = args[i + 1] ?? "";
        i += 2;
        break;
      case "--clickup-list":
        clickupListId = args[i + 1] ?? "";
        i += 2;
        break;
      default:
        die(`Unknown option: ${args[i]}`);
    }
  }

  // Build items list with source tracking
  let items: TodoItem[];
  const sourceMap = new Map<TodoItem, string>();
  let showSource = false;

  if (backend === "sentry") {
    if (!projectRoot) die("Project root is required for sentry backend");
    const config = loadConfig(projectRoot!);
    const sentryConfig = resolveSentryConfig((key) => config[key]);
    if (!sentryConfig) {
      die(
        "Sentry backend requires SENTRY_AUTH_TOKEN env var and " +
          "sentry_org/sentry_project in .ninthwave/config or SENTRY_ORG/SENTRY_PROJECT env vars",
      );
    }
    const b = new SentryBackend(
      sentryConfig.org,
      sentryConfig.project,
      sentryConfig.authToken,
    );
    items = b.list();
    for (const item of items) sourceMap.set(item, "sentry");
    showSource = true;
  } else if (backend === "pagerduty") {
    if (!projectRoot) die("Project root is required for pagerduty backend");
    const config = loadConfig(projectRoot!);
    const pdConfig = resolvePagerDutyConfig((key) => config[key]);
    if (!pdConfig) {
      die(
        "PagerDuty backend requires PAGERDUTY_API_TOKEN and " +
          "PAGERDUTY_FROM_EMAIL env vars (or pagerduty_from_email in .ninthwave/config)",
      );
    }
    const b = new PagerDutyBackend(
      pdConfig.apiToken,
      pdConfig.fromEmail,
      undefined,
      pdConfig.serviceId,
    );
    items = b.list();
    for (const item of items) sourceMap.set(item, "pagerduty");
    showSource = true;
  } else if (backend === "github-issues") {
    if (!projectRoot) die("Project root is required for github-issues backend");
    const ghBackend = new GitHubIssuesBackend(
      projectRoot!,
      "ninthwave",
      ghInRepo,
    );
    items = ghBackend.list();
    for (const item of items) sourceMap.set(item, "github");
    showSource = true;
  } else if (backend === "clickup") {
    if (!projectRoot) die("Project root is required for clickup backend");
    const config = loadConfig(projectRoot!);
    const ckConfig = resolveClickUpConfig(
      clickupListId || undefined,
      (key) => config[key],
    );
    if (!ckConfig) {
      die(
        "ClickUp backend requires CLICKUP_API_TOKEN env var and list ID " +
          "(via --clickup-list flag or CLICKUP_LIST_ID in .ninthwave/config)",
      );
    }
    const ckBackend = new ClickUpBackend(ckConfig!.listId, ckConfig!.apiToken);
    items = ckBackend.list();
    for (const item of items) sourceMap.set(item, "clickup");
    showSource = true;
  } else if (backend) {
    die(`Unknown backend: ${backend}`);
  } else {
    // Default: local items + auto-discovered backends
    items = parseTodos(todosDir, worktreeDir);

    // Auto-discover external backends
    if (projectRoot) {
      const discover = deps?.discoverBackends ?? discoverBackends;
      const discovered = discover(projectRoot);
      if (discovered.length > 0) {
        showSource = true;
        for (const item of items) sourceMap.set(item, "local");
        for (const { name, backend: b } of discovered) {
          try {
            const externalItems = b.list();
            for (const eItem of externalItems) {
              items.push(eItem);
              sourceMap.set(eItem, name);
            }
          } catch {
            warn(`Backend ${name} unavailable, showing local items only`);
          }
        }
      }
    }
  }

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
    const allItems = parseTodos(todosDir, worktreeDir);
    const allIds = new Set(allItems.map((it) => it.id));

    // Effective depth: --ready alone = 1, --depth N = N
    const maxDepth = depth || 1;

    // Iteratively find items reachable within maxDepth batches
    const included = new Set<string>(); // IDs selected so far
    const done = new Set<string>(); // IDs not in todo files (already done)

    // Seed "done" with all IDs referenced as deps but not in todo files
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
  const sourceWidth = 12;
  const sourceHeader = showSource
    ? `${pad("SOURCE", sourceWidth)} `
    : "";
  console.log(
    `${BOLD}${sourceHeader}${pad("ID", 12)} ${pad("PRIORITY", 10)} ${pad("TITLE", 55)} ${pad("DOMAIN", 14)} ${pad("DEPENDS ON", 18)} ${pad("STATUS", 12)}${RESET}`,
  );
  console.log("-".repeat(showSource ? 132 : 120));

  let count = 0;
  for (const item of items) {
    if (!item.id) continue;

    // Source label
    const sourcePrefix = showSource
      ? `${pad(`[${sourceMap.get(item) ?? "local"}]`, sourceWidth)} `
      : "";

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
      `${sourcePrefix}${pad(item.id, 12)} ${pcolor}${pad(item.priority, 10)}${RESET} ${pad(displayTitle, 55)} ${pad(item.domain, 14)} ${pad(displayDeps, 18)} ${scolor}${pad(item.status, 12)}${RESET}`,
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
