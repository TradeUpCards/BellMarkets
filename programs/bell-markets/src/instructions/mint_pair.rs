use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct MintPair<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = !config.paused @ BellMarketsError::Paused,
        has_one = usdc_mint,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        constraint = strike_market.outcome == Outcome::Unsettled @ BellMarketsError::AlreadySettled,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault", strike_market.key().as_ref()],
        bump = strike_market.vault_bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

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

    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(_ctx: Context<MintPair>, _amount: u64) -> Result<()> {
    // Day-1: ix wired. Day-2:
    //   - require!(amount > 0, ZeroAmount)
    //   - transfer amount USDC user_usdc -> usdc_vault (CPI to spl-token)
    //   - mint amount of yes_mint -> user_yes (signer: strike_market PDA)
    //   - mint amount of no_mint  -> user_no  (signer: strike_market PDA)
    //   - emit MintPairEvent
    Ok(())
}
