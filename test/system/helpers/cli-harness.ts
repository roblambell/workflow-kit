import { existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncOptions,
} from "child_process";
import { join } from "path";
import { HeadlessAdapter } from "../../../core/headless.ts";
import type { DaemonState } from "../../../core/daemon.ts";
import {
  launchForwardFixerWorker,
  launchRebaserWorker,
  launchReviewWorker,
  launchSingleItem,
  type ForwardFixerLaunchResult,
  type RebaserLaunchResult,
  type ReviewLaunchResult,
  type LaunchResult,
} from "../../../core/commands/launch.ts";
import { parseWorkItems } from "../../../core/parser.ts";
import { stripHeadlessWorkspaceRef } from "../../../core/headless.ts";
import type { WorkItem } from "../../../core/types.ts";
import {
  resolveProjectStateDir,
  setupTempDir,
  setupTempRepoWithRemote,
  waitFor,
  writeWorkItemFiles,
} from "../../helpers.ts";
import { buildFakeTerminalEnv } from "./fake-terminal.ts";
import type { FakeAiRun } from "./fake-ai-scenario.ts";

const CLI_PATH = join(import.meta.dirname, "..", "..", "..", "core", "cli.ts");

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliProcessHandle {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  closed: boolean;
  exited: Promise<number | null>;
}

function encodeHeadlessRef(ref: string): string {
  return encodeURIComponent(stripHeadlessWorkspaceRef(ref));
}

export class CliHarness {
  readonly projectRoot: string;
  readonly homeDir: string;
  readonly workDir: string;
  readonly worktreeDir: string;
  readonly stateDir: string;

  constructor(projectRoot = setupTempRepoWithRemote(), homeDir = setupTempDir("nw-system-home-")) {
    this.projectRoot = realpathSync(projectRoot);
    this.homeDir = homeDir;
    this.workDir = join(this.projectRoot, ".ninthwave", "work");
    this.worktreeDir = join(this.projectRoot, ".ninthwave", ".worktrees");
    this.stateDir = resolveProjectStateDir(this.projectRoot, homeDir);

    mkdirSync(this.worktreeDir, { recursive: true });
    mkdirSync(this.stateDir, { recursive: true });
  }

