import { describe, it, expect } from "vitest";
import {
  computeStrikesForStock,
  buildStrikeSet,
  roundToNearest,
} from "../../services/automation/src/strike-calc.js";

// Cases verified against the PRD ("Strike Selection" → Algorithm + Examples,
// page 2). The PRD specifies ±3%, ±6%, ±9% from previous close, rounded to
// the nearest $10, plus the rounded previous close as a 7th strike.

describe("computeStrikesForStock — PRD-verified examples", () => {
  it("META prev close $680 → 7 unique strikes [620, 640, 660, 680, 700, 720, 740]", () => {
    // PRD table:
    //   -9% 620 / -6% 640 / -3% 660 / close 680 / +3% 700 / +6% 720 / +9% 740
    // All seven are distinct so no dedup happens for META.
    expect(computeStrikesForStock(680)).toEqual([620, 640, 660, 680, 700, 720, 740]);
  });

  it("AAPL prev close $230 → 5 unique strikes [210, 220, 230, 240, 250] (low-priced dedup)", () => {
    // PRD table:
    //   -9% 210 / -6% 220 / -3% 220 (dedup) / close 230 / +3% 240 / +6% 240 (dedup) / +9% 250
    // The ±3% and ±6% candidates collapse onto the same $10 buckets.
    expect(computeStrikesForStock(230)).toEqual([210, 220, 230, 240, 250]);
  });
});

describe("computeStrikesForStock — boundary + property cases", () => {
  it("returns sorted ascending output", () => {
    const result = computeStrikesForStock(437.5);
    const sorted = [...result].sort((a, b) => a - b);
    expect(result).toEqual(sorted);
  });

  it("returns only unique values", () => {
    const result = computeStrikesForStock(230);
    expect(new Set(result).size).toBe(result.length);
  });

  it("every output strike is a multiple of 10", () => {
    for (const prev of [37, 99, 230, 437.5, 680, 1234, 9001]) {
      const result = computeStrikesForStock(prev);
      for (const s of result) expect(s % 10).toBe(0);
    }
  });

  it("high-priced stock ($1234) → no dedup, 7 unique strikes", () => {
    // 1234 * 0.91 = 1122.94 → 1120; * 0.94 = 1159.96 → 1160; * 0.97 = 1196.98 → 1200
    // * 1.03 = 1271.02 → 1270; * 1.06 = 1308.04 → 1310; * 1.09 = 1345.06 → 1350
    // close = 1230. Seven distinct.
    expect(computeStrikesForStock(1234)).toEqual([1120, 1160, 1200, 1230, 1270, 1310, 1350]);
  });

  it("includes the rounded previous close (PRD 7th-strike rule)", () => {
    // For META, previousClose rounds to 680, and 680 should be present.
    expect(computeStrikesForStock(680)).toContain(680);
    // For an off-grid prev close like 681.5 (rounds to 680), 680 should be present.
    expect(computeStrikesForStock(681.5)).toContain(680);
  });

  it("rejects non-positive or non-finite previousClose", () => {
    expect(() => computeStrikesForStock(0)).toThrow();
    expect(() => computeStrikesForStock(-50)).toThrow();
    expect(() => computeStrikesForStock(Number.NaN)).toThrow();
    expect(() => computeStrikesForStock(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("very-low-price stock ($5) — defensive non-positive-filter doesn't blow up; output is non-empty + positive + sorted", () => {
    // 5 * 0.91 = 4.55 → rounds to 0 → filtered; 5 * 0.94 = 4.7 → 0 → filtered;
    // 5 * 0.97 = 4.85 → 0 → filtered; close = 5 → 10 (rounds up).
    // 5 * 1.03 = 5.15 → 10; 5 * 1.06 = 5.3 → 10; 5 * 1.09 = 5.45 → 10.
    // After dedup: [10]. Single strike — the algorithm degrades gracefully
    // rather than producing zeros / negatives.
    const result = computeStrikesForStock(5);
    expect(result.length).toBeGreaterThan(0);
    for (const s of result) expect(s).toBeGreaterThan(0);
    const sorted = [...result].sort((a, b) => a - b);
    expect(result).toEqual(sorted);
    expect(result).toEqual([10]);
  });
});

describe("roundToNearest", () => {
  it("rounds half-away-from-zero per JS Math.round semantics", () => {
    expect(roundToNearest(5, 10)).toBe(10);
    expect(roundToNearest(14.99, 10)).toBe(10);
    expect(roundToNearest(15, 10)).toBe(20);
    expect(roundToNearest(216.2, 10)).toBe(220);
    expect(roundToNearest(223.1, 10)).toBe(220);
  });

  it("rejects non-positive step", () => {
    expect(() => roundToNearest(100, 0)).toThrow();
    expect(() => roundToNearest(100, -5)).toThrow();
  });
});

describe("buildStrikeSet", () => {
  it("wraps strikes with ticker + previousClose metadata", () => {
    const set = buildStrikeSet("META", 680);
    expect(set.ticker).toBe("META");
    expect(set.previousClose).toBe(680);
    expect(set.strikes).toEqual([620, 640, 660, 680, 700, 720, 740]);
  });
});
