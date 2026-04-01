# Copilot CLI Integration Guide

ninthwave works with GitHub Copilot CLI as a first-class AI tool alongside Claude Code and OpenCode. This guide covers what's different about the Copilot CLI integration.

## Setup

Running `ninthwave init` (or `nw init`) configures Copilot CLI support:

1. **Agent files** are copied into `.github/agents/` with the `.agent.md` suffix:
   - `.github/agents/ninthwave-implementer.agent.md` -- implementation agent for work item processing
   - `.github/agents/ninthwave-reviewer.agent.md` -- review agent for PR reviews

2. **Managed copies** are refreshed when you run `nw init`, so the Copilot agent files stay aligned with the canonical prompts in this repo.

3. **Auto-detection** -- `ninthwave init` detects Copilot CLI if `.github/copilot-instructions.md` exists in the project root, and records it in `.ninthwave/config` under `AI_TOOLS`.

No additional configuration is required. If you have `copilot` in your `PATH`, ninthwave will find and use it.

### Verifying the setup

```bash
nw doctor
```

The doctor command checks that at least one AI tool (`claude`, `opencode`, or `copilot`) is available in your PATH.

## How It Works

### Tool selection

ninthwave selects the AI tool interactively:

- **Single tool installed:** auto-selected, no prompt
- **Multiple tools installed:** prompted every time (last-used is pre-selected)
- **`--tool` flag:** explicit override, no prompt (e.g., `nw --tool copilot`)

The selection is persisted to `.ninthwave/config.json` as `ai_tool`.

### Prompt delivery

Copilot CLI receives its initial prompt differently from Claude Code and OpenCode. Because multiline prompts can break when piped through terminal multiplexers, ninthwave writes the full prompt to a temporary data file under its own state directory and launches Copilot with an **inline shell command**:

1. The full prompt is written to `~/.ninthwave/projects/{slug}/tmp/nw-prompt-{id}-{timestamp}`
2. The launch command reads the prompt, deletes the temp file, and execs Copilot CLI
3. Interactive workers use `-i` with Copilot's broad approval shortcut:
   ```bash
   PROMPT=$(cat '~/.ninthwave/projects/{slug}/tmp/nw-prompt-{id}-{timestamp}')
   rm -f '~/.ninthwave/projects/{slug}/tmp/nw-prompt-{id}-{timestamp}'
   exec copilot --agent=ninthwave-implementer --allow-all -i "$PROMPT"
   ```
4. Headless workers use non-interactive prompt mode with the current approval flags explicitly spelled out:
   ```bash
   PROMPT=$(cat '~/.ninthwave/projects/{slug}/tmp/nw-prompt-{id}-{timestamp}')
   rm -f '~/.ninthwave/projects/{slug}/tmp/nw-prompt-{id}-{timestamp}'
   exec copilot -p "$PROMPT" --agent=ninthwave-implementer --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user
   ```

No executable launcher script is created.

### Session lifecycle

| Phase | What happens |
|-------|-------------|
| **Launch** | Inline shell command runs inside the selected backend |
| **Prompt delivery** | Embedded in the launch command via `-i` (interactive) or `-p` (headless) |
| **Working** | Copilot CLI operates normally -- reads/writes files, runs commands |
| **Idle** | Worker waits for orchestrator messages via `cmux send` |
| **Cleanup** | `ninthwave clean-single` tears down the workspace |

## Differences from Claude Code

| Aspect | Claude Code | Copilot CLI |
|--------|-------------|-------------|
| **Prompt delivery** | `--append-system-prompt "$(cat file)"` | Inline temp-file command with `-i` (interactive) or `-p` (headless) |
| **Permissions** | `--permission-mode bypassPermissions` | `--allow-all` interactively; `--allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user` in headless mode |
| **Agent flag** | `--agent ninthwave-implementer` (space) | `--agent=ninthwave-implementer` (equals) |
| **Agent directory** | `.claude/agents/*.md` | `.github/agents/*.agent.md` |
| **Session detection** | Interactive prompt or `--tool` flag | Interactive prompt or `--tool` flag |
| **Post-launch send** | Not needed (prompt embedded) | Not needed (prompt embedded via `-i` or `-p`) |

### What's the same

- Workers follow the same agent prompt (`implementer.md` / `reviewer.md`)
- The orchestrator daemon treats all tools identically after launch
- PR lifecycle, CI monitoring, and merge behavior are tool-agnostic
- Skills like `/decompose` work across all tools

## Troubleshooting

### Copilot CLI not detected

**Symptom:** `nw doctor` reports no AI tool found, or ninthwave launches Claude Code instead.

**Fix:**
1. Verify `copilot` is in your PATH: `which copilot`
2. If installed but not selected, use `--tool copilot` or choose it from the interactive prompt
3. Run `nw doctor` to confirm

### Agent files missing

**Symptom:** Copilot CLI doesn't know about the ninthwave-implementer or ninthwave-reviewer agents.

**Fix:** Run `nw init` to refresh the managed agent copies in `.github/agents/`.

### Prompt delivery failures

**Symptom:** Worker session launches but doesn't start implementing the work item.

**Possible causes:**
- **State dir permissions** -- The prompt file is written under `~/.ninthwave/projects/{slug}/tmp/`. Verify your user can write there.
- **Copilot CLI not installed** -- The inline launch command calls `exec copilot ...`. If the binary isn't available, the session will exit silently.
- **Multiplexer issues** -- Verify cmux or tmux is running: `nw doctor`

### Session exits immediately

**Symptom:** The cmux/tmux workspace opens and closes right away.

**Fix:**
1. Check that `copilot` is installed and authenticated
2. Try the interactive form manually: `copilot --agent=ninthwave-implementer --allow-all -i "hello"`
3. Try the headless form manually: `copilot -p "hello" --agent=ninthwave-implementer --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user`
4. Check cmux/tmux logs for error output

### Init doesn't detect Copilot

**Symptom:** `nw init` doesn't list Copilot under detected AI tools.

**Fix:** `nw init` looks for `.github/copilot-instructions.md` in the project root. Create this file if it doesn't exist -- it's Copilot CLI's project instruction file (equivalent to `CLAUDE.md` for Claude Code).
