# Onboarding Process

How ninthwave initialises a project -- every entry point, decision, file, and generated managed copy.

## Entry Points

There are two ways onboarding runs:

| Entry Point | When | Interactive? | Source |
|---|---|---|---|
| `nw` (no args, first run) | User runs `nw` in a git repo with no `.ninthwave/` dir | Yes (TTY required) | `core/commands/onboard.ts` → `onboard()` |
| `nw init` | User explicitly runs init | Yes by default, `--yes` for non-interactive | `core/commands/init.ts` → `cmdInit()` |
| `nw init --global` | User wants global skills only | Minimal | `core/commands/setup.ts` → `setupGlobal()` |

Both paths converge on the same `initProject()` function for the actual setup work. The difference is that `nw` (no-args) wraps it in an interactive guided flow with AI tool selection, setup, and startup settings (including backend selection) before orchestration begins.

The queue mental model is intentional: `/decompose` (or manual file creation) populates `.ninthwave/work/`, `nw` works through that live queue, and completed work is looked up through merged PRs, `nw history`, `nw logs`, or git history rather than retained in a `done` lane under `.ninthwave/work/`.

---

## 1. User Journey: `nw` No-Args Routing

When a user runs `nw` with no arguments, `cmdNoArgs()` detects the project state and routes accordingly.

```mermaid
flowchart TD
    A["nw (no args)"] --> B{TTY?}
    B -->|No| C[Print help text]
    B -->|Yes| D{Git repo?}
    D -->|No| C
    D -->|Yes| E{".ninthwave/ exists?"}
    E -->|No| F["First-run onboarding<br/><code>onboard()</code>"]
    E -->|Yes| G{Work items in<br/>.ninthwave/work/?}
    G -->|None| H["Print guidance:<br/>'Run /decompose to populate the live queue'"]
    G -->|Yes| I{Daemon running?}
    I -->|Yes| J["Live status view<br/><code>cmdStatusWatch()</code>"]
    I -->|No| K[Display items summary]
    K --> L{Mode prompt}
    L -->|Orchestrate| M["Item selection + merge strategy + WIP limit + backend<br/>→ <code>runInteractiveFlow()</code> → orchestration"]
    L -->|Launch subset| N["Item selection<br/>→ <code>cmdRunItems()</code>"]
    L -->|Quit| O[Exit]

    style F fill:#e8f5e9
    style M fill:#e3f2fd
    style N fill:#e3f2fd
```

**Source:** `core/commands/onboard.ts:428-532`

---

## 2. Interactive Onboarding Flow

When `onboard()` runs (first-run via `nw` no-args), it guides the user through tool detection and project setup. After that, the regular startup settings flow takes over and the user chooses how to launch orchestration.

```mermaid
sequenceDiagram
    participant U as User
    participant O as onboard()
    participant D as Detection
    participant I as initProject()
    participant S as Startup settings
    participant B as Backend

    O->>U: Welcome to ninthwave

    Note over O,D: Step 2: AI tool detection
    O->>D: detectInstalledAITools()
    D-->>O: [claude, opencode, codex, copilot] or []

    alt No AI tool found
        O->>U: Install an AI tool and re-run
        Note over O: Return (bail)
    else One found
        O->>U: Found one supported tool. Use it? [Y/n]
        U-->>O: Y
    else Multiple found
        O->>U: Choose [1-N]
        U-->>O: selection
    end

    Note over O,I: Step 3: Project setup
    O->>I: initProject(projectDir, bundleDir)
    Note over I: Auto-detect → optional backend warning → scaffold
    I-->>O: DetectionResult

    alt Monorepo detected
        O->>U: Workspace: pnpm (3 packages).<br/>Does this look right? [Y/n]
        U-->>O: Y
    end

    Note over O,S: Step 4: Startup settings
    O->>S: runInteractiveFlow()
    S->>U: Choose items, merge strategy, WIP limit, and backend
    U-->>S: Auto | tmux | cmux | headless
    Note over S: Selection is saved as backend_mode for next startup
    Note over S: NINTHWAVE_MUX can override a single launch

    Note over S,B: Step 5: Start orchestration
    S->>B: Launch workers in selected backend
    B-->>U: tmux/cmux session or detached headless workers
```

