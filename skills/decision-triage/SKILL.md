---
name: decision-triage
description: |
  Interactively walk through every decision log in `.ninthwave/decisions/` one at
  a time. For each log: read it, check whether the choice it describes still
  matches what shipped, ask the human what to do (ratify / record as ADR /
  codify into an existing doc / create follow-up work item / revise / merge /
  skip), execute the decision, and delete the log. This is the canonical way
  to clear the decisions inbox: a synchronous, human-in-the-loop session.
  Use when asked to "triage decisions", "review decision logs", "clear the
  decisions inbox", or "walk through decisions".
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

This is the canonical way to process decision logs in this repo (and any other repo that uses ninthwave). It is a synchronous, human-in-the-loop session: you read each log, the user decides what to do, you execute, you delete. There is a parallel async path (`nw review-inbox decisions`) that opens a weekly review PR; this skill is the sit-down-and-clear-it-now alternative.

Decision logs are not the same as friction logs. A friction log says "something hurt, fix it or drop it." A decision log says "I made a choice X for reason Y, and here is what shipped." So the central question is not "fix or drop" but **ratify, codify, or follow up**: is the choice sound, should it be promoted into durable policy or recorded as a permanent architectural record, and does it leave behind a tradeoff or missing guardrail that needs its own work item?

---

## Repo-agnostic rule (read before anything else)

This skill ships from one repo but runs in any repo that uses ninthwave. The only paths and contracts you may assume exist are the ones ninthwave itself defines:

- `.ninthwave/decisions/` -- the inbox to drain
- `.ninthwave/work/` -- where new work items get written
- `.ninthwave/work-item-format.md` -- work item shape
- `nw lineage-token` -- CLI for lineage IDs
- The decision file fields: `item`, `date`, `summary`, `context`, `decision`, `rationale`

**Anything outside `.ninthwave/` is consuming-repo-specific and must be discovered at runtime.** That includes `docs/`, `agents/`, `skills/`, `CLAUDE.md`, `README.md`, ADR directories, technical guides, and so on. Do not hardcode these paths anywhere in this session. Phase 2 subagents are responsible for discovering each repo's actual conventions before recommending where a CODIFY edit or an ADR record should land. If you find yourself about to suggest editing a file you have not opened, stop and re-survey.

---

## Interactive Questions (CRITICAL)

This skill is highly interactive. You MUST use your interactive question tool to ask the user questions. Do NOT print a question as text and wait for a response.

**Tool names by platform:** `AskUserQuestion` (Claude Code), `question` (OpenCode), `request_user_input` (Codex), `ask_user` (Copilot CLI, Gemini CLI). Use whichever is available in your environment.

**Every question must follow this structure:**

1. **Re-ground:** State the project, the current branch, what phase you are in, and "decision M of N". Assume the user has not looked at this window in 20 minutes.
2. **Explain simply:** Paraphrase the decision in plain English. Say what was chosen and why, not just what the log file is named.
3. **Recommend:** State which option you would pick and why, in one line. Anchor the reason in the investigation, not the log text.
4. **Options:** Lettered options. When an option involves effort, indicate the scale.

---

## Hard rules

- **Never group questions across decisions.** Always one question per log. **But DO batch the slow parts:** investigation runs in parallel up front (Phase 2), execution runs after all decisions are collected (Phase 4). The human's interactive window in Phase 3 must be as tight as possible: no nested confirmations, no waiting for subagents, no follow-up "are you sure" prompts.
- **Never commit.** The skill stages edits and writes new files. The human commits at the end if they want to.
- **Work items must follow `.ninthwave/work-item-format.md`.** Read it before writing any new work item file.
- **Generate lineage tokens with `nw lineage-token`** when creating a work item, the same way `/decompose` does.
- **Do not assume any path outside `.ninthwave/`.** Discover the consuming repo's doc, ADR, agent prompt, and skill conventions via Phase 2 globs. Never hardcode `agents/implementer.md`, `docs/adr/`, `ETHOS.md`, etc.
- **Never propose an edit to a file the subagent has not actually opened.** Codify edits must reference real files surfaced by the doc survey, not guesses based on common conventions.
- **Duplicate detection is best-effort.** If you are not certain two logs are duplicates, surface it as an option and let the human decide. Do not auto-merge.
- **No "Drop" option.** Decisions describe choices that already shipped, so they do not go stale the way friction does. "Ratify" covers "delete with no follow-up." If a decision is genuinely meaningless (e.g., the underlying code was reverted), Ratify with a one-line receipt that names the revert commit.
- **ASCII only.** No em dashes, no smart quotes, no ellipsis characters. Use `--`, straight quotes, and `...`. The repo enforces a `no-em-dash` lint rule on `.md` files.

