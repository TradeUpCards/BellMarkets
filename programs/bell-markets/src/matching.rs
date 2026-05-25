//! DR-020 — In-program CLOB matching primitives.
//!
//! Adapted from Keith's reference design (`docs/architecture/reference-clob-{design,decisions,spec}.md`).
//! Pure helpers + the three-phase matching pattern that keeps the matching
//! logic auditable without holding an `OrderBook` borrow across CPI calls.
//!
//! ## Public surface
//!
//! - [`bid_cost_ceil`] — ceiling-rounded USDC escrow needed for a bid
//! - [`fill_usdc`] — telescoping USDC delta for one partial fill
//! - [`insert_sorted_bid`] — keep bids price-desc then seq-asc; reject on `BookFull`
//! - [`insert_sorted_ask`] — keep asks price-asc then seq-asc; reject on `BookFull`
//! - [`find_order_index`] — locate an active resting order by (side, seq)
//! - [`verify_maker_account`] — H-1: SPL-owned + not-frozen + owner-matches + mint-matches
//! - [`PlannedFill`] — output of phase-1 planning; consumed by phase-2 CPI + phase-3 apply
//!
//! ## Why telescoping (the load-bearing trick)
//!
//! A bid escrows `ceil(price * size / PRICE_SCALE)` USDC (round UP — escrow
//! always covers the worst case). A partial fill that shrinks the resting
//! order from `s_before` to `s_after` debits exactly
//! `ceil(price * s_before / PRICE_SCALE) − ceil(price * s_after / PRICE_SCALE)`
//! USDC from escrow. Summed over any sequence of partial fills, the total
//! debit telescopes to `ceil(price * original_size / PRICE_SCALE)` — i.e., to
//! exactly the escrowed amount. So a fully-filled bid drains its escrow to
//! zero with no dust, and a cancel of a partially-filled bid refunds exactly
//! `ceil(price * remaining / PRICE_SCALE)`.
//!
//! This is Keith's invariant — preserved verbatim. It eliminates the need for
//! a per-order escrow field on `Order` (which the spec's frozen contract
//! doesn't have) and makes `cancel_order`'s refund math derivable from just
//! `price + remaining_size`.

use anchor_lang::prelude::*;
use anchor_spl::token::spl_token;

use crate::errors::BellMarketsError;
use crate::state::{Order, OrderBook, ORDERBOOK_N, PRICE_SCALE, SIDE_ASK, SIDE_BID};

// ─── Pure math ──────────────────────────────────────────────────────────────

/// USDC base units a bid for `size` YES tokens at `price` must escrow.
///
/// `ceil((price * size) / PRICE_SCALE)`. Returns `Err(MathOverflow)` if
/// `price * size` overflows u128 (impossible at our PRICE_SCALE=1e6 + i64
/// price/size ranges, but defensive — `checked_mul` is free).
///
/// Round UP so the escrow always covers the worst case. The over-escrowed
/// remainder (`ceil − floor`) is refunded on the bid's exit from the book
/// via the telescoping property of [`fill_usdc`] + the cancel path.
pub fn bid_cost_ceil(price: u64, size: u64) -> Result<u64> {
    let p = price as u128;
    let s = size as u128;
    let scale = PRICE_SCALE as u128;
    let prod = p.checked_mul(s).ok_or(BellMarketsError::MathOverflow)?;
    // ceil(prod / scale)
    let ceil = prod
        .checked_add(scale - 1)
        .ok_or(BellMarketsError::MathOverflow)?
        / scale;
    u64::try_from(ceil).map_err(|_| BellMarketsError::MathOverflow.into())
}

