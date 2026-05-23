// DR-006 strike-grid evolution — Trigger.dev cron wrappers.
//
// 4 scheduled tasks compose into the 24-hour rolling per-ticker
// TickerConfig evolution:
//
//   Phase 1   (cron "5 16 * * 1-5", tz America/New_York, gated by
//              isRegularTradingDay)         — 4:05 PM ET full days
//              Settles today's markets + anchors next trading day's grid.
//
//   Phase 1b  (cron "5 13 * * 1-5", tz America/New_York, gated by
//              isHalfDay)                    — 1:05 PM ET half-days
//              Same as Phase 1 but for half-day settles.
//
//   Phase 2   (cron "0,30 16-20 * * 1-5", tz America/New_York, gated by
//              isInPhaseWindow(date, "ah"))  — AH window 4:30-8:00 PM ET /30min
//              Reads live spot, expands grid if drift > threshold.
//
//   Phase 3   (cron "0,30 4-9 * * 1-5", tz America/New_York, gated by
//              isInPhaseWindow(date, "pm"))  — PM window 4:00-9:00 AM ET /30min
//              Same as Phase 2 logic; pre-market window.
//
// Cron strings use Trigger.dev's `{ pattern, timezone }` object form so DST
// transitions are handled automatically by the IANA `America/New_York` zone.
// No DST flip needed in code per DR-006/DR-007.
//
// Window-gating is in-code (see grid-evolution.ts isInPhaseWindow) because
// cron expressions can't precisely express "16:30 → 20:00 every 30 min";
// the cron over-fires slightly and we filter at runtime.

import { schedules } from "@trigger.dev/sdk/v3";

import {
  runAnchorPhase,
  runWildSwingPhase,
  isRegularTradingDay,
} from "../grid-evolution.js";
import { isHalfDay, isTradingDay } from "../calendar.js";
import { runSettlementNudger } from "./settlement.js";

// ── Phase 1: 4:05 PM ET on regular (non-half) trading days ──────────────────
// Settle expired markets THEN anchor next trading day's TickerConfig.
//
// Runtime gating: cron fires Mon-Fri at 16:05 ET; we skip on full holidays
// + half-days (Phase 1b handles those) via `isRegularTradingDay()`.

export const phase1AnchorJob = schedules.task({
  id: "grid-phase1-anchor",
  cron: {
    pattern: "5 16 * * 1-5",
    timezone: "America/New_York",
  },
  maxDuration: 1200, // 20 min — settle nudger alone can use up to 15 min retry window
  run: async (payload, { ctx }) => {
    const runAt = payload.timestamp;
    if (!isRegularTradingDay(runAt)) {
      return {
        ok: true,
        skipped: true,
        reason: isHalfDay(runAt) ? "half-day (Phase 1b handles)" : "not a trading day",
        runAt: runAt.toISOString(),
      };
    }
    // 1. Settle today's expired markets (existing logic).
    const settle = await runSettlementNudger({ runAt, ctxRunId: ctx.run.id });
    // 2. Anchor next trading day's TickerConfig.
    const anchor = await runAnchorPhase({ runAt, ctxRunId: ctx.run.id });
    return { ok: true, runAt: runAt.toISOString(), settle, anchor };
  },
});

// ── Phase 1b: 1:05 PM ET on half-days only ──────────────────────────────────
// Same logic as Phase 1; different ET time.

export const phase1bAnchorJob = schedules.task({
  id: "grid-phase1b-anchor-halfday",
  cron: {
    pattern: "5 13 * * 1-5",
    timezone: "America/New_York",
  },
  maxDuration: 1200,
  run: async (payload, { ctx }) => {
    const runAt = payload.timestamp;
    if (!isHalfDay(runAt)) {
      return {
        ok: true,
        skipped: true,
        reason: "not a half-day (Phase 1 handles full days)",
        runAt: runAt.toISOString(),
      };
    }
    const settle = await runSettlementNudger({ runAt, ctxRunId: ctx.run.id });
    const anchor = await runAnchorPhase({ runAt, ctxRunId: ctx.run.id });
    return { ok: true, runAt: runAt.toISOString(), settle, anchor };
  },
});

// ── Phase 2: AH wild-swing every 30 min, 4:30 PM-8:00 PM ET trading days ────
// Cron "0,30 16-20 * * 1-5" fires Mon-Fri at :00 and :30 between 16:00 and
// 20:30 ET. The early fires at 16:00 + 16:30 and late fires at 20:30 are
// filtered by isInPhaseWindow(date, "ah") which permits 16:30 - 20:00 only.

export const phase2AhCheckJob = schedules.task({
  id: "grid-phase2-ah-check",
  cron: {
    pattern: "0,30 16-20 * * 1-5",
    timezone: "America/New_York",
  },
  maxDuration: 300,
  run: async (payload, { ctx }) => {
    const runAt = payload.timestamp;
    if (!isTradingDay(runAt)) {
      return {
        ok: true,
        skipped: true,
        reason: "not a trading day",
        runAt: runAt.toISOString(),
      };
    }
    return runWildSwingPhase({ phase: "ah", runAt, ctxRunId: ctx.run.id });
  },
});

// ── Phase 3: PM wild-swing every 30 min, 4:00 AM-9:00 AM ET trading days ────
// Cron "0,30 4-9 * * 1-5" fires Mon-Fri at :00 and :30 between 04:00 and
// 09:30 ET. The 9:30 fire is filtered by isInPhaseWindow(date, "pm").

export const phase3PmCheckJob = schedules.task({
  id: "grid-phase3-pm-check",
  cron: {
    pattern: "0,30 4-9 * * 1-5",
    timezone: "America/New_York",
  },
  maxDuration: 300,
  run: async (payload, { ctx }) => {
    const runAt = payload.timestamp;
    if (!isTradingDay(runAt)) {
      return {
        ok: true,
        skipped: true,
        reason: "not a trading day",
        runAt: runAt.toISOString(),
      };
    }
    return runWildSwingPhase({ phase: "pm", runAt, ctxRunId: ctx.run.id });
  },
});
