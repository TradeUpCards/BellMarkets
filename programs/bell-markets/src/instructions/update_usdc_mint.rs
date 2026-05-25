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
//!
//! ## CAUTION — resting bid stranding on old-mint strikes
//!
//! Audit-LOW finding (Sonnet defense-in-depth audit on `acf2602`): any
//! resting BIDS on old-mint StrikeMarkets become un-cancellable after this
//! flip. `cancel_order`'s Accounts struct includes
//! `usdc_escrow: token::mint = usdc_mint` — after the flip, `usdc_mint` is
//! the new mint but the old strike's escrow account carries the old mint, so
//! Anchor's `token::mint` constraint fails before the handler runs. Users
//! with resting bids on affected strikes cannot reclaim their USDC escrow
//! unless the admin temporarily flips usdc_mint back.
//!
//! **Pre-flip checklist for admin:** (1) confirm no resting bids exist on
//! any strike whose `usdc_vault.mint` equals the OLD mint, OR (2) document
//! the admin-flip-back recovery procedure so affected users know they can
//! be made whole by request.
//!
//! Devnet posture (deploy_index=7 era): the legacy 7 META markets had no
//! resting bids (Phoenix-style trading was never live against them), so the
//! 2026-05-25 Circle → bUSDC flip was safe in practice. Future flips must
//! re-check this invariant.

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
