---
name: ninthwave-upgrade
description: |
  Upgrade ninthwave to the latest version. Detects install type (git clone vs vendored),
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

### 1. Detect Install Location

Read `.ninthwave/dir` to find the ninthwave bundle:

```bash
NINTHWAVE_DIR="$(cat .ninthwave/dir 2>/dev/null)"
```

If `.ninthwave/dir` does not exist, tell the user ninthwave is not set up in this project.

### 2. Detect Install Type

Check if the bundle is a git repo:

```bash
if git -C "$NINTHWAVE_DIR" rev-parse --is-inside-work-tree &>/dev/null; then
  INSTALL_TYPE="git"
else
  INSTALL_TYPE="vendored"
fi
```

### 3. Show Current Version

```bash
echo "Current: $(cat .ninthwave/version 2>/dev/null || echo unknown)"
echo "Install: $INSTALL_TYPE ($NINTHWAVE_DIR)"
```

### 4. Upgrade

**Git installs:**

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

**Vendored installs (no .git):**

Tell the user to re-download:
```
To upgrade a vendored install, re-download from GitHub:
  curl -fsSL https://github.com/ninthwave-sh/ninthwave/archive/main.tar.gz | \
    tar -xz --strip-components=1 -C "$NINTHWAVE_DIR"
```

### 5. Re-run Setup

After pulling updates, re-run setup to update the CLI shim and agent files:

```bash
"$NINTHWAVE_DIR/setup" --project-dir "$(git rev-parse --show-toplevel)"
```

### 6. Report

Show the new version and a summary of changes.
