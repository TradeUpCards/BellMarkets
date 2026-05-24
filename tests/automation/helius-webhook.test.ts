import { describe, it, expect } from "vitest";
import {
  parseHeliusSettleWebhook,
  type HeliusEnhancedTx,
} from "../../services/automation/src/indexer/helius-webhook.js";

const OUR_PROGRAM_ID = "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV";
const OTHER_PROGRAM_ID = "Phoenix11111111111111111111111111111111111";

describe("parseHeliusSettleWebhook — anchor event path", () => {
  it("extracts settle event from MarketSettled anchor event", () => {
    const tx: HeliusEnhancedTx = {
      signature: "SettleTx1",
      slot: 12345,
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "MarketSettled",
            data: {
              market: "Market1",
              yesMint: "YesMint",
              noMint: "NoMint",
              expiryUnix: 1748000000,
              outcome: "yes",
              settlePrice: "610",
              settleSlot: 12345,
              ticker: "META",
            },
          },
        ],
      },
    };
    const events = parseHeliusSettleWebhook(tx, OUR_PROGRAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      marketPubkey: "Market1",
      yesMint: "YesMint",
      noMint: "NoMint",
      ticker: "META",
      expiryUnix: 1748000000,
      outcome: "yes",
      settlePrice: "610",
      settleSlot: 12345,
      txSig: "SettleTx1",
    });
  });

  it("handles snake_case keys", () => {
    const tx: HeliusEnhancedTx = {
      signature: "SettleTx2",
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "MarketSettled",
            data: {
              strike_market: "M",
              yes_mint: "Y",
              no_mint: "N",
              expiry_unix: 1,
              outcome: { no: {} },
              settle_price: 100,
              settle_slot: 1,
            },
          },
        ],
      },
    };
    const events = parseHeliusSettleWebhook(tx, OUR_PROGRAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("no");
    expect(events[0]!.marketPubkey).toBe("M");
  });

  it("parses Borsh enum outcome shapes — { yes: {} } / { no: {} } / { invalid: {} }", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ yes: {} }, "yes"],
      [{ yesWins: {} }, "yes"],
      [{ no: {} }, "no"],
      [{ noWins: {} }, "no"],
      [{ invalid: {} }, "invalid"],
      [{ unsettled: {} }, "unsettled"],
    ];
    for (const [outcomeShape, expected] of cases) {
      const tx: HeliusEnhancedTx = {
        signature: `tx-${expected}`,
        events: {
          anchor: [
            {
              programId: OUR_PROGRAM_ID,
              name: "MarketSettled",
              data: {
                market: "M",
                yesMint: "Y",
                noMint: "N",
                expiryUnix: 1,
                outcome: outcomeShape,
              },
            },
          ],
        },
      };
      const events = parseHeliusSettleWebhook(tx, OUR_PROGRAM_ID);
      expect(events[0]!.outcome).toBe(expected);
    }
  });

  it("ignores anchor events from OTHER program IDs", () => {
    const tx: HeliusEnhancedTx = {
      signature: "tx",
      events: {
        anchor: [
          {
            programId: OTHER_PROGRAM_ID,
            name: "MarketSettled",
            data: { market: "M", yesMint: "Y", noMint: "N", expiryUnix: 1, outcome: "yes" },
          },
        ],
      },
    };
    expect(parseHeliusSettleWebhook(tx, OUR_PROGRAM_ID)).toEqual([]);
  });

  it("returns [] when no anchor events nor instructions match", () => {
    const tx: HeliusEnhancedTx = {
      signature: "tx",
      events: { anchor: [] },
      instructions: [],
    };
    expect(parseHeliusSettleWebhook(tx, OUR_PROGRAM_ID)).toEqual([]);
  });

  it("accepts both single tx and tx array payloads", () => {
    const single: HeliusEnhancedTx = {
      signature: "s",
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "MarketSettled",
            data: { market: "M", yesMint: "Y", noMint: "N", expiryUnix: 1, outcome: "yes" },
          },
        ],
      },
    };
    expect(parseHeliusSettleWebhook(single, OUR_PROGRAM_ID)).toHaveLength(1);
    expect(parseHeliusSettleWebhook([single, single], OUR_PROGRAM_ID)).toHaveLength(2);
  });
});

describe("parseHeliusSettleWebhook — fallback discriminator path", () => {
  it("matches instructions whose data starts with the settle_market discriminator", async () => {
    // Note: the fallback path returns yesMint/noMint as empty strings —
    // it CANNOT recover those without the anchor event. The "valid" return
    // here is purely so the caller knows the tx is a settle (so they can
    // enrich the mints via program.account.strikeMarket.fetch).
    // Use the live-computed discriminator (sha256("global:settle_market")[..8])
    // rather than a hardcoded placeholder so the test tracks any future
    // rename automatically.
    const { SETTLE_MARKET_DISCRIMINATOR_BASE58 } = await import("../../services/automation/src/indexer/helius-webhook.js");
    const tx: HeliusEnhancedTx = {
      signature: "tx-fallback",
      slot: 99,
      instructions: [
        {
          programId: OUR_PROGRAM_ID,
          accounts: ["Settler", "Config", "StrikeMarket", "PythFeed", "Clock"],
          data: SETTLE_MARKET_DISCRIMINATOR_BASE58 + "AAA", // discriminator + garbage tail
        },
      ],
    };
    const events = parseHeliusSettleWebhook(tx, OUR_PROGRAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.marketPubkey).toBe("StrikeMarket");
    expect(events[0]!.txSig).toBe("tx-fallback");
    expect(events[0]!.settleSlot).toBe(99);
    // Fallback path = caller must enrich
    expect(events[0]!.yesMint).toBe("");
    expect(events[0]!.noMint).toBe("");
  });
});

