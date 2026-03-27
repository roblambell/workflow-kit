---
name: work
description: |
  Batch-process work items through parallel AI coding sessions.
  Interactively select items, then delegate execution to `ninthwave orchestrate`.
  Includes continuous delivery loop with friction review, vision exploration, and
  autonomous self-improvement when dogfooding.
  Use when asked to "process work items", "batch work", "run work", "start work",
  "grind", "work-work-work", "continuous loop", "dogfood loop", or "self-improvement cycle".
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

> **Rule: Never trust `list --ready` without reconciling first.** Todo files in `.ninthwave/todos/` may be stale if PRs were merged outside the orchestrator (manually, by another session, or by GitHub auto-merge). Always reconcile before listing.

1. Run `ninthwave reconcile` to sync todo state with GitHub (removes files for merged PRs, cleans stale worktrees).
2. Run `ninthwave list --depth 99` to get all reachable items across the full dependency chain. Also run `ninthwave list --ready` to identify which items can start immediately (depth 1).
3. Parse the output and present a summary showing items grouped by depth tier:
   - **Depth 1 (starts now):** items with all deps already done
   - **Depth 2 (starts after depth 1):** items whose deps are all in depth 1 or done
   - **Depth N:** and so on until all items are shown
   Show: ID, priority, domain, title, and estimated complexity. Items with a `Repo:` field will indicate which target repo they belong to.

4. **Quick-start detection:** If there are reachable items and the user invoked `/work` without specifying particular items or filters, offer a streamlined entry:

   AskUserQuestion -- "N items reachable (M at depth 1, K at depth 2, ...). How deep do you want to go?"
   - A) Full chain (depth N) with defaults (auto-merge ASAP, WIP 4) — recommended; the orchestrator queues deeper items until their deps merge
   - B) Depth 1 only — just items that can start right now
   - C) Interactive selection — choose items by feature, priority, or domain
   - D) Dry run — show the batch plan without launching

   **If user picks A:** Skip to step 6 (dependency analysis) with all reachable items selected, then skip the merge strategy / WIP limit questions — use the defaults. Proceed directly to Phase 2.

   **If user picks B:** Skip to step 6 with only depth-1 items selected, using defaults. Proceed directly to Phase 2.

   **If user picks C:** Continue with the interactive selection flow below.

   **If user picks D:** Show the batch plan and exit.

5. AskUserQuestion -- "How do you want to select items?"
   - Detect if any feature-code IDs exist (IDs with alphabetic characters like `BF5`, `UO`, `ST`).
   - Options:
     - A) By feature code -- select all items for a specific feature (only if feature IDs detected)
     - B) By priority level -- filter by critical/high/medium/low
     - C) By domain -- filter by domain area
     - D) All ready (N items total) -- process everything available

   **If user picks A (feature code):**
   - List the distinct feature codes found.
   - AskUserQuestion to pick a feature code.
   - Run `ninthwave list --feature <code>`.

   **If user picks B (priority):**
   - AskUserQuestion -- "Which priority level?"
   - Filter items by chosen priority.

   **If user picks C (domain):**
   - AskUserQuestion -- "Which domain?"
   - Filter items by chosen domain.

6. **Dependency analysis:** Run `ninthwave batch-order <selected-IDs>` to check for dependency chains.

   - **If all items are in Batch 1** (no dependencies): proceed to conflict check.
   - **If items span multiple batches**: present the batch plan. The orchestrator handles dependency ordering automatically — all selected items can be passed together. **Stacking note:** items with in-flight dependencies will automatically launch stacked on the dependency's branch (no need to wait for it to merge first). This means multi-batch dependency chains often execute faster than the batch plan suggests.

7. Run `ninthwave conflicts <batch-IDs>` to check for file overlaps.

8. Present the conflict analysis. If conflicts, suggest splitting into sub-batches or lowering the WIP limit.

9. AskUserQuestion -- "Start this batch?"
   - Options:
     - A) Start these N items -- launch the orchestrator now
     - B) Remove conflicting items -- run only non-overlapping subset
     - C) Pick manually -- let me choose specific items by ID
     - D) Cancel -- go back to selection

10. **Merge strategy:**

    AskUserQuestion -- "How should PRs be merged?"
    - A) Auto-merge once approved -- merge after approval + CI passes
    - B) Auto-merge ASAP -- merge as soon as CI passes, skip approval wait
    - C) Ask me before merging -- confirm each merge individually

    Store MERGE_STRATEGY as: `approved` | `asap` | `ask`

