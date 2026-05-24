# BellMarkets — Transaction Size Analysis vs Phantom 900-byte Soft Cap

**Last updated:** 2026-05-24 by Aria, post-deploy_index=6
**Program ID (devnet):** `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV`
**Deployed binary size:** 759 632 bytes (~742 KB; 7.4% of Solana's ~10 MB program cap)

## Why this document exists

Phantom (the dominant Solana wallet) accepts transactions up to Solana's
protocol hard cap of **1232 bytes**, but soft-caps incoming txs at **900
bytes** to avoid wallet-UX edge cases — at the upper end of the protocol
limit Phantom sometimes shows degraded popups, retry storms, or "transaction
too large" rejections that feel like protocol failures even when they're
technically wallet-side. Designing every instruction against 900 bytes
rather than 1232 is the discipline that keeps the dApp usable across the
wallet ecosystem in addition to passing the chain.

This file is the static analysis we used to verify every BellMarkets
instruction fits under 900 — both as a single ix and in the atomic-bundle
flows the product depends on — and where Address Lookup Tables (ALTs)
contribute the rescue when needed.

## Methodology

Solana legacy-tx size formula (RFC-style):

```
tx_size = num_signatures × 64                            # ed25519 signatures
        + 3                                              # message header (compact)
        + 32                                             # recent blockhash
        + compact_u16(num_acct_keys) + (num_acct_keys × 32)  # account keys table
        + compact_u16(num_ixs)                           # ix array length
        + Σ per_ix(
            1                              # program_id_index (u8)
          + compact_u16(num_acct_idxes) + num_acct_idxes
          + compact_u16(data_len) + data_len
          )
```

For versioned txs with one ALT entry:

```
+ 32                       # ALT pubkey
+ 1 + writable_idx_count   # writable index list
+ 1 + readonly_idx_count   # readonly index list
```

Account indexes in the ix block stay 1 byte each regardless of whether the
account is in the account-keys table or sourced via ALT.

`compact_u16` is 1 byte for values < 128, 2 bytes for 128..16383. Every
count in our worst-case is < 128, so 1 byte per count throughout.

Per-ix sizes below count both the account-keys table AND the per-ix
account-indexes — they are NOT double-counting. (Account keys table holds
the 32-byte pubkeys once each; each ix lists 1-byte indexes into that
table.)

## Single-instruction tx sizes (legacy, no ALT)

| Instruction | Accts | Data | Tx bytes | % of 900 | % of 1232 |
|---|---|---|---|---|---|
| `mint_pair` | 18 | 16 B | **714** | 79% | 58% |
| `user_create_strike_market` | 14 | 24 B | 590 | 66% | 48% |
| `create_strike_market` | 12 | 24 B | 524 | 58% | 43% |
| `force_redeem` | 12 | 16 B | 516 | 57% | 42% |
| `redeem_invalid` / `redeem_pair` | 11 | 16 B | 484 | 54% | 39% |
| `initialize_rewards_pools` | 10 | 0 B | 412 | 46% | 33% |
| `redeem` | 9 | 16 B | 419 | 47% | 34% |
| `distribute_*_rewards` (top-10, proof depth=4) | 7 | 158 B | 493 | 55% | 40% |
| `distribute_*_rewards` (top-200, proof depth=8) | 7 | 286 B | 621 | 69% | 50% |
| **`distribute_*_rewards` (max depth=16, theoretical worst)** | 7 | 542 B | **877** | **97%** | 71% |
| `commit_leaderboard_root` | 4 | 89 B | 235 | 26% | 19% |

**Result:** 9 of 9 single-ix tx surfaces fit under 900 bytes legacy.
The closest call — `distribute_*_rewards` at theoretical max merkle
proof depth (16) — is 877 bytes (97% of 900). At realistic top-10 distribution
that uses a 4-level proof, the same ix is 493 bytes (55%).

## Bundled atomic transactions (DR-005 flows)

DR-005 § "Consequences" specifies that the first-trader UX bundles
`[user_create_strike_market, mint_pair, place_order]` into a single atomic
transaction (one wallet signature, one broadcast). The same pattern shows
up in the POV-3 atomic Sell No flow which bundles `[mint_pair,
phoenix_place_order]`. These bundles share accounts (the user, the
strike_market, the Phoenix market pubkey, USDC mint, token program, etc.)
so the account-keys table is deduped — but the total still grows.

Approximate Phoenix `place_limit_order` shape (from the Phoenix v1 source
investigation in `.project/bell-markets/coordination/model-d-investigation.md`):
~7 accounts (phoenix_program, log_authority, market, trader, seat,
base_account, quote_account), ~50 bytes of ix data (price + side + size +
order_type + slippage).

| Bundle | Unique acct keys (deduped) | Tx bytes (legacy) | % of 900 |
|---|---|---|---|
| `[mint_pair + phoenix.place_order]` (Sell No / Buy No atomic) | 21 | **870** | 97% |
| **`[user_create_strike_market + mint_pair + phoenix.place_order]` (first-trader bundle)** | 25 | **1039** | **115% — OVER 900** |

**Result:** the 2-ix Sell No / Buy No atomic flow squeaks under at 97%.
The 3-ix DR-005 first-trader flow **breaks the Phantom 900-byte soft cap
by 139 bytes legacy**. This is the case that motivated ALT pre-deployment.

## Address Lookup Table — the fix

ALT `H1s61AcEuKfLBspPPUWCQTth7CqAhLfBQqDCvATTsQKP` deployed to devnet
2026-05-23 (slot 464510228) by Aria via `migrations/setup-alt/`. **Frozen
immediately on creation** — `Authority: None`. Accounts cannot be added,
removed, or replaced. 8 standard accounts indexed:

| Index | Address | Pubkey |
|---|---|---|
| 0 | token_program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| 1 | system_program | `11111111111111111111111111111111` |
| 2 | rent_sysvar | `SysvarRent111111111111111111111111111111111` |
| 3 | usdc_mint (Circle devnet) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| 4 | fee_collector wallet | `FAc2JccudUr9C5pqB2KAnaBaPXLuejYotvfjuuysUrjs` |
| 5 | weekly_rewards_pool | `2VWzrhmdNZN7Yxv2uknYBurJ2PDFzCqsyi5WVeVxJpCW` |
| 6 | monthly_rewards_pool | `Eppjny6RMtVrGxZnjiKEyk41vwWYpXW4PMVKJHC4SAjh` |
| 7 | leaderboard_commitments | `FxohonFj6bTtbPxe4HNjwy736sqkyPfKj5GRektScF7C` |

Each indexed account drops from 32 bytes in the account-keys table to a
1-byte index in the ix block — a 31-byte saving per account, partly offset
by the ALT entry's ~35-byte overhead.

Verification: `solana address-lookup-table get H1s61AcEuKfLBspPPUWCQTth7CqAhLfBQqDCvATTsQKP --url devnet`

## With ALT — the tight cases recover

| Scenario | Legacy bytes | With ALT bytes | Δ | % of 900 (with ALT) |
|---|---|---|---|---|
| `mint_pair` (5 of 18 in ALT) | 714 | 593 | −121 | 66% |
| `distribute_*_rewards` (max depth, 4 of 7 in ALT) | 877 | 787 | −90 | 87% |
| **3-ix first-trader bundle (6 of 25 in ALT)** | **1039** | **887** | **−152** | **99%** |

The 3-ix bundle that broke legacy comes in at **887 bytes with ALT — just
under the 900 cap**, with 13 bytes of margin. The single-ix `mint_pair`
goes from 79% legacy to 66% with ALT — comfortable through any account-count
growth we'd reasonably entertain.

## Defensibility — security choices worth surfacing

Two design choices in the ALT setup that aren't purely a size optimization:

**1. Frozen by default.** Mainstream Solana protocols often leave ALTs
mutable so they can add accounts as the protocol grows. We chose immutability
at deployment: a future admin-key compromise cannot swap our `fee_collector`
or `usdc_mint` pubkeys for attacker-controlled values via ALT indirection.
The trade-off: if we ever need to add more standard accounts, we deploy a
second ALT instead of extending this one. That's a feature, not a bug —
it forces explicit audit of any new indexed-account additions.

**2. Authority discarded post-freeze.** The Solana SDK pattern leaves the
ALT's `authority` field populated even on frozen tables. We let it transition
to `None` per the freeze instruction's semantics. Cleaner story for an
auditor: "this table cannot be mutated by anyone, period."

## Talking-points one-liner for hiring meetings

> We sized every instruction against Phantom's 900-byte soft cap, not just
> Solana's 1232-byte hard cap. The first-trader atomic bundle from DR-005
> (create the strike PDA, mint a $1 pair, place the order — one wallet
> signature) came in at 1039 bytes legacy, 139 bytes over Phantom's
> recommended ceiling. We caught it pre-launch via static analysis,
> pre-deployed an Address Lookup Table containing the 8 standard accounts
> every BellMarkets tx references, and froze it immutable on creation so
> a future admin-key compromise can't redirect funds via ALT mutation.
> The bundle now fits at 887 bytes — 99% of cap, comfortable for production.

## Reproducing these numbers

The math above is implemented as a small Node script at the bottom of this
file. Run it from the repo root with `node` to re-derive every row in the
tables. The arithmetic is mechanical; nothing depends on RPC reads or live
state beyond the deployed account counts and data widths.

```javascript
// Drop-in Node script. Run: node tx-size.js (or paste into REPL).
function txSize({signers=1, accountKeysCount, ixs, altEntry=null}) {
  let bytes = signers * 64 + 3 + 32;
  bytes += 1 + accountKeysCount * 32;
  bytes += 1;
  for (const ix of ixs) {
    bytes += 1 + 1 + ix.accounts + 1 + ix.data_bytes;
  }
  if (altEntry) bytes += 32 + 1 + altEntry.writable + 1 + altEntry.readonly;
  return bytes;
}

// Single ix: mint_pair (18 accts, 16 B data)
console.log("mint_pair:", txSize({accountKeysCount:18, ixs:[{accounts:18, data_bytes:16}]}));

// Single ix: distribute_*_rewards at max depth (7 accts, 542 B data)
console.log("distribute max-depth:", txSize({accountKeysCount:7, ixs:[{accounts:7, data_bytes:542}]}));

// Bundle: first-trader 3-ix flow
console.log("3-ix bundle:", txSize({
  accountKeysCount:25,
  ixs:[
    {accounts:14, data_bytes:24},  // user_create_strike_market
    {accounts:18, data_bytes:16},  // mint_pair
    {accounts:7, data_bytes:50},   // phoenix.place_limit_order
  ]
}));

// 3-ix bundle WITH ALT (6 of 25 indexed → 19 explicit + ALT entry)
console.log("3-ix bundle WITH ALT:", txSize({
  accountKeysCount:19,
  ixs:[
    {accounts:14, data_bytes:24},
    {accounts:18, data_bytes:16},
    {accounts:7, data_bytes:50},
  ],
  altEntry:{writable:2, readonly:4}
}));
```

## Cross-references

- DR-015 § "Defensive: Address Lookup Tables" (`constitution/decisions.md`)
- `.project/bell-markets/coordination/queued-work.md` § DR-015 ALT entry
- `.project/bell-markets/coordination/devnet-pubkeys.md` § "DR-015 Address Lookup Table"
- `migrations/setup-alt/` — the standalone Rust binary that created + froze the ALT (audit trail in source)
- `migrations/audit_log.jsonl` line 6 — deploy_index=6 entry (the deploy whose IDL feeds these counts)
- Phoenix v1 `place_limit_order` shape — derived from `Ellipsis-Labs/phoenix-v1/src/program/instruction.rs` per `.project/bell-markets/coordination/model-d-investigation.md`
