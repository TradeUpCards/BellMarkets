//! `distribute_weekly_rewards` — admin transfers `amount` USDC from the
//! WeeklyRewardsPool to a recipient, gated by a Merkle proof against the
//! committed root for (period_id, PERIOD_TYPE_WEEKLY).
//!
//! Per-position single-claim semantics: `LeaderboardEntry.claimed_bitmap`
//! tracks which of the 10 positions (bits 0..9) have been distributed. A
//! second distribute for the same (period, position) reverts with
//! `MerkleProofInvalid` (we treat double-claim as proof failure for the
//! generic invariant "this distribution is unique per period/position").
//!
//! Leaf format (from `merkle::compute_leaf`):
//!   sha256(recipient || position || period_id || period_type || amount)
//!
//! Bram's indexer builds the off-chain tree using the same leaf shape +
//! sorted-pair internal-node concat (see `merkle.rs`).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::BellMarketsError;
use crate::merkle::{compute_leaf, verify_merkle_proof};

// ─── Pure helpers shared with distribute_monthly_rewards ──────────────────
//
// P3 audit fix established `is_valid_position` / `position_bit` /
// `is_position_claimed` as a global single-bitmap scheme (top-10 positions
// across the entire entry). DR-015 changes this: the 32-bit bitmap is
// now PARTITIONED into 4 per-metric segments of 8 bits each.
//
//   bit_index = metric_id × BITS_PER_METRIC + (position - 1)
//
// Each (metric_id, position) pair claims a unique bit. Claiming position 1
// for METRIC_PROFIT (bit 0) is independent of claiming position 1 for
// METRIC_WIN_STREAK (bit 8). This implements DR-015's "per-metric
// claimed_bitmap segments" guarantee with zero schema change to the existing
// `LeaderboardEntry.claimed_bitmap: u32`.
//
// All helpers preserve the P3-audit-validated property: invalid (metric_id,
// position) tuples produce bit 0 (a no-op when OR'd; the caller's
// `require!(is_valid_*, ...)` guards prevent reaching that path).

/// Returns true iff `metric_id` is one of the 4 v1-spec metrics.
pub(crate) fn is_valid_metric_id(metric_id: u8) -> bool {
    metric_id < METRIC_COUNT
}

/// Returns true iff `position` is a valid distribution slot within the
/// per-metric segment (1..=POSITIONS_PER_METRIC). DR-015 narrows the v1
/// claimable positions to 8 per metric (was 10 globally in P3) — a
/// trade-off for the no-PDA-change constraint. Top-10 distribution can
/// return in v2 via a `claimed_bitmaps: [u32; 4]` realloc.
pub(crate) fn is_valid_position(position: u8) -> bool {
    position >= 1 && position <= POSITIONS_PER_METRIC
}

/// Compute the bitmap bit for a given (metric_id, position) tuple.
/// Returns 0 for invalid tuples — callers must validate upstream via
/// `is_valid_metric_id` + `is_valid_position` before relying on a non-zero bit.
pub(crate) fn metric_position_bit(metric_id: u8, position: u8) -> u32 {
    if !is_valid_metric_id(metric_id) || !is_valid_position(position) {
        return 0;
    }
    let bit_index = metric_id * BITS_PER_METRIC + (position - 1);
    1u32 << bit_index
}

/// Returns true iff `(metric_id, position)` has been claimed in `bitmap`.
pub(crate) fn is_metric_position_claimed(bitmap: u32, metric_id: u8, position: u8) -> bool {
    let bit = metric_position_bit(metric_id, position);
    bit != 0 && (bitmap & bit) != 0
}

