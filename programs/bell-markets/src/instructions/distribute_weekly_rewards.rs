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

// ─── Pure helpers shared with distribute_monthly_rewards (P3 audit fix) ───
// Extracted to unit-test the position bounds + bitmap manipulation directly.
// Auditor flagged absence of boundary regression coverage on commit 4f58cf0.

/// Returns true iff `position` is a valid distribution slot (1..=DISTRIBUTION_SLOTS).
pub(crate) fn is_valid_position(position: u8) -> bool {
    position >= 1 && (position as usize) <= DISTRIBUTION_SLOTS
}

/// Compute the bitmap bit for a given position. `position` is 1..=10; bit i
/// (i = position - 1) tracks whether position i+1 has been claimed.
/// Returns 0 for invalid positions (caller validates upstream).
pub(crate) fn position_bit(position: u8) -> u32 {
    if !is_valid_position(position) {
        return 0;
    }
    1u32 << (position - 1)
}

/// Returns true iff `position` is already claimed in `bitmap`.
pub(crate) fn is_position_claimed(bitmap: u32, position: u8) -> bool {
    let bit = position_bit(position);
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
    position: u8,
    amount: u64,
    merkle_proof: Vec<[u8; 32]>,
) -> Result<()> {
    require!(is_valid_position(position), BellMarketsError::InvalidDistributionPosition);
    require!(amount > 0, BellMarketsError::ZeroAmount);

    let leaf = compute_leaf(
        &ctx.accounts.recipient.key(),
        position,
        period_id,
        PERIOD_TYPE_WEEKLY,
        amount,
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

        // Position-claim guard — second distribute for the same (period,
        // position) reverts MerkleProofInvalid (treat double-claim as
        // proof failure for the "unique distribution" invariant).
        require!(
            !is_position_claimed(entry.claimed_bitmap, position),
            BellMarketsError::MerkleProofInvalid
        );
        entry.claimed_bitmap |= position_bit(position);
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

    // ── is_valid_position (P3 audit fix) ──────────────────────────────

    #[test]
    fn position_accepts_1_to_10() {
        for p in 1u8..=10 {
            assert!(is_valid_position(p), "position {p} should be valid");
        }
    }

    #[test]
    fn position_rejects_zero() {
        assert!(!is_valid_position(0));
    }

    #[test]
    fn position_rejects_above_slots() {
        assert!(!is_valid_position(11));
        assert!(!is_valid_position(20));
        assert!(!is_valid_position(u8::MAX));
    }

    // ── position_bit ───────────────────────────────────────────────────

    #[test]
    fn position_bit_maps_to_correct_index() {
        assert_eq!(position_bit(1), 0b1);
        assert_eq!(position_bit(2), 0b10);
        assert_eq!(position_bit(10), 0b1000000000);
    }

    #[test]
    fn position_bit_returns_zero_for_invalid() {
        assert_eq!(position_bit(0), 0);
        assert_eq!(position_bit(11), 0);
        assert_eq!(position_bit(u8::MAX), 0);
    }

    // ── is_position_claimed (double-claim guard regression coverage) ───

    #[test]
    fn unclaimed_bitmap_returns_false_for_all_positions() {
        for p in 1u8..=10 {
            assert!(!is_position_claimed(0, p), "position {p} unclaimed in empty bitmap");
        }
    }

    #[test]
    fn claimed_bitmap_returns_true_for_set_position() {
        // Claim position 1 only.
        let bm = position_bit(1);
        assert!(is_position_claimed(bm, 1));
        // Positions 2..=10 are still unclaimed in this bitmap.
        for p in 2u8..=10 {
            assert!(!is_position_claimed(bm, p));
        }
    }

    #[test]
    fn claimed_bitmap_independent_positions() {
        // Claim positions 1, 5, 10.
        let bm = position_bit(1) | position_bit(5) | position_bit(10);
        assert!(is_position_claimed(bm, 1));
        assert!(is_position_claimed(bm, 5));
        assert!(is_position_claimed(bm, 10));
        // Positions 2, 3, 4, 6, 7, 8, 9 are unclaimed.
        for p in [2, 3, 4, 6, 7, 8, 9u8].iter().copied() {
            assert!(!is_position_claimed(bm, p), "position {p} should be unclaimed");
        }
    }

    #[test]
    fn double_claim_property_idempotent_bit_set() {
        // Property: marking the same position twice yields the same bitmap.
        let bm0 = 0u32;
        let bm1 = bm0 | position_bit(3);
        let bm2 = bm1 | position_bit(3);
        assert_eq!(bm1, bm2);
        assert!(is_position_claimed(bm2, 3));
    }
}

