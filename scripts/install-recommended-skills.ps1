<#
.SYNOPSIS
    Bootstrap user-level Claude Code skills from a source directory into ~/.claude/skills/.

.DESCRIPTION
    Use this when setting up a new development machine, or to refresh user-level skills
    from your canonical skill collection.

.PARAMETER SourceDir
    Directory containing per-skill folders (each with SKILL.md at minimum,
    optionally `agents/`, `references/`, etc.).

.PARAMETER NoOverwrite
    Skip skills that already exist in destination instead of overwriting.

.PARAMETER All
    Copy all skills found in source, not just the recommended set.

.EXAMPLE
    .\scripts\install-recommended-skills.ps1 -SourceDir C:\Dev\GauntletAI\AgentForge\.cache\foosaner_skills

.EXAMPLE
    .\scripts\install-recommended-skills.ps1 -SourceDir ~\Downloads\skills -All -NoOverwrite
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$SourceDir,

    [switch]$NoOverwrite,
    [switch]$All
)

$ErrorActionPreference = 'Stop'

# === The recommended skill set ===
$RecommendedSkills = @(
    'agent-review',
    'agent-team-setup',
    'ai-security-review',
    'engineering-interview',
    'frontend-skill',
    'llm-observability-review',
    'presearch-interview',
    'prd-checklist',
    'project-init',
    'synthetic-data-plan',
    'synthetic-data-review',
    'system-architecture-review',
    'weekly-prd'
)

if (-not (Test-Path $SourceDir -PathType Container)) {
    Write-Error "Source directory does not exist: $SourceDir"
    exit 1
}

$DestDir = Join-Path $env:USERPROFILE '.claude\skills'
New-Item -ItemType Directory -Path $DestDir -Force | Out-Null

Write-Host "Source directory: $SourceDir"
Write-Host "Destination:      $DestDir"
Write-Host ""

# === Decide which skills to copy ===
if ($All) {
    Write-Host "Mode: copying ALL skills found in source"
    $SkillsToCopy = Get-ChildItem -Path $SourceDir -Directory | ForEach-Object { $_.Name }
} else {
    Write-Host "Mode: copying recommended skills only (use -All to copy everything found)"
    $SkillsToCopy = $RecommendedSkills
}

# === Copy each skill ===
$Installed = @()
$Skipped = @()
$Missing = @()

foreach ($skill in $SkillsToCopy) {
    $src = Join-Path $SourceDir $skill
    $dest = Join-Path $DestDir $skill

    if (-not (Test-Path $src -PathType Container)) {
        $Missing += $skill
        continue
    }

    # Skip empty directories
    $contents = Get-ChildItem $src -Force
    if ($contents.Count -eq 0) {
        $Missing += "$skill (empty in source)"
        continue
    }

    if ((Test-Path $dest) -and $NoOverwrite) {
        $Skipped += "$skill (-NoOverwrite; already exists)"
        continue
    }

    if (Test-Path $dest) {
        Remove-Item $dest -Recurse -Force
    }

    Copy-Item -Path $src -Destination $dest -Recurse
    $Installed += $skill
}

# === Report ===
Write-Host ""
Write-Host "=== Installation report ==="
Write-Host ""

if ($Installed.Count -gt 0) {
    Write-Host "Installed ($($Installed.Count)):"
    $Installed | ForEach-Object { Write-Host "  - $_" }
}

if ($Skipped.Count -gt 0) {
    Write-Host ""
    Write-Host "Skipped ($($Skipped.Count)):"
    $Skipped | ForEach-Object { Write-Host "  - $_" }
}

if ($Missing.Count -gt 0) {
    Write-Host ""
    Write-Host "Missing from source ($($Missing.Count)):"
    $Missing | ForEach-Object { Write-Host "  - $_" }
    Write-Host ""
    Write-Host "  These are recommended but were not present in $SourceDir."
    Write-Host "  Install them manually or update `$RecommendedSkills in this script."
}

Write-Host ""
Write-Host "Done. Restart any open Claude Code sessions to pick up the new skills."
