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

  it("totals exactly 26 ixs (20 through deploy_index=6 + 6 DR-020 CLOB ixs)", async () => {
    const mod = await import("../../services/automation/src/indexer/helius-webhook.js");
    const { BELL_MARKETS_IX_NAMES } = mod;
    expect(BELL_MARKETS_IX_NAMES).toHaveLength(26);
  });

  it("includes the 6 DR-020 CLOB ixs (init/grow_order_book, place/cancel_order, match_orders, update_usdc_mint)", async () => {
    const mod = await import("../../services/automation/src/indexer/helius-webhook.js");
    const { BELL_MARKETS_IX_NAMES } = mod;
    for (const name of [
      "init_order_book",
      "grow_order_book",
      "place_order",
      "cancel_order",
      "match_orders",
      "update_usdc_mint",
    ]) {
      expect(BELL_MARKETS_IX_NAMES).toContain(name);
    }
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

// ---------------------------------------------------------------------------
// DR-020 — in-program CLOB event parsing (deploy_index=7 scaffolding)
// ---------------------------------------------------------------------------

import { parseClobEvents } from "../../services/automation/src/indexer/helius-webhook.js";

describe("parseClobEvents — OrderBookInitialized", () => {
  it("extracts the four PDAs from a fresh init+grow tx", () => {
    const tx: HeliusEnhancedTx = {
      signature: "InitOBSig1",
      slot: 100,
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "OrderBookInitialized",
            data: {
              market: "MarketPK",
              orderBook: "OrderBookPK",
              usdcEscrow: "UsdcEscrowPK",
              yesEscrow: "YesEscrowPK",
            },
          },
        ],
      },
    };
    const out = parseClobEvents(tx, OUR_PROGRAM_ID);
    expect(out.orderBookInitialized).toHaveLength(1);
    expect(out.orderBookInitialized[0]).toEqual({
      txSig: "InitOBSig1",
      slot: 100,
      marketPubkey: "MarketPK",
      orderBookPubkey: "OrderBookPK",
      usdcEscrowPubkey: "UsdcEscrowPK",
      yesEscrowPubkey: "YesEscrowPK",
    });
  });

  it("tolerates snake_case keys (order_book / usdc_escrow / yes_escrow)", () => {
    const tx: HeliusEnhancedTx = {
      signature: "InitOBSig2",
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "order_book_initialized",
            data: {
              strike_market: "M",
              order_book: "OB",
              usdc_escrow: "UE",
              yes_escrow: "YE",
            },
          },
        ],
      },
    };
    const out = parseClobEvents(tx, OUR_PROGRAM_ID);
    expect(out.orderBookInitialized).toHaveLength(1);
    expect(out.orderBookInitialized[0]!.marketPubkey).toBe("M");
    expect(out.orderBookInitialized[0]!.orderBookPubkey).toBe("OB");
  });
});

describe("parseClobEvents — OrderPlaced", () => {
  it("parses a bid limit order with BN-style price/size/seq", () => {
    const tx: HeliusEnhancedTx = {
      signature: "PlaceSig1",
      slot: 200,
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "OrderPlaced",
            data: {
              market: "M",
              orderBook: "OB",
              owner: "OwnerPK",
              side: { bid: {} },
              price: "550000", // 0.55 in PRICE_SCALE 1e6
              size: "10000000", // 10 yes tokens at 6 decimals
              seq: "42",
            },
          },
        ],
      },
    };
    const out = parseClobEvents(tx, OUR_PROGRAM_ID);
    expect(out.orderPlaced).toHaveLength(1);
    expect(out.orderPlaced[0]).toMatchObject({
      txSig: "PlaceSig1",
      slot: 200,
      marketPubkey: "M",
      orderBookPubkey: "OB",
      ownerPubkey: "OwnerPK",
      side: "bid",
      price: "550000",
      size: "10000000",
      seq: "42",
    });
  });

  it("recognizes ask side via Borsh enum + string aliases", () => {
    const askEnum: HeliusEnhancedTx = {
      signature: "PlaceSig2",
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "OrderPlaced",
            data: {
              market: "M",
              orderBook: "OB",
              owner: "O",
              side: { ask: {} },
              price: 600000,
              size: 5_000_000,
              seq: 7,
            },
          },
        ],
      },
    };
    const askString: HeliusEnhancedTx = {
      signature: "PlaceSig3",
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "OrderPlaced",
            data: {
              market: "M",
              orderBook: "OB",
              owner: "O",
              side: "sell",
              price: 600000,
              size: 5_000_000,
              seq: 7,
            },
          },
        ],
      },
    };
    expect(parseClobEvents(askEnum, OUR_PROGRAM_ID).orderPlaced[0]!.side).toBe("ask");
    expect(parseClobEvents(askString, OUR_PROGRAM_ID).orderPlaced[0]!.side).toBe("ask");
  });
});

