//! Phoenix market adapter (stub).
//!
//! Per aria kickoff §"Hard rules" §4.12: Phoenix accounts must be passed as
//! `UncheckedAccount<'info>` (no Anchor deserialization — Phoenix isn't an
//! Anchor program, so `Account<'info, T>` discriminator checks would always
//! fail). We validate Phoenix accounts via an 8-byte magic prefix at the head
//! of the market data buffer and otherwise treat the account opaquely.
//!
//! Reference: https://github.com/Ellipsis-Labs/phoenix-v1/blob/master/src/state/markets/fifo_market.rs
//!
//! NOTE: this stub validates the magic and exposes a typed `verify_market`
//! handle. Actual order placement / CPI to Phoenix lives behind feature gates
//! that Day-2+ work activates. Day-1 deliverable is: the call surface exists,
//! the magic check is real, and the Accounts struct shape is stable.

use anchor_lang::prelude::*;
use crate::errors::BellMarketsError;

// Phoenix-v1 FIFO market discriminator (first 8 bytes of the account data).
// Source: phoenix-v1 `state::markets::fifo_market::FIFOMarket::discriminator()`.
// We hard-code the bytes so this stays in sync without pulling phoenix-v1 as a
// dep (it would explode the BPF build size).
pub const PHOENIX_FIFO_MARKET_MAGIC: [u8; 8] = [0x07, 0x9c, 0xbd, 0xd1, 0xa3, 0x5d, 0xfc, 0x69];

/// Validates that the supplied account is a Phoenix FIFO market by checking
/// the 8-byte magic prefix. Returns Ok(()) on success; an explicit
/// `PhoenixBadMagic` / `PhoenixAccountTooSmall` error otherwise.
///
/// Day-2 work: extend to return a `&PhoenixMarketHeader` slice (zero-copy view
/// into the first ~256 bytes), so settle/admin_settle can read the market's
/// quote-token mint and confirm it matches the strike's USDC vault.
pub fn verify_phoenix_market(account: &AccountInfo) -> Result<()> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 8, BellMarketsError::PhoenixAccountTooSmall);
    let magic: [u8; 8] = data[0..8].try_into().unwrap();
    require!(magic == PHOENIX_FIFO_MARKET_MAGIC, BellMarketsError::PhoenixBadMagic);
    Ok(())
}
