<#
.SYNOPSIS
    Lead launchers for multi-lead Claude Code projects (Mode 2 / Mode 3 worktrees).

.DESCRIPTION
    Provides Start-Lead / Finish-Lead functions that automate per-lead worktree
    creation + .project/ + .claude/ junctions on start, and safe teardown
    (clean / merged / pushed precondition checks) on finish.

    Source from your PowerShell profile:
      . C:\path\to\<project>\scripts\lead-launchers.ps1

    Then from anywhere:
      Start-Lead aria       # create worktree + junctions; print path to open
      Start-Aria            # same (alias generated for known lead names)
      Finish-Lead aria      # safe teardown
      Finish-Aria

.NOTES
    Path overrides (set before sourcing if needed):
      $env:PROJECT_ROOT     = "C:\path\to\your\project"     # default: from script location
      $env:PROJECT_NAME     = "MyProject"                    # default: basename of PROJECT_ROOT
      $env:PROJECT_PARENT   = "C:\path\to"                   # default: dirname of PROJECT_ROOT
      $env:DEFAULT_BRANCH   = "main"                         # default: main
#>

# Resolve PROJECT_ROOT from script location if not set
if (-not $env:PROJECT_ROOT) {
    $env:PROJECT_ROOT = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
if (-not $env:PROJECT_NAME)   { $env:PROJECT_NAME   = Split-Path -Leaf   $env:PROJECT_ROOT }
if (-not $env:PROJECT_PARENT) { $env:PROJECT_PARENT = Split-Path -Parent $env:PROJECT_ROOT }
if (-not $env:DEFAULT_BRANCH) { $env:DEFAULT_BRANCH = 'main' }

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

function _MakeJunction {
    param([string]$Link, [string]$Target)
    if (Test-Path $Link) {
        Write-Host "  ↷ $Link already exists, skipping"
        return
    }
    New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
}

function _RemoveJunction {
    param([string]$Link)
    if (-not (Test-Path $Link)) { return }
    # Use cmd rmdir to avoid following the junction and deleting the target
    cmd /c "rmdir `"$Link`"" 2>$null
    if (Test-Path $Link) {
        # Fallback
        Remove-Item $Link -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# Public functions
# ---------------------------------------------------------------------------

function Start-Lead {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$Name,

        [Parameter(Position=1)]
        [string]$Branch
    )

    if (-not $Branch) { $Branch = "crt/$Name-init" }
    $WorktreePath = Join-Path $env:PROJECT_PARENT "$($env:PROJECT_NAME)-$Name"

    Write-Host "→ Start-Lead $Name"
    Write-Host "  PROJECT_ROOT:  $($env:PROJECT_ROOT)"
    Write-Host "  Worktree:      $WorktreePath"
    Write-Host "  Branch:        $Branch"
    Write-Host ""

    # Sanity: PROJECT_ROOT is a git repo
    Push-Location $env:PROJECT_ROOT
    try {
        $null = git rev-parse --git-dir 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Error "$env:PROJECT_ROOT is not a git repository"
            return
        }

        # Create worktree if missing
        if (Test-Path $WorktreePath) {
            Write-Host "  ✓ worktree exists, reusing"
        } else {
            Write-Host "  → creating worktree on branch $Branch"
            $null = git rev-parse --verify $Branch 2>$null
            if ($LASTEXITCODE -eq 0) {
                git worktree add $WorktreePath $Branch
            } else {
                git worktree add $WorktreePath -b $Branch
            }
            if ($LASTEXITCODE -ne 0) { return }
        }
    } finally {
        Pop-Location
    }

    # Junction .project/
    Push-Location $WorktreePath
    try {
        if (-not (Test-Path .project)) {
            _MakeJunction -Link .project -Target (Join-Path $env:PROJECT_ROOT '.project')
            Write-Host "  ✓ junctioned .project/"
        } elseif ((Get-Item .project).LinkType -ne 'Junction' -and (Get-Item .project).LinkType -ne 'SymbolicLink') {
            $backup = ".project.local-backup-$(Get-Date -Format 'yyyyMMddHHmmss')"
            Move-Item .project $backup
            _MakeJunction -Link .project -Target (Join-Path $env:PROJECT_ROOT '.project')
            Write-Host "  ✓ replaced real .project/ with junction (backup at $backup)"
        } else {
            Write-Host "  ↷ .project/ already linked"
        }

        # Junction .claude/ — handle git-tracked case
        if (-not (Test-Path .claude) -or (Get-Item .claude -ErrorAction SilentlyContinue).LinkType -eq $null) {
            if (Test-Path .claude) {
                # Check for uncommitted changes
                $dirty = git status --porcelain .claude/ 2>$null
                if ($dirty) {
                    Write-Error "  .claude/ has uncommitted changes; refusing to replace with junction. Commit or stash first."
                    return
                }
                Remove-Item .claude -Recurse -Force
            }
            _MakeJunction -Link .claude -Target (Join-Path $env:PROJECT_ROOT '.claude')
            Write-Host "  ✓ junctioned .claude/"
        } else {
            Write-Host "  ↷ .claude/ already linked"
        }
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "✓ Lead $Name ready at $WorktreePath"
    Write-Host ""
    Write-Host "  Next:"
    Write-Host "    cd $WorktreePath"
    Write-Host "    cursor .                # or open in Cursor however you prefer"
    Write-Host "    # then in Claude Code: /$Name"
    Write-Host ""
}

function Finish-Lead {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$Name,
        [switch]$KeepBranch,
        [switch]$NoFetch,
        [switch]$Force
    )

    $WorktreePath = Join-Path $env:PROJECT_PARENT "$($env:PROJECT_NAME)-$Name"

    Write-Host "→ Finish-Lead $Name"
    Write-Host "  Worktree: $WorktreePath"

    if (-not (Test-Path $WorktreePath)) {
        Write-Error "  worktree does not exist; nothing to tear down"
        return
    }

    # Safety: not standing inside the worktree
    $cwd = (Get-Location).Path
    if ($cwd.StartsWith((Resolve-Path $WorktreePath).Path)) {
        Write-Error "  refusing to remove worktree you're standing in. cd $env:PROJECT_ROOT first."
        return
    }

    Push-Location $WorktreePath
    try {
        # Safety: clean
        if (-not $Force) {
            $dirty = git status --porcelain 2>$null
            if ($dirty) {
                Write-Error "  worktree has uncommitted changes (use -Force to override):`n$dirty"
                return
            }
        }

        $branch = git symbolic-ref --short HEAD 2>$null
        if (-not $NoFetch) {
            Write-Host "  → git fetch origin"
            git -C $env:PROJECT_ROOT fetch origin
        }

        # Safety: branch merged
        if ($branch -and $branch -ne $env:DEFAULT_BRANCH -and -not $Force) {
            $mergeBase = git -C $env:PROJECT_ROOT merge-base $branch "origin/$($env:DEFAULT_BRANCH)" 2>$null
            $branchTip = git -C $env:PROJECT_ROOT rev-parse $branch 2>$null
            if ($mergeBase -ne $branchTip) {
                Write-Error "  branch $branch is not fully merged into origin/$($env:DEFAULT_BRANCH) (use -Force to override)"
                return
            }
        }

        # Safety: pushed
        if ($branch -and -not $Force) {
            $upstream = git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
            if ($upstream) {
                $ahead = git rev-list --count "$upstream..$branch" 2>$null
                if ($ahead -and $ahead -ne '0') {
                    Write-Error "  branch $branch has $ahead unpushed commit(s) (use -Force to override)"
                    return
                }
            }
        }

        # Step 1: remove junctions FIRST
        if (Test-Path .project) {
            _RemoveJunction -Link .project
            Write-Host "  ✓ removed .project/ junction"
        }
        if (Test-Path .claude) {
            _RemoveJunction -Link .claude
            Write-Host "  ✓ removed .claude/ junction"
        }
    } finally {
        Pop-Location
    }

    # Step 2: remove worktree
    Push-Location $env:PROJECT_ROOT
    try {
        git worktree remove $WorktreePath
        if ($LASTEXITCODE -ne 0) {
            Write-Error "  git worktree remove failed; check $WorktreePath manually"
            return
        }
        Write-Host "  ✓ removed worktree"

        # Step 3: optionally delete branch
        if (-not $KeepBranch -and $branch -and $branch -ne $env:DEFAULT_BRANCH) {
            git branch -d $branch 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  ✓ deleted branch $branch"
            } else {
                Write-Host "  ↷ branch $branch not deleted (use git branch -D manually if needed)"
            }
        }
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "✓ Lead $Name torn down"
    Write-Host ""
}

