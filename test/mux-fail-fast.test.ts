// Tests for mux fail-fast behavior: isAvailable() session checks,
// diagnoseUnavailable() messages, and error message correctness.
// Separated from mux.test.ts to avoid vi.mock leakage.

import { describe, it, expect } from "vitest";
import {
  TmuxAdapter,
  ZellijAdapter,
  CmuxAdapter,
  type ShellRunner,
  type MuxType,
} from "../core/mux.ts";

// ── Helper: mock shell runner ───────────────────────────────────────

const ok = { exitCode: 0, stdout: "", stderr: "" };
const fail = { exitCode: 1, stdout: "", stderr: "not found" };

function mockRunner(
  responses: Record<string, { exitCode: number; stdout: string; stderr: string }>,
): ShellRunner {
  return (_cmd: string, args: string[]) => {
    const subcommand = args[0] ?? _cmd;
    return responses[subcommand] ?? fail;
  };
}

// ── ZellijAdapter.isAvailable() ─────────────────────────────────────

describe("ZellijAdapter.isAvailable — session check", () => {
  it("returns true when binary exists AND ZELLIJ_SESSION_NAME is set", () => {
    const runner = mockRunner({
      "--version": { exitCode: 0, stdout: "zellij 0.42.0", stderr: "" },
    });
    const adapter = new ZellijAdapter(runner, {
      env: { ZELLIJ_SESSION_NAME: "my-session" },
    });
    expect(adapter.isAvailable()).toBe(true);
  });

  it("returns false when binary exists but ZELLIJ_SESSION_NAME is unset", () => {
    const runner = mockRunner({
      "--version": { exitCode: 0, stdout: "zellij 0.42.0", stderr: "" },
    });
    const adapter = new ZellijAdapter(runner, { env: {} });
    expect(adapter.isAvailable()).toBe(false);
  });

  it("returns false when binary is not installed", () => {
    const runner = mockRunner({
      "--version": { exitCode: 1, stdout: "", stderr: "not found" },
    });
    const adapter = new ZellijAdapter(runner, {
      env: { ZELLIJ_SESSION_NAME: "my-session" },
    });
    expect(adapter.isAvailable()).toBe(false);
  });

  it("returns false when neither binary nor session is available", () => {
    const runner = mockRunner({
      "--version": { exitCode: 1, stdout: "", stderr: "not found" },
    });
    const adapter = new ZellijAdapter(runner, { env: {} });
    expect(adapter.isAvailable()).toBe(false);
  });
});

// ── TmuxAdapter.isAvailable() ───────────────────────────────────────

describe("TmuxAdapter.isAvailable — session check", () => {
  it("returns true when binary exists AND TMUX is set", () => {
    const runner = mockRunner({
      "-V": { exitCode: 0, stdout: "tmux 3.4", stderr: "" },
    });
    const adapter = new TmuxAdapter(runner, {
      env: { TMUX: "/tmp/tmux-501/default,12345,0" },
    });
    expect(adapter.isAvailable()).toBe(true);
  });

  it("returns false when binary exists but TMUX is unset", () => {
    const runner = mockRunner({
      "-V": { exitCode: 0, stdout: "tmux 3.4", stderr: "" },
    });
    const adapter = new TmuxAdapter(runner, { env: {} });
    expect(adapter.isAvailable()).toBe(false);
  });

  it("returns false when binary is not installed", () => {
    const runner = mockRunner({
      "-V": { exitCode: 1, stdout: "", stderr: "not found" },
    });
    const adapter = new TmuxAdapter(runner, {
      env: { TMUX: "/tmp/tmux-501/default,12345,0" },
    });
    expect(adapter.isAvailable()).toBe(false);
  });

  it("returns false when neither binary nor session is available", () => {
    const runner = mockRunner({
      "-V": { exitCode: 1, stdout: "", stderr: "not found" },
    });
    const adapter = new TmuxAdapter(runner, { env: {} });
    expect(adapter.isAvailable()).toBe(false);
  });
});

// ── diagnoseUnavailable() ───────────────────────────────────────────

