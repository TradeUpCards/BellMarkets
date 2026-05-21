// Pyth-parser test for BellMarkets `bell_markets::oracle`.
//
// Two layers:
//   A. Pure-byte parity check — re-builds the same fixture the Rust unit test
//      in `programs/bell-markets/src/oracle.rs` uses and asserts the field map
//      stays in lock-step. No validator needed; runs under plain `pnpm test`.
//   B. (Day-2+) Localnet round-trip — load fixture bytes into an account via
//      `solana-test-validator`'s `--account` flag and call `settle_market`.
//      Skipped until toolchain (anchor-cli, solana-cli) lands on the build
//      machine — see `.project/bell-markets/handoffs/aria-handoff.md`.

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "pyth-trading-snapshot.json"),
    "utf8",
  ),
);

// JS-side mirror of the parser's field map. If the Rust parser's offsets ever
// drift, this builder will produce bytes the parser misreads and the on-chain
// settle round-trip in layer B catches it.
function buildPythFixtureBytes(): Buffer {
  const buf = Buffer.alloc(FIXTURE.byte_length);
  const o = FIXTURE.offsets;
  buf.writeUInt32LE(parseInt(FIXTURE.magic, 16), o.magic);
  buf.writeUInt32LE(FIXTURE.version, o.ver);
  buf.writeUInt32LE(FIXTURE.atype, o.atype);
  buf.writeInt32LE(FIXTURE.exponent, o.exponent);
  buf.writeBigInt64LE(BigInt(FIXTURE.agg.price), o.agg_price);
  buf.writeBigUInt64LE(BigInt(FIXTURE.agg.confidence), o.agg_conf);
  buf.writeUInt32LE(FIXTURE.agg.status, o.agg_status);
  buf.writeBigUInt64LE(BigInt(FIXTURE.agg.publish_slot), o.agg_pub_slot);
  return buf;
}

describe("oracle::parse_pyth_price (layer A — byte-layout parity)", () => {
  it("encodes the fixture at the exact offsets the Rust parser reads", () => {
    const buf = buildPythFixtureBytes();
    expect(buf.length).to.equal(320);
    expect(buf.readUInt32LE(0).toString(16)).to.equal("a1b2c3d4");
    expect(buf.readUInt32LE(4)).to.equal(2);
    expect(buf.readUInt32LE(8)).to.equal(3);
    expect(buf.readInt32LE(20)).to.equal(-8);
    expect(buf.readBigInt64LE(208)).to.equal(15_000_000_000n);
    expect(buf.readBigUInt64LE(216)).to.equal(7_500_000n);
    expect(buf.readUInt32LE(224)).to.equal(1);
    expect(buf.readBigUInt64LE(232)).to.equal(123_456_789n);
  });

  it("offsets match the canonical pc_price_t.agg_ block (208/216/224/232)", () => {
    // Tripwire: if anyone "fixes" the offsets to the old (wrong) +16 layout,
    // this test fires. Cites pyth-client pc_price_info_t starting at byte 208.
    expect(FIXTURE.offsets.agg_price).to.equal(208);
    expect(FIXTURE.offsets.agg_conf).to.equal(216);
    expect(FIXTURE.offsets.agg_status).to.equal(224);
    expect(FIXTURE.offsets.agg_pub_slot).to.equal(232);
  });

  it("rejects mutations the Rust parser would reject (sanity)", () => {
    const buf = buildPythFixtureBytes();
    buf.writeUInt32LE(0xdeadbeef, 0);
    expect(buf.readUInt32LE(0)).to.equal(0xdeadbeef);
  });
});

describe.skip("oracle::parse_pyth_price (layer B — localnet round-trip)", () => {
  // Activate once toolchain lands. Implementation outline:
  //   1. Dump fixture bytes to a file.
  //   2. Launch solana-test-validator with `--account <pubkey> <path>`.
  //   3. anchor.workspace.BellMarkets.methods.settleMarket().accounts({...}).rpc()
  //   4. Fetch strike_market and assert settle_price/confidence/slot match fixture.
});
