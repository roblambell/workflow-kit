# Onboarding Process

How ninthwave initialises a project -- every entry point, decision, file, and symlink.

## Entry Points

There are two ways onboarding runs:

| Entry Point | When | Interactive? | Source |
|---|---|---|---|
| `nw` (no args, first run) | User runs `nw` in a git repo with no `.ninthwave/` dir | Yes (TTY required) | `core/commands/onboard.ts` → `onboard()` |
| `nw init` | User explicitly runs init | Yes by default, `--yes` for non-interactive | `core/commands/init.ts` → `cmdInit()` |
| `nw init --global` | User wants global skills only | Minimal | `core/commands/setup.ts` → `setupGlobal()` |

Both paths converge on the same `initProject()` function for the actual setup work. The difference is that `nw` (no-args) wraps it in an interactive guided flow with multiplexer/AI tool selection and session launch.

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
    G -->|None| H["Print guidance:<br/>'Run /decompose to get started'"]
    G -->|Yes| I{Daemon running?}
    I -->|Yes| J["Live status view<br/><code>cmdStatusWatch()</code>"]
    I -->|No| K[Display items summary]
    K --> L{Mode prompt}
    L -->|Orchestrate| M["Item selection + merge strategy + WIP limit<br/>→ <code>cmdWatch()</code>"]
    L -->|Launch subset| N["Item selection<br/>→ <code>cmdRunItems()</code>"]
    L -->|Quit| O[Exit]

    style F fill:#e8f5e9
    style M fill:#e3f2fd
    style N fill:#e3f2fd
```

**Source:** `core/commands/onboard.ts:428-532`

---

## 2. Interactive Onboarding Flow

When `onboard()` runs (first-run via `nw` no-args), it guides the user through tool detection and project setup before launching a session.

```mermaid
sequenceDiagram
    participant U as User
    participant O as onboard()
    participant D as Detection
    participant I as initProject()
    participant M as Multiplexer

    O->>U: Welcome to ninthwave

    Note over O,D: Step 2: Multiplexer detection
    O->>D: detectInstalledMuxes()
    D-->>O: [cmux] or []

    alt No multiplexer found
        O->>U: Install cmux and re-run
        Note over O: Return (bail)
    else One found
        O->>U: Found cmux. Use it? [Y/n]
        U-->>O: Y
    else Multiple found
        O->>U: Choose [1-N]
        U-->>O: selection
    end

    Note over O,D: Step 3: AI tool detection
    O->>D: detectInstalledAITools()
    D-->>O: [claude, opencode, ...] or []

    alt No AI tool found
        O->>U: Install an AI tool and re-run
        Note over O: Return (bail)
    else One found
        O->>U: Found Claude Code. Use it? [Y/n]
        U-->>O: Y
    else Multiple found
        O->>U: Choose [1-N]
        U-->>O: selection
    end

    Note over O,I: Step 4: Project setup
    O->>I: initProject(projectDir, bundleDir)
    Note over I: Auto-detect → config → scaffold
    I-->>O: DetectionResult

    alt Monorepo detected
        O->>U: Workspace: pnpm (3 packages).<br/>Does this look right? [Y/n]
        U-->>O: Y
    end

    Note over O,M: Step 5: Launch session
    O->>M: cmux new-workspace --cwd projectDir --command claude
    M-->>O: workspace:123
    O->>M: cmux send --workspace workspace:123 "Welcome message"
    O->>U: You're all set!
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
    H --> H2["Create skill symlinks<br/>.claude/skills/"]
    H --> H3["Create agent symlinks<br/>.claude/agents/ etc."]
    H --> H4["Update .gitignore"]
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
    D -->|Yes| E["Use detected tools<br/>(e.g., Claude Code, OpenCode)"]
    D -->|No| F["Fall back to ALL tool dirs"]
    E & F --> G["Checkbox: which agents?<br/>implementer ✓ reviewer ✓ forward-fixer ✓<br/><i>all pre-selected</i>"]
    G --> H["Preview symlinks to create"]
    H --> I{Confirm?}
    I -->|Yes| J["AgentSelection returned"]
    I -->|No| K["Cancelled → no agents"]

    B -->|No| L["Detect project AI tools"]
    L --> M{Tools found?}
    M -->|Yes| N["Use detected tools"]
    M -->|No| O["Use ALL tool dirs"]
    N & O --> P["Auto-select ALL agents"]
    P --> J

    J --> Q["buildSymlinkPlan() → executeSymlinkPlan()"]

    style G fill:#e3f2fd
    style Q fill:#e8f5e9
