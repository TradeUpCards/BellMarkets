# BellMarkets — Decisions

> Locked architectural decisions. Each entry names the trade-off it
> accepts. Decisions are not deleted — superseded ones stay with status
> updated and the superseding DR cited.

## How to use this file

- **Adding a decision:** append a new `DR-NNN` entry (next sequential
  number). Don't renumber existing entries — citations break.
- **Superseding a decision:** add a new entry, then update the old
  entry's status to `Superseded by DR-XYZ`. Keep the old entry visible.
- **Citing:** "per `constitution/decisions.md` DR-007"

## Decision Record format

Each entry uses this shape:

```
### DR-NNN — [Short title (verb phrase preferred)]

**Date:** YYYY-MM-DD
**Status:** Active | Superseded by DR-XYZ | Deprecated (no replacement)
**Made by:** [Name(s) / lead / team]

**Context:** What was happening when this decision was made? What were
the forces (technical, time, political, partner) in play?

**Decision:** What we're doing. State the choice.

**Trade-off:** What this choice costs. Every real decision has one.
"We pay X in exchange for Y."

**Consequences:** What downstream changes follow from this. What gets
easier; what gets harder.

**Alternatives considered:** What we rejected and why (1-line each).
```

---

## Decision Records

### DR-001 — Integrate Phoenix CLOB; do not build a custom matcher

**Date:** 2026-05-21
**Status:** Active
**Made by:** Cory (Tate) at Day-0 brainlift

**Context:** PRD allows either an existing on-chain CLOB or a hand-built minimal order book. Three-day build window. Team has zero Solana production experience prior to this project. Building a price-time-priority matching engine inside Anchor is a credible interview narrative but consumes a meaningful fraction of the available time and introduces a class of correctness bugs (off-by-one fills, partial-fill accounting, self-trade prevention) that we have no test coverage for yet.

**Decision:** Use **Phoenix** as the on-chain CLOB. Aria's program creates Phoenix markets per strike during the morning create-markets job; Cleo's frontend binds to Phoenix's existing SDK for order placement + book display.

**Trade-off:** We pay a weaker "we built our own matching engine" narrative in exchange for ~1.5 days of build budget, audited matching logic we don't have to test, and a permissionless-crank execution philosophy that aligns with DR-002.

**Consequences:**
- Aria's program does not contain a matcher — only mint-pair / settle / redeem / oracle integration / pause. Smaller surface area, easier to audit ourselves.
- Phoenix market creation must happen before any minting can be useful — morning create-markets job has a sequencing requirement.
- We accept Phoenix's fee schedule (whatever it is on devnet — needs confirmation by Aria during scaffolding).
- If Phoenix has an outage or is deprecated, the trading layer goes away. We have no fallback CLOB.

**Alternatives considered:**
- **Build minimal CLOB inside the Anchor program:** rejected — time budget. Revisitable post-MVP if we ship core lifecycle early.
- **OpenBook v2:** considered but Phoenix is cited specifically in the PRD and has better SDK ergonomics for our timeline.

---

### DR-002 — Permissionless `settle_market`; automation is convenience, not authority

**Date:** 2026-05-21
**Status:** Active
**Made by:** Cory (Tate) at Day-0 brainlift; pushback drove evolution from initial "off-chain owns lifecycle" framing

**Context:** Daily settlement of 35+ markets at 4:05pm ET. Two design options surfaced: (a) Bram's automation service is the sole caller of `settle_market` with signing authority, on-chain enforces only the time gate + Pyth checks; (b) `settle_market` is permissionless — anyone can call it once `block_time >= settlement_window && pyth_fresh && pyth_confident`. Initial framing was (a) on velocity grounds. User raised security and cost/scaling concerns; analysis showed (b) is sharper on multiple axes.

**Decision:** **`settle_market` is permissionless.** The on-chain program enforces all timing rules + Pyth staleness + Pyth confidence + the time-delayed admin override. Bram's automation service is a convenience caller — first to crank wins, automation is the happy-path nudger but holds no special authority over settlement.

