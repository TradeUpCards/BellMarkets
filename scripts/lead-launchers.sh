#!/usr/bin/env bash
#
# Lead launchers for multi-lead Claude Code projects (Mode 2 / Mode 3 worktrees).
#
# Provides start_lead / finish_lead functions that automate per-lead worktree
# creation + .project/ + .claude/ junctions on start, and safe teardown
# (clean / merged / pushed precondition checks) on finish.
#
# Usage — source from your ~/.bashrc (or ~/.zshrc):
#   source /path/to/<project>/scripts/lead-launchers.sh
#
# Then from anywhere:
#   start_lead aria      # create worktree + junctions; print path to open
#   start_aria           # same (alias generated for known lead names)
#   finish_lead aria     # safe teardown (clean/merged/pushed checks)
#   finish_aria          # same
#
# Path overrides (set before sourcing if needed):
#   export PROJECT_ROOT="$HOME/path/to/your/project"     # default: detect from script location
#   export PROJECT_NAME="MyProject"                       # default: basename of PROJECT_ROOT
#   export PROJECT_PARENT="$HOME/path/to"                 # default: dirname of PROJECT_ROOT
#   export DEFAULT_BRANCH="main"                          # default: main
#
# Conventions:
#   Worktree path:  $PROJECT_PARENT/$PROJECT_NAME-<lead>
#   Branch:         crt/<lead>-init  (the lead's first branch on creation)
#
# ---------------------------------------------------------------------------

# Resolve PROJECT_ROOT from script location if not set
if [ -z "${PROJECT_ROOT:-}" ]; then
    _SOURCE="${BASH_SOURCE[0]:-$0}"
    while [ -L "$_SOURCE" ]; do
        _SOURCE="$(readlink "$_SOURCE")"
    done
    PROJECT_ROOT="$(cd "$(dirname "$_SOURCE")/.." && pwd)"
fi

PROJECT_NAME="${PROJECT_NAME:-$(basename "$PROJECT_ROOT")}"
PROJECT_PARENT="${PROJECT_PARENT:-$(dirname "$PROJECT_ROOT")}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

# Detect platform — affects junction syntax
_is_windows() {
    case "$(uname -s 2>/dev/null)" in
        MINGW*|MSYS*|CYGWIN*) return 0 ;;
        *) return 1 ;;
    esac
}

# Make a junction (Windows) or symlink (Unix) from <link-path> to <target-path>
# Both paths are relative to current working dir.
_make_link() {
    local link="$1"
    local target="$2"

    if [ -L "$link" ] || [ -d "$link" ]; then
        echo "  ↷ $link already exists, skipping" >&2
        return 0
    fi

    if _is_windows; then
        # Convert to Windows backslash form for mklink
        local target_win
        target_win="$(echo "$target" | sed 's|/|\\|g')"
        cmd //c "mklink /J \"$link\" \"$target_win\"" >/dev/null
    else
        ln -s "$target" "$link"
    fi
}

# Remove a junction (Windows) or symlink (Unix) WITHOUT touching the target
_remove_link() {
    local link="$1"
    if [ ! -e "$link" ] && [ ! -L "$link" ]; then
        return 0
    fi
    if _is_windows; then
        # rmdir on Windows removes the junction without touching the target
        cmd //c "rmdir \"$link\"" >/dev/null 2>&1 || rm -f "$link"
    else
        rm -f "$link"
    fi
}

