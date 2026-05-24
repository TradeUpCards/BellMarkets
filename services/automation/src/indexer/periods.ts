// DR-010 period math.
//
// Weekly period: ISO week. period_id = ISO_year * 100 + ISO_week.
//   ISO weeks start Monday. Week 1 of an ISO year is the week containing the
//   first Thursday of that calendar year. We use ISO weeks so the period_id
//   is unambiguous across year boundaries.
//   Distribution cron fires every Friday at 5 PM ET (after DR-007 cron
//   precedence + before weekend). Each cron fire closes that ISO week.
//
// Monthly period: calendar month in ET. period_id = year * 100 + month (1..12).
//   Distribution cron fires on the LAST trading Friday of the month at
//   5 PM ET.
//
// Period boundaries (period_start / period_end) are inclusive-start /
// exclusive-end (standard half-open interval):
//   weekly:  Monday 00:00 ET → next Monday 00:00 ET
//   monthly: 1st 00:00 ET → next month 1st 00:00 ET

import { isTradingDay, toEtDateString } from "../calendar.js";

function parseYmdStrict(ymd: string): [number, number, number] {
  const parts = ymd.split("-");
  if (parts.length !== 3) throw new Error(`parseYmdStrict: invalid ${ymd}`);
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`parseYmdStrict: non-numeric in ${ymd}`);
  }
  return [y, m, d];
}

export type PeriodKind = "weekly" | "monthly";

export type PeriodInfo = {
  kind: PeriodKind;
  /** Stable integer id; year*100 + (week|month). */
  id: number;
  /** Inclusive start (ET-aligned). */
  start: Date;
  /** Exclusive end. */
  end: Date;
};

// ---------------------------------------------------------------------------
// ISO-week math
// ---------------------------------------------------------------------------

/**
 * Returns the ISO week number (1..53) + ISO week-year for a given UTC Date.
 * ISO weeks start on Monday; week 1 contains the first Thursday of the
 * Gregorian year.
 *
 * Reference impl from Wikipedia ISO 8601 algorithm.
 */
export function isoWeekInfo(date: Date): { year: number; week: number } {
  // Use UTC components — we treat the calendar in ET but ISO-week math is
  // timezone-agnostic since the algorithm derives from day-of-week.
  // For our purposes (Friday 5 PM ET firing, week boundary at Mon 00:00 ET),
  // we shift the input to ET first via toEtDateString.
  const [y, m, d] = parseYmdStrict(toEtDateString(date));
  // Use UTC arithmetic for week calc (now timezone-agnostic).
  const utc = new Date(Date.UTC(y, m - 1, d));
  // Thursday in current week determines the year.
  const dayNum = utc.getUTCDay() || 7; // Monday=1, Sunday=7
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const isoYear = utc.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((utc.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return { year: isoYear, week };
}

export function isoWeekId(year: number, week: number): number {
  return year * 100 + week;
}

/**
 * Returns the UTC instant of Monday 00:00 ET for the ISO week containing
 * `date`. Used as `period_start` for weekly snapshots.
 */
export function weeklyPeriodStartUtc(date: Date): Date {
  const [y, m, d] = parseYmdStrict(toEtDateString(date));
  // Determine day-of-week in ET
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(date);
  const offsetToMon: Record<string, number> = {
    Mon: 0,
    Tue: -1,
    Wed: -2,
    Thu: -3,
    Fri: -4,
    Sat: -5,
    Sun: -6,
  };
  const off = offsetToMon[weekday] ?? 0;
  // Build the Monday ET date (= Monday at midnight ET).
  const monDate = new Date(Date.UTC(y, m - 1, d + off, 12, 0, 0));
  const [mY, mM, mD] = parseYmdStrict(toEtDateString(monDate));
  // Determine if Monday is in EDT or EST
  const utcOffset = isEtDst(mY, mM, mD) ? 4 : 5;
  return new Date(Date.UTC(mY, mM - 1, mD, utcOffset, 0, 0));
}

export function weeklyPeriodEndUtc(date: Date): Date {
  const start = weeklyPeriodStartUtc(date);
  // Next Monday 00:00 ET. Add 7 days; if DST flips between start and end,
  // the wall-clock midnight ET still lands at +7 * 24h since we use UTC
  // anchoring (start was computed at the correct UTC offset for its own
  // calendar Monday).
  // To stay exact across DST: re-compute the offset for the resulting Monday.
  const [sY, sM, sD] = parseYmdStrict(toEtDateString(start));
  const nextMonDate = new Date(Date.UTC(sY, sM - 1, sD + 7, 12, 0, 0));
  const [nY, nM, nD] = parseYmdStrict(toEtDateString(nextMonDate));
  const utcOffset = isEtDst(nY, nM, nD) ? 4 : 5;
  return new Date(Date.UTC(nY, nM - 1, nD, utcOffset, 0, 0));
}

// ---------------------------------------------------------------------------
// Monthly math
// ---------------------------------------------------------------------------

export function monthlyPeriodId(year: number, month: number): number {
  return year * 100 + month;
}

export function monthlyPeriodStartUtc(year: number, month: number): Date {
  const utcOffset = isEtDst(year, month, 1) ? 4 : 5;
  return new Date(Date.UTC(year, month - 1, 1, utcOffset, 0, 0));
}

export function monthlyPeriodEndUtc(year: number, month: number): Date {
  // First of next month.
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const utcOffset = isEtDst(ny, nm, 1) ? 4 : 5;
  return new Date(Date.UTC(ny, nm - 1, 1, utcOffset, 0, 0));
}

/**
 * Returns the ET calendar date of the LAST Friday of the given month/year.
 * Returns Date anchored at noon UTC of that ET date (suitable for further
 * isTradingDay checks).
 */
export function lastFridayOfMonth(year: number, month: number): Date {
  // Last day of month
  const lastDay = new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
  // Walk back from last day until weekday is Friday (in ET)
  for (let d = lastDay; d > 0; d--) {
    const candidate = new Date(Date.UTC(year, month - 1, d, 12, 0, 0));
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    }).format(candidate);
    if (weekday === "Fri") return candidate;
  }
  throw new Error(`lastFridayOfMonth: no Friday in ${year}-${month}`);
}

