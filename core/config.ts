// Project and user configuration loading and saving for the ninthwave CLI.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import {
  isPersistedBackendMode,
  isPersistedCollaborationMode,
  isPersistedMergeStrategy,
  isPersistedReviewMode,
  type PersistedBackendMode,
  type PersistedCollaborationMode,
  type PersistedMergeStrategy,
  type PersistedReviewMode,
} from "./tui-settings.ts";

/** Project config shape. */
export interface ProjectConfig {
  review_external: boolean;
  schedule_enabled: boolean;
  crew_url?: string;
}

function parseProjectCrewUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
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

    const crewUrl = parseProjectCrewUrl(parsed.crew_url);
    return {
      review_external: parsed.review_external === true,
      schedule_enabled: parsed.schedule_enabled === true,
      ...(crewUrl === undefined ? {} : { crew_url: crewUrl }),
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
export type TmuxLayoutMode = "dashboard" | "windows";

const TMUX_LAYOUT_MODES: readonly TmuxLayoutMode[] = ["dashboard", "windows"] as const;

export function isTmuxLayoutMode(value: unknown): value is TmuxLayoutMode {
  return TMUX_LAYOUT_MODES.includes(value as TmuxLayoutMode);
}

export interface UserConfig {
  ai_tools?: string[];
  session_limit?: number;
  backend_mode?: PersistedBackendMode;
  tmux_layout?: TmuxLayoutMode;
  merge_strategy?: PersistedMergeStrategy;
  review_mode?: PersistedReviewMode;
  collaboration_mode?: PersistedCollaborationMode;
  update_checks_enabled?: boolean;
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
    if (typeof parsed.session_limit === "number" && Number.isFinite(parsed.session_limit) && parsed.session_limit >= 1) {
      result.session_limit = Math.floor(parsed.session_limit);
    }
    if (isPersistedBackendMode(parsed.backend_mode)) {
      result.backend_mode = parsed.backend_mode;
    }
    if (isTmuxLayoutMode(parsed.tmux_layout)) {
      result.tmux_layout = parsed.tmux_layout;
    }
    if (isPersistedMergeStrategy(parsed.merge_strategy)) {
      result.merge_strategy = parsed.merge_strategy;
    }
    if (isPersistedReviewMode(parsed.review_mode)) {
      result.review_mode = parsed.review_mode;
    }
    if (isPersistedCollaborationMode(parsed.collaboration_mode)) {
      result.collaboration_mode = parsed.collaboration_mode;
    }
    if (typeof parsed.update_checks_enabled === "boolean") {
      result.update_checks_enabled = parsed.update_checks_enabled;
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
    if (value === undefined) {
      continue;
    }
    if (key === "merge_strategy") {
      if (isPersistedMergeStrategy(value)) {
        merged[key] = value;
      }
      continue;
    }
    if (key === "review_mode") {
      if (isPersistedReviewMode(value)) {
        merged[key] = value;
      }
      continue;
    }
    if (key === "collaboration_mode") {
      if (isPersistedCollaborationMode(value)) {
        merged[key] = value;
      }
      continue;
    }
    if (key === "session_limit") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
        merged[key] = Math.floor(value);
      }
      continue;
    }
    if (key === "backend_mode") {
      if (isPersistedBackendMode(value)) {
        merged[key] = value;
      }
      continue;
    }
    if (key === "tmux_layout") {
      if (isTmuxLayoutMode(value)) {
        merged[key] = value;
      }
      continue;
    }
    if (key === "ai_tools") {
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string") && value.length > 0) {
        merged[key] = value;
      }
      continue;
    }
    if (key === "update_checks_enabled") {
      if (typeof value === "boolean") {
        merged[key] = value;
      }
      continue;
    }
    merged[key] = value;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
}