The on-chain shape:
- `settle_market(market, pyth_price_account)` — callable by anyone; checks `now >= settlement_time` and `pyth.is_fresh(threshold)` and `pyth.confidence <= threshold`; writes outcome immutably.
- `admin_settle(market, manual_price)` — admin-only; gated by `now >= settlement_time + admin_override_delay` (e.g., 1 hour); used only when Pyth fails persistently.
- `create_strike_market` and `add_strike` remain admin-only (creation needs authority; settlement does not).

**Trade-off:** We pay ~half a day of extra on-chain timing-logic work + tolerance for benign race-condition wasted fees (one tx wins, others fail cleanly), in exchange for: cheaper mainnet ops (~5–10× — no 24/7-monitored hot wallet for liveness), better scaling (settlement load distributes to user demand as market count grows), demo robustness (the cron can crash and the system still works because any user can crank), and alignment with the Phoenix permissionless-crank philosophy (DR-001).

**Consequences:**
- Aria's `settle_market` must be safe under concurrent calls from arbitrary signers — no implicit "caller is admin" assumptions in the instruction.
- Bram's automation service no longer needs a privileged signer for settlement — just gas to call. Morning create-markets still needs admin authority (creation is privileged).
- Demo plan must include the **"cron failure" path**: intentionally kill the automation mid-settle, then trigger settle from a test user wallet. This is the load-bearing evidence that the choice was real, not theoretical.
- Future "settle bounty" (skimmed from settlement fee or admin-funded keeper budget) becomes a natural incentive feature — defer to post-MVP.
- A small class of bug exists where two callers race; on Solana this is benign (one tx wins, losers pay gas and fail). Acceptable.

**Alternatives considered:**
- **Off-chain-owned with admin-only settle:** rejected — creates a single point of failure for liveness, requires monitored hot wallet on mainnet, and the cron going down is a P0 incident rather than a degraded path.
- **No admin override at all:** rejected — Pyth can fail; we need a safety valve, and the time-delay design ensures it can't be abused for adversarial settlement.

---

### DR-003 — Use Pyth Network for stock-price oracle

**Date:** 2026-05-21
**Status:** Active
**Made by:** Cory (Tate) at Day-0 brainlift

**Context:** PRD requires an oracle with staleness + confidence checks, providing both previous-day close (for morning strike calc) and current-day close (for ~4:05pm settlement). Pyth and Switchboard are the two production-grade options on Solana. Pyth has direct US equities feeds (MAG7 included) with a native confidence-interval model; Switchboard is permissionless-feed-first and equity coverage is thinner.

**Decision:** **Pyth Network** for both pre-market reads (off-chain HTTP API) and on-chain settlement reads (program reads Pyth price account during `settle_market`).

**Trade-off:** We pay coupling to Pyth's feed availability and pricing model in exchange for: native equity coverage, native staleness + confidence semantics that map 1:1 to PRD requirements, mature Anchor SDK integration, and lower integration risk on the 3-day timeline.

**Consequences:**
- `settle_market` takes a Pyth price account as input; program validates feed ID matches the market's stock and that the price is recent + tight.
- Morning strike calc reads previous-day close via Pyth HTTP API (off-chain); Bram owns this integration.
- If Pyth has an outage at settlement: admin override path (DR-002) is the recovery, not "swap to Switchboard."
- We do not maintain a fallback oracle. If Pyth deprecates an equity feed, we lose that contract pair until we redeploy with a new feed ID.

**Alternatives considered:**
- **Switchboard:** rejected — thinner equity coverage; would require us to either set up a permissionless feed (extra ops surface) or accept partial coverage.
- **Roll our own admin-pushed price:** rejected — defeats the whole point of being non-custodial / oracle-driven. Reserved as the emergency fallback (admin override path) only.

---

> Aim for 5–15 active DRs over a project's life. Fewer and you're not
> locking enough; more and the file becomes unscannable (rotate stable
> ones into `specs/architecture.md` if they've become "just how the
> system works" rather than "a choice we made").

> **Citation format:** "per `constitution/decisions.md` DR-007"
