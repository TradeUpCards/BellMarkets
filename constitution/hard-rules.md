# BellMarkets — Hard Rules

> Non-negotiables. Banned behaviors, banned dependencies, banned
> patterns. AI coding assistants must refuse work that violates these.

Each rule has:
- **Number** — for grep-able citations (e.g., "per `hard-rules.md` §3.2")
- **Rule** — what's banned or required, stated as imperative
- **Rationale** — why (a one-liner; deeper context in `decisions.md` if needed)
- **Enforcement** — how the rule is policed (CI gate / pre-commit hook /
  human review / honor system + audit)

---

## 1. Security & PHI

### §1.1 [FILL IN: example — "No raw PHI in logs, prompts, or commits"]
**Rationale:** [FILL IN: e.g., HIPAA + general patient-confidentiality posture]
**Enforcement:** [FILL IN: e.g., pre-commit hook scans for `patient_id=\d+`; CI runs scrubber on every test artifact]

### §1.2 [FILL IN: another rule]
**Rationale:**
**Enforcement:**

---

## 2. Privacy

### §2.1 [FILL IN: example — "No third-party analytics / session-replay / telemetry SDKs"]
**Rationale:** [FILL IN: e.g., user sessions never leave the deploy environment]
**Enforcement:** [FILL IN: e.g., `require-checker` blocks the relevant package categories]

---

## 3. Scope

### §3.1 [FILL IN: example — "No backend in MVP — browser-only"]
**Rationale:** [FILL IN: e.g., demo proves the loop, not the data layer]
**Enforcement:** [FILL IN: e.g., human review — Tate refuses to merge MRs introducing server-side code in MVP phase]

### §3.2 [FILL IN: example — "Out of scope: i18n, multi-tenant, offline mode"]
**Rationale:** [FILL IN]
**Enforcement:** [FILL IN]

---

## 4. Code quality

### §4.1 [FILL IN: example — "No external state-management libraries (Redux/Zustand/Jotai/MobX/Recoil)"]
**Rationale:** [FILL IN: e.g., `useReducer` + Context is sufficient at this scale; ceiling kept low to keep codebase auditable]
**Enforcement:** [FILL IN: e.g., `require-checker` + MR review]

### §4.2 [FILL IN: example — "100% test coverage on src/lib/<load-bearing module>"]
**Rationale:** [FILL IN: e.g., bugs there silently pass wrong answers as correct]
**Enforcement:** [FILL IN: e.g., CI fails if coverage on that file drops below 100%]

---

## 5. Deploy & Operations

### §5.1 [FILL IN: example — "Never push directly to main"]
**Rationale:** [FILL IN: e.g., every change reviewed; CI gate fires per MR]
**Enforcement:** [FILL IN: e.g., GitLab branch-protection rule]

### §5.2 [FILL IN: example — "Production credentials never appear in repo or .env files"]
**Rationale:** [FILL IN]
**Enforcement:** [FILL IN: e.g., pre-commit secrets scan]

---

## 6. Data & Identification

### §6.1 [FILL IN: example — "Test fixtures use synthetic data only — no real user data ever"]
**Rationale:** [FILL IN]
**Enforcement:** [FILL IN]

---

> Add more sections as the project surfaces new constraint classes.
> Each new section gets a top-level number; each rule inside gets a sub-number.
> Don't renumber existing rules — citations break. Mark deprecated rules
> with `**Status: DEPRECATED (date)** — superseded by §X.Y` instead of
> deleting them.

---

> **Update protocol:** edit this file via MR. PRs that add a rule should
> link to the trigger (vulnerability finding, regulatory ask, partner
> requirement) in the MR description.
>
> **Citation format:** "per `constitution/hard-rules.md` §3.1"
