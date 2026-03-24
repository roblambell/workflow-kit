---
name: ninthwave-upgrade
description: |
  Upgrade ninthwave to the latest version. Detects install type (brew, git clone, or vendored),
  pulls updates, and re-runs setup. Use when asked to "upgrade ninthwave", "update ninthwave",
  or "get latest version".
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
user_invocable: true
---

# ninthwave Upgrade

## When Invoked

### 1. Detect Install Type

Check install type in order of priority:

**Homebrew install:**

```bash
if brew list ninthwave &>/dev/null; then
  INSTALL_TYPE="brew"
fi
```

**Git clone install (via `.ninthwave/dir`):**

```bash
if [ "$INSTALL_TYPE" != "brew" ]; then
  NINTHWAVE_DIR="$(cat .ninthwave/dir 2>/dev/null)"
  if [ -n "$NINTHWAVE_DIR" ] && git -C "$NINTHWAVE_DIR" rev-parse --is-inside-work-tree &>/dev/null; then
    INSTALL_TYPE="git"
  elif [ -n "$NINTHWAVE_DIR" ]; then
    INSTALL_TYPE="vendored"
  else
    # No .ninthwave/dir and not brew — unknown
    echo "Cannot detect ninthwave installation. Run 'ninthwave setup' first."
    exit 1
  fi
fi
```

### 2. Show Current Version

```bash
echo "Current: $(ninthwave version 2>/dev/null || cat .ninthwave/version 2>/dev/null || echo unknown)"
echo "Install type: $INSTALL_TYPE"
```

### 3. Upgrade

**Homebrew installs:**

```bash
brew update --quiet
brew upgrade ninthwave
```

After upgrading, re-run setup to update skill symlinks and agent files:

```bash
ninthwave setup
```

**Git clone installs:**

```bash
cd "$NINTHWAVE_DIR"
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date."
  exit 0
fi

# Show what's new
git log --oneline "$LOCAL..$REMOTE"
git pull --ff-only origin main
```

After pulling, re-run setup:

```bash
ninthwave setup
```

**Vendored installs (no .git):**

Tell the user to re-download:
```
To upgrade a vendored install, re-download from GitHub:
  curl -fsSL https://github.com/ninthwave-sh/ninthwave/archive/main.tar.gz | \
    tar -xz --strip-components=1 -C "$NINTHWAVE_DIR"
```

Then re-run setup:
```bash
ninthwave setup
```

### 4. Report

Show the new version and a summary of changes.
