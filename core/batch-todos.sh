#!/usr/bin/env bash
# Batch-process TODOs from TODOS.md through parallel AI coding sessions.
#
# Tool-agnostic: auto-detects the AI tool (Claude Code, OpenCode, Copilot CLI)
# from the orchestrator's environment and launches workers with the same tool.
#
# Usage: .ninthwave/work <command> [options]
#
# Commands:
#   list [--priority P] [--domain D] [--feature F] [--ready]
#                                                 List TODO items
#   deps <ID>                                     Show dependency chain for an item
#   conflicts <ID1> <ID2>...                      Check file-level conflicts between items
#   batch-order <ID1> [ID2]...                    Group items into dependency batches
#   start <ID1> [ID2]...                          Launch parallel AI coding sessions
#   status                                        Show active worktree status
#   close-workspaces                              Close cmux workspaces for todo items
#   clean [ID]                                    Clean up merged worktrees (closes workspaces first)
#   mark-done <ID1> [ID2]...                      Remove completed items from TODOS.md
#   merged-ids                                    List IDs of already-merged worktree items
#   partitions                                    Show partition allocation
#   watch-ready                                   Check which PRs are merge-ready
#   autopilot-watch [--interval N] [--state-file F]  Block until item status changes
#   pr-watch --pr N [--interval N] [--since T]    Block until PR has new activity
#   ci-failures <PR_NUMBER>                       Show failing CI check details for a PR
#   pr-activity <PR1> [PR2]... [--since T]        Check for new comments/reviews on PRs
#   version-bump                                  Bump version and generate changelog
#
# Dependencies: git, gh (for PR checks), cmux (for session launch)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_GIT_COMMON="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
  echo "Error: not inside a git repository" >&2; exit 1
}
PROJECT_ROOT="${_GIT_COMMON%/.git}"
TODOS_FILE="$PROJECT_ROOT/TODOS.md"
VERSION_FILE="$PROJECT_ROOT/VERSION"
CHANGELOG_FILE="$PROJECT_ROOT/CHANGELOG.md"
WORKTREE_DIR="$PROJECT_ROOT/.worktrees"
PARTITION_DIR="$WORKTREE_DIR/.partitions"

# Global array for temp file cleanup (must be global so EXIT trap can access it)
_prompt_files=()

# Field separator for parse_todos output. Using FS (ASCII 28 / file separator)
# because pipe chars may appear in TODO text.
FS=$'\x1c'

# --- Project configuration ---
# Load optional project config from .ninthwave/config
# Only accepts KEY=VALUE lines (no command execution).
NW_CONFIG="$PROJECT_ROOT/.ninthwave/config"
if [[ -f "$NW_CONFIG" ]]; then
  while IFS='=' read -r key value; do
    key="$(echo "$key" | tr -d '[:space:]')"
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    # Strip surrounding quotes from value
    value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed 's/^["'"'"']//;s/["'"'"']$//')"
    export "$key=$value" 2>/dev/null || true
  done < "$NW_CONFIG"
fi

# Configurable file extensions for LOC counting (space-separated glob patterns)
LOC_EXTENSIONS="${LOC_EXTENSIONS:-*.ex *.exs *.ts *.tsx *.js *.jsx *.py *.go *.rs *.rb *.java *.kt *.swift}"

# --- Colour helpers (disabled when piped or in CI) ---
if [[ -t 1 ]] && [[ -z "${CI:-}" ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' DIM='' RESET=''
fi

# --- Helpers ---

die() {
  echo -e "${RED}Error:${RESET} $*" >&2
  exit 1
}

warn() {
  echo -e "${YELLOW}Warning:${RESET} $*" >&2
}

info() {
  echo -e "${BLUE}>>>${RESET} $*"
}

# --- AI Tool Detection ---
# Detects which AI coding tool is running the orchestrator session.
# The same tool is used to launch worker sessions.

detect_ai_tool() {
  # 1. Explicit override via environment variable (undocumented escape hatch)
  if [[ -n "${NINTHWAVE_AI_TOOL:-}" ]]; then
    echo "$NINTHWAVE_AI_TOOL"
    return
  fi

  # 2. OpenCode: sets OPENCODE=1 in child processes (merged Aug 2025)
  if [[ "${OPENCODE:-}" == "1" ]]; then
    echo "opencode"
    return
  fi

  # 3. Claude Code: check for session env vars
  if [[ -n "${CLAUDE_CODE_SESSION:-}" ]] || [[ -n "${CLAUDE_SESSION_ID:-}" ]]; then
    echo "claude"
    return
  fi

  # 4. Walk up the process tree looking for known tool names
  local pid="$$"
  local depth=0
  while [[ "$pid" -gt 1 ]] && [[ $depth -lt 10 ]]; do
    local cmd_path
    cmd_path="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
    local cmd_base
    cmd_base="$(basename "$cmd_path" 2>/dev/null || echo "$cmd_path")"
    case "$cmd_base" in
      opencode) echo "opencode"; return ;;
      claude)   echo "claude"; return ;;
      copilot)  echo "copilot"; return ;;
    esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || echo 1)"
    depth=$((depth + 1))
  done

  # 5. Fallback: check if any tool binary is available
  if command -v claude &>/dev/null; then
    echo "claude"
  elif command -v opencode &>/dev/null; then
    echo "opencode"
  elif command -v copilot &>/dev/null; then
    echo "copilot"
  else
    echo "unknown"
  fi
}

# Launch an AI coding session for a single TODO item.
# Arguments: tool, worktree_path, id, safe_title, prompt_file
launch_ai_session() {
  local tool="$1" worktree_path="$2" id="$3" safe_title="$4" prompt_file="$5"

  # Build the tool-specific command string
  local cmd=""
  local initial_prompt="Start"
  case "$tool" in
    claude)
      cmd="claude --name 'TODO ${id}: ${safe_title}' --permission-mode bypassPermissions --agent todo-worker --append-system-prompt \"\$(cat '${prompt_file}')\""
      ;;
    opencode)
      cmd="opencode --agent todo-worker --title 'TODO ${id}: ${safe_title}'"
      initial_prompt="$(cat "$prompt_file")\n\nStart implementing this TODO now."
      ;;
    copilot)
      cmd="copilot --agent=todo-worker --allow-all-tools --allow-all-paths"
      initial_prompt="$(cat "$prompt_file")\n\nStart implementing this TODO now."
      ;;
    *)
      die "Unknown AI tool: $tool. Ensure claude, opencode, or copilot is in your PATH."
      ;;
  esac

  # Launch via cmux and send initial prompt
  local ws_output
  ws_output=$(cmux new-workspace \
    --cwd "$worktree_path" \
    --command "$cmd" \
    2>/dev/null) || { warn "cmux launch failed for $id -- is cmux running?"; return 1; }

  local ws_ref
  ws_ref=$(echo "$ws_output" | grep -o 'workspace:[0-9]*')
  if [[ -n "$ws_ref" ]]; then
    sleep 2
    cmux send --workspace "$ws_ref" "${initial_prompt}\n" 2>/dev/null \
      || warn "Failed to send initial prompt to $ws_ref for $id"
  fi
}

# --- Partition management ---
# Partitions provide port and test DB isolation. No hard cap; lowest available integer is used.

# Allocate the lowest available partition number for a TODO ID.
# Creates a lock file at .worktrees/.partitions/<N> containing the TODO ID.
allocate_partition() {
  local todo_id="$1"
  mkdir -p "$PARTITION_DIR"
  local n=1
  while true; do
    if [[ ! -f "$PARTITION_DIR/$n" ]]; then
      echo "$todo_id" > "$PARTITION_DIR/$n"
      echo "$n"
      return 0
    fi
    n=$((n + 1))
  done
}

