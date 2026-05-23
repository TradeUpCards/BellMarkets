import { describe, it, expect, vi } from "vitest";
import {
  determineResult,
  handleSettleEvent,
  type FetchTokenHoldersFn,
  type TokenHolder,
} from "../../services/automation/src/indexer/settle-event-handler.js";
import * as queries from "../../services/automation/src/db/queries.js";
import type {
  SettleEvent,
  UserStreak,
} from "../../services/automation/src/db/types.js";

describe("determineResult", () => {
  it("YES outcome + held YES → won", () => {
    expect(determineResult("yes", "100", "0")).toBe("won");
  });

  it("YES outcome + held NO only → lost", () => {
    expect(determineResult("yes", "0", "100")).toBe("lost");
  });

  it("YES outcome + held both → won (held winning side)", () => {
    expect(determineResult("yes", "100", "100")).toBe("won");
  });

  it("NO outcome + held NO → won", () => {
    expect(determineResult("no", "0", "100")).toBe("won");
  });

  it("NO outcome + held YES only → lost", () => {
    expect(determineResult("no", "100", "0")).toBe("lost");
  });

  it("INVALID outcome + held both → invalid position", () => {
    expect(determineResult("invalid", "100", "100")).toBe("invalid");
  });

  it("INVALID outcome + held YES only → invalid (single-side invalid market — Aria's redeem_invalid path applies)", () => {
    expect(determineResult("invalid", "100", "0")).toBe("invalid");
  });

  it("Both held = 0 → abstained (zero-balance ATA)", () => {
    expect(determineResult("yes", "0", "0")).toBe("abstained");
    expect(determineResult("no", "0", "0")).toBe("abstained");
    expect(determineResult("invalid", "0", "0")).toBe("abstained");
  });

  it("Negative / non-numeric input safely defaults", () => {
    // Defensive — should never happen but guard against NaN.
    expect(determineResult("yes", "not-a-number", "0")).toBe("abstained");
  });
});

