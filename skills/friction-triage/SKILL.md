---
name: friction-triage
description: |
  Interactively walk through every friction log in `.ninthwave/friction/` one at
  a time. For each log: read it, assess severity and possible duplicates, ask the
  human what to do (fix now / create work item / update doc / drop / merge / skip),
  execute the decision, and delete the log. This is the canonical way to clear
  the friction inbox: a synchronous, human-in-the-loop session.
  Use when asked to "triage friction", "review friction logs", "clear the friction
  inbox", or "walk through friction".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
  - Agent
user_invocable: true
---

## What this skill is

This is the canonical way to process friction logs in this repo. It is a synchronous, human-in-the-loop session: you read each log, the user decides what to do, you execute, you delete. There is no async batch / review-PR fallback. The whole point is that the human stays in the loop and the inbox actually gets to zero in one sitting.

---

## Interactive Questions (CRITICAL)

This skill is highly interactive. You MUST use your interactive question tool to ask the user questions. Do NOT print a question as text and wait for a response.

**Tool names by platform:** `AskUserQuestion` (Claude Code), `question` (OpenCode), `request_user_input` (Codex), `ask_user` (Copilot CLI, Gemini CLI). Use whichever is available in your environment.

**Every question must follow this structure:**

1. **Re-ground:** State the project, the current branch, what phase you are in, and "log M of N". Assume the user has not looked at this window in 20 minutes.
2. **Explain simply:** Paraphrase the friction in plain English. Say what hurt, not just what the log file is named.
3. **Recommend:** State which option you would pick and why, in one line.
4. **Options:** Lettered options A) through F). When an option involves effort, indicate the scale.

---

## Hard rules

- **Never group questions across logs.** Always one question per log. **But DO batch the slow parts:** investigation runs in parallel up front (Phase 2), execution runs after all decisions are collected (Phase 4). The human's interactive window in Phase 3 must be as tight as possible: no nested confirmations, no waiting for subagents, no follow-up "are you sure" prompts.
- **Never commit.** The skill stages edits and writes new files. The human commits at the end if they want to.
- **Work items must follow `.ninthwave/work-item-format.md`.** Read it before writing any new work item file.
- **Generate lineage tokens with `nw lineage-token`** when creating a work item, the same way `/decompose` does.
- **Duplicate detection is best-effort.** If you are not certain two logs are duplicates, surface it as an option and let the human decide. Do not auto-merge.
- **"Drop" is a valid answer.** Friction that is no longer relevant is exactly what this flow exists to clear. Do not argue with the user when they pick D.
- **ASCII only.** No em dashes, no smart quotes, no ellipsis characters. Use `--`, straight quotes, and `...`. The repo enforces a `no-em-dash` lint rule on `.md` files.

---

## Phase 1: LOAD

**Goal:** Find every friction log and prepare to walk through them.

1. List the friction inbox:
   ```bash
   ls .ninthwave/friction/*.md 2>/dev/null
   ```
   Exclude `.gitkeep`. Friction logs live flat in `.ninthwave/friction/`; there is no archive directory. The triage flow is "log -> handle -> delete", end of life.

2. If there are zero logs, tell the user "Friction inbox is clean. Nothing to triage." and exit.

3. Sort the logs by filename (timestamps in the filename make this FIFO by default). Oldest first.

4. Announce the shape of the session so the human knows what is coming: "Found N friction logs. I will investigate all of them in parallel first (this is the slow part). Then I will ask you about each one quickly. Then I will apply your decisions in a batch at the end. The interactive part should take a couple of minutes."

---

## Phase 2: INVESTIGATE (parallel)

**Goal:** Front-load all the slow work. Every friction log gets a grounded investigation before the human is asked anything.

Triage decisions are dramatically better when grounded in the actual codebase, git history, the rest of the friction inbox, and the open work-item queue. Do not try to do this analysis from your own context: you will skim, you will guess, and recommendations will be soft. Delegate it to subagents, and run them in parallel so the human's interactive window in Phase 3 is not gated on slow exploration.

### How to launch

**Launch one Explore subagent per log, all in parallel.** Issue a single assistant message containing N `Agent` tool calls, one per friction log. Do NOT spawn them sequentially. This is the entire point of the phase.

If the inbox holds more than 10 logs, batch in groups of 10 (still parallel within each group). Wait for one group to finish before launching the next.

**Subagent type:** in Claude Code use `subagent_type: "Explore"` with thoroughness "medium". On other platforms use the equivalent codebase-exploration agent.

### Subagent prompt template

Fill in the bracketed parts for each log before launching:

