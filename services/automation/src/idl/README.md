# IDL drop zone (automation service)

`bell_markets.json` is intentionally `{}` until Aria's `anchor build` lands an
IDL artifact at `target/idl/bell_markets.json`. Once it does:

```
# from repo root, in Aria's worktree (or whichever has `target/` populated):
cp target/idl/bell_markets.json services/automation/src/idl/bell_markets.json
git add services/automation/src/idl/bell_markets.json
```

The `BellMarketsAnchorClient` at `services/automation/src/clients/anchor.ts`
fail-fasts with a descriptive `AnchorClientError` if it's still the `{}`
placeholder when a job tries to construct the program — so a partial
deploy can never silently no-op.

Mirrors the same drop-zone pattern at `apps/web/src/idl/` (Cleo's side).

Do **not** hand-edit this file. It's a generated artifact.
