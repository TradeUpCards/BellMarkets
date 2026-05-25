//! `match_orders` — DR-020 in-program CLOB permissionless crank.
//!
//! Sweeps crossed bid/ask pairs from the resting book. In normal operation
//! this is a no-op because `place_order` crosses on placement (taker-pays
//! pattern), so a correctly-operated book is never left crossed. The crank
//! exists for the architecture's **trustlessness/liveness guarantee**
//! (Keith's spec §"`match_orders` is a defensive/liveness no-op"): anyone
//! can trigger settlement of a crossed pair, and the cranker can only
//! trigger — prices/sizes come from on-chain Orders, maker payout accounts
//! are verified per H-1, fee_recipient routing is structural.
//!
//! ## Trade price = the BID's price (deliberate simplification)
//!
//! When the book is crossed (`bid.price ≥ ask.price`), trading at the bid's
//! price drains the bid escrow EXACTLY (no price-improvement surplus to
//! refund, no extra account per fill). The seller (ask maker) receives ≥
//! their ask price — they're not made worse off; they may get a bonus.
//!
//! ## Permissionless. Crank signer is the fee-payer; no escrow authority
//! needed (PDA signs from escrow accounts).
//!
//! ## Adversarial coverage (DR-020 H-1, M-1, M-2)
//!
//! - H-1/M-1: maker payout accounts in `remaining_accounts` verified via
//!   `verify_maker_account` (SPL-owned + not-frozen + owner-matches +
//!   mint-matches). Cranker cannot misdirect funds.
//! - M-2: `yes_mint` PDA-bound via stored bump (matches `place_order`).
//!
//! ## remaining_accounts shape
//!
//! For each crossed pair the cranker processes, TWO maker payout accounts
//! are needed (ask-maker USDC ATA + bid-maker YES ATA), aligned in pair
//! order (best-bid + best-ask first). So `remaining_accounts.len() == 2 *
//! num_pairs_cranked`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::BellMarketsError;
use crate::matching::{fill_usdc, remove_ask, remove_bid, verify_maker_account};
use crate::state::*;

/// Max crossed pairs swept per crank ix. Bounds CU + `remaining_accounts`.
/// 8 pairs × 2 accounts/pair × ~10K CU = ~160K CU, leaves headroom.
pub const MAX_PAIRS_PER_CRANK: usize = 8;

#[derive(Accounts)]
pub struct MatchOrders<'info> {
    /// Cranker (anyone). Pays gas. No special role.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        constraint = strike_market.outcome == Outcome::Unsettled @ BellMarketsError::AlreadySettled,
        constraint = strike_market.config == config.key() @ BellMarketsError::ConfigMismatch,
        constraint = strike_market.order_book == order_book.key() @ BellMarketsError::OrderBookNotInitialized,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// Zero-copy AccountLoader — §4.11 stack safety. Back-ref checked in handler.
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, strike_market.key().as_ref()],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    /// DR-020 M-2: PDA-seed-constrained.
    #[account(
        seeds = [b"yes", strike_market.key().as_ref()],
        bump = strike_market.yes_mint_bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

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
    // remaining_accounts: [ask_maker_usdc_0, bid_maker_yes_0,
    //                     ask_maker_usdc_1, bid_maker_yes_1, ...]
}