/// USDC base units transferred on a single partial fill that shrinks a
/// resting order from `s_before` to `s_after` (both YES sizes).
///
/// `ceil(price * s_before / SCALE) − ceil(price * s_after / SCALE)`. This is
/// the telescoping definition: summed over any sequence of partial fills
/// down to `s_after == 0`, the total equals `ceil(price * s_before_initial /
/// SCALE)` — exactly the escrow [`bid_cost_ceil`] originally took.
///
/// Both subtraction operands are u64 and `s_after ≤ s_before` (caller
/// invariant), so the result is always non-negative. `checked_sub` guards
/// against any future planning-regression that violates the invariant
/// (M-3 fix).
pub fn fill_usdc(price: u64, s_before: u64, s_after: u64) -> Result<u64> {
    let before = bid_cost_ceil(price, s_before)?;
    let after = bid_cost_ceil(price, s_after)?;
    before.checked_sub(after).ok_or(BellMarketsError::MathOverflow.into())
}

// ─── Sorted insert ──────────────────────────────────────────────────────────

/// Insert `order` into `book.bids` keeping the invariant:
/// **price-descending, then seq-ascending** (so `bids[0]` is the best bid).
///
/// Returns `BookFull` if `book.bids_len == ORDERBOOK_N`. On success bumps
/// `bids_len` by 1 and bumps `next_seq` by 1 if the caller hadn't already
/// (callers should set `order.seq = book.next_seq` before calling and the
/// caller is responsible for the bump — this helper only shifts elements).
///
/// Linear shift on insert (O(N)). At N=128 this is trivial in BPF.
pub fn insert_sorted_bid(book: &mut OrderBook, order: Order) -> Result<()> {
    require!(
        (book.bids_len as usize) < ORDERBOOK_N,
        BellMarketsError::BookFull
    );
    let len = book.bids_len as usize;
    // Find insertion point: first index where existing.price < order.price OR
    // (existing.price == order.price AND existing.seq > order.seq).
    let mut idx = len;
    for i in 0..len {
        let existing = &book.bids[i];
        if existing.price < order.price
            || (existing.price == order.price && existing.seq > order.seq)
        {
            idx = i;
            break;
        }
    }
    // Shift down [idx..len] by 1, insert at idx.
    if idx < len {
        for i in (idx..len).rev() {
            book.bids[i + 1] = book.bids[i];
        }
    }
    book.bids[idx] = order;
    book.bids_len = book.bids_len.checked_add(1).ok_or(BellMarketsError::MathOverflow)?;
    Ok(())
}

/// Insert `order` into `book.asks` keeping the invariant:
/// **price-ascending, then seq-ascending** (so `asks[0]` is the best ask).
pub fn insert_sorted_ask(book: &mut OrderBook, order: Order) -> Result<()> {
    require!(
        (book.asks_len as usize) < ORDERBOOK_N,
        BellMarketsError::BookFull
    );
    let len = book.asks_len as usize;
    let mut idx = len;
    for i in 0..len {
        let existing = &book.asks[i];
        if existing.price > order.price
            || (existing.price == order.price && existing.seq > order.seq)
        {
            idx = i;
            break;
        }
    }
    if idx < len {
        for i in (idx..len).rev() {
            book.asks[i + 1] = book.asks[i];
        }
    }
    book.asks[idx] = order;
    book.asks_len = book.asks_len.checked_add(1).ok_or(BellMarketsError::MathOverflow)?;
    Ok(())
}

/// Remove the order at `idx` from `book.bids` by shifting elements
/// `[idx+1..len]` down by 1. Decrements `bids_len`. No-op + error if `idx`
/// out of range.
pub fn remove_bid(book: &mut OrderBook, idx: usize) -> Result<()> {
    let len = book.bids_len as usize;
    require!(idx < len, BellMarketsError::OrderNotFound);
    for i in idx..len.saturating_sub(1) {
        book.bids[i] = book.bids[i + 1];
    }
    // Zero the now-unused slot at the new tail (defensive — bids_len gates
    // reads so this isn't strictly required, but cleaner for debugging).
    book.bids[len - 1] = Order::default();
    book.bids_len = book.bids_len.checked_sub(1).ok_or(BellMarketsError::MathOverflow)?;
    Ok(())
}

/// Symmetric removal for asks.
pub fn remove_ask(book: &mut OrderBook, idx: usize) -> Result<()> {
    let len = book.asks_len as usize;
    require!(idx < len, BellMarketsError::OrderNotFound);
    for i in idx..len.saturating_sub(1) {
        book.asks[i] = book.asks[i + 1];
    }
    book.asks[len - 1] = Order::default();
    book.asks_len = book.asks_len.checked_sub(1).ok_or(BellMarketsError::MathOverflow)?;
    Ok(())
}

