//! Vendored Pyth price-account parser.
//!
//! Per aria kickoff §"Hard rules" + §"Your first task" 2c: we do NOT depend on
//! `pyth-sdk-solana`. We parse the price account's aggregate component at known
//! byte offsets, validate magic + account type + status, and return typed data.
//!
//! Pyth V2 PriceAccount layout (relevant slice, all little-endian).
//! Derived from pyth-client `pc_price_t` struct:
//!   off 0   u32   magic_           (0xa1b2c3d4)
//!   off 4   u32   ver_             (2 for V2)
//!   off 8   u32   atype_           (3 = price)
//!   off 20  i32   expo_            (exponent)
//!   off 48..96   pc_ema_t twap_, twac_   (2 × 24 bytes)
//!   off 96  i64   timestamp_
//!   off 112      pc_pub_key_t prod_      (32 bytes)
//!   off 144      pc_pub_key_t next_      (32 bytes)
//!   off 176 u64   prev_slot_
//!   off 184 i64   prev_price_
//!   off 192 u64   prev_conf_
//!   off 200 i64   prev_timestamp_
//!   off 208      pc_price_info_t agg_:
//!   off 208 i64     agg.price
//!   off 216 u64     agg.conf
//!   off 224 u32     agg.status       (1 = Trading)
//!   off 228 u32     agg.corp_act
//!   off 232 u64     agg.pub_slot
//!
//! Total minimum byte length to safely read agg.pub_slot's end byte = 240.

use anchor_lang::prelude::*;
use crate::errors::BellMarketsError;

pub const PYTH_MAGIC: u32 = 0xa1b2c3d4;
pub const PYTH_VERSION_V2: u32 = 2;
pub const PYTH_ACCTYPE_PRICE: u32 = 3;
pub const PYTH_STATUS_TRADING: u32 = 1;

const MIN_LEN: usize = 240;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PriceData {
    pub price: i64,
    pub confidence: u64,
    pub exponent: i32,
    pub publish_slot: u64,
}

pub fn parse_pyth_price(data: &[u8]) -> Result<PriceData> {
    require!(data.len() >= MIN_LEN, BellMarketsError::PythBadMagic);
    let magic = u32::from_le_bytes(data[0..4].try_into().unwrap());
    require!(magic == PYTH_MAGIC, BellMarketsError::PythBadMagic);
    let ver = u32::from_le_bytes(data[4..8].try_into().unwrap());
    require!(ver == PYTH_VERSION_V2, BellMarketsError::PythBadVersion);
    let atype = u32::from_le_bytes(data[8..12].try_into().unwrap());
    require!(atype == PYTH_ACCTYPE_PRICE, BellMarketsError::PythWrongAccountType);
    let exponent = i32::from_le_bytes(data[20..24].try_into().unwrap());
    let price = i64::from_le_bytes(data[208..216].try_into().unwrap());
    let confidence = u64::from_le_bytes(data[216..224].try_into().unwrap());
    let status = u32::from_le_bytes(data[224..228].try_into().unwrap());
    require!(status == PYTH_STATUS_TRADING, BellMarketsError::PythNotTrading);
    let publish_slot = u64::from_le_bytes(data[232..240].try_into().unwrap());
    Ok(PriceData { price, confidence, exponent, publish_slot })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_fixture(magic: u32, ver: u32, atype: u32, status: u32) -> Vec<u8> {
        let mut buf = vec![0u8; 320];
        buf[0..4].copy_from_slice(&magic.to_le_bytes());
        buf[4..8].copy_from_slice(&ver.to_le_bytes());
        buf[8..12].copy_from_slice(&atype.to_le_bytes());
        buf[20..24].copy_from_slice(&(-8i32).to_le_bytes());
        buf[208..216].copy_from_slice(&15_000_000_000i64.to_le_bytes()); // $150.00 with exp -8
        buf[216..224].copy_from_slice(&7_500_000u64.to_le_bytes());      // conf 0.075
        buf[224..228].copy_from_slice(&status.to_le_bytes());
        buf[232..240].copy_from_slice(&123_456_789u64.to_le_bytes());
        buf
    }

    #[test]
    fn parses_well_formed_trading_account() {
        let buf = make_fixture(PYTH_MAGIC, PYTH_VERSION_V2, PYTH_ACCTYPE_PRICE, PYTH_STATUS_TRADING);
        let p = parse_pyth_price(&buf).unwrap();
        assert_eq!(p.price, 15_000_000_000);
        assert_eq!(p.confidence, 7_500_000);
        assert_eq!(p.exponent, -8);
        assert_eq!(p.publish_slot, 123_456_789);
    }

    #[test]
    fn rejects_bad_magic() {
        let buf = make_fixture(0xdeadbeef, PYTH_VERSION_V2, PYTH_ACCTYPE_PRICE, PYTH_STATUS_TRADING);
        assert!(parse_pyth_price(&buf).is_err());
    }

    #[test]
    fn rejects_halted_status() {
        let buf = make_fixture(PYTH_MAGIC, PYTH_VERSION_V2, PYTH_ACCTYPE_PRICE, 2 /* Halted */);
        assert!(parse_pyth_price(&buf).is_err());
    }

    #[test]
    fn rejects_short_account() {
        let buf = vec![0u8; 100];
        assert!(parse_pyth_price(&buf).is_err());
    }

    #[test]
    fn rejects_bad_version() {
        let buf = make_fixture(PYTH_MAGIC, 99 /* unsupported */, PYTH_ACCTYPE_PRICE, PYTH_STATUS_TRADING);
        assert!(parse_pyth_price(&buf).is_err());
    }

    #[test]
    fn rejects_wrong_account_type() {
        let buf = make_fixture(PYTH_MAGIC, PYTH_VERSION_V2, 1 /* mapping, not price */, PYTH_STATUS_TRADING);
        assert!(parse_pyth_price(&buf).is_err());
    }

    #[test]
    fn rejects_unknown_status() {
        let buf = make_fixture(PYTH_MAGIC, PYTH_VERSION_V2, PYTH_ACCTYPE_PRICE, 0 /* Unknown */);
        assert!(parse_pyth_price(&buf).is_err());
    }
}
