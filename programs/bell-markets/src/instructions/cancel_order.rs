//! `cancel_order` — DR-020 in-program CLOB cancel.
//!
//! Owner-only. Finds the order by `(side, seq)`. Refunds the exact remaining
//! escrow:
//!   - Bid: `bid_cost_ceil(price, remaining)` USDC from `usdc_escrow` →
//!     user's USDC ATA, PDA-signed.
//!   - Ask: `remaining` YES from `yes_escrow` → user's YES ATA, PDA-signed.
//!
//! Removes the slot via shift-down (matching::remove_bid / remove_ask).
//!
//! ## Allowed when paused/settled (Keith's L-2 + intent)
//!
//! Users must ALWAYS be able to reclaim their escrow, regardless of
//! market state. A paused or settled market still needs the cancel path
//! open so resting orders can be unwound. The only `paused` constraint
//! that DOESN'T apply: this ix doesn't gate on it.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::BellMarketsError;
use crate::matching::{bid_cost_ceil, find_order_index, remove_ask, remove_bid};
use crate::state::*;

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        // Note: NO `!config.paused` constraint — users must be able to
        // reclaim escrow even when the program is paused.
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        constraint = strike_market.config == config.key() @ BellMarketsError::ConfigMismatch,
        constraint = strike_market.order_book == order_book.key() @ BellMarketsError::OrderBookNotInitialized,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// Zero-copy AccountLoader — §4.11 stack safety. Back-ref + bump
    /// checked in handler.
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, strike_market.key().as_ref()],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    #[account(
        seeds = [b"yes", strike_market.key().as_ref()],
        bump = strike_market.yes_mint_bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [USDC_ESCROW_SEED, strike_market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [YES_ESCROW_SEED, strike_market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = strike_market,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CancelOrder>, side: u8, seq: u64) -> Result<()> {
    require!(
        side == SIDE_BID || side == SIDE_ASK,
        BellMarketsError::InvalidSide
    );

    // Locate order by (side, seq) + verify back-ref + snapshot fields.
    let (idx, order_owner, order_price, order_remaining) = {
        let book = ctx.accounts.order_book.load()?;
        require!(
            book.market == ctx.accounts.strike_market.key(),
            BellMarketsError::OrderBookMarketMismatch
        );
        let idx = find_order_index(&book, side, seq).ok_or(BellMarketsError::OrderNotFound)?;
        let o = if side == SIDE_BID {
            &book.bids[idx]
        } else {
            &book.asks[idx]
        };
        (idx, o.owner, o.price, o.size)
    };

    // Owner check — only the order's owner can cancel.
    require!(
        order_owner == ctx.accounts.user.key(),
        BellMarketsError::NotOrderOwner
    );

    // Refund exact remaining escrow. PDA-signed transfer (strike_market PDA
    // is the escrow authority — same pattern as redeem path).
    let pyth_feed = ctx.accounts.strike_market.underlying_pyth_feed;
    let expiry_le = ctx.accounts.strike_market.expiry_unix.to_le_bytes();
    let strike_le = ctx.accounts.strike_market.strike_price.to_le_bytes();
    let sm_bump = [ctx.accounts.strike_market.bump];
    let sm_seeds: &[&[u8]] = &[
        b"strike",
        pyth_feed.as_ref(),
        expiry_le.as_ref(),
        strike_le.as_ref(),
        sm_bump.as_ref(),
    ];
    let sm_signer: &[&[&[u8]]] = &[sm_seeds];

    if side == SIDE_BID {
        let refund_usdc = bid_cost_ceil(order_price, order_remaining)?;
        if refund_usdc > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.usdc_escrow.to_account_info(),
                        to: ctx.accounts.user_usdc.to_account_info(),
                        authority: ctx.accounts.strike_market.to_account_info(),
                    },
                    sm_signer,
                ),
                refund_usdc,
            )?;
        }
    } else {
        // Ask: refund remaining YES.
        if order_remaining > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.yes_escrow.to_account_info(),
                        to: ctx.accounts.user_yes.to_account_info(),
                        authority: ctx.accounts.strike_market.to_account_info(),
                    },
                    sm_signer,
                ),
                order_remaining,
            )?;
        }
    }

    // Phase 3: remove the slot.
    let mut book = ctx.accounts.order_book.load_mut()?;
    if side == SIDE_BID {
        remove_bid(&mut book, idx)?;
    } else {
        remove_ask(&mut book, idx)?;
    }

    Ok(())
}
