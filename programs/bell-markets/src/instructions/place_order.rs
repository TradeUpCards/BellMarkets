//! `place_order` — DR-020 in-program CLOB taker-crosses-on-placement.
//!
//! Per Keith's spec §"Taker crosses on placement": an incoming limit order
//! immediately matches against the opposite side's resting book; the
//! remainder (if limit + not market) rests at the supplied price. A market
//! order fills what the book allows and drops the remainder (refunding any
//! over-escrowed amount).
//!
//! ## Three-phase matching (Keith's spec §"Three-phase matching (borrow-safe)")
//!
//! 1. **Plan** (read-only walk over the opposite-side book; build
//!    `PlannedFill`s; collect maker_owner + price + size). Drops borrow.
//! 2. **Settle** (CPI transfers per fill; verify each `remaining_accounts`
//!    entry against the on-chain `Order.owner` + correct mint). The main
//!    audit hotspot.
//! 3. **Apply** (mutate book: decrement partial-fill maker sizes; remove
//!    emptied makers back-to-front so indices stay valid).
//!
//! ## Escrow handling
//!
//! - Bid: caller deposits `bid_cost_ceil(price, size)` USDC into `usdc_escrow`
//!   upfront. Filled portions immediately route to the corresponding ask
//!   maker's USDC ATA; the remainder either stays in escrow (rests) or
//!   refunds back to caller (market/cancel).
//! - Ask: caller deposits `size` YES into `yes_escrow` upfront. Same pattern.
//!
//! ## Adversarial fixes baked in
//! - M-4: limit price must be in `[1, PRICE_SCALE]` (zero-price rejected to
//!   prevent free-YES griefing via 0-cost slots).
//! - H-1: every maker payout account verified via
//!   `matching::verify_maker_account` (SPL-owned + not-frozen + correct
//!   owner + correct mint).
//! - M-1: folded into H-1 (frozen account rejected).
//! - M-3: `checked_sub` in matching::apply_fills (size decrement).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::BellMarketsError;
use crate::matching::{
    apply_fills, bid_cost_ceil, insert_sorted_ask, insert_sorted_bid, plan_fills,
    verify_maker_account, PlannedFill,
};
use crate::state::*;

