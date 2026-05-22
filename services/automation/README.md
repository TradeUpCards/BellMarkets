# services/automation

Off-chain orchestration for BellMarkets. Owner: **Bram**.

Two scheduled jobs (Trigger.dev free tier):

| Job | Schedule (EDT) | Schedule (UTC cron) | Purpose |
|---|---|---|---|
| `morning-create-markets` | 8:00 AM ET, Mon–Fri | `0 13 * * 1-5` | Read previous close per MAG7 stock, compute strikes (±3/6/9 %, $10-rounded, deduped, plus rounded prev close), call `create_strike_market` per unique strike. |
| `settlement-nudger` | 4:05 PM ET, Mon–Fri | `5 21 * * 1-5` | Permissionless caller of `settle_market` (DR-002). Retries every 30s for up to 15 min on `PythConfidenceTooWide` / `PythStale` / RPC blips per the PRD; non-retriable errors abort immediately. After 15min the market stays Unsettled and `admin_settle` becomes eligible at expiry + `admin_override_delay_secs`. |

> **DST:** the cron expressions above are correct for EDT (mid-March through early November). When the US shifts back to EST in November, both crons must move one hour later in UTC (`0 14 …` / `5 22 …`). Tracked as a known issue in `.project/bell-markets/handoffs/bram-handoff.md`.

> **DR-002 (Hard NO #5):** neither job has special signing authority over the on-chain program. The morning job signs `create_strike_market` with the platform-admin keypair because the program's `constraint = config.admin == admin.key()` requires it — any wallet whose pubkey matches `MarketConfig.admin` can sign the same call. The settlement nudger calls `settle_market` with the exact instruction shape any user would use; if the nudger dies, anyone can crank settlement themselves.

## Layout

```
services/automation/
├── README.md             (this file)
├── package.json          @bell-markets/automation
├── tsconfig.json         extends ../../tsconfig.base.json
├── trigger.config.ts     Trigger.dev v4 config
├── vitest.config.ts      points at ../../tests/automation/**
├── .env.example          env shape (program ID, RPC, keypair path, IDL path, per-ticker Phoenix + Pyth pubkeys)
└── src/
    ├── index.ts          barrel
    ├── types.ts          StrikeSet, Ticker, MAG7 constant
    ├── config.ts         env loader + PYTH_HERMES_FEED_IDS + 4pm-ET expiry helper
    ├── strike-calc.ts    pure deterministic strike generator
    ├── idl/
    │   ├── bell_markets.json   placeholder `{}` until Aria's anchor build artifact lands
    │   └── README.md           drop-zone instructions
    ├── lib/
    │   └── retry.ts      deadline-bounded retry helper (injectable clock + sleep, PRD-mandated 30s × 15min cadence)
    ├── clients/
    │   ├── pyth.ts       Hermes HTTP client (mockable fetch) — returns price + expo + publishTime
    │   ├── helius.ts     web3.js Connection wrapper (mockable factory, deferred imports)
    │   └── anchor.ts     BellMarketsAnchorClient — loads IDL + keypair, builds `Program<Idl>` (deferred imports)
    └── jobs/
        ├── morning.ts    Trigger.dev schedules.task — calls create_strike_market per unique strike
        └── settlement.ts Trigger.dev schedules.task — scans open StrikeMarket accounts, settles each with retry harness
```

Tests live at `tests/automation/**` (kept out of the workspace package so Drew's cross-cutting test runner can pick them up uniformly).

## Local commands

From repo root, after `pnpm install`:

```bash
# Run unit tests (vitest, no network access)
pnpm --filter @bell-markets/automation test

# Typecheck
pnpm --filter @bell-markets/automation typecheck

# Run the Trigger.dev local dev server (requires TRIGGER_PROJECT_REF + a Trigger.dev account)
pnpm --filter @bell-markets/automation dev
```

## Test discipline

- **No live Pyth / Helius / Solana reads in unit tests** (`constitution/hard-rules.md` §2.2). All clients accept injection (`fetchImpl`, `connectionFactory`, `programFactory`, `idlOverride`, `keypairOverride`, `readFileImpl`) so tests supply deterministic fixtures and never load `@solana/web3.js` at runtime.
- **No secrets in committed files.** `.env.example` shows shape only; keypair JSONs live under `keys/` (gitignored, w3swap separation-of-authority pattern).
- **Strike-calc is pure** — same input → same output, no Date/clock/env reads inside the function.

## Day-2 wiring (2026-05-21)

Aria's program is live on devnet at `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV`. The morning job:

1. Reads previous-close from Pyth Hermes for each MAG7 ticker.
2. Generates strikes via the pure `computeStrikesForStock(prevClose)` function.
3. Calls `program.methods.createStrikeMarket(strikePriceI64, expiryUnix).accounts({…}).rpc()` per unique strike, scaling each strike into the Pyth-feed-native i64 representation (typically `expo = -8` for US equities; `$230 → 23_000_000_000n`).
4. Skips any ticker whose `PHOENIX_MARKET_<TICKER>` or `PYTH_PRICE_ACCOUNT_<TICKER>` env var is unset, and logs a clear `skipped — …` line.
5. Continues across per-strike failures (one bad strike doesn't kill the batch).

The orchestration is extracted to `runMorningCreateMarkets({ deps })` so it's unit-testable without Trigger.dev's runtime — see `tests/automation/morning-job.test.ts`.

## Day-2 known gaps (handoff-tracked)

- **IDL artifact not yet committed** — `src/idl/bell_markets.json` is `{}` until Aria copies `target/idl/bell_markets.json` from her worktree post-`anchor build`. The Anchor client fail-fasts with a descriptive `AnchorClientError` until then.
- **Pyth on-chain price-account pubkeys** (per-ticker `PYTH_PRICE_ACCOUNT_*` env vars) are blank. Look up devnet pubkeys from pyth.network's published feed list and populate `.env`.
- **Phoenix v1 FIFO market pubkeys** (per-ticker `PHOENIX_MARKET_*` env vars) are blank. Aria's `verify_phoenix_market` is live and rejects anything without the 8-byte magic prefix — Day-3 work to find or clone real devnet markets.
- **`USDC_DEVNET_MINT`** must match `MarketConfig.usdc_mint` set at `initialize_config` time. Populate from Aria's deploy record.
- **Settlement nudger** wired Day-3 with the PRD retry harness — scans `program.account.strikeMarket.all()`, filters Unsettled + expired, settles each with `retryUntilDeadline` (30s × 15min). Won't actually run end-to-end until the IDL + initialize_config blockers above land.
- **DST cron flip** (see table above).
