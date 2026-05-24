import { describe, it, expect } from "vitest";
import {
  isoWeekInfo,
  isoWeekId,
  weeklyPeriodStartUtc,
  weeklyPeriodEndUtc,
  monthlyPeriodId,
  monthlyPeriodStartUtc,
  monthlyPeriodEndUtc,
  lastFridayOfMonth,
  isLastTradingFridayOfMonth,
  periodForDate,
} from "../../services/automation/src/indexer/periods.js";

function etCalendarDay(year: number, monthOneBased: number, day: number): Date {
  return new Date(Date.UTC(year, monthOneBased - 1, day, 12, 0, 0));
}

describe("isoWeekInfo", () => {
  it("Fri May 22 2026 → ISO 2026-W21", () => {
    expect(isoWeekInfo(etCalendarDay(2026, 5, 22))).toEqual({ year: 2026, week: 21 });
  });

  it("Mon Jan 5 2026 → ISO 2026-W02 (Jan 1 2026 = Thursday)", () => {
    // Jan 1 2026 is Thursday → contains the first Thursday → ISO Week 1.
    // Mon Jan 5 starts ISO Week 2.
    expect(isoWeekInfo(etCalendarDay(2026, 1, 5))).toEqual({ year: 2026, week: 2 });
  });

  it("Thu Jan 1 2026 → ISO 2026-W01", () => {
    expect(isoWeekInfo(etCalendarDay(2026, 1, 1))).toEqual({ year: 2026, week: 1 });
  });
});

describe("isoWeekId", () => {
  it("composes year + week into a stable int", () => {
    expect(isoWeekId(2026, 21)).toBe(202621);
    expect(isoWeekId(2026, 1)).toBe(202601);
  });
});

describe("weeklyPeriodStartUtc / weeklyPeriodEndUtc", () => {
  it("anchors to Monday 00:00 ET of the ISO week containing `date`", () => {
    // Fri May 22 2026 — ISO week starts Mon May 18 2026 at 00:00 EDT = 04:00 UTC.
    const start = weeklyPeriodStartUtc(etCalendarDay(2026, 5, 22));
    expect(start.toISOString()).toBe("2026-05-18T04:00:00.000Z");
  });

  it("end = next Monday 00:00 ET", () => {
    const end = weeklyPeriodEndUtc(etCalendarDay(2026, 5, 22));
    expect(end.toISOString()).toBe("2026-05-25T04:00:00.000Z");
  });

  it("handles DST start cleanly (March 2026)", () => {
    // ISO week containing Mon Mar 9 2026 starts on Mon Mar 9 (the first
    // full EDT day). Period start = Mar 9 00:00 EDT = 04:00 UTC.
    const start = weeklyPeriodStartUtc(etCalendarDay(2026, 3, 9));
    expect(start.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("handles DST end cleanly (November 2026)", () => {
    // ISO week containing Mon Nov 2 2026 (first day after DST ends).
    // Mon Nov 2 00:00 EST = 05:00 UTC.
    const start = weeklyPeriodStartUtc(etCalendarDay(2026, 11, 2));
    expect(start.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("monthlyPeriodId / monthlyPeriodStartUtc / monthlyPeriodEndUtc", () => {
  it("composes year + month", () => {
    expect(monthlyPeriodId(2026, 5)).toBe(202605);
    expect(monthlyPeriodId(2026, 12)).toBe(202612);
  });

  it("EDT month: May 2026 start = 2026-05-01 04:00 UTC", () => {
    expect(monthlyPeriodStartUtc(2026, 5).toISOString()).toBe("2026-05-01T04:00:00.000Z");
  });

  it("EST month: Dec 2026 start = 2026-12-01 05:00 UTC", () => {
    expect(monthlyPeriodStartUtc(2026, 12).toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });

  it("Dec end = Jan 1 next year (year boundary)", () => {
    expect(monthlyPeriodEndUtc(2026, 12).toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  it("EDT-to-EST transition month: Nov end aligns to next month's offset", () => {
    // Nov 2026 ends Dec 1 00:00 EST = 05:00 UTC
    expect(monthlyPeriodEndUtc(2026, 11).toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });
});

describe("lastFridayOfMonth", () => {
  it("May 2026 → Fri May 29", () => {
    expect(lastFridayOfMonth(2026, 5).getUTCDate()).toBe(29);
  });

  it("Dec 2026 → Fri Dec 25 (Christmas Day — full holiday!)", () => {
    // The function returns Dec 25 (the last Friday in calendar terms).
    // isLastTradingFridayOfMonth() applies the trading-day gate on top.
    expect(lastFridayOfMonth(2026, 12).getUTCDate()).toBe(25);
  });

  it("Jan 2026 → Fri Jan 30", () => {
    expect(lastFridayOfMonth(2026, 1).getUTCDate()).toBe(30);
  });
});

describe("isLastTradingFridayOfMonth", () => {
  it("true for Fri May 29 2026", () => {
    expect(isLastTradingFridayOfMonth(etCalendarDay(2026, 5, 29))).toBe(true);
  });

  it("false for Fri May 22 2026 (not the last)", () => {
    expect(isLastTradingFridayOfMonth(etCalendarDay(2026, 5, 22))).toBe(false);
  });

  it("false for Fri Dec 25 2026 — last Friday but Christmas full holiday", () => {
    expect(isLastTradingFridayOfMonth(etCalendarDay(2026, 12, 25))).toBe(false);
  });

  it("false for Thursdays / non-Fridays in general", () => {
    expect(isLastTradingFridayOfMonth(etCalendarDay(2026, 5, 28))).toBe(false);
  });
});

describe("periodForDate — high-level lookup", () => {
  it("Fri May 22 2026, weekly → ISO 2026-W21", () => {
    const p = periodForDate(etCalendarDay(2026, 5, 22), "weekly");
    expect(p.kind).toBe("weekly");
    expect(p.id).toBe(202621);
    expect(p.start.toISOString()).toBe("2026-05-18T04:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-05-25T04:00:00.000Z");
  });

  it("Fri May 29 2026, monthly → 202605", () => {
    const p = periodForDate(etCalendarDay(2026, 5, 29), "monthly");
    expect(p.kind).toBe("monthly");
    expect(p.id).toBe(202605);
    expect(p.start.toISOString()).toBe("2026-05-01T04:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-06-01T04:00:00.000Z");
  });
});
