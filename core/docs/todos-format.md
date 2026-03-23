# TODOS.md Format Guide

Canonical reference for the `TODOS.md` format. Used by `/decompose` (feature decomposition) and ad-hoc TODO creation. Parsed by `.ninthwave/work` (the ninthwave CLI).

## Empty Template

When `TODOS.md` is cleared down, it should contain:

```markdown
# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->
```

## Section Headers

Level 2 headers group TODOs by domain or feature:

```markdown
## <Section Name> (<source>, <YYYY-MM-DD>)
```

Examples:
- `## User Onboarding (feature decomposition, 2026-03-22)`
- `## Cloud Infrastructure`
- `## Frontend: Search & Filters`

The section name is normalised by `batch-todos.sh` into a domain slug for filtering (`--domain`).

## Item Format

```markdown
### <Type>: <Title> (<ID>)

**Priority:** <Critical|High|Medium|Low>
**Source:** <origin description>
**Depends on:** <ID(s) comma-separated, or "None">

<Description -- 2-4 sentences explaining what to build/fix and key decisions.>

Acceptance: <Conditions that make this TODO "done". Concrete, verifiable statements. Each condition should be testable -- either by automated tests or manual verification.>

Key files: `path/to/file.ex`, `path/to/component.tsx:42`

---
```

### Required Fields

| Field | Location | Format |
|-------|----------|--------|
| Type | Item header | One of: `Migration`, `Feat`, `Refactor`, `Test`, `Docs`, `Fix` |
| Title | Item header | Short descriptive title |
| ID | Item header (parenthetical) | `[CHML]-<feature_code>-<seq>` |
| Priority | Metadata line | `Critical`, `High`, `Medium`, or `Low` |
| Source | Metadata line | Free text describing origin |
| Depends on | Metadata line | Comma-separated IDs or `None` |
| Description | Body | 2-4 sentences explaining what to build and key decisions |
| Acceptance | Body | Concrete, verifiable conditions for "done" |

### Optional Fields

| Field | Location | Format |
|-------|----------|--------|
| Bundle with | Metadata line | `**Bundle with:** <ID>` |
| Key files | Body | Backtick-quoted paths, `file:line` references |

### Writing Good Acceptance Criteria

Acceptance criteria define WHEN the TODO is done, not WHAT to build (that's the description).

**Good criteria are:**
- **Verifiable** -- can be checked by running a test, a command, or inspecting output
- **Specific** -- name the exact behaviour, not vague qualities ("handles errors" is bad; "returns 401 with TOKEN_EXPIRED code on expired JWT" is good)
- **Complete** -- cover happy path, key edge cases, and failure modes relevant to the TODO

**Example:**
```
Acceptance: `npx cap sync` completes without errors. Adapter correctly stores/retrieves/clears
refresh tokens via Preferences. Platform detection switches adapters correctly. CapacitorHttp
enabled. Tests pass for all paths.
```

### Separator

`---` between items. Visual only -- not required for parsing, but keeps the file scannable.

## ID Scheme

Format: `[CHML]-<feature_code>-<seq>`

**Priority letter** (first character):
- `C` -- Critical (blocking migrations, core schema)
- `H` -- High (actively built features)
- `M` -- Medium (nice-to-have, could defer)
- `L` -- Low (cosmetic, lowest priority)

**Feature code** (2-4 uppercase alphanumeric):
- Derived from the section/feature name
- Examples: `UO` (User Onboarding), `CI` (Cloud Infrastructure), `SF` (Search & Filters)

**Sequence**: Incrementing integer starting at 1.

Examples: `C-UO-1`, `H-UO-3`, `M-CI-1`, `L-SF-2`

## Sizing Guidelines

Each TODO should target one human-reviewable PR:
- ~200-400 lines of meaningful change (not counting test boilerplate)
- Independently testable -- tests pass for just this item
- Single concern -- one migration, one controller extension, one component
- Clear file scope -- list the key files the TODO will touch

## Parsing Rules

`batch-todos.sh` extracts these fields via regex:
- **ID**: from parenthetical in `### ` header, pattern `([A-Z]-[A-Za-z0-9]+-[0-9]+)`
- **Priority**: from `**Priority:**` line, converted to lowercase
- **Depends on**: from `**Depends on:**` line, comma/space-separated IDs
- **Bundle with**: from `**Bundle with:**` line (optional)
- **Domain**: from the `## ` section header, auto-slugified
- **File paths**: from backtick-quoted paths and `file:line` patterns in the body

Things that break parsing:
- Missing ID in the `### ` header
- ID format that doesn't match `[A-Z]-[A-Za-z0-9]+-[0-9]+`
- Missing `**Priority:**` line

## Complete Example

```markdown
## Cloud Infrastructure

### Feat: Upgrade test CI runners from 2 to 4 vCPUs (M-CI-1)

**Priority:** Medium
**Source:** Manual request 2026-03-22
**Depends on:** None

All test workflow runners currently use 2 vCPU Blacksmith instances. Upgrade to 4 vCPU for faster test execution. Keep deploy workflows on 2 vCPU. Each workflow stays on its current platform (ARM or x86).

Acceptance: Test workflows (test-api, test-web, ci) use 4 vCPU runners. Deploy workflows remain on 2 vCPU. All CI pipelines pass on the new runner size. No platform changes (ARM stays ARM, x86 stays x86).

Key files: `.github/workflows/test-api.yml`, `.github/workflows/test-web.yml`, `.github/workflows/ci.yml`

---
```
