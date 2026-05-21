# BellMarkets — Hard Rules

> Non-negotiables. Banned behaviors, banned dependencies, banned
> patterns. AI coding assistants must refuse work that violates these.
>
> Sourced from `BRAINLIFT.md` §4 (Hard NOs + Hard YESes) — kept in sync.
> Citation format: "per `constitution/hard-rules.md` §3.1"

Each rule has:
- **Number** — for grep-able citations
- **Rule** — what's banned or required, stated as imperative
- **Rationale** — why
- **Enforcement** — how the rule is policed (CI gate / human review / honor + audit)

---

## 1. Security & Custody

### §1.1 Never use mainnet or real funds for the core submission
**Rationale:** PRD hard rule. The submission is a devnet-only demonstration. Real funds introduce regulatory, custody, and irreversible-loss risk we are not equipped to handle on a 3-day build window. Mainnet deployment is a documented stretch goal — post-demo only.
**Enforcement:** Human review (Tate + Drew refuse PRs targeting mainnet for the core submission). `Anchor.toml` `[programs.mainnet]` block must remain empty/absent until post-demo. Deploy scripts hard-code `--provider.cluster devnet` for the demo path. Cross-references BRAINLIFT.md Hard NO #1.

### §1.2 Never commit secrets, private keys, wallet mnemonics, API keys, or RPC keys
**Rationale:** A leaked key on devnet is a contained embarrassment; the same leak on mainnet (during the stretch phase) is a real-money exposure. The discipline must hold uniformly so it's never compromised under time pressure.
**Enforcement:** `.gitignore` excludes `.env` and `.env.*` (with `!.env.example` exception). Pre-commit secrets scan via gitleaks recommended once `pnpm install` runs. Human review on every PR. Cross-references BRAINLIFT.md Hard NO #2.

### §1.3 Frontend uses `@solana/wallet-adapter-react` for all signing — never sees a private key
**Rationale:** The standard library asks the user's installed wallet to sign; the frontend never holds key material. Any other path (in-app keystore, env-var private key for "test flows," paste-a-mnemonic input) is a credential-exposure footgun that has no place in a non-custodial dApp.
**Enforcement:** Human review on any `apps/web/lib/solana/` PR. No env vars named `*PRIVATE*` or `*MNEMONIC*` in the frontend bundle. Cross-references BRAINLIFT.md Hard YES #10.

### §1.4 Never `git push --force` to `main` without explicit user request
**Rationale:** Force-pushing rewrites history visible to graders, partner reviewers, and other team machines. Surprise rewrites are a recovery nightmare.
**Enforcement:** GitLab branch protection on `main` blocks force-push by default. The `glab api allow_force_push` recipe in `CLAUDE_SESSION_HANDOFF.md` is the documented exception path; must be flipped back to `false` after. Cross-references BRAINLIFT.md Hard NO #10.

---

## 2. Privacy & Logging Hygiene

### §2.1 Never dump raw oracle, RPC, or wallet logs (>20 lines) into handoffs, session recaps, or commit messages
**Rationale:** Logs at scale pollute the AI context window, surface real account addresses on devnet (and would surface real holdings on mainnet), and noise out the signal. Summary > dump.
**Enforcement:** Human review on every handoff + session recap. The session-handoff skill enforces "no log dumps." If a log is needed for diagnosis, summarize + cite the rerun command. Cross-references BRAINLIFT.md Hard NO #11.

### §2.2 Never use live stock prices in unit or integration tests
**Rationale:** Live oracle reads make tests time-dependent (market hours, weekends, holidays), flaky (Pyth confidence varies), and unreproducible. Synthetic / mocked Pyth feeds give deterministic test fixtures.
**Enforcement:** Test code imports a mock Pyth client by default; live reads are gated behind an explicit `LIVE_ORACLE=1` env flag. CI runs without that flag set. Drew owns the mock fixture infrastructure. Cross-references BRAINLIFT.md Hard NO #12.

---

## 3. Scope

### §3.1 Out of scope: KYC, custody, off-ramp
**Rationale:** PRD requires non-custodial design. Adding KYC/custody/off-ramp inverts the entire architectural posture and is far outside the cohort scope.
**Enforcement:** Human review. No PRs introducing identity verification, user-account schemas, or fiat off-ramp integrations. Cross-references BRAINLIFT.md §1 "Out of scope."

### §3.2 Out of scope: non-MAG7 stocks, margin, perpetuals, cross-strike netting
**Rationale:** v1 scope is exactly the 7 MAG7 tickers and binary same-day expiry. Other instruments invalidate the $1 USDC invariant model and balloon the on-chain surface.
**Enforcement:** Human review on `programs/bell-markets/src/state/` (ticker enum is fixed at 7 values). Cross-references BRAINLIFT.md §1 "Out of scope."

