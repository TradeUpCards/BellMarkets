//! `close_settled_market` — permissionless rent recovery for fully-redeemed
//! markets. Per cory_questions_1_answers.md § PDA Economics — once
//! `pairs_outstanding == 0` (every minted pair has been redeemed via
//! `redeem` / `redeem_pair` / `redeem_invalid` / `force_redeem`), the USDC
//! vault is empty and can be closed to recover ~$0.23 rent to fee_collector.
//!
//! ## Scope: vault rent only (best-effort)
//!
//! YES/NO mints are NOT closed here even when their supply may be 0.
//! Rationale: SPL Token's `CloseAccount` on a Mint requires the Mint to have
//! a `close_authority` AND for `supply == 0`. Our mints were created without
//! an explicit close_authority (default Anchor `init` for Mint sets none),
//! so closing them would require a separate flow (`SetAuthority` then
//! `CloseAccount`). The ~$0.22 mint rent per market remains stranded as the
//! known trade-off documented in cory_questions_1_answers.md §"Updated cost
//! analysis".
//!
//! ## StrikeMarket as tombstone
//!
//! Per Tate's spec: the StrikeMarket PDA itself is NOT closed. It remains as
//! a tombstone for historical queries (settle price, outcome, etc.).
//! `pairs_outstanding == 0` is the on-chain signal that no further activity
//! is expected; downstream indexers can filter on this.
//!
//! ## Permissionless cleanup
//!
//! Any signer can call this — fee_collector receives the recovered rent
//! regardless of who cranks. Mirrors DR-002's settle-permissionless design:
//! the operation is safe (every gate is on-chain), so don't gate it behind
//! admin authority.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount};
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct CloseSettledMarket<'info> {
    #[account(mut)]
    pub closer: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        constraint = strike_market.outcome != Outcome::Unsettled
            @ BellMarketsError::NotSettled,
        constraint = strike_market.config == config.key()
            @ BellMarketsError::ConfigMismatch,
        constraint = strike_market.pairs_outstanding == 0
            @ BellMarketsError::MarketNotEmpty,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    #[account(
        mut,
        seeds = [b"vault", strike_market.key().as_ref()],
        bump = strike_market.vault_bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: rent recipient — pubkey-binding check below enforces
    /// fee_collector.key() == config.treasury. fee_collector receives the
    /// vault's rent lamports + any residual USDC dust (typically zero;
    /// pairs_outstanding == 0 implies vault balance == 0 because of the
    /// $1-per-pair invariant, but a stray Token::transfer attacker could
    /// in principle send dust into the vault).
    #[account(
        mut,
        constraint = fee_collector.key() == config.treasury @ BellMarketsError::ConfigMismatch,
    )]
    pub fee_collector: UncheckedAccount<'info>,

    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CloseSettledMarket>) -> Result<()> {
    // Close usdc_vault → rent (and any residual dust USDC) flows to
    // fee_collector. Vault authority is the strike_market PDA (self-authority).
    let pyth_feed = ctx.accounts.strike_market.underlying_pyth_feed;
    let expiry_le = ctx.accounts.strike_market.expiry_unix.to_le_bytes();
    let strike_le = ctx.accounts.strike_market.strike_price.to_le_bytes();
    let bump = [ctx.accounts.strike_market.bump];
    let seeds: &[&[u8]] = &[
        b"strike",
        pyth_feed.as_ref(),
        expiry_le.as_ref(),
        strike_le.as_ref(),
        bump.as_ref(),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    token::close_account(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.usdc_vault.to_account_info(),
                destination: ctx.accounts.fee_collector.to_account_info(),
                authority: ctx.accounts.strike_market.to_account_info(),
            },
            signer_seeds,
        ),
    )?;

    // Mints + StrikeMarket left in place. See file header for rationale.
    Ok(())
}
