use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
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
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// The mint corresponding to the user's winning side. Day-2 handler
    /// enforces winning_mint == strike_market.yes_mint OR no_mint based on
    /// strike_market.outcome.
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

pub fn handler(_ctx: Context<Redeem>, _amount: u64) -> Result<()> {
    // Day-1: surface. Day-2:
    //   - require amount > 0 (ZeroAmount)
    //   - outcome must be Yes / No / Invalid (InvalidOutcomeForRedeem already filtered)
    //   - if outcome == Invalid: user must burn equal amounts of yes+no for refund
    //   - else: user burns `amount` of winning_mint, vault transfers `amount` USDC out
    //   - CPI burn (authority = user); CPI transfer from vault (authority = strike_market PDA)
    //   - emit RedeemedEvent
    Ok(())
}
