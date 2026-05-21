# BellMarkets — Specs

> What we're building. How it behaves. What's deferred and why.

This directory is the **design layer** of the project. `constitution/`
names what we won't compromise; `specs/` describes the thing being built
within those constraints.

## Files in this directory

| File | What it holds | When to update |
|---|---|---|
| [`architecture.md`](architecture.md) | System shape — components, deployment, data flow, verification approach | When architecture shifts (rare; weighty) |
| [`bell-markets-spec.md`](bell-markets-spec.md) | Behavior-level spec: what the system does, end-to-end. Project-type-specific shape (ed-tech lesson spec / backend API spec / agent loop spec / etc.) | When behavior changes; surface in MR description |
| [`coordination.md`](coordination.md) | Workstream model + lead handoff discipline + cross-lead negotiation patterns | When workstreams reshape (rare) |
| [`deferred.md`](deferred.md) | What we explicitly chose NOT to build (with rationale + revisit threshold) | Whenever a deferral is made; reference DR# in `constitution/decisions.md` |

## How specs/ and constitution/ interact

- **constitution/** names locked rules and decisions (the rails).
- **specs/** names the system being built (the train running on the rails).
- If a spec needs something the constitution forbids, the spec changes
  — never weaken the constitution to fit a spec.

## How agents should cite this directory

```
> Implementing per specs/architecture.md §2.3 (Verifier as defense layer).

> Skipping field X per specs/deferred.md (v3 path; revisit when
> partner Y signs onto pilot).
```

## When to update each file

- **`architecture.md`** — when adding a major component, changing a
  data-flow boundary, or shifting deployment topology. Always update
  the mermaid diagram if the boundary moved.
- **`bell-markets-spec.md`** — whenever the behavior contract changes.
  This is the file partner reviews map against and graders read first.
- **`coordination.md`** — when adding a new lead, splitting a workstream,
  or shipping a new handoff pattern.
- **`deferred.md`** — whenever a feature/path is explicitly chosen NOT
  to build this cycle. Each entry must name the revisit threshold (date,
  external event, or "if we re-scope").

---

> **Template:** SDD v1 (from `claude-code-project-template` {{TEMPLATE_VERSION}})
> **Created:** {{INIT_DATE}}