/// Locate an active resting order by `(side, seq)`. Returns the array index
/// or `None`.
pub fn find_order_index(book: &OrderBook, side: u8, seq: u64) -> Option<usize> {
    match side {
        SIDE_BID => {
            let len = book.bids_len as usize;
            book.bids[..len].iter().position(|o| o.seq == seq)
        }
        SIDE_ASK => {
            let len = book.asks_len as usize;
            book.asks[..len].iter().position(|o| o.seq == seq)
        }
        _ => None,
    }
}

// ─── Maker-account verification (DR-020 H-1 + M-1) ──────────────────────────

/// DR-020 H-1: verify a maker payout account passed via `remaining_accounts`
/// is safe to transfer to. Without this check, a malicious maker could
/// corrupt their own payout account so every fill through their resting
/// order reverts — permanently locking that price level (book-lock DoS).
///
/// Checks:
///   1. Account is owned by the SPL Token program (else `try_deserialize`
///      could be spoofed by raw-byte construction).
///   2. Account is writable.
///   3. Token account state == `Initialized` (rejects frozen accounts —
///      DR-020 M-1, fold-in fix; a frozen maker account would also cause
///      the transfer CPI to revert, blocking matching).
///   4. Token account owner pubkey == `expected_owner` (the on-chain
///      `Order.owner` — caller cannot misdirect to a third party).
///   5. Token account mint == `expected_mint` (USDC when paying an ask
///      maker; YES when paying a bid maker — caller cannot route the wrong
///      asset).
pub fn verify_maker_account(
    account_info: &AccountInfo,
    expected_owner: Pubkey,
    expected_mint: Pubkey,
) -> Result<()> {
    require!(
        account_info.owner == &spl_token::ID,
        BellMarketsError::ClobMakerNotSplOwned
    );
    // Audit-NIT fix (Sonnet defense-in-depth audit on `acf2602`): use the
    // semantically-correct ClobMakerNotWritable error variant here. Previously
    // emitted ClobMakerNotSplOwned for both checks, which misdiagnosed the
    // failure on client-side. No security impact (both fire fail-closed).
    require!(
        account_info.is_writable,
        BellMarketsError::ClobMakerNotWritable
    );
    let data = account_info.try_borrow_data()?;
    // SPL TokenAccount layout: mint(32) owner(32) amount(8) delegate(36)
    // state(1) is_native(12) delegated_amount(8) close_authority(36) = 165
    require!(
        data.len() >= 165,
        BellMarketsError::ClobMakerNotSplOwned
    );
    let mint_bytes: [u8; 32] = data[0..32].try_into().unwrap();
    let owner_bytes: [u8; 32] = data[32..64].try_into().unwrap();
    let state = data[108];
    require!(state == 1, BellMarketsError::ClobMakerFrozen); // 1 = Initialized
    require!(
        Pubkey::new_from_array(owner_bytes) == expected_owner,
        BellMarketsError::ClobMakerOwnerMismatch
    );
    require!(
        Pubkey::new_from_array(mint_bytes) == expected_mint,
        BellMarketsError::ClobMakerMintMismatch
    );
    Ok(())
}

// ─── Three-phase matching primitive ─────────────────────────────────────────

