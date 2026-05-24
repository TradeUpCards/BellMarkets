import { describe, it, expect } from "vitest";
import {
  isTradingDay,
  isHalfDay,
  getCloseTime,
  nextTradingDay,
  toEtDateString,
  _internal,
} from "../../services/automation/src/calendar.js";

// Helper: construct a UTC Date for a specific ET calendar day at noon UTC.
// Using noon UTC keeps us safely inside one ET calendar day on either side of
// DST transitions (noon UTC = 7am EST or 8am EDT — both same ET calendar day).
function etCalendarDay(year: number, monthOneBased: number, day: number): Date {
  return new Date(Date.UTC(year, monthOneBased - 1, day, 12, 0, 0));
}

describe("toEtDateString — timezone correctness", () => {
  it("formats noon UTC as the correct ET calendar day", () => {
    // 2026-05-23 12:00 UTC = 2026-05-23 08:00 EDT — same calendar day.
    expect(toEtDateString(etCalendarDay(2026, 5, 23))).toBe("2026-05-23");
  });

  it("handles midnight UTC straddling the ET date line", () => {
    // 2026-05-23 00:00 UTC = 2026-05-22 20:00 EDT — PREVIOUS ET calendar day.
    expect(toEtDateString(new Date(Date.UTC(2026, 4, 23, 0, 0, 0)))).toBe("2026-05-22");
  });

  it("rejects invalid Date inputs", () => {
    expect(() => toEtDateString(new Date("not-a-date"))).toThrow();
  });
});

describe("isTradingDay — DR-007 full holidays + weekends", () => {
  const FULL_HOLIDAYS: Array<[number, number, number, string]> = [
    [2026, 1, 1, "New Year's Day"],
    [2026, 1, 19, "MLK Day"],
    [2026, 2, 16, "Presidents Day"],
    [2026, 4, 3, "Good Friday"],
    [2026, 5, 25, "Memorial Day"],
    [2026, 6, 19, "Juneteenth"],
    [2026, 7, 3, "Independence Day (observed)"],
    [2026, 9, 7, "Labor Day"],
    [2026, 11, 26, "Thanksgiving"],
    [2026, 12, 25, "Christmas Day"],
  ];

  for (const [y, m, d, label] of FULL_HOLIDAYS) {
    it(`returns false on ${label} (${y}-${m}-${d})`, () => {
      expect(isTradingDay(etCalendarDay(y, m, d))).toBe(false);
    });
  }

  it("returns false on Saturdays", () => {
    // 2026-05-23 is a Saturday — TODAY when this Day-5 work is being done.
    expect(isTradingDay(etCalendarDay(2026, 5, 23))).toBe(false);
  });

  it("returns false on Sundays", () => {
    // 2026-05-24 is a Sunday.
    expect(isTradingDay(etCalendarDay(2026, 5, 24))).toBe(false);
  });

  it("returns true on a normal weekday (Mon May 4 2026)", () => {
    expect(isTradingDay(etCalendarDay(2026, 5, 4))).toBe(true);
  });

  it("returns true on the Friday after Thanksgiving (half-day)", () => {
    // 2026-11-27 is the day after Thanksgiving — half-day, still a trading day.
    expect(isTradingDay(etCalendarDay(2026, 11, 27))).toBe(true);
  });

  it("returns true on Christmas Eve 2026 (half-day, Thursday)", () => {
    expect(isTradingDay(etCalendarDay(2026, 12, 24))).toBe(true);
  });
});