  env(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      ...process.env,
      HOME: this.homeDir,
      ...buildFakeTerminalEnv(),
      ...overrides,
    };
  }

  writeWorkItems(itemsContent: string): string {
    return writeWorkItemFiles(this.projectRoot, itemsContent);
  }

  findItem(id: string): WorkItem {
    const item = parseWorkItems(this.workDir, this.worktreeDir).find(
      (entry) => entry.id === id,
    );
    if (!item) throw new Error(`Work item ${id} not found in ${this.workDir}`);
    return item;
  }

  run(args: string[], options: { env?: Record<string, string>; timeoutMs?: number; stdin?: string } = {}): CliRunResult {
    const spawnOptions: SpawnSyncOptions = {
      cwd: this.projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 10_000,
      env: this.env(options.env),
      input: options.stdin ?? "",
    };
    const result = spawnSync("bun", ["run", CLI_PATH, ...args], spawnOptions);
    return {
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
      exitCode: result.status ?? 1,
    };
  }

  start(
    args: string[],
    options: { env?: Record<string, string>; stdin?: string; keepStdinOpen?: boolean } = {},
  ): CliProcessHandle {
    const child = spawn("bun", ["run", CLI_PATH, ...args], {
      cwd: this.projectRoot,
      env: this.env(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (options.keepStdinOpen) {
      if (options.stdin) child.stdin.write(options.stdin);
    } else {
      child.stdin.end(options.stdin ?? "");
    }

    const handle: CliProcessHandle = {
      child,
      stdout: "",
      stderr: "",
      exitCode: null,
      closed: false,
      exited: new Promise<number | null>((resolve) => {
        child.stdout.on("data", (chunk: string | Buffer) => {
          handle.stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: string | Buffer) => {
          handle.stderr += chunk.toString();
        });
        child.on("close", (code) => {
          handle.exitCode = code;
          handle.closed = true;
          resolve(code);
        });
      }),
    };

    return handle;
  }

  withHomeDir<T>(fn: () => T): T {
    const originalHome = process.env.HOME;
    process.env.HOME = this.homeDir;
    try {
      return fn();
    } finally {
      process.env.HOME = originalHome;
    }
  }

  headlessMux() {
    return new HeadlessAdapter(this.projectRoot, {
      sleep: (ms: number) => Bun.sleepSync(Math.min(ms, 100)),
    });
  }

  orchestratorStatePath(): string {
    return join(this.stateDir, "orchestrator.state.json");
  }

  orchestratorLogPath(): string {
    return join(this.stateDir, "orchestrator.log");
  }

  readOrchestratorState(): DaemonState | null {
    const path = this.orchestratorStatePath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as DaemonState;
  }

  readOrchestratorLog(): string {
    const path = this.orchestratorLogPath();
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  }

  async waitForProcessOutput(
    handle: CliProcessHandle,
    pattern: string | RegExp,
    options: { stream?: "stdout" | "stderr"; timeoutMs?: number } = {},
  ): Promise<string> {
    const stream = options.stream ?? "stdout";
    return waitFor(() => {
      const text = handle[stream];
      if (!text) return false;
      if (typeof pattern === "string") return text.includes(pattern) ? text : false;
      return pattern.test(text) ? text : false;
    }, {
      timeoutMs: options.timeoutMs,
      description: `${stream} to match ${String(pattern)}`,
    });
  }

  async waitForExit(
    handle: CliProcessHandle,
    timeoutMs = 5_000,
  ): Promise<number | null> {
    await waitFor(async () => {
      if (handle.closed) return true;
      return false;
    }, {
      timeoutMs,
      description: "CLI process exit",
    });
    return handle.exitCode;
  }

  async stop(
    handle: CliProcessHandle,
    signal: NodeJS.Signals = "SIGINT",
    timeoutMs = 5_000,
  ): Promise<number | null> {
    if (handle.exitCode !== null) return handle.exitCode;
    handle.child.kill(signal);
    try {
      return await this.waitForExit(handle, timeoutMs);
    } catch {
      handle.child.kill("SIGKILL");
      return await handle.exited;
    }
  }

  writeToProcess(handle: CliProcessHandle, input: string): void {
    handle.child.stdin.write(input);
  }

  async waitForOrchestratorState<T>(
    predicate: (state: DaemonState) => T | false | null | undefined,
    timeoutMs = 5_000,
  ): Promise<T> {
    return waitFor(() => {
      const state = this.readOrchestratorState();
      if (!state) return false;
      return predicate(state);
    }, {
      timeoutMs,
      description: "orchestrator state",
    });
  }

  commitAndPushWorkItems(message = "Add work item files"): void {
    const addResult = spawnSync("git", ["add", ".ninthwave/work"], {
      cwd: this.projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (addResult.status !== 0) {
      throw new Error(addResult.stderr || "git add failed");
    }

    const commitResult = spawnSync("git", ["commit", "-m", message, "--quiet"], {
      cwd: this.projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (commitResult.status !== 0) {
      throw new Error(commitResult.stderr || "git commit failed");
    }

    const pushResult = spawnSync("git", ["push", "origin", "main", "--quiet"], {
      cwd: this.projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (pushResult.status !== 0) {
      throw new Error(pushResult.stderr || "git push failed");
    }
  }

  launchHeadlessItem(
    id: string,
    run: FakeAiRun,
    options: {
      tool?: string;
      baseBranch?: string;
      forceWorkerLaunch?: boolean;
      hubRepoNwo?: string;
    } = {},
  ): LaunchResult | null {
    const item = this.findItem(id);
    return this.withHomeDir(() =>
      launchSingleItem(
        item,
        this.workDir,
        this.worktreeDir,
        this.projectRoot,
        options.tool ?? "claude",
        this.headlessMux(),
        {
          baseBranch: options.baseBranch,
          forceWorkerLaunch: options.forceWorkerLaunch,
          hubRepoNwo: options.hubRepoNwo,
          launchOverride: run.launchOverride,
        },
      )
    );
  }

  launchHeadlessReview(
    prNumber: number,
    itemId: string,
    run: FakeAiRun,
    options: {
      tool?: string;
      autoFixMode?: "off" | "direct" | "pr";
      reviewType?: "todo" | "external";
      implementerWorktreePath?: string;
      hubRepoNwo?: string;
    } = {},
  ): ReviewLaunchResult | null {
    return this.withHomeDir(() =>
      launchReviewWorker(
        prNumber,
        itemId,
        options.autoFixMode ?? "off",
        this.projectRoot,
        options.tool ?? "claude",
        this.headlessMux(),
        {
          reviewType: options.reviewType,
          implementerWorktreePath: options.implementerWorktreePath,
          hubRepoNwo: options.hubRepoNwo,
          projectRoot: this.projectRoot,
          launchOverride: run.launchOverride,
        },
      )
    );
  }

  launchHeadlessRebaser(
    prNumber: number,
    itemId: string,
    run: FakeAiRun,
    options: { tool?: string; hubRepoNwo?: string } = {},
  ): RebaserLaunchResult | null {
    return this.withHomeDir(() =>
      launchRebaserWorker(
        prNumber,
        itemId,
        this.projectRoot,
        options.tool ?? "claude",
        this.headlessMux(),
        {
          hubRepoNwo: options.hubRepoNwo,
          projectRoot: this.projectRoot,
          launchOverride: run.launchOverride,
        },
      )
    );
  }

  launchHeadlessForwardFixer(
    itemId: string,
    mergeCommitSha: string,
    run: FakeAiRun,
    options: { tool?: string; hubRepoNwo?: string; defaultBranch?: string } = {},
  ): ForwardFixerLaunchResult | null {
    return this.withHomeDir(() =>
      launchForwardFixerWorker(
        itemId,
        mergeCommitSha,
        this.projectRoot,
        options.tool ?? "claude",
        this.headlessMux(),
        {
          hubRepoNwo: options.hubRepoNwo,
          defaultBranch: options.defaultBranch,
          projectRoot: this.projectRoot,
          launchOverride: run.launchOverride,
        },
      )
    );
  }

  headlessLogPath(ref: string): string {
    return join(this.stateDir, "logs", `${encodeHeadlessRef(ref)}.log`);
  }

  headlessPidPath(ref: string): string {
    return join(this.stateDir, "workers", `${encodeHeadlessRef(ref)}.pid`);
  }

  readHeadlessLog(ref: string): string {
    const path = this.headlessLogPath(ref);
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  }

  async waitForHeadlessExit(ref: string, timeoutMs = 5_000): Promise<void> {
    await waitFor(() => {
      this.withHomeDir(() => this.headlessMux().listWorkspaces());
      return !existsSync(this.headlessPidPath(ref));
    }, {
      timeoutMs,
      description: `headless worker ${ref} to exit`,
    });
  }

  async waitForHeadlessLog(ref: string, pattern: string | RegExp, timeoutMs = 5_000): Promise<string> {
    return waitFor(() => {
      const log = this.readHeadlessLog(ref);
      if (!log) return false;
      if (typeof pattern === "string") return log.includes(pattern) ? log : false;
      return pattern.test(log) ? log : false;
    }, {
      timeoutMs,
      description: `headless log ${ref} to match ${String(pattern)}`,
    });
  }

  closeHeadlessWorkspace(ref: string): boolean {
    return this.withHomeDir(() => this.headlessMux().closeWorkspace(ref));
  }
}