/// One planned fill produced by phase-1 (planning) consumed by phase-2 (CPI)
/// + phase-3 (apply). Captures everything the later phases need without
/// re-traversing the book.
///
/// `maker_index` is the position in the appropriate side array AT PLAN TIME.
/// Phase-3 removes filled-to-zero entries back-to-front (high index first)
/// so earlier indices remain valid during the apply walk.
#[derive(Clone, Copy, Debug)]
pub struct PlannedFill {
    /// Index into `book.bids` (if incoming is ask) or `book.asks` (if incoming
    /// is bid) at the moment of planning.
    pub maker_index: usize,
    /// YES size filled at the maker's price.
    pub fill_size: u64,
    /// USDC base units to transfer on this fill (telescoping for the maker
    /// side; for a bid-incoming-vs-ask-maker, this is the size × maker_price
    /// rounded toward the maker's escrow).
    pub fill_usdc: u64,
    /// Pubkey owner of the maker order — used by phase-2 to verify the
    /// `remaining_accounts` entry isn't a substitution.
    pub maker_owner: Pubkey,
    /// Maker's resting size at moment of planning.
    pub maker_size_before: u64,
    /// Maker's resting size after this fill (for telescoping continuity).
    pub maker_size_after: u64,
    /// Maker's resting price (= trade price; price-time priority means trade
    /// happens at the maker's price, not the taker's).
    pub maker_price: u64,
}

/// Phase-1 planning. Read-only walk over the opposite-side book from index 0
/// (best price). Builds `PlannedFill`s until either the incoming order is
/// exhausted or no more crossing makers exist.
///
/// Cross definition:
///   - Incoming bid at `price` crosses an ask if `ask.price ≤ price`.
///   - Incoming ask at `price` crosses a bid if `bid.price ≥ price`.
///   - Market orders cross any maker (modeled as bid at `u64::MAX` or ask
///     at `0` by the caller passing `is_market = true` + appropriate price
///     bound; this fn just uses the price comparison).
///
/// `max_fills` bounds the number of fills planned (CU + remaining_accounts
/// budget). After hitting `max_fills`, planning stops even if more crossing
/// makers exist (taker's remainder rests or is dropped per market/limit).
///
/// Returns `(planned_fills, taker_size_remaining)`. Caller decides whether
/// the remainder rests (limit) or drops (market).
pub fn plan_fills(
    book: &OrderBook,
    incoming_side: u8,
    incoming_price: u64,
    incoming_size: u64,
    is_market: bool,
    max_fills: usize,
) -> Vec<PlannedFill> {
    let mut planned: Vec<PlannedFill> = Vec::with_capacity(max_fills);
    let mut remaining = incoming_size;
    let opp_side_is_asks = incoming_side == SIDE_BID;

    let opp_len = if opp_side_is_asks {
        book.asks_len as usize
    } else {
        book.bids_len as usize
    };

    for i in 0..opp_len {
        if remaining == 0 || planned.len() >= max_fills {
            break;
        }
        let maker = if opp_side_is_asks {
            &book.asks[i]
        } else {
            &book.bids[i]
        };
        // Cross check
        let crosses = if is_market {
            true
        } else if opp_side_is_asks {
            // Incoming bid crosses ask if ask.price <= bid.price
            maker.price <= incoming_price
        } else {
            // Incoming ask crosses bid if bid.price >= ask.price
            maker.price >= incoming_price
        };
        if !crosses {
            break; // Sorted book: once no-cross, no further crosses possible
        }
        let fill_size = remaining.min(maker.size);
        let size_after = maker.size - fill_size;
        // USDC for this fill at the maker's price.
        let usdc = match fill_usdc(maker.price, maker.size, size_after) {
            Ok(v) => v,
            Err(_) => break, // Defensive: overflow → don't plan; planner is read-only
        };
        planned.push(PlannedFill {
            maker_index: i,
            fill_size,
            fill_usdc: usdc,
            maker_owner: maker.owner,
            maker_size_before: maker.size,
            maker_size_after: size_after,
            maker_price: maker.price,
        });
        remaining -= fill_size;
    }
    planned
}

