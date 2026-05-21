# BellMarkets — Constitution

> **Locked rules and architectural decisions.** Changes here go through MR
> review. AI coding assistants and human contributors both treat these
> files as authoritative.

This directory is the **load-bearing rules layer** of the project. If
something here conflicts with code, the code is wrong, not these files.

## Files in this directory

| File | What it holds | Update via |
|---|---|---|
| [`hard-rules.md`](hard-rules.md) | Non-negotiables: security, privacy, scope locks, banned dependencies, banned patterns | MR review |
| [`decisions.md`](decisions.md) | Locked architectural decisions (Decision Record table) — each entry names the trade-off it accepts | MR with `decisions:` label |
| [`file-ownership.md`](file-ownership.md) | Workstream model + per-lead file ownership + shared-file coordination protocol | Lead negotiation thread in `.project/<slug>/coordination/`, then MR |

## How agents should cite this directory

When making a decision that depends on a rule, cite the source:

```
> Skipping cookie-based auth per constitution/hard-rules.md §3
> (Security & PHI). Using JWT in Authorization header instead.

> Choosing Postgres over SQLite per constitution/decisions.md DR-007
> (durability for multi-process writes outweighs single-file simplicity
> for this workload).
```

Specific citations beat vague references — make it grep-able.

## When constitution/ disagrees with specs/

`constitution/` wins. The spec describes what we're building; the
constitution names what we won't compromise. If the spec needs something
the constitution forbids, the spec changes, not the constitution.

## When constitution/ disagrees with brainlift / older docs

`constitution/` wins. This is the single source of truth. Legacy docs
(`BRAINLIFT.md`, scattered `DECISIONS.md` entries, etc.) get migrated
into here; if a contradiction surfaces, fix the legacy doc.

## When to update each file

- **`hard-rules.md`** — when discovering a new constraint that should be
  enforced project-wide (a vulnerability class, a regulatory boundary, a
  banned pattern). Rare and weighty edits.
- **`decisions.md`** — when locking a new architectural decision OR
  superseding an existing one. Add a DR-NNN entry; never delete old
  entries (mark `Status: Superseded by DR-XYZ` instead).
- **`file-ownership.md`** — when adding a new workstream, splitting an
  existing one, or resolving a shared-file dispute. Coordinate via the
  lead negotiation thread first, then ship the MR.

---

> **Template:** SDD v1 (from `claude-code-project-template` {{TEMPLATE_VERSION}})
> **Created:** {{INIT_DATE}}
