//! `distribute_monthly_rewards` — admin transfers `amount` USDC from the
//! MonthlyRewardsPool to a recipient, gated by a Merkle proof against the
//! committed root for (period_id, PERIOD_TYPE_MONTHLY).
//!
//! Identical shape to `distribute_weekly_rewards` (the two ixs differ only
//! in: pool PDA seed (`b"monthly_pool"` vs `b"weekly_pool"`) and period_type
//! constant). Kept as separate ixs (rather than parameterized) per Tate's
//! prompt — clearer for downstream consumers + each gets its own IDL entry
//! for ergonomic tx-building.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::BellMarketsError;
use crate::merkle::{compute_leaf, verify_merkle_proof};
use crate::instructions::distribute_weekly_rewards::{is_valid_position, is_position_claimed, position_bit};

#[derive(Accounts)]
pub struct DistributeMonthlyRewards<'info> {
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
        seeds = [b"monthly_pool"],
        bump,
    )]
    pub monthly_pool: Box<Account<'info, TokenAccount>>,

    /// CHECK: recipient wallet pubkey — only the binding check fires here.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = monthly_pool.mint,
        constraint = recipient_token.owner == recipient.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub recipient_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<DistributeMonthlyRewards>,
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
        PERIOD_TYPE_MONTHLY,
        amount,
    );

    let monthly_pool_bump = ctx.bumps.monthly_pool;

    {
        let mut lb = ctx.accounts.leaderboard_commits.load_mut()?;
        let mut found_idx: Option<usize> = None;
        for (i, entry) in lb.entries.iter().enumerate() {
            if entry.period_id == period_id && entry.period_type == PERIOD_TYPE_MONTHLY {
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

        require!(
            !is_position_claimed(entry.claimed_bitmap, position),
            BellMarketsError::MerkleProofInvalid
        );
        entry.claimed_bitmap |= position_bit(position);
    }

    let bump_arr = [monthly_pool_bump];
    let seeds: &[&[u8]] = &[b"monthly_pool", bump_arr.as_ref()];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.monthly_pool.to_account_info(),
                to: ctx.accounts.recipient_token.to_account_info(),
                authority: ctx.accounts.monthly_pool.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    Ok(())
}
