// live-program-call.test.ts — Anchor JS end-to-end against the deployed
// program. Day-3 (Fri 2026-05-22): now that DR-004 `uuid@^9.0.0` workspace
// override is in place and MarketConfig is bootstrapped, this test exercises
// the actual @coral-xyz/anchor 0.30.1 client against
// `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV` on devnet.
//
// What this test proves:
//   1. Anchor JS imports cleanly (DR-004 uuid cascade resolved at runtime).
//   2. `Program.account.marketConfig.fetch()` decodes the live MarketConfig
//      account into the expected camelCase shape via the IDL.
//   3. DR-002 `settle_market` and the admin gate on `create_strike_market`
//      are enforced ON CHAIN — not just by static IDL inspection. We build
//      + simulate (`simulate` RPC = encode + dry-run) a `create_strike_market`
//      ix signed by Drew's non-admin keypair and assert it reverts with
//      `NotAdmin (6001)`.
//   4. The IDL we load from disk matches what the deployed program actually
//      decodes — accounts can be round-tripped through `program.coder.accounts`.
//
// What this test does NOT do:
//   - Send transactions that mutate chain state. Uses `simulateTransaction`
//     which dry-runs the instruction WITHOUT broadcasting. Idempotent + free.
//   - Exercise full lifecycle. Blocked until a StrikeMarket exists on devnet
//     (Aria action — see coordination/monorepo-config.md "New Day-3 ask").
//
// Gated by env. Set `LIVE_DEVNET=1` to enable. CI default skips.

import { expect } from "chai";
import * as fs from "node:fs";
import * as path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";

const LIVE = process.env.LIVE_DEVNET === "1";
const PROGRAM_ID              = "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV";
const MARKET_CONFIG_PDA       = "6CYzWhTMzsndRrnRcHgWCUfVDvrRh3Cfoze6GSVev9gQ";
const EXPECTED_PLATFORM_ADMIN = "7b17F2woUy9hgHcRjuLckBVAtNnKAJBRD769URvLprp5";
const EXPECTED_USDC_MINT      = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PHOENIX_SOL_USDC        = "CS2H8nbAVVEUHWPF5extCSymqheQdkd4d7thik6eet9N";
const PYTH_SOL_USD            = "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix";
const TOKEN_PROGRAM           = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DREW_ADMIN_KEYPAIR      = path.resolve(__dirname, "..", "..", "keys", "devnet-drew-admin.json");
const IDL_PATH                = path.resolve(__dirname, "..", "..", "programs", "bell-markets", "idl", "bell_markets.json");
const DEVNET_RPC              = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

