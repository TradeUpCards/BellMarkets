use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

/// Convenience wrapper for adding a strike to an existing (underlying,
/// expiry) series. The series is implicit — we just spawn a new
/// `StrikeMarket` PDA via `create_strike_market` with a different strike.
/// Day-2 may evolve this into a separate batch creator if the cost/UX of
/// repeated CPIs justifies it.
#[derive(Accounts)]
pub struct AddStrike<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,
}

pub fn handler(_ctx: Context<AddStrike>) -> Result<()> {
    Ok(())
}
