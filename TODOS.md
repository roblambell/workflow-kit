# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Parser Fixes (dogfood friction, 2026-03-23)

### Fix: Strip parenthetical annotations from domain slugs (M-FIX-1)

**Priority:** Medium
**Source:** Dogfood friction log #4
**Depends on:** None

`normalizeDomain` produces excessively long slugs when section headers contain parenthetical content like `## CLI Migration (TypeScript migration completion, 2026-03-23)` → `cli-migration-typescript-migration-completion-2026-03-23`. The parser already strips `(from ...)` at the caller (parser.ts line 218) but not generic parentheticals. Fix: strip all `(...)` content from the section name before passing to `normalizeDomain`, or inside `normalizeDomain` itself. Subsumes the existing `(from ...)` special case.

Acceptance: `normalizeDomain("CLI Migration (TypeScript migration completion, 2026-03-23)")` returns `"cli-migration"`. `normalizeDomain("API Service (v2 rewrite)")` returns `"api-service"`. Existing tests pass. New test cases for parenthetical stripping added.

Key files: `core/parser.ts:18`, `core/parser.ts:216`, `test/parser.test.ts`

---

### Fix: Restrict file path extraction to Key files lines (M-FIX-2)

**Priority:** Medium
**Source:** Dogfood friction log #5
**Depends on:** None

`extractFilePaths` in `core/parser.ts` scans the entire `rawText` of a TODO item for file paths. This causes false positives in `conflicts` when description or acceptance text mentions paths incidentally (e.g., "invokes `core/cli.ts`"). The `Key files:` convention already exists — restrict path extraction to only lines starting with `Key files:` so that description-mentioned paths don't pollute conflict detection.

Acceptance: A TODO with `core/cli.ts` mentioned only in description (not in `Key files:`) does NOT include it in `filePaths`. A TODO with paths in its `Key files:` line still extracts them correctly. The `conflicts` command no longer flags false positives from description text. All existing tests pass. New test cases added for both scenarios.

Key files: `core/parser.ts:59`, `test/parser.test.ts`, `test/conflicts.test.ts`

---

## Brew Distribution (brew install pivot, 2026-03-23)

### Feat: Add bundle directory resolution module (H-BREW-1)

**Priority:** High
**Source:** Brew distribution pivot
**Depends on:** None

Create `core/paths.ts` with a `getBundleDir()` function that resolves the ninthwave resource directory (skills, agents, docs). Resolution chain: (1) `NINTHWAVE_HOME` env var, (2) binary install prefix — if `process.argv[0]` is at `<prefix>/bin/ninthwave`, check `<prefix>/share/ninthwave/`, (3) development fallback — walk up from source file to find repo root containing `skills/work/SKILL.md`. This replaces the `.ninthwave/dir` mechanism and is the foundation for all subsequent brew work.

Acceptance: `getBundleDir()` returns correct path in dev mode (`bun run core/cli.ts`). Returns correct path when `NINTHWAVE_HOME` is set. Tests cover all three resolution paths. Module is exported and importable.

Key files: `core/paths.ts` (new), `test/paths.test.ts` (new)

---

### Feat: Port setup script to TypeScript CLI command (H-BREW-2)

**Priority:** High
**Source:** Brew distribution pivot
**Depends on:** H-BREW-1

Create `core/commands/setup.ts` that replaces the bash `setup` script. Wire it as `ninthwave setup` in `cli.ts`. Two modes: `ninthwave setup` (project — seeds `.ninthwave/`, TODOS.md, skill symlinks, agent copies, .gitignore) and `ninthwave setup --global` (user — seeds `~/.claude/skills/` symlinks only). Uses `getBundleDir()` from `core/paths.ts` to resolve skill/agent source paths. Also add `ninthwave version` command that reads VERSION from bundle dir. Update `cli.ts` to support commands that don't need a project root (`setup`, `version`).

Acceptance: `bun run core/cli.ts setup` in a git repo creates the same artifacts as the bash `setup` script. `bun run core/cli.ts setup --global` creates skill symlinks in `~/.claude/skills/`. `bun run core/cli.ts version` prints the version. Tests cover project setup, global setup, idempotency (running twice produces same result), and preserving existing config files.

