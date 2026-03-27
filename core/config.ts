// Project configuration loading for the ninthwave CLI.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { ProjectConfig, WorkspaceConfig } from "./types.ts";
import { DEFAULT_LOC_EXTENSIONS } from "./types.ts";

/** Keys recognised by ninthwave. Anything else triggers a warning. */
export const KNOWN_CONFIG_KEYS = new Set([
  "LOC_EXTENSIONS",
  "review_external",
  "github_token",
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

    config[key] = value;
  }

  // Warn on unrecognised keys (typos, removed options, etc.)
  for (const k of Object.keys(config)) {
    if (k === "locExtensions") continue; // internal default, not user-supplied
    if (!KNOWN_CONFIG_KEYS.has(k)) {
      console.warn(
        `[ninthwave] warning: unknown config key "${k}" in ${configPath}`,
      );
    }
  }

  // Apply LOC_EXTENSIONS if set in config
  if (config["LOC_EXTENSIONS"]) {
    config.locExtensions = config["LOC_EXTENSIONS"];
  }

  return config;
}

/**
 * Load workspace config from .ninthwave/config.json.
 * Returns null if the file doesn't exist or has no workspace section.
 */
export function loadWorkspaceConfig(projectRoot: string): WorkspaceConfig | null {
  const configJsonPath = join(projectRoot, ".ninthwave", "config.json");
  if (!existsSync(configJsonPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(configJsonPath, "utf-8"));
    if (raw?.workspace?.packages && Array.isArray(raw.workspace.packages)) {
      return raw.workspace as WorkspaceConfig;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load domain mappings from .ninthwave/domains.conf.
 * Format: pattern=domain_key (one per line, comments with #).
 * Patterns are matched case-insensitively against section headers.
 */
export function loadDomainMappings(projectRoot: string): Map<string, string> {
  const mappings = new Map<string, string>();
  const domainsPath = join(projectRoot, ".ninthwave", "domains.conf");
  if (!existsSync(domainsPath)) return mappings;

  const content = readFileSync(domainsPath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const eqIdx = rawLine.indexOf("=");
    if (eqIdx === -1) continue;

    const pattern = rawLine.slice(0, eqIdx).trim();
    if (!pattern || pattern.startsWith("#")) continue;

    const domainKey = rawLine.slice(eqIdx + 1).trim();
    mappings.set(pattern, domainKey);
  }

  return mappings;
}
