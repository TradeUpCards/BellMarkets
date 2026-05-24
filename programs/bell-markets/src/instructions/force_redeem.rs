//! `force_redeem` — admin sweep for stranded balances post-settle.
//!
//! Per `cory_questions_1_answers.md` § "Option A — Force-redeem-to-user
//! after grace period": after a configurable grace window past settlement
//! (default 30 days), admin can claim USDC on behalf of a user who never
//! called `redeem` themselves. USDC goes to the USER's wallet (not admin —
//! the user is "made whole"; admin is the cranker).
//!
//! ## SPL Token authorization model (read carefully — affects UX)
//!
//! `Burn` requires the source token account's owner OR a delegate to sign.
//! force_redeem signs with `strike_market` PDA as the burn authority.
//! This succeeds ONLY IF the user has previously called SPL Token `Approve`
//! granting `strike_market` PDA as a delegate of `user_winning_token`.
//!
//! For users who haven't opted in: the SPL Token CPI returns
//! `OwnerMismatch` and the entire `force_redeem` tx reverts gracefully —
//! no partial state mutation. Cleo's "Enable force-redeem eligibility"
//! UI flow (Cleo-domain) wires the user-signed `Approve(strike_market_pda,
//! u64::MAX)` for both YES and NO mints, so future force_redeems against
//! THIS user succeed.
//!
//! Per cory_questions_1_answers.md, this is a v2/v2.5 ix — the MVP demo does
//! not require force_redeem. The mechanism ships INFRASTRUCTURE so the
//! grace_secs default (30 days) is met before any market would even be
//! eligible. Admin runs it after real-world unredeemed balances accumulate.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::BellMarketsError;
use crate::instructions::redeem::validate_winning_mint;

/// Returns true iff the grace window has elapsed: `now > settled_at + grace_secs`.
///
/// Extracted from the handler so the time-gate logic is unit-testable
/// without a full `Context`. `saturating_add` is the defensive arithmetic:
/// if `settled_at + grace_secs` would overflow i64, the saturated result is
/// `i64::MAX`, blocking force_redeem forever — fail-closed, which is the
/// desired behavior for any corrupted state that could allow earlier-than-
/// intended sweeps.
pub(crate) fn grace_period_elapsed(now: i64, settled_at: i64, grace_secs: i64) -> bool {
    now > settled_at.saturating_add(grace_secs)
}

