use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

/// PERMISSIONLESS settle (kickoff §4.2). Any signer can call this — settle_market
/// is intentionally callable by anyone who can pay the transaction fee. The
/// instruction's correctness is enforced by:
///   1. config.paused == false
///   2. clock.unix_timestamp >= strike_market.expiry_unix
///   3. underlying_pyth_feed.key() == strike_market.underlying_pyth_feed
///   4. parse_pyth_price (magic / version / atype / status / staleness / confidence)
///
/// Note the absence of any `admin` constraint on the Accounts struct. This is
/// deliberate and is enforced by the auditor (kickoff §4.2 — no signer beyond
/// the fee payer).
#[derive(Accounts)]
pub struct SettleMarket<'info> {
    /// Fee payer. NOT validated against admin — settle is permissionless.
    pub settler: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        constraint = strike_market.outcome == Outcome::Unsettled @ BellMarketsError::AlreadySettled,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// CHECK: Pyth price account. Validated by:
    ///   1. key match against strike_market.underlying_pyth_feed
    ///   2. parse_pyth_price magic/version/atype/status checks
    pub underlying_pyth_feed: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(_ctx: Context<SettleMarket>) -> Result<()> {
    // Day-1: surface in place. Day-2:
    //   - require clock.unix_timestamp >= strike_market.expiry_unix (NotExpired)
    //   - require underlying_pyth_feed.key() == strike_market.underlying_pyth_feed (PythFeedMismatch)
    //   - let data = underlying_pyth_feed.try_borrow_data()?
    //   - let p = oracle::parse_pyth_price(&data)?
    //   - require clock - p.publish_slot age <= config.price_staleness_secs (PythStale)
    //   - require p.confidence / p.price.abs() bps <= config.price_confidence_bps (PythConfidenceTooWide)
    //   - outcome = if p.price >= strike_market.strike_price { Yes } else { No }
    //   - write settle_price/confidence/slot, settled_at_unix
    //   - emit SettledEvent
    Ok(())
}