# Verify a path is a junction/symlink (NOT a real directory)
_is_link() {
    local p="$1"
    [ -L "$p" ] && return 0
    if _is_windows; then
        # On Windows, junctions look like directories to bash but not symlinks.
        # Use cmd to query the attribute.
        cmd //c "dir /AL \"$(dirname "$p")\" 2>nul | findstr /i \"$(basename "$p")\"" >/dev/null 2>&1
    else
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Public functions
# ---------------------------------------------------------------------------

# start_lead <name> [<branch>]
#   Create a worktree for <name> at $PROJECT_PARENT/$PROJECT_NAME-<name>
#   on branch <branch> (default: crt/<name>-init).
#   Junction .project/ and .claude/ from the worktree to PROJECT_ROOT.
#   Print the path the user should `cd` to and open in Cursor.
start_lead() {
    local name="${1:?Usage: start_lead <name> [<branch>]}"
    local branch="${2:-crt/${name}-init}"
    local worktree_path="$PROJECT_PARENT/$PROJECT_NAME-$name"

    echo "→ start_lead $name"
    echo "  PROJECT_ROOT:  $PROJECT_ROOT"
    echo "  Worktree:      $worktree_path"
    echo "  Branch:        $branch"
    echo ""

    # Sanity: ensure PROJECT_ROOT is a git repo
    if ! git -C "$PROJECT_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
        echo "✗ $PROJECT_ROOT is not a git repository" >&2
        return 1
    fi

    # Create worktree if missing
    if [ -d "$worktree_path" ]; then
        echo "  ✓ worktree exists, reusing"
    else
        echo "  → creating worktree on branch $branch"
        # Check if branch already exists
        if git -C "$PROJECT_ROOT" rev-parse --verify "$branch" >/dev/null 2>&1; then
            git -C "$PROJECT_ROOT" worktree add "$worktree_path" "$branch" || return 1
        else
            git -C "$PROJECT_ROOT" worktree add "$worktree_path" -b "$branch" || return 1
        fi
    fi

    # Junction .project/
    cd "$worktree_path" || return 1
    if [ ! -L .project ] && [ ! -d .project ]; then
        _make_link .project "../$PROJECT_NAME/.project"
        echo "  ✓ junctioned .project/"
    elif [ -d .project ] && [ ! -L .project ]; then
        # Real directory present (probably from a prior bad setup); back up + link
        mv .project .project.local-backup-$(date +%s)
        _make_link .project "../$PROJECT_NAME/.project"
        echo "  ✓ replaced real .project/ with junction (backup at .project.local-backup-*)"
    else
        echo "  ↷ .project/ already linked"
    fi

    # Junction .claude/ — special case: it's tracked by git, so the worktree HAS one.
    # Replace with junction so persona/skill changes propagate live across worktrees.
    if [ ! -L .claude ]; then
        if [ -d .claude ]; then
            # Check if it has uncommitted changes; refuse to replace if so
            if git -C "$worktree_path" status --porcelain .claude/ 2>/dev/null | grep -q .; then
                echo "  ✗ .claude/ has uncommitted changes; refusing to replace with junction" >&2
                echo "    Commit or stash first, then re-run start_lead $name" >&2
                cd - >/dev/null
                return 1
            fi
            rm -rf .claude
        fi
        _make_link .claude "../$PROJECT_NAME/.claude"
        echo "  ✓ junctioned .claude/"
    else
        echo "  ↷ .claude/ already linked"
    fi

    cd - >/dev/null

    echo ""
    echo "✓ Lead $name ready at $worktree_path"
    echo ""
    echo "  Next:"
    echo "    cd $worktree_path"
    echo "    cursor .          # or open in Cursor however you prefer"
    echo "    # then in Claude Code: /$name"
    echo ""
}

# finish_lead <name> [--keep-branch] [--no-fetch] [--force]
#   Safely tear down the worktree for <name>.
#   Preconditions checked: clean / merged into $DEFAULT_BRANCH / pushed.
#   Removes .project/ and .claude/ junctions FIRST (per WORKTREE_PATTERNS.md),
#   then the worktree, then optionally deletes the branch.
finish_lead() {
    local name="${1:?Usage: finish_lead <name> [--keep-branch] [--no-fetch] [--force]}"
    shift

    local keep_branch=false
    local no_fetch=false
    local force=false
    for arg in "$@"; do
        case "$arg" in
            --keep-branch) keep_branch=true ;;
            --no-fetch)    no_fetch=true ;;
            --force)       force=true ;;
            *) echo "Unknown option: $arg" >&2; return 1 ;;
        esac
    done

    local worktree_path="$PROJECT_PARENT/$PROJECT_NAME-$name"

    echo "→ finish_lead $name"
    echo "  Worktree: $worktree_path"

    if [ ! -d "$worktree_path" ]; then
        echo "  ✗ worktree does not exist; nothing to tear down" >&2
        return 1
    fi

    # Safety check 1: not standing inside the worktree being removed
    local current_dir
    current_dir="$(pwd -P 2>/dev/null || pwd)"
    case "$current_dir" in
        "$worktree_path"*)
            echo "  ✗ refusing to remove worktree you're standing in" >&2
            echo "    cd to $PROJECT_ROOT first, then re-run finish_lead $name" >&2
            return 1
            ;;
    esac

    # Safety check 2: worktree clean
    if ! "$force" && ! git -C "$worktree_path" diff --quiet 2>/dev/null; then
        echo "  ✗ worktree has uncommitted changes (use --force to override):" >&2
        git -C "$worktree_path" status --short >&2
        return 1
    fi
    if ! "$force" && [ -n "$(git -C "$worktree_path" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
        echo "  ✗ worktree has staged-but-uncommitted changes (use --force to override):" >&2
        git -C "$worktree_path" status --short >&2
        return 1
    fi

    # Safety check 3: fetch origin (unless --no-fetch)
    if ! "$no_fetch"; then
        echo "  → git fetch origin"
        git -C "$PROJECT_ROOT" fetch origin || true
    fi

    # Safety check 4: branch merged into origin/$DEFAULT_BRANCH
    local branch
    branch="$(git -C "$worktree_path" symbolic-ref --short HEAD 2>/dev/null)"
    if [ -n "$branch" ] && [ "$branch" != "$DEFAULT_BRANCH" ]; then
        if ! "$force"; then
            local merge_base
            merge_base="$(git -C "$PROJECT_ROOT" merge-base "$branch" "origin/$DEFAULT_BRANCH" 2>/dev/null)"
            local branch_tip
            branch_tip="$(git -C "$PROJECT_ROOT" rev-parse "$branch" 2>/dev/null)"
            if [ "$merge_base" != "$branch_tip" ]; then
                echo "  ✗ branch $branch is not fully merged into origin/$DEFAULT_BRANCH (use --force to override)" >&2
                echo "    Push + merge the MR first, then re-run finish_lead $name" >&2
                return 1
            fi
        fi
    fi

    # Safety check 5: all local commits pushed
    if [ -n "$branch" ] && ! "$force"; then
        local upstream
        upstream="$(git -C "$worktree_path" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"
        if [ -n "$upstream" ]; then
            local ahead
            ahead="$(git -C "$worktree_path" rev-list --count "$upstream..$branch" 2>/dev/null)"
            if [ "$ahead" != "0" ] && [ -n "$ahead" ]; then
                echo "  ✗ branch $branch has $ahead unpushed commit(s) (use --force to override)" >&2
                return 1
            fi
        fi
    fi

    # Step 1: remove junctions FIRST (per WORKTREE_PATTERNS.md "Failure modes")
    cd "$worktree_path" || return 1
    if [ -L .project ] || _is_link .project; then
        _remove_link .project
        echo "  ✓ removed .project/ junction"
    fi
    if [ -L .claude ] || _is_link .claude; then
        _remove_link .claude
        echo "  ✓ removed .claude/ junction"
    fi
    cd - >/dev/null

    # Step 2: remove worktree
    git -C "$PROJECT_ROOT" worktree remove "$worktree_path" || {
        echo "  ✗ git worktree remove failed; check $worktree_path manually" >&2
        return 1
    }
    echo "  ✓ removed worktree"

    # Step 3: optionally delete branch
    if ! "$keep_branch" && [ -n "$branch" ] && [ "$branch" != "$DEFAULT_BRANCH" ]; then
        git -C "$PROJECT_ROOT" branch -d "$branch" 2>/dev/null && echo "  ✓ deleted branch $branch" \
            || echo "  ↷ branch $branch not deleted (use --force or git branch -D manually)"
    fi

    echo ""
    echo "✓ Lead $name torn down"
    echo ""
}

# list_leads — show currently-active worktrees + their branch + status
list_leads() {
    echo "Active worktrees for $PROJECT_NAME:"
    git -C "$PROJECT_ROOT" worktree list 2>/dev/null | while read -r line; do
        echo "  $line"
    done
}

# ---------------------------------------------------------------------------
# Auto-generate per-lead aliases for known names
# (Add custom names to LEAD_NAMES env var or define your own below.)
# ---------------------------------------------------------------------------

LEAD_NAMES="${LEAD_NAMES:-aria bram cleo tate}"
for _lead in $LEAD_NAMES; do
    eval "start_${_lead}()  { start_lead  $_lead \"\$@\"; }"
    eval "finish_${_lead}() { finish_lead $_lead \"\$@\"; }"
done
unset _lead

# Confirm we loaded
echo "lead-launchers.sh loaded for $PROJECT_NAME (root: $PROJECT_ROOT)"
echo "  Functions: start_lead, finish_lead, list_leads"
echo "  Aliases:   $(echo $LEAD_NAMES | sed 's/\([^ ]*\)/start_\1, finish_\1/g')"
