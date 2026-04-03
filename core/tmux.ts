// TmuxAdapter: implements Multiplexer interface using tmux as the backend.
// Default tmux mode uses one dashboard window per project session: a persistent
// status pane plus one worker per pane. A legacy windows mode remains available
// via config for users who prefer one worker per window.

import { basename } from "path";
import { resolveCliRespawnCommand } from "./cli-spawn.ts";
import type { Multiplexer, MuxType } from "./mux.ts";
import type { RunResult } from "./types.ts";

export type TmuxLayout = "dashboard" | "windows";

const DASHBOARD_WINDOW = "nw_dashboard";
const STATUS_PANE_TITLE = "nw_status";

/** Tmux-aware runner: supports optional stdin input for command execution. */
export type TmuxRunner = (
  cmd: string,
  args: string[],
  opts?: { input?: string },
) => RunResult;

/**
 * Sanitize a name for tmux session/window usage.
 * Allowlist: [a-zA-Z0-9_-]. Everything else becomes _.
 * Same pattern as sanitizeTitle in launch.ts but without spaces
 * (spaces in tmux names cause quoting issues in target specs).
 */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Injectable dependencies for the TmuxAdapter. */
export interface TmuxAdapterDeps {
  runner: TmuxRunner;
  sleep: (ms: number) => void;
  env: Record<string, string | undefined>;
  cwd: () => string;
  layout?: TmuxLayout;
}

/** Construct the tmux label for a worker pane/window. */
function workspaceName(workItemId: string): string {
  return `nw_${sanitizeName(workItemId)}`;
}

function sessionTarget(session: string): string {
  return `${session}:`;
}

function dashboardTarget(session: string): string {
  return `${session}:${DASHBOARD_WINDOW}`;
}

