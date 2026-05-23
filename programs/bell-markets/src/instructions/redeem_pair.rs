//! `redeem_pair` — pre-settlement pair redemption. The inverse of `mint_pair`.
//!
//! Permissionless: any user holding `amount` of BOTH YES and NO can burn the
//! pair and reclaim `amount` USDC from the vault. Only callable BEFORE
//! settlement (Outcome::Unsettled); after settlement, use `redeem` (single
//! winning side) or `redeem_invalid` (both sides on Invalid markets).
//!
//! ## Why this is its own instruction (not folded into `redeem` or `redeem_invalid`)
//!
//! - `redeem`'s Accounts struct has a single `winning_mint` — fits binary
//!   payout but not symmetric pair burn.
//! - `redeem_invalid`'s gate is `outcome == Outcome::Invalid` — opposite of
//!   what we need here (Outcome::Unsettled).
//!
//! A dedicated instruction with its own constraints + Accounts struct is the
//! cleanest shape. Cleo's POV-3 atomic "Sell No" flow (front-end build) wires
//! against this instruction directly.
//!
//! ## $1 USDC invariant preservation
//!
//! Per-call: `amount` USDC out of vault == `amount` YES burned == `amount` NO
//! burned. By symmetry with `mint_pair` (which performs the same three CPI
//! calls in reverse), the aggregate invariant holds:
//!
//!     vault.amount  ==  yes_mint.supply  ==  no_mint.supply   (pre-settle)
//!
//! Post-settle the invariant shifts to `vault.amount == winning_mint.supply`
//! (settle freezes the no-longer-winning side's supply but stops paying it
//! out); `redeem_pair` is gated to pre-settle so it never touches that case.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct RedeemPair<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        constraint = strike_market.outcome == Outcome::Unsettled
            @ BellMarketsError::AlreadySettled,
        constraint = strike_market.config == config.key()
            @ BellMarketsError::ConfigMismatch,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    #[account(
        mut,
        seeds = [b"yes", strike_market.key().as_ref()],
        bump = strike_market.yes_mint_bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"no", strike_market.key().as_ref()],
        bump = strike_market.no_mint_bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault", strike_market.key().as_ref()],
        bump = strike_market.vault_bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RedeemPair>, amount: u64) -> Result<()> {
    require!(amount > 0, BellMarketsError::ZeroAmount);

    // Burn `amount` YES from user (user authority).
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.yes_mint.to_account_info(),
                from: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Burn `amount` NO from user (user authority).
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.no_mint.to_account_info(),
                from: ctx.accounts.user_no.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Transfer `amount` USDC vault → user. Vault authority = strike_market PDA.
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

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.strike_market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // P2 / DR-008: decrement pairs_outstanding (see redeem.rs).
    let sm = &mut ctx.accounts.strike_market;
    sm.pairs_outstanding = sm.pairs_outstanding.saturating_sub(amount);

    Ok(())
}
