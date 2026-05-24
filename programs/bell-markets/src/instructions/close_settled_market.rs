//! `close_settled_market` — permissionless rent recovery for fully-redeemed
//! markets. Per cory_questions_1_answers.md § PDA Economics — once
//! `pairs_outstanding == 0` (every minted pair has been redeemed via
//! `redeem` / `redeem_pair` / `redeem_invalid` / `force_redeem`), the USDC
//! vault is empty and can be closed to recover ~$0.23 rent to fee_collector.
//!
//! ## Scope: vault rent only (best-effort)
//!
//! YES/NO mints are NOT closed here even when their supply may be 0.
//! Rationale: SPL Token's `CloseAccount` on a Mint requires the Mint to have
//! a `close_authority` AND for `supply == 0`. Our mints were created without
//! an explicit close_authority (default Anchor `init` for Mint sets none),
//! so closing them would require a separate flow (`SetAuthority` then
//! `CloseAccount`). The ~$0.22 mint rent per market remains stranded as the
//! known trade-off documented in cory_questions_1_answers.md §"Updated cost
//! analysis".
//!
//! ## StrikeMarket as tombstone
//!
//! Per Tate's spec: the StrikeMarket PDA itself is NOT closed. It remains as
//! a tombstone for historical queries (settle price, outcome, etc.).
//! `pairs_outstanding == 0` is the on-chain signal that no further activity
//! is expected; downstream indexers can filter on this.
//!
//! ## Permissionless cleanup
//!
//! Any signer can call this — fee_collector receives the recovered rent
//! regardless of who cranks. Mirrors DR-002's settle-permissionless design:
//! the operation is safe (every gate is on-chain), so don't gate it behind
//! admin authority.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount};
use crate::state::*;
use crate::errors::BellMarketsError;