### §3.3 No persistent off-chain database for the core submission
**Rationale:** Solana RPC + on-chain state is the source of truth. Adding a database creates a sync surface that can drift from on-chain reality, undermines the non-custodial story, and is an operational burden the 3-day budget doesn't have.
**Enforcement:** Human review on `services/automation/` — service must be stateless. Any caching layer must be ephemeral (process-local or Redis-with-TTL); never the source of truth.

---

## 4. Code Quality & Architectural Invariants

### §4.1 Never write an on-chain matching engine
**Rationale:** Phoenix is the integrated CLOB per DR-001. Adding price-time-priority code inside the Anchor program duplicates audited logic, expands the bug surface, and contradicts the explicit architectural commitment.
**Enforcement:** Drew + Tate refuse PRs that add ordering, matching, partial-fill, or self-trade-prevention code inside `programs/`. Cross-references `constitution/decisions.md` DR-001 and BRAINLIFT.md Hard NO #4 + POV-1.

### §4.2 Never give `settle_market` a special-signer requirement
**Rationale:** Permissionless settle is the load-bearing design commitment from DR-002. Adding a signer check would convert the convenience-caller automation into an authority, eliminate the cron-failure recovery path, and break the demo's defensibility narrative.
**Enforcement:** Drew tests this with a unit test that calls `settle_market` from an arbitrary unfunded keypair and asserts success (given valid time + Pyth conditions). The negative test fails if any signer assertion creeps in. Cross-references DR-002 and BRAINLIFT.md Hard NO #5 + POV-2 + Hard YES #5.

### §4.3 Never add a fallback oracle
**Rationale:** Per DR-003, Pyth is the only oracle. The admin time-delayed override (DR-002 / §4.4) is the recovery path. Importing Switchboard "just in case" doubles the integration surface for a vanishingly rare failure mode.
**Enforcement:** Human review. `Cargo.toml` dependency review — Switchboard or other oracle SDKs must be rejected. Cross-references DR-003 and BRAINLIFT.md Hard NO #6.

### §4.4 `settle_market` validates Pyth staleness AND confidence; outcome is immutable once written
**Rationale:** Both checks are PRD-mandated. Staleness alone permits stale-but-confident bad reads; confidence alone permits fresh-but-wide bad reads. Together they form the safety boundary that admin override exists to backstop. Immutability prevents settlement re-litigation under social pressure.
**Enforcement:** Property-based test that injects (stale-fresh × wide-tight × admin-call × non-admin-call) and asserts the program rejects all states where outcome would be written from bad data. Drew writes this. Cross-references BRAINLIFT.md Hard YES #6.

### §4.5 `admin_settle` has an on-chain time-delay gate (≥1hr after settlement window opens)
**Rationale:** Admin override is a safety valve, not a fast path. The on-chain delay prevents adversarial-admin behavior (settling earlier than oracle would have, with a self-favorable price) and forces social pressure to confirm Pyth is genuinely failing.
**Enforcement:** Unit test asserts `admin_settle` rejects calls before `settlement_window + 1h`. Property test fuzzes time inputs. Cross-references BRAINLIFT.md Hard YES #7.

### §4.6 Never violate the $1 USDC invariant
**Rationale:** This is THE load-bearing invariant. `yes_payout + no_payout = $1.00` exactly, for every contract, at every settle, in every market. Fees, if added later, go to a separate account — never skimmed from payouts. Violating this breaks the entire product premise.
**Enforcement:** Property-based test sweeps all (price × strike × outcome × pairs-outstanding) tuples and asserts the invariant holds post-settle. Drew owns the proof set. The test is the gate. Cross-references BRAINLIFT.md Hard NO #8 + Hard YES #1.

### §4.7 Never leak the mint-and-sell mechanic to the trade UI
**Rationale:** POV-3: Buy No / Sell No are first-class atomic single-transaction operations from the user's perspective. Exposing the steps (separate "mint pair" + "sell yes" buttons, or visible Yes balances during a Buy-No flow) breaks the UX abstraction we explicitly chose to pay for.
**Enforcement:** Cleo reviews all `apps/web/lib/solana/buy-no.ts` (+ `sell-no.ts`) PRs for: (a) one signed transaction per user click, (b) no intermediate Yes balance displayed, (c) position-aware button states. Cross-references BRAINLIFT.md POV-3 + Hard NO #7.

### §4.8 Order book + portfolio views use WebSocket subscriptions, never polling
**Rationale:** Polling at scale exhausts Helius rate limits, looks laggy in the demo, and ages poorly for the "production-ready" interview narrative. Subscriptions scale linearly with users.
**Enforcement:** Cleo refuses PRs containing `setInterval` or recursive `setTimeout` for state refresh on the Trade or Portfolio pages. Use `connection.onAccountChange` with proper cleanup. Cross-references BRAINLIFT.md Hard YES #9.

