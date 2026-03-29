// Project configuration loading for the ninthwave CLI.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { ProjectConfig } from "./types.ts";
import { DEFAULT_LOC_EXTENSIONS } from "./types.ts";

/** Keys recognised by ninthwave. Anything else triggers a warning. */
export const KNOWN_CONFIG_KEYS = new Set([
  "LOC_EXTENSIONS",
  "review_external",
  "github_token",
  "schedule_enabled",
]);

/**
 * Load project config from .ninthwave/config (key=value format).
 * Only accepts KEY=VALUE lines; comments and blank lines are skipped.
 * Warns on unrecognised keys so typos are caught early.
 */
export function loadConfig(projectRoot: string): ProjectConfig {
  const config: ProjectConfig = {
    locExtensions: DEFAULT_LOC_EXTENSIONS,
  };

  const configPath = join(projectRoot, ".ninthwave", "config");
  if (!existsSync(configPath)) return config;

  const content = readFileSync(configPath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const eqIdx = rawLine.indexOf("=");
    if (eqIdx === -1) continue;

    const key = rawLine.slice(0, eqIdx).trim();
    if (!key || key.startsWith("#")) continue;

    // Strip surrounding quotes from value
    let value = rawLine.slice(eqIdx + 1).trim();
    value = value.replace(/^["']/, "").replace(/["']$/, "");

    if (!KNOWN_CONFIG_KEYS.has(key)) {
      console.warn(
        `[ninthwave] warning: unknown config key "${key}" in ${configPath}`,
      );
      continue;
    }

    // Assign to typed fields
    switch (key) {
      case "LOC_EXTENSIONS":
        config.locExtensions = value;
        break;
      case "review_external":
        config.reviewExternal = value;
        break;
      case "github_token":
        config.githubToken = value;
        break;
      case "schedule_enabled":
        config.scheduleEnabled = value;
        break;
    }
  }

  return config;
}

