# Frontend data flow + Helius `getProgramAccounts` restriction

> Captures two lessons learned the hard way on 2026-05-28: Helius
> standard tier restricts `getProgramAccounts`, and the demo-strikes
> registry must be re-seeded after every program-schema bump.

---

## 1. The `getProgramAccounts` (GPA) restriction

### What we hit

The frontend's `useAllMarkets` hook used `connection.getProgramAccounts(BELL_MARKETS_PROGRAM_PUBKEY, { filters: [memcmp on discriminator] })` to enumerate every StrikeMarket account in the program. Functionally correct — but on the deployed app the matrix was perpetually stuck on `"Loading live markets from program.account.strikeMarket.all()…"`.

Helius's standard-tier RPC nodes either reject or silently hang on unindexed `getProgramAccounts` calls. The matrix loading state was downstream of an RPC call that never returned. That single failure cascaded into the trade page showing "$0 / Insufficient funds" because `liveMarket` resolution depends on the markets list.

### Why Helius blocks GPA

`getProgramAccounts` forces an RPC node to scan the *entire* account space of the specified program — every byte of every account the program has ever created. It's the single most expensive Solana JSON-RPC method. Helius bills it as such: standard tiers get it blocked, paid tiers get rate-limited windows, the Atlas indexer service (paid) pre-indexes it so a call returns from a database instead of a live scan.

Anchor's `program.account.<X>.all()` wrapper makes a GPA call look innocent in code. It is not. Same call, same cost, same restriction.

### What the rest of the ecosystem does

Looking at the `solana_token_migration` (w3swap) project — a comparable Solana dApp with on-chain projects to enumerate:

| Surface | Pattern |
|---|---|
| User-facing project list (frontend) | Reads from Neon Postgres via `/api/projects` — pure DB read, no chain call |
| Backend sync job (`lib/neon-jobs/discover.ts`) | Uses `getProgramAccounts` with discriminator memcmp, then writes results to Neon. Runs server-side on a Vercel cron — server-side calls can be on a different Helius tier with GPA enabled. |
| Snapshot / multi-account reads | `getMultipleAccountsInfo` (cheap, allowed on all tiers, but you have to know which pubkeys to ask for) |
| GPA-direct fallback path | Documented but inactive — labeled "Neon-off" in code comments, kept around in case the backend goes down. |

Net pattern: **frontend reads from a registry; a backend job populates the registry from chain.**

### What BellMarkets does (v1 / 2026-05-28)

We use the same shape, simplified: the registry is a hardcoded TypeScript const in `apps/web/src/lib/demo-strikes.ts`. Adding a market = appending one line. Removing one = deleting one line. No backend cron, no Postgres table — fine for a 21-market demo with operator control over which markets are seeded.

The hook `useAllMarkets` iterates the registry and calls `connection.getMultipleAccountsInfo(pdas, "confirmed")` once. Works on every Helius tier. No indexer required. ~50ms response time vs the timeout we hit with GPA.

```ts
// apps/web/src/hooks/use-all-markets.ts (post-fix 7f9e5e2)
const pdaList = DEMO_STRIKE_MARKETS.map((m) => new PublicKey(m.marketPda));
const infos = await connection.getMultipleAccountsInfo(pdaList, "confirmed");
// ... decode each non-null
```

### Production evolution path

For mainnet, when users self-create strikes via `user_create_strike_market` (DR-005), a hardcoded list won't cut it. Two options:

1. **Neon table + backend sync** (the w3swap pattern). Bram's automation cron runs `getProgramAccounts` server-side (on a paid Helius tier OR a dedicated RPC), writes the result to a `markets` table in Neon. Frontend reads `/api/markets`. Refreshed every N minutes.
2. **Helius Atlas indexer**. Paid Helius service that pre-indexes every program account. `program.account.strikeMarket.all()` works against the indexed copy. Less infrastructure on our side; more vendor lock-in.

For now, the hardcoded registry is the right shape — it makes the demo deterministic and the cost-of-change linear in the number of markets.

---

## 2. PDA schema bumps invalidate the registry

### What we hit

After the DR-020 pivot (deploy_index=7), `StrikeMarket` grew from 333 B to 341 B with the addition of an `order_book: Pubkey` field. The existing 21 PDAs in the demo-strikes registry were seeded *before* deploy_index=7 — they sat at the legacy 333-byte layout. Anchor's decoder against the current IDL silently failed on every one of them. Matrix stayed empty.

The hook's defensive filter (`if (!data.strikePrice || !data.expiryUnix || !data.yesMint) continue;`) is intentionally permissive — it drops malformed accounts rather than crashing the page. That's the right behavior. The downside is silent failure: legacy-schema markets just disappear from the UI with no error message.

### The PDA-seed problem

`StrikeMarket` PDA is keyed on `[b"strike", underlying_pyth_feed, expiry_unix, strike_price]`. After a schema bump, you can't *upgrade* an existing PDA — the on-chain data is the wrong size, the account is the wrong size, and the program rejects re-init. Your only options:

1. **Force-cancel + close + re-create at the same seed** — requires `force_cancel_order` + `close_strike_market` instructions we don't have yet (v1.1 work per `specs/deferred.md`).
2. **Create at a different seed** — change the expiry or the strike, get a fresh PDA at the new layout. The legacy PDA stays on chain forever as a tombstone (~$0.003 SOL stranded per market).

