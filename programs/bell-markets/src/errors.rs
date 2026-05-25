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

    #[msg("Outcome is incompatible with this redemption path (Unsettled, or Invalid where Invalid requires redeem_invalid). force_redeem currently has no Invalid-market path — see TODO in force_redeem.rs.")]
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

    #[msg("Strike price is not aligned to TickerConfig.strike_tick_size grid.")]
    StrikeTickMisaligned,

    #[msg("Strike price is outside TickerConfig.max_user_strike_deviation_bps of live Pyth spot.")]
    StrikeOutsideDeviationCap,

    #[msg("Expiry timestamp is not at a recognized US-equity market close (1:00 or 4:00 PM ET).")]
    ExpiryNotMarketClose,

    #[msg("Expiry timestamp is more than 7 days in the future.")]
    ExpiryTooFar,

    #[msg("TickerConfig.pyth_feed does not match the supplied underlying_pyth_feed account.")]
    TickerConfigFeedMismatch,

    #[msg("TickerConfig param out of allowed bounds (see update_ticker_config MAX_* constants).")]
    InvalidTickerParam,

    #[msg("Sum of bps fields must equal 10000 exactly.")]
    BpsSumMismatch,

    #[msg("FeeConfig param out of allowed bounds (see initialize_fee_config MAX_* constants).")]
    InvalidFeeParam,

    #[msg("strike_market.creator does not match the supplied creator account.")]
    CreatorMismatch,

    #[msg("Grace period for force_redeem has not elapsed since settlement.")]
    ForceRedeemGraceActive,

    #[msg("Market still has pairs_outstanding > 0; cannot close until fully redeemed.")]
    MarketNotEmpty,

    #[msg("Merkle proof failed verification against committed leaderboard root.")]
    MerkleProofInvalid,

    #[msg("Distribution position out of [1, 10] range.")]
    InvalidDistributionPosition,

    #[msg("Leaderboard period_id has no committed root for the requested period_type.")]
    LeaderboardRootNotFound,

    #[msg("Pyth price is negative; refusing to bind a negative spot for strike validation.")]
    PythNegativePrice,

    // ─── DR-020 — In-program CLOB errors ────────────────────────────────────

    #[msg("Order book is full at capacity ORDERBOOK_N=128 per side; reject new resting order.")]
    BookFull,

    #[msg("Order owner mismatch; only the order's owner may cancel it.")]
    NotOrderOwner,

    #[msg("Order with the supplied (side, seq) not found on the book.")]
    OrderNotFound,

    #[msg("Order price must be in [1, PRICE_SCALE] (DR-020 M-4: zero price rejected to prevent free-Yes griefing).")]
    PriceOutOfRange,

    #[msg("Order size must be > 0.")]
    ZeroOrderSize,

    #[msg("Side discriminator must be SIDE_BID (0) or SIDE_ASK (1).")]
    InvalidSide,

    #[msg("Maker payout account not owned by the SPL Token program (DR-020 H-1: prevents book-lock DoS via spoofed account).")]
    ClobMakerNotSplOwned,

    #[msg("Maker payout account not writable (defense-in-depth: a read-only account would block the SPL Token transfer CPI).")]
    ClobMakerNotWritable,

    #[msg("Maker payout token account is frozen (DR-020 M-1: rejects frozen-account matching DoS).")]
    ClobMakerFrozen,

    #[msg("Maker payout account owner does not match the on-chain order's owner pubkey.")]
    ClobMakerOwnerMismatch,

    #[msg("Maker payout account mint does not match the expected mint (USDC for ask payouts; YES for bid payouts).")]
    ClobMakerMintMismatch,

    #[msg("remaining_accounts shape mismatch: expected one maker payout account per planned fill, in fill order.")]
    ClobRemainingAccountsMismatch,

    #[msg("Order book is not initialized for this strike_market (init_order_book + grow_order_book must run first).")]
    OrderBookNotInitialized,

    #[msg("Order book back-reference does not match the supplied strike_market account.")]
    OrderBookMarketMismatch,

    // ─── deploy_index=8 — reinit_rewards_pools errors ───────────────────────

    #[msg("Reward pool has non-zero balance; drain to admin before reinit (admin manual SPL transfer).")]
    PoolNotEmpty,

    #[msg("Reward pool authority does not match its own pubkey (self-authority pattern from initialize_rewards_pools).")]
    WrongPoolAuthority,
}
