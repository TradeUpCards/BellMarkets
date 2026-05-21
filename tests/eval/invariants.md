# Drew's Invariant Proof Set — BellMarkets

> The 5 invariants the BellMarkets system must hold across every
> `create → mint → trade → settle → redeem` lifecycle. Per Hard YES #1,
> primary verification is the compressed-time simulation
> (`scripts/simulate-trading-day.mjs`); parameterized mocha edge cases
> (`tests/eval/edge-cases.test.ts`) supplement it for the cases the
> simulation doesn't naturally exercise.
>
> Sources: `specs/architecture.md` §3 (invariants table) + BRAINLIFT.md §4
> (Hard YES #1, Hard YES #6, Hard YES #8, Hard NO #8) + `constitution/hard-rules.md`
> §4.4 + §4.6 + §6.1. **No invariant is added or removed without RAISE to Tate**
> (Drew never modifies BRAINLIFT.md unilaterally).

---

## I1 — Vault solvency: `vault_balance == $1 × pairs_outstanding`

After every `mint_pair` and `redeem`, the program-owned USDC vault holds
**exactly $1 per un-redeemed pair**. No more, no less.

- **Where enforced on-chain:** `mint_pair` (deposit), `redeem` (drain).
  Aria's `programs/bell-markets/src/instructions/mint_pair.rs` +
  `redeem.rs` are the load-bearing files.
- **Verified by simulation:** `simulate-trading-day.mjs` Phase 5 reads
  `program.fetchVaultBalance(market)` and `market.pairsOutstanding` from
  the (mocked) program state; asserts `vault == pairs × ONE_USDC`.
- **Supplemented by mocha:** `edge-cases.test.ts → "I1 vault solvency under
  redeem-during-trade"` — sweeps (mints × interleaved trades × partial
  redeems) on devnet against the real program once Aria deploys (Sat 5/23).
- **Failure mode if violated:** vault drains below `$1 × outstanding` →
  some winner cannot be paid out at redeem. Or vault holds *more* than
  `$1 × outstanding` → stuck funds (less catastrophic but still wrong).
  Either way the $1 USDC invariant (Hard NO #8) is broken.
- **Reference:** BRAINLIFT.md Hard NO #8, `hard-rules.md` §4.6, `specs/architecture.md` §3 invariants table row 1.

---

## I2 — Payout completeness: `yes_payout + no_payout == $1.00` per pair

For every settled market, the sum of all winning-side payouts equals
`$1.00 × pairs_redeemed_on_winning_side`. The losing side gets `$0`. No
fees skimmed from payouts (fees, if added later, go to a separate account).

- **Where enforced on-chain:** `settle_market` writes the outcome;
  `redeem` checks token-side against outcome and pays $1 only to the
  winner. Aria's `redeem.rs`.
- **Verified by simulation:** Phase 5 sums `redeem` log events; asserts
  `Σ payouts == Σ winning_side_burns × $1`.
- **Supplemented by mocha:** `edge-cases.test.ts → "I2 payout-completeness
  for at-strike outcome"` — covers the `close == strike` edge case
  (currently `YesWins` per `Outcome::YesWins` `close >= strike` rule);
  also covers `close > strike + ε` and `close < strike - ε`.
- **Failure mode if violated:** the $1 USDC invariant breaks — the
  product's pricing premise (Yes + No = $1 by construction) collapses,
  and arbitrage between Yes and No tokens becomes possible. Demo-killer.
- **Reference:** BRAINLIFT.md Hard NO #8 + Hard YES #1, `hard-rules.md`
  §4.6, `specs/architecture.md` §3 invariants table row 2.

---

## I3 — Outcome immutability: `outcome` is written exactly once

Once `settle_market` or `admin_settle` writes a non-`None` outcome to
`StrikeMarket.outcome`, no subsequent call to either instruction can
overwrite it. This blocks "settlement re-litigation" attacks
(double-settling under social pressure or with a different Pyth read).

- **Where enforced on-chain:** `settle_market` + `admin_settle` check
  `market.outcome.is_none()` before writing.
- **Verified by simulation:** Phase 3 deliberately calls `settle_market`
  a second time from a different caller (`ALICE` after `CAROL`); asserts
  the second call reverts with "outcome already written".
- **Supplemented by mocha:** `edge-cases.test.ts → "I3 second settle
  rejected"` — both via `settle_market` and via `admin_settle`. And the
  same-instruction race case: two callers crank simultaneously, one wins,
  the other reverts cleanly (DR-002 benign race).
- **Failure mode if violated:** an outcome can be re-written → token
  holders can be cheated by re-settling at a different (admin-favorable)
  price. Architecture's strongest defense (POV-2 / DR-002) collapses.
- **Reference:** `specs/architecture.md` §3 invariants table row 3,
  `hard-rules.md` §4.4 (immutable once written).

---

## I4 — Token supply discipline: tokens only created via `mint_pair`, destroyed via `redeem`

Yes and No SPL tokens for a given strike market can ONLY be minted by
the program's `mint_pair` instruction (program owns the mint authority)
and burned by `redeem` (program owns the burn authority via PDAs). No
external mint, no external burn, no arbitrary supply changes.

- **Where enforced on-chain:** Yes/No mints are PDAs (`["yes_mint", market.key()]`
  / `["no_mint", market.key()]`). Mint authority is the program-derived
  PDA, not a wallet. Burn authority for redemption is checked by
  the program against the held position.
- **Verified by simulation:** Phase 5 cross-checks
  `Σ mintPair.pairs - Σ redeem.winning_side_burns == pairsOutstanding`.
  The mock tracks all token-changing events; if the only entry points
  are `mintPair` and `redeem`, the equation holds.
- **Supplemented by mocha:** `edge-cases.test.ts → "I4 unauthorized mint
  attempts rejected"` — direct SPL `mintTo` call with an arbitrary
  signer asserts revert; direct `burn` from a wallet asserts revert
  unless funneled through `redeem`.
- **Failure mode if violated:** unauthorized minting → token supply
  decoupled from vault deposits → vault solvency (I1) breaks.
  Unauthorized burn → user can't redeem tokens they hold (DoS at best,
  asymmetric loss at worst).
- **Reference:** `specs/architecture.md` §3 invariants table row 4, PDA
  seeds in §3 ("PDAs (seeds)" subsection).

---

## I5 — Position-exclusivity: frontend-only guardrail, benign on-chain

The frontend (Cleo) prevents a wallet from acquiring both Yes and No
tokens for the same market from trading. This is enforced at the UX
layer (position-aware Buy/Sell buttons), **not** on-chain. If bypassed
(e.g., user holds both because they minted a pair and didn't trade
either side), the on-chain state is harmless: the user can redeem the
pair for exactly `$1`.

- **Where enforced:** `apps/web/components/TradePanel/*` (Cleo). No on-chain check.
- **Verified by simulation:** Phase 5 walks all positions and reports
  any wallet ending Phase 4 with both `yesBalance > 0` AND `noBalance > 0`.
  This is **informational**, not a fail — Hard YES #8 explicitly says
  the on-chain state is benign. We log a warning so Cleo can audit if
  the UI ever leaks the mint-pair surface (POV-3 violation).
- **Supplemented by mocha:** `tests/frontend/` owns the UI assertions
  (Cleo). Drew's `tests/integration/cron-failure.test.ts` will verify
  the demo audience can still operate the system if they end up in this
  state (redeem-the-pair affordance).
- **Failure mode if violated:** UX bug, not a vault/settle bug. User
  experience degrades (confusing position display) but funds are safe.
  No on-chain remediation required.
- **Reference:** BRAINLIFT.md Hard YES #8, POV-3, `hard-rules.md` §6.1,
  `specs/architecture.md` §3 invariants table row 5.

---

## What is *not* an invariant in this set

These were considered and excluded:

- **"Phoenix order book correctly orders bids/asks by price-time priority"**
  — owned by Phoenix's audited matcher (DR-001). We do not re-verify it.
- **"Pyth price is the true market close"** — we cannot verify this from
  inside our system. We verify that Pyth passes our staleness + confidence
  thresholds (`hard-rules.md` §4.4), which is the on-chain enforceable
  surface.
- **"Automation service runs every day at 4:05pm ET"** — orthogonal to
  the architectural invariants by design (DR-002). The system must work
  whether or not the automation runs; the cron-failure path (Hard YES #5)
  is the load-bearing evidence.

---

## How to run the proof set

**Day 1 (Thu 2026-05-21):** primary verification only (no Aria deploy yet).

```bash
node scripts/simulate-trading-day.mjs               # default outcome: YesWins
node scripts/simulate-trading-day.mjs --outcome=no_wins
```

Both outcomes must exit 0. The simulation logs `✓` for each invariant check
and `✗` for any violation (sets non-zero exit code).

**Sat 2026-05-23 onward** (once Aria deploys + devDeps land):

```bash
pnpm --filter @bell-markets/tests test:eval         # parameterized mocha edge cases
pnpm --filter @bell-markets/tests test:integration  # full devnet lifecycle
```

CI runs all three on every PR (per BRAINLIFT.md Hard YES #4 +
`hard-rules.md` §5.3).
