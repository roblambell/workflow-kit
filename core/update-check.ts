// Passive update-check core with 24-hour caching under ~/.ninthwave/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { loadUserConfig, type UserConfig } from "./config.ts";
import { getBundleDir } from "./paths.ts";

const LATEST_RELEASE_URL = "https://api.github.com/repos/ninthwave-sh/ninthwave/releases/latest";
const DIRECT_INSTALL_COMMAND = "curl -fsSL https://ninthwave.sh/install | bash";

export const UPDATE_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 3000;

interface UpdateCheckCache {
  currentVersion: string;
  latestVersion: string;
  checkedAt: number;
}

type CacheReadResult =
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "ok"; cache: UpdateCheckCache };

export interface PassiveUpdateState {
  status: "update-available" | "up-to-date";
  currentVersion: string;
  latestVersion: string;
  checkedAt: number;
  installSource: UpdateInstallSource;
  updateCommand: UpdateCommandMetadata | null;
  promptSuppressed: boolean;
}

export interface PassiveUpdateStartupState {
  cachedState: PassiveUpdateState | null;
  shouldRefresh: boolean;
}

export interface FetchLatestPublishedVersionDeps {
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export type UpdateInstallSource = "homebrew" | "direct" | "unknown";

export interface UpdateCommandMetadata {
  executable: string;
  args: string[];
  display: string;
}

export interface UpdateInstallMetadata {
  source: UpdateInstallSource;
  command: UpdateCommandMetadata | null;
}

export interface ResolveCurrentInstallDeps {
  homeDir?: () => string;
  getBundleDir?: () => string;
  getCurrentExecutablePath?: () => string | null;
}

export interface UpdateCheckDeps extends FetchLatestPublishedVersionDeps {
  now?: () => number;
  homeDir?: () => string;
  fileExists?: (path: string) => boolean;
  readTextFile?: (path: string) => string;
  writeTextFile?: (path: string, content: string) => void;
  mkdirAll?: (path: string) => void;
  loadUserConfig?: () => Pick<UserConfig, "update_checks_enabled" | "skipped_update_version">;
  getCurrentVersion?: () => string | null;
  fetchLatestVersion?: () => Promise<string | null>;
  getBundleDir?: () => string;
  getCurrentExecutablePath?: () => string | null;
}

function defaultReadTextFile(path: string): string {
  return readFileSync(path, "utf-8");
}

function defaultWriteTextFile(path: string, content: string): void {
  writeFileSync(path, content);
}

function defaultMkdirAll(path: string): void {
  mkdirSync(path, { recursive: true });
}

function normalizeVersion(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^v/, "");
  if (!/^\d+(?:\.\d+)*$/.test(trimmed)) return null;
  return trimmed;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10));
  const right = b.split(".").map((part) => Number.parseInt(part, 10));
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }

  return 0;
}

function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return resolve(trimmed);
  } catch {
    return null;
  }
}

function isPathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent + "/");
}

function getUpdateCommandForSource(source: UpdateInstallSource): UpdateCommandMetadata | null {
  switch (source) {
    case "homebrew":
      return {
        executable: "brew",
        args: ["upgrade", "ninthwave"],
        display: "brew upgrade ninthwave",
      };
    case "direct":
      return {
        executable: "bash",
        args: ["-lc", DIRECT_INSTALL_COMMAND],
        display: DIRECT_INSTALL_COMMAND,
      };
    default:
      return null;
  }
}

function resolveHomebrewPrefix(
  bundleDir: string | null,
  executablePath: string | null,
): string | null {
  if (!bundleDir || !executablePath) return null;
  if (basename(bundleDir) !== "ninthwave") return null;

  const shareDir = dirname(bundleDir);
  if (basename(shareDir) !== "share") return null;

  const prefix = dirname(shareDir);
  return isPathWithin(executablePath, join(prefix, "bin")) ? prefix : null;
}

