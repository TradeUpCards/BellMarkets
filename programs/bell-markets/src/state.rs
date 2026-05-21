use anchor_lang::prelude::*;

// ─── Constants ──────────────────────────────────────────────────────────────
// Citations: aria kickoff §"Your first task" item 2c.
// These are *defaults* — `MarketConfig` stores the active values so admin can
// retune via governance without a program upgrade.

pub const DEFAULT_PRICE_STALENESS_SECS: i64 = 300;
pub const DEFAULT_PRICE_CONFIDENCE_BPS: u16 = 50;
pub const DEFAULT_ADMIN_OVERRIDE_DELAY_SECS: i64 = 3600;

pub const MAX_STRIKES_PER_MARKET: usize = 16;
pub const USDC_DECIMALS: u8 = 6;

// ─── Outcome enum ───────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Unsettled,
    Yes,
    No,
    Invalid,
}

impl Default for Outcome {
    fn default() -> Self {
        Outcome::Unsettled
    }
}

// ─── MarketConfig ───────────────────────────────────────────────────────────
// Global config singleton. PDA seed = b"config".

#[account]
#[derive(Default)]
pub struct MarketConfig {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury: Pubkey,
    pub price_staleness_secs: i64,
    pub price_confidence_bps: u16,
    pub admin_override_delay_secs: i64,
    pub paused: bool,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

impl MarketConfig {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 2 + 8 + 1 + 1 + 64;
}

// ─── StrikeMarket ───────────────────────────────────────────────────────────
// One per (underlying, expiry, strike). PDA seed = b"strike",
// underlying_pyth_feed, expiry_unix_le, strike_price_le.

#[account]
#[derive(Default)]
pub struct StrikeMarket {
    pub config: Pubkey,
    pub underlying_pyth_feed: Pubkey,
    pub strike_price: i64,
    pub expiry_unix: i64,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub phoenix_market: Pubkey,
    pub settle_price: i64,
    pub settle_confidence: u64,
    pub settle_slot: u64,
    pub settled_at_unix: i64,
    pub outcome: Outcome,
    pub admin_override_eligible_at: i64,
    pub bump: u8,
    pub yes_mint_bump: u8,
    pub no_mint_bump: u8,
    pub vault_bump: u8,
    pub _reserved: [u8; 64],
}

impl StrikeMarket {
    pub const LEN: usize = 8
        + 32 // config
        + 32 // underlying_pyth_feed
        + 8  // strike_price
        + 8  // expiry_unix
        + 32 // yes_mint
        + 32 // no_mint
        + 32 // usdc_vault
        + 32 // phoenix_market
        + 8  // settle_price
        + 8  // settle_confidence
        + 8  // settle_slot
        + 8  // settled_at_unix
        + 1  // Outcome (borsh enum tag — 1 byte for ≤256 variants, no payloads)
        + 8  // admin_override_eligible_at
        + 1 + 1 + 1 + 1 // bumps
        + 64; // _reserved
}
