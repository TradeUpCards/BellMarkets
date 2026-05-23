import { describe, it, expect } from "vitest";
import {
  TICKER_DEFAULTS,
  roundToTick,
  computeStrikeGrid,
  driftBps,
  expandedStrikeGrid,
  phaseLabelToOnChainCode,
} from "../../services/automation/src/ticker-config.js";
import { MAG7 } from "../../services/automation/src/types.js";

describe("TICKER_DEFAULTS — per-ticker constants per DR-005 + DR-006", () => {
  it("covers all 7 MAG7 tickers exactly", () => {
    for (const ticker of MAG7) {
      expect(TICKER_DEFAULTS[ticker]).toBeDefined();
    }
    expect(Object.keys(TICKER_DEFAULTS).sort()).toEqual([...MAG7].sort());
  });

  it("NVDA / META / TSLA: 30% cap, $5 tick, 8% threshold", () => {
    for (const t of ["NVDA", "META", "TSLA"] as const) {
      expect(TICKER_DEFAULTS[t].defaultDeviationCapBps).toBe(3000);
      expect(TICKER_DEFAULTS[t].strikeTickSizeUsd).toBe(5);
      expect(TICKER_DEFAULTS[t].wildSwingThresholdBps).toBe(800);
    }
  });

  it("AMZN: 20% cap, $2 tick, 6% threshold", () => {
    expect(TICKER_DEFAULTS.AMZN.defaultDeviationCapBps).toBe(2000);
    expect(TICKER_DEFAULTS.AMZN.strikeTickSizeUsd).toBe(2);
    expect(TICKER_DEFAULTS.AMZN.wildSwingThresholdBps).toBe(600);
  });

  it("AAPL / MSFT / GOOGL: 15% cap, $1 tick, 4% threshold", () => {
    for (const t of ["AAPL", "MSFT", "GOOGL"] as const) {
      expect(TICKER_DEFAULTS[t].defaultDeviationCapBps).toBe(1500);
      expect(TICKER_DEFAULTS[t].strikeTickSizeUsd).toBe(1);
      expect(TICKER_DEFAULTS[t].wildSwingThresholdBps).toBe(400);
    }
  });
});

describe("roundToTick", () => {
  it("rounds to nearest multiple of tickSize, half-away-from-zero", () => {
    expect(roundToTick(610.0, 5)).toBe(610);
    expect(roundToTick(612.5, 5)).toBe(615);
    expect(roundToTick(612.4, 5)).toBe(610);
    expect(roundToTick(230, 1)).toBe(230);
    expect(roundToTick(229.6, 1)).toBe(230);
    expect(roundToTick(437.4, 2)).toBe(438);
    expect(roundToTick(437.0, 2)).toBe(438); // 437.0/2 = 218.5 → rounds to 219 * 2 = 438
  });

  it("rejects non-positive tickSize", () => {
    expect(() => roundToTick(100, 0)).toThrow();
    expect(() => roundToTick(100, -1)).toThrow();
  });

  it("rejects non-finite value", () => {
    expect(() => roundToTick(Number.NaN, 5)).toThrow();
    expect(() => roundToTick(Number.POSITIVE_INFINITY, 5)).toThrow();
  });
});

