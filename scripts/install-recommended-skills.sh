#!/usr/bin/env bash
# install-recommended-skills.sh
#
# Bootstrap user-level Claude Code skills from a source directory into ~/.claude/skills/.
# Use this when setting up a new development machine, or to refresh user-level skills
# from your canonical skill collection.
#
# Usage:
#   scripts/install-recommended-skills.sh <source-dir>
#
# Where <source-dir> is a directory containing per-skill folders (each with SKILL.md
# at minimum, optionally `agents/`, `references/`, etc.).
#
# Example:
#   scripts/install-recommended-skills.sh ~/AgentForge/.cache/foosaner_skills
#   scripts/install-recommended-skills.sh ~/Downloads/my-skill-pack
#
# The script copies the skills listed in RECOMMENDED_SKILLS below from <source-dir>
# to ~/.claude/skills/. Skills in <source-dir> not in the recommended list are
# skipped (use --all to copy everything found).
#
# Idempotent: safely overwrites existing user-level copies (use --no-overwrite to skip).

set -euo pipefail

# === The recommended skill set ===
# These are the skills that pair well with claude-code-project-template's workflow.
# Adjust this list to taste.
RECOMMENDED_SKILLS=(
  agent-review
  agent-team-setup
  ai-security-review
  engineering-interview
  frontend-skill
  llm-observability-review
  presearch-interview
  prd-checklist
  project-init
  synthetic-data-plan
  synthetic-data-review
  system-architecture-review
  weekly-prd
)

# === Argument parsing ===
SOURCE_DIR="${1:-}"
OVERWRITE=true
COPY_ALL=false

# Simple flag parsing (no getopts to keep portable)
for arg in "$@"; do
  case "$arg" in
    --no-overwrite) OVERWRITE=false ;;
    --all) COPY_ALL=true ;;
    --help|-h)
      sed -n '2,/^set/p' "$0" | sed -n 's/^# //p;s/^#$//p'
      exit 0
      ;;
  esac
done

if [[ -z "${SOURCE_DIR}" ]]; then
  echo "Usage: $0 <source-dir> [--no-overwrite] [--all]" >&2
  echo "Run with --help for full documentation." >&2
  exit 1
fi

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "Error: source directory does not exist: ${SOURCE_DIR}" >&2
  exit 1
fi

DEST_DIR="${HOME}/.claude/skills"
mkdir -p "${DEST_DIR}"

# === Discover what's available in source ===
echo "Source directory: ${SOURCE_DIR}"
echo "Destination:      ${DEST_DIR}"
echo ""

# === Decide which skills to copy ===
if [[ "${COPY_ALL}" == "true" ]]; then
  echo "Mode: copying ALL skills found in source"
  SKILLS_TO_COPY=()
  for skill_dir in "${SOURCE_DIR}"/*/; do
    [[ -d "${skill_dir}" ]] || continue
    skill_name="$(basename "${skill_dir}")"
    SKILLS_TO_COPY+=("${skill_name}")
  done
else
  echo "Mode: copying recommended skills only (use --all to copy everything found)"
  SKILLS_TO_COPY=("${RECOMMENDED_SKILLS[@]}")
fi

# === Copy each skill ===
INSTALLED=()
SKIPPED=()
MISSING=()

for skill in "${SKILLS_TO_COPY[@]}"; do
  src="${SOURCE_DIR}/${skill}"
  dest="${DEST_DIR}/${skill}"

  if [[ ! -d "${src}" ]]; then
    MISSING+=("${skill}")
    continue
  fi

  # Skip empty directories (Foosaner cache had at least one)
  if [[ -z "$(ls -A "${src}" 2>/dev/null)" ]]; then
    MISSING+=("${skill} (empty in source)")
    continue
  fi

  if [[ -d "${dest}" ]] && [[ "${OVERWRITE}" == "false" ]]; then
    SKIPPED+=("${skill} (--no-overwrite; already exists)")
    continue
  fi

  if [[ -d "${dest}" ]]; then
    rm -rf "${dest}"
  fi

  cp -r "${src}" "${dest}"
  INSTALLED+=("${skill}")
done

# === Report ===
echo ""
echo "=== Installation report ==="
echo ""

if (( ${#INSTALLED[@]} > 0 )); then
  echo "✓ Installed (${#INSTALLED[@]}):"
  printf '  - %s\n' "${INSTALLED[@]}"
fi

if (( ${#SKIPPED[@]} > 0 )); then
  echo ""
  echo "↷ Skipped (${#SKIPPED[@]}):"
  printf '  - %s\n' "${SKIPPED[@]}"
fi

if (( ${#MISSING[@]} > 0 )); then
  echo ""
  echo "⚠ Missing from source (${#MISSING[@]}):"
  printf '  - %s\n' "${MISSING[@]}"
  echo ""
  echo "  These are recommended but were not present in ${SOURCE_DIR}."
  echo "  Install them manually or update RECOMMENDED_SKILLS in this script."
fi

echo ""
echo "Done. Restart any open Claude Code sessions to pick up the new skills."
echo "Verify with: in any Claude Code session, the skill list should now include them."
