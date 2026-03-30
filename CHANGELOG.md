# Changelog

## [0.3.3] - 2026-03-30

### Added
- replace number-toggle AI tool selection with TUI checkbox in onboard flow

### Fixed
- copy agent files and skills into project instead of symlinking to bundle

## [0.3.2] - 2026-03-30

### Added
- auto-init on first `nw` run after homebrew install -- no need to run `nw init` separately

### Fixed
- bundle dir resolution now tries `process.execPath` first for reliable path in compiled Bun binaries
- graceful error message when ninthwave installation is not found (instead of stack trace)

### Changed
- drop `ai_tool` (singular) backward compat -- configs now use `ai_tools` array exclusively
- add `~/.ninthwave/` as fallback bundle dir location for user-level installs


## [0.3.1] - 2026-03-30

### Added
- report agent frontmatter models in telemetry (H-CT-3) (#455)
- surface GitHub API errors in TUI footer
- add TUI timeout grace countdown (H-TG-3) (#450)
- reframe crew mode as connected mode with delivery metrics
- timeout grace period state machine (H-TG-2) (#449)
- multi-tool selection with round-robin worker assignment
- move AI tool and telemetry prompts into TUI selection flow
- update crew client for new broker protocol (persistent codes, telemetry, 4x4x4x4 format)
- add TmuxAdapter and tmux-send (H-TM-1) (#445)
- add user-level config at ~/.ninthwave/config.json (H-CS-3) (#443)
- inline crew status on branding line, add crew claim diagnostics
- explicit AI tool selection with --tool flag and interactive prompt
- periodic main branch refresh in orchestrator event loop
- visible selection highlight + scroll-follows-selection (H-TG-1) (#440)
- crew mode -- cloud broker, real-time cross-daemon state, UI polish
- add review, crew, text input steps and updated confirmation (H-WJ-3) (#430)
- add __ALL__ sentinel with linked toggle and default all checked (H-WJ-2) (#425)
- add core/ai-tools.ts AI tool profile module (H-TA-1) (#423)

### Fixed
- remaining low-priority production fixes (L-ER-1) (#452)
- set PROJECT_ROOT to worktree path in worker prompts
- tmux worker alive check and surface attach command in TUI
- render item detail as full-screen overlay instead of split-panel inline
- complete .nw-prompt → .ninthwave/.prompt migration in agent docs
- remove invalid --title flag from opencode TUI launch script
- crew broker treats external deps as satisfied, adds TUI dep warning
- crew mode cross-daemon state visibility, title casing, centered crew bar
- skipReview bypasses AI review gate when reviews are off (H-SR-1) (#441)
- detect merge conflicts in all PR lifecycle states, not just ci-pending
- cmux binary detection and session check
- selection UI count, spacing, and independent sentinel toggle
- update CREW_CODE_PATTERN to match cloud broker format (H-WJ-1) (#422)

### Changed
- remove unreliable cost analytics (H-CT-2) (#454)
- strip heartbeat cost flags (H-CT-1) (#453)
- decompose orchestrator.ts into types + actions modules (H-ER-10) (#451)
- support tmux workspace refs downstream (H-TM-3) (#447)
- add tmux to mux detection chain and auto-launch (H-TM-2) (#446)
- split CI/CD workflows with test gate before release
- move filesystem boundary rule from ETHOS.md to CLAUDE.md (H-CS-4) (#444)
- set per-role model defaults in agent frontmatter (H-CS-7) (#442)
- consolidate file writes into .ninthwave/ and ~/.ninthwave/
- switch OpenCode to --prompt flag with OPENCODE_PERMISSION auto-approval
- rename repairer agent to rebaser (H-CS-5) (#438)
- rename verifier agent to forward-fixer (H-CS-6) (#439)
- replace .ninthwave/config with config.json (H-CS-2) (#437)
- remove dead domain mapping feature (H-CS-1) (#436)
- simplify cmdNoArgs, add readline prompts, wire review/crew args (H-WJ-4) (#434)
- orchestrator code quality fixes (M-ER-6) (#433)
- unified WIP pool with review priority (H-ER-8) (#432)
- merge commitFrictionFiles into commitPathFiles, update ARCHITECTURE.md (L-ER-2) (#431)
- decompose orchestrate.ts into focused subsystems (H-ER-9) (#429)
- wire consumers to profile-derived data (H-TA-2) (#428)
- replace launch switch stmt with profile dispatch (H-TA-3) (#427)
- collapse pr-open into ci-pending (H-ER-7) (#426)

## [0.3.0] - 2026-03-29

### Added
- auto-tag CD pipeline on VERSION change
- agent label consistency and comment filter consolidation (H-PC-5) (#390)
- reviewer scorecard table and absolute link (H-PC-4) (#389)
- add Orchestrator link to PR comments (H-PC-3) (#386)
- add hubRepoNwo plumbing to ExecutionContext and launch (H-PC-2) (#383)
- FakeWorker script-driven scenario driver (H-TS-1) (#381)
- in-TUI item selection widgets (M-UT-7) (#373)
- item detail panel with Enter/i and Escape (H-UT-4) (#371)
- post-completion prompt, exit summary, and persistent layout (H-UT-5) (#370)
- log ring buffer, panel wiring, and keyboard shortcuts (H-UT-3) (#369)
- review round counter, max rounds limit, and rich notify (H-RX-2) (#366)
- add --remote flag to nw list (M-RF-2) (#367)
- panel layout infrastructure for split TUI (H-UT-2) (#365)
- execution history, schedule history command, and TUI display (H-SC-6) (#364)
- rebrand status check, agent links, and footer (M-RX-4) (#360)
- crew mode schedule claims (H-SC-5) (#363)
- seed agent files from origin/main (M-RF-3) (#362)
- em dash lint rule and ARCHITECTURE.md state diagram update (M-RX-5) (#361)
- schedule state tracking and solo-mode execution (H-SC-3) (#358)
- add `nw schedule` CLI command (H-SC-4) (#357)
- remote-only filtering for work items (H-RF-1) (#353)
- add .ninthwave/schedules/ scaffolding to init (H-SC-2) (#354)
- schedule file parser, cron evaluator, and types (H-SC-1) (#352)
- add blockerIcon and formatBlockerSubline helpers (H-DS-1) (#351)
- help overlay with ? key in TUI (M-TUI-5) (#348)
- Shift+Tab merge strategy cycling in TUI (H-TUI-4) (#347)
- auto-launch cmux when running nw outside a session (H-MX-2) (#343)
- add bypass merge strategy with --dangerously-bypass flag (H-MS-3) (#344)
- curl installer for Linux and CI (M-DL-1) (#340)
- send repoUrl for crew repo verification
- dependency-aware claims with author-based affinity (H-CA-4) (#334)
- decompose DX onboarding iteration and add L-VIS-17 (L-VIS-16) (#333)
- enrich sync protocol with dependency and priority metadata (H-CA-1) (#331)
- operator and author identity infrastructure (H-CA-2) (#327)
- interactive nw crew command with direct-join shorthand (H-CA-3) (#326)
- add displayItemsSummary and promptMode to interactive.ts (H-NX-1) (#322)
- end-to-end Homebrew release pipeline with auto tap update
- verifier agent prompt and daemon launch wiring (H-VF-3) (#320)
- default crew broker to wss://ninthwave.sh, add --crew-url flag
- post-merge CI verification state machine (H-VF-1) (#319)
- review workers on by default + commit status API (H-RV-1) (#315)
- rotate orchestration log files at daemon startup (M-OBS-4) (#314)
- emit structured transition events from orchestrator (M-OBS-3) (#313)
- add `nw history <ID>` command for item state timeline (H-OBS-2) (#311)
- add `nw logs` command for viewing orchestration logs (H-OBS-1) (#310)
- grouped and per-command rich help (H-CR-9) (#304)
- interactive no-args with checkbox TODO picker (H-CR-8) (#302)
- add ID pattern detection and topo-sort launching (H-CR-5) (#299)
- decompose observability iteration and update vision (L-VIS-15) (#297)
- wire crew mode into orchestrator and TUI (H-CRW-3) (#286)
- token/cost tracking in worker analytics (L-CST-1) (#285)
- add copilot trust folder advisory to nw doctor (M-DOC-1) (#284)
- auto-commit friction entries at orchestration shutdown (M-FRC-1) (#283)
- pre-flight check for uncommitted TODO files (H-PFL-1) (#282)
- mock crew coordination broker (H-CRW-1) (#281)
- crew WebSocket client with reconnect (H-CRW-2) (#279)
- live countdown timer decoupled from poll loop (H-TUI-6) (#278)
- add repair worker for rebase-only conflict resolution
- full-screen scrollable layout with pinned header and footer (H-TUI-5) (#277)
- add domain and ninthwave labels to worker PRs (M-TUI-3) (#268)
- display Rebasing state in TUI and cmux when rebase is in progress (H-TUI-7) (#267)
- wire heartbeats into orchestrator poll loop (H-HB-3) (#264)
- add setStatus and setProgress to Multiplexer interface (H-HB-2) (#263)
- add nw heartbeat CLI command and file I/O helpers (H-HB-1) (#262)
- relay trusted PR comments to workers (M-ORC-3) (#261)
- add keyboard toggling to status watch mode (M-ST-5) (#257)
- add ViewOptions type and DORA metrics panel (M-ST-4) (#256)
- make setup command interactive with agent file selection (TODO M-IST-1) (#247)
- auto-decompose friction files into TODOs (TODO M-ADF-1) (#242)
- vision L-VIS-13 -- decompose next iteration into TODOs (#239)
- pre-flight environment validation in orchestrate (TODO H-PFV-1) (#237)
- launch supervisor session and wire into orchestrate (TODO H-SUP-2) (#232)
- vision L-VIS-12 -- decompose next iteration into TODOs (#231)
- monorepo workspace detection in ninthwave init (TODO H-MNR-1) (#229)
- add keyboard shortcuts and remove status pane (TODO H-TUI-2) (#228)
- create supervisor agent prompt (TODO H-SUP-1) (#227)
- replace dependency tree with flat blocked-by column in status

### Changed
- async snapshot operations for TUI responsiveness (H-TP-3) (#421)
- migrate vi.mock test files to dependency injection (L-ER-4) (#419)
- simplify pr-monitor.ts with shared processChecks and merged cmdWatchReady (M-ER-3) (#418)
- extract branch management and CLI commands from launch.ts (M-ER-5) (#417)
- extract captureOutput to shared test helper (L-ER-5) (#416)
- merge work-item-utils.ts into work-item-files.ts (M-ER-2) (#410)
- cache listWorkspaces per snapshot build (H-TP-2) (#409)
- remove legacy cmdAutopilotWatch command (H-ER-2) (#405)
- strip dead exports and MODEL_PRICING from types.ts (H-ER-1) (#404)
- extract branding constants and fix footer domain (H-PC-1) (#380)
- async buildSnapshot for TUI responsiveness (H-AS-1) (#379)
- merge nw status into unified TUI and wire no-args entry (H-UT-6) (#372)
- replace DEPS column with inline blocker indicator and sub-lines (H-DS-2) (#359)
- remove analytics JSON, state archive, and friction auto-commit (H-UT-1) (#356)
- replace all em dashes with ASCII alternatives (M-RX-3) (#355)
- remove reviewEnabled, make AI review always-on (H-MS-2) (#349)
- consolidate merge strategies to auto/manual (H-MS-1) (#342)
- reviewer signals orchestrator via verdict file, remove PR locking
- remove auto-merge from agent instructions (H-WR-1) (#337)
- retire vision loop, remove L-VIS-16 DX items
- rename todo terminology to work item in test infrastructure (M-TM-5) (#336)
- rewire cmdNoArgs to mode-first flow (H-NX-2) (#335)
- rename CLI user-facing strings from TODO to work item (H-TM-2) (#329)
- rename core types and modules from todo to work-item terminology (H-TM-1) (#321)
- drop create-todo GitHub Action and update VISION.md (H-VF-2) (#318)
- rename agent files to role-based names with scope guards (H-RN-2) (#317)
- rename todos→work, todo/→ninthwave/, todo-→ninthwave- (H-RN-1) (#316)
- fix license, remove gstack refs, remove todo-preview (H-CL-1) (#309)
- slim Phase 7 to pre-PR sanity check (H-CL-2) (#308)
- make status live by default, add --once flag (M-CR-10) (#303)
- merge init and setup into unified init command (H-CR-4) (#301)
- rename orchestrate command to watch (H-CR-6) (#300)
- create command registry in core/help.ts (H-CR-3) (#298)
- simplify refresh to flat 2s and remove countdown display (M-SC-3) (#296)
- rename start.ts to launch.ts (H-CR-2) (#295)
- rename watch.ts to pr-monitor.ts (H-CR-1) (#294)
- remove metrics panel and help option, add session duration to title (H-SC-2) (#293)
- drop unused ninthwave label from worker PRs (L-SC-4) (#292)
- compact status footer and use right-side space (M-SF-1) (#288)
- split progress bar ownership + fix always-full bug (M-TUI-8) (#276)
- remove PR column, inline PR as clickable suffix on state (H-TUI-4) (#273)
- replace screen-scraping health detection with heartbeat-based detection (H-HB-4) (#266)
- replace cmux set-status with nw heartbeat in worker prompt (H-HB-5) (#265)
- condense DEPS count and DURATION columns (H-ST-3) (#255)
- remove supervisor feature (TODO H-SR-1) (#249)
- drop TmuxAdapter and ZellijAdapter (TODO H-SR-3) (#250)
- remove screen-based ongoing health monitoring (TODO H-SR-2) (#248)
- remove decompose-friction CLI command
- remove inline supervisor code (TODO M-SUP-3) (#233)

### Fixed
- guard stacked launch against dep race condition (H-SL-1) (#420)
- add GhResult<T> discriminated union for GitHub API error handling (H-ER-6) (#415)
- share getAvailableMemory across CLI and daemon (M-ER-4) (#412)
- harden worker reliability across five lifecycle modules (M-ER-1) (#411)
- orchestrator transition edge case fixes (H-ER-4) (#408)
- clean up leaked resources on launch failure (H-ER-5) (#407)
- harden daemon persistence for crash recovery (H-ER-3) (#406)
- rename TUI title and fix footer wrap clipping (H-TP-1) (#403)
- review worker off-mode uses implementer worktree (H-WR-2) (#378)
- add autonomous execution mandate to implementer prompt (H-WR-1) (#377)
- reviewer uses GitHub Review API for inline comments (H-RX-3) (#375)
- align dependency sub-line └ under ⧗ blocker icon column (M-UT-8) (#376)
- filter orchestrator and worker comments from review feedback relay (H-RX-4) (#374)
- validate --merge-strategy CLI arg and map skill aliases
- move review workspace from /tmp to .worktrees/ to avoid trust prompt
- detect CI changes from review-pending state (H-RX-1) (#350)
- increase not-alive debounce threshold from 3 to 5 consecutive polls
- timeout measures from last-alive, retry preserves worktree
- map reviewing state to In Review display label
- write agent prompt to workspace instead of temp directory
- preserve worktrees for stuck items (H-WR-2) (#345)
- remove premature prompt file deletion that races with session startup
- use process liveness to suppress launch timeout (H-WR-3) (#341)
- early mux availability check in all launch paths (H-MX-1) (#339)
- eliminate double Start in Claude worker sessions (H-WR-4) (#338)
- prevent title metrics truncation at terminal edge (H-TUI-2) (#325)
- use alt screen buffer to prevent TUI scrollback pollution (H-TUI-1) (#323)
- enforce WIP limits in direct launch path and fix status table titles
- add commit+push steps to /decompose and /work skills
- pass raw 0.0-1.0 progress to cmux (H-SC-1) (#291)
- prevent daemon-worker worktree race on restart with existing PR (H-WR-1) (#290)
- clean external worktrees blocking branch creation (H-WR-2) (#289)
- repair rebase loop -- circuit breaker + worker message priority (H-RR-1) (#287)
- persist CI notification dedup flags and add living PR comment (H-NTF-1) (#275)
- resolve external worktree branch collisions during worker launch
- thread sessionStartedAt through to metrics display (H-TUI-2) (#270)
- hide duration for queued items, remove redundant elapsed suffix (H-TUI-1) (#269)
- rebase before merge retry on conflict (H-ORC-1) (#260)
- roll back stacked dependents in pre-WIP states when base goes stuck (H-ORC-2) (#259)
- add title comparison in buildSnapshot to prevent false completion on reused IDs
- deduplicate CI failure notifications to prevent comment spam
- delete stale branches before launching workers on reused TODO IDs (H-ORC-4) (#258)
- support alphabetic suffixes in TODO ID parsing (TODO H-IDP-1) (#254)
- drop "TODO" prefix from PR title templates (H-ST-2) (#253)
- separator width matches data row width across terminal widths (TODO H-ST-1) (#252)
- commit and push TODO changes before launching orchestrator (TODO H-IDP-2) (#251)
- symlink supervisor agent files (matches todo-worker pattern)
- make getTerminalWidth test TTY-independent (TODO M-TIS-1) (#246)
- deduplicate daemon state transition events (TODO M-EVT-1) (#243)
- daemon misses merged PRs that auto-merge between polls (TODO H-MRG-1) (#241)

## 0.2.0 -- 2026-03-27

Scope reduction: narrowed focus to the core orchestration pipeline.

### Removed
- **External task backends** -- GitHub Issues, ClickUp, Sentry, PagerDuty adapters, `TaskBackend` interface, `StatusSync`, and `backend-registry` module. Work items now come exclusively from `.ninthwave/todos/` files
- **Sandboxing** -- nono process-level sandbox wrapper (`core/sandbox.ts`), policy proxy launcher (`core/proxy-launcher.ts`), `--no-sandbox` flag, and all sandbox configuration keys
- **Remote dashboard** -- orchestrator dashboard server (`core/session-server.ts`), `SessionUrlProvider` interface, `--remote` flag, and dashboard lifecycle wiring
- **Webhook notifications** -- Slack/Discord notification system
- **Legacy migration commands** -- `migrate-todos` and `generate-todos` CLI commands (TODOS.md format is no longer supported)
- **`--backend` flag** from `list` command

### Changed
- Simplified `nw doctor` -- removed sandbox and cloudflared checks
- Cleaned up config keys -- removed sandbox, proxy, webhook, and backend-related settings
- Updated Homebrew formula for 0.2.0

### Why
These features were working but added surface area beyond the narrowest wedge. By focusing on decomposition → parallel sessions → CI → merge, ninthwave ships a tighter, more reliable core. Removed features may return as separate packages or plugins once the core pipeline is battle-tested at scale.

## 0.1.0 -- 2026-03-23

Initial release as **ninthwave**.

### Added
- Batch TODO orchestrator (`core/batch-todos.sh`) -- parse, order, start, merge, finalize
- `/work` skill -- 5-phase interactive workflow (select, launch, autopilot, monitor, finalize)
- `/decompose` skill -- break feature specs into PR-sized work items with dependency mapping
- `/ninthwave-upgrade` skill -- self-update for both global and vendored installs
- `/todo-preview` skill -- port-isolated dev server for live testing
- `todo-worker` agent -- autonomous implementation agent for Claude Code, OpenCode, and Copilot CLI
- Remote installer (`remote-install.sh`) -- one-liner global or per-project setup
- `setup` script -- creates `.ninthwave/` project config, skill symlinks, and agent copies
- Unit test suite -- 112 tests covering parser, batch-order, mark-done, and version-bump

### Fixed
- `_prompt_files` unbound variable on script exit (local array referenced by global EXIT trap)
- Unbound variable in `cmd_batch_order` when remaining array empties
- `cmd_mark_done` not cleaning section headers with intervening blank lines
- Soft skill dependencies -- graceful fallback when optional skills are unavailable
