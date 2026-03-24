---
name: work
description: |
  Batch-process work items through parallel AI coding sessions.
  Interactively select items, then delegate execution to `ninthwave orchestrate`.
  Use when asked to "process work items", "batch work", "run work", or "start work".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
user_invocable: true
---

## Interactive Questions (CRITICAL)

This skill is highly interactive. You MUST use your interactive question tool to ask the user questions -- do NOT simply print a question as text and wait for a response.

**Tool names by platform:** `AskUserQuestion` (Claude Code), `question` (OpenCode), `request_user_input` (Codex), `ask_user` (Copilot CLI, Gemini CLI). Use whichever is available in your environment.

**Every question must follow this structure:**

1. **Re-ground:** State the project, the current branch, and what phase you're in. Assume the user hasn't looked at this window in 20 minutes.
2. **Explain simply:** Describe the situation in plain English. Say what it does, not what it's called.
3. **Recommend:** State which option you'd pick and why. Include a one-line reason.
4. **Options:** Lettered options: A), B), C). When an option involves effort, indicate the scale.

---

## Instructions

This skill interactively selects TODO items, then delegates all orchestration to `ninthwave orchestrate` — a deterministic TypeScript daemon that handles launching workers, polling CI, merging PRs, cleaning up, and marking items done. The skill has three phases: Phase 1 (interactive selection), Phase 2 (launching the daemon), and Phase 3 (continuous delivery loop — checking for remaining work and looping back).

> **CLI shortcut:** You can skip the interactive selection and run the orchestrator directly from any terminal:
> ```
> ninthwave orchestrate --items ID1,ID2 --merge-strategy asap --wip-limit 4
> ```
> No AI tool session required.

---

### Phase 1: SELECT

**Goal:** Help the user choose which TODO items to work on and how to process them.

> **Rule: Never trust `list --ready` without reconciling first.** TODOS.md may be stale if PRs were merged outside the orchestrator (manually, by another session, or by GitHub auto-merge). Always reconcile before listing.

1. Run `.ninthwave/work reconcile` to sync TODOS.md with GitHub state (marks merged PRs as done, cleans stale worktrees).
2. Run `.ninthwave/work list --ready` to get all available items.
3. Parse the output and present a summary table to the user showing: ID, priority, domain, title, and estimated complexity. Items with a `Repo:` field will indicate which target repo they belong to.

4. AskUserQuestion -- "How do you want to select items?"
   - Detect if any feature-code IDs exist (IDs with alphabetic characters like `BF5`, `UO`, `ST`).
   - Options:
     - A) By feature code -- select all items for a specific feature (only if feature IDs detected)
     - B) By priority level -- filter by critical/high/medium/low
     - C) By domain -- filter by domain area
     - D) All ready (N items total) -- process everything available

   **If user picks A (feature code):**
   - List the distinct feature codes found.
   - AskUserQuestion to pick a feature code.
   - Run `.ninthwave/work list --feature <code>`.

   **If user picks B (priority):**
   - AskUserQuestion -- "Which priority level?"
   - Filter items by chosen priority.

   **If user picks C (domain):**
   - AskUserQuestion -- "Which domain?"
   - Filter items by chosen domain.

5. **Dependency analysis:** Run `.ninthwave/work batch-order <selected-IDs>` to check for dependency chains.

   - **If all items are in Batch 1** (no dependencies): proceed to conflict check.
   - **If items span multiple batches**: present the batch plan. The orchestrator handles dependency ordering automatically — all selected items can be passed together.

6. Run `.ninthwave/work conflicts <batch-IDs>` to check for file overlaps.

7. Present the conflict analysis. If conflicts, suggest splitting into sub-batches or lowering the WIP limit.

8. AskUserQuestion -- "Start this batch?"
   - Options:
     - A) Start these N items -- launch the orchestrator now
     - B) Remove conflicting items -- run only non-overlapping subset
     - C) Pick manually -- let me choose specific items by ID
     - D) Cancel -- go back to selection