describe("parseClobEvents — OrderMatched", () => {
  it("parses a taker-buy fill (maker on ask side)", () => {
    const tx: HeliusEnhancedTx = {
      signature: "MatchSig1",
      slot: 300,
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "OrderMatched",
            data: {
              market: "M",
              orderBook: "OB",
              taker: "TakerPK",
              maker: "MakerPK",
              side: { ask: {} }, // resting maker side
              price: "600000",
              size: "2500000",
              takerSeq: "100",
              makerSeq: "55",
            },
          },
        ],
      },
    };
    const out = parseClobEvents(tx, OUR_PROGRAM_ID);
    expect(out.orderMatched).toHaveLength(1);
    expect(out.orderMatched[0]).toEqual({
      txSig: "MatchSig1",
      slot: 300,
      marketPubkey: "M",
      orderBookPubkey: "OB",
      takerPubkey: "TakerPK",
      makerPubkey: "MakerPK",
      side: "ask",
      price: "600000",
      size: "2500000",
      takerSeq: "100",
      makerSeq: "55",
    });
  });

  it("accepts crank-driven matches with missing takerSeq", () => {
    const tx: HeliusEnhancedTx = {
      signature: "CrankSig",
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "OrderMatched",
            data: {
              market: "M",
              order_book: "OB",
              taker: "Cranker",
              maker: "Resting",
              side: { bid: {} },
              fill_price: "550000",
              fill_size: "1000000",
              maker_seq: "33",
            },
          },
        ],
      },
    };
    const out = parseClobEvents(tx, OUR_PROGRAM_ID);
    expect(out.orderMatched).toHaveLength(1);
    expect(out.orderMatched[0]!.takerSeq).toBeUndefined();
    expect(out.orderMatched[0]!.side).toBe("bid");
  });
});

describe("parseClobEvents — OrderCancelled", () => {
  it("captures owner + side + refunded amount for a bid cancel", () => {
    const tx: HeliusEnhancedTx = {
      signature: "CancelSig1",
      slot: 400,
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "OrderCancelled",
            data: {
              market: "M",
              orderBook: "OB",
              owner: "OwnerPK",
              side: "bid",
              seq: "42",
              refundedAmount: "5500000", // 5.5 USDC refund on a 10-yes bid at 0.55 partial-filled
            },
          },
        ],
      },
    };
    const out = parseClobEvents(tx, OUR_PROGRAM_ID);
    expect(out.orderCancelled).toHaveLength(1);
    expect(out.orderCancelled[0]).toEqual({
      txSig: "CancelSig1",
      slot: 400,
      marketPubkey: "M",
      orderBookPubkey: "OB",
      ownerPubkey: "OwnerPK",
      side: "bid",
      seq: "42",
      refundedAmount: "5500000",
    });
  });

  it("missing refundedAmount is tolerated (older event shape)", () => {
    const tx: HeliusEnhancedTx = {
      signature: "CancelSig2",
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "OrderCancelled",
            data: {
              market: "M",
              orderBook: "OB",
              owner: "O",
              side: { ask: {} },
              seq: "12",
            },
          },
        ],
      },
    };
    const out = parseClobEvents(tx, OUR_PROGRAM_ID);
    expect(out.orderCancelled).toHaveLength(1);
    expect(out.orderCancelled[0]!.refundedAmount).toBeUndefined();
  });
});

