//! `redeem` — winning-side payout. User burns `amount` of the winning mint
//! and receives `amount` USDC from the vault.
//!
//! Why Yes/No only (not Invalid): this Accounts struct has a single
//! `winning_mint` + `user_winning_token` pair, which fits the binary-payout
//! shape (one winner, one loser) but cannot represent the symmetric
//! "burn both sides" shape that Invalid markets need. The dedicated
//! `redeem_invalid` instruction handles that.
//!
//! Why no fee on the redeem path: the $1 USDC invariant is load-bearing
//! (Hard YES #1). Any fee here would break the property that aggregate
//! redemptions == aggregate deposits for the winning side. Platform fees, if
//! ever added, should live on `mint_pair` instead (charge on entry, exit
//! is pure).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        constraint = strike_market.outcome != Outcome::Unsettled @ BellMarketsError::NotSettled,
        constraint = strike_market.config == config.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// The mint corresponding to the user's winning side. The handler
    /// enforces `winning_mint == strike_market.yes_mint` (if outcome == Yes)
    /// or `== strike_market.no_mint` (if outcome == No).
    #[account(mut)]
    pub winning_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = winning_mint, token::authority = user)]
    pub user_winning_token: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault", strike_market.key().as_ref()],
        bump = strike_market.vault_bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// Validate the supplied `winning_mint` pubkey matches the strike's outcome.
///
/// LOAD-BEARING. Unlike `redeem_pair` / `redeem_invalid` (which seed their
/// yes/no mints via PDA constraints in the `Accounts` struct), this ix
/// allows the caller to supply ANY mint as `winning_mint` — Anchor's PDA
/// constraint can't statically catch the substitution because the correct
/// mint depends on a runtime field (`strike_market.outcome`). This function
/// IS the safety check.
///
/// Adversarial scenario it defeats: user holds losing-side tokens, supplies
/// the LOSING mint as `winning_mint` to try to burn losing tokens for USDC.
/// `redeem_wrong_mint_substitution` test below pins this.
pub(crate) fn validate_winning_mint(
    outcome: Outcome,
    strike_yes_mint: Pubkey,
    strike_no_mint: Pubkey,
    supplied_winning_mint: Pubkey,
) -> Result<()> {
    let expected = match outcome {
        Outcome::Yes => strike_yes_mint,
        Outcome::No => strike_no_mint,
        // Invalid + Unsettled are filtered upstream (Accounts constraint +
        // explicit `outcome != Invalid` check in handler). Defensive: return
        // the same error code the handler returns, so a future refactor that
        // removes the upstream guard still fails closed.
        Outcome::Invalid | Outcome::Unsettled => {
            return Err(BellMarketsError::InvalidOutcomeForRedeem.into());
        }
    };
    require!(
        supplied_winning_mint == expected,
        BellMarketsError::InvalidOutcomeForRedeem
    );
    Ok(())
}