9. **Merge strategy:**

   AskUserQuestion -- "How should PRs be merged?"
   - A) Auto-merge once approved -- merge after approval + CI passes
   - B) Auto-merge ASAP -- merge as soon as CI passes, skip approval wait
   - C) Ask me before merging -- confirm each merge individually

   Store MERGE_STRATEGY as: `approved` | `asap` | `ask`

10. **WIP limit** (only when total items >= 4):

   AskUserQuestion -- "WIP limit? (how many items to process concurrently)"
   - A) 4 (default) -- good balance of parallelism and memory usage
   - B) 2 -- conservative, lower memory usage
   - C) All at once -- start all simultaneously (set WIP_LIMIT to item count)
   - D) Custom -- let me enter a number

   Store WIP_LIMIT (default: 4).

11. **Supervisor mode:**

   AskUserQuestion -- "Enable LLM supervisor? (monitors for anomalies, logs friction)"
   - A) Yes (recommended for unattended runs) -- an LLM periodically reviews orchestrator state, detects anomalies, and logs friction
   - B) No (daemon only) -- deterministic daemon with no LLM oversight

   Store SUPERVISOR_ENABLED (boolean, default: false).

---

### Phase 2: ORCHESTRATE

**Goal:** Launch the `ninthwave orchestrate` daemon and monitor its output.

1. Build the orchestrate command from the user's selections:

   ```bash
   ninthwave orchestrate \
     --items <comma-separated-IDs> \
     --merge-strategy <MERGE_STRATEGY> \
     --wip-limit <WIP_LIMIT>
   ```

   If SUPERVISOR_ENABLED is true, append `--supervisor` to the command:

   ```bash
   ninthwave orchestrate \
     --items <comma-separated-IDs> \
     --merge-strategy <MERGE_STRATEGY> \
     --wip-limit <WIP_LIMIT> \
     --supervisor
   ```

   If running via the `.ninthwave/work` shim, use `.ninthwave/work orchestrate ...` instead.

2. Run the command. The orchestrator handles the full lifecycle automatically:
   - **Queued** items wait for dependencies to clear
   - **Ready** items get launched as worker sessions (up to the WIP limit)
   - **Implementing** workers are monitored for completion
   - **CI-pending/CI-passed** PRs are tracked through CI
   - **Merging** PRs are squash-merged, worktrees cleaned, and items marked done
   - Adaptive polling adjusts check frequency based on current state
   - Crash recovery reconstructs state from disk and GitHub on restart

3. The orchestrator emits structured JSON log lines. Monitor the output for:
   - `orchestrate_start` — daemon started, lists all items
   - `transition` — items moving between states (e.g., `queued → ready → launching`)
   - `action_execute` / `action_result` — launches, merges, cleanups
   - `orchestrate_complete` — all items reached terminal state (done or stuck)
   - `shutdown` — SIGINT received, clean exit
   - `supervisor_tick` — (supervisor mode only) periodic LLM review of orchestrator state
   - `supervisor_anomaly` — (supervisor mode only) supervisor detected an anomaly and sent a hint to a worker
   - `supervisor_friction` — (supervisor mode only) supervisor logged a friction observation

4. **When the orchestrator exits**, summarize results:
   - How many items completed successfully (done)
   - How many items got stuck (stuck) and why
   - Any errors or warnings from the log output

5. If items remain stuck, AskUserQuestion:
   - A) Retry stuck items -- re-run orchestrate with just those IDs
   - B) Investigate -- look at the stuck PRs/branches manually
   - C) Done -- accept the results as-is

6. **Crash recovery:** If the orchestrator is interrupted (crash, Ctrl-C, terminal closed), re-running the same command reconstructs state from existing worktrees and GitHub PRs and resumes automatically.

---

### Phase 3: CONTINUOUS DELIVERY LOOP

**Goal:** After the orchestrator finishes a batch, check for remaining work and loop back to keep delivering until everything is done or the user stops.