---

## Phase 1: LOAD

**Goal:** Find every decision log and prepare to walk through them.

1. List the decisions inbox:
   ```bash
   ls .ninthwave/decisions/*.md 2>/dev/null
   ```
   Exclude `.gitkeep`. Decision logs live flat in `.ninthwave/decisions/`; there is no archive directory. The triage flow is "log -> handle -> delete", end of life.

2. If there are zero logs, tell the user "Decisions inbox is clean. Nothing to triage." and exit.

3. Sort the logs by filename (timestamps in the filename make this FIFO by default). Oldest first.

4. Announce the shape of the session so the human knows what is coming: "Found N decision logs. I will investigate all of them in parallel first (this is the slow part). Then I will ask you about each one quickly. Then I will apply your decisions in a batch at the end. The interactive part should take a couple of minutes."

---

## Phase 2: INVESTIGATE (parallel)

**Goal:** Front-load all the slow work. Every decision log gets a grounded investigation, including a doc survey of the consuming repo, before the human is asked anything.

Triage decisions are dramatically better when grounded in the actual shipped code, the consuming repo's doc conventions, and the rest of the decisions inbox. Do not try to do this analysis from your own context: you will skim, you will guess, and recommendations will be soft. Delegate it to subagents, and run them in parallel so the human's interactive window in Phase 3 is not gated on slow exploration.

### How to launch

**Launch one Explore subagent per log, all in parallel.** Issue a single assistant message containing N `Agent` tool calls, one per decision log. Do NOT spawn them sequentially. This is the entire point of the phase.

If the inbox holds more than 10 logs, batch in groups of 10 (still parallel within each group). Wait for one group to finish before launching the next.

**Subagent type:** in Claude Code use `subagent_type: "Explore"` with thoroughness "medium". On other platforms use the equivalent codebase-exploration agent.

### Subagent prompt template

Fill in the bracketed parts for each log before launching:

```
You are investigating ONE decision log from a ninthwave-managed repo so a human can decide what to do with it. Read whatever you need (shipped code, git log, the consuming repo's docs, other decision logs, open work items) to give a grounded recommendation AND draft the concrete artifact that would be applied if the human approves.

Decision log path: [path]
Decision log contents (verbatim):
[paste the entire file body]

You are running in an unknown repo. Do NOT assume any paths outside `.ninthwave/`. Discover the consuming repo's doc and ADR conventions before recommending anything.

Investigate and report back, in this exact section order:

1. WHAT SHIPPED
   Run `git log --all --grep=<item id>` and any related searches to find the work item's PR or merge commits. Read the actual diff. Confirm the decision text matches what shipped: does the named field, function, file, or behavior actually exist as described? State explicitly: matches / partial match / mismatch / unclear, and cite the SHA you read.

2. REPO DOC SURVEY
   Glob the repo to discover its doc and ADR conventions. Do NOT hardcode paths; check what is actually present. Look for:
     - prose doc directories: `docs/`, `documentation/`, `doc/`, `architecture/`
     - ADR conventions: `adr/`, `**/adr/`, `**/decisions/`, `**/architecture-decisions/`
     - root docs: `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `ETHOS.md`, `VISION.md`
     - agent / skill prompt directories: `agents/`, `skills/`, `.claude/`, `.codex/`
   Report a short bullet list:
     - Where prose docs live (path, organizing pattern: guide / how-to / reference)
     - Whether an ADR directory already exists (path + filename convention) or "none"
     - Whether agent or skill prompts exist (paths) or "none"
     - Which root principles file (if any) future workers actually read
   This survey is what every later step depends on. Do not skip it.

