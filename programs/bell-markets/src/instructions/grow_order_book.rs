//! `grow_order_book` — phase 2 of two-instruction OrderBook creation
//! (per DR-020 + Keith's spec).
//!
//! Reallocates the OrderBook PDA from `ORDER_BOOK_INIT_ALLOC + 8` (10,008
//! bytes) up to `OrderBook::LEN` (14,661 bytes). Delta = ~4,653 bytes —
//! under `MAX_PERMITTED_DATA_INCREASE` = 10,240.
//!
//! Tops up rent from the caller and writes `strike_market.order_book =
//! order_book.key()` — opening the trading gate.
//!
//! ## Why AccountInfo (not Box<Account<OrderBook>>) for the order_book field
//!
//! Chicken-and-egg with Anchor's typed validation: `Account<OrderBook>`
//! requires the buffer to deserialize at full LEN. Before realloc the
//! buffer is only ~10 KB — typed deserialize would fail before realloc
//! ran. Using `AccountInfo` lets us realloc manually in the handler, then
//! validate the head fields by reading raw bytes.
//!
//! ## Realloc-safety (Keith's L-5)
//!
//! Solana does NOT zero realloc'd bytes. Safety comes from `bids_len = 0`
//! + `asks_len = 0` (set by `init_order_book`) — readers only iterate the
//! active prefix. Garbage in the unused tail slots is never observed.
//!
//! ## Permissionless. Caller pays the rent top-up.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};
use crate::errors::BellMarketsError;
use crate::state::*;

#[derive(Accounts)]
pub struct GrowOrderBook<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        constraint = strike_market.config == config.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// CHECK: PDA at [ORDER_BOOK_SEED, strike_market.key()]. Validated below
    /// by reading the back-ref bytes at offset 8..40 (market field) and
    /// comparing to strike_market.key(). Typed `Account<OrderBook>` can't be
    /// used here because the account starts under-sized.
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, strike_market.key().as_ref()],
        bump,
        owner = crate::ID,
    )]
    pub order_book: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<GrowOrderBook>) -> Result<()> {
    let order_book_info = ctx.accounts.order_book.to_account_info();

    // Verify discriminator (init_order_book set it).
    {
        let data = order_book_info.try_borrow_data()?;
        require!(
            data.len() >= 8 && data[0..8] == *OrderBook::DISCRIMINATOR,
            BellMarketsError::OrderBookNotInitialized
        );
        // Verify back-ref market matches.
        require!(
            data.len() >= 40,
            BellMarketsError::OrderBookNotInitialized
        );
        let market_bytes: [u8; 32] = data[8..40].try_into().unwrap();
        require!(
            Pubkey::new_from_array(market_bytes) == ctx.accounts.strike_market.key(),
            BellMarketsError::OrderBookMarketMismatch
        );
    }

    let current_len = order_book_info.data_len();
    let target_len: usize = OrderBook::LEN;

    if current_len >= target_len {
        // Already grown — handler is idempotent; just (re)wire the trading
        // gate in case strike_market.order_book was somehow cleared.
        let sm = &mut ctx.accounts.strike_market;
        sm.order_book = ctx.accounts.order_book.key();
        return Ok(());
    }

    // Rent top-up: compute new minimum balance, transfer the delta from user.
    let rent = Rent::get()?;
    let new_min_balance = rent.minimum_balance(target_len);
    let current_balance = order_book_info.lamports();
    if new_min_balance > current_balance {
        let delta = new_min_balance - current_balance;
        let transfer_ix = system_instruction::transfer(
            ctx.accounts.user.key,
            order_book_info.key,
            delta,
        );
        invoke(
            &transfer_ix,
            &[
                ctx.accounts.user.to_account_info(),
                order_book_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    // Realloc. False = do NOT zero new bytes (per L-5 — they aren't zeroed
    // by Solana anyway, and `bids_len`/`asks_len = 0` guarantee no reader
    // ever observes them).
    order_book_info.realloc(target_len, false)?;

    // Write the bump byte at offset 16_436 (now reachable post-realloc).
    // OrderBook layout: bump is at offset 8 + 32 + 8 + (64*128*2) + 2 + 2 = 16_436.
    {
        let bump = ctx.bumps.order_book;
        let mut data = order_book_info.try_borrow_mut_data()?;
        data[16_436] = bump;
        // Defensive: clear bids_len + asks_len in case realloc included
        // garbage at offsets 16_432..16_436 (they sit in the freshly-realloc'd
        // tail region).
        data[16_432..16_434].copy_from_slice(&0u16.to_le_bytes());
        data[16_434..16_436].copy_from_slice(&0u16.to_le_bytes());
    }

    // Open the trading gate.
    let sm = &mut ctx.accounts.strike_market;
    sm.order_book = ctx.accounts.order_book.key();
    Ok(())
}