describe("BellMarkets live program call (Drew, integration via Anchor JS)", function () {
  if (!LIVE) {
    it.skip("[live tests gated; set LIVE_DEVNET=1 to enable]", () => undefined);
    return;
  }

  this.timeout(60_000);

  let connection: Connection;
  let drewKeypair: Keypair;
  let provider: anchor.AnchorProvider;
  let program: anchor.Program<anchor.Idl>;

  before(async function () {
    this.timeout(60_000);
    connection = new Connection(DEVNET_RPC, "confirmed");

    if (!fs.existsSync(DREW_ADMIN_KEYPAIR)) {
      this.skip();
    }
    const secretBytes = JSON.parse(fs.readFileSync(DREW_ADMIN_KEYPAIR, "utf8")) as number[];
    drewKeypair = Keypair.fromSecretKey(Uint8Array.from(secretBytes));

    // Devnet faucet airdrop — ensures the fee-payer exists on chain so
    // simulateTransaction can reach the program rather than dying with
    // AccountNotFound on the fee-payer lookup. Idempotent: if Aria has
    // already funded the keypair via Drew Ask 3, this is a no-op top-up.
    const bal = await connection.getBalance(drewKeypair.publicKey);
    if (bal < 100_000_000) {                  // < 0.1 SOL → top up
      try {
        const airdropSig = await connection.requestAirdrop(drewKeypair.publicKey, 1_000_000_000);
        await connection.confirmTransaction(airdropSig, "confirmed");
      } catch (e) {
        // Devnet faucet sometimes rate-limits; if already funded by Aria
        // (Ask 3), bal >= 0.1 SOL above and we never get here. Otherwise
        // skip downstream tests rather than fail noisily.
        if ((await connection.getBalance(drewKeypair.publicKey)) < 100_000_000) {
          this.skip();
        }
      }
    }

    const wallet = new anchor.Wallet(drewKeypair);
    provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

    const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
    program = new anchor.Program(idl, provider) as unknown as anchor.Program<anchor.Idl>;
  });

  it("Anchor JS imports + Program constructs cleanly (DR-004 uuid cascade resolved at runtime)", function () {
    expect(program).to.exist;
    expect(program.programId.toBase58()).to.equal(PROGRAM_ID);
    expect((program.idl as { address: string }).address).to.equal(PROGRAM_ID);
    expect(program.idl.instructions.length).to.equal(9);
  });

  it("Program.account.marketConfig.fetch() decodes the live MarketConfig", async function () {
    const cfgPda = new PublicKey(MARKET_CONFIG_PDA);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = await (program.account as any).marketConfig.fetch(cfgPda);
    expect(cfg.admin.toBase58()).to.equal(EXPECTED_PLATFORM_ADMIN);
    expect(cfg.usdcMint.toBase58()).to.equal(EXPECTED_USDC_MINT);
    expect(Number(cfg.priceStalenessSecs)).to.equal(300);
    expect(cfg.priceConfidenceBps).to.equal(50);
    expect(Number(cfg.adminOverrideDelaySecs)).to.equal(3600);
    expect(cfg.paused).to.equal(false);
  });

  it("create_strike_market signed by non-admin (Drew) reverts on chain with NotAdmin (6001)", async function () {
    const strikePrice = new anchor.BN(680_000_000);
    const expiryUnix  = new anchor.BN(Math.floor(Date.now() / 1000) + 600);
    const programIdPk = new PublicKey(PROGRAM_ID);
    const pythFeed    = new PublicKey(PYTH_SOL_USD);
    const phoenix     = new PublicKey(PHOENIX_SOL_USDC);
    const usdcMint    = new PublicKey(EXPECTED_USDC_MINT);

    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(expiryUnix.toString()));
    const strikeBuf = Buffer.alloc(8);
    strikeBuf.writeBigInt64LE(BigInt(strikePrice.toString()));

    const [strikeMarketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("strike"), pythFeed.toBuffer(), expiryBuf, strikeBuf],
      programIdPk,
    );
    const [yesMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("yes"), strikeMarketPda.toBuffer()], programIdPk,
    );
    const [noMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("no"), strikeMarketPda.toBuffer()], programIdPk,
    );
    const [usdcVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), strikeMarketPda.toBuffer()], programIdPk,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ix = await (program.methods as any)
      .createStrikeMarket(strikePrice, expiryUnix)
      .accounts({
        admin: drewKeypair.publicKey,
        config: new PublicKey(MARKET_CONFIG_PDA),
        strikeMarket: strikeMarketPda,
        underlyingPythFeed: pythFeed,
        yesMint: yesMintPda,
        noMint: noMintPda,
        usdcVault: usdcVaultPda,
        usdcMint,
        phoenixMarket: phoenix,
        systemProgram: SystemProgram.programId,
        tokenProgram: new PublicKey(TOKEN_PROGRAM),
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ix);
    tx.feePayer = drewKeypair.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(drewKeypair);

    const sim = await connection.simulateTransaction(tx);
    expect(sim.value.err, "expected simulation to fail (NotAdmin)").to.not.be.null;

    // Anchor maps custom code 6001 → BellMarketsError::NotAdmin.
    const errStr = JSON.stringify(sim.value.err);
    expect(errStr).to.match(/Custom":\s*6001/);
  });

  it("settle_market against a seeded market reaches the handler (NotExpired) — DR-002 chain evidence", async function () {
    // DR-002 evidence at the chain level. The earlier draft of this test
    // pointed at a NON-EXISTENT StrikeMarket PDA and asserted "NOT NotAdmin
    // (6001)" — which passes vacuously for any account-not-found error.
    // Audit caught this (Sonnet review, 2026-05-22). Rewritten to:
    //
    //   1. Find a real StrikeMarket via getProgramAccounts (StrikeMarket
    //      discriminator [109,109,58,228,193,219,99,7]).
    //   2. If none exists yet, skip with a clear message — proving DR-002
    //      at the chain level is blocked on Aria's optional Ask 4 (seed
    //      market) per coordination/monorepo-config.md.
    //   3. If one exists, build + simulate settle_market signed by Drew
    //      (non-admin). Assert the error is `NotExpired (6003)` — a POSITIVE
    //      signal that the handler ran past Accounts resolution + the (absent)
    //      admin check. NotExpired only fires inside the handler body, after
    //      any signer/admin constraint would have rejected. The presence of
    //      NotExpired ⇒ no admin gate.
    const STRIKE_MARKET_DISCRIMINATOR_B58 = "DkVwfedB46v";   // base58 of [109,109,58,228,193,219,99,7]
    const accounts = await connection.getProgramAccounts(new PublicKey(PROGRAM_ID), {
      filters: [{ memcmp: { offset: 0, bytes: STRIKE_MARKET_DISCRIMINATOR_B58 } }],
      dataSlice: { offset: 0, length: 0 },
    });

    if (accounts.length === 0) {
      this.skip();                           // No seeded market yet — see Drew Ask 4.
    }

    // Pick any seeded StrikeMarket. We'd ideally pick one whose expiry is in
    // the future so NotExpired fires; if all seeded markets have already
    // expired, this test would observe a different (still non-admin) handler
    // error such as PythFeedMismatch — also acceptable evidence the handler
    // reached past any admin check. We narrow the assertion conditionally.
    const candidate = accounts[0];
    const acctInfo = await connection.getAccountInfo(candidate.pubkey, "confirmed");
    if (!acctInfo) this.skip();

    // Layout per state.rs StrikeMarket:
    //   8 (disc) + 32 (config) + 32 (pyth_feed) + 8 (strike_price)
    //   = expiryUnix at offset 80, length 8 (i64 LE)
    const expiryUnixOnChain = acctInfo!.data.readBigInt64LE(80);
    const pythFeedOnChain = new PublicKey(acctInfo!.data.subarray(40, 72));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ix = await (program.methods as any)
      .settleMarket()
      .accounts({
        settler: drewKeypair.publicKey,
        config: new PublicKey(MARKET_CONFIG_PDA),
        strikeMarket: candidate.pubkey,
        underlyingPythFeed: pythFeedOnChain,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ix);
    tx.feePayer = drewKeypair.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(drewKeypair);

    const sim = await connection.simulateTransaction(tx);
    expect(sim.value.err, "expected simulation to fail").to.not.be.null;
    const errStr = JSON.stringify(sim.value.err);

    // The KEY positive assertion: error is a HANDLER-LEVEL error code from
    // the BellMarketsError enum (6000-6025), not an Accounts-struct-level
    // failure. Any 6xxx error means the handler ran. If admin gate were
    // present, the error would have been 6001 (NotAdmin) BEFORE the handler
    // body executed.
    const customMatch = errStr.match(/Custom":\s*(\d+)/);
    expect(customMatch, `expected a BellMarketsError code in ${errStr}`).to.not.be.null;
    const code = parseInt(customMatch![1], 10);
    expect(code).to.be.at.least(6000);
    expect(code).to.be.at.most(6025);
    expect(code, `code ${code} is NotAdmin — DR-002 violation`).to.not.equal(6001);

    // If the seeded market is unexpired, narrow further to NotExpired (6003)
    // — the strongest possible positive signal for DR-002.
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (expiryUnixOnChain > now) {
      expect(code, `unexpired market should hit NotExpired (6003), got ${code}`).to.equal(6003);
    }
  });
});
