//! `redeem_invalid` — refund the original pair deposit when a market settled
//! Invalid (the admin-override path used when the oracle is unrecoverable).
//!
//! The contract is symmetric: a user who originally minted N pairs (deposited
//! N USDC and received N YES + N NO) gets back exactly N USDC by burning N
//! YES + N NO. There is no winner / loser — both sides are unwound.
//!
//! Why this is a separate instruction (not part of `redeem`):
//! `redeem`'s Accounts struct has a single `winning_mint` + `user_winning_token`
//! pair, which fits the Yes / No payout shape (burn the winning side, receive
//! USDC) but cannot represent "burn both sides." Trying to overload it would
//! either (a) require both fields to be present even on Yes/No redeems (bloat)
//! or (b) push the dual-side accounts into `remaining_accounts` (fragile).
//! A dedicated instruction is the clean shape.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct RedeemInvalid<'info> {
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
        constraint = strike_market.outcome == Outcome::Invalid
            @ BellMarketsError::InvalidOutcomeForRedeem,
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

pub fn handler(ctx: Context<RedeemInvalid>, amount: u64) -> Result<()> {
    require!(amount > 0, BellMarketsError::ZeroAmount);

    // Burn `amount` of YES from user (user authority).
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

    // Burn `amount` of NO from user (user authority).
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

    // Refund `amount` USDC from vault → user. Vault authority = strike_market PDA.
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
