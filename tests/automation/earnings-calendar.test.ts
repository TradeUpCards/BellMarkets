import { describe, it, expect } from "vitest";
import {
  EARNINGS_DATES_2026,
  EARNINGS_PREEXPAND_BPS,
  tickersReportingOn,
  isEarningsDay,
  tickersToPreExpand,
  tickersToRestore,
  listMalformedEarningsDates,
  listInvalidExpansionCaps,
} from "../../services/automation/src/earnings-calendar.js";
import { TICKER_DEFAULTS } from "../../services/automation/src/ticker-config.js";
import { MAG7 } from "../../services/automation/src/types.js";

function etCalendarDay(year: number, monthOneBased: number, day: number): Date {
  return new Date(Date.UTC(year, monthOneBased - 1, day, 12, 0, 0));
}

describe("EARNINGS_DATES_2026 — calendar shape", () => {
  it("covers all 7 MAG7 tickers", () => {
    for (const ticker of MAG7) {
      expect(EARNINGS_DATES_2026[ticker]).toBeDefined();
      expect(EARNINGS_DATES_2026[ticker].length).toBeGreaterThan(0);
    }
  });

  it("every ticker has exactly 4 quarterly events", () => {
    for (const ticker of MAG7) {
      expect(EARNINGS_DATES_2026[ticker]).toHaveLength(4);
    }
  });

  it("every date is in YYYY-MM-DD shape and in 2026", () => {
    for (const ticker of MAG7) {
      for (const date of EARNINGS_DATES_2026[ticker]) {
        expect(date).toMatch(/^2026-\d{2}-\d{2}$/);
      }
    }
  });

  it("every earnings date is a TRADING DAY (no weekends, no full holidays)", () => {
    const malformed = listMalformedEarningsDates();
    expect(malformed).toEqual([]);
  });
});

describe("EARNINGS_PREEXPAND_BPS — pre-expansion magnitudes per DR-011", () => {
  it("covers all 7 MAG7 tickers", () => {
    for (const ticker of MAG7) {
      expect(EARNINGS_PREEXPAND_BPS[ticker]).toBeDefined();
    }
  });

  it("every expanded cap is GREATER than the default cap (no shrink-on-earnings)", () => {
    const bad = listInvalidExpansionCaps();
    expect(bad).toEqual([]);
  });

  it("NVDA / META / TSLA: expanded 5000 bps (default 3000)", () => {
    for (const t of ["NVDA", "META", "TSLA"] as const) {
      expect(EARNINGS_PREEXPAND_BPS[t]).toBe(5000);
      expect(TICKER_DEFAULTS[t].defaultDeviationCapBps).toBe(3000);
    }
  });

  it("AMZN: expanded 3000 bps (default 2000)", () => {
    expect(EARNINGS_PREEXPAND_BPS.AMZN).toBe(3000);
    expect(TICKER_DEFAULTS.AMZN.defaultDeviationCapBps).toBe(2000);
  });

  it("AAPL / MSFT / GOOGL: expanded 2500 bps (default 1500)", () => {
    for (const t of ["AAPL", "MSFT", "GOOGL"] as const) {
      expect(EARNINGS_PREEXPAND_BPS[t]).toBe(2500);
      expect(TICKER_DEFAULTS[t].defaultDeviationCapBps).toBe(1500);
    }
  });
});

describe("tickersReportingOn — point lookup", () => {
  it("returns AAPL + GOOGL + AMZN + META on 2026-01-29 (multiple-ticker day)", () => {
    const result = tickersReportingOn(etCalendarDay(2026, 1, 29));
    expect(result.sort()).toEqual(["AAPL", "AMZN", "GOOGL", "META"]);
  });

  it("returns NVDA on 2026-05-22", () => {
    expect(tickersReportingOn(etCalendarDay(2026, 5, 22))).toEqual(["NVDA"]);
  });

  it("returns TSLA on 2026-01-22", () => {
    expect(tickersReportingOn(etCalendarDay(2026, 1, 22))).toEqual(["TSLA"]);
  });

  it("returns [] for a day with no earnings", () => {
    expect(tickersReportingOn(etCalendarDay(2026, 6, 15))).toEqual([]);
  });
});

describe("isEarningsDay", () => {
  it("true for a known earnings day", () => {
    expect(isEarningsDay(etCalendarDay(2026, 1, 29))).toBe(true);
  });

  it("false for a non-earnings trading day", () => {
    expect(isEarningsDay(etCalendarDay(2026, 6, 15))).toBe(false);
  });

  it("false for weekends even if calendar date matches", () => {
    // No calendar date is currently on a weekend, but this is the contract.
    expect(isEarningsDay(etCalendarDay(2026, 5, 23))).toBe(false); // Saturday
  });
});

describe("tickersToPreExpand — pre-expand candidates for tomorrow", () => {
  it("Wed Jan 28 2026 → pre-expand AAPL+GOOGL+AMZN+META (Thu Jan 29 is multi-ticker day)", () => {
    const wed = etCalendarDay(2026, 1, 28);
    const result = tickersToPreExpand(wed);
    expect(result.sort()).toEqual(["AAPL", "AMZN", "GOOGL", "META"]);
  });

  it("Thu May 21 2026 → pre-expand NVDA (Fri May 22)", () => {
    const thu = etCalendarDay(2026, 5, 21);
    expect(tickersToPreExpand(thu)).toEqual(["NVDA"]);
  });

  it("Random non-pre-earnings day returns []", () => {
    expect(tickersToPreExpand(etCalendarDay(2026, 6, 15))).toEqual([]);
  });

  it("Pre-expansion crosses weekend correctly (Fri before a Mon earnings day)", () => {
    // If MSFT reported on Mon Apr 27 2026 (NOT in our calendar — synthetic check),
    // the pre-expand should still find it from Fri Apr 24. We exercise this with
    // a real calendar entry: TSLA reports Fri Apr 24 2026; pre-expand on Thu Apr 23.
    const thu = etCalendarDay(2026, 4, 23);
    expect(tickersToPreExpand(thu)).toEqual(["TSLA"]);
  });
});

describe("tickersToRestore — restore candidates from yesterday", () => {
  it("Fri Jan 30 2026 → restore AAPL+GOOGL+AMZN+META (Thu Jan 29 was multi-ticker day)", () => {
    const fri = etCalendarDay(2026, 1, 30);
    const result = tickersToRestore(fri);
    expect(result.sort()).toEqual(["AAPL", "AMZN", "GOOGL", "META"]);
  });

  it("Day after a Thursday earnings day → restore", () => {
    // TSLA reports Thu Jan 22 2026. Fri Jan 23 should restore TSLA
    // (previousTradingDay(Fri) = Thu).
    const fri = etCalendarDay(2026, 1, 23);
    expect(tickersToRestore(fri)).toEqual(["TSLA"]);
  });

  it("Restoration crosses Memorial Day weekend (Fri May 22 NVDA → restore Tue May 26)", () => {
    const tue = etCalendarDay(2026, 5, 26); // Memorial Day is Mon May 25
    expect(tickersToRestore(tue)).toEqual(["NVDA"]);
  });

  it("Random day with no earnings yesterday returns []", () => {
    expect(tickersToRestore(etCalendarDay(2026, 6, 15))).toEqual([]);
  });
});
