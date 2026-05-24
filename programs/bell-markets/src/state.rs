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

// ─── DR-005 / DR-007 — user-funded strike creation ──────────────────────────
// Maximum slot count in TickerConfig.allowed_strikes. Sized for DR-006 baseline
// (7 strikes: ATM + ±3/6/9%) plus DR-011 earnings-eve expansion (+4 strikes at
// ±15/20%) plus headroom. Fixed-size array gives deterministic borsh layout.
pub const MAX_ALLOWED_STRIKES: usize = 16;

// Max time horizon for user_create_strike_market.expiry_unix. Catches typos
// while letting Bram's grid evolution (DR-006) anchor "next trading day" +
// minor calendar drift. 7 days covers Friday → Tuesday Memorial-Day-style
// long weekends with margin.
pub const MAX_EXPIRY_HORIZON_SECS: i64 = 7 * 24 * 60 * 60;

// DR-010 (Leaderboard / reward pool constants) are introduced in P3 — the
// zero-copy account types they back are too large for the standard
// `#[account]` deserialize path.

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
//
// NOTE: no `#[derive(Default)]`. Rust's stdlib only impls Default for arrays
// up to [T; 32], so the [u8; 64] _reserved field would need a manual impl.
// We don't need Default — `#[account(init, ...)]` allocates zeroed space and
// the handler writes the real values. If a future code path needs
// MarketConfig::default(), add a manual impl then.

#[account]
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

// Same Default-derive caveat as MarketConfig — see note above.

// DR-005 + DR-008: `creator` is set at create time (user pubkey for
// `user_create_strike_market`, `Pubkey::default()` for admin-pathed
// `create_strike_market`). Immutable. Read by `mint_pair`'s fee path to
// determine creator-rebate eligibility.
//
// Layout note: `creator` claims the first 32 bytes of the original 64-byte
// `_reserved` buffer. Total LEN unchanged, so the existing 7 META devnet
// markets (created pre-DR-005 by Bram) deserialize correctly — those bytes
// were init-zeroed by Anchor, so they read as `Pubkey::default()` which is
// the documented admin-origin sentinel.
//
// `pairs_outstanding` (DR-008 closed-rent recovery + P4 `close_settled_market`)
// takes the next 8 bytes after `creator`. Incremented in `mint_pair`,
// decremented in `redeem` / `redeem_invalid` / `redeem_pair` / `force_redeem`.
// Existing markets read as 0; pre-DR-008 mints already happened against those
// markets so the counter is informational/best-effort for those — Drew's
// invariant suite will exercise on freshly-created markets where the
// counter is authoritative.

#[account]
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
    pub creator: Pubkey,
    pub pairs_outstanding: u64,
    pub _reserved: [u8; 24],
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
        + 32 // creator (DR-005)
        + 8  // pairs_outstanding (DR-008 / P4)
        + 24; // _reserved (was 64; -32 creator, -8 pairs_outstanding)
}

// ─── TickerConfig (DR-005 / DR-006) ─────────────────────────────────────────
// One per Pyth feed (per ticker). PDA seed = [b"ticker", pyth_feed].
//
// `cap_center` is the most recent close-anchor price (DR-006 phase 1) or the
// most recent wild-swing-update center (phase 2/3). Stored pre-scaled in the
// same i64 units as `StrikeMarket.strike_price` (i.e., scaled by Pyth feed
// exponent).
//
// `allowed_strikes` is the curated grid Bram's cron offers users to spawn.
// Fixed-size [i64; 16] + `strike_count: u8`. The on-chain user_create_strike
// path does NOT check membership (that's Bram's UX scope); it only enforces
// tick alignment + deviation cap against LIVE Pyth spot.
//
// `max_user_strike_deviation_bps` is the loose cap user_create checks against.
// `strike_tick_size` is the grid alignment (same i64 units as strike_price).
// `threshold_bps` is DR-006 phase-2/3 wild-swing trigger; informational only
// on-chain (Bram's cron interprets it).

