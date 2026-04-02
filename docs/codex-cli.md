# Codex CLI Integration Guide

ninthwave works with Codex CLI as a first-class AI tool alongside Claude Code, OpenCode, and GitHub Copilot CLI. This guide covers the Codex-specific setup, generated files, launch behavior, and ownership boundaries.

## Setup

### Install Codex CLI

```bash
npm install -g @openai/codex
```

Then verify the binary is available:

```bash
which codex
```

### Run init

Running `ninthwave init` (or `nw init`) configures Codex support:

1. **Managed agent artifacts** are written into `.codex/agents/` as TOML files:
   - `.codex/agents/ninthwave-implementer.toml`
   - `.codex/agents/ninthwave-reviewer.toml`
   - `.codex/agents/ninthwave-forward-fixer.toml`
   - Additional `ninthwave-*.toml` files are generated when more canonical agents are selected

2. **Managed copies** are refreshed when you rerun `nw init`, so the Codex artifacts stay aligned with the canonical prompts in `agents/*.md`.

3. **Auto-detection** -- `nw init` treats `.codex/agents/` as the project indicator for Codex support and records `codex` in `.ninthwave/config` under `AI_TOOLS`.

4. **Ownership boundary** -- ninthwave manages only the generated `.codex/agents/ninthwave-*.toml` artifacts. Project instruction files such as `CLAUDE.md`, `AGENTS.md`, and `.github/copilot-instructions.md` remain user-owned inputs. ninthwave reads them when present, but does not create, overwrite, or prune them.

### Verifying the setup

```bash
nw doctor
```

The doctor command checks that at least one AI tool (`claude`, `opencode`, `codex`, or `copilot`) is available in your PATH.

## What ninthwave writes for Codex

Each generated `.codex/agents/ninthwave-*.toml` file is rendered from the canonical markdown agent source in `agents/`.

The generated TOML contains:

- `name`
- `description`
- `model` when the source frontmatter defines one
- `developer_instructions` with the agent prompt body

That means the Codex artifacts are generated outputs, not canonical sources to edit by hand in the ninthwave repo.

## How Codex launch works

Codex workers use the same tool-selection and backend-selection flow as the other ninthwave integrations:

- **Single tool installed:** auto-selected
- **Multiple tools installed:** prompted, unless `--tool codex` is passed
- **Backends:** `Auto`, `tmux`, `cmux`, or `headless`

### Prompt delivery

ninthwave launches Codex with an inline shell command that reads a temporary prompt-data file from `~/.ninthwave/projects/{slug}/tmp/`, deletes it, and then execs Codex.

Interactive workers use:

```bash
PROMPT=$(cat '~/.ninthwave/projects/{slug}/tmp/nw-prompt-{id}-{timestamp}')
rm -f '~/.ninthwave/projects/{slug}/tmp/nw-prompt-{id}-{timestamp}'
exec codex --full-auto "$PROMPT"
```

Headless workers use:

```bash
PROMPT=$(cat '~/.ninthwave/projects/{slug}/tmp/nw-prompt-{id}-{timestamp}')
rm -f '~/.ninthwave/projects/{slug}/tmp/nw-prompt-{id}-{timestamp}'
exec codex exec --ask-for-approval never --sandbox workspace-write "$PROMPT"
```

### Why there is no `--agent` flag

Codex launch uses the currently supported command shapes above, so ninthwave does **not** pass `--agent` at runtime. Instead, it prepends the canonical agent's developer instructions to the work-item prompt before launch. The generated `.codex/agents/ninthwave-*.toml` files and the runtime prompt composition both come from the same canonical `agents/*.md` sources.

## Managed vs user-owned files

### Managed by ninthwave

- `.codex/agents/ninthwave-*.toml`
- Other generated tool artifacts such as `.claude/agents/`, `.opencode/agents/`, and `.github/agents/`

### Not managed by ninthwave

- `AGENTS.md`
- `CLAUDE.md`
- `.github/copilot-instructions.md`

If `AGENTS.md` already exists in your project, ninthwave leaves it alone. If it does not exist, ninthwave still does not create it.

## Troubleshooting

### Codex not detected during onboarding

**Symptom:** `nw` or `nw doctor` does not offer Codex.

**Fix:**
1. Verify the binary exists: `which codex`
2. Install it if needed: `npm install -g @openai/codex`
3. Re-run `nw doctor`

### `.codex/agents/ninthwave-*.toml` is missing

**Symptom:** The project has Codex installed, but the managed project artifacts are missing.

**Fix:** Run `nw init` to refresh the managed Codex artifacts in `.codex/agents/`.

### Concern about `AGENTS.md` being overwritten

**Symptom:** You want Codex support but already maintain your own root `AGENTS.md`.

**Fix:** Keep your file. ninthwave will not overwrite it. Codex support is managed through `.codex/agents/ninthwave-*.toml`, not through root `AGENTS.md`.
