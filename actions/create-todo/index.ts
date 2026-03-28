// GitHub Action entry point for create-todo.
// Uses raw env vars + fetch — no @actions/* dependencies.
// Compile with: bun build actions/create-todo/index.ts --target=node --outfile actions/create-todo/dist/index.js

import { readFileSync, appendFileSync } from "fs";
import {
  getNextCiId,
  generateTodoId,
  generateTodoFilename,
  generateTodoContent,
} from "./lib.ts";

// --- GitHub Actions helpers (replaces @actions/core) ---

function getInput(name: string): string {
  const envKey = `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envKey]?.trim() ?? "";
}

function setOutput(name: string, value: string | number): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

function setFailed(message: string): never {
  console.log(`::error::${message}`);
  process.exit(1);
}

// --- GitHub API client ---

async function githubApi<T>(
  path: string,
  token: string,
  opts?: RequestInit,
): Promise<T> {
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const resp = await fetch(`${apiUrl}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...((opts?.headers as Record<string, string>) ?? {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `GitHub API ${opts?.method ?? "GET"} ${path}: ${resp.status} ${resp.statusText} ${body}`,
    );
  }
  return resp.json() as Promise<T>;
}

// --- Payload types ---

interface WorkflowRunPayload {
  workflow_run?: {
    conclusion: string;
    name: string;
    id: number;
    html_url: string;
  };
}

interface Job {
  id: number;
  name: string;
  conclusion: string;
  steps?: Array<{ name: string; conclusion: string }>;
}

interface ContentItem {
  name: string;
  type: string;
}

interface GitRef {
  object: { sha: string };
}

interface PullRequest {
  number: number;
  html_url: string;
}

// --- Main action logic ---

async function run(): Promise<void> {
  // Read inputs
  const token = getInput("token");
  const priority = getInput("priority") || "high";
  const domain = getInput("domain") || "ci";
  const branch = getInput("branch") || "main";
  const createPr = getInput("create-pr") === "true";

  if (!token) {
    setFailed("Input 'token' is required");
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    setFailed("GITHUB_EVENT_PATH not set — must run inside GitHub Actions");
  }

  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    setFailed("GITHUB_REPOSITORY not set");
  }

  const [owner, repo] = repository!.split("/");

  // Parse the event payload
  const event: WorkflowRunPayload = JSON.parse(
    readFileSync(eventPath!, "utf-8"),
  );
  const workflowRun = event.workflow_run;

  if (!workflowRun) {
    setFailed("This action must be triggered by a workflow_run event");
  }

  if (workflowRun!.conclusion !== "failure") {
    console.log(
      `Workflow conclusion is "${workflowRun!.conclusion}", not "failure". Skipping.`,
    );
    return;
  }

  const workflowName = workflowRun!.name;
  const runId = workflowRun!.id;
  const runUrl = workflowRun!.html_url;

  // Fetch failed job details for error context
  let errorLogs = "";
  try {
    const { jobs } = await githubApi<{ jobs: Job[] }>(
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
      token,
    );

    const failedJobs = jobs.filter((j) => j.conclusion === "failure");
    const logLines: string[] = [];

    for (const job of failedJobs.slice(0, 3)) {
      logLines.push(`Job: ${job.name}`);
      const failedSteps = (job.steps || []).filter(
        (s) => s.conclusion === "failure",
      );
      for (const step of failedSteps) {
        logLines.push(`  Step: ${step.name} — ${step.conclusion}`);
      }
    }

    errorLogs = logLines.join("\n");
  } catch (e) {
    console.log(`::warning::Could not fetch job details: ${e}`);
  }

  // Scan existing todo files for CI-* IDs to auto-increment
  let existingFiles: string[] = [];
  try {
    const contents = await githubApi<ContentItem[]>(
      `/repos/${owner}/${repo}/contents/.ninthwave/work?ref=${branch}`,
      token,
    );
    existingFiles = contents.map((f) => f.name);
  } catch {
    console.log(".ninthwave/work/ not found, will create first CI todo");
  }

  // Generate the todo
  const nextNum = getNextCiId(existingFiles);
  const todoId = generateTodoId(priority, nextNum);
  const filename = generateTodoFilename(todoId, priority, domain);
  const content = generateTodoContent({
    id: todoId,
    workflowName,
    runId,
    runUrl,
    errorLogs,
    priority,
    repo: `${owner}/${repo}`,
  });

  const filePath = `.ninthwave/work/${filename}`;
  const contentBase64 = Buffer.from(content).toString("base64");

  if (createPr) {
    // Get the SHA of the base branch
    const ref = await githubApi<GitRef>(
      `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      token,
    );

    const prBranch = `ci/todo-${todoId.toLowerCase()}`;

    // Create a new branch from the base
    await githubApi(
      `/repos/${owner}/${repo}/git/refs`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          ref: `refs/heads/${prBranch}`,
          sha: ref.object.sha,
        }),
      },
    );

    // Create the todo file on the new branch
    await githubApi(
      `/repos/${owner}/${repo}/contents/${filePath}`,
      token,
      {
        method: "PUT",
        body: JSON.stringify({
          message: `chore: create TODO ${todoId} for CI failure in ${workflowName}`,
          content: contentBase64,
          branch: prBranch,
        }),
      },
    );

    // Open a PR
    const pr = await githubApi<PullRequest>(
      `/repos/${owner}/${repo}/pulls`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title: `chore: TODO ${todoId} — CI failure in ${workflowName}`,
          body: `Automatically created by the create-todo action.\n\nWorkflow **${workflowName}** failed: ${runUrl}`,
          head: prBranch,
          base: branch,
        }),
      },
    );

    console.log(`Created PR #${pr.number}: ${pr.html_url}`);
    setOutput("pr-number", pr.number);
    setOutput("pr-url", pr.html_url);
  } else {
    // Direct commit to branch
    await githubApi(
      `/repos/${owner}/${repo}/contents/${filePath}`,
      token,
      {
        method: "PUT",
        body: JSON.stringify({
          message: `chore: create TODO ${todoId} for CI failure in ${workflowName}`,
          content: contentBase64,
          branch,
        }),
      },
    );

    console.log(`Created ${filePath} on ${branch}`);
  }

  setOutput("todo-id", todoId);
  setOutput("todo-file", filePath);
}

run();
