import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  getPassiveUpdateStartupState,
  getPassiveUpdateState,
  getUpdateCheckCachePath,
  resolveCurrentInstall,
  UPDATE_CHECK_CACHE_TTL_MS,
} from "../core/update-check.ts";
import { cleanupTempRepos, setupTempRepo } from "./helpers.ts";

const NOW = Date.UTC(2026, 3, 1, 12, 0, 0);
type FetchLatestVersionMock = ReturnType<typeof vi.fn<() => Promise<string | null>>>;

afterEach(() => {
  cleanupTempRepos();
});

function writeCache(home: string, cache: Record<string, unknown>): void {
  mkdirSync(home + "/.ninthwave", { recursive: true });
  writeFileSync(getUpdateCheckCachePath(home), JSON.stringify(cache, null, 2) + "\n");
}

function readCache(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(getUpdateCheckCachePath(home), "utf-8"));
}

function createDeps(overrides: {
  home?: string;
  now?: number;
  currentVersion?: string | null;
  userConfig?: { update_checks_enabled?: boolean; skipped_update_version?: string };
  fetchLatestVersion?: FetchLatestVersionMock;
  bundleDir?: string;
  currentExecutablePath?: string | null;
} = {}) {
  const home = overrides.home ?? setupTempRepo();
  const fetchLatestVersion = overrides.fetchLatestVersion ?? vi.fn<() => Promise<string | null>>(async () => "0.4.0");
  const bundleDir = overrides.bundleDir ?? join(home, "dev-bundle");
  const currentExecutablePath = overrides.currentExecutablePath ?? join(home, "dev-bin", "ninthwave");

  return {
    home,
    fetchLatestVersion,
    deps: {
      now: () => overrides.now ?? NOW,
      homeDir: () => home,
      loadUserConfig: () => overrides.userConfig ?? {},
      getCurrentVersion: () => overrides.currentVersion ?? "0.3.9",
      fetchLatestVersion,
      getBundleDir: () => bundleDir,
      getCurrentExecutablePath: () => currentExecutablePath,
    },
  };
}

function expectUnknownInstallState(overrides: Record<string, unknown> = {}) {
  return {
    installSource: "unknown",
    updateCommand: null,
    promptSuppressed: false,
    ...overrides,
  };
}

describe("resolveCurrentInstall", () => {
  it("detects Homebrew-managed installs", () => {
    const home = setupTempRepo();

    expect(resolveCurrentInstall({
      homeDir: () => home,
      getBundleDir: () => "/opt/homebrew/share/ninthwave",
      getCurrentExecutablePath: () => "/opt/homebrew/bin/ninthwave",
    })).toEqual({
      source: "homebrew",
      command: {
        executable: "brew",
        args: ["upgrade", "ninthwave"],
        display: "brew upgrade ninthwave",
      },
    });
  });

  it("detects direct installs under ~/.ninthwave", () => {
    const home = setupTempRepo();

    expect(resolveCurrentInstall({
      homeDir: () => home,
      getBundleDir: () => join(home, ".ninthwave"),
      getCurrentExecutablePath: () => join(home, ".ninthwave", "bin", "ninthwave"),
    })).toEqual({
      source: "direct",
      command: {
        executable: "bash",
        args: ["-lc", "curl -fsSL https://ninthwave.sh/install | bash"],
        display: "curl -fsSL https://ninthwave.sh/install | bash",
      },
    });
  });

  it("returns unknown for unsupported layouts", () => {
    const home = setupTempRepo();

    expect(resolveCurrentInstall({
      homeDir: () => home,
      getBundleDir: () => join(home, "repo"),
      getCurrentExecutablePath: () => join(home, "repo", "bin", "ninthwave"),
    })).toEqual({
      source: "unknown",
      command: null,
    });
  });
});

describe("getPassiveUpdateStartupState", () => {
  it("suppresses only the dismissed release version", () => {
    const { home, deps } = createDeps({
      userConfig: { skipped_update_version: "0.4.0" },
    });
    writeCache(home, {
      currentVersion: "0.3.9",
      latestVersion: "0.4.0",
      checkedAt: NOW - 60_000,
    });

    const state = getPassiveUpdateStartupState(deps);

    expect(state).toEqual({
      cachedState: {
        status: "update-available",
        currentVersion: "0.3.9",
        latestVersion: "0.4.0",
        checkedAt: NOW - 60_000,
        ...expectUnknownInstallState({ promptSuppressed: true }),
      },
      shouldRefresh: false,
    });
  });

  it("re-enables the prompt when a newer release is offered", () => {
    const { home, deps } = createDeps({
      userConfig: { skipped_update_version: "0.4.0" },
    });
    writeCache(home, {
      currentVersion: "0.3.9",
      latestVersion: "0.4.1",
      checkedAt: NOW - 60_000,
    });

    const state = getPassiveUpdateStartupState(deps);

    expect(state).toEqual({
      cachedState: {
        status: "update-available",
        currentVersion: "0.3.9",
        latestVersion: "0.4.1",
        checkedAt: NOW - 60_000,
        ...expectUnknownInstallState(),
      },
      shouldRefresh: false,
    });
  });
});

