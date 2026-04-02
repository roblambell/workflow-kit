import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { LaunchOverride } from "../../../core/ai-tools.ts";
import { resolveProjectStateDir } from "../../helpers.ts";

export const FAKE_AI_SCENARIO_ENV = "NINTHWAVE_FAKE_AI_SCENARIO";
export const FAKE_AI_RUN_ID_ENV = "NINTHWAVE_FAKE_AI_RUN_ID";
export const DEFAULT_FAKE_AI_SCRIPT = join(
  import.meta.dirname,
  "..",
  "..",
  "bin",
  "fake-ai-worker.sh",
);

export type FakeAiBehavior = "success" | "exit" | "hang";

export interface FakeAiHeartbeat {
  progress: number;
  label: string;
  prNumber?: number;
}

export interface FakeAiScenario {
  behavior?: FakeAiBehavior;
  exitCode?: number;
  sleepMs?: number;
  sleepBeforeHeartbeat?: boolean;
  stdout?: string[];
  stderr?: string[];
  heartbeat?: FakeAiHeartbeat;
}

export interface FakeAiRun {
  runId: string;
  scenarioPath: string;
  launchOverride: LaunchOverride;
}

export interface FakeAiContext {
  cwd: string;
  tool: string;
  mode: string;
  agent: string;
  itemId: string;
  projectRoot: string;
  workspaceName: string;
  promptFile: string;
  stateDir: string;
  scenarioFile: string;
  runId: string;
}

export interface FakeAiState {
  status: string;
  behavior: FakeAiBehavior;
  exitCode: number;
  signal: string;
}

export function fakeAiDefaultRunId(itemId: string, agent: string): string {
  return `${itemId}-${agent}`;
}

function serializeScenario(scenario: FakeAiScenario): string {
  const lines: string[] = [];
  lines.push(`behavior=${scenario.behavior ?? "success"}`);
  if (scenario.exitCode != null) lines.push(`exitCode=${scenario.exitCode}`);
  if (scenario.sleepMs != null) lines.push(`sleepMs=${scenario.sleepMs}`);
  if (scenario.sleepBeforeHeartbeat != null) {
    lines.push(`sleepBeforeHeartbeat=${scenario.sleepBeforeHeartbeat ? "1" : "0"}`);
  }
  for (const line of scenario.stdout ?? []) lines.push(`stdout=${line}`);
  for (const line of scenario.stderr ?? []) lines.push(`stderr=${line}`);
  if (scenario.heartbeat) {
    const { progress, label, prNumber } = scenario.heartbeat;
    lines.push(`heartbeat=${progress}|${label}${prNumber != null ? `|${prNumber}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export function writeFakeAiScenario(path: string, scenario: FakeAiScenario): void {
  writeFileSync(path, serializeScenario(scenario), "utf-8");
}

function parseKeyValueFile(path: string): Record<string, string> {
  const raw = readFileSync(path, "utf-8");
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    result[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return result;
}

export function fakeAiArtifactDir(stateDir: string, runId: string): string {
  return join(stateDir, "fake-ai-worker", runId);
}

export function fakeAiScenarioPath(projectRoot: string, runId: string): string {
  return join(projectRoot, ".ninthwave", "test-system", `${runId}.scenario`);
}

export function createFakeAiRun(
  projectRoot: string,
  scenario: FakeAiScenario,
  options: {
    runId?: string;
    scriptPath?: string;
    env?: Record<string, string>;
  } = {},
): FakeAiRun {
  const runId = options.runId ?? `fake-ai-${Date.now()}`;
  const scenarioPath = fakeAiScenarioPath(projectRoot, runId);
  mkdirSync(join(projectRoot, ".ninthwave", "test-system"), { recursive: true });
  writeFakeAiScenario(scenarioPath, scenario);

  return {
    runId,
    scenarioPath,
    launchOverride: {
      command: options.scriptPath ?? DEFAULT_FAKE_AI_SCRIPT,
      env: {
        [FAKE_AI_SCENARIO_ENV]: scenarioPath,
        [FAKE_AI_RUN_ID_ENV]: runId,
        ...(options.env ?? {}),
      },
    },
  };
}

export function fakeAiSuccessScenario(overrides: Omit<FakeAiScenario, "behavior"> = {}): FakeAiScenario {
  return { behavior: "success", ...overrides };
}

export function fakeAiExitScenario(
  exitCode: number,
  overrides: Omit<FakeAiScenario, "behavior" | "exitCode"> = {},
): FakeAiScenario {
  return { behavior: "exit", exitCode, ...overrides };
}

export function fakeAiHangScenario(overrides: Omit<FakeAiScenario, "behavior"> = {}): FakeAiScenario {
  return { behavior: "hang", ...overrides };
}

export function readFakeAiContext(stateDir: string, runId: string): FakeAiContext {
  const values = parseKeyValueFile(join(fakeAiArtifactDir(stateDir, runId), "context.env"));
  return {
    cwd: values.cwd ?? "",
    tool: values.tool ?? "",
    mode: values.mode ?? "",
    agent: values.agent ?? "",
    itemId: values.itemId ?? "",
    projectRoot: values.projectRoot ?? "",
    workspaceName: values.workspaceName ?? "",
    promptFile: values.promptFile ?? "",
    stateDir: values.stateDir ?? "",
    scenarioFile: values.scenarioFile ?? "",
    runId: values.runId ?? runId,
  };
}

export function readFakeAiState(stateDir: string, runId: string): FakeAiState {
  const values = parseKeyValueFile(join(fakeAiArtifactDir(stateDir, runId), "state.env"));
  return {
    status: values.status ?? "",
    behavior: (values.behavior as FakeAiBehavior | undefined) ?? "success",
    exitCode: parseInt(values.exitCode ?? "0", 10),
    signal: values.signal ?? "",
  };
}

export function readFakeAiPrompt(stateDir: string, runId: string): string {
  return readFileSync(join(fakeAiArtifactDir(stateDir, runId), "prompt.txt"), "utf-8");
}

export function readFakeAiLaunches(stateDir: string, runId: string): Array<{
  ts: string;
  agent: string;
  itemId: string;
}> {
  const path = join(fakeAiArtifactDir(stateDir, runId), "launches.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ts = "", agent = "", itemId = ""] = line.split("|");
      return { ts, agent, itemId };
    });
}

export function fakeAiHeartbeatPath(stateDir: string, itemId: string): string {
  return join(stateDir, "heartbeats", `${itemId}.json`);
}

export function readFakeAiHeartbeat(stateDir: string, itemId: string): string | null {
  const path = fakeAiHeartbeatPath(stateDir, itemId);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

export function resolveFakeAiStateDir(projectRoot: string, homeDir: string): string {
  return resolveProjectStateDir(projectRoot, homeDir);
}