/// One crossed pair processed during the crank.
#[derive(Clone, Copy, Debug)]
struct CrossedPair {
    bid_index: usize,
    ask_index: usize,
    bid_owner: Pubkey,
    ask_owner: Pubkey,
    bid_size_before: u64,
    ask_size_before: u64,
    fill_size: u64,
    bid_price: u64, // trade price
    bid_size_after: u64,
    ask_size_after: u64,
    fill_usdc_amount: u64,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, MatchOrders<'info>>,
) -> Result<()> {
    // ── Phase 1: plan crossed pairs + verify back-ref ────────────────────
    let planned: Vec<CrossedPair> = {
        let book = ctx.accounts.order_book.load()?;
        require!(
            book.market == ctx.accounts.strike_market.key(),
            BellMarketsError::OrderBookMarketMismatch
        );
        let mut out: Vec<CrossedPair> = Vec::new();
        // We sweep best-bid vs best-ask repeatedly. Since `apply` runs
        // after settlement, indices in the plan are static (best-bid =
        // index 0, second-best = index 1, etc., until apply removes them).
        // For simplicity: take the SAME pair (idx 0, idx 0) repeatedly with
        // updated sizes. We track "virtual size_after" per pair as we
        // plan; phase 3 applies them in reverse-index order.
        //
        // Limit: MAX_PAIRS_PER_CRANK. For repeated fills against the same
        // resting order (when bid_size_before > ask_size_before or vice
        // versa), we coalesce into one CrossedPair with size = min.

        let mut bid_idx = 0usize;
        let mut ask_idx = 0usize;
        let mut bid_consumed: u64 = 0;
        let mut ask_consumed: u64 = 0;

        while out.len() < MAX_PAIRS_PER_CRANK
            && bid_idx < book.bids_len as usize
            && ask_idx < book.asks_len as usize
        {
            let bid = &book.bids[bid_idx];
            let ask = &book.asks[ask_idx];
            // Cross check: bid.price ≥ ask.price.
            if bid.price < ask.price {
                break; // No more crosses
            }
            let bid_remaining = bid.size.saturating_sub(bid_consumed);
            let ask_remaining = ask.size.saturating_sub(ask_consumed);
            if bid_remaining == 0 {
                bid_idx += 1;
                bid_consumed = 0;
                continue;
            }
            if ask_remaining == 0 {
                ask_idx += 1;
                ask_consumed = 0;
                continue;
            }
            let fill_size = bid_remaining.min(ask_remaining);
            let bid_size_after = bid.size - bid_consumed - fill_size;
            let ask_size_after = ask.size - ask_consumed - fill_size;
            // Trade at the BID's price (drains bid escrow cleanly).
            let usdc = match fill_usdc(bid.price, bid_remaining, bid_remaining - fill_size) {
                Ok(v) => v,
                Err(_) => break, // Defensive: overflow → stop planning
            };
            out.push(CrossedPair {
                bid_index: bid_idx,
                ask_index: ask_idx,
                bid_owner: bid.owner,
                ask_owner: ask.owner,
                bid_size_before: bid.size,
                ask_size_before: ask.size,
                fill_size,
                bid_price: bid.price,
                bid_size_after,
                ask_size_after,
                fill_usdc_amount: usdc,
            });
            bid_consumed += fill_size;
            ask_consumed += fill_size;
        }
        out
    };

    // ── Phase 2: settle (CPI transfers per pair) ─────────────────────────
    require!(
        ctx.remaining_accounts.len() >= planned.len() * 2,
        BellMarketsError::ClobRemainingAccountsMismatch
    );

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

    for (i, pair) in planned.iter().enumerate() {
        let ask_maker_usdc = &ctx.remaining_accounts[i * 2];
        let bid_maker_yes = &ctx.remaining_accounts[i * 2 + 1];
        // Verify both maker accounts per H-1.
        verify_maker_account(
            ask_maker_usdc,
            pair.ask_owner,
            ctx.accounts.usdc_mint.key(),
        )?;
        verify_maker_account(
            bid_maker_yes,
            pair.bid_owner,
            ctx.accounts.yes_mint.key(),
        )?;
        // USDC: usdc_escrow → ask_maker_usdc
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.usdc_escrow.to_account_info(),
                    to: ask_maker_usdc.clone(),
                    authority: ctx.accounts.strike_market.to_account_info(),
                },
                sm_signer,
            ),
            pair.fill_usdc_amount,
        )?;
        // YES: yes_escrow → bid_maker_yes
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.yes_escrow.to_account_info(),
                    to: bid_maker_yes.clone(),
                    authority: ctx.accounts.strike_market.to_account_info(),
                },
                sm_signer,
            ),
            pair.fill_size,
        )?;
    }

    // ── Phase 3: apply book mutations ────────────────────────────────────
    // For each planned pair we need to either decrement size (partial) or
    // remove the slot (emptied). Walk planned in reverse-index order so
    // removals don't shift earlier indices.
    //
    // Coalesce per (bid_index, ask_index) by tracking final size_after:
    // because the planner produces at most one entry per (bid, ask) pair
    // (each is exhausted before moving on), the final size_after for each
    // unique index is the LAST entry's value.
    let mut to_remove_bids: Vec<usize> = Vec::new();
    let mut to_remove_asks: Vec<usize> = Vec::new();
    let mut partial_bid_sizes: Vec<(usize, u64)> = Vec::new();
    let mut partial_ask_sizes: Vec<(usize, u64)> = Vec::new();
    for pair in &planned {
        if pair.bid_size_after == 0 {
            if !to_remove_bids.contains(&pair.bid_index) {
                to_remove_bids.push(pair.bid_index);
            }
        } else {
            partial_bid_sizes.push((pair.bid_index, pair.bid_size_after));
        }
        if pair.ask_size_after == 0 {
            if !to_remove_asks.contains(&pair.ask_index) {
                to_remove_asks.push(pair.ask_index);
            }
        } else {
            partial_ask_sizes.push((pair.ask_index, pair.ask_size_after));
        }
    }
    // Apply partials (don't change indices).
    let mut book = ctx.accounts.order_book.load_mut()?;
    for (idx, new_size) in partial_bid_sizes {
        // Use last write (each index may appear multiple times; final size_after applies).
        book.bids[idx].size = new_size;
    }
    for (idx, new_size) in partial_ask_sizes {
        book.asks[idx].size = new_size;
    }
    // Remove emptied back-to-front.
    to_remove_bids.sort_unstable_by(|a, b| b.cmp(a));
    for idx in to_remove_bids {
        remove_bid(&mut book, idx)?;
    }
    to_remove_asks.sort_unstable_by(|a, b| b.cmp(a));
    for idx in to_remove_asks {
        remove_ask(&mut book, idx)?;
    }

    Ok(())
}