describe("getPassiveUpdateState", () => {
  it("uses a fresh cache without a remote lookup", async () => {
    const { home, fetchLatestVersion, deps } = createDeps();
    writeCache(home, {
      currentVersion: "0.3.9",
      latestVersion: "0.4.0",
      checkedAt: NOW - 60_000,
    });

    const state = await getPassiveUpdateState(deps);

    expect(fetchLatestVersion).not.toHaveBeenCalled();
    expect(state).toEqual({
      status: "update-available",
      currentVersion: "0.3.9",
      latestVersion: "0.4.0",
      checkedAt: NOW - 60_000,
      ...expectUnknownInstallState(),
    });
  });

  it("refreshes the cache after 24 hours", async () => {
    const { home, fetchLatestVersion, deps } = createDeps({
      fetchLatestVersion: vi.fn<() => Promise<string | null>>(async () => "0.4.1"),
    });
    writeCache(home, {
      currentVersion: "0.3.9",
      latestVersion: "0.4.0",
      checkedAt: NOW - UPDATE_CHECK_CACHE_TTL_MS - 1,
    });

    const state = await getPassiveUpdateState(deps);

    expect(fetchLatestVersion).toHaveBeenCalledTimes(1);
    expect(state).toEqual({
      status: "update-available",
      currentVersion: "0.3.9",
      latestVersion: "0.4.1",
      checkedAt: NOW,
      ...expectUnknownInstallState(),
    });
    expect(readCache(home)).toMatchObject({
      currentVersion: "0.3.9",
      latestVersion: "0.4.1",
      checkedAt: NOW,
    });
  });

  it("invalidates cached results when the installed version changes", async () => {
    const { home, fetchLatestVersion, deps } = createDeps({
      currentVersion: "0.4.0",
      fetchLatestVersion: vi.fn<() => Promise<string | null>>(async () => "0.4.1"),
    });
    writeCache(home, {
      currentVersion: "0.3.9",
      latestVersion: "0.4.0",
      checkedAt: NOW - 60_000,
    });

    const state = await getPassiveUpdateState(deps);

    expect(fetchLatestVersion).toHaveBeenCalledTimes(1);
    expect(state).toEqual({
      status: "update-available",
      currentVersion: "0.4.0",
      latestVersion: "0.4.1",
      checkedAt: NOW,
      ...expectUnknownInstallState(),
    });
    expect(readCache(home)).toMatchObject({
      currentVersion: "0.4.0",
      latestVersion: "0.4.1",
      checkedAt: NOW,
    });
  });

  it("returns update-available when the latest version is newer", async () => {
    const { home, deps } = createDeps({
      fetchLatestVersion: vi.fn<() => Promise<string | null>>(async () => "0.4.0"),
    });

    const state = await getPassiveUpdateState(deps);

    expect(state).toEqual({
      status: "update-available",
      currentVersion: "0.3.9",
      latestVersion: "0.4.0",
      checkedAt: NOW,
      ...expectUnknownInstallState(),
    });
    expect(existsSync(getUpdateCheckCachePath(home))).toBe(true);
  });

  it("returns up-to-date when the latest version matches the current version", async () => {
    const { deps } = createDeps({
      fetchLatestVersion: vi.fn<() => Promise<string | null>>(async () => "0.3.9"),
    });

    const state = await getPassiveUpdateState(deps);

    expect(state).toEqual({
      status: "up-to-date",
      currentVersion: "0.3.9",
      latestVersion: "0.3.9",
      checkedAt: NOW,
      ...expectUnknownInstallState(),
    });
  });

  it("carries install metadata for supported sources without changing update status", async () => {
    const { deps } = createDeps({
      bundleDir: "/opt/homebrew/share/ninthwave",
      currentExecutablePath: "/opt/homebrew/bin/ninthwave",
      fetchLatestVersion: vi.fn<() => Promise<string | null>>(async () => "0.4.0"),
    });

    const state = await getPassiveUpdateState(deps);

    expect(state).toEqual({
      status: "update-available",
      currentVersion: "0.3.9",
      latestVersion: "0.4.0",
      checkedAt: NOW,
      installSource: "homebrew",
      updateCommand: {
        executable: "brew",
        args: ["upgrade", "ninthwave"],
        display: "brew upgrade ninthwave",
      },
      promptSuppressed: false,
    });
  });

  it("fails closed when the remote lookup fails", async () => {
    const { home, deps } = createDeps({
      fetchLatestVersion: vi.fn<() => Promise<string | null>>(async () => null),
    });

    const state = await getPassiveUpdateState(deps);

    expect(state).toBeNull();
    expect(existsSync(getUpdateCheckCachePath(home))).toBe(false);
  });

  it("fails closed when cached data is malformed", async () => {
    const { fetchLatestVersion, deps, home } = createDeps();
    writeCache(home, {
      currentVersion: "0.3.9",
      latestVersion: 42,
      checkedAt: NOW - 60_000,
    });

    const state = await getPassiveUpdateState(deps);

    expect(state).toBeNull();
    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });

  it("fails closed when update checks are disabled", async () => {
    const { fetchLatestVersion, deps } = createDeps({
      userConfig: { update_checks_enabled: false },
    });

    const state = await getPassiveUpdateState(deps);

    expect(state).toBeNull();
    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });
});
