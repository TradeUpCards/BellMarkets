// US 2026 trading calendar per DR-007 (constitution/decisions.md).
//
// Why this exists:
//   - Saturday/Sunday and NYSE full-holiday "expiries" have no real close to
//     settle against — settlement would either fail (oracle stale) or use the
//     stale prior close (incorrect — gives users an arbitrage window).
//   - Half-days (~3/year — day after Thanksgiving, Christmas Eve, occasionally
//     July 3) ARE trading days but close early at 1:00 PM ET, not 4:00 PM ET.
//     Real trading produces a real close price; we settle normally just at the
//     earlier time.
//
// Scope:
//   - Hardcoded 2026 only. Each January, future-Bram updates for the new year.
//     V2 path is `nyse-holidays` npm or Polygon.io free tier; for MVP a manual
//     ~30 min refresh per year is acceptable.
//   - All timestamps are ET-anchored. Returned Date objects are in UTC; if you
//     need to display an ET wall-clock to a user, use Intl.DateTimeFormat with
//     timeZone: "America/New_York".
//
// DR-007 references:
//   - `isTradingDay(date)`  → bool. TRUE on half-days. FALSE on weekends + full holidays.
//   - `isHalfDay(date)`     → bool. TRUE only for the half-day set.
//   - `getCloseTime(date)`  → Date. 16:00 ET on regular days, 13:00 ET on half-days.
//   - `nextTradingDay(from)` → Date. First trading day STRICTLY AFTER `from`.

// ---------------------------------------------------------------------------
// 2026 calendar (verified against NYSE 2026 official holiday schedule)
// ---------------------------------------------------------------------------
//
// Full holidays (10 — Jul 3 included as observed Independence Day since Jul 4
// falls on Saturday). NYSE shifts observed-day per its "if Saturday → previous
// Friday, if Sunday → next Monday" rule.
//
// Source check (when refreshing for 2027):
//   - https://www.nyse.com/markets/hours-calendars
//   - https://www.sec.gov/about/holiday-schedule
const FULL_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  "2026-01-01", // New Year's Day (Thu)
  "2026-01-19", // MLK Day (Mon, 3rd Mon Jan)
  "2026-02-16", // Presidents Day (Mon, 3rd Mon Feb)
  "2026-04-03", // Good Friday (Fri)
  "2026-05-25", // Memorial Day (Mon, last Mon May) ← TODAY's final deadline ref
  "2026-06-19", // Juneteenth (Fri)
  "2026-07-03", // Independence Day (observed — Jul 4 is Sat)
  "2026-09-07", // Labor Day (Mon, 1st Mon Sep)
  "2026-11-26", // Thanksgiving (Thu, 4th Thu Nov)
  "2026-12-25", // Christmas (Fri)
]);

// Half-days (1:00 PM ET close) for 2026. July 3 is NOT in this set — when Jul 4
// is Saturday, Jul 3 is the OBSERVED full holiday, not a half-day. The day-
// before-Jul-4 half-day only occurs in years where Jul 4 falls on a weekday.
const HALF_DAYS_2026: ReadonlySet<string> = new Set([
  "2026-11-27", // Day after Thanksgiving (Fri)
  "2026-12-24", // Christmas Eve (Thu)
]);

// Year coverage. If a date outside this is passed, throw with a clear hint
// rather than silently returning wrong results.
const CALENDAR_YEAR = 2026;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert any Date instant into its "YYYY-MM-DD" representation in the
 * America/New_York timezone. Used for comparing against the holiday + half-day
 * sets. Stable across DST transitions because we use the IANA timezone DB
 * through Intl.DateTimeFormat (en-CA gives ISO-shaped output).
 */
export function toEtDateString(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`toEtDateString: invalid Date (${date})`);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Day-of-week ("Sat" / "Sun" / "Mon" / etc.) interpreted in America/New_York.
 * Internal — used only by `isTradingDay`.
 */
function etWeekdayShort(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(date);
}

/**
 * Returns true if the given (y, m, d) is within US Daylight Saving Time —
 * second Sunday of March through (but not including) first Sunday of November.
 * Federal law; stable for the foreseeable future. Cross-check at year refresh.
 */
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