# Release the partition lock file for a given TODO ID.
release_partition() {
  local todo_id="$1"
  [[ -d "$PARTITION_DIR" ]] || return 0
  for f in "$PARTITION_DIR"/*; do
    [[ -f "$f" ]] || continue
    if [[ "$(cat "$f")" == "$todo_id" ]]; then
      rm -f "$f"
      return
    fi
  done
}

# Get the partition number assigned to a TODO ID, or empty if none.
get_partition_for() {
  local todo_id="$1"
  [[ -d "$PARTITION_DIR" ]] || return 0
  for f in "$PARTITION_DIR"/*; do
    [[ -f "$f" ]] || continue
    if [[ "$(cat "$f")" == "$todo_id" ]]; then
      basename "$f"
      return
    fi
  done
}

# Remove stale partition locks (worktree gone but lock remains).
cleanup_stale_partitions() {
  [[ -d "$PARTITION_DIR" ]] || return 0
  for f in "$PARTITION_DIR"/*; do
    [[ -f "$f" ]] || continue
    local lock_id
    lock_id="$(cat "$f")"
    if [[ ! -d "$WORKTREE_DIR/todo-$lock_id" ]]; then
      rm -f "$f"
    fi
  done
}

# --- Domain normalization ---
# Map section headers to short domain keys.
# Projects can override this by defining a domains.conf file.
# Domain mappings are cached on first load to avoid re-reading the file per item.

_DOMAIN_CACHE=""
_DOMAIN_CACHE_LOADED=false

_load_domain_cache() {
  if $_DOMAIN_CACHE_LOADED; then return; fi
  _DOMAIN_CACHE_LOADED=true
  local domains_file="${DOMAINS_FILE:-$PROJECT_ROOT/.ninthwave/domains.conf}"
  if [[ -f "$domains_file" ]]; then
    _DOMAIN_CACHE="$(cat "$domains_file")"
  fi
}

normalize_domain() {
  local section="$1"
  section="$(echo "$section" | tr '[:upper:]' '[:lower:]')"

  # Check project-specific domain mappings first (cached)
  _load_domain_cache
  if [[ -n "$_DOMAIN_CACHE" ]]; then
    while IFS='=' read -r pattern domain_key; do
      [[ -z "$pattern" || "$pattern" =~ ^# ]] && continue
      pattern="$(echo "$pattern" | tr -d '[:space:]')"
      domain_key="$(echo "$domain_key" | tr -d '[:space:]')"
      if [[ "$section" == *"$pattern"* ]]; then
        echo "$domain_key"
        return
      fi
    done <<< "$_DOMAIN_CACHE"
  fi

  # Default auto-slugify: lowercase, spaces to hyphens, strip non-alphanum
  echo "$section" | sed 's/[^a-z0-9 -]//g' | sed 's/  */ /g' | sed 's/ /-/g' | sed 's/^-//;s/-$//'
}

