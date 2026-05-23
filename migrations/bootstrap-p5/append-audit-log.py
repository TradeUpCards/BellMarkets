#!/usr/bin/env python3
"""Append the deploy_index=5 entry to migrations/audit_log.jsonl.

Run once post-deploy from the repo root:
    python3 migrations/bootstrap-p5/append-audit-log.py
"""
import json
import pathlib

# All scalar values verified manually against on-chain state (see commit message
# of the audit-log commit that follows for the verification trail).
ENTRY = {
    "timestamp": "2026-05-23T06:35:00Z",
    "deploy_index": 5,
    "deploy_type": "upgrade",
    "cluster": "devnet",
    "program_id": "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
    "program_data": "Erh54ewsrYEUYRewF8crqPi3VceUsrhwA329oL1MxVFj",
    "tx_signature": "4rQq81zAxwM9ME4qXdnhuMsJMHWqqwqU7A8aBqHm4urmKPkkw9PX8uupsHXifuhfMwWDNcYLeU4TGF3yCKrkGEss",
    "deploy_slot": 464349904,
    "binary_size_bytes": 759016,
    "binary_size_kb": 741.23,
    "size_delta_bytes": 312448,
    "program_data_rent_sol": 5.284,
    "deploy_cost_sol": 2.179,
    "cumulative_deploy_cost_sol": 5.298,
    "upgrade_authority": "9snc1xMYHPQbJuaybP98z6YS6xBbzhDTnXiNoKRawanZ",
    "upgrade_authority_balance_before_sol": 8.881,
    "upgrade_authority_balance_after_sol": 6.702,
    "git_sha": "49b126e",
    "git_branch": "crt/aria-init",
    "ix_count": 20,
    "account_count": 6,
    "error_variant_count": 41,
    "outcome_variants": 4,
    "toolchain": {
        "anchor_cli": "0.31.1",
        "solana_cli": "3.1.14",
        "rustc": "nightly-1.95.0",
        "host": "WSL Ubuntu-24.04",
    },
    "summary": (
        "Day-5 P1-P4 expansion: DR-005 user-funded strike PDA creation + "
        "TickerConfig; DR-007 trading-calendar expiry validation; DR-008 "
        "FeeConfig + UserConfig + tier discount + creator rebate + 3-way "
        "mint-pair fee split; DR-010 SHA256 Merkle reward pools + "
        "leaderboard commitments (zero_copy); P4 force_redeem + "
        "close_settled_market."
    ),
    "changes": [
        "NEW ix user_create_strike_market: permissionless rent-payer creation of StrikeMarket + yes/no mints + USDC vault (DR-005 Meteora DLMM pattern). Validates tick alignment, +/- max_user_strike_deviation_bps of LIVE Pyth spot (via vendored oracle), expiry at 1/4 PM ET (EDT/EST), 7-day horizon, Phoenix v1 magic prefix.",
        "NEW ix update_ticker_config: admin per-Pyth-feed TickerConfig PDA (cap_center, allowed_strikes[16], strike_count, max_user_strike_deviation_bps, strike_tick_size, threshold_bps). init_if_needed. strike_count > 0 footgun guard (P1-audit fix).",
        "StrikeMarket gains creator: Pubkey + pairs_outstanding: u64. Bytes claimed from prior 64-byte _reserved (now 24). LEN unchanged; pre-DR-008 markets read existing zero bytes as the correct admin-origin / zero-pairs sentinels.",
        "NEW admin ix initialize_fee_config + update_fee_config: FeeConfig PDA (separate singleton, sidesteps destructive MarketConfig realloc on existing devnet PDA). Shared validate_fee_params enforces sum-to-10000 on pool split + both distribution arrays + bps bounds + force_redeem_grace_secs > 0.",
        "mint_pair rewrite: init_if_needed UserConfig (per (config,user) mint_volume_30d + lifetime + linear decay); compute tier_bps from decayed volume; SCALE proportionally vs mint_fee_bps as tier-1 anchor (preserves tier differentiation in promo/high-fee — P2 audit fix); apply creator-rebate if signer == strike_market.creator + outcome == Unsettled; 3-way split fee to (treasury_ata, weekly_pool, monthly_pool); transfer amount USDC -> vault (the $1 invariant, untouched); mint amount YES + amount NO; increment pairs_outstanding; ANTI-GAMING SAFEGUARD: only update mint_volume_30d if !creator_rebate_fires.",
        "redeem / redeem_pair / redeem_invalid: each decrement pairs_outstanding (saturating_sub for safety on pre-DR-008 markets).",
        "NEW admin ix initialize_rewards_pools: one-shot creates WeeklyRewardsPool + MonthlyRewardsPool USDC token accounts (self-authority PDA owns its own balance) + LeaderboardCommitments zero-copy PDA.",
        "NEW admin ix commit_leaderboard_root: writes (period_id, period_type, merkle_root, arweave_tx_id) into 24-entry ring buffer. Handler delegates field writes to write_entry_fields helper for unit-testable bitmap-reset coverage (P4-audit fix).",
        "NEW admin ix distribute_weekly_rewards + distribute_monthly_rewards: verify SHA256 Merkle proof against committed root + per-position single-claim via 32-bit claimed_bitmap + transfer amount USDC from pool -> recipient via pool PDA signer seeds.",
        "NEW merkle.rs: compute_leaf (sha256 of recipient || position || period_id || period_type || amount, LE-encoded) + verify_merkle_proof (sorted-pair OpenZeppelin style, fixed 64-byte buffer, depth bound 16).",
        "LeaderboardCommitments uses #[account(zero_copy)] + repr(C) + bytemuck::Pod. 24 entries x 104 bytes (2400+ on-chain). Standard #[account] would overrun BPF 4096-byte stack per §4.11. Explicit _trailing_pad fields satisfy bytemuck no-padding rule.",
        "NEW admin ix force_redeem: post-grace (default 30 days) admin sweep of stranded balances. Burns user winning tokens (strike_market PDA as delegate via user pre-Approve), transfers USDC vault -> user (NOT to admin), decrements pairs_outstanding. v2.5 gap documented: no Invalid-market sweep path yet.",
        "NEW permissionless ix close_settled_market: gated on outcome != Unsettled + pairs_outstanding == 0 + explicit usdc_vault.amount == 0 (P4-audit fix: surfaces dust-attack griefing with MarketNotEmpty instead of raw SPL Token error). Closes USDC vault -> fee_collector receives rent. Mints + StrikeMarket left alive (mint close blocked by SPL Token supply > 0 requirement; StrikeMarket as tombstone per spec).",
        "errors.rs: 15 new variants. InvalidOutcomeForRedeem msg updated to disambiguate Unsettled vs Invalid (P4-audit fix).",
        "Cargo.toml: bytemuck = '1' features=['derive'] added — required by Anchor 0.31 zero_copy macro (not re-exported through anchor_lang).",
        "Pre-deploy SOL transfer 2 SOL from platform admin (7b17F2wo...) to upgrade authority (9snc1xMY...) tx 3rMQ5gcvYLeB85WANCvPGj5RKhypTjRNXdP383EGuQUSqutwrKKnr4MMmxG5ScVLrfBt2U6q1XXCZmcrQoVMvRor — new 758 KB .so needs ~5.3 SOL buffer rent upfront vs upgrade authority pre-deploy 6.88 SOL.",
        "Post-deploy bootstrap-p5 binary ran: initialize_fee_config tx 2DR8Y5cBCib2Jo8WCxvdsXR3f9789avDTFaR36UWBFw6xrfs4YVTJ8wNoog7NkukR5hwUFKVYnkSKkzYNJMu91hw + initialize_rewards_pools tx 3LbhygYwv3fvz6ktG7qepAd3dVPdyJzvGEHczL8ksqyERwG9HVvC5TaN4mjrXe5ntZYadZMoc6gDVUuaqpdcjKiw. New PDAs live: FeeConfig 4xMt4J2WuLFH77Jq3Yexxuv38Ge36fNnWNRmSKLCiT3c / WeeklyPool 2VWzrhmdNZN7Yxv2uknYBurJ2PDFzCqsyi5WVeVxJpCW / MonthlyPool Eppjny6RMtVrGxZnjiKEyk41vwWYpXW4PMVKJHC4SAjh / Leaderboard FxohonFj6bTtbPxe4HNjwy736sqkyPfKj5GRektScF7C.",
        "100/100 cargo test --lib pass. Zero §4.11 Stack-offset warnings.",
        "4 independent Sonnet audits across P1-P4: P1 PASS w/ 2 backport fixes; P2 PASS w/ tier-semantics fix (applied in P3 commit); P3 NEEDS-FOLLOWUP w/ test gaps (fixed in P4 commit); P4 BLOCK w/ 3 fixes (close_settled vault check + error msg + real bitmap test) all applied in commit 49b126e before this deploy.",
    ],
    "notes": (
        "P5 bundles 4 days of DR work into one cutover. Cross-lead impacts: "
        "(Bram) mint_pair Accounts struct grew 11 -> 17 accounts; his tx "
        "builders need fee_config + user_config + fee_collector_usdc + "
        "weekly_pool + monthly_pool refs from this deploy forward. "
        "(Cleo) same — buildMintPair / buildBuyYes / buildSellNo tx "
        "builders all need new accounts; 20-ix IDL refresh required. "
        "(Drew) live-deploy-verify ix-count assertion needs bump from "
        "9-or-10 to exactly 20; her live-program-call tests still hit the "
        "pre-existing 7 META markets which now read creator=Pubkey::default() "
        "+ pairs_outstanding=0 (zero-init correct). Pre-deploy mint_fee_bps=0 "
        "default preserves Day-1 demo behavior (no fee transfers fire even "
        "though accounts are required). force_redeem is INFRASTRUCTURE-only "
        "on this deploy — user Approve flow lives in Cleo's UI roadmap. "
        "Cumulative deploys to date: 5 (Day-1 initial + Day-2 fill + Day-3 "
        "redeem_invalid + Day-4 redeem_pair + Day-5 P1-P4 expansion). "
        "Cumulative spend 5.298 SOL of original 10 SOL upgrade-authority "
        "funding."
    ),
}

target = pathlib.Path("migrations/audit_log.jsonl")
line = json.dumps(ENTRY, separators=(",", ":")) + "\n"
with target.open("a", encoding="utf-8") as f:
    f.write(line)
print(f"Appended {len(line)} bytes to {target}.")
