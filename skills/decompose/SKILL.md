---
name: decompose
description: |
  Decompose a feature spec into work items for orchestration via `nw`.
  Takes a PRD, phase doc, or verbal description and breaks it into human-reviewable
  PR-sized work items with dependencies mapped into batches.
  Use when asked to "decompose", "break down this feature", "create work items for",
  or "plan the work items".
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

This skill decomposes a feature spec into work items sized for individual human-reviewable PRs. Each item is written as an individual file in `.ninthwave/work/`, ready for orchestration via `nw`.

Treat `.ninthwave/work/` as the live queue of open work: `/decompose` populates it, `nw` works through it, and completed work is intentionally looked up through merged PRs, `nw history`, `nw logs`, and git history rather than retained in a `done` lane.

**Prerequisites:** `ninthwave` (or `nw`) must be in PATH. `.ninthwave/work/` directory must exist.

---

### Phase 1: INTAKE

**Goal:** Identify and understand the feature to decompose.

1. The user may provide:
   - A file path to a spec/PRD/phase doc
   - A reference to a project doc
   - A verbal description of the feature

2. If a file path or doc reference is provided, read it.

3. If the description is verbal/ambiguous, AskUserQuestion to clarify scope.

4. Summarize the feature scope in 3-5 bullet points and confirm with the user.

5. Assign a **feature code** for work item IDs. Derive from the feature name (e.g., "User Onboarding" -> `UO`, "Search & Filters" -> `SF`). Keep it 2-4 uppercase alphanumeric characters.

---

### Phase 2: EXPLORE

**Goal:** Understand what exists vs what needs to be built.

1. Launch 1-3 Explore agents to investigate:
   - Existing implementations
   - Adjacent patterns
   - Schema/data state

2. Compile a **delta summary**:
   - "Exists:" -- what's already built
   - "Needs:" -- what must be added/changed
   - "Patterns to follow:" -- existing code to model after

3. Assess rollout sensitivity. Only AskUserQuestion about feature flags or kill switches when the work is rollout-sensitive, for example:
   - risky user-facing behavior
   - external integrations or third-party dependencies
   - migrations or behavior switches that may need a fast rollback path
   - specs that explicitly mention staged rollout, canaries, or kill switches
   - repos that already show a local flag-like pattern

   Do **not** ask this for routine refactors, isolated bug fixes, or straightforward additions with low rollout risk.

   When you do ask:
   - recommend **no flag** by default unless staged rollout or fast disablement would materially reduce risk
   - offer options to ship unflagged, add a narrow feature flag / kill switch for this feature, or defer the decision
   - if the user chooses a flag, decompose only the minimum feature-local flag work; do not invent a repo-wide flag framework

4. Present the delta summary to the user.

---

### Phase 3: ARCHITECT (Optional)

**Goal:** Validate architecture before decomposing.

AskUserQuestion -- run an architecture review first?

If yes and the project has an eng review skill, run it with the spec and delta summary.

---

### Phase 4: DECOMPOSE

**Goal:** Break the feature into work items.

#### Sizing guidelines

Each work item should target one human-reviewable PR:
- **~200-400 lines** of meaningful change
- **Independently testable**
- **Single concern**
- **Clear file scope**
- **Clear acceptance criteria**

#### Decomposition strategy

Work from the bottom of the stack up:

1. **Migrations/Schema** -- database changes first
2. **Backend context functions** -- business logic
3. **Backend controllers/routes** -- API endpoints
4. **Service integrations** -- external services, AI tools, etc.
5. **Frontend hooks** -- data layer
6. **Frontend components** -- UI
7. **Integration/polish** -- wiring and final touches

#### Manual review override

When a work item is unusually sensitive or risky, include:

```markdown
**Requires manual review:** true
```

Use this for auth and permission-boundary changes, secrets handling, destructive production operations, or high-risk data migrations. Omit the field for normal items. Do not write `false`.

#### Test plan (REQUIRED)

Every work item MUST include a `**Test plan:**` field. This is not optional -- workers use it as a testing checklist during implementation.

Each test plan specifies:
- **What tests** to write or verify (new tests vs. existing coverage)
- **Key code paths** that must be covered
- **Edge cases** specific to this item

**Specificity rule:** Test plans must be specific to each item's implementation, not generic boilerplate. Reference the actual functions, modules, or behaviors the item touches. A good test plan reads like instructions a developer could follow without re-reading the description.

**Non-testable items** (docs-only, config changes): Use `**Test plan:**\n- Manual review` instead of omitting the field.

Keep test plans concise -- 2-4 bullet points per item.

#### Dependency mapping

Group work items into **batches**. Items within a batch can run in parallel. Batches run sequentially. **Stacking:** items with **exactly one** in-flight dependency can launch early -- the orchestrator creates their worktree from the dependency's branch and rebases automatically after merge. Items with multiple in-flight deps (fan-in) cannot stack and must wait for all deps to merge. This means dependency chains execute faster than strict batch ordering suggests, so prefer clear dependency declarations over artificially flattening items into a single batch.

