//! `initialize_config` — one-shot setup of the global `MarketConfig` PDA.
//!
//! Bounds on the three tunables (staleness, confidence, override delay) are
//! defensive — they prevent obviously-broken values from being stored even by
//! a trusted admin (e.g., fat-fingered "staleness = 0" which would reject
//! every Pyth price, locking every market into the admin-override path).
//! See the const block below for each bound's rationale.
//!
//! Idempotency: `#[account(init, ...)]` ensures this can only succeed once
//! per `[b"config"]` PDA. A second call fails at account allocation.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = MarketConfig::LEN,
        seeds = [b"config"],
        bump,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    /// CHECK: treasury token account address — validated by client; program
    /// only stores the pubkey for downstream payout flows.
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

// Sane outer bounds on tunable params. These are not the *operating* values
// (those are passed in by the admin at initialize time and stored on chain);
// they are the bounds that prevent obviously-broken values from being stored.
//   - staleness: 0 would always reject Pyth prices; 24h would let stale prices
//     settle markets. Allow 1..=24h.
//   - confidence: 0 would always reject any Pyth price; 10_000 bps (100%) means
//     no confidence check at all. Allow 1..=1000 (10%).
//   - override delay: 0 would let admin frontrun settle in the same block;
//     7 days is a defensible upper bound for human-intervention windows.
const MAX_STALENESS_SECS: i64 = 24 * 60 * 60;
const MAX_CONFIDENCE_BPS: u16 = 1_000;
const MAX_ADMIN_OVERRIDE_DELAY_SECS: i64 = 7 * 24 * 60 * 60;

pub fn handler(
    ctx: Context<InitializeConfig>,
    price_staleness_secs: i64,
    price_confidence_bps: u16,
    admin_override_delay_secs: i64,
) -> Result<()> {
    require!(
        price_staleness_secs > 0 && price_staleness_secs <= MAX_STALENESS_SECS,
        BellMarketsError::InvalidConfigParam
    );
    require!(
        price_confidence_bps > 0 && price_confidence_bps <= MAX_CONFIDENCE_BPS,
        BellMarketsError::InvalidConfigParam
    );
    require!(
        admin_override_delay_secs > 0 && admin_override_delay_secs <= MAX_ADMIN_OVERRIDE_DELAY_SECS,
        BellMarketsError::InvalidConfigParam
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.treasury = ctx.accounts.treasury.key();
    config.price_staleness_secs = price_staleness_secs;
    config.price_confidence_bps = price_confidence_bps;
    config.admin_override_delay_secs = admin_override_delay_secs;
    config.paused = false;
    config.bump = ctx.bumps.config;
    Ok(())
}
