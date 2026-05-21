# BellMarkets — File Ownership

> Who owns what, and how shared-file edits get coordinated. Single source
> of truth for cross-lead conflict avoidance.

## Why this file exists

When multiple named leads work in parallel on the same project, they will
collide if file ownership isn't named in advance. This file is the rule
that the gauntlet-team-lead persona (`/tate`) enforces — refuse to
dispatch a teammate onto another teammate's owned territory without
explicit coordination.

This file complements `.project/bell-markets/in-flight.md` (which tracks
*active* work-in-progress collisions) by documenting the *baseline*
ownership map that doesn't change session-to-session.

---

## Lead workstream model

BellMarkets uses **Option C (named leads) with 4 leads** running in **Mode 2 (per-lead worktrees)**:

- **Aria** — Onchain (Solana / Anchor). Anchor program, oracle integration, Phoenix CLOB binding.
- **Bram** — Automation Service (Node / TypeScript). Daily lifecycle cron (morning create-markets, ~4:05pm settle nudger), off-chain Pyth reads.
- **Cleo** — Frontend (Next.js / React / TypeScript). Trade UI, wallet integration, real-time order book + portfolio views.
- **Drew** — Quality + Integration + Demo (cross-cutting). Full-lifecycle integration tests, property-based invariant evals, demo script + cron-failure path documentation.

**Tate** (`/tate`) is the persistent Director — operates from the main checkout on `main`, coordinates the four leads, owns the global handoff at `CLAUDE_SESSION_HANDOFF.md`.

The four leads work in sibling worktrees at `../BellMarkets-{aria,bram,cleo,drew}` on feature branches `crt/<name>-<phase>`, with `.project/` and `.claude/` junctioned back to the main checkout for shared coordination state. See `specs/coordination.md` §5 for the worktree pattern and `WORKTREE_PATTERNS.md` for the failure modes.

---

## File ownership map

### Aria — Onchain (Solana / Anchor)

**Owned (Aria edits without coordination):**
- `programs/**` — Anchor program: mint_pair, settle_market, admin_settle, redeem, create_strike_market, add_strike, pause, oracle integration, Phoenix CLOB binding
- `tests/contracts/**` — Anchor program unit tests + property-based invariant tests (Aria writes; Drew reviews cross-cutting coverage)
- `migrations/**` — Anchor deploy migrations
- `Anchor.toml`, `Cargo.toml`, `Cargo.lock`

**Shared (Aria edits after announcing in `.project/bell-markets/coordination/`):**
- `scripts/devnet-deploy.sh` (when it exists) — shared with Drew (Drew orchestrates the one-command demo around it)

**Off-limits (Aria does not edit):**
- `services/**`, `apps/**`, `packages/ui/**`, `tests/automation/**`, `tests/frontend/**`, `tests/integration/**`, `tests/eval/**`
- `BRAINLIFT.md`, `constitution/**`, `specs/**`, `CLAUDE_SESSION_HANDOFF.md`, `README.md`

---

### Bram — Automation Service (Node / TypeScript)

**Owned:**
- `services/automation/**` — morning create-markets job (~8am ET), settlement nudger (~4:05pm ET), retry+backoff, alerting
- `services/oracle-adapter/**` — off-chain Pyth HTTP reads for previous-close strike calculation
- `tests/automation/**` — service unit tests

**Shared:**
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (root) — shared with Cleo (frontend) and Drew (test infra). Coordinate via `.project/bell-markets/coordination/monorepo-config.md`.

**Off-limits:**
- `programs/**`, `Anchor.toml`, `Cargo.*` (Aria)
- `apps/**`, `packages/ui/**`, `tests/frontend/**` (Cleo)
- `tests/integration/**`, `tests/eval/**`, `docs/demo/**`, `scripts/one-command-demo.sh` (Drew)
- `BRAINLIFT.md`, `constitution/**`, `specs/**`, `CLAUDE_SESSION_HANDOFF.md`, `README.md`

---

### Cleo — Frontend (Next.js / React / TypeScript)

**Owned:**
- `apps/web/**` — Next.js app: Landing, Markets, Trade/[ticker]/[strike], Portfolio, History pages. Wallet integration via `@solana/wallet-adapter-react`. Order book UI with Yes+No perspectives. Position-aware trade panel (POV-3). Redeem flow. WebSocket subscriptions for real-time book + portfolio updates.
- `packages/ui/**` — shared React components (shadcn/ui-based)
- `tests/frontend/**` — component unit tests

**Shared:**
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (root) — shared with Bram and Drew
- `scripts/one-command-demo.sh` (read-only for Cleo unless adding a frontend-launch step — coordinate with Drew first)

**Off-limits:**
- `programs/**`, `Anchor.toml`, `Cargo.*` (Aria)
- `services/**`, `tests/automation/**` (Bram)
- `tests/integration/**`, `tests/eval/**`, `docs/demo/**` (Drew)
- `BRAINLIFT.md`, `constitution/**`, `specs/**`, `CLAUDE_SESSION_HANDOFF.md`, `README.md`

