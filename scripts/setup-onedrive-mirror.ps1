# Moves .project/ and .claude/ from the working tree into a OneDrive-synced
# folder, then creates Windows directory junctions back so the working tree
# (and slash commands) keep working. OneDrive becomes the source of truth.
#
# Run AFTER /use-template has finished initial setup, from the main checkout.
# Refuses to clobber existing OneDrive content.

$ErrorActionPreference = 'Stop'

$ProjectDir  = (Get-Location).Path
$ProjectName = Split-Path $ProjectDir -Leaf

# Default OneDrive root. Override via $env:ONEDRIVE_ROOT before running.
$OneDriveRoot   = if ($env:ONEDRIVE_ROOT) { $env:ONEDRIVE_ROOT } else { "$env:USERPROFILE\OneDrive\Documents\GauntletAI" }
$OneDriveTarget = Join-Path $OneDriveRoot $ProjectName

Write-Host "OneDrive mirror setup for $ProjectName"
Write-Host "  source: $ProjectDir\.project + .claude"
Write-Host "  target: $OneDriveTarget\.project + .claude"
Write-Host ""

if (-not (Test-Path $OneDriveRoot)) {
    Write-Host "✗ OneDrive root not found: $OneDriveRoot" -ForegroundColor Red
    Write-Host "  Either OneDrive isn't installed/synced or your path differs."
    Write-Host "  Override with: `$env:ONEDRIVE_ROOT='C:\path\to\sync' ; .\scripts\setup-onedrive-mirror.ps1"
    exit 1
}

New-Item -ItemType Directory -Force -Path $OneDriveTarget | Out-Null

function Move-DirToOneDrive {
    param([string]$Name)

    $Src  = Join-Path $ProjectDir $Name
    $Dest = Join-Path $OneDriveTarget $Name

    # Already a junction/symlink? Skip.
    $item = Get-Item $Src -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType) {
        Write-Host "[$Name] already a $($item.LinkType); skipping"
        return
    }

    if (Test-Path $Dest) {
        Write-Host "✗ [$Name] target already exists at $Dest" -ForegroundColor Red
        Write-Host "  refusing to clobber. Inspect manually then re-run."
        exit 1
    }

    if (-not (Test-Path $Src)) {
        Write-Host "[$Name] no source dir at $Src; skipping"
        return
    }

    Write-Host "[$Name] moving to OneDrive..."
    Move-Item -Path $Src -Destination $Dest

    Write-Host "[$Name] junctioning back to working tree..."
    cmd /c "mklink /J `"$Src`" `"$Dest`"" | Out-Null
    Write-Host "[$Name] ✓ done"
}

Move-DirToOneDrive ".project"
Move-DirToOneDrive ".claude"

Write-Host ""
Write-Host "✓ OneDrive mirror set up." -ForegroundColor Green
Write-Host ""
Write-Host "What happened:"
Write-Host "  - $ProjectDir\.project  → junction → $OneDriveTarget\.project"
Write-Host "  - $ProjectDir\.claude   → junction → $OneDriveTarget\.claude"
Write-Host ""
Write-Host "Watch out for:"
Write-Host "  - DO NOT 'Remove-Item -Recurse .project' from the working tree —"
Write-Host "    it follows the junction and deletes the OneDrive source."
Write-Host "    Safe removal: cmd /c 'rmdir .project'   (no recurse flag!)"
Write-Host "  - First OneDrive sync may take a few minutes for small files."
