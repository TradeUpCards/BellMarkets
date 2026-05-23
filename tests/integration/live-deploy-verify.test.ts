// live-deploy-verify.test.ts — read-only verification that Aria's deployed
// program is really on devnet AND matches the IDL she emitted, AND that the
// MarketConfig PDA was bootstrapped with the expected admin.
//
// Drew's compressed-time simulation proves the lifecycle works against a
// mocked Aria interface. This test proves the *real* program account exists,
// is BPF-executable, has the expected upgrade authority, the IDL we're
// coding against matches the deployed program ID, AND (Day-3 addition)
// MarketConfig has been initialized by the platform admin keypair.
//
// Why raw JSON-RPC instead of @coral-xyz/anchor:
//   We exercise Anchor JS separately in live-program-call.test.ts now that
//   the DR-004 workspace `uuid@^9.0.0` override is in place. This test
//   intentionally stays zero-dep so a fresh checkout can verify the deploy
//   without installing anything beyond @types/node + chai + mocha. Raw
//   `fetch` to https://api.devnet.solana.com is sufficient and ESM-safe.
//
// Gated by env. Set `LIVE_DEVNET=1` to enable. Without it, the suite skips
// cleanly so the CI default (no devnet dependency) stays green offline.
//
//   pnpm --filter @bell-markets/tests test:integration
//   LIVE_DEVNET=1 pnpm --filter @bell-markets/tests test:integration  (Unix)
//   $env:LIVE_DEVNET="1"; pnpm --filter @bell-markets/tests test:integration  (PowerShell)
//
// Sources of truth:
//   - programs/bell-markets/idl/bell_markets.json (canonical committed IDL — Day-3 path)
//   - .project/bell-markets/coordination/devnet-pubkeys.md (program + PDAs)
//   - BRAINLIFT.md Hard YES #2 (one-command demo); this is a prereq for the
//     "live-program-actually-works" demo narrative.

import { expect } from "chai";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Constants from Aria's deploy (devnet-pubkeys.md) ─────────────────────
const PROGRAM_ID                 = "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV";
const EXPECTED_PROGRAMDATA       = "Erh54ewsrYEUYRewF8crqPi3VceUsrhwA329oL1MxVFj";
const EXPECTED_UPGRADE_AUTHORITY = "9snc1xMYHPQbJuaybP98z6YS6xBbzhDTnXiNoKRawanZ";
const EXPECTED_PLATFORM_ADMIN    = "7b17F2woUy9hgHcRjuLckBVAtNnKAJBRD769URvLprp5";
const EXPECTED_USDC_MINT         = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const EXPECTED_TREASURY          = "FAc2JccudUr9C5pqB2KAnaBaPXLuejYotvfjuuysUrjs";
const MARKET_CONFIG_PDA          = "6CYzWhTMzsndRrnRcHgWCUfVDvrRh3Cfoze6GSVev9gQ";
const BPF_LOADER_UPGRADEABLE     = "BPFLoaderUpgradeab1e11111111111111111111111";
const DEVNET_RPC                 = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

// IDL canonical committed path (Day-3 — Aria moved it from target/idl/ to here).
const IDL_PATH = path.resolve(
  __dirname, "..", "..",
  "programs", "bell-markets", "idl", "bell_markets.json",
);

// ─── Tiny base58 decoder (only for the 32-byte pubkey case) ───────────────
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const c = B58.indexOf(ch);
    if (c < 0) throw new Error(`base58: invalid char '${ch}'`);
    let carry = c;
    for (let j = 0; j < bytes.length; ++j) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < s.length && s[i] === "1"; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function base58FromBytes(buf: Buffer | Uint8Array): string {
  // Encode 32-byte pubkey to base58. Adequate for the comparison case.
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const rem = Number(n % 58n);
    out = B58[rem] + out;
    n = n / 58n;
  }
  // Leading zero bytes ⇒ leading '1' chars
  for (const b of buf) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

interface RpcAccountInfo {
  lamports: number;
  owner: string;
  executable: boolean;
  rentEpoch: number | string;
  data: [string /* base64 */, "base64"];
}

