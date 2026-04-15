// Project and user configuration loading and saving for the ninthwave CLI.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import {
  isPersistedCollaborationMode,
  isPersistedMergeStrategy,
  isPersistedReviewMode,
  normalizePersistedReviewMode,
  type PersistedCollaborationMode,
  type PersistedMergeStrategy,
  type PersistedReviewMode,
} from "./tui-settings.ts";
import {
  isAiToolId,
  mergeToolOverrides,
  type BuiltInAiToolOverrides,
  type BuiltInToolOverrideConfig,
  type BuiltInToolOverrideModeConfig,
} from "./ai-tools.ts";

/** Project config shape. */
export interface ProjectConfig {
  review_external: boolean;
  crew_url?: string;
  /**
   * Per-tool launch overrides. User-specific; belongs in
   * `.ninthwave/config.local.json` (gitignored) rather than `config.json`
   * because values like `CLAUDE_CONFIG_DIR` point at the developer's local
   * home. `loadMergedProjectConfig` layers the local file over the shared
   * one so consumers don't need to know which file holds which field.
   */
  ai_tool_overrides?: BuiltInAiToolOverrides;
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
 *
 * This reads only the *shared* (committable) config file. Fields that are
 * user-specific (e.g. `ai_tool_overrides` with absolute local paths) live
 * in `.ninthwave/config.local.json` -- use `loadMergedProjectConfig` when
 * consumers need both.
 */
export function loadConfig(projectRoot: string): ProjectConfig {
  return loadProjectConfigFile(
    join(projectRoot, ".ninthwave", "config.json"),
    true,
  );
}

/**
 * Load the gitignored local overlay at .ninthwave/config.local.json.
 * Returns an empty partial config when the file is missing or malformed.
 *
 * Any field in ProjectConfig may appear here and will override the shared
 * `config.json` when read via `loadMergedProjectConfig`. The canonical use
 * is `ai_tool_overrides`, which points at the developer's local home.
 */
export function loadLocalConfig(projectRoot: string): Partial<ProjectConfig> {
  return loadProjectConfigFile(
    join(projectRoot, ".ninthwave", "config.local.json"),
    false,
  );
}

/**
 * Load `.ninthwave/config.json` merged with `.ninthwave/config.local.json`.
 * Local wins per key; `ai_tool_overrides` is deep-merged per tool / per
 * mode / per env key via `mergeToolOverrides`.
 */
export function loadMergedProjectConfig(projectRoot: string): ProjectConfig {
  const shared = loadConfig(projectRoot);
  const local = loadLocalConfig(projectRoot);
  const merged: ProjectConfig = { ...shared };
  if (local.review_external !== undefined) merged.review_external = local.review_external;
  if (local.crew_url !== undefined) merged.crew_url = local.crew_url;
  const overrides = mergeToolOverrides(shared.ai_tool_overrides, local.ai_tool_overrides);
  if (overrides) merged.ai_tool_overrides = overrides;
  return merged;
}

function loadProjectConfigFile<T extends boolean>(
  configPath: string,
  withDefaults: T,
): T extends true ? ProjectConfig : Partial<ProjectConfig> {
  const defaults: ProjectConfig = { review_external: false };
  const empty: Partial<ProjectConfig> = {};
  const fallback = (withDefaults ? defaults : empty) as T extends true ? ProjectConfig : Partial<ProjectConfig>;

  if (!existsSync(configPath)) return fallback;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fallback;
    }

    const result: Partial<ProjectConfig> = withDefaults ? { ...defaults } : {};
    if (withDefaults || parsed.review_external !== undefined) {
      result.review_external = parsed.review_external === true;
    }
    const crewUrl = parseProjectCrewUrl(parsed.crew_url);
    if (crewUrl !== undefined) result.crew_url = crewUrl;
    const overrides = parseBuiltInAiToolOverrides(parsed.ai_tool_overrides);
    if (overrides) result.ai_tool_overrides = overrides;
    return result as T extends true ? ProjectConfig : Partial<ProjectConfig>;
  } catch {
    return fallback;
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

function parseSkippedUpdateVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().replace(/^v/, "");
  return /^\d+(?:\.\d+)*$/.test(normalized) ? normalized : undefined;
}

export function isTmuxLayoutMode(value: unknown): value is TmuxLayoutMode {
  return TMUX_LAYOUT_MODES.includes(value as TmuxLayoutMode);
}

