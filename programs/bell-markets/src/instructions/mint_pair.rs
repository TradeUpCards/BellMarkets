//! `mint_pair` — the `$1 USDC → 1 YES + 1 NO` operation that establishes the
//! Hard YES #1 invariant.
//!
//! Per-call conservation (enforced by code structure, not arithmetic): every
//! `amount` flows symmetrically — `amount` USDC into the strike's vault and
//! `amount` of each side minted to the user. The DR-008 fee skim is a
//! separate `fee_total` USDC charged ON TOP of `amount` (user pays
//! `amount + fee_total`); `amount` itself remains the load-bearing $1 invariant.
//!
//! ## Fee flow (DR-008 + DR-010)
//!
//! When `FeeConfig.mint_fee_bps > 0`:
//!
//!   1. `tier_bps` = tier_fee_bps(user_config.mint_volume_30d after decay)
//!   2. `creator_rebate_fires` = (strike_market.creator == user) &&
//!       (strike_market.outcome == Unsettled) &&
//!       (fee_config.creator_rebate_bps > 0)
//!   3. `effective_bps` = if creator_rebate_fires
//!       { fee_after_rebate(tier_bps, fee_config.creator_rebate_bps) }
//!       else { tier_bps }
//!   4. `fee_total` = amount × effective_bps / 10_000
//!   5. `(platform, weekly, monthly)` = split_fee(fee_total, platform_retain_bps,
//!       weekly_pool_bps, monthly_pool_bps)
//!   6. Three USDC transfers (user → treasury_ata / weekly_pool / monthly_pool)
//!
//! When `FeeConfig.mint_fee_bps == 0`: all fee transfers are skipped (Day-1
//! behavior preserved; demo runs with fees off by default).
//!
//! ## Anti-tier-gaming safeguard (DR-008)
//!
//! Mints that receive ANY creator rebate (even partial — e.g.
//! `creator_rebate_bps = 5000`) do NOT update `user_config.mint_volume_30d`.
//! `mint_volume_lifetime` IS still updated (informational; never used for
//! tier lookup). Closes the attack vector documented in DR-008 § "Critical
//! safeguard".
//!
//! ## $1 invariant + pairs_outstanding
//!
//! `strike_market.pairs_outstanding` is incremented by `amount` here and
//! decremented by `amount` in `redeem` / `redeem_pair` / `redeem_invalid` /
//! `force_redeem`. P4's `close_settled_market` gates on `pairs_outstanding ==
//! 0`. The counter is best-effort for the 7 META markets created pre-DR-008
//! (those started at 0 and saw pre-counter mints).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::BellMarketsError;

// ─── Pure math helpers (extracted for property testing) ───────────────────

/// Three-tier fee lookup. Mirrors the DR-008 table.
///
/// `mint_volume_30d` is in USDC base units (6 decimals). Tier boundaries
/// match `TIER_BREAK_1K_USDC` / `TIER_BREAK_10K_USDC`.
pub(crate) fn tier_fee_bps(mint_volume_30d: u64) -> u16 {
    if mint_volume_30d < TIER_BREAK_1K_USDC {
        TIER_FEE_BPS_TIER1
    } else if mint_volume_30d < TIER_BREAK_10K_USDC {
        TIER_FEE_BPS_TIER2
    } else {
        TIER_FEE_BPS_TIER3
    }
}

/// Apply the DR-008 creator rebate to a tier-derived fee.
///
/// `effective_bps = tier_bps × (10_000 - rebate_bps) / 10_000`
///
/// When `rebate_bps == 10_000` (default), returns 0 (creator pays 0% on
/// every mint into their strike until settle). When `rebate_bps == 0`,
/// returns `tier_bps` unchanged (no rebate applied).
pub(crate) fn fee_after_rebate(tier_bps: u16, rebate_bps: u16) -> u16 {
    // rebate_bps ≤ 10_000 enforced by validate_fee_params upstream; defensive
    // saturating to avoid underflow on a corrupted FeeConfig read.
    let inv_rebate = 10_000u32.saturating_sub(rebate_bps as u32);
    ((tier_bps as u32 * inv_rebate) / 10_000) as u16
}

/// Linear 30-day decay applied lazily on each mint_pair entry.
///
/// `remaining = volume × max(0, DECAY_WINDOW - elapsed) / DECAY_WINDOW`
///
/// Defensive: returns the input unchanged when `now < last_decay_unix`
/// (clock skew); fully decays when `elapsed >= DECAY_WINDOW`.
pub(crate) fn apply_linear_decay(volume: u64, last_decay_unix: i64, now: i64) -> u64 {
    if now <= last_decay_unix {
        return volume;
    }
    let elapsed = (now - last_decay_unix) as u64;
    if elapsed >= MINT_VOLUME_DECAY_WINDOW_SECS {
        return 0;
    }
    let remaining_secs = MINT_VOLUME_DECAY_WINDOW_SECS - elapsed;
    ((volume as u128).saturating_mul(remaining_secs as u128)
        / (MINT_VOLUME_DECAY_WINDOW_SECS as u128)) as u64
}