#[account]
pub struct TickerConfig {
    pub pyth_feed: Pubkey,
    pub cap_center: i64,
    pub allowed_strikes: [i64; MAX_ALLOWED_STRIKES],
    pub strike_count: u8,
    pub max_user_strike_deviation_bps: u16,
    pub strike_tick_size: i64,
    pub threshold_bps: u16,
    pub last_updated_unix: i64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl TickerConfig {
    pub const LEN: usize = 8
        + 32 // pyth_feed
        + 8  // cap_center
        + 8 * MAX_ALLOWED_STRIKES // allowed_strikes
        + 1  // strike_count
        + 2  // max_user_strike_deviation_bps
        + 8  // strike_tick_size
        + 2  // threshold_bps
        + 8  // last_updated_unix
        + 1  // bump
        + 32; // _reserved
}

// ─── DR-008 — fee model + UserConfig + FeeConfig ────────────────────────────

/// Linear decay window for `UserConfig.mint_volume_30d`. 30 days in seconds.
/// Decay is applied lazily on each `mint_pair` entry, not via cron.
pub const MINT_VOLUME_DECAY_WINDOW_SECS: u64 = 30 * 24 * 60 * 60;

/// Tier breakpoints for the 30-day mint-volume discount, in USDC base units
/// (6-decimal Circle USDC).
pub const TIER_BREAK_1K_USDC: u64 = 1_000 * 1_000_000;
pub const TIER_BREAK_10K_USDC: u64 = 10_000 * 1_000_000;

/// Per-tier fee in bps (matches DR-008 table):
///   $0-1K mint volume     → 200 bps (2%)
///   $1K-10K mint volume   → 150 bps (1.5%)
///   $10K+ mint volume     → 100 bps (1%)
pub const TIER_FEE_BPS_TIER1: u16 = 200;
pub const TIER_FEE_BPS_TIER2: u16 = 150;
pub const TIER_FEE_BPS_TIER3: u16 = 100;

/// Default `force_redeem_grace_secs` — 30 days post-settle.
pub const DEFAULT_FORCE_REDEEM_GRACE_SECS: i64 = 30 * 24 * 60 * 60;

/// Per-user mint-volume tracker. PDA seed = [b"user", config, user].
///
/// `mint_volume_30d` is in USDC base units (6 decimals). Linear decay applied
/// on each `mint_pair` entry — see `mint_pair::apply_linear_decay`. Decay is
/// lazy (no cron); each entry recomputes the surviving volume before adding
/// the new contribution.
///
/// `mint_volume_lifetime` is informational (never decays).
///
/// Anti-tier-gaming safeguard (DR-008): mints that fire the creator rebate
/// (full OR partial) do NOT update `mint_volume_30d`. `mint_volume_lifetime`
/// IS still incremented (informational only — not used for tier lookup).
///
/// init_if_needed at mint_pair time — first mint pays the ~$0.16 rent.
#[account]
pub struct UserConfig {
    pub user: Pubkey,
    pub mint_volume_30d: u64,
    pub mint_volume_lifetime: u64,
    pub last_decay_unix: i64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl UserConfig {
    pub const LEN: usize = 8
        + 32 // user
        + 8  // mint_volume_30d
        + 8  // mint_volume_lifetime
        + 8  // last_decay_unix
        + 1  // bump
        + 32; // _reserved
}

/// Separate global singleton (sidesteps a destructive realloc on the existing
/// devnet `MarketConfig` PDA at `6CYzWhTM...`). Seed = [b"fee_config"].
///
/// All bps fields are u16 (max 10000 = 100%). Enforced on `initialize_fee_config`
/// + `update_fee_config`:
///   - platform_retain_bps + weekly_pool_bps + monthly_pool_bps == 10000
///   - weekly_distribution_bps.iter().sum() == 10000
///   - monthly_distribution_bps.iter().sum() == 10000
///   - mint_fee_bps ≤ 10000
///   - creator_rebate_bps ≤ 10000
///   - force_redeem_grace_secs > 0
///
/// Default values (per DR-008 + DR-010):
///   - mint_fee_bps = 0           (mechanism present but disabled; admin flips
///                                  to 200 = 2% via signed update_fee_config)
///   - platform_retain_bps = 5000 (50%)
///   - weekly_pool_bps = 2500     (25%)
///   - monthly_pool_bps = 2500    (25%)
///   - creator_rebate_bps = 10000 (100% rebate = creator pays 0% on all mints
///                                  into their strike until settle)
///   - force_redeem_grace_secs = DEFAULT_FORCE_REDEEM_GRACE_SECS (30 days)
///   - weekly_distribution_bps   = [2500, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400]
///   - monthly_distribution_bps  = same default
#[account]
pub struct FeeConfig {
    /// Back-pointer to MarketConfig PDA (binding — fee_config.config ==
    /// market_config.key() enforced in instructions that touch both).
    pub config: Pubkey,
    pub mint_fee_bps: u16,
    pub platform_retain_bps: u16,
    pub weekly_pool_bps: u16,
    pub monthly_pool_bps: u16,
    pub creator_rebate_bps: u16,
    pub force_redeem_grace_secs: i64,
    pub weekly_distribution_bps: [u16; 10],
    pub monthly_distribution_bps: [u16; 10],
    pub bump: u8,
    pub _reserved: [u8; 64],
}

impl FeeConfig {
    pub const LEN: usize = 8
        + 32 // config
        + 2  // mint_fee_bps
        + 2  // platform_retain_bps
        + 2  // weekly_pool_bps
        + 2  // monthly_pool_bps
        + 2  // creator_rebate_bps
        + 8  // force_redeem_grace_secs
        + 2 * 10 // weekly_distribution_bps
        + 2 * 10 // monthly_distribution_bps
        + 1  // bump
        + 64; // _reserved
}

// ─── DR-010 — Leaderboard commitments + reward pool constants ───────────────

/// Rolling 24-entry ring buffer (12 weekly + 12 monthly = ~3mo lookback per
/// period type at the standard cadence). Larger windows can be added later
/// by reallocating (zero_copy account is realloc-friendly because writes go
/// straight to mapped memory).
pub const LEADERBOARD_COMMITMENT_CAPACITY: usize = 24;

/// Arweave content IDs are base64url 43 ASCII chars. We use a 48-byte field
/// in the on-chain LeaderboardEntry struct (Anchor's `#[zero_copy]` + bytemuck
/// Pod impls require array sizes that fit common bytemuck blanket impls; 48
/// is the next 8-byte-aligned size up from 43). The trailing 5 bytes are
/// zero-padding and documented as such for off-chain consumers — they slice
/// `[..43]` when displaying.
pub const ARWEAVE_TX_ID_LEN: usize = 48;
pub const ARWEAVE_TX_ID_ASCII_LEN: usize = 43;

pub const PERIOD_TYPE_WEEKLY: u8 = 0;
pub const PERIOD_TYPE_MONTHLY: u8 = 1;

/// Top-N distribution slots per period type (matches `FeeConfig.weekly_distribution_bps`
/// and `monthly_distribution_bps` array length).
pub const DISTRIBUTION_SLOTS: usize = 10;

// ─── DR-015 — Multi-metric leaderboard constants ────────────────────────────
//
// Per DR-015 § "Verifier reads metric_id from the proven leaf": 4 distinct
// ranking metrics share the single 32-bit `claimed_bitmap` field on each
// LeaderboardEntry. 32 bits / 4 metrics = 8 positions per metric — claiming
// position N for metric M is mutually exclusive only WITHIN metric M.
// (Higher per-metric position counts would require expanding the bitmap to
// [u32; N], which is a deferred LeaderboardEntry realloc — see the handoff
// recommended-next-action for the migration ix sketch.)
//
// Bit layout: bit_index = metric_id × BITS_PER_METRIC + (position - 1)
//   metric 0 positions 1..=8 → bits 0..=7
//   metric 1 positions 1..=8 → bits 8..=15
//   metric 2 positions 1..=8 → bits 16..=23
//   metric 3 positions 1..=8 → bits 24..=31

pub const METRIC_PROFIT: u8 = 0x00;
pub const METRIC_WIN_STREAK: u8 = 0x01;
pub const METRIC_WIN_RATE: u8 = 0x02;
pub const METRIC_ROI: u8 = 0x03;

/// Number of distinct metric_ids accepted on-chain. DR-015 § "Initial metric
/// set (v1 launch)" defines 4. Adding metrics 5..255 in future would require
/// only off-chain tree changes IF the bitmap can still hold them — at 4
/// metrics × 8 positions = 32 bits we're at capacity. New metrics imply a
/// claimed_bitmap realloc.
pub const METRIC_COUNT: u8 = 4;

/// Bits allocated per metric within the 32-bit `claimed_bitmap`.
/// 32 / METRIC_COUNT = 8.
pub const BITS_PER_METRIC: u8 = 32 / METRIC_COUNT;

/// Positions claimable per metric per period. Same as BITS_PER_METRIC by
/// design (each position consumes one bit).
pub const POSITIONS_PER_METRIC: u8 = BITS_PER_METRIC;

/// Max merkle-proof depth accepted by `verify_merkle_proof`. Caps CU usage
/// (each hash step = ~600 CU). log2(2^16) = 16 leaves headroom for any
/// reasonable leaderboard size while bounding worst-case verify cost.
pub const MERKLE_PROOF_MAX_DEPTH: usize = 16;

/// LeaderboardCommitments uses `#[account(zero_copy)]` because the 24-entry
/// fixed-size array (~2.3 KB) would otherwise overrun the BPF 4096-byte
/// stack frame inside Anchor's macro-generated `try_deserialize_unchecked`
/// (kickoff §4.11). Zero-copy keeps the struct in mapped memory; access via
/// `AccountLoader<'info, LeaderboardCommitments>::load()` /
/// `load_mut()`.
///
/// Field layout (repr(C)):
///   period_id            @ 0  (u64, align 8)
///   committed_at_unix    @ 8  (i64, align 8)
///   claimed_bitmap       @ 16 (u32, align 4)  — bit i set = position (i+1) claimed
///   period_type          @ 20 (u8)
///   merkle_root          @ 21 ([u8;32])
///   arweave_tx_id        @ 53 ([u8;48], first 43 = ASCII Arweave CID, last 5 = zero padding)
///   end                  @ 101 → padded to 104 (struct align 8)
// No #[derive(Default)] — Rust stdlib only impls Default for [T; N] up to N=32,
// so the trailing fixed-size byte arrays would need a manual Default impl. We
// don't need it: Anchor's `init` constraint allocates zero-initialized space
// for zero-copy accounts, so every entry starts at all-zero bytes (which IS
// a valid empty LeaderboardEntry — period_id=0, etc.).
//
// `_trailing_pad`: explicit because `#[zero_copy]` derives `bytemuck::Pod`,
// which rejects structs with implicit alignment-trailing padding. Without
// this field, the struct would size to 101 bytes but align-to-8 rounds up
// to 104, leaving 3 bytes of implicit padding bytemuck refuses to accept.
#[zero_copy]
#[repr(C)]
#[derive(Debug, PartialEq)]
pub struct LeaderboardEntry {
    pub period_id: u64,
    pub committed_at_unix: i64,
    pub claimed_bitmap: u32,
    pub period_type: u8,
    pub merkle_root: [u8; 32],
    pub arweave_tx_id: [u8; ARWEAVE_TX_ID_LEN],
    pub _trailing_pad: [u8; 3],
}

impl LeaderboardEntry {
    /// 8 + 8 + 4 + 1 + 32 + 48 + 3 = 104 bytes (struct align 8 → no implicit pad).
    pub const LEN: usize = 104;
}

/// Global singleton ring buffer. Seed = [b"leaderboard_commits"].
///
/// `next_slot` is the write head modulo `LEADERBOARD_COMMITMENT_CAPACITY`.
/// Distribute ixs lookup by linear scan over the 24 entries matching
/// (period_id, period_type) — at 24 i64 comparisons + 1 u8 comparison this
/// is negligible CU.
#[account(zero_copy)]
#[repr(C)]
pub struct LeaderboardCommitments {
    pub config: Pubkey,
    pub entries: [LeaderboardEntry; LEADERBOARD_COMMITMENT_CAPACITY],
    pub next_slot: u8,
    pub bump: u8,
    pub _reserved: [u8; 64],
    pub _trailing_pad: [u8; 6], // align outer struct to 8 (bytemuck::Pod requirement)
}

impl LeaderboardCommitments {
    /// 32 + 104×24 + 1 + 1 + 64 + 6 = 2600 bytes (+ 8 disc = 2608 on-chain).
    pub const LEN: usize = 32
        + LeaderboardEntry::LEN * LEADERBOARD_COMMITMENT_CAPACITY
        + 1  // next_slot
        + 1  // bump
        + 64 // _reserved
        + 6; // _trailing_pad (align-to-8)
}
// one. It cannot be a standard `#[account]` struct because the 24-entry
// fixed-size array (~2208 bytes payload) overruns the BPF 4096-byte stack
// frame inside Anchor's macro-generated `try_deserialize_unchecked`
// (kickoff §4.11). P3 introduces it as `#[account(zero_copy)]` + `repr(C)`
// + `AccountLoader<'info, T>` accessor so the struct stays in mapped memory
// and never enters the stack.