**Source:** `core/commands/onboard.ts:229-391`

---

## 3. `initProject()` Internal Pipeline

Both entry points converge here. This is the core setup logic.

```mermaid
flowchart TD
    A["initProject(projectDir, bundleDir)"] --> B["1. Auto-detect environment<br/><code>detectAll()</code>"]
    B --> C["2. Print detection summary<br/><code>printSummary()</code>"]
    C --> D["3. Check prerequisites<br/><code>checkPrerequisites()</code><br/><i>warn only, never abort</i>"]
    D --> E["4a. Write .ninthwave/config<br/><i>always overwritten</i>"]
    E --> F{Monorepo?}
    F -->|Yes| G["4b. Write .ninthwave/config.json<br/><i>workspace packages</i>"]
    F -->|No| H["5. Scaffold<br/><code>scaffold()</code>"]
    G --> H

    H --> H1["Create .ninthwave/ directories"]
    H --> H2["Create skill copies<br/>.claude/skills/"]
    H --> H3["Create agent copies<br/>.claude/agents/ etc."]
    H --> H4["Write .ninthwave/.gitignore"]
    H --> H5["Write version tracking"]

    H1 & H2 & H3 & H4 & H5 --> I["6. Create nw CLI alias<br/><code>createNwSymlink()</code>"]
    I --> J["7. Migrate runtime state<br/><code>migrateRuntimeState()</code>"]
    J --> K["8. Print next steps"]
    K --> L["Return DetectionResult"]

    style E fill:#fff3e0
    style H fill:#e8f5e9
```

**Source:** `core/commands/init.ts:823-891`

---

## 4. Agent Selection Flow

How agents get selected differs between interactive and non-interactive mode.

```mermaid
flowchart TD
    A["nw init"] --> B{Interactive?<br/>TTY and no --yes}

    B -->|Yes| C["Detect project AI tools<br/><code>detectProjectTools()</code>"]
    C --> D{Tools found?}
    D -->|Yes| E["Use detected tools<br/>(e.g., Claude Code, OpenCode, Codex CLI)"]
    D -->|No| F["Fall back to ALL tool dirs"]
    E & F --> G["Checkbox: which agents?<br/>implementer ✓ reviewer ✓ forward-fixer ✓<br/><i>all pre-selected</i>"]
    G --> H["Preview managed files to create"]
    H --> I{Confirm?}
    I -->|Yes| J["AgentSelection returned"]
    I -->|No| K["Cancelled → no agents"]

    B -->|No| L["Detect project AI tools"]
    L --> M{Tools found?}
    M -->|Yes| N["Use detected tools"]
    M -->|No| O["Use ALL tool dirs"]
    N & O --> P["Auto-select ALL agents"]
    P --> J

    J --> Q["buildCopyPlan() → executeCopyPlan()"]

    style G fill:#e3f2fd
    style Q fill:#e8f5e9
```

**Tool detection logic** (`core/commands/setup.ts:266-290`):

| AI Tool | Detection | Target Directory | Filename Suffix |
|---|---|---|---|
| Claude Code | `.claude/` exists | `.claude/agents/` | `.md` |
| OpenCode | `.opencode/` or `.opencode.json` exists | `.opencode/agents/` | `.md` |
| Codex CLI | `.codex/agents/` exists | `.codex/agents/` | `.toml` (prefixed `ninthwave-`) |
| GitHub Copilot | `.github/copilot-instructions.md` (user-managed) or `.github/agents/` exists | `.github/agents/` | `.agent.md` (prefixed `ninthwave-`) |

---

## 5. Auto-Detection Reference

`detectAll()` runs these detectors and returns a `DetectionResult`:

