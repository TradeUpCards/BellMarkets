#!/usr/bin/env bash
# one-command-demo.sh — PRD's reproducible lifecycle path.
#
# Hard YES #2: the full lifecycle is demoable end-to-end with one command.
# Drew owns. Day-1 status (Thu 2026-05-21): SKELETON ONLY. Actual implementation
# lands Sun 2026-05-24 — depends on Aria's devnet deploy script (Sat 5/23) +
# Bram's morning create-markets script + Cleo's frontend dev server.
#
# Demo flow when complete:
#   1. Verify env (Solana CLI 3.1.14, anchor 0.31.1, pnpm, node ≥ 20)
#   2. Deploy program to devnet (calls Aria's scripts/devnet-deploy.sh)
#   3. Run morning create-markets job manually (Bram's services/automation entrypoint)
#   4. Run the compressed-time simulation (Phase 0-5) against the real program
#   5. Trigger settle_market manually from a NON-ADMIN wallet (cron-failure demo path / Hard YES #5)
#   6. Verify all redemptions completed; vault drained to ~0
#
# Run from repo root:  bash scripts/one-command-demo.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "── BellMarkets one-command demo ─────────────────────────────"
echo "   Day-1 status: skeleton. Actual demo lands Sun 2026-05-24."
echo ""

# ── Step 1: Verify env ─────────────────────────────────────────────────
echo "[1/6] Verifying environment..."
# TODO(drew, Sun 5/24): assert tool versions
#   solana --version          # expect 3.1.14
#   anchor --version          # expect 0.31.1
#   pnpm --version            # expect 9.12.1 (from monorepo-config.md)
#   node --version            # expect ≥ 20.10.0
#   Exit non-zero with actionable error if any tool is missing.
echo "  TODO: tool version checks"

# ── Step 2: Deploy program to devnet ───────────────────────────────────
echo "[2/6] Deploying Anchor program to devnet..."
# TODO(drew + aria, Sat 5/23): call Aria's deploy script
#   bash scripts/devnet-deploy.sh
#   # Aria's script does: anchor build, anchor deploy --provider.cluster devnet,
#   # exports PROGRAM_ID, copies IDL into apps/web/src/idl/ and tests/integration/.
#   # Asserts no "Stack offset exceeded" warnings (hard-rules.md §4.11).
echo "  TODO: scripts/devnet-deploy.sh"

# ── Step 3: Run morning create-markets job manually ────────────────────
echo "[3/6] Running morning create-markets job..."
# TODO(drew + bram, Sun 5/24): invoke Bram's automation service in CLI mode
#   pnpm --filter @bell-markets/automation morning:run
#   # Reads previous-day close for each MAG7 ticker, computes ±3/6/9% strikes,
#   # calls create_strike_market for each. Logs to stdout; alerts on failure.
echo "  TODO: pnpm --filter @bell-markets/automation morning:run"

# ── Step 4: Run the compressed-time simulation ─────────────────────────
echo "[4/6] Running compressed-time lifecycle simulation..."
# TODO(drew, Sat 5/23): swap the inline mock in simulate-trading-day.mjs for
# real @coral-xyz/anchor 0.30.1 calls against the deployed program. Then:
#   node scripts/simulate-trading-day.mjs --outcome=yes_wins
#   # 60s simulated trading day, 3 wallets, real on-chain finality.
node scripts/simulate-trading-day.mjs

# ── Step 5: Trigger settle_market from a NON-ADMIN wallet (cron-failure path) ──
echo "[5/6] Cron-failure demo path: trigger settle_market from a user wallet..."
# TODO(drew + bram, Sun 5/24): kill the Bram automation cron mid-settle (or just
# don't start it), then have a test user wallet crank settle_market. This is
# load-bearing evidence for DR-002. Hard YES #5.
#
#   # Step 5a: ensure Bram's settlement-nudger is NOT running
#   #   (Day-1: we just describe the path; demo step is "open Trigger.dev dashboard, pause job")
#   # Step 5b: from a non-admin keypair, call settle_market via Anchor CLI
#   #   pnpm --filter @bell-markets/tests crank-settle --market=<id> --wallet=keys/devnet-user-1.json
#   # Step 5c: assert market.outcome is Some(...) and was set by the non-admin signer.
echo "  TODO: cron-failure crank from user wallet (see docs/demo/cron-failure-script.md)"

# ── Step 6: Verify all redemptions completed ───────────────────────────
echo "[6/6] Verifying redemptions completed..."
# TODO(drew, Sun 5/24): for each market created in Step 3, fetch the vault PDA
# balance and assert it's drained to ~0 (modulo dust). Cross-check against
# `pairs_outstanding` on the StrikeMarket account.
#   pnpm --filter @bell-markets/tests verify-redemptions
echo "  TODO: verify-redemptions script"

echo ""
echo "── Demo run complete ──"
echo ""
echo "Note: this skeleton runs the simulation against an INLINE MOCK of Aria's"
echo "program. Sat 5/23 the simulation is rewired to call the real deployed"
echo "program; the rest of this script's steps come online progressively."