3. IS IT ENCODED ANYWHERE?
   Using the doc survey from step 2, grep the discovered locations for evidence that THIS specific decision is already expressed in tests, types, docs, skill, or agent prompt. Cite file:line for any match. If nothing encodes it, say so explicitly: this is the strongest signal that CODIFY or RECORD_ADR is the right call.

4. DID IT STICK?
   `git log` since the decision's `date` field for commits that touch the same area. Detect silent drift where a later change partly reversed the decision. State explicitly: stuck / drifted (cite SHA) / unclear.

5. RELATED DECISIONS
   Look at the other files in `.ninthwave/decisions/` for logs that overlap this one. Two workers independently choosing X and Y for the same ambiguity is a real pattern. List filename and a one-line reason for the overlap. If none, say "none".

6. TENSION WITH STATED PRINCIPLES
   If the doc survey found a principles file, read the sections that touch this area and flag contradictions explicitly. If no principles file exists, say so.

7. RECOMMENDATION
   Pick exactly one tag and give a one-sentence reason that references the investigation, not the log text:
     RATIFY      -- sound, already reflected in code, no institutional value worth preserving, delete log
     RECORD_ADR  -- sound AND worth preserving as a permanent architectural record
     CODIFY      -- promote into an existing project doc / agent prompt / skill so future workers follow the rule
     FOLLOWUP    -- create a work item that captures the tradeoff, owner, and missing guardrails
     REVISE      -- decision is wrong or stale; create a work item to reverse or adjust it
     MERGE_INTO  -- duplicate of another decision log; name which one

8. DRAFT THE ARTIFACT
   Produce the concrete thing that would be applied if the human approves your recommendation. Do not write any files; include the artifact inline in your report so the skill can apply it later.

   - RATIFY: a one-line receipt naming the commit SHA that already implements the decision (or the revert SHA that made it moot).
   - RECORD_ADR: the full ADR file body and proposed path. If the doc survey found an existing ADR directory, follow its filename and template conventions. If not, propose a path under the discovered docs root (e.g. `<docs root>/adr/NNNN-<slug>.md`) with a minimal Context / Decision / Consequences template, and call out in your recommendation that this is the repo's first ADR so the human knows they are bootstrapping a convention.
   - CODIFY: the exact discovered file path and a before/after edit, ready for the Edit tool. Show enough surrounding context that `old_string` will be unique. Use fenced code blocks labeled `BEFORE` and `AFTER`. Do not propose an edit to a file you have not opened in this report.
   - FOLLOWUP: the full work item file. Filename in the form `{priority_num}-{domain_slug}--{ID}.md`. Body following `.ninthwave/work-item-format.md` exactly. Acceptance criteria must explicitly include the question: "What evidence or constraint is still missing before this should be treated as settled?" Leave the lineage token as the literal string `<LINEAGE>`; the skill will fill it in.
   - REVISE: same as FOLLOWUP but framed as a reversal. Quote the original decision's filename and `decision:` line in the work item body so the reversal is anchored.
   - MERGE_INTO: the target log filename and a one-line note on what distinct context to append.