#[derive(Accounts)]
pub struct DistributeWeeklyRewards<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        seeds = [b"leaderboard_commits"],
        bump,
        constraint = leaderboard_commits.load()?.config == config.key()
            @ BellMarketsError::ConfigMismatch,
    )]
    pub leaderboard_commits: AccountLoader<'info, LeaderboardCommitments>,

    #[account(
        mut,
        seeds = [b"weekly_pool"],
        bump,
    )]
    pub weekly_pool: Box<Account<'info, TokenAccount>>,

    /// CHECK: recipient wallet pubkey — only the binding check fires here
    /// (`recipient_token.owner == recipient.key()`), so the wallet account
    /// itself isn't deserialized.
    pub recipient: UncheckedAccount<'info>,

    /// Recipient's USDC ATA. Must be owned by `recipient` to bind the
    /// merkle-leaf identity to the actual transfer target.
    #[account(
        mut,
        token::mint = weekly_pool.mint,
        constraint = recipient_token.owner == recipient.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub recipient_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<DistributeWeeklyRewards>,
    period_id: u64,
    metric_id: u8,
    position: u8,
    amount: u64,
    merkle_proof: Vec<[u8; 32]>,
) -> Result<()> {
    require!(is_valid_metric_id(metric_id), BellMarketsError::InvalidDistributionPosition);
    require!(is_valid_position(position), BellMarketsError::InvalidDistributionPosition);
    require!(amount > 0, BellMarketsError::ZeroAmount);

    let leaf = compute_leaf(
        &ctx.accounts.recipient.key(),
        metric_id,
        position,
        amount,
        period_id,
        PERIOD_TYPE_WEEKLY,
    );

    let weekly_pool_bump = ctx.bumps.weekly_pool;

    {
        let mut lb = ctx.accounts.leaderboard_commits.load_mut()?;
        // Linear scan for matching (period_id, period_type=Weekly)
        let mut found_idx: Option<usize> = None;
        for (i, entry) in lb.entries.iter().enumerate() {
            if entry.period_id == period_id && entry.period_type == PERIOD_TYPE_WEEKLY {
                found_idx = Some(i);
                break;
            }
        }
        let idx = found_idx.ok_or(BellMarketsError::LeaderboardRootNotFound)?;
        let entry = &mut lb.entries[idx];

        require!(
            verify_merkle_proof(leaf, &merkle_proof, entry.merkle_root)?,
            BellMarketsError::MerkleProofInvalid
        );

        // Per-metric claim guard — second distribute for the same (period,
        // metric, position) reverts MerkleProofInvalid. Claiming
        // (metric=PROFIT, pos=1) does NOT mark (metric=STREAK, pos=1)
        // as claimed — the bit indices are disjoint per DR-015 partition.
        require!(
            !is_metric_position_claimed(entry.claimed_bitmap, metric_id, position),
            BellMarketsError::MerkleProofInvalid
        );
        entry.claimed_bitmap |= metric_position_bit(metric_id, position);
    } // drop borrow on leaderboard_commits before token CPI

    // Transfer `amount` USDC from weekly_pool → recipient_token.
    // Authority is the weekly_pool PDA itself (self-authority).
    let bump_arr = [weekly_pool_bump];
    let seeds: &[&[u8]] = &[b"weekly_pool", bump_arr.as_ref()];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.weekly_pool.to_account_info(),
                to: ctx.accounts.recipient_token.to_account_info(),
                authority: ctx.accounts.weekly_pool.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_valid_metric_id (DR-015) ────────────────────────────────────

    #[test]
    fn metric_id_accepts_the_4_v1_metrics() {
        assert!(is_valid_metric_id(METRIC_PROFIT));        // 0
        assert!(is_valid_metric_id(METRIC_WIN_STREAK));    // 1
        assert!(is_valid_metric_id(METRIC_WIN_RATE));      // 2
        assert!(is_valid_metric_id(METRIC_ROI));           // 3
    }

    #[test]
    fn metric_id_rejects_unknown() {
        assert!(!is_valid_metric_id(METRIC_COUNT));        // 4
        assert!(!is_valid_metric_id(5));
        assert!(!is_valid_metric_id(u8::MAX));
    }

    // ── is_valid_position (DR-015 narrowed to 1..=POSITIONS_PER_METRIC) ───

    #[test]
    fn position_accepts_1_to_per_metric_max() {
        for p in 1u8..=POSITIONS_PER_METRIC {
            assert!(is_valid_position(p), "position {p} should be valid");
        }
    }

    #[test]
    fn position_rejects_zero() {
        assert!(!is_valid_position(0));
    }

    #[test]
    fn position_rejects_above_per_metric_max() {
        // Per-metric cap is 8 (BITS_PER_METRIC == POSITIONS_PER_METRIC).
        assert!(!is_valid_position(POSITIONS_PER_METRIC + 1));
        assert!(!is_valid_position(10));
        assert!(!is_valid_position(u8::MAX));
    }

    // ── metric_position_bit (DR-015 partitioned bitmap) ────────────────

    #[test]
    fn metric_position_bit_partitions_correctly() {
        // Metric 0 (PROFIT) positions 1..=8 → bits 0..=7
        assert_eq!(metric_position_bit(METRIC_PROFIT, 1), 1u32 << 0);
        assert_eq!(metric_position_bit(METRIC_PROFIT, 8), 1u32 << 7);
        // Metric 1 (WIN_STREAK) positions 1..=8 → bits 8..=15
        assert_eq!(metric_position_bit(METRIC_WIN_STREAK, 1), 1u32 << 8);
        assert_eq!(metric_position_bit(METRIC_WIN_STREAK, 8), 1u32 << 15);
        // Metric 2 (WIN_RATE) positions 1..=8 → bits 16..=23
        assert_eq!(metric_position_bit(METRIC_WIN_RATE, 1), 1u32 << 16);
        assert_eq!(metric_position_bit(METRIC_WIN_RATE, 8), 1u32 << 23);
        // Metric 3 (ROI) positions 1..=8 → bits 24..=31
        assert_eq!(metric_position_bit(METRIC_ROI, 1), 1u32 << 24);
        assert_eq!(metric_position_bit(METRIC_ROI, 8), 1u32 << 31);
    }

    #[test]
    fn metric_position_bit_returns_zero_for_invalid_metric() {
        assert_eq!(metric_position_bit(METRIC_COUNT, 1), 0);
        assert_eq!(metric_position_bit(u8::MAX, 1), 0);
    }

    #[test]
    fn metric_position_bit_returns_zero_for_invalid_position() {
        assert_eq!(metric_position_bit(METRIC_PROFIT, 0), 0);
        assert_eq!(metric_position_bit(METRIC_PROFIT, POSITIONS_PER_METRIC + 1), 0);
        assert_eq!(metric_position_bit(METRIC_PROFIT, u8::MAX), 0);
    }

    #[test]
    fn metric_position_bit_property_disjoint_across_metric_x_position_grid() {
        // Property: every valid (metric, position) tuple maps to a UNIQUE bit.
        // No collisions across the 4 × 8 = 32 cells of the partition.
        use std::collections::HashSet;
        let mut seen: HashSet<u32> = HashSet::new();
        for m in 0..METRIC_COUNT {
            for p in 1u8..=POSITIONS_PER_METRIC {
                let bit = metric_position_bit(m, p);
                assert!(bit != 0, "(metric={m}, pos={p}) returned 0");
                assert!(seen.insert(bit), "bit collision at (metric={m}, pos={p}) — bit {bit:b}");
            }
        }
        // 32 unique bits → exactly fills u32 capacity.
        assert_eq!(seen.len(), 32);
    }

    // ── is_metric_position_claimed (per-metric independence guard) ─────

    #[test]
    fn empty_bitmap_no_claims_for_any_metric() {
        for m in 0..METRIC_COUNT {
            for p in 1u8..=POSITIONS_PER_METRIC {
                assert!(!is_metric_position_claimed(0, m, p),
                    "(metric={m}, pos={p}) wrongly claimed in empty bitmap");
            }
        }
    }

    #[test]
    fn claim_one_metric_position_doesnt_mark_other_metrics() {
        // CRITICAL DR-015 invariant: claim (METRIC_PROFIT, position=1) →
        // (METRIC_WIN_STREAK, position=1) is still UNCLAIMED.
        let bm = metric_position_bit(METRIC_PROFIT, 1);
        assert!(is_metric_position_claimed(bm, METRIC_PROFIT, 1));
        // Same position, different metric — must still be unclaimed.
        assert!(!is_metric_position_claimed(bm, METRIC_WIN_STREAK, 1));
        assert!(!is_metric_position_claimed(bm, METRIC_WIN_RATE, 1));
        assert!(!is_metric_position_claimed(bm, METRIC_ROI, 1));
        // Different position, same metric — must still be unclaimed.
        for p in 2u8..=POSITIONS_PER_METRIC {
            assert!(!is_metric_position_claimed(bm, METRIC_PROFIT, p));
        }
    }

    #[test]
    fn claim_all_4_metrics_at_position_1_uses_4_disjoint_bits() {
        let bm = metric_position_bit(METRIC_PROFIT, 1)
            | metric_position_bit(METRIC_WIN_STREAK, 1)
            | metric_position_bit(METRIC_WIN_RATE, 1)
            | metric_position_bit(METRIC_ROI, 1);
        // 4 bits set, all in their per-metric segments.
        assert_eq!(bm.count_ones(), 4);
        assert!(is_metric_position_claimed(bm, METRIC_PROFIT, 1));
        assert!(is_metric_position_claimed(bm, METRIC_WIN_STREAK, 1));
        assert!(is_metric_position_claimed(bm, METRIC_WIN_RATE, 1));
        assert!(is_metric_position_claimed(bm, METRIC_ROI, 1));
        // Other positions on those metrics remain unclaimed.
        for m in 0..METRIC_COUNT {
            for p in 2u8..=POSITIONS_PER_METRIC {
                assert!(!is_metric_position_claimed(bm, m, p));
            }
        }
    }

    #[test]
    fn full_capacity_claim_fills_bitmap() {
        // Property: claiming all 4 metrics × 8 positions sets all 32 bits.
        let mut bm = 0u32;
        for m in 0..METRIC_COUNT {
            for p in 1u8..=POSITIONS_PER_METRIC {
                bm |= metric_position_bit(m, p);
            }
        }
        assert_eq!(bm, u32::MAX);
        assert_eq!(bm.count_ones(), 32);
    }

    #[test]
    fn double_claim_property_idempotent_bit_set() {
        // Property: marking the same (metric, position) twice yields the same bitmap.
        let bm0 = 0u32;
        let bm1 = bm0 | metric_position_bit(METRIC_PROFIT, 3);
        let bm2 = bm1 | metric_position_bit(METRIC_PROFIT, 3);
        assert_eq!(bm1, bm2);
        assert!(is_metric_position_claimed(bm2, METRIC_PROFIT, 3));
    }
}