| What | How | Config Key | Stored In |
|---|---|---|---|
| CI provider | `.github/workflows/*.{yml,yaml}` exists | `ci_provider` | `.ninthwave/config` |
| Test command | `package.json` scripts: `test:ci` > `test` > first `test*` | `test_command` | `.ninthwave/config` |
| Interactive backend | `which cmux`, else `which tmux` | *(none persisted by init)* | detection summary only |
| AI tools | `.claude/`, `.opencode/`, `.codex/agents/`, `.github/copilot-instructions.md` (user-managed), `.github/agents/` | `AI_TOOLS` | `.ninthwave/config` |
| Repo type | `package.json` workspaces or `pnpm-workspace.yaml` | `REPO_TYPE` | `.ninthwave/config` |
| Workspace config | Resolve workspace globs → packages list, detect turbo | *(structured)* | `.ninthwave/config.json` |
| Observability | `SENTRY_AUTH_TOKEN`, `PAGERDUTY_API_TOKEN`, `LINEAR_API_KEY` env vars | *(informational)* | *(summary only)* |

**Source:** `core/commands/init.ts:117-516`

---

## 6. File Manifest

Every file and directory created during onboarding, plus the user-managed instruction inputs that init reads but does not own:

### Project-level (`.ninthwave/`)

| Path | Type | When Created | Overwritten on Re-init? | Git-tracked? | Purpose |
|---|---|---|---|---|---|
| `.ninthwave/` | Directory | Always | N/A | Yes | Project config root |
| `.ninthwave/config` | File | Always | **Yes** (authoritative) | Yes | Auto-detected environment settings (INI format) |
| `.ninthwave/config.json` | File | Only if monorepo detected | **Yes** | Yes | Structured workspace package list |
| `.ninthwave/domains.conf` | File | Only if missing | **No** (preserved) | Yes | Domain pattern mappings for work item filtering |
| `.ninthwave/work/` | Directory | Always | N/A | Yes | Live queue of open work item markdown files |
| `.ninthwave/work/.gitkeep` | File | Always | Yes | Yes | Keeps empty dir in git |
| `.ninthwave/friction/` | Directory | Always | N/A | Yes | Friction log entries |
| `.ninthwave/friction/.gitkeep` | File | Always | Yes | Yes | Keeps empty dir in git |
| `.ninthwave/schedules/` | Directory | Always | N/A | Yes | Scheduled task definitions |
| `.ninthwave/schedules/ci--example-daily-audit.md` | File | Only on fresh init (dir is new) | **No** | Yes | Example disabled schedule |

### Managed tool copies (tool integration)

| Path | Type | When Created | Overwritten on Re-init? | Git-tracked? | Purpose |
|---|---|---|---|---|---|
| `.claude/skills/decompose/` | Directory | Always | Yes (re-copied) | Repo policy | `/decompose` skill |
| `.claude/agents/implementer.md` | File | If Claude Code selected | Yes (refreshed) | Repo policy | Implementation agent prompt |
| `.claude/agents/reviewer.md` | File | If Claude Code selected | Yes (refreshed) | Repo policy | PR review agent prompt |
| `.claude/agents/forward-fixer.md` | File | If Claude Code selected | Yes (refreshed) | Repo policy | CI fix-forward agent prompt |
| `.opencode/agents/implementer.md` | File | If OpenCode selected | Yes (refreshed) | Repo policy | Implementation agent prompt |
| `.opencode/agents/reviewer.md` | File | If OpenCode selected | Yes (refreshed) | Repo policy | PR review agent prompt |
| `.opencode/agents/forward-fixer.md` | File | If OpenCode selected | Yes (refreshed) | Repo policy | CI fix-forward agent prompt |
| `.codex/agents/ninthwave-implementer.toml` | File | If Codex CLI selected | Yes (refreshed) | Repo policy | Implementation agent prompt rendered as Codex TOML |
| `.codex/agents/ninthwave-reviewer.toml` | File | If Codex CLI selected | Yes (refreshed) | Repo policy | PR review agent prompt rendered as Codex TOML |
| `.codex/agents/ninthwave-forward-fixer.toml` | File | If Codex CLI selected | Yes (refreshed) | Repo policy | CI fix-forward agent prompt rendered as Codex TOML |
| `.github/agents/ninthwave-implementer.agent.md` | File | If Copilot selected | Yes (refreshed) | Repo policy | Implementation agent prompt |
| `.github/agents/ninthwave-reviewer.agent.md` | File | If Copilot selected | Yes (refreshed) | Repo policy | PR review agent prompt |
| `.github/agents/ninthwave-forward-fixer.agent.md` | File | If Copilot selected | Yes (refreshed) | Repo policy | CI fix-forward agent prompt |
| `AGENTS.md` | File | Never created by ninthwave | Never | Repo policy | User-managed project instructions (read-only input) |
| `.github/copilot-instructions.md` | File | Never created by ninthwave | Never | Repo policy | User-managed Copilot project instructions (read-only input) |