describe("isHalfDay — DR-007 half-day set", () => {
  it("returns true for the day after Thanksgiving (2026-11-27)", () => {
    expect(isHalfDay(etCalendarDay(2026, 11, 27))).toBe(true);
  });

  it("returns true for Christmas Eve 2026 (2026-12-24)", () => {
    expect(isHalfDay(etCalendarDay(2026, 12, 24))).toBe(true);
  });

  it("returns false on regular trading days", () => {
    expect(isHalfDay(etCalendarDay(2026, 5, 4))).toBe(false);
    expect(isHalfDay(etCalendarDay(2026, 11, 25))).toBe(false); // day before Thanksgiving
    expect(isHalfDay(etCalendarDay(2026, 12, 23))).toBe(false); // day before Christmas Eve
  });

  it("returns false on full holidays (mutually exclusive with FULL_HOLIDAYS)", () => {
    expect(isHalfDay(etCalendarDay(2026, 11, 26))).toBe(false); // Thanksgiving
    expect(isHalfDay(etCalendarDay(2026, 12, 25))).toBe(false); // Christmas
  });

  it("returns false on Jul 3 2026 (observed Independence Day = full holiday)", () => {
    // Critical: when Jul 4 falls on Saturday, Jul 3 is a FULL holiday, not a
    // half-day. The day-before-Jul-4 half-day pattern only applies when Jul 4
    // is a weekday.
    expect(isHalfDay(etCalendarDay(2026, 7, 3))).toBe(false);
    expect(isTradingDay(etCalendarDay(2026, 7, 3))).toBe(false);
  });
});

describe("getCloseTime — close times honoring DST + half-day", () => {
  it("regular EST trading day (Mon Jan 5 2026) closes at 16:00 ET = 21:00 UTC", () => {
    const close = getCloseTime(etCalendarDay(2026, 1, 5));
    expect(close.toISOString()).toBe("2026-01-05T21:00:00.000Z");
  });

  it("regular EDT trading day (Wed Apr 15 2026) closes at 16:00 ET = 20:00 UTC", () => {
    // After DST starts (Mar 8 2026): ET is UTC-4.
    const close = getCloseTime(etCalendarDay(2026, 4, 15));
    expect(close.toISOString()).toBe("2026-04-15T20:00:00.000Z");
  });

  it("regular EDT trading day immediately AFTER DST start (Mon Mar 9 2026)", () => {
    // DST starts Sun Mar 8 2026 at 2am ET. Mon Mar 9 is the first full EDT day.
    const close = getCloseTime(etCalendarDay(2026, 3, 9));
    expect(close.toISOString()).toBe("2026-03-09T20:00:00.000Z");
  });

  it("regular EDT trading day immediately BEFORE DST end (Fri Oct 30 2026)", () => {
    // DST ends Sun Nov 1 2026 at 2am ET. Fri Oct 30 is still EDT.
    const close = getCloseTime(etCalendarDay(2026, 10, 30));
    expect(close.toISOString()).toBe("2026-10-30T20:00:00.000Z");
  });

  it("regular EST trading day immediately AFTER DST end (Mon Nov 2 2026)", () => {
    const close = getCloseTime(etCalendarDay(2026, 11, 2));
    expect(close.toISOString()).toBe("2026-11-02T21:00:00.000Z");
  });

  it("half-day in EST (Fri Nov 27 2026) closes at 13:00 ET = 18:00 UTC", () => {
    const close = getCloseTime(etCalendarDay(2026, 11, 27));
    expect(close.toISOString()).toBe("2026-11-27T18:00:00.000Z");
  });

  it("half-day in EST (Thu Dec 24 2026) closes at 13:00 ET = 18:00 UTC", () => {
    const close = getCloseTime(etCalendarDay(2026, 12, 24));
    expect(close.toISOString()).toBe("2026-12-24T18:00:00.000Z");
  });

  it("throws when given a non-trading day (full holiday)", () => {
    expect(() => getCloseTime(etCalendarDay(2026, 1, 1))).toThrow(/not a trading day/);
  });

  it("throws when given a weekend", () => {
    expect(() => getCloseTime(etCalendarDay(2026, 5, 23))).toThrow(/not a trading day/); // Saturday
  });

  it("throws when given a non-2026 date (calendar refresh reminder)", () => {
    expect(() => getCloseTime(etCalendarDay(2027, 1, 4))).toThrow(/Refresh/);
  });
});