#[derive(Accounts)]
pub struct ForceRedeem<'info> {
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
        seeds = [b"fee_config"],
        bump = fee_config.bump,
        constraint = fee_config.config == config.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub fee_config: Box<Account<'info, FeeConfig>>,

    #[account(
        mut,
        constraint = strike_market.outcome != Outcome::Unsettled @ BellMarketsError::NotSettled,
        constraint = strike_market.config == config.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// CHECK: user wallet pubkey — bound by user_winning_token.owner == user.key().
    pub user: UncheckedAccount<'info>,

    #[account(mut)]
    pub winning_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        token::mint = winning_mint,
        constraint = user_winning_token.owner == user.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub user_winning_token: Box<Account<'info, TokenAccount>>,

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
        token::mint = usdc_mint,
        constraint = user_usdc.owner == user.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,
    pub clock: Sysvar<'info, Clock>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ForceRedeem>, amount: u64) -> Result<()> {
    require!(amount > 0, BellMarketsError::ZeroAmount);

    // Grace-period gate. force_redeem is an admin sweep ONLY after the
    // user has had `force_redeem_grace_secs` (default 30 days) to claim.
    // See `grace_period_elapsed` for the saturating-add fail-closed
    // semantics. `force_redeem_grace_period_active` test below pins this.
    require!(
        grace_period_elapsed(
            ctx.accounts.clock.unix_timestamp,
            ctx.accounts.strike_market.settled_at_unix,
            ctx.accounts.fee_config.force_redeem_grace_secs,
        ),
        BellMarketsError::ForceRedeemGraceActive
    );

    // Verify winning_mint matches outcome — DRY with redeem.rs. Same helper
    // means same audit surface: a regression there would also break
    // force_redeem.
    //
    // TODO(v2.5): `validate_winning_mint` rejects Invalid outcomes by design.
    // No admin force-sweep path for Invalid markets — users who abandon
    // Invalid positions cannot be swept by admin via this ix. The fix is a
    // dedicated `force_redeem_invalid` ix (burns equal YES + NO via delegate
    // + refunds USDC + decrements pairs_outstanding, mirroring `redeem_invalid`
    // but with admin signer + strike_market PDA as burn delegate). Not
    // blocking MVP since Invalid markets are admin-override-only (rare).
    // `force_redeem_rejects_invalid_outcome` test below pins the gap.
    validate_winning_mint(
        ctx.accounts.strike_market.outcome,
        ctx.accounts.strike_market.yes_mint,
        ctx.accounts.strike_market.no_mint,
        ctx.accounts.winning_mint.key(),
    )?;

    // Signer seeds: strike_market PDA acts as both the burn delegate (via
    // user's prior Approve) AND the vault transfer authority. The Burn CPI
    // succeeds only if user previously called Approve(strike_market_pda,
    // delegate, u64::MAX) on their token account; if not, the CPI errors
    // OwnerMismatch (a graceful revert — see file header).
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

    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.winning_mint.to_account_info(),
                from: ctx.accounts.user_winning_token.to_account_info(),
                authority: ctx.accounts.strike_market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // Transfer `amount` USDC from vault → user's USDC ATA. Vault authority
    // is the strike_market PDA (self-authority — same as redeem path).
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.strike_market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    let sm = &mut ctx.accounts.strike_market;
    sm.pairs_outstanding = sm.pairs_outstanding.saturating_sub(amount);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADVERSARIAL: admin (or a compromised admin key) tries to sweep BEFORE
    /// the user's grace window has elapsed. The Accounts constraint allows
    /// the ix to enter the handler; the `grace_period_elapsed` check is the
    /// load-bearing guard that rejects early sweeps with
    /// `ForceRedeemGraceActive`.
    ///
    /// Test methodology: every parameter is a pure i64; no Context needed.
    /// We hit the inclusive vs exclusive boundary at `now == settled_at +
    /// grace` (must reject, since the check is `now > ...`) plus the
    /// just-elapsed case (`now == settled_at + grace + 1` accepts).
    #[test]
    fn force_redeem_grace_period_active() {
        let settled_at = 1_700_000_000i64; // arbitrary post-settle timestamp
        let grace = 30 * 24 * 60 * 60i64;   // 30 days (DR-008 default)
        let boundary = settled_at + grace;

        // --- Adversarial: immediate sweep on settlement day.
        assert!(
            !grace_period_elapsed(settled_at, settled_at, grace),
            "sweep on settlement day MUST be blocked"
        );

        // --- Adversarial: one second before grace ends.
        assert!(
            !grace_period_elapsed(boundary - 1, settled_at, grace),
            "sweep 1 sec before grace end MUST be blocked"
        );

        // --- Boundary: exactly at grace end. Spec says `now > settled_at +
        //     grace` (strict greater), so the exact moment STILL blocks.
        assert!(
            !grace_period_elapsed(boundary, settled_at, grace),
            "sweep AT exact grace boundary MUST be blocked (strict inequality)"
        );

        // --- Happy path: 1 second past grace.
        assert!(
            grace_period_elapsed(boundary + 1, settled_at, grace),
            "sweep 1 sec past grace MUST be allowed"
        );

        // --- Adversarial: massive grace_secs that overflows i64 when added
        //     to settled_at. saturating_add caps at i64::MAX → `now > MAX`
        //     is impossible → forever-blocked. Fail-closed.
        assert!(
            !grace_period_elapsed(i64::MAX, i64::MAX - 100, i64::MAX),
            "overflow case MUST fail-closed (block forever)"
        );

        // --- Adversarial: clock skew backwards (now < settled_at). Impossible
        //     for honest Solana clocks but worth pinning.
        assert!(
            !grace_period_elapsed(settled_at - 1000, settled_at, grace),
            "clock-skew-backwards MUST be blocked"
        );
    }

    /// ADVERSARIAL: an Invalid-outcome market still has stranded user
    /// balances (admin used `admin_settle` to mark the market unrecoverable
    /// when the oracle failed past override-delay). Without a dedicated
    /// `force_redeem_invalid` ix (v2.5 — see TODO in handler), `force_redeem`
    /// MUST refuse Invalid outcomes outright. Test pins the documented gap.
    ///
    /// Composes with `validate_winning_mint` from `redeem.rs` — that helper
    /// rejects Invalid + Unsettled by design; force_redeem inherits the
    /// rejection via the shared helper. Coverage here = the `force_redeem`
    /// flow specifically (in addition to the `redeem_wrong_mint_substitution`
    /// coverage at the helper layer).
    #[test]
    fn force_redeem_rejects_invalid_outcome() {
        let yes_mint = Pubkey::new_unique();
        let no_mint = Pubkey::new_unique();
        // Even when supplying the right pubkey (yes_mint), Invalid is rejected.
        assert!(
            validate_winning_mint(Outcome::Invalid, yes_mint, no_mint, yes_mint).is_err(),
            "Invalid outcome rejection is force_redeem's documented v2.5 gap — \
             test pins the rejection so a future relaxation requires explicit \
             design discussion"
        );
        assert!(
            validate_winning_mint(Outcome::Invalid, yes_mint, no_mint, no_mint).is_err()
        );
    }
}
