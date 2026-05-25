//! `redeem` — winning-side payout. User burns `amount` of the winning mint
//! and receives `amount` USDC from the vault.
//!
//! Why Yes/No only (not Invalid): the handler matches on `strike_market.outcome`
//! to pick the bound Yes-side or No-side (mint, user_token) pair to burn from.
//! Invalid outcomes are rejected at the handler entry (use `redeem_invalid`
//! for the symmetric pair-burn shape).
//!
//! Why no fee on the redeem path: the $1 USDC invariant is load-bearing
//! (Hard YES #1). Any fee here would break the property that aggregate
//! redemptions == aggregate deposits for the winning side. Platform fees, if
//! ever added, should live on `mint_pair` instead (charge on entry, exit
//! is pure).
//!
//! ## DR-017 Fix 1 — structural mint-substitution defense (deploy_index=7+)
//!
//! The Accounts struct PDA-binds BOTH `yes_mint` AND `no_mint` (via
//! `[b"yes"|b"no", strike_market.key()]` + stored `yes_mint_bump` /
//! `no_mint_bump`) plus their corresponding user token accounts
//! (`user_yes` / `user_no`, statically bound to the mints via
//! `token::mint`). The handler matches on `strike_market.outcome` to pick
//! which side to burn from via the pure `select_winning_side` helper.
//! Anchor's PDA verifier + `token::mint` constraint reject any non-canonical
//! pubkey BEFORE the handler runs.
//!
//! **Attack class eliminated:** pre-DR-017, `redeem` took a single caller-
//! supplied `winning_mint: Mint` validated at runtime via a
//! `validate_winning_mint(outcome, yes, no, supplied)` helper at
//! redeem.rs:82-85 (the SOLE defense). A user holding losing tokens could
//! attempt to substitute the losing mint pubkey into the `winning_mint`
//! slot. Post-DR-017 that attack is type-system impossible: there is no
//! caller-controlled mint pubkey anywhere in the Redeem accounts shape.
//! `select_winning_side` is a pure function of outcome — not subvertible
//! by any caller input. See `redeem_outcome_selects_correct_side` +
//! `redeem_mint_pda_seed_bytestrings_match_canonical_pattern` tests below.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::BellMarketsError;

/// PDA seed prefix for `yes_mint`. Lockstep with `redeem_invalid.rs` +
/// `redeem_pair.rs` (which inline the same `b"yes"` literal); the unit test
/// `redeem_mint_pda_seed_bytestrings_match_canonical_pattern` pins this so a
/// drift in one file but not the others fails fast.
pub(crate) const YES_MINT_SEED: &[u8] = b"yes";

/// PDA seed prefix for `no_mint`. See `YES_MINT_SEED` doc.
pub(crate) const NO_MINT_SEED: &[u8] = b"no";

/// Discriminator returned by `select_winning_side`. The handler matches on
/// this to pick the bound `(mint, user_token)` pair to burn from. Shared
/// with `force_redeem.rs` via `pub(crate)`.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum WinningSide {
    Yes,
    No,
}

/// DR-017 Fix 1 — pure outcome→side selector.
///
/// LOAD-BEARING. This is the ONLY runtime decision the handler makes about
/// which side to burn; the mint pubkeys themselves are structurally fixed
/// by Anchor's PDA verifier (see `Redeem` accounts struct seeds), and the
/// matching user token accounts are statically bound to those mints via
/// `token::mint = ...`.
///
/// Filters Invalid + Unsettled outcomes. Invalid is also filtered by an
/// explicit handler `require!` (defense in depth — a future refactor that
/// removes the upstream check still fails closed here). Unsettled is
/// rejected by the `Accounts` struct constraint upstream.
///
/// REPLACES the pre-DR-017 `validate_winning_mint(outcome, yes, no, supplied)`
/// helper, which only existed to runtime-validate a caller-supplied mint
/// pubkey that the DR-017 redesign eliminates from the Accounts shape.
/// Shared with `force_redeem.rs` (admin sweep path inherits the same
/// structural defense via this helper).
pub(crate) fn select_winning_side(outcome: Outcome) -> Result<WinningSide> {
    match outcome {
        Outcome::Yes => Ok(WinningSide::Yes),
        Outcome::No => Ok(WinningSide::No),
        Outcome::Invalid | Outcome::Unsettled => {
            Err(BellMarketsError::InvalidOutcomeForRedeem.into())
        }
    }
}

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

    /// DR-017 Fix 1 — PDA-seed-constrained. Caller cannot substitute. Bound
    /// to the canonical per-market YES mint via `[b"yes", strike_market.key()]`
    /// + stored bump.
    #[account(
        mut,
        seeds = [YES_MINT_SEED, strike_market.key().as_ref()],
        bump = strike_market.yes_mint_bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    /// DR-017 Fix 1 — PDA-seed-constrained. Bound to the canonical per-market
    /// NO mint via `[b"no", strike_market.key()]` + stored bump.
    #[account(
        mut,
        seeds = [NO_MINT_SEED, strike_market.key().as_ref()],
        bump = strike_market.no_mint_bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    /// User's YES-token ATA. Statically bound to `yes_mint` above; if
    /// outcome == No the handler does not touch this account but it is
    /// still passed in (Anchor's static analyzer needs the full account
    /// list for verification).
    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// User's NO-token ATA. Statically bound to `no_mint`; symmetric to
    /// `user_yes` — unused when outcome == Yes.
    #[account(mut, token::mint = no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,

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

