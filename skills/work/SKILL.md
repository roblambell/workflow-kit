---
name: work
description: |
  Batch-process work items through parallel AI coding sessions via cmux.
  Interactively select, launch, monitor, merge, and finalize work items.
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

This skill orchestrates batch processing of engineering TODOs through 5 interactive phases. The utility script `.ninthwave/work` must exist and be executable. All implementation work happens on worktree branches, never directly on main. VERSION and CHANGELOG.md are ONLY modified during Phase 5 (version-bump), never on feature branches.

---

### Phase 1: SELECT

**Goal:** Help the user choose which TODO items to work on in this batch.

1. Run `.ninthwave/work list --ready` to get all available items.
2. Parse the output and present a summary table to the user showing: ID, priority, domain, title, and estimated complexity.

3. AskUserQuestion -- "How do you want to select items?"
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

4. **Dependency analysis:** Run `.ninthwave/work batch-order <selected-IDs>` to check for dependency chains.

   - **If all items are in Batch 1** (no dependencies): proceed to conflict check and launch.
   - **If items span multiple batches**: present the batch plan. Start with Batch 1, process remaining after merge.

5. Run `.ninthwave/work conflicts <batch-IDs>` to check for file overlaps.

6. Present the conflict analysis. If conflicts, suggest splitting into sub-batches.

7. AskUserQuestion -- "Start this batch?"
   - Options:
     - A) Start these N items -- launch parallel sessions now
     - B) Remove conflicting items -- run only non-overlapping subset
     - C) Pick manually -- let me choose specific items by ID
     - D) Cancel -- go back to selection

8. **Merge strategy:**

   AskUserQuestion -- "How should PRs be merged?"
   - A) Auto-merge once approved -- merge after approval + CI passes
   - B) Auto-merge ASAP -- merge as soon as CI passes, skip approval wait
   - C) Ask me before merging -- confirm each merge individually

   Store MERGE_STRATEGY as: `approved` | `asap` | `ask`

9. **Execution mode** (only when total items >= 4):

   AskUserQuestion -- "How should we run these N items?"
   - A) WIP Autopilot -- launch up to a WIP limit; auto-start next when each PR opens
   - B) All at once -- start all simultaneously

   If user picks A, ask for WIP limit. Store WIP_LIMIT. Proceed to Phase 2A.
   If user picks B or total items < 4: proceed to Phase 2.

---

### Phase 2: LAUNCH

**Goal:** Create worktrees and launch parallel AI coding sessions.

1. Run `.ninthwave/work start <IDs>`.
2. Display summary: item ID, title, branch, worktree path, session name.
3. Tell the user sessions are running. Proceed to Phase 3.

---

### Phase 2A: AUTOPILOT (WIP Mode)

**Skip if WIP Autopilot was NOT selected.**

#### State tracking

Maintain four sets: **queued**, **implementing** (counts against WIP), **pr_open** (does NOT count against WIP), **merged**.

#### Initialization

1. Build item list ordered by batch-order output.
2. Launch min(WIP_LIMIT, launchable items).
3. Report status.

#### Watch loop

Use `.ninthwave/work autopilot-watch --interval 120 --state-file /tmp/autopilot-state.tsv` as a background task.

**CRITICAL: Check-then-watch pattern.** Before each watch, run `watch-ready` first and process actionable items.

**When transitions return:**

1. Update internal state from transitions
2. Merge according to MERGE_STRATEGY (merge eligible items, rebase dependents)
3. Orchestrator-driven post-PR handling (CI failures via `ci-failures`, review feedback via `pr-activity`, rebase needs)
4. Launch next items (fill WIP slots from queued)
5. Progress report
6. Check exit conditions
7. Loop

#### Merge execution

For each item being merged:
1. Close cmux workspace for that item
2. `gh pr merge <PR> --squash`
3. `git pull origin main --ff-only`
4. Rebase dependent active worktrees
5. Clean worktree and partition
6. Move to merged

---

### Phase 3: WAIT

**Skip if Phase 2A was used.**

Wait for user to confirm sessions completed, then verify PR status.

---

### Phase 4: MERGE

**Goal:** Merge all PRs from the batch.

1. Run `watch-ready` and `merged-ids` to categorize items
2. Use MERGE_STRATEGY from Phase 1 (or ask if not set)
3. Execute merges in order, handling conflicts and retries

---

### Phase 5: FINALIZE

**Goal:** Bump version, clean up, mark done.

1. `.ninthwave/work version-bump`
2. `.ninthwave/work clean`
3. `.ninthwave/work mark-done <IDs>` for all merged items
4. Commit TODOS.md changes
5. Present completion summary
6. Check for remaining dependency batches -- offer to continue

---

## Orchestrator-Worker Communication

**Operational messages:** Use `cmux send` to push text into worker sessions.

```bash
cmux send --workspace <workspace-ref> "message"
cmux send-key --workspace <workspace-ref> enter
```

**PR comments (audit trail):** Prefix with `**[Orchestrator]**`.

Workers prefix with `**[Worker: TODO-ID]**`.

## Important Rules

- **Script dependency:** `.ninthwave/work` must exist and be executable
- **Branch safety:** All implementation on `todo/*` worktree branches, main only during Phase 5
- **VERSION/CHANGELOG discipline:** Only modified during Phase 5
- **Conflict handling:** Always check before launching
- **No silent failures:** Report errors and ask how to proceed
- **External merges:** Detect and handle gracefully
- **Partition isolation:** Dynamic allocation, cleaned during start/clean
