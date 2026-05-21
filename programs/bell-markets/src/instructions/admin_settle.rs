use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

/// Admin escape hatch. Only callable AFTER `admin_override_delay_secs` past
/// expiry, by `config.admin`, and when the market is still Unsettled. Use:
/// the oracle is halted past the override window and we must manually rule
/// the market (Yes/No/Invalid) so users can redeem.
#[derive(Accounts)]
pub struct AdminSettle<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        constraint = strike_market.outcome == Outcome::Unsettled @ BellMarketsError::AlreadySettled,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(_ctx: Context<AdminSettle>, _forced_outcome: Outcome) -> Result<()> {
    // Day-1: surface. Day-2:
    //   - require forced_outcome != Outcome::Unsettled
    //   - require clock.unix_timestamp >= strike_market.expiry_unix + config.admin_override_delay_secs
    //     (AdminOverrideTooEarly)
    //   - write outcome, settled_at_unix; leave settle_price = 0 to flag admin-pathed settle
    //   - emit AdminSettledEvent
    Ok(())
}
