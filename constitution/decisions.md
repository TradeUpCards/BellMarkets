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

### DR-001 — [FILL IN: example — "Single-binary deploy over containerized microservices"]

**Date:** {{INIT_DATE}}
**Status:** Active
**Made by:** [FILL IN: name / team]

**Context:** [FILL IN: 2-4 sentences. Forces in play at decision time.]

**Decision:** [FILL IN: the choice, stated unambiguously]

**Trade-off:** [FILL IN: "We pay X in exchange for Y"]

**Consequences:**
- [FILL IN: downstream effect 1]
- [FILL IN: downstream effect 2]

**Alternatives considered:**
- [Alternative A]: [why rejected]
- [Alternative B]: [why rejected]

---

### DR-002 — [FILL IN]

**Date:** {{INIT_DATE}}
**Status:** Active
**Made by:** [FILL IN]

**Context:** [FILL IN]

**Decision:** [FILL IN]

**Trade-off:** [FILL IN]

**Consequences:**
- [FILL IN]

**Alternatives considered:**
- [FILL IN]

---

### DR-003 — [FILL IN]

[Same shape]

---

> Aim for 5–15 active DRs over a project's life. Fewer and you're not
> locking enough; more and the file becomes unscannable (rotate stable
> ones into `specs/architecture.md` if they've become "just how the
> system works" rather than "a choice we made").

> **Citation format:** "per `constitution/decisions.md` DR-007"