/// Phase-3 apply. Mutates `book` in place: decrements partial-fill maker
/// sizes; removes emptied makers BACK-TO-FRONT (high index first) so earlier
/// indices remain valid.
///
/// `incoming_side` is the side of the INCOMING order; the makers being
/// mutated are on the OPPOSITE side.
pub fn apply_fills(
    book: &mut OrderBook,
    incoming_side: u8,
    planned: &[PlannedFill],
) -> Result<()> {
    let opp_side_is_asks = incoming_side == SIDE_BID;
    // Sort planned indices descending so we remove from tail-ward first.
    let mut to_remove: Vec<usize> = Vec::with_capacity(planned.len());
    for fill in planned {
        if fill.maker_size_after == 0 {
            to_remove.push(fill.maker_index);
        } else {
            // Partial fill — decrement size in place.
            if opp_side_is_asks {
                book.asks[fill.maker_index].size = book.asks[fill.maker_index]
                    .size
                    .checked_sub(fill.fill_size)
                    .ok_or(BellMarketsError::MathOverflow)?;
            } else {
                book.bids[fill.maker_index].size = book.bids[fill.maker_index]
                    .size
                    .checked_sub(fill.fill_size)
                    .ok_or(BellMarketsError::MathOverflow)?;
            }
        }
    }
    // Sort descending + remove.
    to_remove.sort_unstable_by(|a, b| b.cmp(a));
    for idx in to_remove {
        if opp_side_is_asks {
            remove_ask(book, idx)?;
        } else {
            remove_bid(book, idx)?;
        }
    }
    Ok(())
}

// ─── Unit tests (pure helpers only — CPI paths are integration tests) ───────

#[cfg(test)]
mod tests {
    use super::*;

    // ── bid_cost_ceil ──────────────────────────────────────────────────────

    // Sizes are in YES base units (6-decimal SPL token convention matches
    // USDC). 1 "macro" YES = 1_000_000 base units. So "4 YES" = 4 * 10^6.

    #[test]
    fn bid_cost_ceil_exact_division() {
        // price = 0.5 (= 500_000), size = 4 YES (= 4_000_000 base units)
        // cost = ceil(500_000 * 4_000_000 / 1_000_000) = 2_000_000 = $2 USDC
        assert_eq!(bid_cost_ceil(500_000, 4_000_000).unwrap(), 2_000_000);
        // Smallest tick: 1 YES base unit at $1 = 1 USDC base unit
        assert_eq!(bid_cost_ceil(PRICE_SCALE, 1).unwrap(), 1);
    }

    #[test]
    fn bid_cost_ceil_rounds_up_on_remainder() {
        // price = $0.33 (= 330_000), size = 1 base-unit YES.
        // 330_000 * 1 / 1_000_000 = 0.33 → ceil = 1 USDC base unit
        assert_eq!(bid_cost_ceil(330_000, 1).unwrap(), 1);
        // Smallest non-zero round-up: price = 1, size = 1
        // 1 * 1 / 1_000_000 = 0.000001 → ceil = 1
        assert_eq!(bid_cost_ceil(1, 1).unwrap(), 1);
        // price = 1, size = PRICE_SCALE → 1_000_000 / 1_000_000 = exact 1
        assert_eq!(bid_cost_ceil(1, PRICE_SCALE).unwrap(), 1);
        // Mid-trade: price=0.333_333, size=3 YES (= 3_000_000 base) →
        // 333_333 * 3_000_000 / 1_000_000 = 999_999 → ceil = 999_999 (exact)
        assert_eq!(bid_cost_ceil(333_333, 3_000_000).unwrap(), 999_999);
        // Same but +1 size base unit → 333_333 * 3_000_001 / 1_000_000 = 999_999.333 → ceil = 1_000_000
        assert_eq!(bid_cost_ceil(333_333, 3_000_001).unwrap(), 1_000_000);
    }

    #[test]
    fn bid_cost_ceil_zero_size_returns_zero() {
        assert_eq!(bid_cost_ceil(500_000, 0).unwrap(), 0);
    }

    // ── fill_usdc telescoping ──────────────────────────────────────────────

    /// LOAD-BEARING PROPERTY: a series of partial fills telescopes to exactly
    /// the original escrow. This is the invariant that lets us avoid an
    /// escrow field on `Order` AND lets `cancel_order` refund exactly
    /// `ceil(price * remaining)` without bookkeeping.
    #[test]
    fn fill_usdc_telescopes_to_initial_escrow() {
        let price = 333_333; // odd price to exercise rounding
        let initial_size = 7u64;
        let escrow_initial = bid_cost_ceil(price, initial_size).unwrap();
        // Walk size 7 → 5 → 2 → 0 in three fills.
        let f1 = fill_usdc(price, 7, 5).unwrap();
        let f2 = fill_usdc(price, 5, 2).unwrap();
        let f3 = fill_usdc(price, 2, 0).unwrap();
        assert_eq!(f1 + f2 + f3, escrow_initial,
            "telescoping must sum to initial escrow exactly (no dust)");
    }