# Parse TODOS.md into a structured list.
# Output: FS-separated lines: ID${FS}Priority${FS}Title${FS}Domain${FS}Dependencies${FS}BundleWith${FS}Status${FS}LineNumber
parse_todos() {
  local current_domain=""
  # Derive in-progress IDs from worktree directories (no TODOS.md mutation needed)
  local in_progress_ids=""
  if [[ -d "$WORKTREE_DIR" ]]; then
    for wt_dir in "$WORKTREE_DIR"/todo-*/; do
      [[ -d "$wt_dir" ]] || continue
      local wt_id="${wt_dir##*/todo-}"
      wt_id="${wt_id%/}"
      in_progress_ids="$in_progress_ids $wt_id"
    done
  fi

  # Parse all items
  local id="" priority="" title="" depends="" bundle="" line_num=0
  local in_item=false
  local item_start_line=0

  while IFS= read -r line; do
    line_num=$((line_num + 1))

    # Section headers (## level)
    if [[ "$line" =~ ^##\  ]]; then
      # Emit previous item if any
      if [[ -n "$id" ]]; then
        local status="open"
        if [[ " $in_progress_ids " == *" $id "* ]]; then
          status="in-progress"
        fi
        printf '%s' "$id"; printf '%s' "$FS"
        printf '%s' "$priority"; printf '%s' "$FS"
        printf '%s' "$title"; printf '%s' "$FS"
        printf '%s' "$current_domain"; printf '%s' "$FS"
        printf '%s' "$depends"; printf '%s' "$FS"
        printf '%s' "$bundle"; printf '%s' "$FS"
        printf '%s' "$status"; printf '%s' "$FS"
        printf '%s\n' "$item_start_line"
      fi
      id="" priority="" title="" depends="" bundle="" in_item=false

      local section_name="${line#\#\# }"
      section_name="$(echo "$section_name" | sed 's/ (from .*//')"

      if [[ "$line" =~ "In Progress" ]]; then
        current_domain="in-progress-section"
      else
        current_domain="$(normalize_domain "$section_name")"
      fi
      continue
    fi

    # Item headers (### level)
    if [[ "$line" =~ ^###\  ]]; then
      # Emit previous item if any
      if [[ -n "$id" ]]; then
        local status="open"
        if [[ " $in_progress_ids " == *" $id "* ]]; then
          status="in-progress"
        fi
        printf '%s' "$id"; printf '%s' "$FS"
        printf '%s' "$priority"; printf '%s' "$FS"
        printf '%s' "$title"; printf '%s' "$FS"
        printf '%s' "$current_domain"; printf '%s' "$FS"
        printf '%s' "$depends"; printf '%s' "$FS"
        printf '%s' "$bundle"; printf '%s' "$FS"
        printf '%s' "$status"; printf '%s' "$FS"
        printf '%s\n' "$item_start_line"
      fi

      # Extract ID: find first X-code-N pattern in parenthetical (e.g. H-8-3, H-BF5-1, D-2-1)
      if [[ "$line" =~ \(([A-Z]-[A-Za-z0-9]+-[0-9]+) ]]; then
        id="${BASH_REMATCH[1]}"
      else
        id=""
      fi

      title="${line#\#\#\# }"
      title="$(echo "$title" | sed 's/ ([A-Z]*-[A-Za-z0-9]*-[0-9]*.*//' | sed 's/ (bundled)//' | sed 's/ ([0-9]*A)//')"

      priority=""
      depends=""
      bundle=""
      in_item=true
      item_start_line=$line_num
      continue
    fi

    # Parse metadata lines within an item
    if $in_item; then
      if [[ "$line" =~ ^\*\*Priority:\*\*\ (.+) ]]; then
        priority="$(echo "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
        priority="$(echo "$priority" | sed 's/ (.*//')"
      fi
      if [[ "$line" =~ ^\*\*Depends\ on:\*\*\ (.+) ]]; then
        depends="${BASH_REMATCH[1]}"
      fi
      if [[ "$line" =~ ^\*\*Bundle\ with:\*\*\ (.+) ]]; then
        bundle="${BASH_REMATCH[1]}"
      fi
    fi
  done < "$TODOS_FILE"

  # Emit last item
  if [[ -n "$id" ]]; then
    local status="open"
    if [[ " $in_progress_ids " == *" $id "* ]]; then
      status="in-progress"
    fi
    printf '%s' "$id"; printf '%s' "$FS"
    printf '%s' "$priority"; printf '%s' "$FS"
    printf '%s' "$title"; printf '%s' "$FS"
    printf '%s' "$current_domain"; printf '%s' "$FS"
    printf '%s' "$depends"; printf '%s' "$FS"
    printf '%s' "$bundle"; printf '%s' "$FS"
    printf '%s' "$status"; printf '%s' "$FS"
    printf '%s\n' "$item_start_line"
  fi
}

# Helper: extract field N (1-based) from an FS-separated line
field() {
  local n="$1"
  awk -F"$FS" -v n="$n" '{print $n}'
}

# Get all item IDs currently in TODOS.md
get_all_ids() {
  parse_todos | awk -F"$FS" '{ print $1 }'
}

# Check if a dependency is satisfied (not present in TODOS.md = completed and removed)
is_dep_satisfied() {
  local dep_id="$1" all_ids="$2"
  ! echo "$all_ids" | grep -qx "$dep_id"
}

# Extract file paths mentioned in a TODO item's full text
extract_file_paths() {
  local target_id="$1"
  local in_item=false
  local found=false
  local paths=""

  while IFS= read -r line; do
    if [[ "$line" =~ ^###\  ]]; then
      if $found; then
        break
      fi
      if [[ "$line" =~ \($target_id ]]; then
        in_item=true
        found=true
        continue
      else
        in_item=false
      fi
    fi

    if $in_item; then
      # Match backtick-quoted paths (e.g., `path/to/file.ex`)
      local remaining="$line"
      while [[ "$remaining" =~ \`([a-zA-Z_][a-zA-Z0-9_/.-]*\.(ex|exs|ts|tsx|js|jsx|md|yml|yaml|json|conf|sh|py|go|rs|rb|java|kt|swift))\` ]]; do
        local path="${BASH_REMATCH[1]}"
        paths="$paths $path"
        remaining="${remaining#*\`$path\`}"
      done

      # Match file:line patterns (e.g., file.ex:123, file.ex:123-456)
      remaining="$line"
      while [[ "$remaining" =~ ([a-zA-Z_][a-zA-Z0-9_/.-]*\.(ex|exs|ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift)):([0-9]+) ]]; do
        local path="${BASH_REMATCH[1]}"
        paths="$paths $path"
        remaining="${remaining#*${BASH_REMATCH[0]}}"
      done

      # Match paths in backticks that look like directories/files without extensions
      remaining="$line"
      while [[ "$remaining" =~ \`([a-zA-Z_][a-zA-Z0-9_]*(/[a-zA-Z0-9_.+-]+)+)\` ]]; do
        local path="${BASH_REMATCH[1]}"
        paths="$paths $path"
        remaining="${remaining#*\`$path\`}"
      done
    fi
  done < "$TODOS_FILE"

  # Deduplicate and normalize
  echo "$paths" | tr ' ' '\n' | sort -u | grep -v '^$' || true
}

# Extract full TODO text for an item
extract_todo_text() {
  local target_id="$1"
  local in_item=false
  local found=false
  local text=""

  while IFS= read -r line; do
    if [[ "$line" =~ ^###\  ]]; then
      if $found; then
        break
      fi
      if [[ "$line" =~ \($target_id ]]; then
        in_item=true
        found=true
      else
        in_item=false
      fi
    fi

    if $in_item; then
      text="$text$line
"
    fi
  done < "$TODOS_FILE"

  echo "$text"
}

# --- Commands ---

cmd_list() {
  local filter_priority="" filter_domain="" filter_feature="" show_ready=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --priority) filter_priority="$2"; shift 2 ;;
      --domain)   filter_domain="$2"; shift 2 ;;
      --feature)  filter_feature="$2"; shift 2 ;;
      --ready)    show_ready=true; shift ;;
      *)          die "Unknown option: $1" ;;
    esac
  done

  local all_ids
  all_ids="$(get_all_ids)"

  # Parse and filter
  local items
  items="$(parse_todos)"

  # Apply filters
  if [[ -n "$filter_priority" ]]; then
    items="$(echo "$items" | awk -F"$FS" -v p="$filter_priority" '$2 == p')"
  fi

  if [[ -n "$filter_domain" ]]; then
    items="$(echo "$items" | awk -F"$FS" -v d="$filter_domain" '$4 == d')"
  fi

  # Filter by feature code (matches against ID, e.g., --feature BF5 matches C-BF5-1)
  if [[ -n "$filter_feature" ]]; then
    items="$(echo "$items" | awk -F"$FS" -v f="$filter_feature" '$1 ~ f')"
  fi

  if $show_ready; then
    local filtered=""
    while IFS= read -r record; do
      [[ -z "$record" ]] && continue
      local id deps status
      id="$(echo "$record" | field 1)"
      deps="$(echo "$record" | field 5)"
      status="$(echo "$record" | field 7)"
      [[ -z "$id" ]] && continue

      if [[ -z "$deps" ]]; then
        filtered="${filtered}${record}
"
      else
        local all_met=true
        local dep_ids
        dep_ids="$(echo "$deps" | grep -oE '[A-Z]-[A-Za-z0-9]+-[0-9]+' || true)"
        for dep_id in $dep_ids; do
          if ! is_dep_satisfied "$dep_id" "$all_ids"; then
            all_met=false
            break
          fi
        done
        if $all_met; then
          filtered="${filtered}${record}
"
        fi
      fi
    done <<< "$items"
    items="$filtered"
  fi

  # Print table header
  printf "${BOLD}%-12s %-10s %-55s %-14s %-18s %-12s${RESET}\n" \
    "ID" "PRIORITY" "TITLE" "DOMAIN" "DEPENDS ON" "STATUS"
  printf '%.0s-' {1..120}
  echo

  # Print items
  local count=0
  while IFS= read -r record; do
    [[ -z "$record" ]] && continue
    local id priority title domain deps bundle status
    id="$(echo "$record" | field 1)"
    priority="$(echo "$record" | field 2)"
    title="$(echo "$record" | field 3)"
    domain="$(echo "$record" | field 4)"
    deps="$(echo "$record" | field 5)"
    status="$(echo "$record" | field 7)"
    [[ -z "$id" ]] && continue

    # Color-code priority
    local pcolor=""
    case "$priority" in
      critical) pcolor="$RED" ;;
      high)     pcolor="$YELLOW" ;;
      medium)   pcolor="$CYAN" ;;
      low)      pcolor="$DIM" ;;
    esac

    # Color-code status
    local scolor=""
    case "$status" in
      in-progress) scolor="$YELLOW" ;;
      *)           scolor="" ;;
    esac

    # Truncate title if too long
    local display_title="$title"
    if [[ ${#display_title} -gt 53 ]]; then
      display_title="${display_title:0:50}..."
    fi

    # Format deps
    local display_deps="-"
    if [[ -n "$deps" ]]; then
      display_deps="$(echo "$deps" | grep -oE '[A-Z]-[A-Za-z0-9]+-[0-9]+' | tr '\n' ',' | sed 's/,$//' || true)"
      if [[ -z "$display_deps" ]]; then
        display_deps="-"
      elif [[ ${#display_deps} -gt 16 ]]; then
        display_deps="${display_deps:0:13}..."
      fi
    fi

    printf "%-12s ${pcolor}%-10s${RESET} %-55s %-14s %-18s ${scolor}%-12s${RESET}\n" \
      "$id" "$priority" "$display_title" "$domain" "$display_deps" "$status"

    count=$((count + 1))
  done <<< "$items"

  echo
  echo -e "${DIM}$count items${RESET}"
}

cmd_deps() {
  local target_id="${1:-}"
  [[ -z "$target_id" ]] && die "Usage: batch-todos.sh deps <ID>"

  local items
  items="$(parse_todos)"

  # Find the target item
  local target_line
  target_line="$(echo "$items" | awk -F"$FS" -v id="$target_id" '$1 == id')"
  [[ -z "$target_line" ]] && die "Item $target_id not found"

  local target_title target_deps target_bundle target_status
  target_title="$(echo "$target_line" | field 3)"
  target_deps="$(echo "$target_line" | field 5)"
  target_bundle="$(echo "$target_line" | field 6)"
  target_status="$(echo "$target_line" | field 7)"

  echo -e "${BOLD}Dependency chain for $target_id:${RESET} $target_title"
  echo -e "${DIM}Status: $target_status${RESET}"
  echo

  # Items this depends on
  echo -e "${BOLD}Must complete before $target_id:${RESET}"
  if [[ -z "$target_deps" ]]; then
    echo "  (none)"
  else
    local dep_ids
    dep_ids="$(echo "$target_deps" | grep -oE '[A-Z]-[A-Za-z0-9]+-[0-9]+' || true)"
    for dep_id in $dep_ids; do
      local dep_line
      dep_line="$(echo "$items" | awk -F"$FS" -v id="$dep_id" '$1 == id')"
      if [[ -n "$dep_line" ]]; then
        local dep_title dep_status
        dep_title="$(echo "$dep_line" | field 3)"
        dep_status="$(echo "$dep_line" | field 7)"
        local icon="[ ]"
        [[ "$dep_status" == "in-progress" ]] && icon="[~]"
        echo "  $icon $dep_id: $dep_title ($dep_status)"
      else
        echo "  [x] $dep_id: (completed -- removed from TODOS.md)"
      fi
    done
  fi
  echo

  # Items that depend on this
  echo -e "${BOLD}Items that depend on $target_id:${RESET}"
  local found_dependents=false
  while IFS= read -r record; do
    [[ -z "$record" ]] && continue
    local id deps title status
    id="$(echo "$record" | field 1)"
    deps="$(echo "$record" | field 5)"
    title="$(echo "$record" | field 3)"
    status="$(echo "$record" | field 7)"
    [[ -z "$id" ]] && continue
    if echo "$deps" | grep -qE "(^|[, ])$target_id([, ]|$|\b)"; then
      echo "  $id: $title ($status)"
      found_dependents=true
    fi
  done <<< "$items"
  if ! $found_dependents; then
    echo "  (none)"
  fi
  echo

  # Bundle relationships
  echo -e "${BOLD}Bundle with:${RESET}"
  if [[ -z "$target_bundle" ]]; then
    local found_bundles=false
    while IFS= read -r record; do
      [[ -z "$record" ]] && continue
      local id bundle title
      id="$(echo "$record" | field 1)"
      bundle="$(echo "$record" | field 6)"
      title="$(echo "$record" | field 3)"
      [[ -z "$id" ]] && continue
      if [[ -n "$bundle" ]] && echo "$bundle" | grep -qE "(^|[, ])$target_id([, ]|$|\b)"; then
        echo "  $id: $title"
        found_bundles=true
      fi
    done <<< "$items"
    if ! $found_bundles; then
      echo "  (none)"
    fi
  else
    local bundle_ids
    bundle_ids="$(echo "$target_bundle" | grep -oE '[A-Z]-[A-Za-z0-9]+-[0-9]+' || true)"
    for bid in $bundle_ids; do
      local b_line
      b_line="$(echo "$items" | awk -F"$FS" -v id="$bid" '$1 == id')"
      if [[ -n "$b_line" ]]; then
        local b_title
        b_title="$(echo "$b_line" | field 3)"
        echo "  $bid: $b_title"
      else
        echo "  $bid: (not found in TODOS.md)"
      fi
    done
  fi
}

cmd_conflicts() {
  [[ $# -lt 2 ]] && die "Usage: batch-todos.sh conflicts <ID1> <ID2> [ID3...]"

  local ids=("$@")
  local items
  items="$(parse_todos)"

  # Validate all IDs exist
  for id in "${ids[@]}"; do
    local item_line
    item_line="$(echo "$items" | awk -F"$FS" -v id="$id" '$1 == id')"
    [[ -z "$item_line" ]] && die "Item $id not found"
  done

  local has_conflicts=false

  echo -e "${BOLD}File-level conflict analysis:${RESET}"
  echo

  for ((i=0; i<${#ids[@]}; i++)); do
    for ((j=i+1; j<${#ids[@]}; j++)); do
      local id1="${ids[$i]}" id2="${ids[$j]}"

      local domain1 domain2
      domain1="$(echo "$items" | awk -F"$FS" -v id="$id1" '$1 == id' | field 4)"
      domain2="$(echo "$items" | awk -F"$FS" -v id="$id2" '$1 == id' | field 4)"

      local files1 files2
      files1="$(extract_file_paths "$id1")"
      files2="$(extract_file_paths "$id2")"

      local common
      common="$(comm -12 <(echo "$files1" | sort) <(echo "$files2" | sort) 2>/dev/null | grep -v '^$' || true)"

      if [[ -n "$common" ]]; then
        echo -e "  ${RED}CONFLICT${RESET} $id1 vs $id2 -- overlapping files:"
        echo "$common" | while read -r f; do
          echo "    - $f"
        done
        has_conflicts=true
      fi

      if [[ "$domain1" == "$domain2" ]]; then
        echo -e "  ${YELLOW}POTENTIAL${RESET} $id1 vs $id2 -- same domain: $domain1"
        has_conflicts=true
      fi
    done
  done

  if ! $has_conflicts; then
    echo -e "  ${GREEN}CLEAR${RESET} -- no file-level conflicts or domain overlaps detected"
  fi
}

cmd_batch_order() {
  local ids=("$@")
  [[ ${#ids[@]} -lt 1 ]] && die "Usage: batch-todos.sh batch-order <ID1> [ID2...]"

  local items
  items="$(parse_todos)"

  local item_deps=()
  local item_titles=()
  local item_priorities=()
  local valid_ids=()

  for id in "${ids[@]}"; do
    local record
    record="$(echo "$items" | awk -F"$FS" -v id="$id" '$1 == id')"
    [[ -z "$record" ]] && { warn "Item $id not found, skipping"; continue; }

    local deps title priority
    deps="$(echo "$record" | awk -F"$FS" '{print $5}')"
    title="$(echo "$record" | awk -F"$FS" '{print $3}')"
    priority="$(echo "$record" | awk -F"$FS" '{print $2}')"

    local internal_deps=""
    if [[ -n "$deps" ]]; then
      local dep_ids_raw
      dep_ids_raw="$(echo "$deps" | grep -oE '[A-Z]-[A-Za-z0-9]+-[0-9]+' || true)"
      for dep_id in $dep_ids_raw; do
        for sel_id in "${ids[@]}"; do
          if [[ "$dep_id" == "$sel_id" ]]; then
            internal_deps="$internal_deps $dep_id"
          fi
        done
      done
    fi

    valid_ids+=("$id")
    item_deps+=("$(echo "$internal_deps" | xargs)")
    item_titles+=("$title")
    item_priorities+=("$priority")
  done

  _idx_for() {
    local target="$1"
    local i
    for i in "${!valid_ids[@]}"; do
      [[ "${valid_ids[$i]}" == "$target" ]] && { echo "$i"; return; }
    done
    echo "-1"
  }

  local batch_num=0
  local remaining=("${valid_ids[@]}")
  local assigned=""

  echo -e "${BOLD}Dependency batch order:${RESET}"
  echo

  while [[ ${#remaining[@]} -gt 0 ]]; do
    batch_num=$((batch_num + 1))
    local batch_items=()

    for id in "${remaining[@]}"; do
      local idx
      idx="$(_idx_for "$id")"
      local deps="${item_deps[$idx]}"
      local all_met=true
      if [[ -n "$deps" ]]; then
        for dep_id in $deps; do
          if [[ " $assigned " != *" $dep_id "* ]]; then
            all_met=false
            break
          fi
        done
      fi
      if $all_met; then
        batch_items+=("$id")
      fi
    done

    if [[ ${#batch_items[@]} -eq 0 ]]; then
      echo -e "  ${RED}ERROR:${RESET} Circular dependency detected among remaining items:"
      for id in "${remaining[@]}"; do
        local idx
        idx="$(_idx_for "$id")"
        echo "    $id (depends on: ${item_deps[$idx]:-none})"
      done
      return 1
    fi

    echo -e "  ${BOLD}Batch $batch_num${RESET} (${#batch_items[@]} items, parallel):"
    for id in "${batch_items[@]}"; do
      local idx
      idx="$(_idx_for "$id")"
      local pcolor=""
      case "${item_priorities[$idx]}" in
        critical) pcolor="$RED" ;;
        high)     pcolor="$YELLOW" ;;
        medium)   pcolor="$CYAN" ;;
        low)      pcolor="$DIM" ;;
      esac
      local display_title="${item_titles[$idx]}"
      if [[ ${#display_title} -gt 55 ]]; then
        display_title="${display_title:0:52}..."
      fi
      local display_deps="${item_deps[$idx]}"
      [[ -z "$display_deps" ]] && display_deps="-"
      printf "    %-12s ${pcolor}%-10s${RESET} %-55s deps: %s\n" \
        "$id" "${item_priorities[$idx]}" "$display_title" "$display_deps"
      assigned="$assigned $id"
    done
    echo

    local new_remaining=()
    for id in "${remaining[@]}"; do
      local found=false
      for batch_id in "${batch_items[@]}"; do
        [[ "$id" == "$batch_id" ]] && { found=true; break; }
      done
      $found || new_remaining+=("$id")
    done
    remaining=("${new_remaining[@]+"${new_remaining[@]}"}")
  done

  echo -e "${DIM}Total: ${#valid_ids[@]} items in $batch_num batch(es)${RESET}"
}

cmd_start() {
  [[ $# -lt 1 ]] && die "Usage: batch-todos.sh start <ID1> [ID2...]"

  # Clean up temp files on exit (uses global _prompt_files array)
  trap 'rm -f "${_prompt_files[@]}" 2>/dev/null' EXIT

  local ids=("$@")
  local items
  items="$(parse_todos)"
  local all_ids
  all_ids="$(get_all_ids)"

  # Detect AI tool
  local ai_tool
  ai_tool="$(detect_ai_tool)"
  if [[ "$ai_tool" == "unknown" ]]; then
    die "Could not detect AI tool. Ensure claude, opencode, or copilot is in your PATH."
  fi
  info "Detected AI tool: $ai_tool"

  # Validate all items exist and check dependencies
  for id in "${ids[@]}"; do
    local item_line
    item_line="$(echo "$items" | awk -F"$FS" -v id="$id" '$1 == id')"
    [[ -z "$item_line" ]] && die "Item $id not found"

    local deps
    deps="$(echo "$item_line" | field 5)"
    if [[ -n "$deps" ]]; then
      local dep_ids
      dep_ids="$(echo "$deps" | grep -oE '[A-Z]-[A-Za-z0-9]+-[0-9]+' || true)"
      for dep_id in $dep_ids; do
        if ! is_dep_satisfied "$dep_id" "$all_ids"; then
          die "Item $id depends on $dep_id which is not completed"
        fi
      done
    fi
  done

  # Check for file-level conflicts between selected items (warn only)
  if [[ ${#ids[@]} -gt 1 ]]; then
    info "Checking for file-level conflicts..."
    local conflict_output
    conflict_output="$(cmd_conflicts "${ids[@]}" 2>/dev/null || true)"
    if echo "$conflict_output" | grep -q "CONFLICT\|POTENTIAL"; then
      echo "$conflict_output"
      echo
      warn "Conflicts detected between selected items. Proceeding anyway."
      echo
    fi
  fi

  # Ensure worktree directory exists
  mkdir -p "$WORKTREE_DIR"

  # Clean stale partition locks before allocating
  cleanup_stale_partitions

  local launched=()

  for id in "${ids[@]}"; do
    local item_line
    item_line="$(echo "$items" | awk -F"$FS" -v id="$id" '$1 == id')"
    local title
    title="$(echo "$item_line" | field 3)"
    local todo_text
    todo_text="$(extract_todo_text "$id")"

    local worktree_path="$WORKTREE_DIR/todo-$id"
    local branch_name="todo/$id"

    # Create worktree (fetch latest main first)
    if [[ -d "$worktree_path" ]]; then
      warn "Worktree already exists for $id at $worktree_path, reusing"
    else
      info "Fetching latest main before creating worktree for $id"
      git -C "$PROJECT_ROOT" fetch origin main --quiet 2>/dev/null || true
      git -C "$PROJECT_ROOT" merge --ff-only origin/main --quiet 2>/dev/null || true
      info "Creating worktree for $id on branch $branch_name"
      git -C "$PROJECT_ROOT" worktree add "$worktree_path" -b "$branch_name" HEAD
    fi

    # Allocate partition (reuse existing if worktree was reused)
    local partition
    partition="$(get_partition_for "$id")"
    if [[ -z "$partition" ]]; then
      partition="$(allocate_partition "$id")"
    fi

    # Sanitize title for shell safety
    local safe_title
    safe_title="$(echo "$title" | tr "\`\$'" "___")"
    info "Launching $ai_tool session for $id: $safe_title (partition $partition)"

    local system_prompt
    system_prompt="YOUR_TODO_ID: ${id}
YOUR_PARTITION: ${partition}
PROJECT_ROOT: ${PROJECT_ROOT}

${todo_text}"

    # Write system prompt to a temp file to avoid shell escaping issues
    local prompt_file
    prompt_file="$(mktemp)"
    _prompt_files+=("$prompt_file")
    echo "$system_prompt" > "$prompt_file"

    # Launch using the detected AI tool
    launch_ai_session "$ai_tool" "$worktree_path" "$id" "$safe_title" "$prompt_file" || true

    launched+=("$id")
  done

  echo
  echo -e "${GREEN}Launched ${#launched[@]} session(s) via $ai_tool:${RESET}"
  for id in "${launched[@]}"; do
    local item_line
    item_line="$(echo "$items" | awk -F"$FS" -v id="$id" '$1 == id')"
    local title
    title="$(echo "$item_line" | field 3)"
    echo "  - $id: $title"
  done
}

cmd_status() {
  echo -e "${BOLD}Active TODO worktrees:${RESET}"
  echo

  if [[ ! -d "$WORKTREE_DIR" ]]; then
    echo "  No worktrees found at $WORKTREE_DIR"
    return
  fi

  local found=false
  for wt_dir in "$WORKTREE_DIR"/todo-*/; do
    [[ -d "$wt_dir" ]] || continue
    found=true

    local dir_name
    dir_name="$(basename "$wt_dir")"
    local id="${dir_name#todo-}"
    local branch="todo/$id"

    local has_remote=false
    if git -C "$PROJECT_ROOT" rev-parse --verify "origin/$branch" &>/dev/null; then
      has_remote=true
    fi

    local base_commit
    base_commit="$(git -C "$PROJECT_ROOT" merge-base HEAD "$branch" 2>/dev/null || echo "")"
    local ahead=0
    if [[ -n "$base_commit" ]]; then
      ahead="$(git -C "$PROJECT_ROOT" rev-list --count "$base_commit..$branch" 2>/dev/null || echo 0)"
    fi

    local pr_info="" pr_state_val="none"
    if command -v gh &>/dev/null; then
      local merged_pr
      merged_pr="$(gh pr list --head "$branch" --state merged --json number --jq '.[0].number' --limit 1 2>/dev/null || true)"
      if [[ -n "$merged_pr" ]]; then
        pr_info="PR #$merged_pr (MERGED)"
        pr_state_val="merged"
      else
        local open_pr
        open_pr="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number' --limit 1 2>/dev/null || true)"
        if [[ -n "$open_pr" ]]; then
          pr_info="PR #$open_pr (Open)"
          pr_state_val="open"
        else
          local closed_pr
          closed_pr="$(gh pr list --head "$branch" --state closed --json number --jq '.[0].number' --limit 1 2>/dev/null || true)"
          if [[ -n "$closed_pr" ]]; then
            pr_info="PR #$closed_pr (Closed)"
            pr_state_val="closed"
          else
            pr_info="No PR"
          fi
        fi
      fi
    else
      pr_info="(gh not available)"
    fi

    local branch_merged=false
    local ahead_count
    ahead_count="$(git -C "$PROJECT_ROOT" rev-list --count main.."$branch" 2>/dev/null || echo "0")"
    if [[ "$ahead_count" -gt 0 ]] && git -C "$PROJECT_ROOT" branch --merged main 2>/dev/null | grep -q "$branch"; then
      branch_merged=true
    fi

    local item_status
    if [[ "$pr_state_val" == "merged" ]] || $branch_merged; then
      item_status="${GREEN}MERGED${RESET}"
    elif [[ "$pr_state_val" == "open" ]]; then
      item_status="${BLUE}PR Open${RESET}"
    elif [[ "$pr_state_val" == "closed" ]]; then
      item_status="${YELLOW}PR Closed${RESET}"
    elif $has_remote; then
      item_status="${YELLOW}Pushed, no PR${RESET}"
    else
      item_status="${DIM}In progress${RESET}"
    fi

    local partition_num=""
    partition_num="$(get_partition_for "$id")"

    echo -e "  ${BOLD}$id${RESET}  [$item_status]"
    echo -e "    Branch:    $branch ($ahead commits ahead)"
    echo -e "    Remote:    $( $has_remote && echo -e "${GREEN}pushed${RESET}" || echo -e "${DIM}local only${RESET}" )"
    echo -e "    PR:        $pr_info"
    [[ -n "$partition_num" ]] && echo -e "    Partition:  $partition_num"
    echo -e "    Path:      $wt_dir"
    echo
  done

  if ! $found; then
    echo "  No active worktrees"
  fi
}

cmd_merged_ids() {
  if [[ ! -d "$WORKTREE_DIR" ]]; then
    return
  fi
  for wt_dir in "$WORKTREE_DIR"/todo-*/; do
    [[ -d "$wt_dir" ]] || continue
    local dir_name
    dir_name="$(basename "$wt_dir")"
    local id="${dir_name#todo-}"
    local branch="todo/$id"

    local is_merged=false
    local ahead_count
    ahead_count="$(git -C "$PROJECT_ROOT" rev-list --count main.."$branch" 2>/dev/null || echo "0")"
    if [[ "$ahead_count" -gt 0 ]] && git -C "$PROJECT_ROOT" branch --merged main 2>/dev/null | grep -q "$branch"; then
      is_merged=true
    elif command -v gh &>/dev/null; then
      local merged_count
      merged_count="$(gh pr list --head "$branch" --state merged --json number --jq 'length' 2>/dev/null || echo "0")"
      [[ "$merged_count" -gt 0 ]] && is_merged=true
    fi

    if $is_merged; then
      echo "$id"
    fi
  done
}

cmd_close_workspaces() {
  if ! command -v cmux &>/dev/null; then
    warn "cmux not available, skipping workspace close"
    return
  fi

  local workspaces
  workspaces="$(cmux list-workspaces 2>/dev/null || true)"
  [[ -z "$workspaces" ]] && { echo "No cmux workspaces found"; return; }

  local closed=0
  while IFS= read -r line; do
    local ws_ref="" todo_id=""
    if [[ "$line" =~ workspace:[0-9]+ ]]; then
      ws_ref="${BASH_REMATCH[0]}"
    fi
    if [[ "$line" =~ TODO\ ([A-Z]+-[0-9]+-[0-9]+) ]]; then
      todo_id="${BASH_REMATCH[1]}"
    fi

    if [[ -n "$ws_ref" ]] && [[ -n "$todo_id" ]]; then
      info "Closing workspace $ws_ref ($todo_id)"
      cmux close-workspace --workspace "$ws_ref" 2>/dev/null || \
        warn "Failed to close $ws_ref"
      closed=$((closed + 1))
    fi
  done <<< "$workspaces"

  echo -e "${GREEN}Closed $closed todo workspace(s)${RESET}"
}

cmd_close_workspace() {
  local target_id="${1:-}"
  [[ -z "$target_id" ]] && die "Usage: batch-todos.sh close-workspace <ID>"

  if ! command -v cmux &>/dev/null; then
    warn "cmux not available, skipping workspace close for $target_id"
    return
  fi

  local workspaces
  workspaces="$(cmux list-workspaces 2>/dev/null || true)"
  [[ -z "$workspaces" ]] && return

  while IFS= read -r line; do
    local ws_ref=""
    if [[ "$line" =~ workspace:[0-9]+ ]]; then
      ws_ref="${BASH_REMATCH[0]}"
    fi

    if [[ -n "$ws_ref" ]] && [[ "$line" == *"$target_id"* ]]; then
      info "Closing workspace $ws_ref for $target_id"
      cmux close-workspace --workspace "$ws_ref" 2>/dev/null || \
        warn "Failed to close $ws_ref"
      return
    fi
  done <<< "$workspaces"
}

cmd_clean() {
  local target_id="${1:-}"

  # Close workspaces first
  cmd_close_workspaces

  if [[ ! -d "$WORKTREE_DIR" ]]; then
    echo "No worktrees to clean"
    return
  fi

  local cleaned=0

  for wt_dir in "$WORKTREE_DIR"/todo-*/; do
    [[ -d "$wt_dir" ]] || continue
    local dir_name
    dir_name="$(basename "$wt_dir")"
    local id="${dir_name#todo-}"

    # If a specific ID was requested, skip others
    if [[ -n "$target_id" ]] && [[ "$id" != "$target_id" ]]; then
      continue
    fi

    local branch="todo/$id"

    # Check if merged
    local is_merged=false
    local ahead_count
    ahead_count="$(git -C "$PROJECT_ROOT" rev-list --count main.."$branch" 2>/dev/null || echo "0")"
    if [[ "$ahead_count" -gt 0 ]] && git -C "$PROJECT_ROOT" branch --merged main 2>/dev/null | grep -q "$branch"; then
      is_merged=true
    elif command -v gh &>/dev/null; then
      local merged_count
      merged_count="$(gh pr list --head "$branch" --state merged --json number --jq 'length' 2>/dev/null || echo "0")"
      [[ "$merged_count" -gt 0 ]] && is_merged=true
    fi

    if $is_merged || [[ -n "$target_id" ]]; then
      info "Removing worktree for $id"
      git -C "$PROJECT_ROOT" worktree remove "$wt_dir" --force 2>/dev/null || \
        rm -rf "$wt_dir"
      git -C "$PROJECT_ROOT" branch -D "$branch" 2>/dev/null || true
      # Also delete remote branch
      git -C "$PROJECT_ROOT" push origin --delete "$branch" 2>/dev/null || true
      release_partition "$id"
      cleaned=$((cleaned + 1))
    fi
  done

  echo -e "${GREEN}Cleaned $cleaned worktree(s)${RESET}"
}

cmd_clean_single() {
  local target_id="${1:-}"
  [[ -z "$target_id" ]] && die "Usage: batch-todos.sh clean-single <ID>"

  local worktree_path="$WORKTREE_DIR/todo-$target_id"
  local branch="todo/$target_id"

  if [[ -d "$worktree_path" ]]; then
    info "Removing worktree for $target_id"
    git -C "$PROJECT_ROOT" worktree remove "$worktree_path" --force 2>/dev/null || \
      rm -rf "$worktree_path"
    git -C "$PROJECT_ROOT" branch -D "$branch" 2>/dev/null || true
    git -C "$PROJECT_ROOT" push origin --delete "$branch" 2>/dev/null || true
    release_partition "$target_id"
    echo -e "${GREEN}Cleaned worktree for $target_id${RESET}"
  else
    echo "No worktree found for $target_id"
  fi
}

cmd_mark_done() {
  [[ $# -lt 1 ]] && die "Usage: batch-todos.sh mark-done <ID1> [ID2...]"

  local ids=("$@")
  local temp_file
  temp_file="$(mktemp)"

  # Read TODOS.md and remove completed items.
  # Strategy: buffer section headers and inter-item lines until we know the
  # section has at least one kept item, then flush the buffer.
  local in_item=false
  local skip_item=false
  local section_has_items=false
  local pending_section=""
  local pending_lines=""

  # Flush pending section header and buffered lines to the output file.
  _flush_section() {
    if [[ -n "$pending_section" ]]; then
      echo "$pending_section" >> "$temp_file"
      echo "" >> "$temp_file"
      pending_section=""
    fi
    if [[ -n "$pending_lines" ]]; then
      printf '%s' "$pending_lines" >> "$temp_file"
      pending_lines=""
    fi
  }

  while IFS= read -r line; do
    # Track section headers
    if [[ "$line" =~ ^##\  ]] && ! [[ "$line" =~ ^###\  ]]; then
      pending_section="$line"
      pending_lines=""
      section_has_items=false
      skip_item=false
      in_item=false
      continue
    fi

    # Check item headers
    if [[ "$line" =~ ^###\  ]]; then
      skip_item=false
      in_item=true

      # Check if this item should be removed
      for id in "${ids[@]}"; do
        if [[ "$line" == *"($id)"* ]]; then
          skip_item=true
          break
        fi
      done

      if ! $skip_item; then
        section_has_items=true
        _flush_section
      fi
    fi

    # Write line unless we're skipping this item
    if ! $skip_item; then
      if [[ -n "$pending_section" ]]; then
        # Buffer lines between section header and first kept item
        pending_lines="${pending_lines}${line}
"
      else
        echo "$line" >> "$temp_file"
      fi
    fi
  done < "$TODOS_FILE"

  mv "$temp_file" "$TODOS_FILE"

  echo -e "${GREEN}Marked ${#ids[@]} item(s) as done: ${ids[*]}${RESET}"
}

cmd_partitions() {
  echo -e "${BOLD}Partition allocation:${RESET}"
  echo

  if [[ ! -d "$PARTITION_DIR" ]]; then
    echo "  No partitions allocated"
    return
  fi

  for f in "$PARTITION_DIR"/*; do
    [[ -f "$f" ]] || continue
    local num
    num="$(basename "$f")"
    local todo_id
    todo_id="$(cat "$f")"
    echo "  Partition $num: $todo_id"
  done
}

cmd_watch_ready() {
  if [[ ! -d "$WORKTREE_DIR" ]]; then
    echo "No active worktrees"
    return
  fi

  for wt_dir in "$WORKTREE_DIR"/todo-*/; do
    [[ -d "$wt_dir" ]] || continue
    local dir_name
    dir_name="$(basename "$wt_dir")"
    local id="${dir_name#todo-}"
    local branch="todo/$id"

    # Check PR status
    if ! command -v gh &>/dev/null; then
      continue
    fi

    local pr_number pr_state
    pr_number="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number' --limit 1 2>/dev/null || true)"

    if [[ -z "$pr_number" ]]; then
      # Check if merged
      local merged_pr
      merged_pr="$(gh pr list --head "$branch" --state merged --json number --jq '.[0].number' --limit 1 2>/dev/null || true)"
      if [[ -n "$merged_pr" ]]; then
        printf '%s\t%s\t%s\n' "$id" "$merged_pr" "merged"
      else
        printf '%s\t%s\t%s\n' "$id" "" "no-pr"
      fi
      continue
    fi

    # Check CI and review status
    local review_decision ci_status is_mergeable
    review_decision="$(gh pr view "$pr_number" --json reviewDecision --jq '.reviewDecision' 2>/dev/null || true)"
    ci_status="$(gh pr checks "$pr_number" --json state --jq '[.[] | select(.state != "SKIPPED")] | if all(.state == "SUCCESS") then "pass" elif any(.state == "FAILURE") then "fail" elif any(.state == "PENDING") then "pending" else "unknown" end' 2>/dev/null || true)"
    is_mergeable="$(gh pr view "$pr_number" --json mergeable --jq '.mergeable' 2>/dev/null || true)"

    local status="pending"
    if [[ "$ci_status" == "fail" ]]; then
      status="failing"
    elif [[ "$ci_status" == "pass" ]] && [[ "$is_mergeable" == "MERGEABLE" ]]; then
      if [[ "$review_decision" == "APPROVED" ]]; then
        status="ready"
      else
        status="pending"
      fi
    elif [[ "$ci_status" == "pending" ]]; then
      status="pending"
    fi

    printf '%s\t%s\t%s\n' "$id" "$pr_number" "$status"
  done
}

cmd_autopilot_watch() {
  local interval=120
  local state_file=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --interval) interval="$2"; shift 2 ;;
      --state-file) state_file="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  # Take initial snapshot
  local current_state
  current_state="$(cmd_watch_ready 2>/dev/null || true)"

  # Load previous state
  local prev_state=""
  if [[ -n "$state_file" ]] && [[ -f "$state_file" ]]; then
    prev_state="$(cat "$state_file")"
  fi

  # Save current state
  if [[ -n "$state_file" ]]; then
    echo "$current_state" > "$state_file"
  fi

  # Compare and report transitions
  local transitions=""
  while IFS=$'\t' read -r id pr_number status; do
    [[ -z "$id" ]] && continue
    local prev_status="no-pr"
    if [[ -n "$prev_state" ]]; then
      prev_status="$(echo "$prev_state" | awk -F'\t' -v id="$id" '$1 == id { print $3 }')"
      [[ -z "$prev_status" ]] && prev_status="no-pr"
    fi

    if [[ "$prev_status" != "$status" ]]; then
      transitions="${transitions}${id}\t${pr_number}\t${prev_status}\t${status}\n"
    fi
  done <<< "$current_state"

  # Check for items that disappeared (worktree cleaned = gone)
  if [[ -n "$prev_state" ]]; then
    while IFS=$'\t' read -r id pr_number status; do
      [[ -z "$id" ]] && continue
      if ! echo "$current_state" | grep -q "^${id}	"; then
        transitions="${transitions}${id}\t${pr_number}\t${status}\tgone\n"
      fi
    done <<< "$prev_state"
  fi

  if [[ -n "$transitions" ]]; then
    echo -e "$transitions" | grep -v '^$'
    return 0
  fi

  # No transitions -- poll until something changes
  local elapsed=0
  while [[ $elapsed -lt 3600 ]]; do
    sleep "$interval"
    elapsed=$((elapsed + interval))

    current_state="$(cmd_watch_ready 2>/dev/null || true)"

    # Compare again
    transitions=""
    while IFS=$'\t' read -r id pr_number status; do
      [[ -z "$id" ]] && continue
      local prev_status="no-pr"
      if [[ -n "$state_file" ]] && [[ -f "$state_file" ]]; then
        prev_status="$(cat "$state_file" | awk -F'\t' -v id="$id" '$1 == id { print $3 }')"
        [[ -z "$prev_status" ]] && prev_status="no-pr"
      fi

      if [[ "$prev_status" != "$status" ]]; then
        transitions="${transitions}${id}\t${pr_number}\t${prev_status}\t${status}\n"
      fi
    done <<< "$current_state"

    # Check for gone items
    if [[ -n "$state_file" ]] && [[ -f "$state_file" ]]; then
      while IFS=$'\t' read -r id pr_number status; do
        [[ -z "$id" ]] && continue
        if ! echo "$current_state" | grep -q "^${id}	"; then
          transitions="${transitions}${id}\t${pr_number}\t${status}\tgone\n"
        fi
      done < "$state_file"
    fi

    # Save current state
    if [[ -n "$state_file" ]]; then
      echo "$current_state" > "$state_file"
    fi

    if [[ -n "$transitions" ]]; then
      echo -e "$transitions" | grep -v '^$'
      return 0
    fi
  done

  echo "Timeout: no status changes after 1 hour"
  return 1
}

cmd_pr_watch() {
  local pr_number="" interval=120 since=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --pr) pr_number="$2"; shift 2 ;;
      --interval) interval="$2"; shift 2 ;;
      --since) since="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  [[ -z "$pr_number" ]] && die "Usage: batch-todos.sh pr-watch --pr N [--interval N] [--since T]"

  if [[ -z "$since" ]]; then
    since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi

  local elapsed=0
  while [[ $elapsed -lt 3600 ]]; do
    sleep "$interval"
    elapsed=$((elapsed + interval))

    local owner_repo
    owner_repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
    [[ -z "$owner_repo" ]] && continue

    # Check for new reviews
    local new_reviews
    new_reviews="$(gh api "repos/${owner_repo}/pulls/${pr_number}/reviews" \
      --jq "[.[] | select(.submitted_at > \"$since\")] | length" 2>/dev/null || echo "0")"

    # Check for new comments
    local new_comments
    new_comments="$(gh api "repos/${owner_repo}/issues/${pr_number}/comments" \
      --jq "[.[] | select(.created_at > \"$since\")] | length" 2>/dev/null || echo "0")"

    # Check for new review comments
    local new_review_comments
    new_review_comments="$(gh api "repos/${owner_repo}/pulls/${pr_number}/comments" \
      --jq "[.[] | select(.created_at > \"$since\")] | length" 2>/dev/null || echo "0")"

    local total=$((new_reviews + new_comments + new_review_comments))
    if [[ $total -gt 0 ]]; then
      echo -e "activity\t$pr_number\t$total"
      return 0
    fi

    # Check if PR state changed
    local state
    state="$(gh pr view "$pr_number" --json state --jq '.state' 2>/dev/null || true)"
    if [[ "$state" == "MERGED" ]] || [[ "$state" == "CLOSED" ]]; then
      echo -e "state_change\t$pr_number\t$state"
      return 0
    fi
  done

  echo "Timeout: no activity on PR #$pr_number after 1 hour"
  return 1
}

cmd_ci_failures() {
  local pr_number="${1:-}"
  [[ -z "$pr_number" ]] && die "Usage: batch-todos.sh ci-failures <PR_NUMBER>"

  gh pr checks "$pr_number" --json name,state,detailsUrl \
    --jq '.[] | select(.state == "FAILURE") | "\(.name)\t\(.detailsUrl)"' 2>/dev/null || \
    echo "No failing checks found"
}

cmd_pr_activity() {
  local prs=() since=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since) since="$2"; shift 2 ;;
      *)       prs+=("$1"); shift ;;
    esac
  done

  [[ ${#prs[@]} -lt 1 ]] && die "Usage: batch-todos.sh pr-activity <PR1> [PR2]... [--since T]"

  if [[ -z "$since" ]]; then
    since="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
             date -u -v-1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
             date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi

  local owner_repo
  owner_repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
  [[ -z "$owner_repo" ]] && die "Could not determine repository"

  for pr in "${prs[@]}"; do
    local activity_type="none"

    # Check for review decisions
    local review_state
    review_state="$(gh api "repos/${owner_repo}/pulls/${pr}/reviews" \
      --jq "[.[] | select(.submitted_at > \"$since\")] | last | .state" 2>/dev/null || true)"

    if [[ "$review_state" == "CHANGES_REQUESTED" ]]; then
      activity_type="changes_requested"
    elif [[ "$review_state" == "APPROVED" ]]; then
      activity_type="approved"
    fi

    # Check for new comments
    local comment_count
    comment_count="$(gh api "repos/${owner_repo}/issues/${pr}/comments" \
      --jq "[.[] | select(.created_at > \"$since\")] | length" 2>/dev/null || echo "0")"

    if [[ "$comment_count" -gt 0 ]] && [[ "$activity_type" == "none" ]]; then
      activity_type="new_comments"
    fi

    # Check for new review comments (inline)
    local review_comment_count
    review_comment_count="$(gh api "repos/${owner_repo}/pulls/${pr}/comments" \
      --jq "[.[] | select(.created_at > \"$since\")] | length" 2>/dev/null || echo "0")"

    if [[ "$review_comment_count" -gt 0 ]] && [[ "$activity_type" == "none" ]]; then
      activity_type="new_comments"
    fi

    printf '%s\t%s\n' "$pr" "$activity_type"
  done
}

cmd_version_bump() {
  # Guard: must be on main branch
  local current_branch
  current_branch="$(git -C "$PROJECT_ROOT" branch --show-current 2>/dev/null || echo "")"
  if [[ "$current_branch" != "main" ]]; then
    die "version-bump must be run on the main branch (currently on: $current_branch)"
  fi

  [[ ! -f "$VERSION_FILE" ]] && die "VERSION file not found at $VERSION_FILE"
  [[ ! -f "$CHANGELOG_FILE" ]] && die "CHANGELOG.md not found at $CHANGELOG_FILE"

  local current_version
  current_version="$(tr -d '[:space:]' < "$VERSION_FILE")"
  info "Current version: $current_version"

  local last_version_commit
  last_version_commit="$(git -C "$PROJECT_ROOT" log -1 --format='%H' -- VERSION 2>/dev/null || echo "")"

  if [[ -z "$last_version_commit" ]]; then
    die "Could not find any commit that modified VERSION"
  fi

  info "Last VERSION change: $(git -C "$PROJECT_ROOT" log -1 --oneline "$last_version_commit")"

  local commits
  commits="$(git -C "$PROJECT_ROOT" log --oneline "$last_version_commit..HEAD" 2>/dev/null || echo "")"

  if [[ -z "$commits" ]]; then
    echo "No commits since last version bump."
    return
  fi

  echo
  echo -e "${BOLD}Commits since $current_version:${RESET}"
  echo "$commits"
  echo

  # Categorize by conventional commit prefix
  local added="" changed="" fixed="" removed=""

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local msg="${line#* }"
    case "$msg" in
      feat:*|feat\(*)     added="$added
- ${msg#*: }" ;;
      fix:*|fix\(*)       fixed="$fixed
- ${msg#*: }" ;;
      refactor:*|refactor\(*) changed="$changed
- ${msg#*: }" ;;
      *)                  ;;
    esac
  done <<< "$commits"

  # Calculate net LOC changed (using configurable extensions)
  local stat_args=()
  for ext in $LOC_EXTENSIONS; do
    stat_args+=("--" "$ext")
  done

  local stat_line
  stat_line="$(git -C "$PROJECT_ROOT" diff --stat "$last_version_commit..HEAD" "${stat_args[@]}" 2>/dev/null | \
    tail -1)"

  local insertions=0 deletions=0
  if [[ "$stat_line" =~ ([0-9]+)\ insertion ]]; then
    insertions="${BASH_REMATCH[1]}"
  fi
  if [[ "$stat_line" =~ ([0-9]+)\ deletion ]]; then
    deletions="${BASH_REMATCH[1]}"
  fi
  local total_loc=$((insertions + deletions))

  echo -e "Net LOC changed: ${BOLD}$total_loc${RESET} (+$insertions -$deletions)"

  # Parse version parts: MAJOR.MINOR.PATCH.MICRO
  IFS='.' read -r v_major v_minor v_patch v_micro <<< "$current_version"
  v_micro="${v_micro:-0}"

  local new_version=""
  if [[ $total_loc -lt 50 ]]; then
    v_micro=$((v_micro + 1))
    new_version="$v_major.$v_minor.$v_patch.$v_micro"
    info "Auto-bumping MICRO (< 50 LOC): $current_version -> $new_version"
  elif [[ $total_loc -le 200 ]]; then
    v_patch=$((v_patch + 1))
    v_micro=0
    new_version="$v_major.$v_minor.$v_patch.$v_micro"
    info "Auto-bumping PATCH (50-200 LOC): $current_version -> $new_version"
  else
    echo
    echo -e "${YELLOW}> 200 LOC changed. Choose bump level:${RESET}"
    echo "  1) MINOR ($v_major.$((v_minor + 1)).0.0)"
    echo "  2) MAJOR ($((v_major + 1)).0.0.0)"
    echo "  3) PATCH ($v_major.$v_minor.$((v_patch + 1)).0)"

    read -rp "Choice [1/2/3]: " choice
    case "$choice" in
      1) new_version="$v_major.$((v_minor + 1)).0.0" ;;
      2) new_version="$((v_major + 1)).0.0.0" ;;
      3) new_version="$v_major.$v_minor.$((v_patch + 1)).0" ;;
      *) die "Invalid choice" ;;
    esac
    info "Bumping to: $new_version"
  fi

  # Generate CHANGELOG entry
  local changelog_entry="## [$new_version] - $(date +%Y-%m-%d)"

  if [[ -n "$added" ]]; then
    changelog_entry="$changelog_entry

### Added
$added"
  fi

  if [[ -n "$changed" ]]; then
    changelog_entry="$changelog_entry

### Changed
$changed"
  fi

  if [[ -n "$fixed" ]]; then
    changelog_entry="$changelog_entry

### Fixed
$fixed"
  fi

  if [[ -n "$removed" ]]; then
    changelog_entry="$changelog_entry

### Removed
$removed"
  fi

  echo
  echo -e "${BOLD}Changelog entry:${RESET}"
  echo "$changelog_entry"
  echo

  # Write VERSION
  echo "$new_version" > "$VERSION_FILE"
  info "Updated VERSION to $new_version"

  # Prepend to CHANGELOG.md (after header line)
  local temp_file
  temp_file="$(mktemp)"
  local header_done=false
  while IFS= read -r line; do
    echo "$line" >> "$temp_file"
    if [[ "$line" =~ ^"# " ]] && ! $header_done; then
      echo "" >> "$temp_file"
      echo "$changelog_entry" >> "$temp_file"
      header_done=true
    fi
  done < "$CHANGELOG_FILE"
  mv "$temp_file" "$CHANGELOG_FILE"
  info "Updated CHANGELOG.md"

  # Commit
  git -C "$PROJECT_ROOT" add "$VERSION_FILE" "$CHANGELOG_FILE"
  git -C "$PROJECT_ROOT" commit -m "$(cat <<EOF
chore: bump version and changelog (v$new_version)
EOF
)"

  echo
  echo -e "${GREEN}Version bumped to $new_version and committed.${RESET}"
}

# --- Main ---

main() {
  [[ ! -f "$TODOS_FILE" ]] && die "TODOS.md not found at $TODOS_FILE"

  local command="${1:-}"
  [[ -z "$command" ]] && {
    echo "Usage: batch-todos.sh <command> [options]"
    echo
    echo "Commands:"
    echo "  list [--priority P] [--domain D] [--feature F] [--ready]"
    echo "                                                List TODO items"
    echo "  deps <ID>                                     Show dependency chain"
    echo "  conflicts <ID1> <ID2>...                      Check file conflicts"
    echo "  batch-order <ID1> [ID2]...                    Group items into dependency batches"
    echo "  start <ID1> [ID2]...                          Launch parallel sessions"
    echo "  status                                        Show active worktrees"
    echo "  close-workspaces                              Close all cmux todo workspaces"
    echo "  close-workspace <ID>                          Close cmux workspace for a single item"
    echo "  clean [ID]                                    Clean up worktrees + close all workspaces"
    echo "  clean-single <ID>                             Clean single worktree (no side effects)"
    echo "  mark-done <ID1> [ID2]...                      Remove completed items from TODOS.md"
    echo "  merged-ids                                    List IDs of already-merged worktree items"
    echo "  partitions                                    Show partition allocation"
    echo "  watch-ready                                   Check which PRs are merge-ready"
    echo "  autopilot-watch [--interval N] [--state-file F]  Block until item status changes"
    echo "  pr-watch --pr N [--interval N] [--since T]    Block until PR has new activity"
    echo "  ci-failures <PR>                              Show failing CI check details"
    echo "  pr-activity <PR1> [PR2]... [--since T]        Check for new comments/reviews"
    echo "  version-bump                                  Bump version + changelog"
    exit 0
  }

  shift

  case "$command" in
    list)              cmd_list "$@" ;;
    deps)              cmd_deps "$@" ;;
    conflicts)         cmd_conflicts "$@" ;;
    batch-order)       cmd_batch_order "$@" ;;
    start)             cmd_start "$@" ;;
    status)            cmd_status "$@" ;;
    close-workspaces)  cmd_close_workspaces "$@" ;;
    close-workspace)   cmd_close_workspace "$@" ;;
    clean)             cmd_clean "$@" ;;
    clean-single)      cmd_clean_single "$@" ;;
    mark-done)         cmd_mark_done "$@" ;;
    merged-ids)        cmd_merged_ids "$@" ;;
    partitions)        cmd_partitions "$@" ;;
    watch-ready)       cmd_watch_ready "$@" ;;
    autopilot-watch)   cmd_autopilot_watch "$@" ;;
    pr-watch)          cmd_pr_watch "$@" ;;
    ci-failures)       cmd_ci_failures "$@" ;;
    pr-activity)       cmd_pr_activity "$@" ;;
    version-bump)      cmd_version_bump "$@" ;;
    *)                 die "Unknown command: $command" ;;
  esac
}

main "$@"
