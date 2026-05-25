//! `update_usdc_mint` — admin ix to swap `MarketConfig.usdc_mint` to a new
//! mint without redeploying the program.
//!
//! Unlocks DR-020's "bUSDC swap" path — Bram needs to flip from Circle's
//! devnet USDC to a self-controlled bUSDC demo mint without redeploying.
//!
//! ## Side effects on existing strikes
//!
//! Existing `StrikeMarket`s have `usdc_vault.mint` bound at creation time
//! to whatever `MarketConfig.usdc_mint` was THEN. After this ix flips
//! `usdc_mint`, the existing strikes' vaults still contain the old mint —
//! `mint_pair` against them will fail (`has_one = usdc_mint` mismatch) but
//! `redeem` paths that don't strictly check usdc_mint should still work.
//!
//! Per DR-020 explicit acceptance: "The 7 legacy META strikes (deploy_index=6)
//! become trade-inert after the USDC mint flip — their vaults hold Circle
//! USDC, config will say bUSDC. Acceptable per the pivot scope." Devnet
//! only; no real funds at risk.

use anchor_lang::prelude::*;
use crate::errors::BellMarketsError;
use crate::state::MarketConfig;

#[derive(Accounts)]
pub struct UpdateUsdcMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
    )]
    pub config: Box<Account<'info, MarketConfig>>,
}

pub fn handler(ctx: Context<UpdateUsdcMint>, new_mint: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.usdc_mint = new_mint;
    Ok(())
}