export function projectUserConfigKey(projectRoot: string): string {
  return projectRoot.replace(/\//g, "-");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOverrideArgs(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string")
    ? [...value]
    : undefined;
}

function parseOverrideEnv(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;

  const envEntries = Object.entries(value)
    .filter(([, envValue]) => typeof envValue === "string") as Array<[string, string]>;
  return envEntries.length > 0 ? Object.fromEntries(envEntries) : undefined;
}

function parseOverrideEnvRotation(value: unknown): Record<string, string[]> | undefined {
  if (!isPlainObject(value)) return undefined;

  const result: Record<string, string[]> = {};
  for (const [key, listValue] of Object.entries(value)) {
    if (!Array.isArray(listValue)) continue;
    const items = listValue.filter((entry): entry is string => typeof entry === "string");
    if (items.length > 0) result[key] = items;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseBuiltInToolOverrideModeConfig(value: unknown): BuiltInToolOverrideModeConfig | undefined {
  if (!isPlainObject(value)) return undefined;

  const result: BuiltInToolOverrideModeConfig = {};
  if (typeof value.command === "string" && value.command.trim().length > 0) {
    result.command = value.command;
  }

  const args = parseOverrideArgs(value.args);
  if (args) result.args = args;

  const env = parseOverrideEnv(value.env);
  if (env) result.env = env;

  const envRotation = parseOverrideEnvRotation(value.env_rotation);
  if (envRotation) result.env_rotation = envRotation;

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseBuiltInToolOverrideConfig(value: unknown): BuiltInToolOverrideConfig | undefined {
  if (!isPlainObject(value)) return undefined;

  const result: BuiltInToolOverrideConfig = {
    ...(parseBuiltInToolOverrideModeConfig(value) ?? {}),
  };

  const launch = parseBuiltInToolOverrideModeConfig(value.launch);
  if (launch) result.launch = launch;

  const headless = parseBuiltInToolOverrideModeConfig(value.headless);
  if (headless) result.headless = headless;

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseBuiltInAiToolOverrides(value: unknown): BuiltInAiToolOverrides | undefined {
  if (!isPlainObject(value)) return undefined;

  const result: BuiltInAiToolOverrides = {};
  for (const [toolId, toolOverride] of Object.entries(value)) {
    if (!isAiToolId(toolId)) continue;
    const parsedOverride = parseBuiltInToolOverrideConfig(toolOverride);
    if (parsedOverride) result[toolId] = parsedOverride;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export interface UserConfig {
  ai_tools?: string[];
  ai_tool_overrides?: BuiltInAiToolOverrides;
  session_limit?: number;
  tmux_layout?: TmuxLayoutMode;
  merge_strategy?: PersistedMergeStrategy;
  review_mode?: PersistedReviewMode;
  collaboration_mode?: PersistedCollaborationMode;
  update_checks_enabled?: boolean;
  skipped_update_version?: string;
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
    const aiToolOverrides = parseBuiltInAiToolOverrides(parsed.ai_tool_overrides);
    if (aiToolOverrides) {
      result.ai_tool_overrides = aiToolOverrides;
    }
    if (typeof parsed.session_limit === "number" && Number.isFinite(parsed.session_limit) && parsed.session_limit >= 1) {
      result.session_limit = Math.floor(parsed.session_limit);
    }
    if (isTmuxLayoutMode(parsed.tmux_layout)) {
      result.tmux_layout = parsed.tmux_layout;
    }
    if (isPersistedMergeStrategy(parsed.merge_strategy)) {
      result.merge_strategy = parsed.merge_strategy;
    }
    const normalizedReviewMode = normalizePersistedReviewMode(parsed.review_mode);
    if (normalizedReviewMode) {
      result.review_mode = normalizedReviewMode;
    }
    if (isPersistedCollaborationMode(parsed.collaboration_mode)) {
      result.collaboration_mode = parsed.collaboration_mode;
    }
    if (typeof parsed.update_checks_enabled === "boolean") {
      result.update_checks_enabled = parsed.update_checks_enabled;
    }
    const skippedUpdateVersion = parseSkippedUpdateVersion(parsed.skipped_update_version);
    if (skippedUpdateVersion) {
      result.skipped_update_version = skippedUpdateVersion;
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
    if (key === "ai_tool_overrides") {
      const parsed = parseBuiltInAiToolOverrides(value);
      if (parsed) {
        merged[key] = parsed;
      }
      continue;
    }
    if (key === "update_checks_enabled") {
      if (typeof value === "boolean") {
        merged[key] = value;
      }
      continue;
    }
    if (key === "skipped_update_version") {
      const parsed = parseSkippedUpdateVersion(value);
      if (parsed) {
        merged[key] = parsed;
      }
      continue;
    }
    merged[key] = value;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
}