Phase 3 runs automatically after Phase 2 completes. It checks whether more work was unblocked by the completed batch and offers to continue. In dogfooding mode (developing ninthwave itself), it also reviews the friction log for new actionable entries.

#### Step 1: Reconcile and check for remaining ready items

Run `.ninthwave/work reconcile` to sync TODOS.md with GitHub state — items merged during the batch are marked done, stale worktrees are cleaned, and TODOS.md is committed/pushed. Never trust `list --ready` without reconciling first.

Then run `.ninthwave/work list --ready` to see if any items were unblocked by the batch that just completed.

- If **no ready items remain**, report "All done — no remaining work items" and exit the loop.
- If **ready items exist**, continue to Step 2.

#### Step 2: Dogfooding — friction log review (ninthwave projects only)

**Detection:** Check if `skills/work/SKILL.md` exists in the project root. If it does, this is a ninthwave project and dogfooding mode is active.

If in dogfooding mode:

1. Read the friction log at `~/.claude/projects/-Users-roblambell-code-ninthwave/memory/project_dogfood_friction.md` (or `.ninthwave/friction.log` if it exists).
2. Identify any **new actionable entries** — friction items that don't already have corresponding TODOs in `TODOS.md`.
3. If actionable entries exist, present them to the user:

   AskUserQuestion — "Friction log has N new actionable entries. Decompose into TODOs?"
   - A) Yes — decompose into TODOs, then include them in the next batch
   - B) Skip — continue with existing ready items only
   - C) Show entries — display the friction entries before deciding

   If the user chooses A, use the `/decompose` skill (or `.ninthwave/work decompose`) to break friction entries into TODOs. The newly created items will appear in the next `list --ready` call.

If **not** in dogfooding mode, skip this step entirely.

#### Step 3: Offer to continue

Present the remaining ready items and ask the user whether to continue.

AskUserQuestion — "Batch complete. N items are now ready. Continue?"
- A) Continue with all N items — launch the next batch with the same merge strategy and WIP limit
- B) Select items — go back to Phase 1 to pick specific items
- C) Stop — exit the delivery loop

**If the user chooses A:** Loop back to Phase 2 with the same MERGE_STRATEGY, WIP_LIMIT, and SUPERVISOR_ENABLED settings. Use the full list of ready items.

**If the user chooses B:** Loop back to Phase 1 (SELECT) with fresh item selection.

**If the user chooses C:** Summarize total progress across all batches (items completed, items remaining, items stuck) and exit.

#### Loop termination

The Phase 2 → Phase 3 loop continues until one of these conditions is met:

1. **No ready items remain** — `list --ready` returns zero items. Report "All done" and exit.
2. **User chooses to stop** — user selects "Stop" at the continuation prompt.
3. **All items stuck** — every remaining item is in a stuck/blocked state with no path forward. Report the stuck items and exit.

---

## Orchestrator-Worker Communication

The orchestrator daemon communicates with workers via `cmux send`:

- **CI fix requests:** Sent when CI fails on a worker's PR
- **Review feedback:** Relayed when a trusted collaborator leaves review comments
- **Rebase requests:** Sent after a dependency merges and the worker needs to rebase
- **Stop requests:** Sent when the orchestrator needs to shut down a worker

**PR comments (audit trail):** The daemon posts comments prefixed with `**[Orchestrator]**`.

Workers prefix their comments with `**[Worker: TODO-ID]**`.

## Important Rules

- **Script dependency:** `.ninthwave/work` must exist and be executable
- **Branch safety:** All implementation on `todo/*` branches, never directly on main
- **Conflict handling:** Always check before launching
- **No silent failures:** Report errors and ask how to proceed
- **Crash recovery:** Re-running the orchestrate command resumes from where it left off
- **Orchestrator handles lifecycle:** Do not manually merge PRs, clean worktrees, or mark items done — the orchestrator does this automatically
