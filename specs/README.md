# BellMarkets — Specs

> What we're building. How it behaves. What's deferred and why.

This directory is the **design layer** of the project. `constitution/` names what we won't compromise; `specs/` describes the thing being built within those constraints.

## Files in this directory

| File | What it holds | When to update |
|---|---|---|
| [`architecture.md`](architecture.md) | System shape: 4 components (Anchor program, Automation service, Frontend, Quality/Demo harness), mermaid diagram, on-chain account schemas (Rust), off-chain type signatures (TypeScript), repo layout, deployment topology, verification approach, external dependency table (Phoenix, Pyth, Helius, Solana, GitHub/GitLab). | When architecture shifts — rare; weighty. Always update the mermaid diagram if a component boundary moves. |
| [`bell-markets-spec.md`](bell-markets-spec.md) | Behavior-level spec for the DeFi dApp shape: 6 user journeys (4 trade paths + settlement + redeem), daily lifecycle state machine, edge cases, non-goals. Ed-tech / API / agent / data-pipeline sections from the template have been deleted (don't apply). | When behavior changes; surface in MR description with the user-visible delta. |
| [`coordination.md`](coordination.md) | Workstream model: 4 named leads in Mode 2 worktrees + Tate Director. Lead identities, handoff discipline (per-session + daily-sync), cross-lead negotiation patterns (shared-file edits, decision changes, architecture changes, hard-rule additions, scope disputes, load-bearing instruction reviews). | When workstreams reshape — rare. The Drew promotion on Day 0 is the kind of change that lands here. |
| [`deferred.md`](deferred.md) | 7 explicit deferrals: custom CLOB, mainnet, fallback oracle, off-chain DB, mobile app, settle bounty, admin dashboard. Each with rationale, trade-off accepted, revisit threshold, re-evaluation owner. | Whenever a deferral is made; reference the DR-NNN in `constitution/decisions.md` that locked the decision. |

## How specs/ and constitution/ interact

- **constitution/** names locked rules and decisions (the rails).
- **specs/** names the system being built (the train running on the rails).
- If a spec needs something the constitution forbids, the spec changes — never weaken the constitution to fit a spec.

## How agents should cite this directory

```
> Implementing the Buy No atomic flow per specs/bell-markets-spec.md §3.2
> (one signed tx; mint_pair + sell_yes_on_phoenix bundled).

> Skipping Switchboard fallback per specs/deferred.md "Fallback oracle"
> (admin override is the intentional safety valve).

> Component boundary per specs/architecture.md §2.2 — automation
> service is stateless; no caching layer.
```

Specific citations beat vague references — make it grep-able.

## When to update each file

- **`architecture.md`** — when adding a major component, changing a data-flow boundary, or shifting deployment topology. Always update the mermaid diagram if a boundary moved.
- **`bell-markets-spec.md`** — whenever the behavior contract changes. This is the file partner reviews map against and graders read first.
- **`coordination.md`** — when adding a new lead, splitting a workstream, or shipping a new handoff pattern.
- **`deferred.md`** — whenever a feature/path is explicitly chosen NOT to build this cycle. Each entry must name the revisit threshold.

---

> **Template:** SDD v1 (from `claude-code-project-template` v0.3.0+)
> **Created:** 2026-05-21