    #[test]
    fn fill_usdc_property_telescopes_over_sweep() {
        // Property: for any sequence of size decreases, sum of fill_usdc
        // equals bid_cost_ceil(price, initial).
        for price in [1u64, 100, 333_333, 500_000, 999_999, PRICE_SCALE].iter().copied() {
            for initial in [1u64, 5, 100, 1_000].iter().copied() {
                let escrow = bid_cost_ceil(price, initial).unwrap();
                // Single fill consuming everything
                assert_eq!(fill_usdc(price, initial, 0).unwrap(), escrow);
                // Two-step fill
                if initial >= 2 {
                    let mid = initial / 2;
                    let f1 = fill_usdc(price, initial, mid).unwrap();
                    let f2 = fill_usdc(price, mid, 0).unwrap();
                    assert_eq!(f1 + f2, escrow,
                        "telescoping fails at price={price} initial={initial} mid={mid}");
                }
            }
        }
    }

    // ── insert_sorted_bid (price-desc, seq-asc) ────────────────────────────

    fn empty_book() -> OrderBook {
        OrderBook {
            market: Pubkey::default(),
            next_seq: 0,
            bids: core::array::from_fn(|_| Order::default()),
            asks: core::array::from_fn(|_| Order::default()),
            bids_len: 0,
            asks_len: 0,
            bump: 0,
            _reserved: [0u8; 11],
        }
    }

    fn mk_order(owner_seed: u8, price: u64, size: u64, seq: u64, side: u8) -> Order {
        let mut owner_bytes = [0u8; 32];
        owner_bytes[0] = owner_seed;
        Order {
            owner: Pubkey::new_from_array(owner_bytes),
            price,
            size,
            seq,
            side,
            _pad: [0u8; 7],
        }
    }

    #[test]
    fn insert_bid_keeps_price_desc_seq_asc() {
        let mut book = empty_book();
        // Insert in scrambled order; expect price-desc then seq-asc.
        insert_sorted_bid(&mut book, mk_order(1, 400_000, 10, 1, SIDE_BID)).unwrap();
        insert_sorted_bid(&mut book, mk_order(2, 500_000, 10, 2, SIDE_BID)).unwrap();
        insert_sorted_bid(&mut book, mk_order(3, 500_000, 10, 3, SIDE_BID)).unwrap(); // tie at 0.5, later seq
        insert_sorted_bid(&mut book, mk_order(4, 300_000, 10, 4, SIDE_BID)).unwrap();
        insert_sorted_bid(&mut book, mk_order(5, 500_000, 10, 5, SIDE_BID)).unwrap(); // tie at 0.5, latest seq

        assert_eq!(book.bids_len, 5);
        // Expected order:
        //   [0] price=500_000 seq=2 (best price, earliest seq)
        //   [1] price=500_000 seq=3
        //   [2] price=500_000 seq=5
        //   [3] price=400_000 seq=1
        //   [4] price=300_000 seq=4
        assert_eq!((book.bids[0].price, book.bids[0].seq), (500_000, 2));
        assert_eq!((book.bids[1].price, book.bids[1].seq), (500_000, 3));
        assert_eq!((book.bids[2].price, book.bids[2].seq), (500_000, 5));
        assert_eq!((book.bids[3].price, book.bids[3].seq), (400_000, 1));
        assert_eq!((book.bids[4].price, book.bids[4].seq), (300_000, 4));
    }