describe("nextTradingDay — skips weekends + full holidays, includes half-days", () => {
  it("Friday May 22 2026 → next trading day is Tuesday May 26 (skip Sat/Sun + Memorial Day Mon)", () => {
    const fri = etCalendarDay(2026, 5, 22);
    const next = nextTradingDay(fri);
    expect(toEtDateString(next)).toBe("2026-05-26");
  });

  it("Wednesday Nov 25 2026 → next trading day is Friday Nov 27 (skip Thanksgiving Thu, half-day Fri included)", () => {
    const wed = etCalendarDay(2026, 11, 25);
    const next = nextTradingDay(wed);
    expect(toEtDateString(next)).toBe("2026-11-27"); // half-day still counts
    expect(isHalfDay(next)).toBe(true);
  });

  it("Thursday Dec 24 2026 → next trading day is Monday Dec 28 (skip Christmas Fri + weekend)", () => {
    const thu = etCalendarDay(2026, 12, 24);
    const next = nextTradingDay(thu);
    expect(toEtDateString(next)).toBe("2026-12-28");
  });

  it("Monday May 4 2026 → next trading day is Tuesday May 5", () => {
    const mon = etCalendarDay(2026, 5, 4);
    const next = nextTradingDay(mon);
    expect(toEtDateString(next)).toBe("2026-05-05");
  });

  it("Friday Jan 2 2026 → next trading day is Monday Jan 5 (skip weekend)", () => {
    const fri = etCalendarDay(2026, 1, 2);
    const next = nextTradingDay(fri);
    expect(toEtDateString(next)).toBe("2026-01-05");
  });

  it("Always returns a date strictly AFTER `from` (never returns `from` itself)", () => {
    // Even on a Monday trading day, we get Tuesday — not Monday.
    const mon = etCalendarDay(2026, 5, 4);
    const next = nextTradingDay(mon);
    expect(next.getTime()).toBeGreaterThan(mon.getTime());
  });

  it("Crosses DST boundary correctly (Sat Mar 7 2026 → Mon Mar 9 2026, EDT first day)", () => {
    const sat = etCalendarDay(2026, 3, 7);
    const next = nextTradingDay(sat);
    expect(toEtDateString(next)).toBe("2026-03-09"); // Mon, first full EDT day
  });

  it("Crosses DST end correctly (Fri Oct 30 2026 EDT → Mon Nov 2 2026 EST)", () => {
    const fri = etCalendarDay(2026, 10, 30);
    const next = nextTradingDay(fri);
    expect(toEtDateString(next)).toBe("2026-11-02"); // Mon, first EST day after fallback
  });
});

describe("DR-007 invariants — composition properties", () => {
  it("FULL_HOLIDAYS and HALF_DAYS are mutually exclusive", () => {
    const halfDays = _internal.HALF_DAYS_2026;
    const fullHolidays = _internal.FULL_HOLIDAYS_2026;
    for (const hd of halfDays) {
      expect(fullHolidays.has(hd)).toBe(false);
    }
  });

  it("Every half-day is also a trading day", () => {
    for (const ymd of _internal.HALF_DAYS_2026) {
      const [y, m, d] = ymd.split("-").map(Number);
      const date = etCalendarDay(y, m, d);
      expect(isTradingDay(date)).toBe(true);
      expect(isHalfDay(date)).toBe(true);
    }
  });

  it("Every full holiday is NOT a trading day and NOT a half-day", () => {
    for (const ymd of _internal.FULL_HOLIDAYS_2026) {
      const [y, m, d] = ymd.split("-").map(Number);
      const date = etCalendarDay(y, m, d);
      expect(isTradingDay(date)).toBe(false);
      expect(isHalfDay(date)).toBe(false);
    }
  });

  it("isEtDst boundary: Sat Mar 7 2026 is EST; Mon Mar 9 2026 is EDT", () => {
    expect(_internal.isEtDst(2026, 3, 7)).toBe(false);
    expect(_internal.isEtDst(2026, 3, 9)).toBe(true);
  });

  it("isEtDst boundary: Fri Oct 30 2026 is EDT; Mon Nov 2 2026 is EST", () => {
    expect(_internal.isEtDst(2026, 10, 30)).toBe(true);
    expect(_internal.isEtDst(2026, 11, 2)).toBe(false);
  });
});
