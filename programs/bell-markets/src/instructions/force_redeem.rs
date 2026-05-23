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

    let now = ctx.accounts.clock.unix_timestamp;
    let grace = ctx.accounts.fee_config.force_redeem_grace_secs;
    let settled_at = ctx.accounts.strike_market.settled_at_unix;
    require!(
        now > settled_at.saturating_add(grace),
        BellMarketsError::ForceRedeemGraceActive
    );

    // Verify winning_mint matches outcome (mirrors redeem.rs).
    let outcome = ctx.accounts.strike_market.outcome;
    let expected_winning_mint = match outcome {
        Outcome::Yes => ctx.accounts.strike_market.yes_mint,
        Outcome::No => ctx.accounts.strike_market.no_mint,
        // Invalid markets use redeem_invalid (or its admin force-redeem
        // equivalent if/when added). Not in this ix's scope.
        Outcome::Invalid => return Err(BellMarketsError::InvalidOutcomeForRedeem.into()),
        Outcome::Unsettled => unreachable!(), // filtered by Accounts constraint
    };
    require!(
        ctx.accounts.winning_mint.key() == expected_winning_mint,
        BellMarketsError::InvalidOutcomeForRedeem
    );

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