async function rpcGetAccountInfo(pubkey: string): Promise<RpcAccountInfo | null> {
  const body = {
    jsonrpc: "2.0", id: 1, method: "getAccountInfo",
    params: [pubkey, { encoding: "base64", commitment: "confirmed" }],
  };
  const res = await fetch(DEVNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result: { value: RpcAccountInfo | null }; error?: { message: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result.value;
}

// ─── Suite ────────────────────────────────────────────────────────────────

const LIVE = process.env.LIVE_DEVNET === "1";

describe("BellMarkets live deploy verify (Drew, integration)", function () {
  if (!LIVE) {
    it.skip("[live tests gated; set LIVE_DEVNET=1 to enable]", () => undefined);
    return;
  }

  this.timeout(30_000);

  it("program account exists, is executable, owned by BPF upgradeable loader", async () => {
    const acc = await rpcGetAccountInfo(PROGRAM_ID);
    expect(acc, `no account at ${PROGRAM_ID} on devnet`).to.not.be.null;
    expect(acc!.executable).to.equal(true);
    expect(acc!.owner).to.equal(BPF_LOADER_UPGRADEABLE);
    const data = Buffer.from(acc!.data[0], "base64");
    expect(data.length).to.equal(36);
    expect(data.readUInt32LE(0)).to.equal(2);    // UpgradeableLoaderState::Program
    const programDataBytes = data.subarray(4, 36);
    const expectedProgramDataBytes = base58Decode(EXPECTED_PROGRAMDATA);
    expect(Buffer.from(programDataBytes).equals(Buffer.from(expectedProgramDataBytes))).to.equal(true);
  });

  it("ProgramData account exists, has expected upgrade authority", async () => {
    const acc = await rpcGetAccountInfo(EXPECTED_PROGRAMDATA);
    expect(acc, `no ProgramData at ${EXPECTED_PROGRAMDATA}`).to.not.be.null;
    expect(acc!.owner).to.equal(BPF_LOADER_UPGRADEABLE);
    const data = Buffer.from(acc!.data[0], "base64");
    expect(data.length).to.be.greaterThan(45 + 1000);
    expect(data.readUInt32LE(0)).to.equal(3);
    const slot = data.readBigUInt64LE(4);
    expect(slot > 0n).to.equal(true);
    expect(data[12]).to.equal(1);
    const upgradeAuthBytes = data.subarray(13, 45);
    const expectedBytes = base58Decode(EXPECTED_UPGRADE_AUTHORITY);
    expect(Buffer.from(upgradeAuthBytes).equals(Buffer.from(expectedBytes))).to.equal(true);
  });

  it("MarketConfig PDA exists + admin == platform admin pubkey (Day-3 bootstrap)", async () => {
    // Aria's bootstrap-config migration ran on 2026-05-22, tx
    // `3qJbdLe55GGgpwiErTJKhyn5q3uNuhikMb2h6EQBhAUZZJ4iztAYAkz7jyZm1HySivXE1y62qkftnV8gzLybXUmq`.
    const acc = await rpcGetAccountInfo(MARKET_CONFIG_PDA);
    expect(acc, `MarketConfig PDA ${MARKET_CONFIG_PDA} not found — bootstrap missing or PDA derivation drift`).to.not.be.null;
    expect(acc!.owner).to.equal(PROGRAM_ID);

    // Anchor account layout: 8-byte discriminator + struct fields per IDL.
    // MarketConfig (state.rs LEN):
    //   8   discriminator
    //   32  admin (pubkey)
    //   32  usdc_mint (pubkey)
    //   32  treasury (pubkey)
    //   8   price_staleness_secs (i64)
    //   2   price_confidence_bps (u16)
    //   8   admin_override_delay_secs (i64)
    //   1   paused (bool)
    //   1   bump (u8)
    //  64   _reserved
    //  ---  total 188 bytes
    const data = Buffer.from(acc!.data[0], "base64");
    expect(data.length).to.equal(188);

    const admin    = base58FromBytes(data.subarray(8,  40));
    const usdcMint = base58FromBytes(data.subarray(40, 72));
    const treasury = base58FromBytes(data.subarray(72, 104));
    const staleness = data.readBigInt64LE(104);
    const confidenceBps = data.readUInt16LE(112);
    const overrideDelay = data.readBigInt64LE(114);
    const paused = data[122] === 1;
    const bump   = data[123];

    expect(admin).to.equal(EXPECTED_PLATFORM_ADMIN);
    expect(usdcMint).to.equal(EXPECTED_USDC_MINT);
    expect(treasury).to.equal(EXPECTED_TREASURY);
    expect(staleness).to.equal(300n);
    expect(confidenceBps).to.equal(50);
    expect(overrideDelay).to.equal(3600n);
    expect(paused).to.equal(false);
    expect(bump).to.equal(255);
  });

  it("IDL at programs/bell-markets/idl/ matches deployed program structure", () => {
    expect(fs.existsSync(IDL_PATH), `IDL not found at ${IDL_PATH}`).to.equal(true);
    const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));

    expect(idl.address).to.equal(PROGRAM_ID);
    expect(idl.metadata?.name).to.equal("bell_markets");
    expect(idl.metadata?.spec).to.equal("0.1.0");

    // Day-3: 9 ix. Day-4: 10. Day-5 (post Aria DR-005/007/008/010 merge): 20.
    // Forward-compatible: require the 10 Day-4 core ix; tolerate new ix from
    // Aria's DR-005/008/010 expansion (user_create_strike_market, fee_config
    // init + update, rewards pool init + commit + distribute, force_redeem,
    // close_settled_market, update_ticker_config).
    const ixNames: string[] = (idl.instructions ?? []).map((i: { name: string }) => i.name).sort();
    const required10 = [
      "add_strike", "admin_settle", "create_strike_market", "initialize_config",
      "mint_pair", "pause", "redeem", "redeem_invalid", "redeem_pair", "settle_market",
    ];
    for (const required of required10) expect(ixNames).to.include(required);
    expect(ixNames.length, "expected at least 10 core ix").to.be.at.least(10);

    // Day-5 NEW ix presence check — if they're here, structural verify they
    // match the DR spec. If missing, fail (would mean Aria's merge incomplete).
    const day5NewIx = [
      "user_create_strike_market", "update_ticker_config",
      "force_redeem", "close_settled_market",
      "initialize_fee_config", "update_fee_config",
      "initialize_rewards_pools", "commit_leaderboard_root",
      "distribute_weekly_rewards", "distribute_monthly_rewards",
    ];
    for (const newIx of day5NewIx) {
      expect(ixNames, `Day-5 IDL must include ${newIx} (per DR-005/006/008/010)`).to.include(newIx);
    }

    // Day-3: 2 accounts. Day-5: 6 accounts (added FeeConfig, LeaderboardCommitments,
    // TickerConfig, UserConfig per DR-005/008/010).
    const accountNames: string[] = (idl.accounts ?? []).map((a: { name: string }) => a.name).sort();
    expect(accountNames).to.include.members(["MarketConfig", "StrikeMarket"]);
    expect(accountNames).to.include.members([
      "FeeConfig", "LeaderboardCommitments", "TickerConfig", "UserConfig",
    ]);

    // Day-3: 26 errors. Day-5: 41 errors (DR-005/008/010 added new variants —
    // StrikeBeyondDeviationCap, StrikeMisalignedTick, ForceRedeemTooEarly,
    // PairsStillOutstanding, InvalidProof, FeeBpsSumMismatch, etc.).
    const codes: number[] = (idl.errors ?? []).map((e: { code: number }) => e.code).sort((a, b) => a - b);
    expect(codes.length, "expected at least 26 errors from Day-3").to.be.at.least(26);
    expect(codes[0]).to.equal(6000);

    // Outcome enum has 4 variants.
    const outcomeType = (idl.types ?? []).find((t: { name: string }) => t.name === "Outcome");
    expect(outcomeType, "no Outcome type in IDL").to.exist;
    const variants: string[] = outcomeType.type.variants.map((v: { name: string }) => v.name);
    expect(variants).to.deep.equal(["Unsettled", "Yes", "No", "Invalid"]);

    // DR-002: settle_market has NO admin signer.
    const settleIx = (idl.instructions ?? []).find((i: { name: string }) => i.name === "settle_market");
    expect(settleIx, "no settle_market in IDL").to.exist;
    const signers = settleIx.accounts.filter((a: { signer?: boolean }) => a.signer === true);
    expect(signers.length).to.equal(1);
    expect(signers[0].name).to.equal("settler");
    const docs = (signers[0].docs ?? []).join(" ").toLowerCase();
    expect(docs).to.match(/permissionless|not validated against admin/);

    // admin_settle takes forced_outcome: Outcome.
    const adminIx = (idl.instructions ?? []).find((i: { name: string }) => i.name === "admin_settle");
    expect(adminIx, "no admin_settle in IDL").to.exist;
    expect(adminIx.args).to.have.length(1);
    expect(adminIx.args[0].name).to.equal("forced_outcome");
    expect(adminIx.args[0].type.defined.name).to.equal("Outcome");

    // settle_market has zero args.
    expect(settleIx.args).to.have.length(0);

    // redeem_invalid (Day-3) takes amount: u64; has both yes_mint + no_mint + user_yes + user_no.
    const redeemInvalidIx = (idl.instructions ?? []).find((i: { name: string }) => i.name === "redeem_invalid");
    expect(redeemInvalidIx, "no redeem_invalid in IDL — Day-3 instruction missing").to.exist;
    expect(redeemInvalidIx.args).to.have.length(1);
    expect(redeemInvalidIx.args[0].name).to.equal("amount");
    expect(redeemInvalidIx.args[0].type).to.equal("u64");
    const acctNames = redeemInvalidIx.accounts.map((a: { name: string }) => a.name);
    expect(acctNames).to.include.members(["yes_mint", "no_mint", "user_yes", "user_no"]);
  });
});
