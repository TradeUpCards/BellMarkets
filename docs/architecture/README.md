# BellMarkets — Architecture (LikeC4)

This directory holds the **architecture-as-code** model of BellMarkets,
authored in [LikeC4](https://github.com/likec4/likec4). It is the canonical
"how the pieces talk to each other" reference — superseding the static
Mermaid diagram in `ARCHITECTURE.md` if/when they diverge.

## Files

- `bell-markets.c4` — single-file model. Captures actors, external systems,
  the BellMarkets system, its 4 containers, their components, data stores,
  and relationships. Defines 5 views (context, containers, program,
  automation, frontend) + quality.
- This README.

## Quick view (zero install)

The fastest way to see it is the LikeC4 playground (paste the .c4 contents):

> https://playground.likec4.dev

## Local viewing

From repo root:

```bash
npx likec4@1.30 start docs/architecture
```

This starts a local web server (default `http://localhost:5173`) with an
interactive diagram explorer. Hot-reloads on `.c4` file edits.

**Pinned to v1.30.** Latest LikeC4 requires Node ≥ 20.19.0 or ≥ 22.12.0.
This repo's local Node is v20.10.0 (Windows) / v18.19.1 (WSL), both too
old for the cutting-edge release. v1.30 has the same DSL and works fine.
Bump the pin when you upgrade Node.

To upgrade Node later:
```bash
# Windows (via nvm-windows)
nvm install 22 && nvm use 22

# WSL Ubuntu
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install nodejs
```

Note: `npx` downloads LikeC4 on demand — no addition to `package.json`,
no commitment to the dep tree. If you want it persistently installed,
add it under `devDependencies` later.

## Generate static output

```bash
# Export views as PNG/SVG to ./dist/ (requires Graphviz `dot` on PATH for PNG)
npx likec4@1.30 export png docs/architecture --output dist/architecture
npx likec4@1.30 export svg docs/architecture --output dist/architecture

# Or build a static interactive site (no Graphviz needed)
npx likec4@1.30 build docs/architecture --output dist/architecture-site
# Then: cd dist/architecture-site && python -m http.server 8000
```

`build` is the cleanest output — produces a self-contained interactive
explorer that opens cleanly in any browser. Validated working on this
repo's Node v20.10.0.

The static site is deployable to Vercel / GitHub Pages if you want a
permanent shareable architecture viewer (e.g., link it from `README.md`
or include it in the interview submission packet).

## Views shipped in this model

| View | Audience | What it shows |
|---|---|---|
| `index` | Interview panel / first-time reader | BellMarkets in its ecosystem (Solana, Pyth, Phoenix, Circle, Trigger.dev, Helius) + the 3 actor types (Trader, Admin, Anyone-cranker) |
| `containers` | Engineering reviewer | The 4 internal containers (program, automation, frontend, quality) + on-chain data stores |
| `program` | Smart-contract reviewer | 9 shipped instructions + 1 deferred (`redeem_pair`). Color-coded permissionless (green) vs admin-only (amber) vs deferred (muted) |
| `automation` | Off-chain reviewer | Morning + settlement jobs, retry harness, Pyth/Helius clients |
| `frontend` | UX/frontend reviewer | Hooks + tx builders + wallet adapter integration |
| `quality` | QA reviewer | Drew's simulation + edge-case tests |

## Editing in VS Code / Cursor

Install the LikeC4 extension:
- VS Code Marketplace: `likec4.likec4-vscode`
- Open VSX (Cursor): same package name

You get syntax highlighting, autocomplete on element/relationship names, and a
side-by-side live preview.

## How this differs from `ARCHITECTURE.md`

- **`ARCHITECTURE.md`** (in repo root) is the *decision-record + summary*
  format from `/presearch-interview`. It captures *why* — Spiky POVs,
  Decision Records, trade-offs.
- **`docs/architecture/bell-markets.c4`** is the *structural map*. It
  captures *what connects to what*. Both are useful; neither replaces the
  other.

If the two diverge: the `.c4` model wins for "what's actually wired up,"
and `ARCHITECTURE.md` wins for "why we chose this." Update both when the
architecture meaningfully changes.

## Maintenance

- Update when a new component lands (e.g., when `redeem_pair` ships, remove
  its `#deferred` tag).
- Update when a relationship changes (e.g., if we add a Squads multisig
  layer between admin and program).
- Update when an external dependency rotates (e.g., if we move off
  Trigger.dev).
- Keep relationship descriptions concise — they appear as edge labels.

## What this is NOT

- Not a runtime introspection tool — LikeC4 doesn't read the code. It reads
  *our description of the code*. If the description drifts from reality,
  fix the description.
- Not a security model. Threat modeling, attack surfaces, and key-rotation
  procedures live elsewhere (constitution + handoffs).
- Not a sequence diagram. LikeC4 shows *structure*, not *temporal flow*.
  For the daily lifecycle in time order, see `docs/TIMELINE.md` (Gantt) and
  `ARCHITECTURE.md` §System Shape.