/// Max fills per `place_order` ix — bounds CU + `remaining_accounts` size.
/// 16 fills × ~10K CU/fill ≈ 160K CU, leaves headroom under the 200K CU cap.
pub const MAX_FILLS_PER_PLACE_ORDER: usize = 16;

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
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
        // Trading rejected on settled markets.
        constraint = strike_market.outcome == Outcome::Unsettled @ BellMarketsError::AlreadySettled,
        constraint = strike_market.config == config.key() @ BellMarketsError::ConfigMismatch,
        // DR-020 trading gate: order_book must be wired (grow_order_book ran).
        constraint = strike_market.order_book == order_book.key() @ BellMarketsError::OrderBookNotInitialized,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// Zero-copy AccountLoader — required for §4.11 stack safety. The
    /// ~16 KB OrderBook is mapped, not deserialized onto the BPF stack.
    /// `order_book.market` back-ref is verified in the handler (constraints
    /// can't directly read zero_copy fields without `.load()`).
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

    /// Caller's YES ATA. Used as the SOURCE for ask escrow (sell YES) AND
    /// the DESTINATION for bid fills (buy YES received from ask makers).
    /// Always required even for pure-rest bid (a crossing bid receives YES).
    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// Caller's USDC ATA. SOURCE for bid escrow; DESTINATION for ask fills.
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
    // remaining_accounts: maker payout token accounts, aligned in fill order.
    //   - If side == SIDE_BID (taker buys YES): one USDC ATA per ask maker
    //     filled (Phase-2 sends USDC from usdc_escrow → maker's USDC ATA).
    //   - If side == SIDE_ASK (taker sells YES): one YES ATA per bid maker
    //     filled (Phase-2 sends YES from yes_escrow → maker's YES ATA).
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, PlaceOrder<'info>>,
    side: u8,
    price: u64,
    size: u64,
    is_market: bool,
) -> Result<()> {
    // ── Validation ───────────────────────────────────────────────────────
    require!(
        side == SIDE_BID || side == SIDE_ASK,
        BellMarketsError::InvalidSide
    );
    require!(size > 0, BellMarketsError::ZeroOrderSize);
    if !is_market {
        // M-4: limit price must be in [1, PRICE_SCALE]. Zero-price would
        // escrow nothing yet acquire YES for free / squat a slot.
        require!(
            price >= 1 && price <= PRICE_SCALE,
            BellMarketsError::PriceOutOfRange
        );
    }

    // ── Phase 1: plan fills + verify order_book back-ref ─────────────────
    let planned: Vec<PlannedFill> = {
        let book = ctx.accounts.order_book.load()?;
        // Verify back-ref (replaces the constraint we can't put on the
        // zero_copy account macro).
        require!(
            book.market == ctx.accounts.strike_market.key(),
            BellMarketsError::OrderBookMarketMismatch
        );
        plan_fills(&book, side, price, size, is_market, MAX_FILLS_PER_PLACE_ORDER)
    };

    // ── Escrow deposit (incoming taker side) ─────────────────────────────
    //
    // Deposit upfront escrow that COVERS the worst case + rounding pad.
    // Refund the actual excess on exit. Padding rationale:
    //   - When an incoming bid fills MULTIPLE ask makers at DIFFERENT
    //     prices, summing per-fill telescoped USDC payments at MAKER prices
    //     can exceed the bid's own bid_cost_ceil(BID_PRICE, total_filled) by
    //     up to 1 base unit per fill (rounding bias). Max ~MAX_FILLS units.
    //   - For market orders the `price` arg isn't meaningful, so we escrow
    //     the absolute worst case = size USDC base units (= price=PRICE_SCALE,
    //     i.e., $1.00 per YES — the max possible price). Refund actual.
    let escrow_in_usdc = if side == SIDE_BID {
        let base = if is_market {
            // Worst case: every YES bought at $1.00 = size USDC base units.
            size
        } else {
            bid_cost_ceil(price, size)?
        };
        base.checked_add(MAX_FILLS_PER_PLACE_ORDER as u64)
            .ok_or(BellMarketsError::MathOverflow)?
    } else {
        0
    };
    let escrow_in_yes = if side == SIDE_ASK { size } else { 0 };

    if side == SIDE_BID && escrow_in_usdc > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.usdc_escrow.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            escrow_in_usdc,
        )?;
    }
    if side == SIDE_ASK {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_yes.to_account_info(),
                    to: ctx.accounts.yes_escrow.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            size,
        )?;
    }

    // ── Phase 2: settle fills (CPI per fill) ────────────────────────────
    //
    // remaining_accounts shape: one maker payout token account per planned
    // fill, in fill order (best-price/time first).
    require!(
        ctx.remaining_accounts.len() >= planned.len(),
        BellMarketsError::ClobRemainingAccountsMismatch
    );

    let mut total_filled_size: u64 = 0;
    let mut total_filled_usdc: u64 = 0;

    // Precompute strike_market signer seeds (used for all escrow PDA-signed
    // outgoing transfers).
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

    for (i, fill) in planned.iter().enumerate() {
        let maker_payout = &ctx.remaining_accounts[i];
        if side == SIDE_BID {
            // Taker buys YES: pay maker (ask) USDC from usdc_escrow.
            // Maker receives USDC; expected_mint = config.usdc_mint.
            verify_maker_account(
                maker_payout,
                fill.maker_owner,
                ctx.accounts.usdc_mint.key(),
            )?;
            // Transfer USDC: usdc_escrow → maker_payout (USDC ATA), PDA-signed.
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.usdc_escrow.to_account_info(),
                        to: maker_payout.clone(),
                        authority: ctx.accounts.strike_market.to_account_info(),
                    },
                    sm_signer,
                ),
                fill.fill_usdc,
            )?;
            // Transfer YES: yes_escrow → user_yes (taker receives YES), PDA-signed.
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
                fill.fill_size,
            )?;
        } else {
            // Taker sells YES: pay maker (bid) YES from yes_escrow.
            verify_maker_account(
                maker_payout,
                fill.maker_owner,
                ctx.accounts.yes_mint.key(),
            )?;
            // Transfer YES: yes_escrow → maker_payout (YES ATA), PDA-signed.
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.yes_escrow.to_account_info(),
                        to: maker_payout.clone(),
                        authority: ctx.accounts.strike_market.to_account_info(),
                    },
                    sm_signer,
                ),
                fill.fill_size,
            )?;
            // Transfer USDC: usdc_escrow → user_usdc (taker receives USDC), PDA-signed.
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
                fill.fill_usdc,
            )?;
        }
        total_filled_size = total_filled_size
            .checked_add(fill.fill_size)
            .ok_or(BellMarketsError::MathOverflow)?;
        total_filled_usdc = total_filled_usdc
            .checked_add(fill.fill_usdc)
            .ok_or(BellMarketsError::MathOverflow)?;
    }

    // ── Phase 3: apply book mutations ────────────────────────────────────
    {
        let mut book = ctx.accounts.order_book.load_mut()?;
        apply_fills(&mut book, side, &planned)?;
    }

    // ── Remainder handling ───────────────────────────────────────────────
    let remaining_size = size
        .checked_sub(total_filled_size)
        .ok_or(BellMarketsError::MathOverflow)?;

    if remaining_size == 0 {
        // Fully filled. Refund over-escrow on the bid side: we deposited
        // `bid_cost_ceil(price, size)` but only `total_filled_usdc` actually
        // routed to makers. The difference (rounding remainder) is refunded.
        if side == SIDE_BID {
            let refund = escrow_in_usdc
                .checked_sub(total_filled_usdc)
                .ok_or(BellMarketsError::MathOverflow)?;
            if refund > 0 {
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
                    refund,
                )?;
            }
        }
        return Ok(());
    }

    // remaining_size > 0 — either rest (limit) or drop+refund (market).
    if is_market {
        // Market remainder = fill-or-cancel: refund unused escrow to caller.
        if side == SIDE_BID {
            let refund = escrow_in_usdc
                .checked_sub(total_filled_usdc)
                .ok_or(BellMarketsError::MathOverflow)?;
            if refund > 0 {
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
                    refund,
                )?;
            }
        } else {
            // Ask side: refund unused YES.
            let unfilled = escrow_in_yes
                .checked_sub(total_filled_size)
                .ok_or(BellMarketsError::MathOverflow)?;
            if unfilled > 0 {
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
                    unfilled,
                )?;
            }
        }
        return Ok(());
    }

    // Limit remainder — rest at the supplied price.
    let mut book = ctx.accounts.order_book.load_mut()?;
    let seq = book.next_seq;
    book.next_seq = book.next_seq.checked_add(1).ok_or(BellMarketsError::MathOverflow)?;
    let rest_order = Order {
        owner: ctx.accounts.user.key(),
        price,
        size: remaining_size,
        seq,
        side,
        _pad: [0u8; 7],
    };
    if side == SIDE_BID {
        // On rest, the remaining escrow is exactly
        // bid_cost_ceil(price, remaining_size) per the telescoping property.
        // The difference between escrow_in_usdc - total_filled_usdc and
        // bid_cost_ceil(price, remaining_size) is the over-escrow rounding
        // refund — refund it now.
        let expected_remaining_escrow = bid_cost_ceil(price, remaining_size)?;
        let current_escrow_for_this_order = escrow_in_usdc
            .checked_sub(total_filled_usdc)
            .ok_or(BellMarketsError::MathOverflow)?;
        let refund = current_escrow_for_this_order
            .checked_sub(expected_remaining_escrow)
            .ok_or(BellMarketsError::MathOverflow)?;
        if refund > 0 {
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
                refund,
            )?;
        }
        insert_sorted_bid(&mut book, rest_order)?;
    } else {
        // Ask rest: yes_escrow already holds remaining_size YES (since
        // total_filled_size was sent out). No refund — escrow == size exactly.
        insert_sorted_ask(&mut book, rest_order)?;
    }

    Ok(())
}