```
You are investigating ONE friction log from a ninthwave repo so a human can decide what to do with it. Read whatever you need (code, git log, other friction logs, open work items) to give a grounded recommendation AND draft the concrete artifact that would be applied if the human approves.

Friction log path: [path]
Friction log contents (verbatim):
[paste the entire file body, including frontmatter fields]

Investigate and report back, in this exact section order:

1. WHERE A FIX WOULD LAND
   Identify specific files (with line numbers when possible) where the rectification would happen. If the friction names a tool, file, command, behavior, or doc, find it in the repo.

2. ALREADY ADDRESSED?
   Check `git log --since=[log date]` for commits that look related. Read the current state of the relevant code/docs to see whether the friction has already been fixed since the log was written. State explicitly: yes (with commit SHA) / no / unclear.

3. EXISTING WORK ITEMS
   Look in `.ninthwave/work/` for any open work items that already cover this friction. List filename and ID for each match. If none, say "none".

4. DUPLICATE FRICTION LOGS
   Look at the other files in `.ninthwave/friction/` for logs that overlap this one. List filename and a one-line reason for the overlap. If none, say "none".

5. SMALLEST CONCRETE FIX
   Describe the smallest change that would resolve this friction. Be specific: "edit `agents/implementer.md` around line 380 to add a step that does X" beats "improve the worker logic". If the fix is non-trivial or speculative, say so and sketch the shape instead.

6. RECOMMENDATION
   Pick exactly one tag and give a one-sentence reason:
     FIX_NOW         -- small code change, obvious, low risk
     UPDATE_DOC      -- the fix is editing a doc / skill / prompt
     CREATE_WORKITEM -- real fix is non-trivial, needs its own PR
     DROP            -- already fixed, stale, or not actionable
     MERGE_INTO      -- duplicate of another log; name which one

7. DRAFT THE ARTIFACT
   Produce the concrete thing that would be applied if the human approves your recommendation. Do not write any files; include the artifact inline in your report so the skill can apply it later.

   - FIX_NOW or UPDATE_DOC: the exact file path and a before/after edit, ready for the Edit tool. Show enough surrounding context that `old_string` will be unique. Use fenced code blocks labeled `BEFORE` and `AFTER`.
   - CREATE_WORKITEM: the full work item file. Filename in the form `{priority_num}-{domain_slug}--{ID}.md`. Body following `.ninthwave/work-item-format.md` exactly. Leave the lineage token as the literal string `<LINEAGE>`; the skill will fill it in.
   - DROP: a one-line receipt naming the commit SHA or existing work item that resolves the friction.
   - MERGE_INTO: the target log filename and a one-line note on what distinct context to append.

Be concrete, not vague. No prose paragraphs, no hedging. Cap your report at 500 words including the artifact.
```

### After all subagents return

Build a triage table in your working notes, indexed by log path. One entry per log:

```
{
  <log_path>: {
    assessment: <synthesized block, see below>,
    rec: <FIX_NOW | UPDATE_DOC | CREATE_WORKITEM | DROP | MERGE_INTO>,
    draft: <the concrete artifact from section 7, kept verbatim>,
    full_report: <the subagent's full response, retained for fallbacks>
  }
}
```

Synthesized assessment block format:

```
Log M of N: <filename>
Item: <item id>   Severity: <low|medium|high>   Date: <date>
Friction: <one-sentence paraphrase of what hurt>
Where it would land: <file:line, file:line>
Already addressed?: <yes (commit abc123) | no | unclear>
Existing work item?: <ID + path | none>
Possible duplicate: <other log filename | none>
Smallest fix: <one-line concrete description>
Subagent rec: <FIX_NOW | UPDATE_DOC | CREATE_WORKITEM | DROP | MERGE_INTO> -- <one-line reason>
```

The triage table is the only state Phase 3 and Phase 4 share. Carry it across both phases without dropping anything.

---

## Phase 3: DECIDE (quick interactive walk-through)

**Goal:** Collect every decision, fast. Do not execute anything.

Walk the triage table in FIFO order. For each log, in order:

1. **Print** the assessment block (so the human has the grounded context on screen above the question).
2. **Call AskUserQuestion ONCE.** No follow-ups. No "are you sure". No inner confirmation loops.
3. **Mark the subagent's recommendation** as `(Recommended)` and put it first in the option list (per the AskUserQuestion convention).
4. **Use the `preview` field** on the recommended option to show the proposed artifact: the work item draft, the before/after diff, the receipt, etc. AskUserQuestion renders previews as monospace markdown blocks beside the option list, so the human can read what will happen if they approve without leaving the question.
5. **Record** the user's choice in the triage table under a new `decision` key. Move to the next log immediately.

If the user picks an option the subagent did NOT draft for (e.g. the user picks B when the subagent recommended D), record the choice anyway. Phase 4 will draft inline using the investigation context from `full_report`.