Key files: `core/commands/setup.ts` (new), `core/cli.ts`, `test/setup.test.ts` (new), `setup` (reference for porting)

---

### Feat: Add binary compilation and release pipeline (H-BREW-3)

**Priority:** High
**Source:** Brew distribution pivot
**Depends on:** H-BREW-2

Add `bun build --compile` support. Add build scripts to `package.json` for macOS ARM64, macOS x64, and Linux x64 targets. Create `.github/workflows/release.yml` that triggers on tag push (`v*`), builds binaries, creates a GitHub Release with attached binaries. Add a compile smoke test to CI (`bun build --compile` + `./dist/ninthwave version`). Add `dist/` to `.gitignore`.

Acceptance: `bun run build` produces a working binary at `dist/ninthwave`. The binary runs `ninthwave version`, `ninthwave setup --help`, and `ninthwave list` correctly. CI includes a compile smoke test. Release workflow builds and publishes binaries on tag push.

Key files: `package.json`, `.github/workflows/release.yml` (new), `.github/workflows/ci.yml`, `.gitignore`

---

### Feat: Create Homebrew tap and formula (H-BREW-4)

**Priority:** High
**Source:** Brew distribution pivot
**Depends on:** H-BREW-3
**Repo:** homebrew-tap

Create the `ninthwave-sh/homebrew-tap` repository with a Homebrew formula at `Formula/ninthwave.rb`. The formula downloads the source tarball, compiles via `bun build --compile`, installs the binary to `bin/`, and installs resource files (skills, agents, docs, VERSION) to `share/ninthwave/`. Symlinks should use the Homebrew `opt` prefix for stability across upgrades. Test with `brew install --build-from-source`.

Acceptance: `brew tap ninthwave-sh/tap && brew install ninthwave` installs successfully. `ninthwave version` works after install. `ninthwave setup` in a project creates correct symlinks pointing into the Homebrew share directory.

Key files: `Formula/ninthwave.rb` (new, in homebrew-tap repo)

---

### Refactor: Simplify shim and update upgrade skill for brew (M-BREW-5)

**Priority:** Medium
**Source:** Brew distribution pivot
**Depends on:** H-BREW-2

Update the shim template in `core/commands/setup.ts` to generate `exec ninthwave "$@"` (no bun dependency, no `.ninthwave/dir`). Keep writing `.ninthwave/dir` for backward compatibility with existing skill references. Rewrite `skills/ninthwave-upgrade/SKILL.md` to detect install type: if `brew list ninthwave` succeeds, suggest `brew upgrade ninthwave`; if `.ninthwave/dir` points to a git repo, keep current git-pull behavior. Update TODOS.md template comment to use a URL instead of the `$(cat .ninthwave/dir)` shell expansion.

Acceptance: New projects get the simplified shim. The upgrade skill correctly detects brew vs git installs. TODOS.md template uses a stable reference for the format guide.

Key files: `core/commands/setup.ts`, `skills/ninthwave-upgrade/SKILL.md`, `.ninthwave/work`

---

### Docs: Update README and CONTRIBUTING for brew distribution (M-BREW-6)

**Priority:** Medium
**Source:** Brew distribution pivot
**Depends on:** H-BREW-4

Update README.md installation section: `brew install ninthwave-sh/tap/ninthwave` as primary method, curl one-liner as fallback. Update the getting-started flow to use `ninthwave setup`. Remove references to git-clone installation as the primary path. Update CONTRIBUTING.md for the new development workflow (binary compilation, release process). Remove the bash `setup` script (replaced by `ninthwave setup`). Remove `remote-install.sh` or update it to install via brew.

Acceptance: README shows brew as the primary install method. CONTRIBUTING documents the build/release process. The bash `setup` script is removed. `bun test` passes.

Key files: `README.md`, `CONTRIBUTING.md`, `setup` (delete), `remote-install.sh` (delete or update)

---