### Other project files

| Path | Type | When Created | Overwritten on Re-init? | Git-tracked? | Purpose |
|---|---|---|---|---|---|
| `.ninthwave/.gitignore` | File | Always if missing | Preserved after first write | Yes | Deny-by-default rules for committed ninthwave state |

### User-level (`~/.ninthwave/`)

| Path | Type | When Created | Git-tracked? | Purpose |
|---|---|---|---|---|
| `~/.ninthwave/projects/{slug}/` | Directory | Always | N/A | Per-project runtime state |
| `~/.ninthwave/projects/{slug}/version` | File | Always | N/A | ninthwave version used at init |

Slug formula: project root path with `/` replaced by `-` (e.g., `/Users/rob/code/proj` → `-Users-rob-code-proj`).

### System-level

| Path | Type | When Created | Purpose |
|---|---|---|---|
| `{NINTHWAVE_BIN_DIR}/nw` | Symlink | If `nw` not already in PATH | Short alias: `nw` → `ninthwave` |

### Global mode only (`nw init --global`)

| Path | Type | Purpose |
|---|---|---|
| `~/.claude/skills/decompose/` | Directory | Global `/decompose` skill |
| `~/.claude/skills/decompose/` | Directory | Global `/decompose` skill |

No project-level files are created in global mode.

---

## 7. Directory Tree

Resulting project structure after `nw init` in a project with Claude Code, OpenCode, Codex CLI, and Copilot detected:

```
project-root/
├── .ninthwave/                          # git-tracked
│   ├── config                           # auto-detected settings (INI)
│   ├── config.json                      # workspace packages (monorepo only)
│   ├── domains.conf                     # domain mappings (preserved)
│   ├── work/                            # work item files
│   │   └── .gitkeep
│   ├── friction/                        # friction log
│   │   └── .gitkeep
│   └── schedules/                       # scheduled tasks
│       └── ci--example-daily-audit.md   # example (fresh init only)
│
├── .claude/
│   ├── agents/                          # ← managed copies
│   │   ├── implementer.md
│   │   ├── reviewer.md
│   │   └── forward-fixer.md
│   └── skills/                          # ← managed copies
│       ├── work/
│       │   └── SKILL.md
│       └── decompose/
│           └── SKILL.md
│
├── .opencode/                           # managed copies (if detected)
│   └── agents/
│       ├── implementer.md
│       ├── reviewer.md
│       └── forward-fixer.md
│
├── .codex/                              # managed copies (if detected)
│   └── agents/
│       ├── ninthwave-implementer.toml
│       ├── ninthwave-reviewer.toml
│       └── ninthwave-forward-fixer.toml
│
├── .github/                             # regular repo metadata + managed copies
│   ├── agents/
│   │   ├── ninthwave-implementer.agent.md
│   │   ├── ninthwave-reviewer.agent.md
│   │   └── ninthwave-forward-fixer.agent.md
│   └── copilot-instructions.md          # optional user-managed Copilot instructions
│
├── AGENTS.md                            # optional user-managed project instructions
├── .gitignore                           # repo-local policy (optional)
└── .worktrees/                          # created later by orchestrator, gitignored
```

By default, `nw init` writes portable managed copies into the project. In the ninthwave repo itself, those generated copies are ignored so only the canonical sources in `skills/`, `agents/`, and `CLAUDE.md` stay tracked. Project instruction files such as `CLAUDE.md`, `AGENTS.md`, and `.github/copilot-instructions.md` remain user-owned inputs; init reads them but never creates, refreshes, or prunes them. For Codex, the managed boundary is `.codex/agents/ninthwave-*.toml` only.

