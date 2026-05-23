//! `redeem` — winning-side payout. User burns `amount` of the winning mint
//! and receives `amount` USDC from the vault.
//!
//! Why Yes/No only (not Invalid): this Accounts struct has a single
//! `winning_mint` + `user_winning_token` pair, which fits the binary-payout
//! shape (one winner, one loser) but cannot represent the symmetric
//! "burn both sides" shape that Invalid markets need. The dedicated
//! `redeem_invalid` instruction handles that.
//!
//! Why no fee on the redeem path: the $1 USDC invariant is load-bearing
//! (Hard YES #1). Any fee here would break the property that aggregate
//! redemptions == aggregate deposits for the winning side. Platform fees, if
//! ever added, should live on `mint_pair` instead (charge on entry, exit
//! is pure).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct Redeem<'info> {
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
        constraint = strike_market.outcome != Outcome::Unsettled @ BellMarketsError::NotSettled,
        constraint = strike_market.config == config.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// The mint corresponding to the user's winning side. The handler
    /// enforces `winning_mint == strike_market.yes_mint` (if outcome == Yes)
    /// or `== strike_market.no_mint` (if outcome == No).
    #[account(mut)]
    pub winning_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = winning_mint, token::authority = user)]
    pub user_winning_token: Box<Account<'info, TokenAccount>>,

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

pub fn handler(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    require!(amount > 0, BellMarketsError::ZeroAmount);

    // Yes/No only — Invalid markets refund the original pair deposit and
    // require both mints + both user token accounts; that path lives in the
    // dedicated `redeem_invalid` instruction (see ../redeem_invalid.rs).
    let outcome = ctx.accounts.strike_market.outcome;
    require!(outcome != Outcome::Invalid, BellMarketsError::InvalidOutcomeForRedeem);
    let expected_winning_mint = match outcome {
        Outcome::Yes => ctx.accounts.strike_market.yes_mint,
        Outcome::No => ctx.accounts.strike_market.no_mint,
        // Unsettled is already filtered by the Accounts struct constraint
        // (strike_market.outcome != Outcome::Unsettled). Invalid is rejected
        // above. So we can only reach this match arm with Yes or No.
        _ => unreachable!(),
    };
    require!(
        ctx.accounts.winning_mint.key() == expected_winning_mint,
        BellMarketsError::InvalidOutcomeForRedeem
    );

    // Burn `amount` of winning_mint from user (user authority).
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.winning_mint.to_account_info(),
                from: ctx.accounts.user_winning_token.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Transfer `amount` USDC vault → user. Vault authority is strike_market PDA.
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

    Ok(())
}