/// Split a fee total across the three sinks per DR-010 bps configuration.
///
/// Caller has validated `platform_bps + weekly_bps + monthly_bps == 10_000`
/// via `validate_fee_params`. Monthly is computed as the remainder
/// (fee_total - platform - weekly) so the three-part sum is EXACTLY
/// fee_total — avoids 1-base-unit accounting drift from triple integer
/// division (which would otherwise round 3 × `fee_total/3` to `fee_total - 1`
/// or `fee_total - 2`).
pub(crate) fn split_fee(
    fee_total: u64,
    platform_bps: u16,
    weekly_bps: u16,
    _monthly_bps: u16,
) -> (u64, u64, u64) {
    let platform = ((fee_total as u128) * (platform_bps as u128) / 10_000) as u64;
    let weekly = ((fee_total as u128) * (weekly_bps as u128) / 10_000) as u64;
    let monthly = fee_total.saturating_sub(platform).saturating_sub(weekly);
    (platform, weekly, monthly)
}

// ─── Accounts ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct MintPair<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = !config.paused @ BellMarketsError::Paused,
        has_one = usdc_mint,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        seeds = [b"fee_config"],
        bump = fee_config.bump,
        constraint = fee_config.config == config.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub fee_config: Box<Account<'info, FeeConfig>>,

    #[account(
        init_if_needed,
        payer = user,
        space = UserConfig::LEN,
        seeds = [b"user", config.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_config: Box<Account<'info, UserConfig>>,

    #[account(
        mut,
        constraint = strike_market.outcome == Outcome::Unsettled @ BellMarketsError::AlreadySettled,
        constraint = strike_market.config == config.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault", strike_market.key().as_ref()],
        bump = strike_market.vault_bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"yes", strike_market.key().as_ref()],
        bump = strike_market.yes_mint_bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"no", strike_market.key().as_ref()],
        bump = strike_market.no_mint_bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,

    /// Fee-collector USDC ATA — destination for platform_retain_bps share.
    /// Constrained to be a USDC token account owned by `config.treasury`.
    /// Bram/Cleo derive the ATA pubkey client-side via getAssociatedTokenAddress.
    #[account(
        mut,
        token::mint = usdc_mint,
        constraint = fee_collector_usdc.owner == config.treasury @ BellMarketsError::ConfigMismatch,
    )]
    pub fee_collector_usdc: Box<Account<'info, TokenAccount>>,

    /// Weekly rewards pool — destination for weekly_pool_bps share.
    /// PDA at seeds `[b"weekly_pool"]`. P3 creates this; until then mint_pair
    /// fails at deserialization (AccountNotInitialized).
    #[account(
        mut,
        seeds = [b"weekly_pool"],
        bump,
        token::mint = usdc_mint,
    )]
    pub weekly_pool: Box<Account<'info, TokenAccount>>,

    /// Monthly rewards pool — destination for monthly_pool_bps share.
    /// PDA at seeds `[b"monthly_pool"]`.
    #[account(
        mut,
        seeds = [b"monthly_pool"],
        bump,
        token::mint = usdc_mint,
    )]
    pub monthly_pool: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,
    pub clock: Sysvar<'info, Clock>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<MintPair>, amount: u64) -> Result<()> {
    require!(amount > 0, BellMarketsError::ZeroAmount);

    let now = ctx.accounts.clock.unix_timestamp;
    let fee_bps_static = ctx.accounts.fee_config.mint_fee_bps;

    // ── UserConfig: apply decay BEFORE tier lookup ───────────────────────
    // If the PDA was just init_if_needed'd, all fields are zeroed — decay
    // is a no-op (volume == 0 → remains 0). For existing UserConfigs, the
    // lazy decay applies the time-weighted reduction.
    {
        let uc = &mut ctx.accounts.user_config;
        if uc.user == Pubkey::default() {
            // Freshly init'd. Set immutable user pubkey + decay anchor.
            uc.user = ctx.accounts.user.key();
            uc.last_decay_unix = now;
            uc.bump = ctx.bumps.user_config;
        } else {
            // Existing — apply decay to mint_volume_30d.
            uc.mint_volume_30d = apply_linear_decay(uc.mint_volume_30d, uc.last_decay_unix, now);
            uc.last_decay_unix = now;
        }
    }

    // ── Determine creator rebate ─────────────────────────────────────────
    let creator_rebate_bps = ctx.accounts.fee_config.creator_rebate_bps;
    let creator_rebate_fires = creator_rebate_bps > 0
        && ctx.accounts.strike_market.creator == ctx.accounts.user.key()
        && ctx.accounts.strike_market.outcome == Outcome::Unsettled;

    // ── Compute effective fee_bps ────────────────────────────────────────
    let effective_bps: u16 = if fee_bps_static == 0 {
        0
    } else {
        let tier_bps = tier_fee_bps(ctx.accounts.user_config.mint_volume_30d);
        let after_tier = tier_bps.min(fee_bps_static);
        if creator_rebate_fires {
            fee_after_rebate(after_tier, creator_rebate_bps)
        } else {
            after_tier
        }
    };

    let fee_total: u64 = ((amount as u128).saturating_mul(effective_bps as u128) / 10_000) as u64;

    // ── Transfer principal: amount user_usdc → vault (the $1 invariant) ──
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // ── Fee split: 3 transfers if fee_total > 0 ──────────────────────────
    if fee_total > 0 {
        let (platform_amt, weekly_amt, monthly_amt) = split_fee(
            fee_total,
            ctx.accounts.fee_config.platform_retain_bps,
            ctx.accounts.fee_config.weekly_pool_bps,
            ctx.accounts.fee_config.monthly_pool_bps,
        );
        if platform_amt > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_usdc.to_account_info(),
                        to: ctx.accounts.fee_collector_usdc.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                platform_amt,
            )?;
        }
        if weekly_amt > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_usdc.to_account_info(),
                        to: ctx.accounts.weekly_pool.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                weekly_amt,
            )?;
        }
        if monthly_amt > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_usdc.to_account_info(),
                        to: ctx.accounts.monthly_pool.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                monthly_amt,
            )?;
        }
    }

    // ── Mint amount YES + amount NO to user. Authority = strike_market PDA.
    let pyth_feed = ctx.accounts.strike_market.underlying_pyth_feed;
    let expiry_le = ctx.accounts.strike_market.expiry_unix.to_le_bytes();
    let strike_le = ctx.accounts.strike_market.strike_price.to_le_bytes();
    let bump = [ctx.accounts.strike_market.bump];
    let seeds: &[&[u8]] = &[
        b"strike",
        pyth_feed.as_ref(),
        expiry_le.as_ref(),
        strike_le.as_ref(),
        bump.as_ref(),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.strike_market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.user_no.to_account_info(),
                authority: ctx.accounts.strike_market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // ── Update UserConfig + StrikeMarket counters ────────────────────────
    {
        let uc = &mut ctx.accounts.user_config;
        // Lifetime always grows (informational; never tier-relevant)
        uc.mint_volume_lifetime = uc.mint_volume_lifetime.saturating_add(amount);
        // Anti-tier-gaming: only update mint_volume_30d if no creator rebate fired
        if !creator_rebate_fires {
            uc.mint_volume_30d = uc.mint_volume_30d.saturating_add(amount);
        }
    }
    let sm = &mut ctx.accounts.strike_market;
    sm.pairs_outstanding = sm.pairs_outstanding.saturating_add(amount);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── tier_fee_bps ──────────────────────────────────────────────────

    #[test]
    fn tier_tier1_at_zero_volume() {
        assert_eq!(tier_fee_bps(0), TIER_FEE_BPS_TIER1); // 200
    }

    #[test]
    fn tier_tier1_at_boundary_minus_1() {
        assert_eq!(tier_fee_bps(TIER_BREAK_1K_USDC - 1), TIER_FEE_BPS_TIER1);
    }

    #[test]
    fn tier_tier2_at_boundary() {
        assert_eq!(tier_fee_bps(TIER_BREAK_1K_USDC), TIER_FEE_BPS_TIER2); // 150
        assert_eq!(tier_fee_bps(TIER_BREAK_10K_USDC - 1), TIER_FEE_BPS_TIER2);
    }

    #[test]
    fn tier_tier3_at_high_volume() {
        assert_eq!(tier_fee_bps(TIER_BREAK_10K_USDC), TIER_FEE_BPS_TIER3); // 100
        assert_eq!(tier_fee_bps(u64::MAX), TIER_FEE_BPS_TIER3);
    }

    // ── fee_after_rebate ──────────────────────────────────────────────

    #[test]
    fn rebate_full_zeros_fee() {
        // 100% rebate → 0 effective fee
        assert_eq!(fee_after_rebate(200, 10_000), 0);
    }

    #[test]
    fn rebate_zero_preserves_fee() {
        // 0% rebate → unchanged fee
        assert_eq!(fee_after_rebate(200, 0), 200);
    }

    #[test]
    fn rebate_half_halves_fee() {
        // 50% rebate → half fee
        assert_eq!(fee_after_rebate(200, 5_000), 100);
    }

    #[test]
    fn rebate_truncates_on_int_div() {
        // 33% rebate, 200 tier: 200 × 6700 / 10000 = 134
        assert_eq!(fee_after_rebate(200, 3_300), 134);
    }

    // ── apply_linear_decay ────────────────────────────────────────────

    #[test]
    fn decay_zero_elapsed_preserves_volume() {
        assert_eq!(apply_linear_decay(1000, 100, 100), 1000);
    }

    #[test]
    fn decay_clock_skew_preserves_volume() {
        // now < last_decay (clock went backwards) — defensive, no decay
        assert_eq!(apply_linear_decay(1000, 200, 100), 1000);
    }

    #[test]
    fn decay_full_window_zeros_volume() {
        assert_eq!(
            apply_linear_decay(1000, 0, MINT_VOLUME_DECAY_WINDOW_SECS as i64),
            0
        );
        // And past the window
        assert_eq!(
            apply_linear_decay(1000, 0, (MINT_VOLUME_DECAY_WINDOW_SECS + 1) as i64),
            0
        );
    }

    #[test]
    fn decay_half_window_halves_volume() {
        let half = (MINT_VOLUME_DECAY_WINDOW_SECS / 2) as i64;
        let result = apply_linear_decay(1000, 0, half);
        // floor of 1000 * (DECAY_WINDOW - half) / DECAY_WINDOW = 500
        assert_eq!(result, 500);
    }

    #[test]
    fn decay_property_monotone_decreasing() {
        // As elapsed grows, surviving volume strictly decreases (until 0).
        let mut last = u64::MAX;
        for elapsed in (0..MINT_VOLUME_DECAY_WINDOW_SECS).step_by(86_400) {
            let v = apply_linear_decay(1_000_000_000, 0, elapsed as i64);
            assert!(v <= last, "non-monotone at elapsed={elapsed}: {v} > {last}");
            last = v;
        }
    }

    #[test]
    fn decay_property_proportional_to_initial() {
        // Decay is linear in volume — doubling volume doubles the surviving amount.
        let now = (MINT_VOLUME_DECAY_WINDOW_SECS / 3) as i64;
        let v1 = apply_linear_decay(100, 0, now);
        let v2 = apply_linear_decay(200, 0, now);
        // Allow ±1 unit for integer division
        assert!(v2 >= 2 * v1 - 1 && v2 <= 2 * v1 + 2, "v1={v1}, v2={v2}");
    }

    // ── split_fee ─────────────────────────────────────────────────────

    #[test]
    fn split_sums_exactly_to_fee_total() {
        // Defaults: 50/25/25
        let (p, w, m) = split_fee(1_000_000, 5_000, 2_500, 2_500);
        assert_eq!(p + w + m, 1_000_000);
        assert_eq!(p, 500_000);
        assert_eq!(w, 250_000);
        assert_eq!(m, 250_000);
    }

    #[test]
    fn split_handles_uneven_remainder() {
        // fee=7 with 50/25/25: ideally 3.5/1.75/1.75 → 3/1/3 (monthly catches remainder)
        let (p, w, m) = split_fee(7, 5_000, 2_500, 2_500);
        assert_eq!(p + w + m, 7);
        assert_eq!(p, 3);
        assert_eq!(w, 1);
        assert_eq!(m, 3); // 7 - 3 - 1 = 3 (catches both rounding losses)
    }

    #[test]
    fn split_promo_mode() {
        // DR-010 § Promo mode: 0/50/50
        let (p, w, m) = split_fee(1000, 0, 5_000, 5_000);
        assert_eq!(p, 0);
        assert_eq!(w, 500);
        assert_eq!(m, 500);
        assert_eq!(p + w + m, 1000);
    }

    #[test]
    fn split_property_sum_equals_fee_total_over_sweep() {
        // Property: regardless of fee_total OR bps configuration (as long as it
        // sums to 10_000), the (platform, weekly, monthly) tuple sums to
        // fee_total exactly.
        let bps_configs: &[(u16, u16, u16)] = &[
            (5_000, 2_500, 2_500),
            (10_000, 0, 0),
            (0, 5_000, 5_000),
            (3_333, 3_333, 3_334),
            (0, 0, 10_000),
            (1, 1, 9_998),
        ];
        for &(p_bps, w_bps, m_bps) in bps_configs {
            for fee_total in [0u64, 1, 2, 3, 7, 100, 1_000, 1_000_000, u64::MAX / 2].iter().copied() {
                let (p, w, m) = split_fee(fee_total, p_bps, w_bps, m_bps);
                assert_eq!(p.saturating_add(w).saturating_add(m), fee_total,
                    "mismatch at fee={fee_total}, bps=({p_bps},{w_bps},{m_bps}): got ({p},{w},{m})");
            }
        }
    }
}