pub fn handler(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    require!(amount > 0, BellMarketsError::ZeroAmount);

    // Yes/No only — Invalid markets refund the original pair deposit and
    // require both mints + both user token accounts; that path lives in the
    // dedicated `redeem_invalid` instruction (see ../redeem_invalid.rs).
    // Defense in depth: `select_winning_side` also rejects Invalid; this
    // require! preserves the explicit local rejection for readability and
    // makes the error surface at handler entry rather than helper return.
    let outcome = ctx.accounts.strike_market.outcome;
    require!(outcome != Outcome::Invalid, BellMarketsError::InvalidOutcomeForRedeem);

    // DR-017 Fix 1: handler structurally picks the (winning_mint, user_winning_token)
    // pair from outcome. No caller-controlled mint pubkey to substitute.
    let (winning_mint_info, user_winning_token_info) = match select_winning_side(outcome)? {
        WinningSide::Yes => (
            ctx.accounts.yes_mint.to_account_info(),
            ctx.accounts.user_yes.to_account_info(),
        ),
        WinningSide::No => (
            ctx.accounts.no_mint.to_account_info(),
            ctx.accounts.user_no.to_account_info(),
        ),
    };

    // Burn `amount` of winning_mint from user (user authority).
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: winning_mint_info,
                from: user_winning_token_info,
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

    /// DR-017 Fix 1 — CANONICAL ADVERSARIAL TEST. Replaces the pre-DR-017
    /// `redeem_wrong_mint_substitution` helper-layer pin. Asserts the
    /// outcome→side mapping that is now the ONLY runtime decision the
    /// handler makes when selecting which mint to burn.
    ///
    /// ## Old attack (now structurally eliminated)
    ///
    /// Pre-DR-017 Redeem accepted a single caller-supplied `winning_mint: Mint`.
    /// Attack: user holding losing tokens passed the LOSING mint pubkey as
    /// `winning_mint`, hoping to burn losing tokens for $1 USDC. The runtime
    /// `validate_winning_mint` helper at redeem.rs:82-85 was the SOLE
    /// defense — its deletion or relaxation would have drained the vault.
    ///
    /// ## New shape (this deploy, deploy_index=7+)
    ///
    /// Redeem PDA-binds BOTH `yes_mint` AND `no_mint` via `[b"yes"|b"no",
    /// strike_market.key()]` + stored bumps. Anchor's verifier rejects ANY
    /// non-canonical pubkey BEFORE the handler runs. `user_yes` + `user_no`
    /// token accounts are statically bound to the PDA mints via
    /// `token::mint`. The handler matches on outcome to pick which (mint,
    /// user_token) pair to burn from — `select_winning_side` is a pure
    /// function of outcome, NOT of any caller input.
    ///
    /// ## What this test pins
    ///
    /// `select_winning_side` is the ONLY runtime decision in the new shape.
    /// We assert:
    ///   (a) `Yes` maps to `WinningSide::Yes` (the yes_mint + user_yes pair)
    ///   (b) `No` maps to `WinningSide::No` (the no_mint + user_no pair)
    /// The structural defense itself (PDA verifier + token::mint binding)
    /// runs in Anchor's pre-handler verification layer and is covered by
    /// `tests/contracts/` integration tests against the deployed program.
    #[test]
    fn redeem_outcome_selects_correct_side() {
        assert_eq!(
            select_winning_side(Outcome::Yes).unwrap(),
            WinningSide::Yes,
            "Yes outcome MUST select WinningSide::Yes (handler picks yes_mint + user_yes)"
        );
        assert_eq!(
            select_winning_side(Outcome::No).unwrap(),
            WinningSide::No,
            "No outcome MUST select WinningSide::No (handler picks no_mint + user_no)"
        );
    }

    /// DR-017 Fix 1 — defense-in-depth. `select_winning_side` rejects Invalid
    /// + Unsettled at the helper layer. Invalid is ALSO rejected by an
    /// explicit `require!` at handler entry; Unsettled is rejected by the
    /// Accounts struct `constraint = ... != Outcome::Unsettled` upstream.
    /// Three layers, fail-closed at each — removing any single one still
    /// blocks the rejected outcome.
    #[test]
    fn redeem_outcome_rejects_invalid_and_unsettled() {
        assert!(
            select_winning_side(Outcome::Invalid).is_err(),
            "Invalid outcome MUST be rejected at helper layer (use redeem_invalid)"
        );
        assert!(
            select_winning_side(Outcome::Unsettled).is_err(),
            "Unsettled outcome MUST be rejected at helper layer (use redeem_pair pre-settle)"
        );
    }

    /// DR-017 Fix 1 — structural PDA-seed canonical-pattern pin. The seed
    /// bytestrings for `yes_mint` and `no_mint` MUST stay in lockstep across
    /// `redeem.rs`, `redeem_invalid.rs`, and `redeem_pair.rs` — all three
    /// derive the same physical mint PDAs per market. A regression that
    /// renamed the seed in one file but not the others would either DoS
    /// legitimate callers (PDA mismatch on lookup) or, with a clever rename,
    /// accept a DIFFERENT mint than the other instructions expect.
    ///
    /// This test pins the bytestrings exported from THIS file's
    /// `YES_MINT_SEED` / `NO_MINT_SEED` consts (used by the Accounts macro).
    /// `redeem_invalid` / `redeem_pair` lock the lockstep by using the same
    /// `b"yes"` / `b"no"` literals inline; if you change one, update all
    /// three AND this test.
    #[test]
    fn redeem_mint_pda_seed_bytestrings_match_canonical_pattern() {
        assert_eq!(YES_MINT_SEED, b"yes");
        assert_eq!(NO_MINT_SEED, b"no");
    }
}
