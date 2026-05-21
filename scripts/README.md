# `scripts/`

Project-level helper scripts that ship with the template.

## `install-recommended-skills.sh` / `.ps1`

Bootstrap user-level Claude Code skills from a source directory into `~/.claude/skills/`. Useful when:
- Setting up a new development machine
- Refreshing skills from a canonical collection
- Onboarding a teammate to the same skill set

The "recommended" set is the curated list of universal-utility skills that pair well with this template's workflow. Edit the `RECOMMENDED_SKILLS` array in the script to customize.

**Bash (Git Bash on Windows, macOS, Linux):**
```bash
scripts/install-recommended-skills.sh ~/path/to/your/skills-source
scripts/install-recommended-skills.sh /path/to/foosaner_skills
scripts/install-recommended-skills.sh /path/to/source --all          # copy everything found, not just recommended
scripts/install-recommended-skills.sh /path/to/source --no-overwrite # skip existing
```

**PowerShell:**
```powershell
.\scripts\install-recommended-skills.ps1 -SourceDir C:\path\to\your\skills-source
.\scripts\install-recommended-skills.ps1 -SourceDir C:\path\to\source -All -NoOverwrite
```

The script reports installed / skipped / missing skills at completion.

### Where to point it

The "Foosaner" set is one example of a skill collection — a curated set of universal-utility skills authored by the broader Claude Code community. If you have a local cache of these skills (e.g., from a previous machine or a teammate), point the script at that directory.

If you're starting fresh and have no source: copy the recommended skill names from this script and either author them yourself or find equivalents from public Claude Code skill repositories.

The script does NOT pull from the internet — it expects a local source directory you control. This is intentional: skills are code that runs in your sessions, and you should review what you install.

## `lead-launchers.sh` / `lead-launchers.ps1` (Mode 2 / Mode 3)

Source-able shell functions that automate per-lead worktree setup + teardown with all the safety preconditions baked in. Use these instead of running `git worktree add` + junction commands by hand.

### Bash (Git Bash on Windows, macOS, Linux)

Add to your `~/.bashrc` (or `~/.zshrc`):

```bash
source /c/Dev/path/to/<project>/scripts/lead-launchers.sh
```

Then from anywhere:

```bash
start_lead aria      # create worktree + junctions; print where to open Cursor
start_aria           # same (alias auto-generated for aria/bram/cleo/tate)
start_bram

# Work happens in the lead's worktree...

finish_lead aria     # safe teardown (clean / merged / pushed checks)
finish_aria          # same
finish_aria --keep-branch    # tear down worktree but keep branch
finish_aria --force          # override safety checks (use with caution)
finish_aria --no-fetch       # skip the origin fetch precondition

list_leads           # show all active worktrees
```

### PowerShell

Add to your PowerShell profile (`$PROFILE`):

```powershell
. C:\Dev\path\to\<project>\scripts\lead-launchers.ps1
```

Then:

```powershell
Start-Lead aria
Start-Aria               # alias
Finish-Lead aria
Finish-Aria
Finish-Aria -KeepBranch
Finish-Aria -Force
Get-Leads
```

### What `start_lead` does

1. Verifies `PROJECT_ROOT` is a git repo
2. Creates worktree at `$PROJECT_PARENT/$PROJECT_NAME-<lead>` on branch `crt/<lead>-init` (or reuses if exists)
3. Junctions `.project/` from the worktree → main checkout (so coordination state is shared)
4. Junctions `.claude/` from the worktree → main checkout (with safeguard: refuses to replace if uncommitted `.claude/` changes exist)
5. Prints next steps (cd into worktree, `cursor .`, then `/<lead>` in Claude Code)

### What `finish_lead` does

Safety preconditions checked before teardown (per `WORKTREE_PATTERNS.md`):

1. **You're not standing in the worktree being removed** (would corrupt state)
2. **Worktree is clean** (no uncommitted changes)
3. **`git fetch origin`** runs to refresh local view of remote branches
4. **Branch is fully merged into `origin/<DEFAULT_BRANCH>`** (no orphan commits)
5. **All local commits are pushed** (no dropped work)

Then:

1. Removes `.project/` junction (junction-FIRST per WORKTREE_PATTERNS.md "Failure modes")
2. Removes `.claude/` junction
3. Runs `git worktree remove`
4. Optionally deletes the local branch (skip with `--keep-branch`)

Use `--force` to override the safety checks, but only when you know what you're skipping.

### Configuration via env vars

If your project paths don't match defaults, override before sourcing:

```bash
export PROJECT_ROOT="$HOME/projects/MyProject"
export PROJECT_NAME="MyProject"             # default: basename $PROJECT_ROOT
export PROJECT_PARENT="$HOME/projects"      # default: dirname $PROJECT_ROOT
export DEFAULT_BRANCH="main"                 # default: main
export LEAD_NAMES="aria bram cleo tate reza"  # default: aria bram cleo tate
source /path/to/lead-launchers.sh
```

The launcher generates `start_<lead>` and `finish_<lead>` aliases for each name in `LEAD_NAMES`.

### Why source-able functions, not standalone scripts?

Sourcing into your shell session means `start_aria` works from any directory and modifies your shell's environment (e.g., `cd` after the worktree is created). Standalone scripts can't do that without hacks like `eval "$(start_aria)"`.

### What this DOESN'T do (vs the W2 launcher)

The W2 AgentForge launcher (~1400 lines bash + ~1100 lines PowerShell) also handles:
- Cursor multi-root workspace JSON manipulation (requires `jq`)
- YAML kickoff rendering via `render_kickoff.py`
- Phase rotation (`finish_<lead> --next-phase P3 --next-branch ...`)
- Terminal tab title setting

The template version (~250 lines each) is intentionally minimal. Add those features back if your project genuinely needs them. For most builds, the safety preconditions + junction discipline are what matters.

---

## Adding more scripts

This is a thin scripts directory by design. If a pattern repeats across 2+ projects, consider:
- Adding it to this directory in the template
- Or making it a Claude Code skill (so it's reachable via slash command, not bash)
