#!/usr/bin/env bash
# Sets up per-lead git worktrees with .project/ + .claude/ junctions.
# Run AFTER /use-template has finished initial setup, from the main checkout.
# Idempotent: safe to re-run; skips worktrees / junctions that already exist.
#
# Result: sibling directories at ../BellMarkets-aria, -bram, -cleo, each a
# git worktree on its own branch with .project/ and .claude/ junctioned back
# to the main checkout (so coordination state stays single-source-of-truth).

set -euo pipefail

PROJECT_NAME="BellMarkets"
PROJECT_DIR="$(pwd)"
LEADS=(aria bram cleo drew)
BRANCH_PREFIX="crt"  # claude-red-team style; rename if desired

for lead in "${LEADS[@]}"; do
  WORKTREE_PATH="../${PROJECT_NAME}-${lead}"
  BRANCH="${BRANCH_PREFIX}/${lead}-init"

  if [[ -d "${WORKTREE_PATH}" ]]; then
    echo "Worktree ${WORKTREE_PATH} already exists; skipping creation"
  else
    echo "Creating worktree at ${WORKTREE_PATH} on branch ${BRANCH}"
    git worktree add "${WORKTREE_PATH}" -b "${BRANCH}"
  fi

  cd "${WORKTREE_PATH}"

  # Junction .project/
  if [[ ! -L .project ]] && [[ ! -d .project ]]; then
    if [[ "${OS:-}" == "Windows_NT" ]]; then
      cmd //c "mklink /J .project ..\\${PROJECT_NAME}\\.project"
    else
      ln -s "../${PROJECT_NAME}/.project" .project
    fi
    echo "  + junctioned .project/"
  else
    echo "  (.project/ already present; skipping)"
  fi

  # Junction .claude/
  if [[ ! -L .claude ]] && { [[ ! -d .claude ]] || [[ "$(ls -A .claude 2>/dev/null | wc -l)" -eq 0 ]]; }; then
    rm -rf .claude
    if [[ "${OS:-}" == "Windows_NT" ]]; then
      cmd //c "mklink /J .claude ..\\${PROJECT_NAME}\\.claude"
    else
      ln -s "../${PROJECT_NAME}/.claude" .claude
    fi
    echo "  + junctioned .claude/"
  else
    echo "  (.claude/ already present; skipping)"
  fi

  cd "${PROJECT_DIR}"
done

echo ""
echo "Done. Each lead now has its own worktree:"
git worktree list
echo ""
echo "Open Cursor in each worktree and run /aria, /bram, /cleo, /drew respectively."
echo ""
echo "REMINDER: ALWAYS remove junctions BEFORE 'git worktree remove' on Windows,"
echo "or rm-rf on the worktree will follow the junction and nuke the main checkout."
