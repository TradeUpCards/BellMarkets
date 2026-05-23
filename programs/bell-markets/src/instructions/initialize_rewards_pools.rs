//! `initialize_rewards_pools` — one-shot admin init of:
//!   - `WeeklyRewardsPool`  — USDC token account at seeds [b"weekly_pool"],
//!     authority = self (PDA owns its own balance)
//!   - `MonthlyRewardsPool` — same shape at seeds [b"monthly_pool"]
//!   - `LeaderboardCommitments` zero-copy account at seeds [b"leaderboard_commits"]
//!
//! Pre-conditions:
//!   - `MarketConfig` exists (admin-bound)
//!   - `FeeConfig` exists (binds the bps fields that mint_pair reads)
//!
//! Idempotency: each `init` constraint is one-shot per PDA. Second call fails
//! at account allocation. Admin runs this exactly once post-deploy. (Demo
//! note: without this, mint_pair fails AccountNotInitialized on the pool
//! token accounts — even when mint_fee_bps == 0 because the Accounts struct
//! still requires deserialization.)

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct InitializeRewardsPools<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    /// FeeConfig must exist before pools are initialized (binding check).
    #[account(
        seeds = [b"fee_config"],
        bump = fee_config.bump,
        constraint = fee_config.config == config.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub fee_config: Box<Account<'info, FeeConfig>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"weekly_pool"],
        bump,
        token::mint = usdc_mint,
        token::authority = weekly_pool,
    )]
    pub weekly_pool: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"monthly_pool"],
        bump,
        token::mint = usdc_mint,
        token::authority = monthly_pool,
    )]
    pub monthly_pool: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        space = 8 + LeaderboardCommitments::LEN,
        seeds = [b"leaderboard_commits"],
        bump,
    )]
    pub leaderboard_commits: AccountLoader<'info, LeaderboardCommitments>,

    pub usdc_mint: Box<Account<'info, Mint>>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializeRewardsPools>) -> Result<()> {
    let lb = &mut ctx.accounts.leaderboard_commits.load_init()?;
    lb.config = ctx.accounts.config.key();
    lb.next_slot = 0;
    lb.bump = ctx.bumps.leaderboard_commits;
    // entries[] and _reserved are already zeroed by Anchor's init allocation.
    Ok(())
}