describe("ZellijAdapter.diagnoseUnavailable", () => {
  it("reports 'binary not found' when zellij is not installed", () => {
    const runner = mockRunner({
      "--version": { exitCode: 1, stdout: "", stderr: "not found" },
    });
    const adapter = new ZellijAdapter(runner, { env: {} });
    const msg = adapter.diagnoseUnavailable();
    expect(msg).toContain("zellij binary not found");
    expect(msg).not.toContain("No active zellij session");
  });

  it("reports 'no active session' when binary exists but no session", () => {
    const runner = mockRunner({
      "--version": { exitCode: 0, stdout: "zellij 0.42.0", stderr: "" },
    });
    const adapter = new ZellijAdapter(runner, { env: {} });
    const msg = adapter.diagnoseUnavailable();
    expect(msg).toContain("No active zellij session");
    expect(msg).not.toContain("binary not found");
  });
});

describe("TmuxAdapter.diagnoseUnavailable", () => {
  it("reports 'binary not found' when tmux is not installed", () => {
    const runner = mockRunner({
      "-V": { exitCode: 1, stdout: "", stderr: "not found" },
    });
    const adapter = new TmuxAdapter(runner, { env: {} });
    const msg = adapter.diagnoseUnavailable();
    expect(msg).toContain("tmux binary not found");
    expect(msg).not.toContain("No active tmux session");
  });

  it("reports 'no active session' when binary exists but no session", () => {
    const runner = mockRunner({
      "-V": { exitCode: 0, stdout: "tmux 3.4", stderr: "" },
    });
    const adapter = new TmuxAdapter(runner, { env: {} });
    const msg = adapter.diagnoseUnavailable();
    expect(msg).toContain("No active tmux session");
    expect(msg).not.toContain("binary not found");
  });
});

describe("CmuxAdapter.diagnoseUnavailable", () => {
  it("reports cmux not available", () => {
    const adapter = new CmuxAdapter();
    const msg = adapter.diagnoseUnavailable();
    expect(msg).toContain("cmux");
    expect(msg).toContain("not available");
  });
});

// ── type property ───────────────────────────────────────────────────

describe("Multiplexer.type property", () => {
  it("CmuxAdapter has type 'cmux'", () => {
    const adapter = new CmuxAdapter();
    expect(adapter.type).toBe("cmux" satisfies MuxType);
  });

  it("TmuxAdapter has type 'tmux'", () => {
    const runner = mockRunner({});
    const adapter = new TmuxAdapter(runner, { env: {} });
    expect(adapter.type).toBe("tmux" satisfies MuxType);
  });

  it("ZellijAdapter has type 'zellij'", () => {
    const runner = mockRunner({});
    const adapter = new ZellijAdapter(runner, { env: {} });
    expect(adapter.type).toBe("zellij" satisfies MuxType);
  });
});

// ── Error messages reference correct mux type ───────────────────────

describe("Error messages reference correct mux type name", () => {
  it("zellij diagnosis mentions 'zellij' not 'cmux' or 'tmux'", () => {
    const runner = mockRunner({
      "--version": { exitCode: 0, stdout: "zellij 0.42.0", stderr: "" },
    });
    const adapter = new ZellijAdapter(runner, { env: {} });
    const msg = adapter.diagnoseUnavailable();
    expect(msg).toContain("zellij");
    expect(msg).not.toContain("cmux");
  });

  it("tmux diagnosis mentions 'tmux' not 'cmux' or 'zellij'", () => {
    const runner = mockRunner({
      "-V": { exitCode: 0, stdout: "tmux 3.4", stderr: "" },
    });
    const adapter = new TmuxAdapter(runner, { env: {} });
    const msg = adapter.diagnoseUnavailable();
    expect(msg).toContain("tmux");
    expect(msg).not.toContain("cmux");
  });

  it("cmux diagnosis mentions 'cmux'", () => {
    const adapter = new CmuxAdapter();
    const msg = adapter.diagnoseUnavailable();
    expect(msg).toContain("cmux");
  });
});
