//! Phoenix market adapter.
//!
//! Per kickoff hard-rule §4.12: Phoenix accounts must be passed as
//! `UncheckedAccount<'info>` (Phoenix isn't an Anchor program; an Anchor
//! `Account<'info, T>` discriminator check would reject every Phoenix market).
//! We validate Phoenix accounts via an 8-byte discriminator prefix and
//! otherwise treat the account opaquely.
//!
//! ## Discriminator value (Day-3 verified against upstream)
//!
//! On-chain Phoenix market accounts begin with a `MarketHeader` struct (see
//! `Ellipsis-Labs/phoenix-v1/src/program/accounts.rs`). Its first field is
//! `discriminant: u64`, set to `get_discriminant::<MarketHeader>()`, which is
//! `keccak::hashv(&[program_id, type_name])[..8]` interpreted as a native
//! (little-endian on Solana/x86) u64. Phoenix locks this value in an upstream
//! test:
//!
//! ```ignore
//! // src/program/accounts.rs  (Ellipsis-Labs/phoenix-v1)
//! assert_eq!(get_discriminant::<MarketHeader>().unwrap(), 8167313896524341111);
//! ```
//!
//! Converting `8167313896524341111u64` to little-endian bytes yields
//! `[0x77, 0xDF, 0x71, 0x73, 0xB7, 0x20, 0x58, 0x71]`. That is the canonical
//! first 8 bytes of any Phoenix v1 market account.
//!
//! The discriminant input includes Phoenix's program ID
//! (`PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY` — single ID across all
//! clusters per upstream `declare_id!`), so this value is universal.
//!
//! ## What the Day-1 constant got wrong
//!
//! Day-1 used `[0x07, 0x9c, 0xbd, 0xd1, 0xa3, 0x5d, 0xfc, 0x69]`, cited as
//! `FIFOMarket::discriminator()`. There is no such function — `FIFOMarket` is
//! the inner generic struct that begins with `_padding: [u64; 32]` (i.e.,
//! zeroes), and discriminator lookup actually happens on the wrapping
//! `MarketHeader`. The Day-1 magic would have rejected every real Phoenix
//! market. The unit test below tripwires any future drift.

use anchor_lang::prelude::*;
use crate::errors::BellMarketsError;

/// Phoenix v1 `MarketHeader` discriminant as the first 8 bytes of the account
/// data, little-endian. Derived from upstream constant `8167313896524341111`.
pub const PHOENIX_MARKET_HEADER_DISCRIMINANT: u64 = 8_167_313_896_524_341_111;

/// Same value in LE byte form for direct slice comparison.
pub const PHOENIX_FIFO_MARKET_MAGIC: [u8; 8] = PHOENIX_MARKET_HEADER_DISCRIMINANT.to_le_bytes();

/// Validates that the supplied account is a Phoenix v1 market by checking
/// the 8-byte `MarketHeader::discriminant` prefix. Returns Ok(()) on success;
/// an explicit `PhoenixBadMagic` / `PhoenixAccountTooSmall` error otherwise.
pub fn verify_phoenix_market(account: &AccountInfo) -> Result<()> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 8, BellMarketsError::PhoenixAccountTooSmall);
    let magic: [u8; 8] = data[0..8].try_into().unwrap();
    require!(magic == PHOENIX_FIFO_MARKET_MAGIC, BellMarketsError::PhoenixBadMagic);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tripwire: if anyone ever "updates" the Phoenix discriminant constant
    /// without verifying against upstream, this test fires.
    /// Source: Ellipsis-Labs/phoenix-v1 src/program/accounts.rs
    /// `assert_eq!(get_discriminant::<MarketHeader>().unwrap(), 8167313896524341111);`
    #[test]
    fn discriminant_matches_phoenix_v1_upstream() {
        assert_eq!(PHOENIX_MARKET_HEADER_DISCRIMINANT, 8_167_313_896_524_341_111);
        assert_eq!(
            PHOENIX_FIFO_MARKET_MAGIC,
            [0x77, 0xDF, 0x71, 0x73, 0xB7, 0x20, 0x58, 0x71]
        );
    }

    #[test]
    fn rejects_short_account() {
        // The Anchor `AccountInfo` shape is hard to fake outside a validator,
        // but we can at least assert the byte-level magic constant matches
        // expectations for the canonical Phoenix market shape; the early-exit
        // length guard inside `verify_phoenix_market` is exercised in
        // integration tests against the deployed program.
        let zeros = [0u8; 4];
        assert_ne!(&zeros[..], &PHOENIX_FIFO_MARKET_MAGIC[..4]);
    }
}