/**
 * TRUE if `date` is the last Friday of its month (in ET) AND is a trading
 * day. Used by the monthly distribute cron to gate "should this fire today?"
 *
 * If the calendar's last Friday is a NYSE holiday (rare — Good Friday is in
 * March/April, Christmas Eve is Thursday-ish), the function returns false.
 * In that case the cron skips; a future enhancement could shift to the
 * preceding trading Friday.
 */
export function isLastTradingFridayOfMonth(date: Date): boolean {
  const etYmd = toEtDateString(date);
  const [yStr, mStr] = etYmd.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const lastFri = lastFridayOfMonth(y, m);
  if (toEtDateString(lastFri) !== etYmd) return false;
  return isTradingDay(date);
}

// ---------------------------------------------------------------------------
// High-level "compute the period for this cron fire"
// ---------------------------------------------------------------------------

/**
 * Returns the period info that would be CLOSED by a cron firing at `date`.
 * For weekly: the ISO week containing `date`.
 * For monthly: the calendar month containing `date`.
 */
export function periodForDate(date: Date, kind: PeriodKind): PeriodInfo {
  if (kind === "weekly") {
    const { year, week } = isoWeekInfo(date);
    return {
      kind: "weekly",
      id: isoWeekId(year, week),
      start: weeklyPeriodStartUtc(date),
      end: weeklyPeriodEndUtc(date),
    };
  }
  const etYmd = toEtDateString(date);
  const [yStr, mStr] = etYmd.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  return {
    kind: "monthly",
    id: monthlyPeriodId(y, m),
    start: monthlyPeriodStartUtc(y, m),
    end: monthlyPeriodEndUtc(y, m),
  };
}

// ---------------------------------------------------------------------------
// DST helper (duplicates calendar.ts's internal helper — re-exposed here so
// this module doesn't need to import from `_internal`).
// ---------------------------------------------------------------------------

function isEtDst(year: number, month: number, day: number): boolean {
  // 2nd Sunday of March
  const marchStart = new Date(Date.UTC(year, 2, 1, 12, 0, 0));
  const offsetToSunMarch = (7 - marchStart.getUTCDay()) % 7;
  const secondSundayMarch = new Date(
    Date.UTC(year, 2, 1 + offsetToSunMarch + 7, 12, 0, 0),
  );
  // 1st Sunday of November
  const novStart = new Date(Date.UTC(year, 10, 1, 12, 0, 0));
  const offsetToSunNov = (7 - novStart.getUTCDay()) % 7;
  const firstSundayNov = new Date(
    Date.UTC(year, 10, 1 + offsetToSunNov, 12, 0, 0),
  );
  const target = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return target >= secondSundayMarch && target < firstSundayNov;
}
