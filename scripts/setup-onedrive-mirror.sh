#!/usr/bin/env bash
# Moves .project/ and .claude/ from the working tree into a OneDrive-synced
# folder, then junctions them back so the working tree (and slash commands)
# keep working. OneDrive becomes the source of truth; the working tree reads
# via junction.
#
# Run AFTER /use-template has finished initial setup, from the main checkout.
# Idempotent-ish: refuses to clobber existing OneDrive content. To re-run,
# manually rmdir the junctions and the OneDrive target dir first.
#
# Why: coordination state (kickoffs, handoffs, agent personas) must survive
# `rm -rf` of the working tree and cross-machine sync without git. OneDrive
# (or iCloud / Dropbox / Drive) handles that; git would expose internal
# coordination on the cohort/public mirror.

set -euo pipefail

PROJECT_DIR="$(pwd)"
PROJECT_NAME="$(basename "${PROJECT_DIR}")"

# Default OneDrive root for Cory's machines. Override by setting
# ONEDRIVE_ROOT before invoking the script.
ONEDRIVE_ROOT="${ONEDRIVE_ROOT:-/c/Users/${USER}/OneDrive/Documents/GauntletAI}"
ONEDRIVE_TARGET="${ONEDRIVE_ROOT}/${PROJECT_NAME}"

# Detect platform once.
if [[ "${OS:-}" == "Windows_NT" ]]; then
  PLATFORM="windows"
else
  PLATFORM="unix"
fi

echo "OneDrive mirror setup for ${PROJECT_NAME}"
echo "  source: ${PROJECT_DIR}/.project + .claude"
echo "  target: ${ONEDRIVE_TARGET}/.project + .claude"
echo "  platform: ${PLATFORM}"
echo ""

if [[ ! -d "${ONEDRIVE_ROOT}" ]]; then
  echo "✗ OneDrive root not found: ${ONEDRIVE_ROOT}"
  echo "  Either OneDrive isn't installed/synced or your path differs."
  echo "  Override with: ONEDRIVE_ROOT=/path/to/sync/folder $0"
  exit 1
fi

mkdir -p "${ONEDRIVE_TARGET}"

move_dir_to_onedrive () {
  local name="$1"          # ".project" or ".claude"
  local src="${PROJECT_DIR}/${name}"
  local dest="${ONEDRIVE_TARGET}/${name}"

  if [[ -L "${src}" ]]; then
    echo "[${name}] already a symlink/junction; skipping"
    return
  fi

  if [[ -e "${dest}" ]]; then
    echo "✗ [${name}] target already exists at ${dest}"
    echo "  refusing to clobber. Inspect manually then re-run."
    exit 1
  fi

  if [[ ! -d "${src}" ]]; then
    echo "[${name}] no source dir at ${src}; skipping"
    return
  fi

  echo "[${name}] moving to OneDrive..."
  mv "${src}" "${dest}"

  echo "[${name}] junctioning back to working tree..."
  if [[ "${PLATFORM}" == "windows" ]]; then
    # Windows mklink /J needs backslash paths.
    local win_dest
    win_dest="$(echo "${dest}" | sed 's|/c/|C:\\|' | tr '/' '\\')"
    local win_src
    win_src="$(echo "${src}" | sed 's|/c/|C:\\|' | tr '/' '\\')"
    cmd //c "mklink /J \"${win_src}\" \"${win_dest}\"" >/dev/null
  else
    ln -s "${dest}" "${src}"
  fi
  echo "[${name}] ✓ done"
}

move_dir_to_onedrive ".project"
move_dir_to_onedrive ".claude"

echo ""
echo "✓ OneDrive mirror set up."
echo ""
echo "What happened:"
echo "  - ${PROJECT_DIR}/.project  → junction → ${ONEDRIVE_TARGET}/.project"
echo "  - ${PROJECT_DIR}/.claude   → junction → ${ONEDRIVE_TARGET}/.claude"
echo ""
echo "Watch out for:"
echo "  - DO NOT 'rm -rf .project' from the working tree — it follows the junction"
echo "    and deletes the OneDrive source. To remove a junction safely:"
echo "      Windows: cmd //c \"rmdir .project\"   (no -Recurse flag!)"
echo "      Unix:    rm .project                  (symlinks unlink, don't recurse)"
echo "  - Mode 2 worktree junctions in scripts/setup-worktrees.sh now chain"
echo "    through this OneDrive junction. Should work transparently."
echo "  - First OneDrive sync may take a few minutes for small files."
