//! `initialize_fee_config` — one-shot setup of the global `FeeConfig` PDA.
//!
//! Carries all DR-008 + DR-010 economic parameters in a separate PDA from
//! `MarketConfig` to sidestep a destructive realloc of the existing devnet
//! config PDA at `6CYzWhTM...`. The shape mirrors `initialize_config`'s
//! defensive-bounds pattern.
//!
//! Idempotency: `#[account(init, ...)]` ensures this can only succeed once
//! per `[b"fee_config"]` PDA. A second call fails at account allocation.
//! Subsequent parameter updates flow through `update_fee_config` (admin).

use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct InitializeFeeConfig<'info> {
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
        init,
        payer = admin,
        space = FeeConfig::LEN,
        seeds = [b"fee_config"],
        bump,
    )]
    pub fee_config: Box<Account<'info, FeeConfig>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeFeeConfig>,
    mint_fee_bps: u16,
    platform_retain_bps: u16,
    weekly_pool_bps: u16,
    monthly_pool_bps: u16,
    creator_rebate_bps: u16,
    force_redeem_grace_secs: i64,
    weekly_distribution_bps: [u16; 10],
    monthly_distribution_bps: [u16; 10],
) -> Result<()> {
    crate::instructions::update_fee_config::validate_fee_params(
        mint_fee_bps,
        platform_retain_bps,
        weekly_pool_bps,
        monthly_pool_bps,
        creator_rebate_bps,
        force_redeem_grace_secs,
        &weekly_distribution_bps,
        &monthly_distribution_bps,
    )?;

    let fc = &mut ctx.accounts.fee_config;
    fc.config = ctx.accounts.config.key();
    fc.mint_fee_bps = mint_fee_bps;
    fc.platform_retain_bps = platform_retain_bps;
    fc.weekly_pool_bps = weekly_pool_bps;
    fc.monthly_pool_bps = monthly_pool_bps;
    fc.creator_rebate_bps = creator_rebate_bps;
    fc.force_redeem_grace_secs = force_redeem_grace_secs;
    fc.weekly_distribution_bps = weekly_distribution_bps;
    fc.monthly_distribution_bps = monthly_distribution_bps;
    fc.bump = ctx.bumps.fee_config;
    Ok(())
}