11. **WIP limit** (only when total items >= 4):

    AskUserQuestion -- "WIP limit? (how many items to process concurrently)"
    - A) 4 (default) -- good balance of parallelism and memory usage
    - B) 2 -- conservative, lower memory usage
    - C) All at once -- start all simultaneously (set WIP_LIMIT to item count)
    - D) Custom -- let me enter a number

    Store WIP_LIMIT (default: 4).

---

### Transition: Commit and push TODO changes

**Goal:** Ensure all TODO file changes from Phase 1 (selection, reconciliation, ad-hoc edits) are committed and pushed before launching workers.

> **Why?** Workers spawn in worktrees cloned from the remote. If TODO files are created, modified, or removed during Phase 1 but not pushed, workers won't see those changes — they'll operate on stale state from the last push.

```bash
git add .ninthwave/todos/
# Only commit if there are staged changes
if ! git diff --cached --quiet; then
  git commit -m "chore: sync TODO files before orchestration"
  git push
fi
```

Skip this step if nothing changed in `.ninthwave/todos/` during Phase 1.

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

   **Output modes:** When run in a TTY, the daemon shows an interactive TUI with a live status table. Use `--json` for structured JSON log lines (useful for piping to other tools or CI):

   ```bash
   ninthwave orchestrate \
     --items <comma-separated-IDs> \
     --json
   ```

2. Run the command. The orchestrator handles the full lifecycle automatically:
   - **Queued** items wait for dependencies to clear — or **stack early** if a dependency is already in-flight (ci-passed, review-pending, or merging). Stacked items launch from the dependency's branch instead of main.
   - **Ready** items get launched as worker sessions (up to the WIP limit)
   - **Implementing** workers are monitored for completion
   - **CI-pending/CI-passed** PRs are tracked through CI
   - **Merging** PRs are squash-merged, worktrees cleaned, and items marked done
   - **Post-merge restacking** — after a dependency merges, stacked dependents are automatically rebased onto main using squash-merge-safe `rebaseOnto()`
   - **Stack navigation comments** — PRs in a dependency chain get comments showing the full stack with links, so reviewers can navigate up and down the chain
   - Adaptive polling adjusts check frequency based on current state
   - Crash recovery reconstructs state from disk and GitHub on restart

3. The orchestrator emits structured JSON log lines (always in `--json` mode; TUI mode also logs to `~/.ninthwave/state/<project>/daemon.log`). Monitor the output for:
   - `orchestrate_start` — daemon started, lists all items
   - `transition` — items moving between states (e.g., `queued → ready → launching`)
   - `action_execute` / `action_result` — launches, merges, cleanups
   - `orchestrate_complete` — all items reached terminal state (done or stuck)
   - `shutdown` — SIGINT received, clean exit

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

Phase 3 runs automatically after Phase 2 completes. It checks whether more work was unblocked by the completed batch, reviews friction, offers vision exploration, and loops back. In dogfooding mode (developing ninthwave itself), it runs the full self-improvement cycle automatically.

#### Step 1: Reconcile and check for remaining ready items

Run `ninthwave reconcile` to sync todo state with GitHub — files for merged items are removed from `.ninthwave/todos/`, stale worktrees are cleaned, and changes are committed/pushed. Never trust `list --ready` without reconciling first.

Then run `ninthwave list --ready` to see if any items were unblocked by the batch that just completed.

- If **ready items exist** (non-vision items), continue to Step 2.
- If **only vision items remain** (L-VIS-*) or **no items remain**, skip to Step 3 (vision).

#### Step 2: Dogfooding — friction log review (ninthwave projects only)

**Detection:** Check if `skills/work/SKILL.md` exists in the project root. If it does, this is a ninthwave project and dogfooding mode is active.

If in dogfooding mode:

1. Read friction files from `.ninthwave/friction/` directory (excluding the `processed/` subdirectory). Each file is an individual friction observation.
2. Identify any **new actionable entries** — friction items that don't already have corresponding TODOs in `.ninthwave/todos/`.
3. If actionable entries exist, present them to the user:

   AskUserQuestion — "Friction log has N new actionable entries. Decompose into TODOs?"
   - A) Yes — decompose into TODOs, then include them in the next batch
   - B) Skip — continue with existing ready items only
   - C) Show entries — display the friction entries before deciding

   If the user chooses A, use the `/decompose` skill to break friction entries into TODOs. Pass the friction file contents as context. The newly created items will appear in the next `list --ready` call.

