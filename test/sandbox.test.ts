// Tests for core/sandbox.ts — nono sandbox integration for worker processes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";
import {
  isNonoAvailable,
  warnOnceNoSandbox,
  _resetWarnState,
  buildDefaultConfig,
  applySandboxOverrides,
  buildSandboxCommand,
  wrapWithSandbox,
  type SandboxConfig,
} from "../core/sandbox.ts";
import type { RunResult } from "../core/types.ts";

/** Create a fake ShellRunner that returns success for `which nono`. */
function nonoInstalled() {
  return (cmd: string, args: string[]): RunResult => {
    if (cmd === "which" && args[0] === "nono") {
      return { stdout: "/usr/local/bin/nono", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "not found", exitCode: 1 };
  };
}

/** Create a fake ShellRunner where nono is NOT installed. */
function nonoMissing() {
  return (_cmd: string, _args: string[]): RunResult => {
    return { stdout: "", stderr: "not found", exitCode: 1 };
  };
}

describe("isNonoAvailable", () => {
  it("returns true when nono is installed", () => {
    expect(isNonoAvailable(nonoInstalled())).toBe(true);
  });

  it("returns false when nono is not installed", () => {
    expect(isNonoAvailable(nonoMissing())).toBe(false);
  });

  it("returns false when runner throws", () => {
    const throwing = () => {
      throw new Error("spawn error");
    };
    expect(isNonoAvailable(throwing as any)).toBe(false);
  });
});

describe("warnOnceNoSandbox", () => {
  beforeEach(() => {
    _resetWarnState();
  });

  it("emits warning on first call", () => {
    const warnings: string[] = [];
    const result = warnOnceNoSandbox((msg) => warnings.push(msg));
    expect(result).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nono not found");
  });

  it("does not emit warning on second call", () => {
    const warnings: string[] = [];
    warnOnceNoSandbox((msg) => warnings.push(msg));
    const result = warnOnceNoSandbox((msg) => warnings.push(msg));
    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});

describe("buildDefaultConfig", () => {
  it("includes worktree path as read-write", () => {
    const config = buildDefaultConfig("/tmp/worktree", "/tmp/project");
    expect(config.paths.readWrite).toEqual(["/tmp/worktree"]);
  });

  it("is enabled by default", () => {
    const config = buildDefaultConfig("/tmp/worktree", "/tmp/project");
    expect(config.enabled).toBe(true);
  });

  it("includes default network hosts", () => {
    const config = buildDefaultConfig("/tmp/worktree", "/tmp/project");
    expect(config.network.allowHosts).toContain("api.github.com");
    expect(config.network.allowHosts).toContain("github.com");
    expect(config.network.allowHosts).toContain("registry.npmjs.org");
    expect(config.network.allowHosts).toContain("bun.sh");
  });

  it("includes project root in read-only paths", () => {
    // Use a path that exists on the test machine
    const repo = setupTempRepo();
    const config = buildDefaultConfig("/tmp/worktree", repo);
    expect(config.paths.readOnly).toContain(repo);
  });

  afterEach(() => {
    cleanupTempRepos();
  });
});

describe("applySandboxOverrides", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("returns base config when no config file exists", () => {
    const base: SandboxConfig = {
      enabled: true,
      paths: { readWrite: ["/rw"], readOnly: ["/ro"] },
      network: { allowHosts: ["example.com"] },
    };
    const result = applySandboxOverrides("/nonexistent/path", base);
    expect(result).toEqual(base);
  });

  it("adds extra read-write paths from config", () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(repo, ".ninthwave", "config"),
      "sandbox_extra_rw_paths=/tmp/extra1,/tmp/extra2\n",
    );

    const base: SandboxConfig = {
      enabled: true,
      paths: { readWrite: ["/rw"], readOnly: [] },
      network: { allowHosts: [] },
    };
    const result = applySandboxOverrides(repo, base);
    expect(result.paths.readWrite).toEqual(["/rw", "/tmp/extra1", "/tmp/extra2"]);
  });

  it("adds extra read-only paths from config", () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(repo, ".ninthwave", "config"),
      "sandbox_extra_ro_paths=/opt/custom\n",
    );

    const base: SandboxConfig = {
      enabled: true,
      paths: { readWrite: [], readOnly: ["/ro"] },
      network: { allowHosts: [] },
    };
    const result = applySandboxOverrides(repo, base);
    expect(result.paths.readOnly).toEqual(["/ro", "/opt/custom"]);
  });

  it("adds extra network hosts from config", () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(repo, ".ninthwave", "config"),
      "sandbox_extra_hosts=api.custom.com,cdn.custom.com\n",
    );

    const base: SandboxConfig = {
      enabled: true,
      paths: { readWrite: [], readOnly: [] },
      network: { allowHosts: ["api.github.com"] },
    };
    const result = applySandboxOverrides(repo, base);
    expect(result.network.allowHosts).toEqual([
      "api.github.com",
      "api.custom.com",
      "cdn.custom.com",
    ]);
  });

  it("does not mutate the base config", () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(repo, ".ninthwave", "config"),
      "sandbox_extra_rw_paths=/tmp/extra\n",
    );

    const base: SandboxConfig = {
      enabled: true,
      paths: { readWrite: ["/rw"], readOnly: [] },
      network: { allowHosts: [] },
    };
    applySandboxOverrides(repo, base);
    expect(base.paths.readWrite).toEqual(["/rw"]);
  });

  it("ignores comments and blank lines", () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(repo, ".ninthwave", "config"),
      "# comment\n\nsandbox_extra_hosts=api.custom.com\n",
    );

    const base: SandboxConfig = {
      enabled: true,
      paths: { readWrite: [], readOnly: [] },
      network: { allowHosts: [] },
    };
    const result = applySandboxOverrides(repo, base);
    expect(result.network.allowHosts).toEqual(["api.custom.com"]);
  });
});

