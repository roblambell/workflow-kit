---
name: grind
description: |
  Continuous delivery and self-improvement loop. Processes all TODOs,
  reviews friction, decomposes improvements, processes those, runs vision,
  and repeats — fully autonomous until the user stops it or it runs out of work.
  Use when asked to "grind", "work-work-work", "continuous loop", "dogfood loop",
  or "self-improvement cycle".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
user_invocable: true
---

## Interactive Questions (CRITICAL)

This skill is interactive at key decision points. You MUST use your interactive question tool — do NOT simply print a question as text and wait for a response.

**Tool names by platform:** `AskUserQuestion` (Claude Code), `question` (OpenCode), `request_user_input` (Codex), `ask_user` (Copilot CLI, Gemini CLI). Use whichever is available in your environment.

**Every question must follow this structure:**

1. **Re-ground:** State the project, current branch, and what cycle/phase you're in. Assume the user hasn't looked at this window in 20 minutes.
2. **Explain simply:** Describe the situation in plain English.
3. **Recommend:** State which option you'd pick and why.
4. **Options:** Lettered options: A), B), C).

---

## Overview

`/grind` is the fully autonomous self-improvement loop. It runs the entire dogfooding cycle from CLAUDE.md without requiring the user to manually invoke `/work`, `/decompose`, or vision exploration between batches.

The cycle:

```
  ┌─────────────────────────────────────────────────────────┐
  │                    /grind LOOP                          │
  │                                                         │
  │  1. WORK ──→ Process all ready TODOs                    │
  │       ↓                                                 │
  │  2. FRICTION ──→ Review friction log                    │
  │       ↓                                                 │
  │  3. DECOMPOSE ──→ Turn friction into TODOs              │
  │       ↓                                                 │
  │  4. WORK ──→ Process friction TODOs                     │
  │       ↓                                                 │
  │  5. VISION ──→ Run L-VIS-N, explore what's next         │
  │       ↓                                                 │
  │  6. REPEAT ──→ Back to step 1 with new TODOs            │
  └─────────────────────────────────────────────────────────┘
```

The user can interrupt at any checkpoint. Between major phases the skill pauses to report progress and confirm continuation.

---

## Phase 0: CONFIGURE

**Goal:** Set up the grind loop with sensible defaults, confirm with the user.

1. Run `.ninthwave/work reconcile` to sync todo state with GitHub.
2. Run `.ninthwave/work list` to get the full picture.
3. Count items by status: ready, blocked, in-progress, total.

4. AskUserQuestion — "Starting the grind loop. Here's the current state: N ready, M blocked, K in-progress, T total. Settings?"

   - **Merge strategy:** `asap` (auto-merge when CI passes — recommended for dogfooding)
   - **WIP limit:** `4` (default, reduce if memory pressure observed)
   - **Supervisor:** `on` (anomaly detection and friction logging)

   Options:
   - A) Start with defaults (asap, WIP 4, supervisor on) — recommended
   - B) Customize settings
   - C) Dry run — show what would happen without launching

If the user picks B, ask follow-up questions for each setting.

---

## Phase 1: WORK

**Goal:** Process all ready TODOs through the orchestrator.

1. Get the list of ready items: `.ninthwave/work list --ready`
2. If no items are ready, skip to Phase 2 (friction review).
3. Get the batch order: `.ninthwave/work batch-order <IDs>`
4. Show the user the batch plan (how many batches, which items in each).
5. Launch the orchestrator:

```bash
ninthwave orchestrate --items <IDs> --merge-strategy <STRATEGY> --wip-limit <WIP> [--supervisor]
```

6. Wait for orchestration to complete.
7. Run `.ninthwave/work reconcile` to sync state.
8. Report results: items merged, items stuck, items remaining.

**If items are stuck:** Report them and ask the user whether to investigate or skip.

---

## Phase 2: FRICTION REVIEW

**Goal:** Check friction observations for new actionable items.

1. Check for friction files in `.ninthwave/friction/` directory. Each file is an individual friction observation.

2. If the directory doesn't exist or has no files (`ls .ninthwave/friction/` is empty), skip to Phase 4.