4. **Mark processed friction entries:** After reviewing and decomposing friction entries (whether the user chose A or B), move all reviewed friction files to `.ninthwave/friction/processed/`. This prevents re-reviewing the same entries in the next loop iteration. The original files are preserved in `processed/` for audit trail purposes.

   ```bash
   mkdir -p .ninthwave/friction/processed
   # Move all top-level friction files (not directories) to processed/
   for f in .ninthwave/friction/*.md; do
     [ -f "$f" ] && mv "$f" .ninthwave/friction/processed/
   done
   ```

5. **Commit friction artifacts:** Commit any new or moved friction files and decomposed TODOs so they are not lost between loop iterations. Only commit if there are staged changes — skip if nothing new.

   ```bash
   git add .ninthwave/friction/ .ninthwave/todos/
   # Only commit if there are staged changes
   if ! git diff --cached --quiet; then
     git commit -m "chore: commit friction entries and decomposed TODOs"
   fi
   ```

   > **Why commit here?** Without this step, friction files and newly decomposed TODOs accumulate uncommitted. If the session is interrupted or the orchestrator restarts, uncommitted friction work is lost. Committing ensures the friction-to-TODO pipeline is durable.

If **not** in dogfooding mode, skip this step entirely.

#### Step 3: Vision exploration (when all code items are done)

Check if an L-VIS-* item exists in `.ninthwave/todos/` and is ready (all deps met). This step runs when all non-vision items have been processed — either no ready items remain, or only vision items are left.

- If **no vision item is ready**, skip to Step 4.
- If a vision item is ready:

  AskUserQuestion — "All code and friction items are done. Ready to run the vision exploration (L-VIS-N)? This reviews the product state, friction log, and competitive landscape, then decomposes new work."
  - A) Run vision — recommended
  - B) Skip vision — end this cycle
  - C) Run vision with scope constraint — limit vision to a specific area

  If the user chooses A or C, process the vision item via the orchestrator (single item). After vision completes, run `ninthwave reconcile` to sync state. New TODOs created by the vision item feed back into the loop naturally — return to Step 1.

  If the user chooses B, skip to Step 4.

#### Step 4: Offer to continue

Run `ninthwave list --ready` to get the current count (may have changed due to friction decompose or vision).

- If **no ready items remain**, report "All done — inbox zero" and exit.
- If **ready items exist**, present them:

AskUserQuestion — "Batch complete. N items are now ready. Continue?"
- A) Continue with all N items — launch the next batch with the same merge strategy and WIP limit
- B) Select items — go back to Phase 1 to pick specific items
- C) Stop — exit the delivery loop

**If the user chooses A:** Loop back to Phase 2 with the same MERGE_STRATEGY and WIP_LIMIT settings. Use the full list of ready items.

**If the user chooses B:** Loop back to Phase 1 (SELECT) with fresh item selection.

**If the user chooses C:** Summarize total progress across all batches (items completed, items remaining, items stuck) and exit.

#### Cycle summary

At each checkpoint, display a summary:

```
╔══════════════════════════════════════════╗
║          CYCLE SUMMARY                   ║
╠══════════════════════════════════════════╣
║  Items processed:    8                   ║
║  Items merged:       7                   ║
║  Items stuck:        1                   ║
║  Friction reviewed:  3 entries           ║
║  Friction → TODOs:   2 new items         ║
║  Vision items:       1 (L-VIS-4)         ║
║  New items created:  5                   ║
║  Ready for next:     5                   ║
╚══════════════════════════════════════════╝
```

#### Loop termination

The Phase 2 → Phase 3 loop continues until one of these conditions is met:

1. **No ready items remain** — `list --ready` returns zero items after vision check. Report "All done — inbox zero" and exit.
2. **User chooses to stop** — user selects "Stop" at the continuation prompt or skips vision.
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

- **CLI dependency:** `ninthwave` (or `nw`) must be in PATH
- **Branch safety:** All implementation on `todo/*` branches, never directly on main
- **Conflict handling:** Always check before launching
- **No silent failures:** Report errors and ask how to proceed
- **Crash recovery:** Re-running the orchestrate command resumes from where it left off
- **Orchestrator handles lifecycle:** Do not manually merge PRs, clean worktrees, or mark items done — the orchestrator does this automatically
