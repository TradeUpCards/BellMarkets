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

pub fn handler(ctx: Context<Pause>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}
