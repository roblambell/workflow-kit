// Passive update-check core with 24-hour caching under ~/.ninthwave/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { loadUserConfig, type UserConfig } from "./config.ts";
import { getBundleDir } from "./paths.ts";

const LATEST_RELEASE_URL = "https://api.github.com/repos/ninthwave-sh/ninthwave/releases/latest";

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

export interface UpdateCheckDeps extends FetchLatestPublishedVersionDeps {
  now?: () => number;
  homeDir?: () => string;
  fileExists?: (path: string) => boolean;
  readTextFile?: (path: string) => string;
  writeTextFile?: (path: string, content: string) => void;
  mkdirAll?: (path: string) => void;
  loadUserConfig?: () => Pick<UserConfig, "update_checks_enabled">;
  getCurrentVersion?: () => string | null;
  fetchLatestVersion?: () => Promise<string | null>;
  getBundleDir?: () => string;
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

function buildPassiveUpdateState(cache: UpdateCheckCache): PassiveUpdateState | null {
  const currentVersion = normalizeVersion(cache.currentVersion);
  const latestVersion = normalizeVersion(cache.latestVersion);
  if (!currentVersion || !latestVersion) return null;

  return {
    status: compareVersions(currentVersion, latestVersion) < 0 ? "update-available" : "up-to-date",
    currentVersion,
    latestVersion,
    checkedAt: cache.checkedAt,
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

  if (loadUserConfigFn().update_checks_enabled === false) {
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

  return {
    cachedState: buildPassiveUpdateState(cached.cache),
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

  if (loadUserConfigFn().update_checks_enabled === false) {
    return null;
  }

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
    return buildPassiveUpdateState(cached.cache);
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

  return buildPassiveUpdateState(cache);
}