    #[test]
    fn insert_ask_keeps_price_asc_seq_asc() {
        let mut book = empty_book();
        insert_sorted_ask(&mut book, mk_order(1, 600_000, 10, 1, SIDE_ASK)).unwrap();
        insert_sorted_ask(&mut book, mk_order(2, 500_000, 10, 2, SIDE_ASK)).unwrap();
        insert_sorted_ask(&mut book, mk_order(3, 500_000, 10, 3, SIDE_ASK)).unwrap();
        insert_sorted_ask(&mut book, mk_order(4, 700_000, 10, 4, SIDE_ASK)).unwrap();

        assert_eq!(book.asks_len, 4);
        // Expected: [500_000/2, 500_000/3, 600_000/1, 700_000/4]
        assert_eq!((book.asks[0].price, book.asks[0].seq), (500_000, 2));
        assert_eq!((book.asks[1].price, book.asks[1].seq), (500_000, 3));
        assert_eq!((book.asks[2].price, book.asks[2].seq), (600_000, 1));
        assert_eq!((book.asks[3].price, book.asks[3].seq), (700_000, 4));
    }

    #[test]
    fn insert_bid_rejects_when_book_full() {
        let mut book = empty_book();
        for i in 0..(ORDERBOOK_N as u64) {
            insert_sorted_bid(&mut book, mk_order(0, 500_000, 1, i, SIDE_BID)).unwrap();
        }
        assert_eq!(book.bids_len as usize, ORDERBOOK_N);
        // 129th insert must reject with BookFull.
        let res = insert_sorted_bid(&mut book, mk_order(0, 600_000, 1, 999, SIDE_BID));
        assert!(res.is_err(), "129th bid must be rejected with BookFull");
    }

    // ── remove + find ──────────────────────────────────────────────────────

    #[test]
    fn remove_bid_shifts_correctly() {
        let mut book = empty_book();
        insert_sorted_bid(&mut book, mk_order(1, 500_000, 10, 1, SIDE_BID)).unwrap();
        insert_sorted_bid(&mut book, mk_order(2, 400_000, 10, 2, SIDE_BID)).unwrap();
        insert_sorted_bid(&mut book, mk_order(3, 300_000, 10, 3, SIDE_BID)).unwrap();
        // Book: [500/1, 400/2, 300/3]
        remove_bid(&mut book, 1).unwrap(); // remove the 400/2
        assert_eq!(book.bids_len, 2);
        assert_eq!((book.bids[0].price, book.bids[0].seq), (500_000, 1));
        assert_eq!((book.bids[1].price, book.bids[1].seq), (300_000, 3));
        // The tail slot should be zeroed (sanity, not strictly required).
        assert_eq!(book.bids[2].price, 0);
    }

    #[test]
    fn find_order_index_locates_by_seq() {
        let mut book = empty_book();
        insert_sorted_bid(&mut book, mk_order(1, 500_000, 10, 42, SIDE_BID)).unwrap();
        insert_sorted_bid(&mut book, mk_order(2, 400_000, 10, 7, SIDE_BID)).unwrap();
        assert_eq!(find_order_index(&book, SIDE_BID, 42), Some(0));
        assert_eq!(find_order_index(&book, SIDE_BID, 7), Some(1));
        assert_eq!(find_order_index(&book, SIDE_BID, 99), None);
        assert_eq!(find_order_index(&book, SIDE_ASK, 42), None);
    }

    // ── plan_fills ─────────────────────────────────────────────────────────

