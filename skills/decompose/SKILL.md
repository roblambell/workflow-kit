---
name: decompose
description: |
  Decompose a feature spec into work items for batch processing via /work.
  Takes a PRD, phase doc, or verbal description and breaks it into human-reviewable
  PR-sized work items with dependencies mapped into batches.
  Use when asked to "decompose", "break down this feature", "create todos for",
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

This skill decomposes a feature spec into work items sized for individual human-reviewable PRs. The items are written to `TODOS.md` in a format compatible with `.ninthwave/work`, ready for processing via `/work`.

**Prerequisites:** `.ninthwave/work` must exist and be executable. `TODOS.md` must exist at the project root.

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

5. Assign a **feature code** for TODO IDs. Derive from the feature name (e.g., "User Onboarding" -> `UO`, "Search & Filters" -> `SF`). Keep it 2-4 uppercase alphanumeric characters.

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

3. Present the delta summary to the user.

---

### Phase 3: ARCHITECT (Optional)

**Goal:** Validate architecture before decomposing.

AskUserQuestion -- run an architecture review first?

If yes and the project has an eng review skill, run it with the spec and delta summary.

---

### Phase 4: DECOMPOSE

**Goal:** Break the feature into TODO items.

#### Sizing guidelines

Each TODO should target one human-reviewable PR:
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

#### Dependency mapping

Group TODOs into **batches**. Items within a batch can run in parallel. Batches run sequentially.

#### ID assignment

Format: `[CHML]-<feature_code>-<seq>`

- **C** (Critical), **H** (High), **M** (Medium), **L** (Low)
- Feature code from Phase 1
- Incrementing sequence

---

### Phase 5: REVIEW

**Goal:** Get user approval.

Present the decomposition as a table:

| Batch | ID | Title | Scope | Key Files | Depends On |
|-------|-----|-------|-------|-----------|------------|

Show totals and ask for approval. Options: looks good, adjust, re-decompose.

---

### Phase 6: WRITE

**Goal:** Add the TODOs to TODOS.md.

1. Read current TODOS.md
2. Add section: `## <Feature Name> (feature decomposition, <YYYY-MM-DD>)`
3. Write each TODO following the format guide. Read it with: `cat "$(cat .ninthwave/dir)/core/docs/todos-format.md"`
4. Verify parseable: `.ninthwave/work list | grep <feature_code>`

---

### Phase 7: HANDOFF

Present summary and connect to `/work` for processing.

---

## Important Rules

- **Spec fidelity:** Every requirement must map to at least one TODO
- **No implementation:** This skill only plans and writes TODOs
- **PR size discipline:** Split TODOs > ~500 LOC, combine < ~50 LOC
- **File conflict awareness:** Items in the same batch should not modify the same files
- **No VERSION/CHANGELOG:** TODOs should not mention modifying these files
- **Idempotent:** Check for existing TODOs before writing duplicates