#### Dependency shape trade-offs

The orchestrator stacks launches when a queued item has **exactly one** in-flight dependency. It cannot stack on multiple in-flight deps. This shapes how you should decompose:

- **Linear chain** (A -> B -> C, each depending on the previous): best for autonomous delivery. Each item stacks on the previous one's branch and launches immediately, even before review. A batch decomposed as a chain runs hands-off end-to-end in manual-merge mode.
- **Batch-parallel** (A, B, C all depending on nothing, or on the same merged prerequisite): also fine. All items launch simultaneously; no stacking needed.
- **Diamond / fan-in** (C depends on A *and* B, both in-flight): **avoid in manual-merge mode.** C will not launch until both A and B merge, which requires human review. The tail of the batch stalls in the queue.

**Decomposition preference (manual-merge mode):** when you have a choice between "three items in parallel, then one fan-in" vs "four items in a linear chain," prefer the chain. You trade a bit of wall-clock parallelism for full autonomous execution. Only introduce a fan-in when the work truly cannot be linearized (e.g., the fan-in item inspects behavior that only emerges when all branches are combined).

**If a diamond is unavoidable:** call it out explicitly in the decomposition output, e.g. `H-X-3: depends on [H-X-1, H-X-2] (fan-in -- will wait for manual merge)`, so the operator knows the tail will need their attention.

#### ID assignment

Format: `[CHML]-<feature_code>-<seq>`

- **C** (Critical), **H** (High), **M** (Medium), **L** (Low)
- Feature code from Phase 1
- Incrementing sequence

---

### Phase 5: REVIEW

**Goal:** Get user approval.

Present the decomposition as a table:

| Batch | ID | Title | Scope | Test Plan | Key Files | Depends On |
|-------|-----|-------|-------|-----------|-----------|------------|

Show totals and ask for approval. Options: looks good, adjust, re-decompose.

---

### Phase 6: WRITE

**Goal:** Write each work item as an individual file in `.ninthwave/work/`.

1. Ensure the directory exists: `mkdir -p .ninthwave/work`
2. Read the canonical format guide: `cat .ninthwave/work-item-format.md`. If the file is missing, tell the user to run `nw init` before continuing -- that command copies the guide into the repo.
3. For each new work item, run `nw lineage-token` exactly once and store the result in that item's `**Lineage:**` field. Never invent, derive, or freeform-generate the token.
4. Write each work item as a separate file. The filename convention is:

   ```
   {priority_num}-{domain_slug}--{ID}.md
   ```

   Where `priority_num` is: Critical=1, High=2, Medium=3, Low=4.
   And `domain_slug` is the domain name in kebab-case (e.g., `worker-reliability`, `cli-ux`).

   Example: `2-worker-reliability--H-WRK-3.md`

5. Each file uses this template:

```markdown
# <Type>: <Title> (<ID>)

**Priority:** <Critical|High|Medium|Low>
**Source:** <origin>
**Depends on:** <IDs or None>
**Domain:** <domain name>
**Lineage:** <token from `nw lineage-token`>
**Requires manual review:** true   <!-- optional; include only for sensitive/high-risk items -->

<Description -- 2-4 sentences.>

**Test plan:**
- <what tests to write or verify for this specific item>
- <key code paths to cover>
- <edge cases specific to this item>

Acceptance: <concrete, verifiable conditions>

Key files: `path/to/file.ts`, `path/to/other.ex`
```

   Note: The heading uses `# ` (not `### `). The `**Domain:**` field is required and must be explicit in each file.

6. Verify every item has both a `**Lineage:**` field and a `**Test plan:**` section
7. Verify parseable: `ls .ninthwave/work/` to confirm files were written, then `ninthwave list | grep <feature_code>`
8. Commit and push the new work files so they are available to workers (which clone from remote):

   ```bash
   git add .ninthwave/work/
   if ! git diff --cached --quiet; then
     git commit -m "chore: add <feature_code> work items from decompose"
     git push
   fi
   ```

---

### Phase 7: HANDOFF

Present summary and connect to `nw` for orchestration.

Explicitly remind the user that the files you just wrote are now the live queue. The next step is to run `nw`, which works through `.ninthwave/work/`. When items finish, their files disappear from that directory on purpose; use merged PRs, `nw history`, `nw logs`, and git history for retrospective lookup.

---

## Important Rules

- **ASCII only:** work files must use only ASCII characters. Use `--` instead of em dashes, `-` instead of en dashes, `"` instead of smart quotes, `...` instead of ellipsis. Non-ASCII characters break `$'...'` shell quoting when the prompt is sent to workers via multiplexers (tmux/zellij).
- **Spec fidelity:** Every requirement must map to at least one work item
- **No implementation:** This skill only plans and writes work items
- **PR size discipline:** Split work items > ~500 LOC, combine < ~50 LOC
- **File conflict awareness:** Items in the same batch should not modify the same files
- **No VERSION/CHANGELOG:** work items should not mention modifying these files
- **Idempotent:** Check `.ninthwave/work/` for existing files with the same ID before writing duplicates
