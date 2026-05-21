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
    _strike_price: i64,
    _expiry_unix: i64,
) -> Result<()> {
    // Day-1: prove the magic-prefix path is hooked up. Real state writes
    // land Day-2 (binding strike_price/expiry/pyth_feed/phoenix_market into
    // strike_market and computing admin_override_eligible_at).
    verify_phoenix_market(&ctx.accounts.phoenix_market.to_account_info())?;
    Ok(())
}