describe("recognizeBellMarketsIxs — observability over all 20 deploy-5 ixs", () => {
  it("recognizes every ix by its computed discriminator", async () => {
    const mod = await import("../../services/automation/src/indexer/helius-webhook.js");
    const {
      recognizeBellMarketsIxs,
      BELL_MARKETS_IX_NAMES,
      BELL_MARKETS_IX_DISCRIMINATORS,
    } = mod;
    for (const ixName of BELL_MARKETS_IX_NAMES) {
      const tx: HeliusEnhancedTx = {
        signature: `tx-${ixName}`,
        slot: 1,
        instructions: [
          {
            programId: OUR_PROGRAM_ID,
            accounts: [],
            data: BELL_MARKETS_IX_DISCRIMINATORS[ixName] + "GARBAGETAIL",
          },
        ],
      };
      const observed = recognizeBellMarketsIxs(tx, OUR_PROGRAM_ID);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ txSig: `tx-${ixName}`, ixName, slot: 1 });
    }
  });

  it("ignores ixs from other programs", async () => {
    const mod = await import("../../services/automation/src/indexer/helius-webhook.js");
    const { recognizeBellMarketsIxs, BELL_MARKETS_IX_DISCRIMINATORS } = mod;
    const tx: HeliusEnhancedTx = {
      signature: "tx",
      instructions: [
        {
          programId: OTHER_PROGRAM_ID,
          accounts: [],
          data: BELL_MARKETS_IX_DISCRIMINATORS.settle_market + "AAA",
        },
      ],
    };
    expect(recognizeBellMarketsIxs(tx, OUR_PROGRAM_ID)).toEqual([]);
  });

  it("returns empty array when no Bell Markets ix in the payload", async () => {
    const mod = await import("../../services/automation/src/indexer/helius-webhook.js");
    const { recognizeBellMarketsIxs } = mod;
    const tx: HeliusEnhancedTx = {
      signature: "tx",
      instructions: [
        {
          programId: OUR_PROGRAM_ID,
          accounts: [],
          data: "thisIsNotAnyKnownIx",
        },
      ],
    };
    expect(recognizeBellMarketsIxs(tx, OUR_PROGRAM_ID)).toEqual([]);
  });

  it("counts multiple ixs per tx (Anchor allows multi-ix txs)", async () => {
    const mod = await import("../../services/automation/src/indexer/helius-webhook.js");
    const { recognizeBellMarketsIxs, BELL_MARKETS_IX_DISCRIMINATORS } = mod;
    const tx: HeliusEnhancedTx = {
      signature: "tx-multi",
      slot: 7,
      instructions: [
        {
          programId: OUR_PROGRAM_ID,
          accounts: [],
          data: BELL_MARKETS_IX_DISCRIMINATORS.mint_pair + "AAA",
        },
        {
          programId: OUR_PROGRAM_ID,
          accounts: [],
          data: BELL_MARKETS_IX_DISCRIMINATORS.redeem_pair + "BBB",
        },
      ],
    };
    const observed = recognizeBellMarketsIxs(tx, OUR_PROGRAM_ID);
    expect(observed).toHaveLength(2);
    expect(observed.map((o) => o.ixName).sort()).toEqual(["mint_pair", "redeem_pair"]);
  });
});

describe("BELL_MARKETS_IX_NAMES — coverage check", () => {
  it("includes all 10 new deploy-5 ixs Tate flagged for indexing", async () => {
    const mod = await import("../../services/automation/src/indexer/helius-webhook.js");
    const { BELL_MARKETS_IX_NAMES } = mod;
    const expected = [
      "user_create_strike_market",
      "update_ticker_config",
      "initialize_fee_config",
      "update_fee_config",
      "initialize_rewards_pools",
      "commit_leaderboard_root",
      "distribute_weekly_rewards",
      "distribute_monthly_rewards",
      "force_redeem",
      "close_settled_market",
    ];
    for (const name of expected) {
      expect(BELL_MARKETS_IX_NAMES).toContain(name);
    }
  });

  it("totals exactly 20 ixs (matches Aria's deploy-5 IDL ix_count)", async () => {
    const mod = await import("../../services/automation/src/indexer/helius-webhook.js");
    const { BELL_MARKETS_IX_NAMES } = mod;
    expect(BELL_MARKETS_IX_NAMES).toHaveLength(20);
  });
});

describe("parseHeliusSettleWebhook — defensive cases", () => {
  it("missing market field → drops the event silently", () => {
    const tx: HeliusEnhancedTx = {
      signature: "tx",
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "MarketSettled",
            data: { yesMint: "Y", noMint: "N", expiryUnix: 1, outcome: "yes" },
          },
        ],
      },
    };
    expect(parseHeliusSettleWebhook(tx, OUR_PROGRAM_ID)).toEqual([]);
  });

  it("missing outcome → drops the event silently", () => {
    const tx: HeliusEnhancedTx = {
      signature: "tx",
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "MarketSettled",
            data: { market: "M", yesMint: "Y", noMint: "N", expiryUnix: 1 },
          },
        ],
      },
    };
    expect(parseHeliusSettleWebhook(tx, OUR_PROGRAM_ID)).toEqual([]);
  });
});