    #[test]
    fn plan_fills_taker_bid_crosses_one_ask() {
        let mut book = empty_book();
        // Asks at 0.5/10 YES (= 10_000_000 base), 0.6/10 YES
        insert_sorted_ask(&mut book, mk_order(1, 500_000, 10_000_000, 1, SIDE_ASK)).unwrap();
        insert_sorted_ask(&mut book, mk_order(2, 600_000, 10_000_000, 2, SIDE_ASK)).unwrap();
        // Taker bid at 0.55 size 5 YES (= 5_000_000 base) — crosses 0.5 but not 0.6
        let planned = plan_fills(&book, SIDE_BID, 550_000, 5_000_000, false, 10);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].maker_index, 0);
        assert_eq!(planned[0].fill_size, 5_000_000);
        assert_eq!(planned[0].maker_price, 500_000);
        // fill_usdc: 5 YES at 0.5 = $2.5 = 2_500_000 USDC base
        assert_eq!(planned[0].fill_usdc, 2_500_000);
    }

    #[test]
    fn plan_fills_market_consumes_multiple_levels() {
        let mut book = empty_book();
        // Three asks: 0.5/10, 0.6/10, 0.7/10
        insert_sorted_ask(&mut book, mk_order(1, 500_000, 10, 1, SIDE_ASK)).unwrap();
        insert_sorted_ask(&mut book, mk_order(2, 600_000, 10, 2, SIDE_ASK)).unwrap();
        insert_sorted_ask(&mut book, mk_order(3, 700_000, 10, 3, SIDE_ASK)).unwrap();
        // Market buy size 25 → consumes all of 0.5 + all of 0.6 + 5 of 0.7
        let planned = plan_fills(&book, SIDE_BID, 0, 25, true, 10);
        assert_eq!(planned.len(), 3);
        assert_eq!(planned[0].fill_size, 10);
        assert_eq!(planned[0].maker_size_after, 0);
        assert_eq!(planned[1].fill_size, 10);
        assert_eq!(planned[1].maker_size_after, 0);
        assert_eq!(planned[2].fill_size, 5);
        assert_eq!(planned[2].maker_size_after, 5);
    }

    #[test]
    fn plan_fills_stops_at_max_fills() {
        let mut book = empty_book();
        for i in 0..5 {
            insert_sorted_ask(&mut book, mk_order(0, 500_000 + i, 10, i, SIDE_ASK)).unwrap();
        }
        // Market buy of 100 with max_fills=2 → only 2 fills
        let planned = plan_fills(&book, SIDE_BID, 0, 100, true, 2);
        assert_eq!(planned.len(), 2);
    }

    #[test]
    fn plan_fills_no_cross_returns_empty() {
        let mut book = empty_book();
        insert_sorted_ask(&mut book, mk_order(0, 600_000, 10, 0, SIDE_ASK)).unwrap();
        // Bid at 0.5 doesn't cross 0.6 ask
        let planned = plan_fills(&book, SIDE_BID, 500_000, 10, false, 10);
        assert!(planned.is_empty());
    }

    // ── apply_fills ────────────────────────────────────────────────────────

    #[test]
    fn apply_fills_removes_emptied_back_to_front() {
        let mut book = empty_book();
        // 4 asks
        for i in 0..4 {
            insert_sorted_ask(&mut book, mk_order(0, 500_000 + i, 10, i, SIDE_ASK)).unwrap();
        }
        // Plan fills emptying indices 0 + 2 (non-contiguous)
        let planned = vec![
            PlannedFill {
                maker_index: 0,
                fill_size: 10,
                fill_usdc: 5_000_000,
                maker_owner: Pubkey::default(),
                maker_size_before: 10,
                maker_size_after: 0,
                maker_price: 500_000,
            },
            PlannedFill {
                maker_index: 2,
                fill_size: 10,
                fill_usdc: 5_000_020,
                maker_owner: Pubkey::default(),
                maker_size_before: 10,
                maker_size_after: 0,
                maker_price: 500_002,
            },
        ];
        apply_fills(&mut book, SIDE_BID, &planned).unwrap();
        // After removal: indices [original 1, original 3] survive
        assert_eq!(book.asks_len, 2);
        assert_eq!(book.asks[0].price, 500_001);
        assert_eq!(book.asks[1].price, 500_003);
    }

    #[test]
    fn apply_fills_partial_decrements_size() {
        let mut book = empty_book();
        insert_sorted_ask(&mut book, mk_order(0, 500_000, 10, 0, SIDE_ASK)).unwrap();
        let planned = vec![PlannedFill {
            maker_index: 0,
            fill_size: 3,
            fill_usdc: 1_500_000,
            maker_owner: Pubkey::default(),
            maker_size_before: 10,
            maker_size_after: 7,
            maker_price: 500_000,
        }];
        apply_fills(&mut book, SIDE_BID, &planned).unwrap();
        assert_eq!(book.asks_len, 1);
        assert_eq!(book.asks[0].size, 7);
    }
}