function parseYmd(ymd: string): [number, number, number] {
  const parts = ymd.split("-");
  if (parts.length !== 3) {
    throw new Error(`parseYmd: invalid YYYY-MM-DD string: ${ymd}`);
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`parseYmd: invalid YYYY-MM-DD string: ${ymd}`);
  }
  return [y, m, d];
}

function assertCoveredYear(year: number): void {
  if (year !== CALENDAR_YEAR) {
    throw new Error(
      `calendar.ts only covers ${CALENDAR_YEAR}. Refresh FULL_HOLIDAYS / HALF_DAYS for ${year} per NYSE schedule.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API per DR-007 §"Off-chain (Bram)" — exact helper names + semantics
// ---------------------------------------------------------------------------

/**
 * TRUE if the given date is a US equity trading day (in ET).
 *   - FALSE on weekends.
 *   - FALSE on full holidays.
 *   - TRUE on half-days (real trading just with early close).
 *
 * Every cron entry-point gates on this — prevents Saturday/Sunday/holiday
 * Trigger.dev fires from doing anything.
 */
export function isTradingDay(date: Date): boolean {
  const ymd = toEtDateString(date);
  if (FULL_HOLIDAYS_2026.has(ymd)) return false;
  const weekday = etWeekdayShort(date);
  return weekday !== "Sat" && weekday !== "Sun";
}

/**
 * TRUE if the given date is a half-day (1:00 PM ET close instead of 4:00 PM).
 * Half-days are still trading days; this is just for cron-routing
 * (1:05 PM ET settle cron vs 4:05 PM ET settle cron).
 */
export function isHalfDay(date: Date): boolean {
  return HALF_DAYS_2026.has(toEtDateString(date));
}

/**
 * Returns the official close time of the given trading day as a UTC Date.
 *   - Regular trading day: 16:00 ET
 *   - Half-day:            13:00 ET
 *
 * Throws if `date` is NOT a trading day — caller should `isTradingDay()`
 * first; passing a weekend/holiday is a programming error here, not a
 * silent edge case (would otherwise return a fake close time).
 */
export function getCloseTime(date: Date): Date {
  if (!isTradingDay(date)) {
    throw new Error(
      `getCloseTime: ${toEtDateString(date)} is not a trading day; gate with isTradingDay() first`,
    );
  }
  const [year, month, day] = parseYmd(toEtDateString(date));
  assertCoveredYear(year);
  const closeHourEt = isHalfDay(date) ? 13 : 16;
  // ET = UTC - offset. EDT offset = -4, so UTC = ET + 4. EST offset = -5, so UTC = ET + 5.
  const utcOffsetHours = isEtDst(year, month, day) ? 4 : 5;
  return new Date(Date.UTC(year, month - 1, day, closeHourEt + utcOffsetHours, 0, 0));
}

/**
 * Returns the first trading day STRICTLY AFTER `from` (does NOT return `from`
 * even if `from` is a trading day). Skips weekends + full holidays. Half-days
 * COUNT as trading days.
 *
 * Used by DR-006 Phase 1 to anchor TickerConfig.expiry_unix for tomorrow's
 * (or post-weekend) market.
 *
 * Bounded at 14-day lookahead — would only fire if the calendar were
 * pathologically wrong (no real-world holiday cluster spans 14 days).
 */
export function nextTradingDay(from: Date): Date {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new Error(`nextTradingDay: invalid Date (${from})`);
  }
  const [y, m, d] = parseYmd(toEtDateString(from));
  // Anchor at noon UTC of `from`'s ET calendar day. Noon UTC ± offset stays
  // within the same ET calendar day, so adding 24h advances ET by one day
  // regardless of DST transitions.
  let candidate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  for (let i = 0; i < 14; i++) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
    if (isTradingDay(candidate)) return candidate;
  }
  throw new Error(
    `nextTradingDay: no trading day found within 14 days of ${from.toISOString()}`,
  );
}

// ---------------------------------------------------------------------------
// Exports for diagnostics / tests
// ---------------------------------------------------------------------------

export const _internal = {
  FULL_HOLIDAYS_2026,
  HALF_DAYS_2026,
  CALENDAR_YEAR,
  isEtDst,
  etWeekdayShort,
};
