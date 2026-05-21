use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct Pause<'info> {
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

pub fn handler(_ctx: Context<Pause>, _paused: bool) -> Result<()> {
    // Day-2: ctx.accounts.config.paused = paused; emit PauseEvent
    Ok(())
}