/// Returns Ok iff the strike market is in the right shape for vault closure.
/// Extracted from the handler so the dust-attack griefing path is unit-testable.
///
/// Three gates compose:
///   - `outcome != Unsettled` — Accounts constraint (also enforced upstream)
///   - `pairs_outstanding == 0` — every minted pair has been redeemed
///   - `vault_amount == 0` — SPL Token CloseAccount requires this
///
/// The third gate is the load-bearing one for the dust-attack scenario:
/// `pairs_outstanding == 0` would normally IMPLY `vault.amount == 0` under
/// the `$1`-invariant flow, but anyone can `Token::Transfer` USDC into the
/// public vault PDA. That dust would block the close at the SPL Token layer
/// with `NonNativeHasBalance`. Surfacing the same condition with our own
/// `MarketNotEmpty` error gives operators a diagnosable signal. The
/// `close_settled_dust_attack_griefing` test below pins this.
pub(crate) fn can_close_settled_market(
    outcome: Outcome,
    pairs_outstanding: u64,
    vault_amount: u64,
) -> Result<()> {
    require!(
        outcome != Outcome::Unsettled,
        BellMarketsError::NotSettled
    );
    require!(
        pairs_outstanding == 0,
        BellMarketsError::MarketNotEmpty
    );
    require!(
        vault_amount == 0,
        BellMarketsError::MarketNotEmpty
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CloseSettledMarket<'info> {
    #[account(mut)]
    pub closer: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        constraint = strike_market.outcome != Outcome::Unsettled
            @ BellMarketsError::NotSettled,
        constraint = strike_market.config == config.key()
            @ BellMarketsError::ConfigMismatch,
        constraint = strike_market.pairs_outstanding == 0
            @ BellMarketsError::MarketNotEmpty,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    #[account(
        mut,
        seeds = [b"vault", strike_market.key().as_ref()],
        bump = strike_market.vault_bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: rent recipient — pubkey-binding check below enforces
    /// fee_collector.key() == config.treasury. fee_collector receives ONLY
    /// the vault's rent lamports. SPL Token's CloseAccount rejects close if
    /// `usdc_vault.amount > 0` — the explicit pre-check below surfaces this
    /// with our `MarketNotEmpty` error instead of the raw SPL Token error.
    ///
    /// Dust-attack griefing: anyone can `Token::Transfer` USDC into the
    /// vault address (it's a public token account). With `pairs_outstanding
    /// == 0` (our gate) but `vault.amount > 0` (the dust), close_settled
    /// reverts cleanly via our pre-check. The dust remains stranded in
    /// the vault PDA. No protocol funds at risk; rent stays unrecovered
    /// for that specific market until a future sweep ix is added.
    #[account(
        mut,
        constraint = fee_collector.key() == config.treasury @ BellMarketsError::ConfigMismatch,
    )]
    pub fee_collector: UncheckedAccount<'info>,

    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CloseSettledMarket>) -> Result<()> {
    // All gating delegated to `can_close_settled_market` for direct
    // unit-test coverage of every rejection branch (outcome unsettled,
    // pairs_outstanding non-zero, vault dust). Three pure parameters
    // → no Context needed for the test surface.
    can_close_settled_market(
        ctx.accounts.strike_market.outcome,
        ctx.accounts.strike_market.pairs_outstanding,
        ctx.accounts.usdc_vault.amount,
    )?;

    // Close usdc_vault → rent lamports flow to fee_collector. Vault authority
    // is the strike_market PDA (self-authority).
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

    token::close_account(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.usdc_vault.to_account_info(),
                destination: ctx.accounts.fee_collector.to_account_info(),
                authority: ctx.accounts.strike_market.to_account_info(),
            },
            signer_seeds,
        ),
    )?;

    // Mints + StrikeMarket left in place. See file header for rationale.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADVERSARIAL: an attacker dust-transfers 1 lamport-equivalent USDC
    /// (i.e., 1 base unit = $0.000001) into the public vault PDA after all
    /// legitimate users have redeemed. `pairs_outstanding == 0` (the
    /// Accounts constraint) is satisfied; SPL Token's CloseAccount would
    /// then return `NonNativeHasBalance` mid-CPI, which surfaces as an
    /// opaque error code. Our explicit `vault_amount == 0` check catches
    /// the grief BEFORE the CPI and returns our own `MarketNotEmpty` error.
    ///
    /// Attack outcome (current design): the vault stays open; the closer's
    /// tx reverts with a clear error code; the dust + ~$0.23 vault rent
    /// remain locked. No protocol funds at risk. A future sweep mechanism
    /// could rescue the rent; not in MVP scope.
    #[test]
    fn close_settled_dust_attack_griefing() {
        // --- Happy path: settled market, no outstanding pairs, empty vault.
        assert!(can_close_settled_market(Outcome::Yes, 0, 0).is_ok());
        assert!(can_close_settled_market(Outcome::No, 0, 0).is_ok());
        assert!(can_close_settled_market(Outcome::Invalid, 0, 0).is_ok());

        // --- Adversarial: dust attack. pairs_outstanding == 0 (every legit
        //     user redeemed) but an attacker pushed 1 base unit into the
        //     vault. MUST reject with MarketNotEmpty (NOT silently fall
        //     through to the SPL Token NonNativeHasBalance error).
        assert!(
            can_close_settled_market(Outcome::Yes, 0, 1).is_err(),
            "1-base-unit dust attack MUST be rejected at the helper layer"
        );

        // --- Adversarial: larger dust amounts behave the same.
        assert!(can_close_settled_market(Outcome::Yes, 0, 1_000).is_err());
        assert!(can_close_settled_market(Outcome::Yes, 0, u64::MAX).is_err());

        // --- Other rejection branches:
        // pairs_outstanding > 0 → market still has live positions.
        assert!(can_close_settled_market(Outcome::Yes, 1, 0).is_err());
        assert!(can_close_settled_market(Outcome::Yes, 100, 0).is_err());

        // Unsettled → not eligible regardless of balances.
        assert!(can_close_settled_market(Outcome::Unsettled, 0, 0).is_err());
        assert!(can_close_settled_market(Outcome::Unsettled, 5, 1).is_err());
    }

    #[test]
    fn close_property_only_specific_triple_passes() {
        // Property: ONLY (outcome != Unsettled, pairs == 0, vault == 0) passes.
        // Sweep all (outcome, pairs ∈ {0, 1, 99}, vault ∈ {0, 1, 99}) combos.
        let outcomes = [Outcome::Unsettled, Outcome::Yes, Outcome::No, Outcome::Invalid];
        let counts: [u64; 3] = [0, 1, 99];
        for &outcome in &outcomes {
            for pairs in counts {
                for vault in counts {
                    let result = can_close_settled_market(outcome, pairs, vault);
                    let should_pass = outcome != Outcome::Unsettled && pairs == 0 && vault == 0;
                    assert_eq!(
                        result.is_ok(), should_pass,
                        "outcome={outcome:?} pairs={pairs} vault={vault} → should_pass={should_pass} but got is_ok={}",
                        result.is_ok()
                    );
                }
            }
        }
    }
}
