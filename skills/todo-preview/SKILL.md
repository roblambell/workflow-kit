---
name: todo-preview
description: Launch port-isolated dev servers in a worktree for live testing
user_invocable: true
---

# TODO Preview

Launch port-isolated dev servers within a worktree so a todo-worker agent can test changes in a browser.

## When Invoked

### 1. Detect Partition Number

Determine the partition number using this priority:

1. Look for `YOUR_PARTITION` in the appended system prompt
2. Check the current working directory for a `.worktrees/todo-*` pattern and extract the partition number
3. If neither is found, ask the user which partition to use

If the current directory is not inside a worktree (`.worktrees/todo-*`), tell the user: "This skill is for worktree-based TODO work. Run it from inside a worktree directory."

### 2. Launch Servers

Check CLAUDE.md or Taskfile for dev server commands. If a `task dev:preview` command exists, use it:

```bash
task dev:preview PARTITION=<partition> &
echo $! > /tmp/todo-preview-<partition>.pid
```

Otherwise, start the project's dev server with port isolation using the partition number. Common patterns:
- API on port `4000 + partition`
- Web on port `3000 + partition`

### 3. Wait for Readiness

Poll ports until services are listening:

```bash
API_PORT=$((4000 + <partition>))
WEB_PORT=$((3000 + <partition>))
for i in $(seq 1 60); do
  lsof -i :$API_PORT >/dev/null 2>&1 && break
  sleep 1
done
for i in $(seq 1 30); do
  lsof -i :$WEB_PORT >/dev/null 2>&1 && break
  sleep 1
done
```

### 4. Report

Tell the agent:

> Dev servers running:
> - Web: http://localhost:\<web-port\>
> - API: http://localhost:\<api-port\>
>
> You can now run `/qa` or `/design-review` against http://localhost:\<web-port\>.

## Stopping Servers

When the user says "stop servers" or "cleanup":

```bash
PID=$(cat /tmp/todo-preview-<partition>.pid 2>/dev/null)
if [ -n "$PID" ]; then
  kill -- -$(ps -o pgid= -p $PID | tr -d ' ') 2>/dev/null
  rm -f /tmp/todo-preview-<partition>.pid
fi
```

## Important Notes

- This skill is only useful inside a worktree (`.worktrees/todo-*`).
- Servers run as a background process group. They persist until stopped or the terminal is closed.
- The todo-worker agent should suggest this skill to the user, not run it automatically.