describe("parseClobEvents — defensive cases", () => {
  it("returns all-empty groups for an empty payload", () => {
    const tx: HeliusEnhancedTx = { signature: "EmptyTx" };
    const out = parseClobEvents(tx, OUR_PROGRAM_ID);
    expect(out.orderBookInitialized).toEqual([]);
    expect(out.orderPlaced).toEqual([]);
    expect(out.orderMatched).toEqual([]);
    expect(out.orderCancelled).toEqual([]);
  });

  it("ignores events from a different program id", () => {
    const tx: HeliusEnhancedTx = {
      signature: "WrongProgTx",
      events: {
        anchor: [
          {
            programId: OTHER_PROGRAM_ID,
            name: "OrderPlaced",
            data: {
              market: "M",
              orderBook: "OB",
              owner: "O",
              side: { bid: {} },
              price: "1",
              size: "1",
              seq: "1",
            },
          },
        ],
      },
    };
    const out = parseClobEvents(tx, OUR_PROGRAM_ID);
    expect(out.orderPlaced).toEqual([]);
  });

  it("drops OrderPlaced with missing price", () => {
    const tx: HeliusEnhancedTx = {
      signature: "BadPlaceTx",
      events: {
        anchor: [
          {
            programId: OUR_PROGRAM_ID,
            name: "OrderPlaced",
            data: { market: "M", orderBook: "OB", owner: "O", side: "bid", size: "1", seq: "1" },
          },
        ],
      },
    };
    const out = parseClobEvents(tx, OUR_PROGRAM_ID);
    expect(out.orderPlaced).toEqual([]);
  });
});

describe("BELL_MARKETS_IX_DISCRIMINATORS — DR-020 CLOB ixs round-trip via recognizeBellMarketsIxs", () => {
  it("recognizes a place_order ix purely from its discriminator prefix", async () => {
    const mod = await import("../../services/automation/src/indexer/helius-webhook.js");
    const { BELL_MARKETS_IX_DISCRIMINATORS, recognizeBellMarketsIxs } = mod;
    const placeOrderDiscrim = BELL_MARKETS_IX_DISCRIMINATORS.place_order;
    const tx: HeliusEnhancedTx = {
      signature: "PlaceIxTx",
      slot: 999,
      instructions: [
        {
          programId: OUR_PROGRAM_ID,
          // Append arbitrary suffix; recognizer prefix-matches the first 8 bytes.
          data: placeOrderDiscrim + "AdditionalArgsBytes",
          accounts: [],
        },
      ],
    };
    const observed = recognizeBellMarketsIxs(tx, OUR_PROGRAM_ID);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ txSig: "PlaceIxTx", ixName: "place_order", slot: 999 });
  });

  it("recognizes update_usdc_mint via discriminator (admin ix)", async () => {
    const mod = await import("../../services/automation/src/indexer/helius-webhook.js");
    const { BELL_MARKETS_IX_DISCRIMINATORS, recognizeBellMarketsIxs } = mod;
    const tx: HeliusEnhancedTx = {
      signature: "FlipUsdcMintTx",
      instructions: [
        {
          programId: OUR_PROGRAM_ID,
          data: BELL_MARKETS_IX_DISCRIMINATORS.update_usdc_mint,
        },
      ],
    };
    const observed = recognizeBellMarketsIxs(tx, OUR_PROGRAM_ID);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.ixName).toBe("update_usdc_mint");
  });
});
