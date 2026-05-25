//! `init_order_book` — phase 1 of two-instruction OrderBook creation
//! (per DR-020 + Keith's spec §"Order-book creation is two instructions").
//!
//! ## Why two instructions
//!
//! Solana's `MAX_PERMITTED_DATA_INCREASE` = 10,240 bytes per ix caps how much
//! account data can be allocated via a single `system_program::create_account`
//! CPI (and the equivalent cap on realloc). The `OrderBook` PDA needs ~14.7
//! KB to hold its `[Order; 128]` bid + ask arrays. So we split:
//!
//!   1. `init_order_book` (this ix) — allocate `ORDER_BOOK_INIT_ALLOC`
//!      (10,000 bytes) via raw `system_program::create_account` CPI. Write
//!      the 8-byte anchor discriminator + head fields (market back-ref +
//!      bump). Bids/asks region exists but only partially (~9.9 KB available
//!      / ~14.6 KB needed) — any trading ix's `Account<OrderBook>` deserialize
//!      would fail here, which is the natural trading gate.
//!      Also initializes the two per-market escrow token accounts (usdc_escrow
//!      + yes_escrow), owned by the StrikeMarket PDA.
//!   2. `grow_order_book` — `realloc` the PDA to full `OrderBook::LEN`,
//!      top up rent, and wire `StrikeMarket.order_book = order_book.key()` —
//!      the trading gate opens.
//!
//! ## Permissionless
//!
//! Per Keith's spec: anyone can call init + grow. Once the strike exists
//! (`create_strike_market` or `user_create_strike_market`), any user can
//! crank the book into existence. Caller pays SOL rent (~0.07 SOL for the
//! ~10 KB OrderBook + ~0.002 SOL × 2 for the escrow ATAs).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::errors::BellMarketsError;
use crate::state::*;

#[derive(Accounts)]
pub struct InitOrderBook<'info> {
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
        constraint = strike_market.config == config.key() @ BellMarketsError::ConfigMismatch,
        // No outcome constraint — init can happen any time; trading gate is
        // grow_order_book wiring strike_market.order_book.
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// CHECK: PDA created in handler via system_program::create_account CPI
    /// at smaller-than-OrderBook::LEN size. Anchor's `init` constraint can't
    /// be used here because it would require typed deserialization at the
    /// smaller allocation, which the borsh layout doesn't permit. The PDA
    /// derivation is verified by Anchor via `seeds + bump`; ownership +
    /// discriminator are written manually below.
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, strike_market.key().as_ref()],
        bump,
    )]
    pub order_book: UncheckedAccount<'info>,

    /// USDC mint — also bound on `MarketConfig.usdc_mint` via `has_one` above.
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// YES mint — PDA-bound to the strike. Used as the mint for the
    /// `yes_escrow` token account.
    #[account(
        seeds = [b"yes", strike_market.key().as_ref()],
        bump = strike_market.yes_mint_bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    /// Per-market USDC escrow for resting bid orders. Authority = strike_market
    /// PDA (reused per DR-020 — no separate mint_authority PDA, matches our
    /// existing usdc_vault pattern). Init via Anchor's standard token::init
    /// path; small enough to fit in one ix.
    #[account(
        init,
        payer = user,
        seeds = [USDC_ESCROW_SEED, strike_market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// Per-market YES escrow for resting ask orders. Authority = strike_market
    /// PDA.
    #[account(
        init,
        payer = user,
        seeds = [YES_ESCROW_SEED, strike_market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = strike_market,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitOrderBook>) -> Result<()> {
    let order_book_info = ctx.accounts.order_book.to_account_info();

    // Must not already exist (handler-level idempotency check; Anchor's
    // `seeds` constraint guarantees PDA derivation but not initialization
    // state).
    require!(
        order_book_info.data_is_empty(),
        BellMarketsError::OrderBookNotInitialized // Reused error — "already" semantics
    );

    let bump = ctx.bumps.order_book;
    let strike_key = ctx.accounts.strike_market.key();
    let signer_bytes = &[bump];
    let signer_seeds: &[&[u8]] = &[ORDER_BOOK_SEED, strike_key.as_ref(), signer_bytes];

    // Phase 1 allocation: ORDER_BOOK_INIT_ALLOC bytes (10,000) — under
    // MAX_PERMITTED_DATA_INCREASE = 10,240. Grow_order_book will realloc the
    // remaining ~4,661 bytes to reach OrderBook::LEN (14,661).
    //
    // The +8 discriminator is INCLUDED in the allocation; Anchor's
    // OrderBook::DISCRIMINATOR is the 8-byte sha256 prefix that Account<T>
    // checks on deserialize.
    let space: usize = ORDER_BOOK_INIT_ALLOC + 8;
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);

    let create_ix = system_instruction::create_account(
        ctx.accounts.user.key,
        order_book_info.key,
        lamports,
        space as u64,
        &crate::ID,
    );
    invoke_signed(
        &create_ix,
        &[
            ctx.accounts.user.to_account_info(),
            order_book_info.clone(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[signer_seeds],
    )?;

    // Write discriminator + head fields. Tail bytes (arrays region) stay
    // zero-initialized by Solana's create_account guarantee.
    //
    // OrderBook layout (zero_copy, repr(C), field-order-by-alignment):
    //   offset 0..8     : discriminator (Anchor 8-byte sha256)
    //   offset 8..40    : market (Pubkey, 32 bytes)
    //   offset 40..48   : next_seq (u64, 8 bytes) — left zero
    //   offset 48..8240 : bids[128] (Order arrays) — left zero / garbage
    //   offset 8240..16432 : asks[128] — left zero / garbage
    //   offset 16432..16434 : bids_len (u16, 2 bytes) — left zero
    //   offset 16434..16436 : asks_len (u16, 2 bytes) — left zero
    //   offset 16436        : bump (u8)
    //   offset 16437..16448 : _reserved[11] — left zero
    //
    // Only discriminator + market + bump need explicit writes. ORDER_BOOK_INIT_ALLOC
    // is 10_000 payload bytes (+8 disc = 10_008 total), so the bump byte at
    // offset 16_436 is BEYOND the current allocation — bump write happens in
    // grow_order_book after the realloc.
    let mut data = order_book_info.try_borrow_mut_data()?;
    data[0..8].copy_from_slice(&OrderBook::DISCRIMINATOR);
    data[8..40].copy_from_slice(strike_key.as_ref());
    // Note: bump is written by grow_order_book at offset 16_436 (post-realloc).
    let _ = bump; // suppress unused warning; bump is verified at this ix by Anchor's `bump` seed constraint

    Ok(())
}