pub fn handler(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    require!(amount > 0, BellMarketsError::ZeroAmount);

    // Yes/No only — Invalid markets refund the original pair deposit and
    // require both mints + both user token accounts; that path lives in the
    // dedicated `redeem_invalid` instruction (see ../redeem_invalid.rs).
    let outcome = ctx.accounts.strike_market.outcome;
    require!(outcome != Outcome::Invalid, BellMarketsError::InvalidOutcomeForRedeem);
    validate_winning_mint(
        outcome,
        ctx.accounts.strike_market.yes_mint,
        ctx.accounts.strike_market.no_mint,
        ctx.accounts.winning_mint.key(),
    )?;

    // Burn `amount` of winning_mint from user (user authority).
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.winning_mint.to_account_info(),
                from: ctx.accounts.user_winning_token.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Transfer `amount` USDC vault → user. Vault authority is strike_market PDA.
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

    // P2 / DR-008: decrement pairs_outstanding so close_settled_market (P4)
    // can gate on `== 0`. saturating_sub guards the 7 pre-DR-008 META markets
    // which started with the counter at 0; those pre-counter mints are
    // best-effort and won't make the counter negative.
    let sm = &mut ctx.accounts.strike_market;
    sm.pairs_outstanding = sm.pairs_outstanding.saturating_sub(amount);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CANONICAL ADVERSARIAL TEST for the runtime check at `redeem.rs` lines
    /// 82-85 (now extracted into `validate_winning_mint`). Pins the exact
    /// attack `redeem` is hardened against: user holds losing tokens and
    /// substitutes the losing mint pubkey for `winning_mint` to extract
    /// USDC despite holding the wrong side.
    ///
    /// Why this is load-bearing: `redeem_pair` and `redeem_invalid` both
    /// SEED their yes/no mints via PDA constraints in the `#[derive(Accounts)]`
    /// struct, so Anchor enforces the correct mint statically. `redeem`
    /// cannot — the correct mint depends on the dynamic `outcome` field on
    /// `strike_market`. Anchor's static analyzer has no way to know whether
    /// you should expect `yes_mint` or `no_mint` until runtime. This helper
    /// IS the safety; deletion or relaxation of it = funds drain by losing
    /// holders.
    #[test]
    fn redeem_wrong_mint_substitution() {
        let yes_mint = Pubkey::new_unique();
        let no_mint = Pubkey::new_unique();
        let unrelated_mint = Pubkey::new_unique();

        // --- Adversarial: market settled YES; attacker holding NO supplies
        //     NO's mint as `winning_mint` to redeem losing tokens for $1.
        assert!(
            validate_winning_mint(Outcome::Yes, yes_mint, no_mint, no_mint).is_err(),
            "attacker substituting NO mint when outcome=Yes MUST be rejected"
        );

        // --- Adversarial: market settled NO; attacker holding YES supplies
        //     YES's mint as `winning_mint`.
        assert!(
            validate_winning_mint(Outcome::No, yes_mint, no_mint, yes_mint).is_err(),
            "attacker substituting YES mint when outcome=No MUST be rejected"
        );

        // --- Adversarial: attacker supplies an unrelated mint (e.g., from a
        //     different strike market) hoping to confuse the check.
        assert!(
            validate_winning_mint(Outcome::Yes, yes_mint, no_mint, unrelated_mint).is_err(),
            "unrelated mint MUST be rejected on Yes outcome"
        );
        assert!(
            validate_winning_mint(Outcome::No, yes_mint, no_mint, unrelated_mint).is_err(),
            "unrelated mint MUST be rejected on No outcome"
        );

        // --- Adversarial defense-in-depth: even if the upstream Accounts
        //     constraint somehow let an Unsettled or Invalid outcome reach
        //     this helper (it shouldn't), the helper itself returns an error.
        assert!(
            validate_winning_mint(Outcome::Invalid, yes_mint, no_mint, yes_mint).is_err(),
            "Invalid outcome MUST be rejected at the helper layer (defense in depth)"
        );
        assert!(
            validate_winning_mint(Outcome::Unsettled, yes_mint, no_mint, yes_mint).is_err(),
            "Unsettled outcome MUST be rejected at the helper layer (defense in depth)"
        );

        // --- Happy path: correct mint accepted.
        assert!(validate_winning_mint(Outcome::Yes, yes_mint, no_mint, yes_mint).is_ok());
        assert!(validate_winning_mint(Outcome::No, yes_mint, no_mint, no_mint).is_ok());
    }

    #[test]
    fn redeem_wrong_mint_property_only_canonical_pair_accepted() {
        // Property: across a sweep of (yes_mint, no_mint, supplied_mint),
        // validate_winning_mint accepts EXACTLY the (outcome → matching mint)
        // pair and rejects everything else.
        let yes_mint = Pubkey::new_unique();
        let no_mint = Pubkey::new_unique();
        let candidates = [yes_mint, no_mint, Pubkey::new_unique(), Pubkey::default()];

        for &supplied in &candidates {
            let yes_ok = validate_winning_mint(Outcome::Yes, yes_mint, no_mint, supplied).is_ok();
            let no_ok = validate_winning_mint(Outcome::No, yes_mint, no_mint, supplied).is_ok();
            // Yes outcome accepts ONLY yes_mint.
            assert_eq!(yes_ok, supplied == yes_mint, "Yes outcome decision wrong for supplied {supplied}");
            // No outcome accepts ONLY no_mint.
            assert_eq!(no_ok, supplied == no_mint, "No outcome decision wrong for supplied {supplied}");
        }
    }
}
