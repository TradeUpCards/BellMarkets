#!/usr/bin/env python3
"""Append the deploy_index=6 entry to migrations/audit_log.jsonl.

Day-6 upgrade: bundles DR-015 verifier branching (commit a68c321) + P4
hardening (commit 5d80742) into a single redeploy. Same program ID; .so
grew marginally (759016 → 759632, +616 bytes from cargo update + P2 audit
docstring fixes + 3 conservation tests' code paths).

Run once post-deploy from the repo root:
    python3 migrations/bootstrap-p5/append-audit-log-6.py
"""
import json
import pathlib

ENTRY = {
    "timestamp": "2026-05-24T00:18:00Z",
    "deploy_index": 6,
    "deploy_type": "upgrade",
    "cluster": "devnet",
    "program_id": "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
    "program_data": "Erh54ewsrYEUYRewF8crqPi3VceUsrhwA329oL1MxVFj",
    "tx_signature": "2PQVK4pM3MNu1xQQpuMWdWLiBqMrMZ7jEKv3jgJ4mZ2NDTred37rLVcPFU4DHTZnLV2Mppgd7jejGG56M3bNZmSY",
    "deploy_slot": 464517905,
    "binary_size_bytes": 759632,
    "binary_size_kb": 741.83,
    "size_delta_bytes": 616,
    "program_data_rent_sol": 5.288,
    "deploy_cost_sol": 0.008,
    "cumulative_deploy_cost_sol": 5.306,
    "upgrade_authority": "9snc1xMYHPQbJuaybP98z6YS6xBbzhDTnXiNoKRawanZ",
    "upgrade_authority_balance_before_sol": 6.699,
    "upgrade_authority_balance_after_sol": 6.691,
    "git_sha": "5d80742",
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
        "Day-6 upgrade: source-tree-to-deployed-program lockstep. Bundles "
        "DR-015 multi-metric distribute_*_rewards verifier branching + "
        "P4 fee-pipeline conservation tests + 8 transitive Cargo.lock "
        "minor bumps. No new instructions; surface stays at 20 ix. "
        "distribute_weekly_rewards + distribute_monthly_rewards gained "
        "`metric_id: u8` arg (IDL-breaking for any existing tx builders; "
        "no live commit_leaderboard_root has been called yet so zero "
        "in-flight tx impact)."
    ),
    "changes": [
        "distribute_weekly_rewards + distribute_monthly_rewards: new `metric_id: u8` arg routes 32-bit claimed_bitmap into 4 disjoint per-metric 8-bit segments (DR-015). bit_index = metric_id × 8 + (position - 1).",
        "merkle.rs compute_leaf signature reordered to DR-015 47-byte format: sha256(user || metric_id || rank || amount || period_id_u32 || period_type). period_id narrowed u64 → u32 in the hash (deliberate DR-015 spec choice; off-chain Bram indexer must mirror).",
        "state.rs: 7 new DR-015 constants (METRIC_PROFIT/WIN_STREAK/WIN_RATE/ROI + METRIC_COUNT + BITS_PER_METRIC + POSITIONS_PER_METRIC). No new account types; LeaderboardEntry struct unchanged (claimed_bitmap stays u32).",
        "Helpers replaced (DR-015 verifier path): is_valid_metric_id + metric_position_bit + is_metric_position_claimed (was: is_valid_position + position_bit + is_position_claimed in P3).",
        "Position range narrowed from 1..=10 (P3 global) to 1..=8 per metric (DR-015 partition constraint with no PDA change). Top-10 distribution can return in v2 via [u32; 4] bitmap realloc.",
        "P4 hardening: 3 new fee-pipeline conservation property tests compose tier_fee_bps × mint_fee_bps scaling × creator_rebate × split_fee end-to-end. Asserts vault always receives `amount` (HARD YES #1) regardless of fee config; user_paid_total == amount + (platform + weekly + monthly).",
        "merkle.rs: leaf_hash_period_id_wraps_at_u32_max_boundary regression test pins deterministic wrap-from-u32::MAX-to-zero behavior (P2 audit G1 fix).",
        "Cargo.lock: 8 transitive minor bumps (autocfg 1.5.0→1.5.1, bumpalo 3.20.2→3.20.3, js-sys/wasm-bindgen 0.2.121→0.2.122 family, web-sys 0.3.98→0.3.99). All build-time/WASM-target only; irrelevant to BPF compile.",
        "P2 audit docstring fixes (commit 5363335): module-header comments in distribute_weekly_rewards.rs + merkle.rs rewritten to reflect DR-015 47-byte leaf format + 4×8 bitmap partition. Critical for Bram's indexer correctness — stale docs would have produced silently-failing proofs.",
        "ALT H1s61AcEuKfLBspPPUWCQTth7CqAhLfBQqDCvATTsQKP (8 standard accounts, frozen) live from prior session — not affected by this deploy.",
        "110/110 cargo test --lib pass. Zero §4.11 Stack offset warnings.",
    ],
    "notes": (
        "P3-from-prior-session ALT (H1s61AcEuKfLBspPPUWCQTth7CqAhLfBQqDCvATTsQKP) "
        "remains live + frozen — independent of this deploy. FeeConfig + "
        "WeeklyPool + MonthlyPool + LeaderboardCommitments PDAs from P5 "
        "deploy_index=5 bootstrap also unchanged (no bootstrap-p6 needed; "
        "this is a logic-only upgrade). Cross-lead: (Bram) off-chain "
        "Merkle leaf format MUST switch to DR-015 47-byte shape with "
        "period_id_u32 narrowing before he sends any commit_leaderboard_root "
        "+ distribute_*_rewards on the new program. (Cleo) buildClaimReward "
        "tx builder gains metric_id parameter; her demo doesn't exercise "
        "this path so no demo blocker. (Drew) live-deploy-verify ix-count "
        "assertion stays at 20; distribute_*_rewards arg shape changed "
        "(her mocked Aria interface needs metric_id update for property "
        "tests that exercise distribute paths). Deploy cost trivially "
        "low (0.008 SOL — .so grew only 616 bytes vs P5) thanks to no "
        "schema/PDA changes. Cumulative spend 5.306 SOL of original 10 "
        "SOL upgrade-authority funding."
    ),
}

target = pathlib.Path("migrations/audit_log.jsonl")
line = json.dumps(ENTRY, separators=(",", ":")) + "\n"
with target.open("a", encoding="utf-8") as f:
    f.write(line)
print(f"Appended {len(line)} bytes to {target}.")
