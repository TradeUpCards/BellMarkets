use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};
use crate::state::*;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = MarketConfig::LEN,
        seeds = [b"config"],
        bump,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    /// CHECK: treasury token account address — validated by client; program
    /// only stores the pubkey for downstream payout flows.
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    _ctx: Context<InitializeConfig>,
    _price_staleness_secs: i64,
    _price_confidence_bps: u16,
    _admin_override_delay_secs: i64,
) -> Result<()> {
    // Day-1 stub. Day-2 fills:
    //   - write config.admin = ctx.accounts.admin.key()
    //   - write config.usdc_mint, treasury
    //   - apply staleness/confidence/override params (with sane bounds)
    //   - paused = false
    //   - bump = ctx.bumps.config
    Ok(())
}
