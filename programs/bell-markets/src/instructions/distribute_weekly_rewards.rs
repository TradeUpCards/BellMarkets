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
    require!(
        position >= 1 && (position as usize) <= DISTRIBUTION_SLOTS,
        BellMarketsError::InvalidDistributionPosition
    );
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

        // Position is 1..=10; bit (position - 1) tracks claim state.
        let bit = 1u32 << (position - 1);
        require!(
            entry.claimed_bitmap & bit == 0,
            BellMarketsError::MerkleProofInvalid
        );
        entry.claimed_bitmap |= bit;
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