Be concrete, not vague. No prose paragraphs, no hedging. Cap your report at 500 words including the artifact.
```

### After all subagents return

Build a triage table in your working notes, indexed by log path. One entry per log:

```
{
  <log_path>: {
    assessment: <synthesized block, see below>,
    rec: <RATIFY | RECORD_ADR | CODIFY | FOLLOWUP | REVISE | MERGE_INTO>,
    draft: <the concrete artifact from section 8, kept verbatim>,
    full_report: <the subagent's full response, retained for fallbacks>
  }
}
```

Synthesized assessment block format:

```
Decision M of N: <filename>
Item: <item id>   Date: <date>
Summary: <fields.summary in one line>
What shipped: <matches | partial | mismatch | unclear> (<SHA>)
Repo doc home: <discovered docs root | none>   ADR convention: <found path | none>
Encoded anywhere?: <file:line | nowhere>
Drift since?: <SHA | no | unclear>
Tension with principles: <file + snippet | none>
Subagent rec: <RATIFY | RECORD_ADR | CODIFY | FOLLOWUP | REVISE | MERGE_INTO> -- <one-line reason>
```

The triage table is the only state Phase 3 and Phase 4 share. Carry it across both phases without dropping anything.

---

## Phase 3: DECIDE (quick interactive walk-through)

**Goal:** Collect every decision, fast. Do not execute anything.

Walk the triage table in FIFO order. For each log, in order:

1. **Print** the assessment block (so the human has the grounded context on screen above the question).
2. **Call AskUserQuestion ONCE.** No follow-ups. No "are you sure". No inner confirmation loops.
3. **Mark the subagent's recommendation** as `(Recommended)` and put it first in the option list (per the AskUserQuestion convention).
4. **Use the `preview` field** on the recommended option to show the proposed artifact: the ADR body, the work item draft, the before/after diff, the receipt, etc. AskUserQuestion renders previews as monospace markdown blocks beside the option list, so the human can read what will happen if they approve without leaving the question.
5. **Record** the user's choice in the triage table under a new `decision` key. Move to the next log immediately.

If the user picks an option the subagent did NOT draft for (e.g. the user picks E when the subagent recommended A), record the choice anyway. Phase 4 will draft inline using the investigation context from `full_report`.

### Question shape

Every Phase 3 question follows the same structure (re-grounding the user each time, since they may have lost focus mid-walk-through):

> **Question:** "Project: `<repo>`. Branch: `<current>`. Phase: decision-triage decide, decision M of N (`<filename>`). The decision: `<one-sentence paraphrase of summary + decision>`. The investigation found: `<one-line on whether the shipped code matches>` | `<one-line on whether anything encodes the rule>` | `<one-line on drift, duplicates, or principle tension if any>`. I would pick `<X>` because `<reason that references the investigation>`. What should we do with this log?"

### Conceptual option set

The skill reasons about seven options, but only four go into each AskUserQuestion call (see "Dynamic option selection" below).

- **A) Ratify (delete)** -- decision is sound, already reflected in merged code, no institutional value worth preserving. Preview: the commit SHA receipt.
- **B) Record as ADR** -- sound AND worth preserving as a permanent architectural record. Preview: the full ADR body + proposed path. If the consuming repo has no ADR convention yet, the preview flags that the human is bootstrapping one.
- **C) Codify into existing doc** -- promote into a project doc / agent prompt / skill / guide that already encodes rules in this repo. Preview: drafted BEFORE/AFTER edit against a discovered file. Indicate scale (tiny / small / medium).
- **D) Create follow-up work item** -- capture the missing guardrail, tradeoff, or owner. Preview: full work item body. Acceptance criteria includes the question "What evidence or constraint is still missing before this should be treated as settled?"
- **E) Revise (reversal work item)** -- the decision was wrong or stale; create a work item framed as a reversal with the original decision quoted. Preview: full work item body.
- **F) Merge into another decision** -- duplicate of another log; append distinct context, delete this log. Only offered when the subagent flagged a real duplicate.
- **G) Skip** -- leave in place and move on. Use sparingly: the point of this session is to drive the inbox to zero.

### Dynamic option selection

`AskUserQuestion` allows four explicit options plus an automatic "Other" free-text field. Pick the four most relevant for each decision:

1. Always include **A) Ratify** and **D) Follow-up work item**. These are the two most common outcomes and need to be one click away.
2. Slot 3 is the subagent's recommendation if it is not already A or D (so B / C / E / F whichever was picked).
3. Slot 4 is the next most plausible alternative based on the assessment block. Heuristics: if the rec is RECORD_ADR, slot 4 is usually CODIFY; if the rec is CODIFY, slot 4 is usually RECORD_ADR; if the rec is REVISE, slot 4 is usually FOLLOWUP; if the rec is MERGE_INTO, slot 4 is usually RATIFY; if the rec is RATIFY or FOLLOWUP, slot 4 is usually whichever of B / C the doc survey suggests is most natural.
4. The recommended option is marked `(Recommended)` and listed first.
5. **G) Skip** and any unlisted option are reachable through "Other" with a short text instruction; Phase 4 honors them.

The whole point of Phase 3 is speed: read assessment, click option, next. If the human wants to steer a draft, they pick "Other" with notes and Phase 4 honors them.

---

## Phase 4: EXECUTE (batch)

**Goal:** Apply every recorded decision. The human's input window is closed; do not call AskUserQuestion in this phase.

Walk the triage table in FIFO order. For each entry, look at the recorded `decision` and apply it.

### Decision handlers

**A) Ratify:**
1. Print the one-line receipt from `draft` so the user has the trail (commit SHA that implements or reverts the decision).
2. Delete the decision log (see "After each handler" below).

**B) Record as ADR:**
1. Use the pre-drafted ADR body from `draft`. Write it to the proposed path (which the subagent already validated against the discovered ADR convention, or proposed as a bootstrap if none existed).
2. If the user picked B but the subagent did not draft an ADR (because it recommended something else), draft one inline from `full_report` using the same Context / Decision / Consequences template, against a path consistent with the doc survey in `full_report`. Do not invent a docs directory the survey did not find; if the survey found nothing, fall back to `docs/adr/NNNN-<slug>.md` and tell the human in the progress line that this bootstraps a new convention.
3. Print the new ADR path.
4. Delete the decision log.

**C) Codify into existing doc:**
1. Use the pre-drafted edit from `draft`. Open the file (which the subagent already opened and quoted), locate the BEFORE block, apply the AFTER block via the Edit tool.
2. If the user overrode the subagent's recommendation and there is no pre-drafted edit, draft one inline from `full_report` against a file the subagent's doc survey already named. Do not edit a file that was not surfaced in the survey.
3. Print a 3-5 line summary of what changed and which file.
4. Delete the decision log.

**D) Follow-up:**
1. Generate a lineage token:
   ```bash
   nw lineage-token
   ```
2. Substitute it for the `<LINEAGE>` placeholder in the drafted work item body.
3. Write the file to `.ninthwave/work/{priority_num}-{domain_slug}--{ID}.md`.
4. Print the new ID and path.
5. If the user picked D without a pre-drafted work item (because the subagent recommended something else), draft one inline from `full_report` using the same fields as the standard subagent template, then write. The acceptance criteria must include: "What evidence or constraint is still missing before this should be treated as settled?"
6. Delete the decision log.

**E) Revise:**
1. Same flow as D, but the work item body is framed as a reversal. Quote the original decision log's filename and `decision:` line in the body so the reversal is anchored to the choice it overturns.
2. Delete the decision log.

**F) Merge into <other decision>:**
1. Read the target decision log named in `draft`.
2. Append a `---` divider and the distinct context from the current log (do not duplicate fields that already match).
3. Use Edit to write the appended content.
4. Delete the current decision log (the target stays).

**G) Skip:**
1. Leave the log in place. Do nothing.

### After each handler

For decisions A, B, C, D, E, F, delete the decision log:

```bash
rm <log_path>
```

For G, do not delete.

Print one line per log as it is handled: "Decision M of N done: `<choice>` -- `<one-line outcome>`. `<remaining>` to go."

---

## Phase 5: WRAP

When the loop finishes, summarize the session:

1. Counts: "Triaged N decisions. Ratified: X. Recorded as ADR: Y. Codified: Z. Follow-ups: A. Revisions: B. Merged: C. Skipped: D."
2. List any new work items by ID.
3. List any new ADR files by path.
4. List any files edited.
5. Run `git status` and show the user the staged/unstaged changes.
6. **Do NOT commit.** Tell the user the suggested commit command and let them decide:
   ```
   Suggested next step:
     git add -A && git commit -m "chore: triage decisions"
   I will not run this for you. Commits are your call.
   ```

---

## Why this skill exists (background for the worker reading this)

Decision logs accumulate during heavy dogfooding: every time a worker has to make a material architectural, product, or testing call that the work item did not specify, the worker writes one. They are the sibling of friction logs in the ninthwave inbox model: friction is the dogfooding signal, decisions are the institutional memory of what got chosen and why. The async path (`nw review-inbox decisions`) exists for weekly hygiene, but it is bad for clearing twenty logs in one sitting.

The leverage of this skill is in promoting the important decisions into durable form before they are lost: an ADR for the ones future contributors will need to understand the "why" of, a doc or prompt edit for the ones future workers will need to follow as a rule, and a follow-up work item for the ones that exposed a missing guardrail. Ratifying the trivial ones quickly is what makes room to spend real attention on the load-bearing ones. The skill's job is to keep that loop tight: parallel investigation with per-repo doc discovery, no nested confirmations, no waiting for subagents during the Decide phase, no commits without permission.
