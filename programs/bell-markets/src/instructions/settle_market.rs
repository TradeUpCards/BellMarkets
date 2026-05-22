use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;
use crate::oracle::parse_pyth_price;

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

pub fn handler(ctx: Context<SettleMarket>) -> Result<()> {
    let clock = &ctx.accounts.clock;
    let strike_market = &ctx.accounts.strike_market;

    require!(
        clock.unix_timestamp >= strike_market.expiry_unix,
        BellMarketsError::NotExpired
    );
    require!(
        ctx.accounts.underlying_pyth_feed.key() == strike_market.underlying_pyth_feed,
        BellMarketsError::PythFeedMismatch
    );

    let data = ctx.accounts.underlying_pyth_feed.try_borrow_data()?;
    let p = parse_pyth_price(&data)?;

    // Staleness check (slot-domain). Solana slots are nominally ~400ms each
    // (2.5 slots/sec), so age_secs = floor(slot_delta * 2 / 5). We use slot
    // delta rather than Pyth's publish_timestamp because the vendored 30-line
    // parser intentionally does not parse the timestamp_ field (off 96).
    let slot_delta = clock.slot.saturating_sub(p.publish_slot);
    let age_secs = (slot_delta as i64).saturating_mul(2) / 5;
    require!(
        age_secs <= ctx.accounts.config.price_staleness_secs,
        BellMarketsError::PythStale
    );

    // Confidence check in bps: confidence / |price| * 10_000 <= max_bps.
    // Rearrange to avoid division: confidence * 10_000 <= |price| * max_bps.
    let abs_price = p.price.unsigned_abs();
    require!(abs_price > 0, BellMarketsError::PythConfidenceTooWide);
    let conf_scaled = (p.confidence as u128).saturating_mul(10_000);
    let limit_scaled = (abs_price as u128)
        .saturating_mul(ctx.accounts.config.price_confidence_bps as u128);
    require!(
        conf_scaled <= limit_scaled,
        BellMarketsError::PythConfidenceTooWide
    );

    // Settle: Yes if oracle price at/above strike, No otherwise. Tie goes to
    // Yes by design — the binary contract is "underlying >= strike at expiry".
    let outcome = if p.price >= strike_market.strike_price {
        Outcome::Yes
    } else {
        Outcome::No
    };

    let sm = &mut ctx.accounts.strike_market;
    sm.outcome = outcome;
    sm.settle_price = p.price;
    sm.settle_confidence = p.confidence;
    sm.settle_slot = p.publish_slot;
    sm.settled_at_unix = clock.unix_timestamp;
    Ok(())
}
