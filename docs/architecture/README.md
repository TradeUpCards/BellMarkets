# BellMarkets — Architecture-as-Code (LikeC4)

This directory holds the canonical structural + temporal + topological
description of the BellMarkets system, authored in
[LikeC4](https://github.com/likec4/likec4). It supersedes the static
Mermaid diagram in `ARCHITECTURE.md` whenever they disagree.

## File layout

| File | Lines | Purpose |
|---|---|---|
| `bell-markets.c4` | ~1,200 | Specification + structural model (actors, externals, BellMarkets system, 4 containers, ~40 components, ~50 relationships) + 13 structural views |
| `dynamics.c4` | ~300 | 7 temporal narratives (daily lifecycle, permissionless settle, atomic Buy No, mint pair, admin override, retry harness, subscription flow) |
| `deployment.c4` | ~210 | 7 deployment nodes (Solana devnet, Trigger.dev, Helius, Pyth Hermes, Vercel, dev machine, trader browser) + 2 topology views |

LikeC4 merges all `.c4` files in this directory into one model at parse
time. Splitting is for human navigation, not the tool.

## Quick view (zero install)

Paste the file contents into the LikeC4 playground:

> https://playground.likec4.dev

## Local viewing (recommended)

From the repo root:

```bash
npx likec4@1.30 start docs/architecture
```

Starts a dev server (port picked at random, e.g. `http://localhost:62002`).
Hot-reloads on any `.c4` file edit. Pinned to v1.30 because latest LikeC4
needs Node ≥ 20.19 / ≥ 22.12 and this repo's Node is v20.10.

To upgrade Node later:
```bash
# Windows
nvm install 22 && nvm use 22

# WSL Ubuntu
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install nodejs
```

`npx` downloads LikeC4 on demand. No `package.json` commitment.

## All 15 views in this model

Open `index` first; the others are accessed via the sidebar dropdown.

### Structural (13 views)

| # | View | Audience | What it shows |
|---|---|---|---|
| 1 | `index` | First-time reader / interview panel | The 10,000ft picture: BellMarkets in its ecosystem |
| 2 | `containers` | Engineering reviewer | The 4 internal containers + on-chain data stores |
| 3 | `program` | Smart-contract reviewer | All 10 instructions, color-coded permissionless vs admin-only vs deferred |
| 4 | `automation` | Off-chain reviewer | Bram's morning + settlement jobs + retry harness |
| 5 | `frontend` | UX/frontend reviewer | Cleo's 6 hooks + 7 tx builders + wallet boundary |
| 6 | `quality` | QA reviewer | Drew's simulation + edge cases + cron-failure demo |
| 7 | `pov3` | Architecture deep-dive | The atomic Buy No / Sell No commitment |
| 8 | `permissionless` | Architecture deep-dive | Everything any signer can call (DR-002) |
| 9 | `adminOnly` | Architecture deep-dive | The 4 authority boundaries (deliberately tiny) |
| 10 | `aria` | Lead orientation | Aria's owned surface (program + adapters + data stores) |
| 11 | `bram` | Lead orientation | Bram's service + cron + retry |
| 12 | `cleo` | Lead orientation | Cleo's hooks + builders + wallet integration |
| 13 | `drew` | Lead orientation | Drew's quality + demo layer |

### Dynamic (7 narratives)

| # | View | What it walks through |
|---|---|---|
| D1 | `dailyLifecycle` | 8 AM cron → morning markets → trades all day → 4 PM Pyth → 4:05 PM settle → redeems. ~31 steps. **The primary interview narrative.** |
| D2 | `permissionlessSettle` | 4:05 PM cron fails → cranker steps in → settle completes. DR-002 / HY-5 in action |
| D3 | `atomicBuyNo` | Trader clicks Buy No → one signature → 2-ix atomic tx → user holds NO at (1 - YES price). POV-3 |
| D4 | `mintPairInvariant` | The $1 USDC invariant primitive (HY-1). How vault USDC == pairs_outstanding × $1 is enforced |
| D5 | `adminOverrideSafety` | Pyth confidence wide → settle keeps failing → 1-hour delay expires → admin can override → traders redeem refunds |
| D6 | `retryHarness` | PRD 30s × 15min retry policy. Why we don't use Trigger.dev job-level retry |
| D7 | `subscriptionFlow` | HY-9: no polling. WebSocket onAccountChange → TanStack Query → React re-render |

### Topology (2 views)

| # | View | What it shows |
|---|---|---|
| T1 | `deployment` | Where each piece physically runs (Solana devnet, Trigger.dev cloud, Helius, Pyth Hermes, Vercel-planned, dev machine, trader browser) |
| T2 | `trustBoundaries` | The non-custodial enforcement story. What touches whose keys |

## How to use this for interview defense

Open the LikeC4 dev server. Walk through these views in order:

1. **`index`** — 30-second elevator pitch ("here's where BellMarkets sits")
2. **`containers`** — 1-min team structure ("4 workstreams, separation of concerns")
3. **`dailyLifecycle` (dynamic)** — 2-min narrative ("what happens in one trading day")
4. **`permissionlessSettle` (dynamic)** — 1-min architectural commitment ("here's why automation isn't authority — DR-002")
5. **`atomicBuyNo` (dynamic)** — 1-min UX defense ("here's why Sell No is one signature, not two — POV-3")
6. **`mintPairInvariant` (dynamic)** — 30-sec primitive defense ("the $1 invariant is enforced on-chain, not in a backend")
7. Drill into any of the per-lead views if asked about specifics

Total runtime: ~6-8 minutes for a strong architecture walkthrough.

## Generate static output (for submission / sharing)

```bash
# Self-contained interactive site (validated working on this repo)
npx likec4@1.30 build docs/architecture --output dist/architecture
cd dist/architecture && python -m http.server 8000

# Or deploy to Vercel:
#   vercel --prod dist/architecture
```

The static site is fully interactive — drill, pan, zoom, click for
descriptions. Deployable to any static host.

## Editing in VS Code / Cursor

Install the LikeC4 extension (Marketplace + Open VSX): `likec4.likec4-vscode`.

You get:
- Syntax highlighting
- Autocomplete on element + relationship names
- Side-by-side live preview
- Jump-to-definition

## Element tags reference

Every key element carries tags that drive styling and enable per-concern
views:

| Tag | Color | Meaning |
|---|---|---|
| `aria` | indigo | Onchain workstream |
| `bram` | amber | Automation workstream |
| `cleo` | sky | Frontend workstream |
| `drew` | green | Quality workstream |
| `permissionless` | solid border | Any signer (DR-002) |
| `admin-only` | dashed border | Platform admin keypair required |
| `deferred` | dotted muted | Planned but not shipped |
| `external` | muted | Third-party (Solana, Pyth, Phoenix, Helius, etc.) |
| `pov-N`, `hy-N`, `dr-NNN` | n/a | Cross-reference to architectural commitments |

## How this differs from `ARCHITECTURE.md`

| Doc | Purpose | Owns |
|---|---|---|
| `ARCHITECTURE.md` (repo root) | Decision-record / Spiky POV rationale | The *why* |
| `docs/architecture/*.c4` | Element relationships + temporal flows + topology | The *what* and *how* |
| `docs/TIMELINE.md` | Per-lead Day-1/2/3 schedule | The *when* (calendar time) |
| `constitution/decisions.md` | Locked DR-NNN entries | The *what we agreed to* (formal) |

When two disagree:
- For "is this element connected to that one?" → the `.c4` model wins
- For "why did we choose this approach?" → `ARCHITECTURE.md` / `constitution/decisions.md` wins
- Update both when architecture meaningfully changes

## Maintenance

- New component lands → add to model + relevant view
- Relationship rewires → update the relationship statement
- New architectural decision → add tag + view + cross-reference (`#dr-NNN`)
- Deferred ships → remove `#deferred` tag
- Workstream renames → search-replace tag

The model files are pure text. Diff cleanly. Review-friendly.

## What this is NOT

- **Not runtime introspection.** LikeC4 doesn't read code. It reads our
  description of code. Drift detection is human responsibility.
- **Not a threat model.** Trust boundaries are sketched in
  `trustBoundaries` but full threat modeling lives in the
  constitution + handoffs.
- **Not a sequence diagram.** Dynamic views show ordered steps but
  don't render lifelines. For sequence diagrams use Mermaid in markdown.