function extractPaneRef(output: string): string | null {
  const match = output.match(/%\d+/);
  return match?.[0] ?? null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildStatusWatchCommand(): string {
  const { command, args } = resolveCliRespawnCommand(["status", "--watch"]);
  return [command, ...args].map(shellQuote).join(" ");
}

/**
 * Resolve the tmux session name for ninthwave.
 *
 * - Inside tmux ($TMUX set): queries the current session name via display-message
 * - Outside tmux: uses `nw-{dirname}` where dirname is the sanitized cwd basename
 */
export function resolveSessionName(
  deps: Pick<TmuxAdapterDeps, "runner" | "env" | "cwd">,
): string {
  if (deps.env.TMUX) {
    const result = deps.runner("tmux", ["display-message", "-p", "#S"]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  const dirname = basename(deps.cwd()) || "nw";
  return `nw-${sanitizeName(dirname)}`;
}

type DashboardPane = { ref: string; title: string };

/** Adapter that delegates to the tmux CLI binary. */
export class TmuxAdapter implements Multiplexer {
  readonly type: MuxType = "tmux";

  private deps: TmuxAdapterDeps;
  private sessionName: string | null = null;
  private lastLaunchError: string | undefined;

  constructor(deps: TmuxAdapterDeps) {
    this.deps = deps;
  }

  /** Lazily resolve and cache the session name. */
  private getSessionName(): string {
    if (!this.sessionName) {
      this.sessionName = resolveSessionName(this.deps);
    }
    return this.sessionName;
  }

  getLastLaunchError(): string | undefined {
    return this.lastLaunchError;
  }

  private getLayout(): TmuxLayout {
    return this.deps.layout ?? "dashboard";
  }

  /**
   * Ensure the tmux session exists, creating it if necessary.
   * Reuses existing session (crash recovery) via has-session check.
   */
  private ensureSession(): boolean {
    const session = this.getSessionName();
    const check = this.deps.runner("tmux", ["has-session", "-t", sessionTarget(session)]);
    if (check.exitCode === 0) return true;

    const create = this.deps.runner("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
    ]);
    if (create.exitCode !== 0) {
      this.lastLaunchError = create.stderr || `tmux new-session exited ${create.exitCode}`;
      return false;
    }
    return true;
  }

  private listDashboardPanes(session: string): DashboardPane[] | null {
    const result = this.deps.runner("tmux", [
      "list-panes",
      "-t",
      dashboardTarget(session),
      "-F",
      "#{pane_id} #{pane_title}",
    ]);
    if (result.exitCode !== 0) return null;
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [ref, title = ""] = line.split(/\s+/, 2);
        return { ref: ref!, title };
      });
  }

  private setPaneTitle(ref: string, title: string): void {
    this.deps.runner("tmux", ["select-pane", "-t", ref, "-T", title]);
  }

  private ensureDashboardStatusPane(session: string): boolean {
    const existing = this.listDashboardPanes(session);
    if (existing?.some((pane) => pane.title === STATUS_PANE_TITLE)) {
      return true;
    }

    const statusCommand = buildStatusWatchCommand();
    const result = existing
      ? this.deps.runner("tmux", [
          "split-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          dashboardTarget(session),
          "-c",
          this.deps.cwd(),
          statusCommand,
        ])
      : this.deps.runner("tmux", [
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          sessionTarget(session),
          "-n",
          DASHBOARD_WINDOW,
          "-c",
          this.deps.cwd(),
          statusCommand,
        ]);
    if (result.exitCode !== 0) {
      this.lastLaunchError = result.stderr || `tmux dashboard status pane exited ${result.exitCode}`;
      return false;
    }

    const paneRef = extractPaneRef(result.stdout);
    if (!paneRef) {
      this.lastLaunchError = "tmux did not return a pane id for the status pane";
      return false;
    }

    this.setPaneTitle(paneRef, STATUS_PANE_TITLE);
    this.deps.runner("tmux", ["select-layout", "-t", dashboardTarget(session), "tiled"]);
    return true;
  }

  private launchWindowWorkspace(
    cwd: string,
    command: string,
    workItemId?: string,
  ): string | null {
    const session = this.getSessionName();
    const winName = workItemId ? workspaceName(workItemId) : `nw_${Date.now()}`;
    const target = `${session}:${winName}`;

    this.deps.runner("tmux", ["kill-window", "-t", target]);

    const result = this.deps.runner("tmux", [
      "new-window",
      "-t",
      sessionTarget(session),
      "-n",
      winName,
      "-c",
      cwd,
      command,
    ]);
    if (result.exitCode !== 0) {
      this.lastLaunchError = result.stderr || `tmux new-window exited ${result.exitCode}`;
      return null;
    }

    return target;
  }

  private launchDashboardPane(
    cwd: string,
    command: string,
    workItemId?: string,
  ): string | null {
    const session = this.getSessionName();
    const title = workItemId ? workspaceName(workItemId) : `nw_${Date.now()}`;
    if (!this.ensureDashboardStatusPane(session)) return null;

    const dashboardPanes = this.listDashboardPanes(session) ?? [];
    const existing = dashboardPanes.find((pane) => pane.title === title);
    if (existing) {
      this.deps.runner("tmux", ["kill-pane", "-t", existing.ref]);
    }

    const result = this.deps.runner("tmux", [
      "split-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      dashboardTarget(session),
      "-c",
      cwd,
      command,
    ]);
    if (result.exitCode !== 0) {
      this.lastLaunchError = result.stderr || `tmux split-window exited ${result.exitCode}`;
      return null;
    }

    const paneRef = extractPaneRef(result.stdout);
    if (!paneRef) {
      this.lastLaunchError = "tmux did not return a pane id";
      return null;
    }

    this.setPaneTitle(paneRef, title);
    this.deps.runner("tmux", ["select-layout", "-t", dashboardTarget(session), "tiled"]);
    return paneRef;
  }

  isAvailable(): boolean {
    const result = this.deps.runner("tmux", ["-V"]);
    return result.exitCode === 0;
  }

  diagnoseUnavailable(): string {
    return "tmux is not available. Install tmux: brew install tmux (macOS) or apt install tmux (Linux).";
  }

  launchWorkspace(
    cwd: string,
    command: string,
    workItemId?: string,
  ): string | null {
    this.lastLaunchError = undefined;
    if (!this.ensureSession()) return null;
    return this.getLayout() === "windows"
      ? this.launchWindowWorkspace(cwd, command, workItemId)
      : this.launchDashboardPane(cwd, command, workItemId);
  }

  splitPane(_command: string): string | null {
    // Not supported in tmux adapter
    return null;
  }

  readScreen(ref: string, lines?: number): string {
    const result = this.deps.runner("tmux", [
      "capture-pane",
      "-t",
      ref,
      "-p",
    ]);
    if (result.exitCode !== 0) return "";
    if (lines === undefined) return result.stdout;

    const allLines = result.stdout.split("\n");
    return allLines.slice(-lines).join("\n");
  }

  listWorkspaces(): string {
    const session = this.getSessionName();
    if (this.getLayout() === "dashboard") {
      return (this.listDashboardPanes(session) ?? [])
        .filter((pane) => pane.title.startsWith("nw_") && pane.title !== STATUS_PANE_TITLE)
        .map((pane) => `${pane.ref} ${pane.title}`)
        .join("\n");
    }

    const result = this.deps.runner("tmux", [
      "list-windows",
      "-t",
      sessionTarget(session),
      "-F",
      "#{window_name}",
    ]);
    if (result.exitCode !== 0) return "";

    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("nw_"))
      .map((line) => `${session}:${line}`)
      .join("\n");
  }

  closeWorkspace(ref: string): boolean {
    if (ref.startsWith("%")) {
      const result = this.deps.runner("tmux", ["kill-pane", "-t", ref]);
      return result.exitCode === 0;
    }
    const result = this.deps.runner("tmux", ["kill-window", "-t", ref]);
    return result.exitCode === 0;
  }

  setStatus(
    _ref: string,
    _key: string,
    _text: string,
    _icon: string,
    _color: string,
  ): boolean {
    // No-op -- tmux has no native status-per-pane API
    return false;
  }

  setProgress(_ref: string, _value: number, _label?: string): boolean {
    // No-op -- tmux has no native progress API
    return false;
  }
}