```

**Tool detection logic** (`core/commands/setup.ts:266-290`):

| AI Tool | Detection | Target Directory | Symlink Suffix |
|---|---|---|---|
| Claude Code | `.claude/` exists | `.claude/agents/` | `.md` |
| OpenCode | `.opencode/` or `.opencode.json` exists | `.opencode/agents/` | `.md` |
| GitHub Copilot | `.github/` exists | `.github/agents/` | `.agent.md` (prefixed `ninthwave-`) |

---

## 5. Auto-Detection Reference

`detectAll()` runs these detectors and returns a `DetectionResult`:

| What | How | Config Key | Stored In |
|---|---|---|---|
| CI provider | `.github/workflows/*.{yml,yaml}` exists | `ci_provider` | `.ninthwave/config` |
| Test command | `package.json` scripts: `test:ci` > `test` > first `test*` | `test_command` | `.ninthwave/config` |
| Multiplexer | `which cmux` succeeds | `MUX` | `.ninthwave/config` |
| AI tools | `.claude/`, `.opencode/`, `.github/copilot-instructions.md` | `AI_TOOLS` | `.ninthwave/config` |
| Repo type | `package.json` workspaces or `pnpm-workspace.yaml` | `REPO_TYPE` | `.ninthwave/config` |
| Workspace config | Resolve workspace globs → packages list, detect turbo | *(structured)* | `.ninthwave/config.json` |
| Observability | `SENTRY_AUTH_TOKEN`, `PAGERDUTY_API_TOKEN`, `LINEAR_API_KEY` env vars | *(informational)* | *(summary only)* |

**Source:** `core/commands/init.ts:117-516`

---

## 6. File Manifest

Every file and directory created during onboarding:

### Project-level (`.ninthwave/`)

| Path | Type | When Created | Overwritten on Re-init? | Git-tracked? | Purpose |
|---|---|---|---|---|---|
| `.ninthwave/` | Directory | Always | N/A | Yes | Project config root |
| `.ninthwave/config` | File | Always | **Yes** (authoritative) | Yes | Auto-detected environment settings (INI format) |
| `.ninthwave/config.json` | File | Only if monorepo detected | **Yes** | Yes | Structured workspace package list |
| `.ninthwave/domains.conf` | File | Only if missing | **No** (preserved) | Yes | Domain pattern mappings for work item filtering |
| `.ninthwave/work/` | Directory | Always | N/A | Yes | Work item markdown files |
| `.ninthwave/work/.gitkeep` | File | Always | Yes | Yes | Keeps empty dir in git |
| `.ninthwave/friction/` | Directory | Always | N/A | Yes | Friction log entries |
| `.ninthwave/friction/.gitkeep` | File | Always | Yes | Yes | Keeps empty dir in git |
| `.ninthwave/schedules/` | Directory | Always | N/A | Yes | Scheduled task definitions |
| `.ninthwave/schedules/ci--example-daily-audit.md` | File | Only on fresh init (dir is new) | **No** | Yes | Example disabled schedule |

### Symlinks (tool integration)

| Path | Type | When Created | Overwritten on Re-init? | Git-tracked? | Purpose |
|---|---|---|---|---|---|
| `.claude/skills/work` | Symlink | Always | Yes (recreated) | **No** (gitignored) | `/work` skill |
| `.claude/skills/decompose` | Symlink | Always | Yes (recreated) | **No** (gitignored) | `/decompose` skill |
| `.claude/skills/ninthwave-upgrade` | Symlink | Always | Yes (recreated) | **No** (gitignored) | `/ninthwave-upgrade` skill |
| `.claude/agents/implementer.md` | Symlink | If Claude Code selected | Yes (recreated) | **No** (gitignored) | Implementation agent prompt |
| `.claude/agents/reviewer.md` | Symlink | If Claude Code selected | Yes (recreated) | **No** (gitignored) | PR review agent prompt |
| `.claude/agents/forward-fixer.md` | Symlink | If Claude Code selected | Yes (recreated) | **No** (gitignored) | CI fix-forward agent prompt |
| `.opencode/agents/implementer.md` | Symlink | If OpenCode selected | Yes (recreated) | **No** (gitignored) | Implementation agent prompt |
| `.opencode/agents/reviewer.md` | Symlink | If OpenCode selected | Yes (recreated) | **No** (gitignored) | PR review agent prompt |
| `.opencode/agents/forward-fixer.md` | Symlink | If OpenCode selected | Yes (recreated) | **No** (gitignored) | CI fix-forward agent prompt |
| `.github/agents/ninthwave-implementer.agent.md` | Symlink | If Copilot selected | Yes (recreated) | **No** (gitignored) | Implementation agent prompt |
| `.github/agents/ninthwave-reviewer.agent.md` | Symlink | If Copilot selected | Yes (recreated) | **No** (gitignored) | PR review agent prompt |
| `.github/agents/ninthwave-forward-fixer.agent.md` | Symlink | If Copilot selected | Yes (recreated) | **No** (gitignored) | CI fix-forward agent prompt |

### Other project files

| Path | Type | When Created | Overwritten on Re-init? | Git-tracked? | Purpose |
|---|---|---|---|---|---|
| `.gitignore` | File | Created if missing, appended if exists | Appended (deduped) | Yes | Excludes `.worktrees/` and symlink dirs |

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
| `~/.claude/skills/work` | Symlink | Global `/work` skill |
| `~/.claude/skills/decompose` | Symlink | Global `/decompose` skill |
| `~/.claude/skills/ninthwave-upgrade` | Symlink | Global `/ninthwave-upgrade` skill |

No project-level files are created in global mode.

---

## 7. Directory Tree

Resulting project structure after `nw init` in a project with Claude Code and OpenCode detected:

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
├── .claude/                             # gitignored subdirs
│   ├── agents/                          # ← symlinks, gitignored
│   │   ├── implementer.md  → ../../ninthwave/agents/implementer.md
│   │   ├── reviewer.md     → ../../ninthwave/agents/reviewer.md
│   │   └── forward-fixer.md     → ../../ninthwave/agents/forward-fixer.md
│   └── skills/                          # ← symlinks, gitignored
│       ├── work             → ../../ninthwave/skills/work
│       ├── decompose        → ../../ninthwave/skills/decompose
│       └── ninthwave-upgrade → ../../ninthwave/skills/ninthwave-upgrade
│
├── .opencode/                           # gitignored subdirs (if detected)
│   └── agents/                          # ← symlinks, gitignored
│       ├── implementer.md  → ../../ninthwave/agents/implementer.md
│       ├── reviewer.md     → ../../ninthwave/agents/reviewer.md
│       └── forward-fixer.md     → ../../ninthwave/agents/forward-fixer.md
│
├── .github/                             # gitignored agents/ subdir (if detected)
│   └── agents/                          # ← symlinks, gitignored
│       ├── ninthwave-implementer.agent.md → ...
│       ├── ninthwave-reviewer.agent.md    → ...
│       └── ninthwave-forward-fixer.agent.md    → ...
│
├── .gitignore                           # appended with ninthwave entries
└── .worktrees/                          # created later by orchestrator, gitignored
```

Symlink targets are relative paths (e.g., `../../../path/to/ninthwave/agents/implementer.md`) computed from each link's parent directory back to the ninthwave bundle. This ensures portability across directory moves and Homebrew prefix changes.

---

## 8. `.gitignore` Entries

Init adds these entries (deduped, appended if `.gitignore` exists, created if not):

```gitignore
# ninthwave worktrees
.worktrees/

# ninthwave symlinks (developer-local, re-created by ninthwave init)
.claude/agents/
.claude/skills/
.opencode/agents/
.github/agents/
```

**Self-hosting exception:** When `projectDir === bundleDir` (ninthwave developing itself), the symlink entries are **not** added since those directories contain source files, not symlinks.

**Source:** `core/commands/init.ts:756-796`, `core/commands/setup.ts:206-219`

---

## 9. Modes & Flags

### `nw init`
Standard project init. Interactive by default (prompts for agent selection). Runs full auto-detect + scaffold pipeline.

### `nw init --yes` / `nw init -y`
Non-interactive. Skips agent selection prompt -- auto-selects all discovered agents into all detected tool directories (or all tool directories if none detected).

### `nw init --global`
Global-only mode. Creates `~/.claude/skills/` symlinks and returns. No `.ninthwave/` directory, no agent symlinks, no `.gitignore` changes, no project setup.

### `nw` (no args, first run)
Interactive guided onboarding. Detects multiplexer and AI tool, runs `initProject()`, then launches a session in the multiplexer with a welcome message. Only triggers when `.ninthwave/` does not exist.

---

## 10. Legacy Migration

If `.ninthwave/todos/` exists (pre-rename), init migrates files to `.ninthwave/work/` and removes the old directory. Only happens if `.ninthwave/work/` does not already exist.

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
| Skill symlinks | Removed and recreated (always current) |
| Agent symlinks | Recreated; existing correct symlinks reported as "already set up" |
| `.gitignore` | Appended only if entries missing (deduped) |
| `nw` CLI alias | Skipped if already in PATH |

---

## 12. Prerequisite Checks

Init checks for external tools but **never aborts** -- warnings only.

| Tool | Check | Install Command | Purpose |
|---|---|---|---|
| `gh` | `which gh` | `brew install gh` | GitHub PR operations |
| `cmux` | `which cmux` | `brew install --cask manaflow-ai/cmux/cmux` | Terminal multiplexer for parallel sessions |
| `gh auth` | `gh auth status` | `gh auth login` | GitHub authentication (only checked if `gh` is present) |

**Source:** `core/commands/setup.ts:103-159`