function Get-Leads {
    Write-Host "Active worktrees for $($env:PROJECT_NAME):"
    git -C $env:PROJECT_ROOT worktree list
}

# ---------------------------------------------------------------------------
# Auto-generate per-lead aliases for known names
# ---------------------------------------------------------------------------

$LeadNames = if ($env:LEAD_NAMES) { $env:LEAD_NAMES -split ' ' } else { @('aria','bram','cleo','tate') }
foreach ($lead in $LeadNames) {
    $startName  = "Start-$((Get-Culture).TextInfo.ToTitleCase($lead))"
    $finishName = "Finish-$((Get-Culture).TextInfo.ToTitleCase($lead))"
    Invoke-Expression "function $startName  { Start-Lead  -Name '$lead' @args }"
    Invoke-Expression "function $finishName { Finish-Lead -Name '$lead' @args }"
}

Write-Host "lead-launchers.ps1 loaded for $($env:PROJECT_NAME) (root: $($env:PROJECT_ROOT))"
Write-Host "  Functions: Start-Lead, Finish-Lead, Get-Leads"
$aliasList = ($LeadNames | ForEach-Object {
    $cap = (Get-Culture).TextInfo.ToTitleCase($_)
    "Start-$cap, Finish-$cap"
}) -join ', '
Write-Host "  Aliases:   $aliasList"
