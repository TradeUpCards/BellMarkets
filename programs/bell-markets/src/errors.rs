use anchor_lang::prelude::*;

#[error_code]
pub enum BellMarketsError {
    #[msg("Program is paused; mutating instruction refused.")]
    Paused,

    #[msg("Caller is not the admin recorded in MarketConfig.")]
    NotAdmin,

    #[msg("Market is already settled; second settlement refused.")]
    AlreadySettled,

    #[msg("Market is not yet expired; settlement refused.")]
    NotExpired,

    #[msg("Market is not settled; redeem refused until settlement is final.")]
    NotSettled,

    #[msg("Pyth account magic mismatch; account is not a Pyth price account.")]
    PythBadMagic,

    #[msg("Pyth account version unsupported by vendored parser.")]
    PythBadVersion,

    #[msg("Pyth account type is not the expected price-account type.")]
    PythWrongAccountType,

    #[msg("Pyth price status is not Trading; refusing to settle on a halted feed.")]
    PythNotTrading,

    #[msg("Pyth publish slot is older than MarketConfig.price_staleness_secs.")]
    PythStale,

    #[msg("Pyth confidence interval exceeds MarketConfig.price_confidence_bps.")]
    PythConfidenceTooWide,

    #[msg("Pyth feed for this market does not match the strike's underlying_pyth_feed.")]
    PythFeedMismatch,

    #[msg("Phoenix market account magic mismatch; refusing CPI to unverified market.")]
    PhoenixBadMagic,

    #[msg("Phoenix market account is too small to be a valid market header.")]
    PhoenixAccountTooSmall,

    #[msg("Outcome cannot be Unsettled at redemption time.")]
    InvalidOutcomeForRedeem,

    #[msg("Burn amount must be > 0.")]
    ZeroAmount,

    #[msg("USDC mint on Accounts does not match MarketConfig.usdc_mint.")]
    UsdcMintMismatch,

    #[msg("Strike list is full; cannot add another strike to this market.")]
    StrikeListFull,

    #[msg("Strike already exists at this price for this (underlying, expiry).")]
    StrikeAlreadyExists,

    #[msg("Admin override window has not opened yet — wait at least admin_override_delay_secs after expiry.")]
    AdminOverrideTooEarly,

    #[msg("Math overflow (checked).")]
    MathOverflow,

    #[msg("InitializeConfig param out of allowed bounds (see instruction MAX_* constants).")]
    InvalidConfigParam,

    #[msg("Strike price must be > 0.")]
    InvalidStrikePrice,

    #[msg("Expiry timestamp is in the past.")]
    ExpiryInPast,

    #[msg("admin_settle forced_outcome must be Yes / No / Invalid (not Unsettled).")]
    ForcedOutcomeUnsettled,

    #[msg("strike_market.config does not match the supplied config account.")]
    ConfigMismatch,
}
