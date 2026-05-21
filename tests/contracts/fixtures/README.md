# Pyth fixture bytes

`pyth-trading-snapshot.json` is a synthetic Pyth V2 price account encoded as
hex, generated to match the byte layout the vendored parser
(`programs/bell-markets/src/oracle.rs`) reads:

Offsets are derived from pyth-client `pc_price_t` (the `agg_` block starts at 208).

| field        | offset | type | value                |
|--------------|--------|------|----------------------|
| magic        | 0      | u32  | 0xa1b2c3d4           |
| ver          | 4      | u32  | 2                    |
| atype        | 8      | u32  | 3 (price)            |
| exponent     | 20     | i32  | -8                   |
| agg.price    | 208    | i64  | 15_000_000_000 ($150) |
| agg.conf     | 216    | u64  | 7_500_000 (0.075)    |
| agg.status   | 224    | u32  | 1 (Trading)          |
| agg.pub_slot | 232    | u64  | 123_456_789          |

Total buffer length: 320 bytes (Pyth V2 PriceAccount is larger in production;
we pad to 320 so all read offsets are in-bounds).

The Rust unit test `oracle::tests::parses_well_formed_trading_account` builds
this same fixture in-memory — bytes must stay in sync.