For dev / demo iteration, option 2 is what we use. The `--expiry-days N` flag on `seed-demo-liquidity` was added specifically for this: pick a fresh expiry, get fresh PDAs at the current schema, update the registry.

### Operator runbook for a schema bump

When the on-chain `StrikeMarket` layout changes:

1. Re-deploy the program with the new layout
2. Re-seed: `pnpm --filter @bell-markets/automation seed-demo-liquidity --tickers META,NVDA,AAPL,MSFT,GOOGL,AMZN,TSLA --expiry-days N` (pick N to avoid colliding with any existing valid registry entries)
3. Parse the seed output JSON for the 21 new `(ticker, strike, marketPda)` tuples
4. Update `DEMO_STRIKE_MARKETS` in `apps/web/src/lib/demo-strikes.ts`
5. Update `DEMO_LIVE_STRIKE` if the per-ticker ATM strike values changed
6. Commit + push — Vercel rebuilds the frontend
7. Optional verification: `pnpm --filter @bell-markets/automation tsx services/automation/scripts/verify-demo-registry.ts` (currently has the PDAs hardcoded — update it from the registry every time you bump)

The 21-PDA registry is small. The whole sweep is ~10 min wall-clock.

---

## 3. The expiry-days flag is a workaround, not a product feature

`--expiry-days N` exists because we need to force fresh PDAs without re-implementing the `close_strike_market` machinery. It's not modeling the product lifecycle.

### Production lifecycle (per DR-006 / DR-007)

```
4:05 PM ET, day N-1
   grid-phase1-anchor cron creates the 49-market grid for day N
   (7 tickers × 7 strikes per ticker: ATM, ±3%, ±6%, ±9%)
   Markets open for trading immediately on creation

24-hour continuous trading window
   post-close, evening, overnight, pre-market, regular session

4:00 PM ET, day N
   Underlying market closes; last trade

~4:05 PM ET, day N
   settle_market cranked (permissionless DR-002).
   Pyth read, outcome immutably written.

Indefinite after settle
   Redemption open. Winners claim $1 bUSDC per winning token.
```

### Why we don't model this in dev

Wall-clock time is too slow for iteration. A full lifecycle test (create → trade → settle → redeem) takes 24+ hours of calendar time. We need to compress that into minutes for E2E development.

### What we have today

Aria shipped the on-chain pieces in deploy_index=9:

- **`update_admin_override_delay_secs(N)`** — admin sets the `admin_settle` time-delay gate. Default is 1 hour; set to 0 for dev to fire admin settle immediately after expiry. Production stays at 1 hour.
- **`create_strike_market` admin path elides `expiry_is_market_close_time`** — admin can create a market with expiry = `now + 5 minutes`. User-funded `user_create_strike_market` still enforces market-close alignment.

So the building blocks are there. What we're MISSING is a compressed-time mode wired into the seed script. The current `seed-demo-liquidity --expiry-days N` only takes integer-day offsets pegged to 4 PM ET. We need:

- `seed-demo-liquidity --expiry-minutes N` (or a separate `seed-compressed-cycle.ts`) that:
  1. Calls `update_admin_override_delay_secs(0)` once at the start
  2. Creates a strike with `expiry_unix = now + N * 60`
  3. Seeds liquidity (existing pipeline)
  4. Prints follow-up commands: a) timestamps for when to crank settle, b) the `admin_settle` and `redeem` shell calls to copy-paste

That would let a dev run a full lifecycle in ~10 minutes including trading time. Without it, every settlement test waits for 4 PM ET tomorrow.

**Status:** Documented as TODO. Effort estimate ~30 min Aria + Bram pair. Track at `specs/deferred.md` under "compressed-time dev tooling".

---

## 4. TL;DR for the next person

If the matrix is empty:

1. **Is the deployed app on the latest commit?** Check `https://bell-markets.vercel.app/api/spot/NVDA` returns 200. If 404, Vercel hasn't rebuilt.
2. **Is the RPC proxy alive?** Check `https://bell-markets.vercel.app/api/solana-rpc?network=devnet` returns ANY JSON response (even an error). If 500, Helius env var is missing.
3. **Are the registry PDAs still valid?** Run `pnpm --filter @bell-markets/automation tsx services/automation/scripts/verify-demo-registry.ts` (after updating its hardcoded PDA list). If all 21 decode, the registry is current. If they don't, the program schema changed and you need to re-seed.
4. **Is the seed script using `getProgramAccounts` anywhere new?** Grep the hook code. If yes, replace with `getMultipleAccountsInfo(pdaList)` and add the PDAs to the registry.

If "Insufficient funds" shows even with a funded wallet:

- It's almost always a downstream symptom of the matrix being empty (no `liveMarket` → no `marketConfig` → no ATA derivation → 0 balance). Fix the matrix first; the balance will resolve.
- If the matrix is fine and the balance is still 0, confirm the wallet's bUSDC ATA exists and is funded: `pnpm --filter @bell-markets/automation tsx services/automation/scripts/check-market-config.ts` (after editing the wallet pubkey at the top).

---

## Related docs

- `docs/architecture/pre-mainnet-readiness.md` §"Pyth devnet posture (audited)" — sibling case of "RPC reality vs assumed reality"
- `specs/deferred.md` §"OrderBook + escrow rent recovery" — what `force_cancel_order` + `close_strike_market` would unlock for in-place schema upgrades
- `docs/cost-analysis.md` — operator-cost picture including the "tombstone PDAs after schema bumps" line item