describe("computeStrikeGrid — ATM ± 3/6/9% at per-ticker tick size", () => {
  it("$610 META at $5 tick → 7 unique strikes", () => {
    // -9% = 555.1 → 555; -6% = 573.4 → 575; -3% = 591.7 → 590
    // close = 610; +3% = 628.3 → 630; +6% = 646.6 → 645; +9% = 664.9 → 665
    expect(computeStrikeGrid(610, 5)).toEqual([555, 575, 590, 610, 630, 645, 665]);
  });

  it("$230 AAPL at $1 tick → 7 strikes (no dedup at fine tick)", () => {
    // -9%=209.3→209; -6%=216.2→216; -3%=223.1→223; 230; +3%=236.9→237; +6%=243.8→244; +9%=250.7→251
    expect(computeStrikeGrid(230, 1)).toEqual([209, 216, 223, 230, 237, 244, 251]);
  });

  it("$437 AMZN at $2 tick → 7 strikes", () => {
    // -9%=397.67→398; -6%=410.78→410; -3%=423.89→424; 437→438; +3%=450.11→450; +6%=463.22→464; +9%=476.33→476
    expect(computeStrikeGrid(437, 2)).toEqual([398, 410, 424, 438, 450, 464, 476]);
  });

  it("returns sorted ascending", () => {
    const grid = computeStrikeGrid(437.5, 2);
    const sorted = [...grid].sort((a, b) => a - b);
    expect(grid).toEqual(sorted);
  });

  it("returns only unique values (per-ticker tick dedup property)", () => {
    const grid = computeStrikeGrid(100, 5);
    expect(new Set(grid).size).toBe(grid.length);
  });

  it("never returns non-positive strikes (degrades gracefully on tiny capCenter)", () => {
    const grid = computeStrikeGrid(5, 5);
    for (const s of grid) expect(s).toBeGreaterThan(0);
  });

  it("rejects non-positive capCenter", () => {
    expect(() => computeStrikeGrid(0, 5)).toThrow();
    expect(() => computeStrikeGrid(-10, 5)).toThrow();
  });
});

describe("driftBps", () => {
  it("0 when spot equals capCenter", () => {
    expect(driftBps(610, 610)).toBe(0);
  });

  it("167 bps for $610 vs $600 (1.67% drift)", () => {
    expect(driftBps(610, 600)).toBe(167);
  });

  it("833 bps for $550 vs $600 (8.33% drift, triggers 8% NVDA/META/TSLA threshold)", () => {
    expect(driftBps(550, 600)).toBe(833);
  });

  it("symmetric: drift up vs drift down equal at same magnitude", () => {
    expect(driftBps(610, 600)).toBe(driftBps(590, 600));
  });

  it("rejects non-positive capCenter", () => {
    expect(() => driftBps(100, 0)).toThrow();
  });
});

describe("expandedStrikeGrid — preserves existing strikes; adds fresh", () => {
  it("union of existing + new grid, sorted, unique", () => {
    const existing = [555, 575, 590, 610, 630, 645, 665];
    const expanded = expandedStrikeGrid(700, 5, existing);
    // New grid around $700, $5 tick (half-away-from-zero rounding):
    // -9%=637→635; -6%=658→660; -3%=679→680; 700; +3%=721→720; +6%=742→740; +9%=763→765
    expect(expanded).toContain(555); // existing preserved
    expect(expanded).toContain(700); // new center
    expect(expanded).toContain(765); // new far strike (rounded to $5 tick)
    expect(new Set(expanded).size).toBe(expanded.length);
    const sorted = [...expanded].sort((a, b) => a - b);
    expect(expanded).toEqual(sorted);
  });

  it("does not drop existing strikes that are outside the new spot's grid", () => {
    // Users with positions in strikes far from new spot must not have their
    // strike vanish mid-cycle.
    const existing = [400]; // wildly out-of-band relative to new spot
    const expanded = expandedStrikeGrid(700, 5, existing);
    expect(expanded).toContain(400);
  });

  it("never returns non-positive strikes", () => {
    const expanded = expandedStrikeGrid(10, 5, [-3, 0, 5]);
    for (const s of expanded) expect(s).toBeGreaterThan(0);
  });
});

describe("phaseLabelToOnChainCode — stable ordinal mapping", () => {
  it("0 = anchor, 1 = ah, 2 = pm, 3 = earnings-pre, 4 = earnings-restore", () => {
    expect(phaseLabelToOnChainCode("anchor")).toBe(0);
    expect(phaseLabelToOnChainCode("ah")).toBe(1);
    expect(phaseLabelToOnChainCode("pm")).toBe(2);
    expect(phaseLabelToOnChainCode("earnings-pre")).toBe(3);
    expect(phaseLabelToOnChainCode("earnings-restore")).toBe(4);
  });
});