export function resolveCurrentInstall(
  deps: ResolveCurrentInstallDeps = {},
): UpdateInstallMetadata {
  const homeDir = normalizePath((deps.homeDir ?? homedir)());
  const bundleDir = normalizePath((() => {
    try {
      return (deps.getBundleDir ?? getBundleDir)();
    } catch {
      return null;
    }
  })());
  const executablePath = normalizePath(
    deps.getCurrentExecutablePath?.() ?? process.execPath ?? process.argv[0] ?? null,
  );

  if (homeDir) {
    const directInstallRoot = join(homeDir, ".ninthwave");
    const directInstallBin = join(directInstallRoot, "bin");
    if (
      (bundleDir && isPathWithin(bundleDir, directInstallRoot)) ||
      (executablePath && isPathWithin(executablePath, directInstallBin))
    ) {
      return { source: "direct", command: getUpdateCommandForSource("direct") };
    }
  }

  if (resolveHomebrewPrefix(bundleDir, executablePath)) {
    return { source: "homebrew", command: getUpdateCommandForSource("homebrew") };
  }

  return { source: "unknown", command: null };
}

export function shouldSuppressUpdatePrompt(
  latestVersion: string,
  skippedVersion: string | null | undefined,
): boolean {
  return normalizeVersion(skippedVersion) === latestVersion;
}

function buildPassiveUpdateState(
  cache: UpdateCheckCache,
  config: Pick<UserConfig, "skipped_update_version">,
  installMetadata: UpdateInstallMetadata,
): PassiveUpdateState | null {
  const currentVersion = normalizeVersion(cache.currentVersion);
  const latestVersion = normalizeVersion(cache.latestVersion);
  if (!currentVersion || !latestVersion) return null;

  const status = compareVersions(currentVersion, latestVersion) < 0 ? "update-available" : "up-to-date";

  return {
    status,
    currentVersion,
    latestVersion,
    checkedAt: cache.checkedAt,
    installSource: installMetadata.source,
    updateCommand: installMetadata.command,
    promptSuppressed: status === "update-available" &&
      shouldSuppressUpdatePrompt(latestVersion, config.skipped_update_version),
  };
}

function isFreshCache(cache: UpdateCheckCache, currentVersion: string, now: number): boolean {
  return cache.currentVersion === currentVersion &&
    now >= cache.checkedAt &&
    now - cache.checkedAt < UPDATE_CHECK_CACHE_TTL_MS;
}

function readInstalledVersion(
  fileExists: (path: string) => boolean,
  readTextFile: (path: string) => string,
  getBundleDirFn: () => string,
): string | null {
  try {
    const versionPath = join(getBundleDirFn(), "VERSION");
    if (!fileExists(versionPath)) return null;
    return normalizeVersion(readTextFile(versionPath));
  } catch {
    return null;
  }
}

function readUpdateCheckCache(
  cachePath: string,
  fileExists: (path: string) => boolean,
  readTextFile: (path: string) => string,
): CacheReadResult {
  if (!fileExists(cachePath)) return { kind: "missing" };

  try {
    const parsed = JSON.parse(readTextFile(cachePath));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { kind: "malformed" };
    }

    const currentVersion = normalizeVersion(
      typeof parsed.currentVersion === "string" ? parsed.currentVersion : null,
    );
    const latestVersion = normalizeVersion(
      typeof parsed.latestVersion === "string" ? parsed.latestVersion : null,
    );
    const checkedAt = typeof parsed.checkedAt === "number" && Number.isFinite(parsed.checkedAt)
      ? parsed.checkedAt
      : null;

    if (!currentVersion || !latestVersion || checkedAt === null) {
      return { kind: "malformed" };
    }

    return {
      kind: "ok",
      cache: {
        currentVersion,
        latestVersion,
        checkedAt,
      },
    };
  } catch {
    return { kind: "malformed" };
  }
}

function writeUpdateCheckCache(
  cachePath: string,
  cache: UpdateCheckCache,
  mkdirAll: (path: string) => void,
  writeTextFile: (path: string, content: string) => void,
): void {
  mkdirAll(dirname(cachePath));
  writeTextFile(cachePath, JSON.stringify(cache, null, 2) + "\n");
}

export function getUpdateCheckCachePath(home: string = homedir()): string {
  return join(home, ".ninthwave", "update-check.json");
}