### §4.9 Audit subagents use a different model than the code-writing agent
**Rationale:** Bias diversification — a model that wrote code has the writer's perspective and is more likely to defend it than challenge it. A different-model audit catches independent classes of issues.
**Enforcement:** Drew's operating discipline (`.project/bell-markets/kickoff/drew.md`). Audit reports name the model used. Default: Opus-written → Sonnet audit. Generic `quality-lead` agent type defaults to Sonnet exactly for this reason. Deterministic test execution (e.g., `anchor test`) needs no model and is exempt.

---

## 5. Deploy & Operations

### §5.1 The full lifecycle is demoable end-to-end on devnet with one command
**Rationale:** PRD requires "one-command setup." The demo's defensibility depends on a reviewer being able to reproduce `create → mint → trade → settle → redeem` without coaching.
**Enforcement:** Drew owns `scripts/one-command-demo.sh` and a corresponding integration test that runs it against a fresh devnet deploy. CI runs the test (or a subset) every PR. Cross-references BRAINLIFT.md Hard YES #2.

### §5.2 The demo includes the cron-failure path
**Rationale:** Without it, DR-002's permissionless-settle commitment is theoretical. Killing automation mid-settle and having a test user wallet trigger settle is the load-bearing evidence that the architecture is real.
**Enforcement:** Drew owns the demo step + `docs/demo/cron-failure-script.md`. Run by Tate in the demo dry-run before submission. Cross-references DR-002 and BRAINLIFT.md Hard YES #5.

### §5.3 Every PR runs `anchor test` + `pnpm test` + `pnpm typecheck` + `pnpm lint` — CI fails the merge if any fail
**Rationale:** Multi-language, multi-package monorepo with three workstreams editing in parallel. The CI gate is the only thing keeping inadvertent regressions out of `main`.
**Enforcement:** GitLab CI pipeline. Drew + Tate review the gate config; weakening it requires a new DR. Cross-references BRAINLIFT.md Hard YES #4.

### §5.4 Always use `pnpm` — never `npm`, never `yarn`
**Rationale:** Lockfile consistency. Mixed package managers produce drifting lockfiles, divergent dep resolution, and irreproducible builds across machines.
**Enforcement:** `package.json` includes `"packageManager": "pnpm@<version>"` and an `engines` block. CI uses pnpm exclusively. Any `package-lock.json` or `yarn.lock` that appears in a PR is removed. Cross-references BRAINLIFT.md Hard NO #3 + Hard YES #3.

---

## 6. Data & Identification

### §6.1 Position-exclusivity is a frontend guardrail, not an on-chain invariant
**Rationale:** Per PRD: a user shouldn't hold both Yes and No tokens for the same strike from trading. The frontend prevents this by guiding the user to close their existing position first. Putting this on-chain would add compute cost and bug surface for a benign edge case (holding both = $1 redeemable USDC, harmless).
**Enforcement:** Cleo's Trade page implements position-aware button states. Drew's integration test verifies the UI prevents the disallowed transition; no on-chain test asserts the invariant because it's intentionally not enforced on-chain. Cross-references BRAINLIFT.md Hard YES #8.

### §6.2 `.project/` and `.claude/` are never committed to git
**Rationale:** Coordination state (kickoffs, in-flight, handoffs, candidates, agent personas, slash-command skills) is local-only / OneDrive-mirrored. Committing it exposes internal team workflow and pollutes the cohort-visible repo.
**Enforcement:** `.gitignore` excludes `/.project/` and `/.claude/`. `git check-ignore` confirms on every commit. If anything from these paths ever appears in a staged change, the commit is rejected and the gitignore is fixed. Cross-references BRAINLIFT.md Hard NO #9.

### §6.3 Every Spiky POV has a Decision Record in `constitution/decisions.md`
**Rationale:** A POV without a DR is a preference, not an architecture commitment. The DR is where the trade-off line lives — and the trade-off is what makes the POV defensible to a hostile reviewer.
**Enforcement:** Tate refuses to add a POV to BRAINLIFT.md without a paired DR. Drew flags missing DRs during cross-cutting review. Cross-references BRAINLIFT.md Hard YES #11.

---

> Add more sections as the project surfaces new constraint classes.
> Each new section gets a top-level number; each rule inside gets a sub-number.
> Don't renumber existing rules — citations break. Mark deprecated rules
> with `**Status: DEPRECATED (date)** — superseded by §X.Y`.

> **Update protocol:** edit via MR. PRs that add a rule should link to the
> trigger (security finding, regulatory ask, partner requirement, real bug)
> in the MR description. Sync BRAINLIFT.md §4 in the same PR.

> **Citation format:** "per `constitution/hard-rules.md` §3.1"
> **Source-of-truth pairing:** BRAINLIFT.md §4 ↔ this file. Out-of-sync = bug.

> **Template:** SDD v1 (from `claude-code-project-template` v0.3.0+)
> **Created:** 2026-05-21