describe("buildSandboxCommand", () => {
  it("wraps command with nono and flags", () => {
    const config: SandboxConfig = {
      enabled: true,
      paths: {
        readWrite: ["/tmp/worktree"],
        readOnly: ["/home/user/project"],
      },
      network: {
        allowHosts: ["api.github.com"],
      },
    };

    const result = buildSandboxCommand(config, "claude --agent todo-worker");
    expect(result).toBe(
      "nono run --allow /tmp/worktree --read /home/user/project --allow-domain api.github.com -- claude --agent todo-worker",
    );
  });

  it("handles multiple paths and hosts", () => {
    const config: SandboxConfig = {
      enabled: true,
      paths: {
        readWrite: ["/rw1", "/rw2"],
        readOnly: ["/ro1", "/ro2"],
      },
      network: {
        allowHosts: ["host1.com", "host2.com"],
      },
    };

    const result = buildSandboxCommand(config, "cmd");
    expect(result).toBe(
      "nono run --allow /rw1 --allow /rw2 --read /ro1 --read /ro2 --allow-domain host1.com --allow-domain host2.com -- cmd",
    );
  });

  it("handles empty policies", () => {
    const config: SandboxConfig = {
      enabled: true,
      paths: { readWrite: [], readOnly: [] },
      network: { allowHosts: [] },
    };

    const result = buildSandboxCommand(config, "cmd");
    expect(result).toBe("nono run -- cmd");
  });
});

describe("wrapWithSandbox", () => {
  beforeEach(() => {
    _resetWarnState();
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it("returns original command when disabled", () => {
    const result = wrapWithSandbox("claude --agent", "/wt", "/proj", {
      disabled: true,
      runner: nonoInstalled(),
    });
    expect(result).toBe("claude --agent");
  });

  it("returns original command when nono not installed and warns once", () => {
    const warnings: string[] = [];
    const result = wrapWithSandbox("claude --agent", "/wt", "/proj", {
      runner: nonoMissing(),
      warnFn: (msg) => warnings.push(msg),
    });
    expect(result).toBe("claude --agent");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nono not found");
  });

  it("warns only once across multiple calls when nono missing", () => {
    const warnings: string[] = [];
    wrapWithSandbox("cmd1", "/wt", "/proj", {
      runner: nonoMissing(),
      warnFn: (msg) => warnings.push(msg),
    });
    wrapWithSandbox("cmd2", "/wt", "/proj", {
      runner: nonoMissing(),
      warnFn: (msg) => warnings.push(msg),
    });
    expect(warnings).toHaveLength(1);
  });

  it("wraps command with nono when available", () => {
    const repo = setupTempRepo();
    const result = wrapWithSandbox("claude --agent", "/tmp/worktree", repo, {
      runner: nonoInstalled(),
    });
    expect(result).toMatch(/^nono run /);
    expect(result).toContain("--allow /tmp/worktree");
    expect(result).toContain(`--read ${repo}`);
    expect(result).toContain("--allow-domain api.github.com");
    expect(result).toContain("-- claude --agent");
  });

  it("applies config overrides from .ninthwave/config", () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(repo, ".ninthwave", "config"),
      "sandbox_extra_hosts=custom.api.com\n",
    );

    const result = wrapWithSandbox("claude --agent", "/tmp/worktree", repo, {
      runner: nonoInstalled(),
    });
    expect(result).toContain("--allow-domain custom.api.com");
  });
});
