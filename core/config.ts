// Project and user configuration loading and saving for the ninthwave CLI.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import {
  isPersistedCollaborationMode,
  isPersistedMergeStrategy,
  isPersistedReviewMode,
  normalizePersistedCollaborationMode,
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
  crew_url?: string;
  /**
   * Stable anonymized identifier for this project. Written once to
   * `.ninthwave/config.json` by `loadOrGenerateProjectIdentity` and
   * referenced by the broker/crew protocols so projects can be recognized
   * without leaking directory names or repo slugs. May be overridden in
   * `.ninthwave/config.local.json` for forks that need to present a
   * different identity to a shared broker.
   */
  project_id?: string;
  /**
   * Per-project secret (32 random bytes, base64-encoded) used to authenticate
   * this project to the broker. Always generated into the gitignored
   * `.ninthwave/config.local.json` so a random secret never lands in version
   * control; teammates share the value out of band (password manager, secure
   * chat, etc.) and paste it into their own local overlay.
   */
  broker_secret?: string;
  /**
   * Per-tool launch overrides. User-specific; belongs in
   * `.ninthwave/config.local.json` (gitignored) rather than `config.json`
   * because values like `CLAUDE_CONFIG_DIR` point at the developer's local
   * home. `loadMergedProjectConfig` layers the local file over the shared
   * one so consumers don't need to know which file holds which field.
   */
  ai_tool_overrides?: BuiltInAiToolOverrides;
  /**
   * Per-repo mode settings. These live only in the gitignored
   * `.ninthwave/config.local.json` and override the global user defaults.
   */
  merge_strategy?: PersistedMergeStrategy;
  review_mode?: PersistedReviewMode;
  collaboration_mode?: PersistedCollaborationMode;
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
 * Validate a `project_id` string. Only accepts lowercase RFC 4122 version 4
 * UUIDs; anything else is treated as absent so we can regenerate a valid
 * one. Strict parsing keeps the broker protocol from having to defend
 * against surprise shapes later.
 */
function parseProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // UUID v4: 8-4-4-4-12 hex, version nibble is 4, variant nibble is 8/9/a/b.
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  return uuidV4.test(value) ? value : undefined;
}

/**
 * Validate a `broker_secret` string. Only accepts the canonical (non-URL)
 * base64 encoding of exactly 32 random bytes. Anything shorter, longer, or
 * mis-encoded is treated as absent.
 */
function parseBrokerSecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // 32 bytes base64-encoded is 44 chars including a single trailing '='.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
  try {
    // Node/Bun Buffer round-trip to confirm the decoded payload is exactly 32 bytes.
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== 32) return undefined;
    if (decoded.toString("base64") !== value) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Generate a fresh project identity pair. Exposed as a helper so tests can
 * stub the random source and so `loadOrGenerateProjectIdentity` has a
 * single point of entropy.
 */
export function generateProjectIdentity(): { project_id: string; broker_secret: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const broker_secret = Buffer.from(bytes).toString("base64");
  return {
    project_id: crypto.randomUUID(),
    broker_secret,
  };
}

/**
 * Ensure the project has a committed `project_id`. Missing values are
 * generated into `.ninthwave/config.json` only; this narrower helper never
 * provisions or mutates `broker_secret`.
 *
 * A `project_id` already present in either config file counts as satisfying
 * the requirement so local fork overrides do not get copied into the shared
 * config file.
 */
export function ensureProjectId(projectRoot: string): string {
  const shared = loadConfig(projectRoot);
  const local = loadLocalConfig(projectRoot);
  const effectiveProjectId = local.project_id ?? shared.project_id;

  if (effectiveProjectId !== undefined) {
    return effectiveProjectId;
  }

  const projectId = crypto.randomUUID();
  saveConfig(projectRoot, { project_id: projectId });
  return projectId;
}

/**
 * Ensure the project has a `project_id` and a `broker_secret`. Missing
 * fields are generated with `generateProjectIdentity` and written to the
 * appropriate file: `project_id` (public) lands in committed
 * `.ninthwave/config.json`; `broker_secret` (sensitive) lands in gitignored
 * `.ninthwave/config.local.json`. A value already present in either file
 * counts as satisfying the requirement and does not trigger a write.
 *
 * Returns the resolved identity (committed + local overlay applied).
 */
export function loadOrGenerateProjectIdentity(
  projectRoot: string,
): { project_id: string; broker_secret: string } {
  const shared = loadConfig(projectRoot);
  const local = loadLocalConfig(projectRoot);

  // Either file satisfying a field counts as "already present"; local wins
  // on reads but we don't treat a local value as a reason to re-write the
  // shared file, and vice versa.
  const effectiveProjectId = local.project_id ?? shared.project_id;
  const effectiveBrokerSecret = local.broker_secret ?? shared.broker_secret;

  const needsProjectId = effectiveProjectId === undefined;
  const needsBrokerSecret = effectiveBrokerSecret === undefined;

  if (!needsProjectId && !needsBrokerSecret) {
    return {
      project_id: effectiveProjectId!,
      broker_secret: effectiveBrokerSecret!,
    };
  }

  const generated = generateProjectIdentity();
  if (needsProjectId) {
    saveConfig(projectRoot, { project_id: generated.project_id });
  }
  if (needsBrokerSecret) {
    saveLocalConfig(projectRoot, { broker_secret: generated.broker_secret });
  }

  return {
    project_id: effectiveProjectId ?? generated.project_id,
    broker_secret: effectiveBrokerSecret ?? generated.broker_secret,
  };
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
  if (local.crew_url !== undefined) merged.crew_url = local.crew_url;
  if (local.project_id !== undefined) merged.project_id = local.project_id;
  if (local.broker_secret !== undefined) merged.broker_secret = local.broker_secret;
  const overrides = mergeToolOverrides(shared.ai_tool_overrides, local.ai_tool_overrides);
  if (overrides) merged.ai_tool_overrides = overrides;
  return merged;
}

