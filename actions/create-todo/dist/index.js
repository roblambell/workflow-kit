// actions/create-todo/index.ts
import { readFileSync, appendFileSync } from "fs";

// actions/create-todo/lib.ts
var PRIORITY_NUM = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};
var PRIORITY_PREFIX = {
  critical: "C",
  high: "H",
  medium: "M",
  low: "L"
};
function getNextCiId(existingFiles) {
  let max = 0;
  for (const file of existingFiles) {
    const match = file.match(/[A-Z]-CI-(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max)
        max = num;
    }
  }
  return max + 1;
}
function generateTodoId(priority, num) {
  const prefix = PRIORITY_PREFIX[priority.toLowerCase()] ?? "H";
  return `${prefix}-CI-${num}`;
}
function generateTodoFilename(id, priority, domain) {
  const num = PRIORITY_NUM[priority.toLowerCase()] ?? 1;
  return `${num}-${domain}--${id}.md`;
}
var MAX_LOG_LENGTH = 2000;
function generateTodoContent(opts) {
  const priorityDisplay = opts.priority.charAt(0).toUpperCase() + opts.priority.slice(1);
  const truncatedLogs = opts.errorLogs.length > MAX_LOG_LENGTH ? opts.errorLogs.slice(0, MAX_LOG_LENGTH) + `
... (truncated)` : opts.errorLogs;
  const lines = [
    `# Fix: CI failure in ${opts.workflowName} (${opts.id})`,
    "",
    `**Priority:** ${priorityDisplay}`,
    `**Source:** GitHub Action (create-todo)`,
    `**Depends on:** -`,
    `**Domain:** ci`,
    "",
    `CI workflow "${opts.workflowName}" failed in ${opts.repo}.`,
    "",
    `- **Run ID:** ${opts.runId}`,
    `- **Run URL:** ${opts.runUrl}`,
    "",
    `Acceptance: The CI failure is investigated and resolved. The failing workflow passes.`
  ];
  if (truncatedLogs) {
    lines.push("", `## Error Logs`, "", "```", truncatedLogs, "```");
  }
  return lines.join(`
`) + `
`;
}

// actions/create-todo/index.ts
function getInput(name) {
  const envKey = `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envKey]?.trim() ?? "";
}
function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${name}=${value}
`);
  }
}
function setFailed(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}
async function githubApi(path, token, opts) {
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const resp = await fetch(`${apiUrl}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...opts?.headers ?? {}
    }
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`GitHub API ${opts?.method ?? "GET"} ${path}: ${resp.status} ${resp.statusText} ${body}`);
  }
  return resp.json();
}
async function run() {
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
  const [owner, repo] = repository.split("/");
  const event = JSON.parse(readFileSync(eventPath, "utf-8"));
  const workflowRun = event.workflow_run;
  if (!workflowRun) {
    setFailed("This action must be triggered by a workflow_run event");
  }
  if (workflowRun.conclusion !== "failure") {
    console.log(`Workflow conclusion is "${workflowRun.conclusion}", not "failure". Skipping.`);
    return;
  }
  const workflowName = workflowRun.name;
  const runId = workflowRun.id;
  const runUrl = workflowRun.html_url;
  let errorLogs = "";
  try {
    const { jobs } = await githubApi(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, token);
    const failedJobs = jobs.filter((j) => j.conclusion === "failure");
    const logLines = [];
    for (const job of failedJobs.slice(0, 3)) {
      logLines.push(`Job: ${job.name}`);
      const failedSteps = (job.steps || []).filter((s) => s.conclusion === "failure");
      for (const step of failedSteps) {
        logLines.push(`  Step: ${step.name} — ${step.conclusion}`);
      }
    }
    errorLogs = logLines.join(`
`);
  } catch (e) {
    console.log(`::warning::Could not fetch job details: ${e}`);
  }
  let existingFiles = [];
  try {
    const contents = await githubApi(`/repos/${owner}/${repo}/contents/.ninthwave/todos?ref=${branch}`, token);
    existingFiles = contents.map((f) => f.name);
  } catch {
    console.log(".ninthwave/todos/ not found, will create first CI todo");
  }
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
    repo: `${owner}/${repo}`
  });
  const filePath = `.ninthwave/todos/${filename}`;
  const contentBase64 = Buffer.from(content).toString("base64");
  if (createPr) {
    const ref = await githubApi(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);
    const prBranch = `ci/todo-${todoId.toLowerCase()}`;
    await githubApi(`/repos/${owner}/${repo}/git/refs`, token, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${prBranch}`,
        sha: ref.object.sha
      })
    });
    await githubApi(`/repos/${owner}/${repo}/contents/${filePath}`, token, {
      method: "PUT",
      body: JSON.stringify({
        message: `chore: create TODO ${todoId} for CI failure in ${workflowName}`,
        content: contentBase64,
        branch: prBranch
      })
    });
    const pr = await githubApi(`/repos/${owner}/${repo}/pulls`, token, {
      method: "POST",
      body: JSON.stringify({
        title: `chore: TODO ${todoId} — CI failure in ${workflowName}`,
        body: `Automatically created by the create-todo action.

Workflow **${workflowName}** failed: ${runUrl}`,
        head: prBranch,
        base: branch
      })
    });
    console.log(`Created PR #${pr.number}: ${pr.html_url}`);
    setOutput("pr-number", pr.number);
    setOutput("pr-url", pr.html_url);
  } else {
    await githubApi(`/repos/${owner}/${repo}/contents/${filePath}`, token, {
      method: "PUT",
      body: JSON.stringify({
        message: `chore: create TODO ${todoId} for CI failure in ${workflowName}`,
        content: contentBase64,
        branch
      })
    });
    console.log(`Created ${filePath} on ${branch}`);
  }
  setOutput("todo-id", todoId);
  setOutput("todo-file", filePath);
}
run();
