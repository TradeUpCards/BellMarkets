# services/automation

Off-chain orchestration for BellMarkets. Owner: **Bram**.

Two scheduled jobs (Trigger.dev free tier):

| Job | Schedule (EDT) | Schedule (UTC cron) | Purpose |
|---|---|---|---|
| `morning-create-markets` | 8:00 AM ET, Mon–Fri | `0 13 * * 1-5` | Read previous close per MAG7 stock, compute strikes (±3/6/9 %, $10-rounded, deduped, plus rounded prev close), call `create_strike_market` per unique strike. |
| `settlement-nudger` | 4:05 PM ET, Mon–Fri | `5 21 * * 1-5` | Permissionless caller of `settle_market` (DR-002). Retries every 30s for up to 15 min if Pyth confidence is wide; otherwise alerts admin for `admin_settle` fallback. |

> **DST:** the cron expressions above are correct for EDT (mid-March through early November). When the US shifts back to EST in November, both crons must move one hour later in UTC (`0 14 …` / `5 22 …`). Tracked as a known issue in `.project/bell-markets/handoffs/bram-handoff.md`.

> **DR-002 (Hard NO #5):** neither job has special signing authority over the on-chain program. The settlement nudger calls `settle_market` with the exact instruction shape any user would use; if the nudger dies, anyone can crank settlement themselves. The morning create-markets job uses an "operator" wallet that has admin authority on `create_strike_market` only — not on `settle_market`.

## Layout

```
services/automation/
├── README.md             (this file)
├── package.json          @bell-markets/automation
├── tsconfig.json         extends ../../tsconfig.base.json
├── trigger.config.ts     Trigger.dev v4 config
├── vitest.config.ts      points at ../../tests/automation/**
├── .env.example          env shape (TRIGGER_PROJECT_REF, HELIUS_DEVNET_RPC_URL, PYTH_HTTP_BASE_URL, PROGRAM_ID, ADMIN_KEYPAIR_PATH)
└── src/
    ├── index.ts          barrel
    ├── types.ts          StrikeSet, Ticker, MAG7 constant
    ├── config.ts         env loader + PYTH_FEED_IDS (placeholders until Aria publishes the real map)
    ├── strike-calc.ts    pure deterministic strike generator
    ├── clients/
    │   ├── pyth.ts       Hermes HTTP client (mockable fetch)
    │   └── helius.ts     web3.js Connection wrapper (mockable factory)
    └── jobs/
        ├── morning.ts    Trigger.dev schedules.task — Day-1 stub (no on-chain)
        └── settlement.ts Trigger.dev schedules.task — Day-1 stub (no on-chain)
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

- **No live Pyth / Helius reads in unit tests** (`constitution/hard-rules.md` §2.2). The `PythClient` and `HeliusClient` constructors both accept injection (`fetchImpl`, `connectionFactory`) so tests deterministically supply fixture data.
- **No secrets in committed files.** `.env.example` shows the shape only.
- **Strike-calc is pure** — same input → same output, no Date/clock/env reads inside the function.

## Day-1 known gaps (handoff-tracked)

- `PYTH_FEED_IDS` in `src/config.ts` are placeholders. Reconcile with Aria's `MarketConfig.pyth_feed_map` before the first live devnet run.
- Both jobs hard-stop if `PROGRAM_ID` is configured but on-chain wiring is missing — by design, to avoid silently no-op'ing on a half-wired deploy.
- DST cron flip (see table above).