export function getPassiveUpdateStartupState(
  deps: UpdateCheckDeps = {},
): PassiveUpdateStartupState {
  const now = deps.now ?? Date.now;
  const homeDir = deps.homeDir ?? homedir;
  const fileExists = deps.fileExists ?? existsSync;
  const readTextFile = deps.readTextFile ?? defaultReadTextFile;
  const loadUserConfigFn = deps.loadUserConfig ?? loadUserConfig;
  const userConfig = loadUserConfigFn();

  if (userConfig.update_checks_enabled === false) {
    return { cachedState: null, shouldRefresh: false };
  }

  const currentVersion = normalizeVersion(
    deps.getCurrentVersion?.() ?? readInstalledVersion(fileExists, readTextFile, deps.getBundleDir ?? getBundleDir),
  );
  if (!currentVersion) {
    return { cachedState: null, shouldRefresh: false };
  }

  const cachePath = getUpdateCheckCachePath(homeDir());
  const cached = readUpdateCheckCache(cachePath, fileExists, readTextFile);
  if (cached.kind === "malformed") {
    return { cachedState: null, shouldRefresh: false };
  }
  if (cached.kind === "missing") {
    return { cachedState: null, shouldRefresh: true };
  }
  if (cached.cache.currentVersion !== currentVersion) {
    return { cachedState: null, shouldRefresh: true };
  }

  const installMetadata = resolveCurrentInstall({
    homeDir,
    getBundleDir: deps.getBundleDir,
    getCurrentExecutablePath: deps.getCurrentExecutablePath,
  });

  return {
    cachedState: buildPassiveUpdateState(cached.cache, userConfig, installMetadata),
    shouldRefresh: !isFreshCache(cached.cache, currentVersion, now()),
  };
}

export async function fetchLatestPublishedVersion(
  deps: FetchLatestPublishedVersionDeps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;
  const abortController = new AbortController();
  const timeout = setTimeoutImpl(() => abortController.abort(), UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "ninthwave",
      },
      signal: abortController.signal,
    });

    if (!response.ok) return null;

    const payload = await response.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return null;
    }
    const record = payload as Record<string, unknown>;

    return normalizeVersion(
      typeof record.tag_name === "string" ? record.tag_name : null,
    );
  } catch {
    return null;
  } finally {
    clearTimeoutImpl(timeout);
  }
}

export async function getPassiveUpdateState(
  deps: UpdateCheckDeps = {},
): Promise<PassiveUpdateState | null> {
  const now = deps.now ?? Date.now;
  const homeDir = deps.homeDir ?? homedir;
  const fileExists = deps.fileExists ?? existsSync;
  const readTextFile = deps.readTextFile ?? defaultReadTextFile;
  const writeTextFile = deps.writeTextFile ?? defaultWriteTextFile;
  const mkdirAll = deps.mkdirAll ?? defaultMkdirAll;
  const loadUserConfigFn = deps.loadUserConfig ?? loadUserConfig;
  const userConfig = loadUserConfigFn();

  if (userConfig.update_checks_enabled === false) {
    return null;
  }

  const installMetadata = resolveCurrentInstall({
    homeDir,
    getBundleDir: deps.getBundleDir,
    getCurrentExecutablePath: deps.getCurrentExecutablePath,
  });

  const currentVersion = normalizeVersion(
    deps.getCurrentVersion?.() ?? readInstalledVersion(fileExists, readTextFile, deps.getBundleDir ?? getBundleDir),
  );
  if (!currentVersion) return null;

  const cachePath = getUpdateCheckCachePath(homeDir());
  const cached = readUpdateCheckCache(cachePath, fileExists, readTextFile);
  if (cached.kind === "malformed") {
    return null;
  }
  if (cached.kind === "ok" && isFreshCache(cached.cache, currentVersion, now())) {
    return buildPassiveUpdateState(cached.cache, userConfig, installMetadata);
  }

  const latestVersion = normalizeVersion(
    await (deps.fetchLatestVersion?.() ?? fetchLatestPublishedVersion(deps)),
  );
  if (!latestVersion) return null;

  const cache: UpdateCheckCache = {
    currentVersion,
    latestVersion,
    checkedAt: now(),
  };

  try {
    writeUpdateCheckCache(cachePath, cache, mkdirAll, writeTextFile);
  } catch {
    // Cache persistence is best-effort. Fall back to the computed state.
  }

  return buildPassiveUpdateState(cache, userConfig, installMetadata);
}