/**
 * Strip `//` line comments and `/* ... *\/` block comments from JSONC
 * content, respecting string literals (including escaped quotes) so that a
 * `//` inside `"…"` is preserved. We accept JSONC in `.ninthwave/config.json`
 * so the init-generated file can carry a header comment pointing at
 * `config.local.json` for the `broker_secret`; the file extension stays
 * `.json` (tsconfig-style) to avoid churn in docs and external references.
 */
export function stripJsonComments(raw: string): string {
  let out = "";
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === '"') {
      // String literal -- copy through, honoring escapes so `\"` does not close.
      out += ch;
      i++;
      while (i < n) {
        const c = raw[i];
        out += c;
        i++;
        if (c === "\\" && i < n) {
          out += raw[i];
          i++;
          continue;
        }
        if (c === '"') break;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      if (i < n) i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function loadProjectConfigFile<T extends boolean>(
  configPath: string,
  withDefaults: T,
): T extends true ? ProjectConfig : Partial<ProjectConfig> {
  const defaults: ProjectConfig = {};
  const empty: Partial<ProjectConfig> = {};
  const fallback = (withDefaults ? defaults : empty) as T extends true ? ProjectConfig : Partial<ProjectConfig>;

  if (!existsSync(configPath)) return fallback;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(stripJsonComments(raw));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fallback;
    }

    const result: Partial<ProjectConfig> = withDefaults ? { ...defaults } : {};
    const crewUrl = parseProjectCrewUrl(parsed.crew_url);
    if (crewUrl !== undefined) result.crew_url = crewUrl;
    const projectId = parseProjectId(parsed.project_id);
    if (projectId !== undefined) result.project_id = projectId;
    const brokerSecret = parseBrokerSecret(parsed.broker_secret);
    if (brokerSecret !== undefined) result.broker_secret = brokerSecret;
    const overrides = parseBuiltInAiToolOverrides(parsed.ai_tool_overrides);
    if (overrides) result.ai_tool_overrides = overrides;
    if (isPersistedMergeStrategy(parsed.merge_strategy)) result.merge_strategy = parsed.merge_strategy;
    if (isPersistedReviewMode(parsed.review_mode)) result.review_mode = parsed.review_mode;
    if (isPersistedCollaborationMode(parsed.collaboration_mode)) result.collaboration_mode = parsed.collaboration_mode;
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

  saveMergedConfigFile(configPath, updates);
}

/**
 * Save partial config updates to `.ninthwave/config.local.json`. Mirrors
 * `saveConfig` but targets the gitignored overlay so secrets (notably
 * `broker_secret`) and developer-local values (e.g. `ai_tool_overrides`)
 * never land in a tracked file. Read-merge-write preserves unknown keys.
 */
export function saveLocalConfig(
  projectRoot: string,
  updates: Partial<ProjectConfig>,
): void {
  const configPath = join(projectRoot, ".ninthwave", "config.local.json");
  saveMergedConfigFile(configPath, updates);
}

function saveMergedConfigFile(
  configPath: string,
  updates: Partial<ProjectConfig>,
): void {
  // Read existing raw JSON (JSONC-tolerant) to preserve unknown keys.
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(stripJsonComments(raw));
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

function parseOverrideEnvRotation(
  value: unknown,
): Record<string, Array<string | null>> | undefined {
  if (!isPlainObject(value)) return undefined;

  const result: Record<string, Array<string | null>> = {};
  for (const [key, listValue] of Object.entries(value)) {
    if (!Array.isArray(listValue)) continue;
    const items = listValue.filter(
      (entry): entry is string | null => entry === null || typeof entry === "string",
    );
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
  max_inflight?: number;
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
    if (typeof parsed.max_inflight === "number" && Number.isFinite(parsed.max_inflight) && parsed.max_inflight >= 1) {
      result.max_inflight = Math.floor(parsed.max_inflight);
    } else if (
      // Deprecated alias: older configs used `session_limit`. Read it as
      // `max_inflight` when the new key is absent so existing files keep working.
      // The next saveUserConfig() will persist only `max_inflight`.
      typeof parsed.session_limit === "number"
      && Number.isFinite(parsed.session_limit)
      && parsed.session_limit >= 1
    ) {
      result.max_inflight = Math.floor(parsed.session_limit);
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
    const normalizedCollaborationMode = normalizePersistedCollaborationMode(parsed.collaboration_mode);
    if (normalizedCollaborationMode) {
      result.collaboration_mode = normalizedCollaborationMode;
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
  // Drop the deprecated `session_limit` alias on any write so it doesn't linger
  // in the persisted JSON once the new `max_inflight` key is in use.
  if ("session_limit" in merged) {
    delete merged.session_limit;
  }
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
      const normalized = normalizePersistedCollaborationMode(value);
      if (normalized) {
        merged[key] = normalized;
      }
      continue;
    }
    if (key === "max_inflight") {
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
