# BellMarkets — Constitution

> **Locked rules and architectural decisions.** Changes here go through MR review. AI coding assistants and human contributors both treat these files as authoritative.

This directory is the **load-bearing rules layer** of the project. If something here conflicts with code, the code is wrong, not these files.

## Files in this directory

| File | What it holds | Update via |
|---|---|---|
| [`hard-rules.md`](hard-rules.md) | Non-negotiables across 6 categories: Security & Custody, Privacy & Logging, Scope, Code Quality & Architectural Invariants, Deploy & Operations, Data & Identification. 22 rules; each cites the source BRAINLIFT.md §4 Hard NO/YES it enforces and the DR it derives from. | MR review |
| [`decisions.md`](decisions.md) | Locked architectural decisions. Currently: DR-001 (Phoenix CLOB integration), DR-002 (permissionless `settle_market`), DR-003 (Pyth oracle). Each entry names the trade-off it accepts + alternatives considered. | MR with `decisions:` label |
| [`file-ownership.md`](file-ownership.md) | Workstream model + per-lead file ownership (Tate / Aria / Bram / Cleo / Drew) + shared-file coordination protocol. Source for `.project/bell-markets/in-flight.md` ownership table. | Lead negotiation thread in `.project/bell-markets/coordination/`, then MR labeled `ownership-change` |

## Pairing with BRAINLIFT.md

This directory and `BRAINLIFT.md` (at repo root) hold the same locked content in two shapes:

- **`BRAINLIFT.md`** — 1-page constitution. Quick-scan source of truth. The file AI coding assistants read at session start. 147 lines.
- **`constitution/`** — directory-based SDD. Long-form parallel. Each file is the full version of a section of the brainlift, with cross-references and enforcement details.

The user picked **"Both from day one"** during `/use-template` (not the migration path). Brainlift is the 1-pager that leads scan first; constitution is what they cite when they need the rule's full enforcement context.

**Sync rule:** if you change a Hard NO or Hard YES in BRAINLIFT.md, mirror the change in `hard-rules.md` in the same PR. Out-of-sync = bug.

## How agents should cite this directory

When making a decision that depends on a rule, cite the source:

```
> Skipping in-app keystore per constitution/hard-rules.md §1.3
> (Security & Custody — frontend uses wallet adapter only). Using
> @solana/wallet-adapter-react instead.

> Choosing Phoenix integration over custom matcher per
> constitution/decisions.md DR-001 (3-day budget; audited logic).

> README.md is shared between Tate and Drew per
> constitution/file-ownership.md (Drew owns the "how to run the
> demo" section).
```

Specific citations beat vague references — make it grep-able.

## When constitution/ disagrees with specs/

`constitution/` wins. The spec describes what we're building; the constitution names what we won't compromise. If the spec needs something the constitution forbids, the spec changes, not the constitution.

## When constitution/ disagrees with BRAINLIFT.md

They should never disagree (sync rule above). If they do, BRAINLIFT.md is the AI-readable 1-pager that everyone scans first, so the constitution loses by precedence — but the contradiction is a bug that gets reconciled in the next PR, not papered over.

## When to update each file

- **`hard-rules.md`** — when discovering a new constraint that should be enforced project-wide. Rare and weighty edits. Add the rule, cite the trigger in the MR.
- **`decisions.md`** — when locking a new architectural decision OR superseding an existing one. Add a DR-NNN entry; never delete old entries (mark `Status: Superseded by DR-XYZ` instead).
- **`file-ownership.md`** — when adding a new workstream (e.g., the Drew promotion that happened on Day 0), splitting an existing one, or resolving a shared-file dispute. Coordinate via the lead negotiation thread first, then ship the MR.

---

> **Template:** SDD v1 (from `claude-code-project-template` v0.3.0+)
> **Created:** 2026-05-21
