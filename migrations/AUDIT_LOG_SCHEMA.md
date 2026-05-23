# `migrations/audit_log.jsonl` — schema + workflow

**Purpose:** append-only record of every program deploy / upgrade so we can
(a) explain to graders what shipped and when, (b) trend the .so size + rent
cost over the build, and (c) trace any on-chain behavior back to a git SHA.

**Format:** JSON Lines (`.jsonl`) — one JSON object per line. Append-only;
never edit a past entry except to add a missing field (`null` is fine when
unknown).

**Pattern borrowed from `w3swap/solana_token_migration/auditlogssize_audit.jsonl`.**
That file existed in w3swap as a placeholder but was never populated; we're
adopting the spirit (per-deploy audit log) with a sharper schema.

---

## Schema

| Field | Type | Required? | Notes |
|---|---|---|---|
| `timestamp` | string (ISO 8601 UTC) | yes | When `anchor deploy` returned success. |
| `deploy_index` | integer | yes | 1-based monotonic counter. |
| `deploy_type` | "initial" \| "upgrade" | yes | First deploy after program-keypair creation = "initial"; everything else = "upgrade". |
| `cluster` | "devnet" \| "localnet" \| "mainnet" | yes | We don't deploy to mainnet per Hard NO #1. |
| `program_id` | string (base58) | yes | The deployed program's pubkey. |
| `program_data` | string (base58) | yes | The BPFLoaderUpgradeable's ProgramData account. |
| `tx_signature` | string (base58) | yes | Signature of the deploy tx. Verify via `solana confirm <sig> --url devnet`. |
| `deploy_slot` | integer | yes | `solana program show ... --url devnet` → "Last Deployed In Slot". |
| `binary_size_bytes` | integer | yes | `ls -la target/deploy/bell_markets.so` size column. |
| `binary_size_kb` | number | yes | `binary_size_bytes / 1024`. Convenience. |
| `size_delta_bytes` | integer | yes | Difference from previous deploy's `binary_size_bytes`. Positive = growth. For deploy_index=1, equals `binary_size_bytes`. |
| `program_data_rent_sol` | number | yes | `solana program show ... --url devnet` → "Balance:" line. Cumulative ProgramData account rent. |
| `deploy_cost_sol` | number | yes | Upgrade authority balance delta from before to after this deploy. Includes ProgramData rent delta + tx fee + buffer rent (refunded post-deploy). |
| `cumulative_deploy_cost_sol` | number | yes | Running total across all deploys. |
| `upgrade_authority` | string (base58) | yes | Should be stable across upgrades. Watch for drift. |
| `upgrade_authority_balance_before_sol` | number | yes | `solana balance <pubkey> --url devnet` immediately pre-deploy. |
| `upgrade_authority_balance_after_sol` | number | yes | `solana balance <pubkey> --url devnet` immediately post-deploy. |
| `git_sha` | string | yes | Short SHA of the commit being deployed. Use "pre-commit-DayN" if deploy happens mid-session before commit. |
| `git_branch` | string | yes | Active branch at deploy time. |
| `ix_count` | integer | yes | Number of instructions in the IDL post-build. |
| `account_count` | integer | yes | Number of `#[account]` types in the IDL. |
| `error_variant_count` | integer | yes | `programs/bell-markets/src/errors.rs` `#[error_code]` variants. |
| `outcome_variants` | integer | yes | Number of variants in the `Outcome` enum (currently 4: Unsettled/Yes/No/Invalid). |
| `toolchain` | object | yes | `{anchor_cli, solana_cli, rustc, host}` — keep current. |
| `summary` | string | yes | One sentence describing the deploy. Imperative or past-tense. |
| `changes` | array<string> | yes | Bullet list of meaningful changes since previous deploy. Focus on user/lead-visible impact. |
| `notes` | string | no | Anything else worth recording (warnings, caveats, known issues, etc.). |

---

## Workflow — appending an entry after a new deploy

Manual (until automated):

1. After `anchor deploy` succeeds, record:
   - tx signature from the deploy output
   - `solana program show <PROGRAM_ID> --url devnet` → "Last Deployed In Slot" + "Balance:" (= program_data_rent_sol)
   - `ls -la target/deploy/bell_markets.so` → `binary_size_bytes`
   - `solana balance <upgrade-authority> --url devnet` → balance_after_sol
   - Difference from prior recorded `upgrade_authority_balance_after_sol` = `deploy_cost_sol`
2. Compute deltas:
   - `size_delta_bytes` = current binary_size_bytes - previous deploy's binary_size_bytes
   - `cumulative_deploy_cost_sol` = previous cumulative + this deploy_cost_sol
3. Read IDL: `node -e "const i=require('./programs/bell-markets/idl/bell_markets.json'); console.log(JSON.stringify({ix:i.instructions.length, accts:i.accounts.length}))"`
4. Read error count: `grep -c '#\[msg(' programs/bell-markets/src/errors.rs`
5. Read git: `git rev-parse --short HEAD` + `git rev-parse --abbrev-ref HEAD`
6. Write a one-line JSON object with all fields above; append to `migrations/audit_log.jsonl` with no trailing newline mid-object (JSONL requires one object per line).
7. Commit the audit log update alongside the source change that triggered the deploy.

---

## Conventions

- **One line per deploy.** No pretty-printing — the line is the atomic unit.
- **Never delete past entries.** History is the value.
- **`changes` describes the diff since the previous deploy_index**, not since the project began.
- **Sort entries by `deploy_index` ascending.** New entries always go at the bottom.
- **Cluster split:** in principle multiple clusters could share this log via the `cluster` field. Today we only deploy to devnet.
- **`deploy_cost_sol` semantics:** the upgrade-authority balance delta captures all costs the authority paid (ProgramData rent delta + tx fees + buffer rent that didn't refund). It is NOT the same as `program_data_rent_sol` (cumulative ProgramData rent).

---

## Future automation hooks

- A small shell wrapper around `anchor deploy` could append automatically by parsing the deploy output + querying `solana program show` + diffing against the last entry. Optional Day-4+ tooling.
- `migrations/bootstrap-config` (existing Rust binary) is one-shot ix invocation; could be paired with a sibling binary that just appends an audit entry given the tx sig + program ID.

---

## Reading the log

- Track size growth: `jq '.binary_size_bytes' migrations/audit_log.jsonl`
- Per-deploy summaries: `jq -r '"\(.deploy_index) [\(.git_sha)] +\(.size_delta_bytes)B \(.deploy_cost_sol)SOL — \(.summary)"' migrations/audit_log.jsonl`
- Total cost: `jq '[.deploy_cost_sol] | add' migrations/audit_log.jsonl` (within `jq -s`)
