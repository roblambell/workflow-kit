// Unit tests for the manual update runner (`nw update`). These exercise
// runUpdate() through injected deps -- no real subprocesses are spawned, no
// real filesystem detection happens, and nothing touches the user's install.

import { describe, expect, it, vi } from "vitest";
import { runUpdate, type UpdateSpawnResult } from "../core/commands/update.ts";
import type { UpdateInstallMetadata } from "../core/update-check.ts";

const HOMEBREW_INSTALL: UpdateInstallMetadata = {
  source: "homebrew",
  command: {
    executable: "brew",
    args: ["upgrade", "ninthwave"],
    display: "brew upgrade ninthwave",
  },
};

const DIRECT_INSTALL: UpdateInstallMetadata = {
  source: "direct",
  command: {
    executable: "bash",
    args: ["-lc", "curl -fsSL https://ninthwave.sh/install | bash"],
    display: "curl -fsSL https://ninthwave.sh/install | bash",
  },
};

const UNKNOWN_INSTALL: UpdateInstallMetadata = {
  source: "unknown",
  command: null,
};

interface Sink {
  log: string[];
  err: string[];
}

function makeSink(): { sink: Sink; log: (line: string) => void; err: (line: string) => void } {
  const sink: Sink = { log: [], err: [] };
  return {
    sink,
    log: (line: string) => { sink.log.push(line); },
    err: (line: string) => { sink.err.push(line); },
  };
}

describe("runUpdate", () => {
  it("runs Homebrew's updater and reports success with restart guidance", () => {
    const spawn = vi.fn<(cmd: string, args: string[]) => UpdateSpawnResult>(
      () => ({ exitCode: 0 }),
    );
    const { sink, log, err } = makeSink();

    const result = runUpdate({
      resolveInstall: () => HOMEBREW_INSTALL,
      spawn,
      log,
      err,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("brew", ["upgrade", "ninthwave"]);
    expect(result).toEqual({
      installSource: "homebrew",
      exitCode: 0,
      outcome: "updated",
    });
    expect(sink.log.join("\n")).toContain("Updating ninthwave via: brew upgrade ninthwave");
    expect(sink.log.join("\n")).toContain("Update complete.");
    expect(sink.log.join("\n")).toContain("Restart any running `nw` sessions");
    expect(sink.err).toEqual([]);
  });

  it("runs the direct-install updater and reports success", () => {
    const spawn = vi.fn<(cmd: string, args: string[]) => UpdateSpawnResult>(
      () => ({ exitCode: 0 }),
    );
    const { sink, log, err } = makeSink();

    const result = runUpdate({
      resolveInstall: () => DIRECT_INSTALL,
      spawn,
      log,
      err,
    });

    expect(spawn).toHaveBeenCalledWith("bash", [
      "-lc",
      "curl -fsSL https://ninthwave.sh/install | bash",
    ]);
    expect(result).toEqual({
      installSource: "direct",
      exitCode: 0,
      outcome: "updated",
    });
    expect(sink.log.join("\n")).toContain(
      "Updating ninthwave via: curl -fsSL https://ninthwave.sh/install | bash",
    );
    expect(sink.log.join("\n")).toContain("Update complete.");
    expect(sink.err).toEqual([]);
  });

  it("propagates a non-zero exit code and explains where to run the command manually", () => {
    const spawn = vi.fn<(cmd: string, args: string[]) => UpdateSpawnResult>(
      () => ({ exitCode: 42 }),
    );
    const { sink, log, err } = makeSink();

    const result = runUpdate({
      resolveInstall: () => HOMEBREW_INSTALL,
      spawn,
      log,
      err,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      installSource: "homebrew",
      exitCode: 42,
      outcome: "update-failed",
    });
    expect(sink.err.join("\n")).toContain("Update command exited with code 42");
    expect(sink.err.join("\n")).toContain("brew upgrade ninthwave");
    // No restart guidance on failure.
    expect(sink.log.join("\n")).not.toContain("Update complete.");
  });

  it("prints manual instructions and returns non-zero for unknown installs", () => {
    const spawn = vi.fn<(cmd: string, args: string[]) => UpdateSpawnResult>(
      () => ({ exitCode: 0 }),
    );
    const { sink, log, err } = makeSink();

    const result = runUpdate({
      resolveInstall: () => UNKNOWN_INSTALL,
      spawn,
      log,
      err,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(result.installSource).toBe("unknown");
    expect(result.exitCode).not.toBe(0);
    expect(result.outcome).toBe("unknown-install");

    const stderr = sink.err.join("\n");
    expect(stderr).toContain("Could not detect how this ninthwave install was managed");
    expect(stderr).toContain("brew upgrade ninthwave");
    expect(stderr).toContain("curl -fsSL https://ninthwave.sh/install | bash");
    expect(stderr).toContain("Restart any running `nw` sessions");
    // No success output.
    expect(sink.log).toEqual([]);
  });

  it("treats a missing command on a known source as unknown (defensive fallback)", () => {
    const spawn = vi.fn<(cmd: string, args: string[]) => UpdateSpawnResult>(
      () => ({ exitCode: 0 }),
    );
    const { sink, log, err } = makeSink();

    const result = runUpdate({
      // Synthesized pathological case: source tagged but no command metadata.
      resolveInstall: () => ({ source: "homebrew", command: null }),
      spawn,
      log,
      err,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(result.exitCode).not.toBe(0);
    expect(result.outcome).toBe("no-command");
    expect(sink.err.join("\n")).toContain("Could not detect how this ninthwave install was managed");
  });
});