### Question shape

Every Phase 3 question follows the same structure (re-grounding the user each time, since they may have lost focus mid-walk-through):

> **Question:** "Project: ninthwave. Branch: `<current>`. Phase: friction-triage decide, log M of N (`<filename>`). The friction: `<one-sentence paraphrase>`. The investigation found: `<one-line on where the fix lands>` | `<one-line on whether it's already addressed>` | `<one-line on duplicates or existing work items, if any>`. Smallest concrete fix: `<smallest fix>`. I would pick `<X>` because `<reason that references the investigation, not just the log text>`. What should we do with this log?"

### Options

Always offer A, B, C, D, F. Only offer E when the subagent flagged a real duplicate candidate.

- **A) Fix now (small code change)** -- apply the pre-drafted edit directly in the codebase. The diff will appear in the `preview` if this is the recommended option.
- **B) Create work item** -- write the pre-drafted work item to `.ninthwave/work/`. The full file will appear in the `preview` if this is the recommended option.
- **C) Update a doc / skill / prompt** -- apply the pre-drafted doc edit to `agents/implementer.md`, `CLAUDE.md`, an existing skill, etc. The diff will appear in the `preview` if this is the recommended option.
- **D) Drop** -- delete the log with no further action. The receipt (commit SHA or existing work item ID) will appear in the `preview` if this is the recommended option.
- **E) Merge into another log** -- append this log's distinct context to the duplicate the subagent named, then delete this log.
- **F) Skip for now** -- leave the log in place and move on. Use sparingly: the point of this session is to drive the inbox to zero.

The whole point of Phase 3 is speed: read assessment, click option, next. If the human wants to steer a draft, they pick "Other" with notes and Phase 4 honors them.

---

## Phase 4: EXECUTE (batch)

**Goal:** Apply every recorded decision. The human's input window is closed; do not call AskUserQuestion in this phase.

Walk the triage table in FIFO order. For each entry, look at the recorded `decision` and apply it.

### Decision handlers

**A) Fix now / C) Update doc:**
1. Use the pre-drafted edit from `draft`. Open the file, locate the BEFORE block, apply the AFTER block via the Edit tool.
2. If the user overrode the subagent's recommendation and there is no pre-drafted edit for this option, draft one inline from `full_report` and apply it.
3. Print a 3-5 line summary of what changed and which file.

**B) Create work item:**
1. Generate a lineage token:
   ```bash
   nw lineage-token
   ```
2. Substitute it for the `<LINEAGE>` placeholder in the drafted file body.
3. Write the file to `.ninthwave/work/{priority_num}-{domain_slug}--{ID}.md`.
4. Print the new ID and path.
5. If the user picked B without a pre-drafted work item (because the subagent recommended something else), draft one inline from `full_report` using the same fields as the standard subagent template, then write.

**D) Drop:**
1. Print the one-line receipt from `draft` so the user has the trail (commit SHA or existing work item ID).
2. No file changes.

**E) Merge into <other log>:**
1. Read the target log named in `draft`.
2. Append a `---` divider and the distinct context from the current log (do not duplicate fields that already match).
3. Use Edit to write the appended content.

**F) Skip:**
1. Leave the log in place. Do nothing.

### After each handler

For decisions A, B, C, D, E, delete the friction log:

```bash
rm <log_path>
```

For F, do not delete.

Print one line per log as it is handled: "Log M of N done: `<decision>` -- `<one-line outcome>`. `<remaining>` to go."

---

## Phase 5: WRAP

When the loop finishes, summarize the session:

1. Counts: "Triaged N logs. Fixed: X. New work items: Y. Doc updates: Z. Dropped: W. Merged: V. Skipped: S."
2. List any new work items by ID.
3. List any files edited.
4. Run `git status` and show the user the staged/unstaged changes.
5. **Do NOT commit.** Tell the user the suggested commit command and let them decide:
   ```
   Suggested next step:
     git add -A && git commit -m "chore: triage friction logs"
   I will not run this for you. Commits are your call.
   ```

---

## Why this skill exists (background for the worker reading this)

Friction logs are the dogfooding signal that drives ninthwave's roadmap (see `VISION.md`: "the friction log is the roadmap"). They accumulate fast because workers and humans both write them. Clearing them is high leverage but easy to put off when the flow is async, so the design here is deliberately **synchronous AND fast**: investigation runs in parallel up front so the slow part is over before the human starts answering, decisions are quick (one question per log, with the proposed artifact already drafted in the preview), and execution is batched at the end. The interactive window the human sits through should be a couple of minutes for a typical inbox.

The skill's job is to keep that loop tight: parallel investigation, no nested confirmations, no waiting for subagents during the Decide phase, no commits without permission.
