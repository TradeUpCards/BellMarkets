# bell_markets IDL — committed snapshot

`bell_markets.json` here is the **committed snapshot** of the Anchor IDL emitted
by `anchor build` (Anchor 0.31 → IDL spec v0.1.0). It is checked in so that
other workstreams (`services/automation`, `apps/web`, `tests/integration`) can
consume a stable IDL without needing to share Aria's `target/` directory across
worktrees (which is gitignored).

## When to regenerate

Whenever the `#[program]` mod in `lib.rs` changes (new ix, removed ix, changed
ix signature) OR an Accounts struct shape changes OR a public `state.rs` /
`errors.rs` type changes. In short: any source change that an IDL consumer
would care about.

## How to regenerate (Aria)

```bash
# From repo root, in WSL Ubuntu (Anchor 0.31.1 toolchain):
anchor build
cp target/idl/bell_markets.json programs/bell-markets/idl/bell_markets.json
git add programs/bell-markets/idl/bell_markets.json
```

Commit alongside the source change that triggered the regen so reviewers see
the IDL delta in the same PR.

## How to consume (other leads)

- **Bram (`services/automation`)**: `cp programs/bell-markets/idl/bell_markets.json services/automation/src/idl/bell_markets.json` (or import directly via a relative path; lead-coordinator's call).
- **Cleo (`apps/web`)**: `cp programs/bell-markets/idl/bell_markets.json apps/web/src/idl/bell_markets.json`.
- **Drew (`tests/integration`)**: read directly from `programs/bell-markets/idl/bell_markets.json` (already does so in `live-deploy-verify.test.ts` via sibling-worktree fs path; can switch to repo-relative now).

## Stale-IDL detection

Drew's `tests/integration/live-deploy-verify.test.ts` already cross-checks the
on-chain program's account discriminators against this IDL. If the IDL is
stale relative to the deployed program, that test fires. Use it as an early
warning if a redeploy ships without an IDL regen.
