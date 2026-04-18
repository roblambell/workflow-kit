// Project and user configuration loading and saving for the ninthwave CLI.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import {
  isAiToolId,
  mergeToolOverrides,
  type BuiltInAiToolOverrides,
  type BuiltInToolOverrideConfig,
  type BuiltInToolOverrideModeConfig,
} from "./ai-tools.ts";
import { readOriginMainFile } from "./git.ts";

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
 *
 * Exported for interactive init flows that let the user paste a pre-existing
 * team secret: callers can use this as a strict round-trip validator before
 * saving the value into `.ninthwave/config.local.json`.
 */
export function parseBrokerSecret(value: unknown): string | undefined {
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
  // Bootstrap reads consult the working tree as well as origin/main so a
  // committed-but-not-yet-pushed `project_id` (written by `nw init` before
  // the user's first push) is never silently rotated.
  const shared = loadWorkingTreeConfig(projectRoot);
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
  // Bootstrap-era reads: consult the working tree so a committed-but-not-
  // yet-pushed identity is never silently rotated on the next CLI run.
  const shared = loadWorkingTreeConfig(projectRoot);
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
 * Load project config from `.ninthwave/config.json` on `origin/main` (via
 * `git show origin/main:.ninthwave/config.json`).
 *
 * Sourcing `config.json` from origin/main (not the working tree) is what
 * lets the daemon see the same config regardless of the user's branch,
 * dirty index, or locally edited `config.json`.
 *
 * Falls back to the working tree `.ninthwave/config.json` when
 * `origin/main` does not resolve. This fallback is deliberate: loadConfig
 * is called by many non-daemon paths (init-era bootstrap, ad-hoc
 * commands outside a pushed repo) where a hard-fail would be more
 * disruptive than helpful. The daemon's deliberate hard-fail on a
 * missing `origin/main` lives in {@link loadConfigFromOriginMain} and in
 * the work-item readers, and `nw init` explicitly asserts origin/main
 * resolvability up front via {@link import("./git.ts").assertOriginMain}.
 *
 * Returns empty defaults when neither source yields a usable file.
 *
 * This reads only the *shared* (committable) config. Fields that are
 * user-specific (e.g. `ai_tool_overrides` with absolute local paths) live
 * in `.ninthwave/config.local.json` -- use {@link loadMergedProjectConfig}
 * when consumers need both.
 */
export function loadConfig(projectRoot: string): ProjectConfig {
  try {
    const raw = readOriginMainFile(
      projectRoot,
      ".ninthwave/config.json",
      "loadConfig",
    );
    if (raw !== null) {
      // origin/main resolves and has the file -- authoritative. Daemon's
      // view is the committed-and-pushed config, regardless of the
      // user's working tree.
      return parseProjectConfigContent(raw, true);
    }
    // origin/main resolves but the file does not exist there yet (e.g.
    // fresh repo immediately after `nw init` but before the first push,
    // or a pushed repo that predates ninthwave). Fall back to the
    // working-tree copy so bootstrap-era commands can still read the
    // config they just wrote. The daemon's authoritative origin/main
    // view is already the primary source above.
    return loadWorkingTreeConfig(projectRoot);
  } catch {
    // origin/main does not resolve -- fall back to the working-tree copy
    // so non-daemon callers (init-era, fresh repos, unit tests without
    // a remote) keep working. The daemon hot path uses
    // {@link loadConfigFromOriginMain} when it needs the strict
    // hard-fail behavior.
    return loadWorkingTreeConfig(projectRoot);
  }
}

/**
 * Strict variant of {@link loadConfig} that never falls back to the
 * working tree. Throws with an actionable error when `origin/main` does
 * not resolve -- intended for the daemon hot path where we want the
 * deliberate hard-fail from the acceptance spec.
 */
export function loadConfigFromOriginMain(projectRoot: string): ProjectConfig {
  const raw = readOriginMainFile(
    projectRoot,
    ".ninthwave/config.json",
    "loadConfig",
  );
  if (raw === null) return {};
  return parseProjectConfigContent(raw, true);
}

/**
 * Read `.ninthwave/config.json` directly from the user's working tree,
 * without consulting origin/main. Used only by the init-era bootstrap
 * helpers (`ensureProjectId`, `loadOrGenerateProjectIdentity`, `saveConfig`
 * merge) so they can see a committed-but-not-yet-pushed `project_id`
 * without rotating it. Not for daemon hot path use.
 */
export function loadWorkingTreeConfig(projectRoot: string): ProjectConfig {
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
 * Environment variable that lets operators override the file-based
 * `broker_secret` for a single process without touching
 * `.ninthwave/config.local.json`. Useful for ephemeral environments
 * (CI runners, shared dev containers) where the secret should not live
 * on disk.
 */
export const BROKER_SECRET_ENV_VAR = "NINTHWAVE_BROKER_SECRET";

/**
 * Resolve the effective broker secret for this session. Precedence, highest
 * to lowest:
 *
 * 1. `explicitSecret` -- typically a value piped in via `--broker-secret-stdin`.
 *    Already validated by the caller.
 * 2. `NINTHWAVE_BROKER_SECRET` environment variable. Validated here.
 * 3. Value from `.ninthwave/config.local.json` (local overlay).
 * 4. Value from `.ninthwave/config.json` (shared).
 *
 * Returns `undefined` when no layer provides a usable secret. Connect-mode
 * resolution in the orchestrator treats a missing return as "stay local".
 *
 * Does not touch the filesystem and never writes the env-var / stdin values
 * back to disk so the secret stays off disk by default.
 */
export function resolveEffectiveBrokerSecret(
  projectRoot: string,
  explicitSecret?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicitSecret !== undefined) {
    return parseBrokerSecret(explicitSecret);
  }
  const envSecret = parseBrokerSecret(env[BROKER_SECRET_ENV_VAR]);
  if (envSecret !== undefined) return envSecret;
  const local = loadLocalConfig(projectRoot);
  if (local.broker_secret !== undefined) return local.broker_secret;
  // Secret-resolving consults the working tree (not origin/main) so that
  // secrets never have to be pushed to be effective. The daemon is already
  // reading the sharable config fields from origin/main via `loadConfig`;
  // the secret stays a working-tree concept.
  const shared = loadWorkingTreeConfig(projectRoot);
  return shared.broker_secret;
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
  if (!existsSync(configPath)) {
    return (withDefaults ? {} : {}) as T extends true ? ProjectConfig : Partial<ProjectConfig>;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    return parseProjectConfigContent(raw, withDefaults);
  } catch {
    return (withDefaults ? {} : {}) as T extends true ? ProjectConfig : Partial<ProjectConfig>;
  }
}

/**
 * Parse raw JSONC config content into a ProjectConfig. Shared between the
 * filesystem loader ({@link loadProjectConfigFile}) and the origin/main
 * loader ({@link loadConfig}) so the validation/parsing logic has a
 * single home. Returns an empty/defaults object when the content is not a
 * JSON object or cannot be parsed.
 */
function parseProjectConfigContent<T extends boolean>(
  raw: string,
  withDefaults: T,
): T extends true ? ProjectConfig : Partial<ProjectConfig> {
  const defaults: ProjectConfig = {};
  const empty: Partial<ProjectConfig> = {};
  const fallback = (withDefaults ? defaults : empty) as T extends true ? ProjectConfig : Partial<ProjectConfig>;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fallback;
  }

  const obj = parsed as Record<string, unknown>;
  const result: Partial<ProjectConfig> = withDefaults ? { ...defaults } : {};
  const crewUrl = parseProjectCrewUrl(obj.crew_url);
  if (crewUrl !== undefined) result.crew_url = crewUrl;
  const projectId = parseProjectId(obj.project_id);
  if (projectId !== undefined) result.project_id = projectId;
  const brokerSecret = parseBrokerSecret(obj.broker_secret);
  if (brokerSecret !== undefined) result.broker_secret = brokerSecret;
  const overrides = parseBuiltInAiToolOverrides(obj.ai_tool_overrides);
  if (overrides) result.ai_tool_overrides = overrides;
  return result as T extends true ? ProjectConfig : Partial<ProjectConfig>;
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