describe("handleSettleEvent — full pipeline with injected SQL + holders", () => {
  it("inserts settle event + per-user holds + applies streak updates", async () => {
    const inserts: Array<{ table: string; params: unknown }> = [];
    const streakUpdates: Array<{ user: string; result: string }> = [];

    // Spy on queries.insertSettleEvent / insertUserMarketHold / applyResultToUserStreak
    const spyInsertSettleEvent = vi
      .spyOn(queries, "insertSettleEvent")
      .mockImplementation(async (input) => {
        inserts.push({ table: "settle_events", params: input });
        return 42;
      });
    const spyInsertHold = vi.spyOn(queries, "insertUserMarketHold").mockImplementation(async (input) => {
      inserts.push({ table: "user_market_holds", params: input });
      return 100 + inserts.length;
    });
    const spyApplyStreak = vi
      .spyOn(queries, "applyResultToUserStreak")
      .mockImplementation(async (user, result): Promise<UserStreak> => {
        streakUpdates.push({ user, result });
        return {
          userPubkey: user,
          currentStreak: result === "won" ? 1 : 0,
          longestStreak: 1,
          totalMarketsWon: result === "won" ? 1 : 0,
          totalMarketsTraded: 1,
          lastResult: result === "abstained" ? undefined : (result as UserStreak["lastResult"]),
          lastSettleAt: new Date(),
          updatedAt: new Date(),
        };
      });

    const fetchHolders: FetchTokenHoldersFn = async () => [
      { ownerPubkey: "alice", yesHeld: "100", noHeld: "0" },
      { ownerPubkey: "bob", yesHeld: "0", noHeld: "100" },
      { ownerPubkey: "carol", yesHeld: "0", noHeld: "0" }, // abstain
    ];

    const result = await handleSettleEvent(
      {
        marketPubkey: "Market1",
        yesMint: "YesMint",
        noMint: "NoMint",
        ticker: "META",
        expiryUnix: 1748000000,
        outcome: "yes",
        settlePrice: "610.00",
        settleSlot: 12345,
        txSig: "SettleTxSig",
      },
      { fetchTokenHolders: fetchHolders },
    );

    expect(result.settleEventId).toBe(42);
    expect(result.holdersProcessed).toBe(3);
    expect(result.winners).toBe(1); // alice
    expect(result.losers).toBe(1); // bob
    expect(result.abstainers).toBe(1); // carol
    expect(result.invalidPositions).toBe(0);

    // settle_events insert
    expect(spyInsertSettleEvent).toHaveBeenCalledTimes(1);
    // 3 holds inserted (including the abstain row)
    expect(spyInsertHold).toHaveBeenCalledTimes(3);
    // 2 streak updates (skip abstain)
    expect(spyApplyStreak).toHaveBeenCalledTimes(2);
    expect(streakUpdates).toEqual([
      { user: "alice", result: "won" },
      { user: "bob", result: "lost" },
    ]);

    spyInsertSettleEvent.mockRestore();
    spyInsertHold.mockRestore();
    spyApplyStreak.mockRestore();
  });

  it("propagates invalid outcome to user_market_holds + skips win/loss streak update for unique-position cases", async () => {
    const streakUpdates: Array<{ user: string; result: string }> = [];
    const spyInsertSettleEvent = vi.spyOn(queries, "insertSettleEvent").mockResolvedValue(99);
    const spyInsertHold = vi.spyOn(queries, "insertUserMarketHold").mockResolvedValue(1);
    const spyApplyStreak = vi
      .spyOn(queries, "applyResultToUserStreak")
      .mockImplementation(async (user, result) => {
        streakUpdates.push({ user, result });
        return {
          userPubkey: user,
          currentStreak: 0,
          longestStreak: 0,
          totalMarketsWon: 0,
          totalMarketsTraded: 1,
          lastResult: "invalid",
          lastSettleAt: new Date(),
          updatedAt: new Date(),
        };
      });

    const holders: TokenHolder[] = [
      { ownerPubkey: "dave", yesHeld: "50", noHeld: "50" },
    ];

    const result = await handleSettleEvent(
      {
        marketPubkey: "Mkt",
        yesMint: "Y",
        noMint: "N",
        ticker: "TSLA",
        expiryUnix: 1748000000,
        outcome: "invalid",
        settlePrice: undefined,
        settleSlot: 999,
        txSig: "InvalidTx",
      },
      { fetchTokenHolders: async () => holders },
    );

    expect(result.invalidPositions).toBe(1);
    expect(streakUpdates).toEqual([{ user: "dave", result: "invalid" }]);

    spyInsertSettleEvent.mockRestore();
    spyInsertHold.mockRestore();
    spyApplyStreak.mockRestore();
  });

  it("is idempotent — re-running for same tx_sig does not multi-count", async () => {
    // We trust the SQL-layer ON CONFLICT to dedupe. Here we just verify the
    // function passes the same tx_sig through and lets the DB handle it.
    const spyInsertSettleEvent = vi.spyOn(queries, "insertSettleEvent").mockResolvedValue(7);
    vi.spyOn(queries, "insertUserMarketHold").mockResolvedValue(1);
    vi.spyOn(queries, "applyResultToUserStreak").mockResolvedValue({
      userPubkey: "x",
      currentStreak: 1,
      longestStreak: 1,
      totalMarketsWon: 1,
      totalMarketsTraded: 1,
      lastResult: "won",
      lastSettleAt: new Date(),
      updatedAt: new Date(),
    } as UserStreak);

    const fetchHolders: FetchTokenHoldersFn = async () => [
      { ownerPubkey: "x", yesHeld: "10", noHeld: "0" },
    ];

    const a = await handleSettleEvent(
      { marketPubkey: "M", yesMint: "Y", noMint: "N", ticker: "AAPL", expiryUnix: 1, outcome: "yes", settlePrice: "1", settleSlot: 1, txSig: "SameTx" },
      { fetchTokenHolders: fetchHolders },
    );
    const b = await handleSettleEvent(
      { marketPubkey: "M", yesMint: "Y", noMint: "N", ticker: "AAPL", expiryUnix: 1, outcome: "yes", settlePrice: "1", settleSlot: 1, txSig: "SameTx" },
      { fetchTokenHolders: fetchHolders },
    );

    expect(a.settleEventId).toBe(7);
    expect(b.settleEventId).toBe(7); // same row id returned by ON CONFLICT
    expect(spyInsertSettleEvent).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });
});

// Suppress the unused SettleEvent import (helps reviewer see it's typed)
const _t: SettleEvent | undefined = undefined;
void _t;