3. Read the friction files. Identify entries that:
   - Don't have corresponding TODOs already in `.ninthwave/todos/`
   - Are actionable (not just observations or already-fixed items)
   - Were logged since the last grind cycle (or all, if first cycle)

4. If no new actionable friction, skip to Phase 4.

5. Present findings:

   AskUserQuestion — "Found N new friction observations since last cycle. Review them?"
   - A) Review and decompose — show entries, then decompose actionable ones into TODOs
   - B) Skip friction — proceed to vision
   - C) Show entries only — display without decomposing

---

## Phase 3: DECOMPOSE FRICTION

**Goal:** Turn actionable friction into TODO items.

1. For each actionable friction entry, use `/decompose` (invoke the skill or run the equivalent CLI workflow) to break it into individual TODO files in `.ninthwave/todos/`.
2. New items are written as individual files — no ordering within the directory is needed. Dependencies ensure friction TODOs are processed before vision items.
3. Report what was added: N new items across M domains.

4. Loop back to **Phase 1** to process the newly created friction TODOs.

---

## Phase 4: VISION

**Goal:** Run the recurring vision item to explore what's next.

1. Check if an L-VIS-* item exists in `.ninthwave/todos/` and is ready (all deps met).
2. If no vision item is ready, report "No vision item ready — cycle complete" and go to Phase 5.

3. AskUserQuestion — "All code and friction items are done. Ready to run the vision exploration (L-VIS-N)? This will review the product state, friction log, and competitive landscape, then decompose new work."
   - A) Run vision — recommended
   - B) Skip vision — end this cycle
   - C) Run vision with scope constraint — limit vision to a specific area

4. Process the vision item via the orchestrator (single item).
5. After vision completes, reconcile todo state.
6. Report: what new items were created, what the next iteration looks like.

---

## Phase 5: CHECKPOINT

**Goal:** Decide whether to continue the loop.

1. Run `.ninthwave/work list --ready` to see if new items exist (from vision or friction).
2. Report cycle summary:
   - Items processed this cycle
   - Items created this cycle (from friction + vision)
   - Items ready for next cycle
   - Friction entries addressed
   - Total wall-clock time for this cycle

3. AskUserQuestion — "Cycle N complete. M items shipped, K new items ready. Continue?"
   - A) Continue — start the next cycle (back to Phase 1)
   - B) Continue but re-check friction first — go to Phase 2
   - C) Stop — end the grind loop

If the user continues, increment the cycle counter and loop back.

---

## Loop Termination

The grind loop ends when:

1. **No ready items and no actionable friction** — nothing left to do. Report "Grind complete — inbox zero."
2. **User chooses to stop** — at any checkpoint.
3. **All items stuck** — every remaining item is blocked with no path forward. Report stuck items and exit.
4. **Resource pressure** — if the supervisor flags memory pressure or the user's system is struggling, suggest pausing.

---

## Cycle Summary Format

At each checkpoint, display:

```
╔══════════════════════════════════════════╗
║          GRIND CYCLE N SUMMARY           ║
╠══════════════════════════════════════════╣
║  Items processed:    8                   ║
║  Items merged:       7                   ║
║  Items stuck:        1                   ║
║  Friction reviewed:  3 entries           ║
║  Friction → TODOs:   2 new items         ║
║  Vision items:       1 (L-VIS-4)         ║
║  New items created:  5                   ║
║  Ready for next:     5                   ║
║  Wall clock:         47 min              ║
╚══════════════════════════════════════════╝
```

---

## Important Rules

- **Always reconcile before listing.** Todo files may be stale.
- **Auto-merge is the default.** This is dogfooding — tight feedback loops matter.
- **Supervisor should be on.** It detects anomalies and logs friction automatically.
- **Worktree isolation is mandatory.** Every worker gets its own worktree.
- **Never skip friction review.** The friction log is the roadmap. Skipping it defeats the purpose of the grind loop.
- **Vision is optional per cycle.** The user can skip it if they want to focus on code items only.
- **Report progress, don't hide it.** The cycle summary is how the user knows the loop is healthy.
- **Crash recovery works.** If the grind loop is interrupted, re-running `/grind` picks up where it left off — the orchestrator handles state reconstruction.
