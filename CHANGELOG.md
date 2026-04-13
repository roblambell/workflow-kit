# Changelog

## [0.4.5] - 2026-04-13

Supersedes a dead v0.4.4 tag whose release workflow failed before shipping. All intended 0.4.4 changes are included here.

### Changed
- GitHub org renamed from `ninthwave-sh` to `ninthwave-io`. The Homebrew tap moved with it: install via `brew install ninthwave-io/tap/ninthwave`. Existing users on the old tap should migrate with `brew untap ninthwave-sh/tap && brew tap ninthwave-io/tap && brew upgrade ninthwave`. GitHub redirects handle old URLs for now, but the new paths are canonical.
- README version badge now tracks the latest GitHub release automatically instead of being hand-bumped.

### Added
- add interactive startup update prompt (H-UPD-3) (#649)
- add manual nw update command (H-UPD-2) (#647)
- add decision-triage skill for synchronous decisions inbox clearing
- queue H-RVPB-1 machine-actionable reviewer pushback
- add friction-triage skill for synchronous inbox clearing
- add install-aware update runtime state (H-UPD-1) (#644)
- post-worktree-create bootstrap hook and stale index.lock cleanup (H-WR-1) (#637)
- add CI lifecycle observability events (H-CF-7) (#634)
- emoji reaction acknowledgment for PR comments (M-CF-2) (#628)
- read agent instructions from seeded worktree artifacts (#627)
- ship core/docs format guides via nw init

### Changed
- delete remaining schedule modules and docs (H-RS-2) (#648)
- front-load friction-triage investigation, batch execution
- remove shared schedule integration (H-RS-1) (#645)
- rename WIP to session in test files (M-TS-2) (#640)
- rename WIP to session in core source comments (M-TS-1) (#636)
- split CI fail counters by lifetime (H-CF-8) (#635)

### Fixed
- allowlist .ninthwave/decisions/ in dogfood gitignore
- suppress git rev-parse stderr in inbox/heartbeat (H-CF-7)
- stop opencode workers pausing for permission prompts (#643)
- three parked-item feedback loop bugs (#642)
- auto-save uncommitted work before session respawn (H-WR-3) (#641)
- silent inbox delivery failures for CI and PR comments (H-WR-2) (#638)
- workspace-based WIP counting and SHA gate for review loops
- reviewer agent must use COMMENT event, never APPROVE/REQUEST_CHANGES
- simplify PR comment branding to minimal Ninthwave link
- park live workers at CI retry breaker (H-CF-5) (#632)
- enforce exclusive post-PR inbox loop and bump max review rounds
- extend ci fix ack timeout (H-CF-6) (#633)
- suppress reactions on ninthwave comments (H-CF-4) (#631)
- exclude review check from CI aggregation (H-CF-3) (#630)
- respawn parked workers for PR feedback (H-CF-1) (#629)

## Unreleased

### Fixed
- opencode: stop workers pausing for permission. `nw init` now writes (or merges into) a project-level `.opencode/opencode.jsonc` that grants Ninthwave's orchestrated agents (`ninthwave-implementer`, `-reviewer`, `-rebaser`, `-forward-fixer`) full tool permissions. The previous `OPENCODE_PERMISSION` env var was the wrong shape (a full config file instead of a `Permission` value) so it silently did nothing; it has been removed.

## [0.4.3] - 2026-04-08

### Added
- TUI blocker explanation + decompose fan-in guidance

### Fixed
- resolve inbox namespace for workers running in worktrees

## [0.4.2] - 2026-04-07

### Added
- TUI parked indicator for review-pending items (M-SP-4) (#626)
- fast-path CI failure resume for parked items (M-SP-3) (#625)
- park sessions on review-pending and adjust WIP counting (H-SP-2) (#624)
- add sessionParked plumbing and fix executeWorkspaceClose dangling ref (H-SP-1) (#623)

## [0.4.1] - 2026-04-06

### Added
- centralized request queue with token bucket and priority semaphore (H-ARC-3) (#614)

### Changed
- group OrchestratorDeps into functional sub-interfaces (M-ARC-8) (#619)
- queue-routed action execution and retire RateLimitBackoff (H-ARC-6) (#618)
- add StateDataMap and getStateData() typed accessor (M-ARC-7) (#617)
- parallel snapshot building via request queue (H-ARC-4) (#616)
- consolidate timeout constants into TIMEOUTS object (M-ARC-5) (#615)
- enforce STATE_TRANSITIONS at runtime in transition() (H-ARC-1) (#613)
- extract guard registry for temporal safety predicates (H-ARC-2) (#612)

### Fixed
- remove stale cross-repo refs from agent and skill prompts (H-CLN-1) (#622)
- replace "nw watch" with "nw" in CLI messages and internal docs (H-CLN-2) (#620)
- clear stale mergeCommitSha on fix-forward PR adoption and distinguish CD failures in TUI
- five orchestrator bugs from doughsense dogfooding session #2
- six orchestrator bugs found during doughsense dogfooding session

## [0.4.0] - 2026-04-04

### Added
- surface inbox state in daemon snapshots and status UI (#610)
- add foreground `nw broker` command for self-hosted crews (H-SHB-5) (#609)
- detect and respawn unresponsive workers during CI failure recovery
- add exponential backoff for GitHub rate limit errors
- add persistent self-hosted broker runtime on shared core (H-SHB-4) (#608)
- ship broker-safe review schedules (H-DIR-6) (#607)
- align crew broker payload compatibility (H-SHB-3) (#606)
- expose scheduled task controls in TUI (H-DIR-5) (#601)
- add review-inbox command for friction and decisions (H-DIR-3) (#600)
- add repo reference helpers (H-SHB-2) (#599)
- add decisions inbox scaffolding (H-DIR-1) (#596)
- add review GH maintenance helpers (H-DIR-2) (#595)
- add per-item manual review gate
- add feature-flag recovery guidance
- add tmux dashboard layout
- add inspectable worker inbox history (H-WIR-1) (#589)

### Changed
- extract crew, TUI render, and event loop modules from orchestrate.ts
- extract timing and completion modules from orchestrate.ts
- simplify orchestrator state machine for auditability
- remove cross-repo hub orchestration capability
- extract shared broker core (H-SHB-1) (#603)
- add per-project schedule preference plumbing (H-DIR-4) (#598)
- remove decomposition templates
- standardize work item terminology
- rename WIP limits to session limits
- clean up detail modal description rendering (H-TDM-1) (#594)
- extract durable startup persistence mapping (H-STS-1) (#590)

### Fixed
- prevent merging/ci-passed tight loop under GitHub rate limiting
- watch-recovery test race condition reading stale state file
- align help overlay descriptions and show version in footer
- wire up detail modal scroll by exposing totalContentLines from render
- mirror agent files from main checkout into worktrees instead of re-rendering
- surface raw GH API errors, add general error backoff, and log follow mode
- auto-recover restart-hold blocked items instead of requiring manual retry
- wrap-around navigation and pause overlay UX improvements
- restore spies in gh-pr-checks test to prevent mock leak
- default session limit to 1, persist user's last selection
- handle repos with no CI workflows in orchestrator state machine
- prevent orphaned fake-ai-worker processes on parent exit
- simplify mux detection to session-only, remove backend_mode config
- only persist changed startup settings and plug test config leaks
- active session count excludes verifying/fixing-forward and show fixing-forward as distinct state
- lowercase backend "auto" label and default reviews to "off"
- align startup settings labels and reduce option spacing
- clear stale friction logs and split test suite for faster worker feedback
- stop committing ignored generated mirrors
- make inbox delivery targets explicit (H-WIR-2) (#604)
- stabilize startup settings option chips (H-STUI-1) (#605)
- confirm q before TUI shutdown (H-TUIQ-1) (#602)
- hold unresolved restarted workers on restart (H-RSM-3) (#597)
- reattach implementation workers on restart (H-RSM-2) (#593)
- persist confirmed startup defaults (H-STS-2) (#592)
- preserve watch restart state (H-RSM-1) (#591)
- tighten implementer CI ownership (H-WIR-4) (#588)
- ignore legacy no-lineage PR blockers

## [0.3.11] - 2026-04-02

### Added
- surface blocked items in status (M-JIT-4) (#586)
- apply preview install skips without pruning (H-WI-2) (#575)
- paint startup status tui immediately (H-SUI-3) (#574)
- add init preview selection (H-WI-1) (#572)
- refresh startup picker after first paint (H-SUI-2) (#569)
- preserve crew_url on init reruns (H-CRW-3) (#568)
- wire crew URL precedence into orchestration (H-CRW-2) (#567)
- add crew_url project config support (H-CRW-1) (#564)

### Changed
- validate launch pickup candidates (H-JIT-3) (#584)
- add blocked terminal state (H-JIT-2) (#580)
- speed startup and watch discovery (H-JIT-1) (#578)
- split startup item refresh phases (H-SUI-1) (#566)
- add deterministic AI launch override seam (H-TEST-1) (#565)

### Fixed
- correct packaged CLI self-respawn argv (H-PBR-1) (#579)
- refine TUI footer shortcut styling (M-TFT-1) (#576)
- show closing footer before TUI shutdown (L-TQF-1) (#573)
- match stacked PR comment format (H-SPC-1) (#563)
- align release bundle marker checks

## [0.3.10] - 2026-04-02

### Added
- add paused overlay guidance (#562)
- add pause runtime and TUI controls (H-TPAU-1) (#559)
- surface codex in onboarding and diagnostics (M-CDX-4) (#556)
- generate managed Codex artifacts (H-CDX-2) (#553)
- compose codex worker prompts (H-CDX-3) (#554)
- add codex tool profile primitives (H-CDX-1) (#549)
- surface passive update notice in TUI footer (H-UPN-2) (#543)
- add passive update-check core (H-UPN-1) (#540)
- honor runtime backend choices (H-BES-3) (#527)
- add backend choice to startup flow (H-BES-2) (#525)
- wire live collaboration controls (H-COL-4) (#523)
- add backend preference resolver (H-BES-1) (#521)
- track repair PR history on canonical items (H-PMR-2) (#519)
- route watch runtime controls via protocol (M-TRS-4) (#520)
- split foreground watch operator/engine (H-TRS-3) (#518)
- render collaboration details in controls overlay (M-COL-3) (#514)
- add live collaboration input state (H-COL-2) (#511)
- replace startup confirm with settings screen (H-TUI-2) (#501)
- convert runtime controls to arrow navigation (H-TUI-3) (#500)
- add shared TUI settings foundation (H-TUI-1) (#497)
- wire headless mux launch dispatch (H-RSH-6) (#492)
- add headless adapter fallback (H-RSH-4) (#491)
- add buildHeadlessCmd to AI tool profiles (H-RSH-5) (#490)
- re-evaluate review-pending merges (H-TI-6) (#483)
- add config cleanup work items
- add post-merge status work items
- replace split TUI with two-page layout (H-TI-5) (#480)
- debounce merge strategy switching (H-TI-4) (#478)
- allow queued item navigation in TUI (H-TI-3) (#477)
- add Shift+Tab footer hint (H-TI-1) (#476)
- show worker progress in status views
- persist remote crew state in status views (M-CRS-3) (#473)
- consume broker crew state in live TUI (H-CRS-2) (#471)
- make detail overlay a scrollable inspection surface (M-STUI-6) (#472)
- fast PR detection via heartbeat --pr flag
- add stronger status-page layout rules for active, queued, and mode details (M-STUI-4) (#469)
- enter watch directly from future-only flow (H-STUI-3) (#468)

### Changed
- narrow instruction artifact ownership (H-INS-1) (#552)
- persist rebase recovery state (H-RRR-2) (#547)
- rename internal work item terminology (M-WQ-5) (#541)
- align CLI/TUI work item copy (M-WQ-2) (#535)
- extract shared watch engine runner (H-TRS-2) (#516)
- unify managed copy generation (H-SG-2) (#495)
- canonicalize bundle source discovery (H-SG-1) (#494)
- simplify launch flow (H-RSH-3) (#489)
- gut worker-health helpers (H-RSH-2) (#488)
- strip mux send-message adapters (H-RSH-1) (#487)
- drop ai_tools from project config (M-CFG-3) (#486)
- use user tool memory for startup flows (H-CFG-2) (#485)
- move AI tool memory to user config (H-CFG-1) (#482)
- carry work item snippets into status detail (M-STUI-5) (#470)
- rewrite reviewer prompt for conventional comments (H-CC-2) (#467)
- align review verdict counts with conventional comments (H-CC-1) (#466)

### Fixed
- bypass codex worker permission prompts
- block stale stacked PR merges
- align help overlay copy and render assertions (M-TMU-2) (#555)
- route worker inbox notifications to live worktrees (H-RRR-4) (#557)
- retry stale rebase requests (H-RRR-3) (#551)
- make help a true modal (H-TMU-1) (#550)
- keep startup settings viewport pinned (H-TUW-2) (#546)
- remove merged work items during merge completion (H-SRP-4) (#545)
- keep rebase status truthful (H-RRR-1) (#544)
- clamp confirm summary overflow (M-TUW-3) (#542)
- make checkbox picker rows width-safe and line-aware (H-TUW-1) (#539)
- validate headless tool commands (M-BES-5) (#533)
- make muxes optional for headless mode (M-BES-4) (#532)
- make status and cleanup token-aware (H-SRP-3) (#531)
- block startup replay for merged items (H-SRP-2) (#530)
- add durable work item lineage tokens (H-SRP-1) (#524)
- remove duplicate startup arming flow (H-MSU-2) (#528)
- hold repair completion until verification passes (H-PMR-3) (#526)
- surface interactive engine startup failures
- re-enter repair PRs into canonical flow (H-PMR-1) (#517)
- clarify merge strategy visuals and copy (H-MSU-1) (#515)
- preserve TUI selection by item id (H-STN-3) (#513)
- instrument interactive watch stalls (H-TRS-1) (#512)
- use visible ids for status TUI navigation (H-STN-2) (#510)
- align startup collaboration with local-first flow (M-COL-5) (#509)
- queue CD and release workflows
- extract visible status order metadata (H-STN-1) (#507)
- make collaboration local-first by default (H-COL-1) (#508)
- hold merged items until verification can run (H-PMV-2) (#505)
- show TUI countdowns through 0s (M-TUI-4) (#504)
- inline fullscreen live mode indicator (M-TUI-5) (#503)
- preserve merged verification recovery (H-PMV-1) (#499)
- align Copilot launch and generated agents (H-COP-1) (#498)
- prune legacy generated init artifacts (M-SG-3) (#496)
- preserve PR recovery state after restart (H-PRR-1) (#493)
- classify GitHub polling warnings and avoid footer clipping
- preserve PR state during transient GitHub errors
- rescan for new work during active watch runs
- render post-merge verifying and done in status table (H-PS-1) (#484)
- align post-merge verifying display (H-PS-2) (#481)
- add arming window countdown
- hide unavailable bypass control (H-TI-2) (#475)
- harden inbox wait interruptions
- sync stacked PR comments and review state
- run CI for stacked PR base changes

## [0.3.9] - 2026-04-01

### Added
- add future-only empty queue startup (H-STUI-2) (#464)
- add queue-safe inbox messaging for workers (#462)
- add live controls for collaboration, reviews, merge, and WIP (H-LFRC-4) (#460)
- add claim-gated arming window and ephemeral collaboration start (H-LFRC-3) (#459)
- persist operator WIP preference and runtime WIP updates (H-LFRC-2) (#458)

### Changed
- reorder no-args empty queue startup (H-STUI-1) (#463)
- remove telemetry flag from shared sessions
- make startup selection local-first by default (#457)

### Fixed
- stop tracking runtime prompt file

## [0.3.8] - 2026-03-30

### Added
- report daemon session metadata and token usage to broker
- consolidate nw watch into nw, wait for items when none exist

### Fixed
- increase keystroke-to-Return delay for TUI message delivery
- eliminate EDR-triggering shell scripts from worker launch
- filter untracked deps from crew sync to prevent stuck queue (#456)

## [0.3.7] - 2026-03-30

### Fixed
- PRs on repos with no CI no longer get stuck in `ci-pending` -- zero checks are treated as pass after a 2-minute grace period (allows GitHub Actions time to register)
- removed `/ninthwave-upgrade` skill; upgrades are handled by `brew upgrade ninthwave`

## [0.3.6] - 2026-03-30

### Fixed
- first-run onboarding no longer prompts for multiplexer selection or launches a session -- init happens first, then shows "no work items" guidance
- removed dead `launchSession` code carrying the CMUX-not-in-PATH and tmux-hardcoded-as-cmux bugs

## [0.3.5] - 2026-03-30

### Fixed
- detect cmux via app path, add tmux to prerequisites, prompt for AI tool dirs in init

## [0.3.4] - 2026-03-30

### Added
- interactive multiplexer install prompt: when no mux is available, `nw` now offers to install tmux or cmux via brew (macOS), auto-relaunches after tmux install, opens cmux app after cmux install
- tmux added to multiplexer options in onboarding alongside cmux

### Changed
- "no work items" message reframed: now directs users to `.ninthwave/work/` and clarifies `/decompose` is an AI tool skill, not a CLI command
- cmux-not-in-session error now offers to open cmux interactively instead of just printing a static message

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
- interactive no-args with checkbox work item picker (H-CR-8) (#302)
- add ID pattern detection and topo-sort launching (H-CR-5) (#299)
- decompose observability iteration and update vision (L-VIS-15) (#297)
- wire crew mode into orchestrator and TUI (H-CRW-3) (#286)
- token/cost tracking in worker analytics (L-CST-1) (#285)
- add copilot trust folder advisory to nw doctor (M-DOC-1) (#284)
- auto-commit friction entries at orchestration shutdown (M-FRC-1) (#283)
- pre-flight check for uncommitted work item files (H-PFL-1) (#282)
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
- make setup command interactive with agent file selection (work item M-IST-1) (#247)
- auto-decompose friction files into work items (work item M-ADF-1) (#242)
- vision L-VIS-13 -- decompose next iteration into work items (#239)
- pre-flight environment validation in orchestrate (work item H-PFV-1) (#237)
- launch supervisor session and wire into orchestrate (work item H-SUP-2) (#232)
- vision L-VIS-12 -- decompose next iteration into work items (#231)
- monorepo workspace detection in ninthwave init (work item H-MNR-1) (#229)
- add keyboard shortcuts and remove status pane (work item H-TUI-2) (#228)
- create supervisor agent prompt (work item H-SUP-1) (#227)
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
- rename work item terminology to work item in test infrastructure (M-TM-5) (#336)
- rewire cmdNoArgs to mode-first flow (H-NX-2) (#335)
- rename CLI user-facing strings from work item to work item (H-TM-2) (#329)
- rename core types and modules from work item to work-item terminology (H-TM-1) (#321)
- drop create-work-item GitHub Action and update VISION.md (H-VF-2) (#318)
- rename agent files to role-based names with scope guards (H-RN-2) (#317)
- rename work items→work, work item/→ninthwave/, work item-→ninthwave- (H-RN-1) (#316)
- fix license, remove gstack refs, remove work-item-preview (H-CL-1) (#309)
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
- remove supervisor feature (work item H-SR-1) (#249)
- drop TmuxAdapter and ZellijAdapter (work item H-SR-3) (#250)
- remove screen-based ongoing health monitoring (work item H-SR-2) (#248)
- remove decompose-friction CLI command
- remove inline supervisor code (work item M-SUP-3) (#233)

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
- delete stale branches before launching workers on reused work item IDs (H-ORC-4) (#258)
- support alphabetic suffixes in work item ID parsing (work item H-IDP-1) (#254)
- drop "work item" prefix from PR title templates (H-ST-2) (#253)
- separator width matches data row width across terminal widths (work item H-ST-1) (#252)
- commit and push work item changes before launching orchestrator (work item H-IDP-2) (#251)
- symlink supervisor agent files (matches work-item-worker pattern)
- make getTerminalWidth test TTY-independent (work item M-TIS-1) (#246)
- deduplicate daemon state transition events (work item M-EVT-1) (#243)
- daemon misses merged PRs that auto-merge between polls (work item H-MRG-1) (#241)

## 0.2.0 -- 2026-03-27

Scope reduction: narrowed focus to the core orchestration pipeline.

### Removed
- **External task backends** -- GitHub Issues, ClickUp, Sentry, PagerDuty adapters, `TaskBackend` interface, `StatusSync`, and `backend-registry` module. Work items now come exclusively from `.ninthwave/work/` files
- **Sandboxing** -- nono process-level sandbox wrapper (`core/sandbox.ts`), policy proxy launcher (`core/proxy-launcher.ts`), `--no-sandbox` flag, and all sandbox configuration keys
- **Remote dashboard** -- orchestrator dashboard server (`core/session-server.ts`), `SessionUrlProvider` interface, `--remote` flag, and dashboard lifecycle wiring
- **Webhook notifications** -- Slack/Discord notification system
- **Legacy migration commands** -- `migrate-work items` and `generate-work items` CLI commands (work-items.md format is no longer supported)
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
- Batch work item orchestrator (`core/batch-work-items.sh`) -- parse, order, start, merge, finalize
- `/work` skill -- 5-phase interactive workflow (select, launch, autopilot, monitor, finalize)
- `/decompose` skill -- break feature specs into PR-sized work items with dependency mapping
- `/ninthwave-upgrade` skill -- self-update for both global and vendored installs
- `/work-item-preview` skill -- port-isolated dev server for live testing
- `work-item-worker` agent -- autonomous implementation agent for Claude Code, OpenCode, and Copilot CLI
- Remote installer (`remote-install.sh`) -- one-liner global or per-project setup
- `setup` script -- creates `.ninthwave/` project config, skill symlinks, and agent copies
- Unit test suite -- 112 tests covering parser, batch-order, mark-done, and version-bump

### Fixed
- `_prompt_files` unbound variable on script exit (local array referenced by global EXIT trap)
- Unbound variable in `cmd_batch_order` when remaining array empties
- `cmd_mark_done` not cleaning section headers with intervening blank lines
- Soft skill dependencies -- graceful fallback when optional skills are unavailable
