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

This skill decomposes a feature spec into work items sized for individual human-reviewable PRs. Each item is written as an individual file in `.ninthwave/todos/`, ready for processing via `/work`.

**Prerequisites:** `.ninthwave/work` must exist and be executable. `.ninthwave/todos/` directory must exist.

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

5. If the hub repo has context about other repos (via agent instructions, `.ninthwave/repos.conf`, or project docs), consider which repo each piece of work targets. Features may span multiple repos.

6. Assign a **feature code** for TODO IDs. Derive from the feature name (e.g., "User Onboarding" -> `UO`, "Search & Filters" -> `SF`). Keep it 2-4 uppercase alphanumeric characters.

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

3. **Check decomposition templates.** Load templates from the `templates/` directory in the ninthwave bundle (resolve via `core/templates.ts`). Match the feature description against available templates using keyword scoring. If a template matches:
   - Present it to the user as a suggested starting structure
   - Show the template's typical breakdown and dependency graph
   - Explain that the template is advisory — the actual decomposition can deviate based on codebase analysis
   - AskUserQuestion: "Use this template as a starting point, modify it, or skip?"

   Templates are **not prescriptive** — they improve consistency for common patterns while preserving flexibility for unique features. If no template matches (or the user skips), proceed with freeform decomposition.

4. Present the delta summary to the user.

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

#### Target repo

When a TODO targets a repo other than the hub repo, include the `**Repo:** <alias>` metadata field. Omit the field for items that target the hub repo itself.

#### Test plan (REQUIRED)

Every TODO MUST include a `**Test plan:**` field. This is not optional — workers use it as a testing checklist during implementation.

Each test plan specifies:
- **What tests** to write or verify (new tests vs. existing coverage)
- **Key code paths** that must be covered
- **Edge cases** specific to this item

**Specificity rule:** Test plans must be specific to each item's implementation, not generic boilerplate. Reference the actual functions, modules, or behaviors the item touches. A good test plan reads like instructions a developer could follow without re-reading the description.

**Non-testable items** (docs-only, config changes): Use `**Test plan:**\n- Manual review` instead of omitting the field.

Keep test plans concise — 2-4 bullet points per item.

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

| Batch | ID | Title | Scope | Test Plan | Key Files | Depends On |
|-------|-----|-------|-------|-----------|-----------|------------|

Show totals and ask for approval. Options: looks good, adjust, re-decompose.

---

### Phase 6: WRITE

**Goal:** Write each TODO as an individual file in `.ninthwave/todos/`.

1. Ensure the directory exists: `mkdir -p .ninthwave/todos`
2. Read the format guide: `cat "$(cat .ninthwave/dir)/core/docs/todos-format.md"`
3. Write each TODO as a separate file. The filename convention is:

   ```
   {priority_num}-{domain_slug}--{ID}.md
   ```

   Where `priority_num` is: Critical=1, High=2, Medium=3, Low=4.
   And `domain_slug` is the domain name in kebab-case (e.g., `worker-reliability`, `cli-ux`).

   Example: `2-worker-reliability--H-WRK-3.md`

4. Each file uses this template:

```markdown
# <Type>: <Title> (<ID>)

**Priority:** <Critical|High|Medium|Low>
**Source:** <origin>
**Depends on:** <IDs or None>
**Domain:** <domain name>

<Description — 2-4 sentences.>

**Test plan:**
- <what tests to write or verify for this specific item>
- <key code paths to cover>
- <edge cases specific to this item>

Acceptance: <concrete, verifiable conditions>

Key files: `path/to/file.ts`, `path/to/other.ex`
```

   Note: The heading uses `# ` (not `### `). The `**Domain:**` field is required — it was previously inferred from TODOS.md section headers but must now be explicit in each file.

5. Verify every item has a `**Test plan:**` section (non-optional for decomposed items)
6. Verify parseable: `ls .ninthwave/todos/` to confirm files were written, then `.ninthwave/work list | grep <feature_code>`

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
- **Idempotent:** Check `.ninthwave/todos/` for existing files with the same ID before writing duplicates
