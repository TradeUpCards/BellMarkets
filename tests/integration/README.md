# tests/integration — full-lifecycle on Solana devnet

**Owner:** Drew. **Status:** Day-1 scaffold (Thu 2026-05-21).

## What lives here

End-to-end tests that exercise the `create → mint → trade → settle → redeem`
lifecycle against Aria's deployed Anchor program on Solana devnet.

- `mocks/aria-interface.ts` — TS types + mock implementation of Aria's
  program instructions. Used by `scripts/simulate-trading-day.mjs` and the
  parameterized mocha tests **until Aria deploys Sat 2026-05-23**, at which
  point the mock is replaced with real `@coral-xyz/anchor` 0.30.1 client
  calls against the deployed program.
- (planned) `lifecycle.test.ts` — single-tx-per-phase mocha test of the
  full lifecycle. Lands Sat 2026-05-23 after Aria's first devnet deploy.
- (planned) `multi-user.test.ts` — 3-wallet contention test. Same gate.
- (planned) `cron-failure.test.ts` — DR-002 evidence: kill the automation
  signer mid-settle, assert a user wallet can still crank `settle_market`.

## How to run

**Day 1 (today):** the simulation runs standalone:

```bash
node scripts/simulate-trading-day.mjs
```

**From Sat 2026-05-23 onward (once devDeps land):**

```bash
pnpm --filter @bell-markets/tests test:integration
```

## Coverage targets

- **Hard YES #1** ($1 USDC invariant) — verified by `scripts/simulate-trading-day.mjs` + invariant cross-check (Phase 5).
- **Hard YES #2** (one-command demo) — exercised by `scripts/one-command-demo.sh`.
- **Hard YES #5** (cron-failure path / DR-002 evidence) — exercised by `cron-failure.test.ts` (lands Sun 2026-05-24).
- **Hard NO #12** (no live stock prices) — mock Pyth feeds only; `LIVE_ORACLE=1` is the explicit opt-in.
