use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

/// Convenience hook for adding a strike to an existing (underlying, expiry)
/// series. The series is implicit — each strike is its own `StrikeMarket`
/// PDA created via `create_strike_market` with the same underlying + expiry
/// and a different strike_price. This instruction is a no-op surface
/// reserved for a possible future batch creator; live in the IDL today only
/// so clients can target it without an upgrade later.
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