---

## 8. Ignore Files and Tracking Policy

Init always creates `.ninthwave/.gitignore` with deny-by-default rules for ninthwave's own committed state:

```gitignore
# Deny by default -- only explicitly allowed files are committed
*

# Committed project files
!.gitignore
!config.json
!work/
!work/**
!schedules/
!schedules/**
!friction/
!friction/**
```

`nw init` does **not** modify the repo root `.gitignore`.

If a project wants generated tool copies to stay untracked, add repo-local root ignore rules manually. The ninthwave repo does this because it tracks only the canonical sources and regenerates tool copies locally:

```gitignore
/.claude/agents/
/.claude/skills/
/.opencode/agents/
/.codex/agents/
/.github/agents/
```

That root-level ignore policy is specific to the ninthwave repo itself, not a universal rule for user repositories.

**Source:** `core/commands/init.ts:756-796`, `core/commands/setup.ts:206-219`

---

## 9. Modes & Flags

### `nw init`
Standard project init. Interactive by default (prompts for agent selection). Runs full auto-detect + scaffold pipeline.

### `nw init --yes` / `nw init -y`
Non-interactive. Skips agent selection prompt -- auto-selects all discovered agents into all detected tool directories (or all tool directories if none detected).

### `nw init --global`
Global-only mode. Creates `~/.claude/skills/` managed copies and returns. No `.ninthwave/` directory, no project agent files, no repo `.gitignore` changes, no project setup.

### `nw` (no args, first run)
Interactive guided onboarding. Detects an AI tool, runs `initProject()`, then drops into the normal startup settings flow where the user can choose `Auto`, `tmux`, `cmux`, or `headless`. Only triggers when `.ninthwave/` does not exist.

---

## 10. Legacy Migration

If `.ninthwave/todos/` exists (pre-rename), init migrates files to `.ninthwave/work/` and removes the old directory. Only happens if `.ninthwave/work/` does not already exist.

This is an intentional compatibility boundary, not a stray old name: keep `.ninthwave/todos/` references in init code and migration docs until support for pre-rename repos is deliberately removed. Likewise, older docs or review notes that mention `TODOS.md` / `todo` should be treated as historical records unless they are being rewritten as current guidance.

For the full keep-list of `todo` names that are protocol-, compatibility-, or history-sensitive, see [work-item terminology boundaries](work-item-terminology.md).

**Source:** `core/commands/init.ts:691-709`

---

## 11. Idempotency

Running `nw init` multiple times is safe:

| Artifact | Behavior on Re-init |
|---|---|
| `.ninthwave/config` | Overwritten (init is authoritative for detection) |
| `.ninthwave/config.json` | Overwritten if monorepo detected |
| `.ninthwave/domains.conf` | Preserved (user configuration) |
| `.ninthwave/work/`, `friction/`, `schedules/` | Directories ensured, contents preserved |
| Schedule example file | Only created if `schedules/` dir is new |
| Skill managed copies | Re-copied from the canonical bundle |
| Agent managed copies | Refreshed when stale, left alone when already current |
| `AGENTS.md` | Preserved as a user-managed input if present; never written or pruned by init |
| `.github/copilot-instructions.md` | Preserved as a user-managed input if present; never written or pruned by init |
| `.ninthwave/.gitignore` | Written once if missing, then preserved |
| `nw` CLI alias | Skipped if already in PATH |

---

## 12. Prerequisite Checks

Init checks for external tools but **never aborts** -- warnings only. `gh` is required for PR workflows; interactive backends are optional because headless works by default.

| Tool | Check | Install Command | Purpose |
|---|---|---|---|
| `gh` | `which gh` | `brew install gh` | GitHub PR operations |
| `tmux` *(optional)* | `which tmux` | `brew install tmux` | Attachable interactive backend |
| `cmux` *(optional)* | `which cmux` | `brew install --cask manaflow-ai/cmux/cmux` | Attachable interactive backend with richer macOS UI |
| `gh auth` | `gh auth status` | `gh auth login` | GitHub authentication (only checked if `gh` is present) |

**Source:** `core/commands/setup.ts:103-159`
