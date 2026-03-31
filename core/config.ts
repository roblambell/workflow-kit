// Project and user configuration loading and saving for the ninthwave CLI.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

/** Project config shape. */
export interface ProjectConfig {
  review_external: boolean;
  schedule_enabled: boolean;
  ai_tools?: string[];
  telemetry?: boolean;
}

/**
 * Load project config from .ninthwave/config.json (JSON format).
 * Returns defaults when the file is missing or malformed.
 * Unknown keys are silently ignored.
 */
export function loadConfig(projectRoot: string): ProjectConfig {
  const defaults: ProjectConfig = {
    review_external: false,
    schedule_enabled: false,
  };

  const configPath = join(projectRoot, ".ninthwave", "config.json");
  if (!existsSync(configPath)) return defaults;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return defaults;
    }
    const ai_tools = Array.isArray(parsed.ai_tools) && parsed.ai_tools.every((t: unknown) => typeof t === "string") && parsed.ai_tools.length > 0
      ? (parsed.ai_tools as string[])
      : undefined;
    return {
      review_external: parsed.review_external === true,
      schedule_enabled: parsed.schedule_enabled === true,
      ai_tools,
      telemetry: typeof parsed.telemetry === "boolean" ? parsed.telemetry : undefined,
    };
  } catch {
    return defaults;
  }
}

/**
 * Save partial config updates to .ninthwave/config.json.
 * Reads the existing file, merges updates, and writes back.
 * Preserves unknown keys that other tools may have written.
 */
export function saveConfig(
  projectRoot: string,
  updates: Partial<ProjectConfig>,
): void {
  const configPath = join(projectRoot, ".ninthwave", "config.json");

  // Read existing raw JSON to preserve unknown keys
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch {
      // Malformed file -- start fresh
    }
  }

  // Merge updates (only defined values)
  const merged = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
}

// ── User-level config (~/.ninthwave/config.json) ──────────────────────

/** User config shape. */
export interface UserConfig {
  ai_tools?: string[];
  wip_limit?: number;
}

/**
 * Load user-level config from ~/.ninthwave/config.json.
 * Returns {} when the file is missing or malformed (malformed triggers a warning).
 *
 * @param homeOverride - Override the home directory (for testing). Defaults to os.homedir().
 */
export function loadUserConfig(homeOverride?: string): UserConfig {
  const home = homeOverride ?? homedir();
  const configPath = join(home, ".ninthwave", "config.json");

  if (!existsSync(configPath)) return {};

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error("Warning: ~/.ninthwave/config.json is not a JSON object, ignoring.");
      return {};
    }
    const result: UserConfig = {};
    if (Array.isArray(parsed.ai_tools) && parsed.ai_tools.every((t: unknown) => typeof t === "string") && parsed.ai_tools.length > 0) {
      result.ai_tools = parsed.ai_tools as string[];
    }
    if (typeof parsed.wip_limit === "number" && Number.isFinite(parsed.wip_limit) && parsed.wip_limit >= 1) {
      result.wip_limit = Math.floor(parsed.wip_limit);
    }
    return result;
  } catch {
    console.error("Warning: ~/.ninthwave/config.json contains malformed JSON, ignoring.");
    return {};
  }
}

/**
 * Save partial user-level config updates to ~/.ninthwave/config.json.
 * Reads the existing file, merges updates, and writes back.
 * Preserves unknown keys that other tools may have written.
 *
 * @param updates - Partial UserConfig fields to merge.
 * @param homeOverride - Override the home directory (for testing). Defaults to os.homedir().
 */
export function saveUserConfig(
  updates: Partial<UserConfig>,
  homeOverride?: string,
): void {
  const home = homeOverride ?? homedir();
  const configPath = join(home, ".ninthwave", "config.json");

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch {
      // Malformed file -- start fresh
    }
  }

  const merged = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
}