---

### Drew — Quality + Integration + Demo (cross-cutting)

**Owned:**
- `tests/integration/**` — full-lifecycle tests on Solana devnet (create → mint → trade → settle → redeem)
- `tests/eval/**` — property-based invariant tests, oracle-failure scenarios, the $1 USDC invariant proof set, meta-tests (deliberate-fixture-breaks that prove the rubric works)
- `docs/demo/**` — demo script, screen recording assets, cron-failure path documentation
- `scripts/one-command-demo.sh` — the PRD's reproducible lifecycle path

**Shared:**
- `README.md` — co-owned with Tate. Drew owns the "how to run the demo" section as the lifecycle stabilizes. Announce in `.project/bell-markets/coordination/readme.md` before editing.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (root) — shared with Bram and Cleo (Drew adds test runner config)
- `scripts/devnet-deploy.sh` — shared with Aria

**Off-limits:**
- `programs/**`, `Anchor.toml`, `Cargo.*` (Aria) — Drew READS to understand what to test, but RAISES if a test needs a program-level change.
- `services/**` (Bram) — same.
- `apps/**`, `packages/ui/**` (Cleo) — same.
- `BRAINLIFT.md`, `constitution/**`, `specs/**`, `CLAUDE_SESSION_HANDOFF.md` (Tate) — Drew reads, raises issues, never edits. Specifically: if a property test reveals that a Hard YES is unenforceable as written, Drew RAISES; does not modify the constitution.

---

### Tate — Director (main checkout)

**Owned:**
- `BRAINLIFT.md`
- `constitution/**` — hard-rules.md, decisions.md, file-ownership.md (this file), README.md
- `specs/**` — architecture.md, bell-markets-spec.md, coordination.md, deferred.md, README.md
- `CLAUDE_SESSION_HANDOFF.md`
- `.project/bell-markets/in-flight.md`
- `.project/bell-markets/kickoff/**` — lead boot prompts
- `.project/bell-markets/sessions/**` — session recaps
- `.project/bell-markets/candidates/**`, `.project/bell-markets/stories/**`

**Shared:**
- `README.md` (repo root) — primary owner; Drew co-owns the "how to run the demo" section
- `scripts/setup-worktrees.sh`, `scripts/setup-onedrive-mirror.sh`, `scripts/lead-launchers.*`, `scripts/install-recommended-skills.*` — Tate edits when new leads are added or worktree layout changes

**Off-limits:**
- Code under `programs/`, `services/`, `apps/`, `packages/`, `tests/` — Tate dispatches leads; doesn't edit code directly except for cross-cutting refactors that all leads have signed off on (rare).

---

## Shared-file coordination protocol

For files in any lead's "Shared" list:

1. **Announce intent.** Before editing, write a 1-line note in
   `.project/bell-markets/coordination/<file-slug>.md`:
   > "Drew taking `README.md` 2026-05-22 14:00 to add demo section. ETA 30 min."
2. **Check for conflicts.** Read existing notes. If another lead is working on it, wait or negotiate scope.
3. **Edit, commit, clear.** Make your edits, push, then delete or strike-through your coordination note.
4. **No silent edits to shared files.** Reviewers can ask you to revert + re-do with proper coordination if you forgot.

For files in any lead's "Off-limits" list:

1. **Stop.** Don't edit.
2. **Negotiate.** Open a thread in `.project/bell-markets/coordination/cross-lead-<topic>.md`.
3. **Decide together.** Either the owner takes the change, or ownership gets renegotiated (update this file via MR).

---

## How `/tate` enforces this

When a teammate dispatch is requested, `/tate` checks:

- Does the dispatch's prompted edits cross any lead's "Off-limits" boundary?
  → **Refuse.** Explain which boundary. Suggest negotiation.
- Are there any unresolved `.project/bell-markets/coordination/` notes touching the same files?
  → **Defer** until those resolve.
- Is the dispatch implicit-multi-lead (touches two leads' owned dirs)?
  → **Require explicit acknowledgement** of both leads before dispatching.
- Does the dispatch touch a load-bearing instruction (`settle_market`, `mint_pair`, `redeem`) or the Buy-No / Sell-No frontend path?
  → **Require Drew's review** before merge (Hard YES #1, Hard YES #5, POV-3).

---

## Updating this file

Changes here are weighty — they reshape who can move on what. Update via:

1. Open a thread in `.project/bell-markets/coordination/file-ownership-change.md` describing the proposed change.
2. Get acknowledgement from every affected lead.
3. Land via MR. Tag it `ownership-change` so reviewers read carefully.
4. Sync `.project/bell-markets/in-flight.md` file-ownership table in the same PR.

---

> **Template:** SDD v1 (from `claude-code-project-template` v0.3.0+)
> **Created:** 2026-05-21
