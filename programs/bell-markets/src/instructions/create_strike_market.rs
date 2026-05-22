use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::*;
use crate::adapters::phoenix::verify_phoenix_market;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
#[instruction(strike_price: i64, expiry_unix: i64)]
pub struct CreateStrikeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        init,
        payer = admin,
        space = StrikeMarket::LEN,
        seeds = [
            b"strike",
            underlying_pyth_feed.key().as_ref(),
            &expiry_unix.to_le_bytes(),
            &strike_price.to_le_bytes(),
        ],
        bump,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// CHECK: Pyth price feed. Validated at settle time via vendored parser
    /// in oracle::parse_pyth_price. At creation we only bind its pubkey into
    /// the market state.
    pub underlying_pyth_feed: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [b"yes", strike_market.key().as_ref()],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = strike_market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"no", strike_market.key().as_ref()],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = strike_market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault", strike_market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    /// CHECK: Phoenix v1 FIFO market — validated by 8-byte magic prefix in
    /// the handler via verify_phoenix_market. Per kickoff §4.12, this must
    /// remain UncheckedAccount (Phoenix is not an Anchor program; Account<T>
    /// would fail the discriminator check).
    pub phoenix_market: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<CreateStrikeMarket>,
    strike_price: i64,
    expiry_unix: i64,
) -> Result<()> {
    require!(strike_price > 0, BellMarketsError::InvalidStrikePrice);
    let now = Clock::get()?.unix_timestamp;
    require!(expiry_unix > now, BellMarketsError::ExpiryInPast);

    verify_phoenix_market(&ctx.accounts.phoenix_market.to_account_info())?;

    let override_eligible_at = expiry_unix
        .checked_add(ctx.accounts.config.admin_override_delay_secs)
        .ok_or(BellMarketsError::MathOverflow)?;

    let sm = &mut ctx.accounts.strike_market;
    sm.config = ctx.accounts.config.key();
    sm.underlying_pyth_feed = ctx.accounts.underlying_pyth_feed.key();
    sm.strike_price = strike_price;
    sm.expiry_unix = expiry_unix;
    sm.yes_mint = ctx.accounts.yes_mint.key();
    sm.no_mint = ctx.accounts.no_mint.key();
    sm.usdc_vault = ctx.accounts.usdc_vault.key();
    sm.phoenix_market = ctx.accounts.phoenix_market.key();
    sm.settle_price = 0;
    sm.settle_confidence = 0;
    sm.settle_slot = 0;
    sm.settled_at_unix = 0;
    sm.outcome = Outcome::Unsettled;
    sm.admin_override_eligible_at = override_eligible_at;
    sm.bump = ctx.bumps.strike_market;
    sm.yes_mint_bump = ctx.bumps.yes_mint;
    sm.no_mint_bump = ctx.bumps.no_mint;
    sm.vault_bump = ctx.bumps.usdc_vault;
    Ok(())
}
