"use client";

/**
 * Admin operational console (`/admin`).
 *
 * Sections (top to bottom):
 *   1. Authorization gate — render the rest only when connected wallet ==
 *      `MarketConfig.admin`. Otherwise render a "not authorized" stub.
 *   2. EMERGENCY PAUSE / UNPAUSE toggle.
 *   3. Read-only MarketConfig card.
 *   4. Read-only FeeConfig card.
 *   5. Markets table with per-row admin_settle action.
 *
 * Honest narration in the page header: this is an operational surface, not
 * a polished product. The v1 demo doesn't walk through it; reviewers can
 * navigate here if curious.
 */

import { useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";

import { useAllMarkets } from "@/hooks/use-all-markets";
import { useFeeConfig } from "@/hooks/use-fee-config";
import { useMarketConfig } from "@/hooks/use-market-config";
import { useBellMarketsProgram } from "@/lib/solana/anchor";
import { deriveOrderBookPda } from "@/lib/solana/pdas";
import { outcomeTag } from "@/lib/solana/types";
import type { Outcome, StrikeMarketWithPda } from "@/lib/solana/types";
import { buildPauseTx } from "@/lib/tx/build-pause";
import {
  buildAdminSettleTx,
  type ForcedOutcome,
} from "@/lib/tx/build-admin-settle";
import { buildUpdateFeeConfigTx } from "@/lib/tx/build-update-fee-config";

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtPubkey(p: PublicKey | undefined | null): string {
  if (!p) return "—";
  const s = p.toBase58();
  return `${s.slice(0, 6)}…${s.slice(-6)}`;
}

function fmtBool(b: boolean | undefined): string {
  if (b === undefined) return "—";
  return b ? "YES" : "no";
}

function fmtBn(v: { toString(): string } | undefined): string {
  if (v == null) return "—";
  return v.toString();
}

function fmtBps(b: number | undefined): string {
  if (b === undefined) return "—";
  return `${b} bps · ${(b / 100).toFixed(2)}%`;
}

function fmtEtTimestamp(unix: bigint | number): string {
  const ms = Number(unix) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " ET";
}

function outcomeLabel(o: Outcome): string {
  const tag = outcomeTag(o);
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

function strikeToDollars(strikePrice: { toString(): string }): number {
  // On-chain strike is encoded at the underlying Pyth feed's negative
  // exponent. Mainnet equity feeds use e-8; USDC-shaped feeds use e-6;
  // SOL/USD devnet (our current fallback while Pyth devnet has no MAG7
  // equity feeds) uses e-5. Magnitude-detect the scale by band:
  //   raw < 1e8     → e-5  (SOL/USD devnet fallback)
  //   raw 1e8–1e11  → e-6  (USDC-shaped feeds)
  //   raw >= 1e11   → e-8  (mainnet Pyth equity feeds)
  // Pre-fix this divided e-5-encoded values by 1e6, so $639 rendered as $64
  // ($639 × 1e5 / 1e6 = 63.9 → rounded to 64). See landing-view.tsx for
  // the parallel fix + comment trail.
  const raw = BigInt(strikePrice.toString());
  if (raw === 0n) return 0;
  const e6Scale = 1_000_000n;
  const e8Scale = 100_000_000n;
  const e5Scale = 100_000n;
  if (raw >= 100_000_000_000n) return Number(raw) / Number(e8Scale);
  if (raw >= 100_000_000n) return Number(raw) / Number(e6Scale);
  return Number(raw) / Number(e5Scale);
}

function inferTicker(_pythFeed: PublicKey): string {
  // Pyth feed → ticker is operational metadata that lives in Bram's
  // ticker-config; here we just show the strike + truncated feed for now.
  // Future: read TickerConfig per feed for a real ticker label.
  return "—";
}

// ─── Section components ────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  children: React.ReactNode;
  subtitle?: string;
}

function Section({ title, subtitle, children }: SectionProps) {
  return (
    <section
      style={{
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 6,
        padding: 16,
        marginBottom: 16,
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{title}</h2>
        {subtitle && (
          <p style={{ fontSize: 11, opacity: 0.6, margin: "4px 0 0" }}>
            {subtitle}
          </p>
        )}
      </header>
      {children}
    </section>
  );
}

function KV({ k, v, mono = true }: { k: string; v: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gap: 8,
        padding: "4px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        fontSize: 12,
      }}
    >
      <span style={{ opacity: 0.6 }}>{k}</span>
      <span
        className={mono ? "mono" : undefined}
        style={{ fontFamily: mono ? "var(--font-mono)" : undefined, wordBreak: "break-all" }}
      >
        {v}
      </span>
    </div>
  );
}

// ─── Per-row admin settle control (P5) ─────────────────────────────────────

function AdminSettleControls({
  row,
  adminOverrideDelaySecs,
  onSettle,
  busy,
}: {
  row: StrikeMarketWithPda;
  adminOverrideDelaySecs: bigint;
  onSettle: (marketPda: PublicKey, forced: ForcedOutcome) => Promise<void>;
  busy: boolean;
}) {
  const [forced, setForced] = useState<ForcedOutcome>("yes");

  const settled = outcomeTag(row.data.outcome) !== "unsettled";
  const expiryUnix = BigInt(row.data.expiryUnix.toString());
  const eligibleAtUnix = expiryUnix + adminOverrideDelaySecs;
  const nowUnix = BigInt(Math.floor(Date.now() / 1000));
  const eligible = nowUnix >= eligibleAtUnix;
  const secondsRemaining = eligible ? 0n : eligibleAtUnix - nowUnix;

  let disabledReason: string | null = null;
  if (settled) disabledReason = `Already settled: ${outcomeLabel(row.data.outcome)}`;
  else if (!eligible) {
    const hrs = Number(secondsRemaining) / 3600;
    disabledReason = `Admin override eligible in ${hrs.toFixed(1)} hr`;
  }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <select
        value={forced}
        onChange={(e) => setForced(e.target.value as ForcedOutcome)}
        disabled={!!disabledReason || busy}
        style={{
          fontSize: 11,
          padding: "4px 6px",
          background: "rgba(255,255,255,0.04)",
          color: "inherit",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 4,
        }}
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
        <option value="invalid">Invalid</option>
      </select>
      <button
        type="button"
        onClick={() => onSettle(row.pda, forced)}
        disabled={!!disabledReason || busy}
        title={disabledReason ?? undefined}
        style={{
          fontSize: 11,
          padding: "4px 10px",
          background: disabledReason ? "rgba(255,255,255,0.04)" : "#dc2626",
          color: disabledReason ? "rgba(255,255,255,0.4)" : "white",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 4,
          cursor: disabledReason ? "not-allowed" : "pointer",
        }}
      >
        Admin Settle
      </button>
    </div>
  );
}

// ─── update_fee_config form (P6) ───────────────────────────────────────────

interface FeeConfigFormProps {
  initial: {
    mintFeeBps: number;
    platformRetainBps: number;
    weeklyPoolBps: number;
    monthlyPoolBps: number;
    creatorRebateBps: number;
    forceRedeemGraceSecs: bigint;
    weeklyDistributionBps: number[];
    monthlyDistributionBps: number[];
  };
  onSubmit: (params: FeeConfigFormProps["initial"]) => Promise<void>;
  busy: boolean;
}

function FeeConfigForm({ initial, onSubmit, busy }: FeeConfigFormProps) {
  const [mintFeeBps, setMintFeeBps] = useState(String(initial.mintFeeBps));
  const [platformBps, setPlatformBps] = useState(String(initial.platformRetainBps));
  const [weeklyBps, setWeeklyBps] = useState(String(initial.weeklyPoolBps));
  const [monthlyBps, setMonthlyBps] = useState(String(initial.monthlyPoolBps));
  const [creatorRebateBps, setCreatorRebateBps] = useState(
    String(initial.creatorRebateBps),
  );
  const [graceSecs, setGraceSecs] = useState(
    initial.forceRedeemGraceSecs.toString(),
  );
  const [weeklyDist, setWeeklyDist] = useState(
    initial.weeklyDistributionBps.join(","),
  );
  const [monthlyDist, setMonthlyDist] = useState(
    initial.monthlyDistributionBps.join(","),
  );
  const [err, setErr] = useState<string | null>(null);

  const parseBucket = (s: string, expected: number = 10): number[] | string => {
    const nums = s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .map((x) => Number(x));
    if (nums.length !== expected)
      return `expected ${expected} entries, got ${nums.length}`;
    if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 65_535 || !Number.isInteger(n)))
      return "all entries must be integer 0..65535";
    return nums;
  };

  const handleSubmit = async () => {
    setErr(null);
    const m = Number(mintFeeBps);
    const p = Number(platformBps);
    const w = Number(weeklyBps);
    const mo = Number(monthlyBps);
    const cr = Number(creatorRebateBps);
    const grace = (() => {
      try {
        return BigInt(graceSecs);
      } catch {
        return null;
      }
    })();
    if ([m, p, w, mo, cr].some((n) => !Number.isFinite(n) || n < 0 || n > 65_535)) {
      setErr("All bps fields must be 0..65535.");
      return;
    }
    if (p + w + mo !== 10_000) {
      setErr(`platform + weekly + monthly must sum to 10000 (got ${p + w + mo}).`);
      return;
    }
    if (m > 10_000) {
      setErr("mint_fee_bps ≤ 10000.");
      return;
    }
    if (cr > 10_000) {
      setErr("creator_rebate_bps ≤ 10000.");
      return;
    }
    if (grace === null || grace <= 0n) {
      setErr("force_redeem_grace_secs must be a positive integer.");
      return;
    }
    const weekly = parseBucket(weeklyDist);
    const monthly = parseBucket(monthlyDist);
    if (typeof weekly === "string") {
      setErr(`weekly_distribution_bps: ${weekly}`);
      return;
    }
    if (typeof monthly === "string") {
      setErr(`monthly_distribution_bps: ${monthly}`);
      return;
    }
    const weeklySum = weekly.reduce((a, b) => a + b, 0);
    const monthlySum = monthly.reduce((a, b) => a + b, 0);
    if (weeklySum !== 10_000) {
      setErr(`weekly_distribution_bps must sum to 10000 (got ${weeklySum}).`);
      return;
    }
    if (monthlySum !== 10_000) {
      setErr(`monthly_distribution_bps must sum to 10000 (got ${monthlySum}).`);
      return;
    }

    const ok = window.confirm(
      `update_fee_config:\n` +
        `  mint_fee_bps         = ${m}\n` +
        `  platform_retain_bps  = ${p}\n` +
        `  weekly_pool_bps      = ${w}\n` +
        `  monthly_pool_bps     = ${mo}\n` +
        `  creator_rebate_bps   = ${cr}\n` +
        `  force_redeem_grace_secs = ${grace}\n` +
        `  weekly_distribution  = [${weekly.join(", ")}]\n` +
        `  monthly_distribution = [${monthly.join(", ")}]\n\n` +
        `Submit?`,
    );
    if (!ok) return;
    await onSubmit({
      mintFeeBps: m,
      platformRetainBps: p,
      weeklyPoolBps: w,
      monthlyPoolBps: mo,
      creatorRebateBps: cr,
      forceRedeemGraceSecs: grace,
      weeklyDistributionBps: weekly,
      monthlyDistributionBps: monthly,
    });
  };

  const inputStyle = {
    fontSize: 12,
    padding: "4px 6px",
    width: 90,
    background: "rgba(255,255,255,0.04)",
    color: "inherit",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 4,
    fontFamily: "var(--font-mono)",
  } as const;

  return (
    <div
      style={{
        marginTop: 16,
        padding: 12,
        background: "rgba(255,255,255,0.03)",
        borderRadius: 4,
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>
        update_fee_config form · validates locally before signing
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "200px 1fr",
          gap: 8,
          fontSize: 12,
          alignItems: "center",
        }}
      >
        <label>mint_fee_bps</label>
        <input
          value={mintFeeBps}
          onChange={(e) => setMintFeeBps(e.target.value)}
          style={inputStyle}
          inputMode="numeric"
        />
        <label>platform_retain_bps</label>
        <input
          value={platformBps}
          onChange={(e) => setPlatformBps(e.target.value)}
          style={inputStyle}
          inputMode="numeric"
        />
        <label>weekly_pool_bps</label>
        <input
          value={weeklyBps}
          onChange={(e) => setWeeklyBps(e.target.value)}
          style={inputStyle}
          inputMode="numeric"
        />
        <label>monthly_pool_bps</label>
        <input
          value={monthlyBps}
          onChange={(e) => setMonthlyBps(e.target.value)}
          style={inputStyle}
          inputMode="numeric"
        />
        <label>creator_rebate_bps</label>
        <input
          value={creatorRebateBps}
          onChange={(e) => setCreatorRebateBps(e.target.value)}
          style={inputStyle}
          inputMode="numeric"
        />
        <label>force_redeem_grace_secs</label>
        <input
          value={graceSecs}
          onChange={(e) => setGraceSecs(e.target.value)}
          style={{ ...inputStyle, width: 160 }}
          inputMode="numeric"
        />
        <label>weekly_distribution_bps</label>
        <input
          value={weeklyDist}
          onChange={(e) => setWeeklyDist(e.target.value)}
          style={{ ...inputStyle, width: 500 }}
          placeholder="10 comma-separated u16s summing to 10000"
        />
        <label>monthly_distribution_bps</label>
        <input
          value={monthlyDist}
          onChange={(e) => setMonthlyDist(e.target.value)}
          style={{ ...inputStyle, width: 500 }}
          placeholder="10 comma-separated u16s summing to 10000"
        />
      </div>
      {err && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: "#fca5a5",
            padding: "6px 8px",
            border: "1px solid rgba(239,68,68,0.4)",
            background: "rgba(239,68,68,0.08)",
            borderRadius: 3,
          }}
        >
          {err}
        </div>
      )}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={busy}
        style={{
          marginTop: 12,
          padding: "6px 14px",
          fontSize: 12,
          fontWeight: 600,
          background: "#0ea5e9",
          color: "white",
          border: "1px solid rgba(255,255,255,0.16)",
          borderRadius: 4,
          cursor: busy ? "wait" : "pointer",
        }}
      >
        {busy ? "Submitting…" : "update_fee_config"}
      </button>
    </div>
  );
}

// ─── Main view ─────────────────────────────────────────────────────────────

export function AdminView() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const program = useBellMarketsProgram();
  const { data: marketConfig } = useMarketConfig();
  const { data: feeConfig } = useFeeConfig();
  const { data: allMarkets } = useAllMarkets();

  const authorized = useMemo(() => {
    if (!wallet.publicKey || !marketConfig) return false;
    return wallet.publicKey.equals(marketConfig.admin);
  }, [wallet.publicKey, marketConfig]);

  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const broadcast = async (tx: Transaction): Promise<string> => {
    if (!wallet.publicKey) throw new Error("wallet disconnected");
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    return wallet.sendTransaction(tx, connection, { skipPreflight: false });
  };

  const handlePauseToggle = async () => {
    if (!program || !marketConfig || !wallet.publicKey) return;
    const wantPaused = !marketConfig.paused;
    const action = wantPaused ? "PAUSE" : "UNPAUSE";
    const ok = window.confirm(
      `${action} the entire protocol?\n\nThis halts mint_pair / place_order / cancel_order / redeem / settle for ALL strikes until you call ${wantPaused ? "unpause" : "pause"}.`,
    );
    if (!ok) return;
    setBusy("pause");
    setResult(null);
    try {
      const built = await buildPauseTx({
        program,
        admin: wallet.publicKey,
        paused: wantPaused,
      });
      const sig = await broadcast(built.tx);
      setResult({
        ok: true,
        msg: `${action} broadcast: ${sig.slice(0, 16)}…`,
      });
    } catch (err) {
      setResult({
        ok: false,
        msg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const handleUpdateFeeConfig = async (
    fields: FeeConfigFormProps["initial"],
  ) => {
    if (!program || !wallet.publicKey) return;
    setBusy("update-fee-config");
    setResult(null);
    try {
      const built = await buildUpdateFeeConfigTx({
        program,
        admin: wallet.publicKey,
        ...fields,
      });
      const sig = await broadcast(built.tx);
      setResult({
        ok: true,
        msg: `update_fee_config broadcast: ${sig.slice(0, 16)}…`,
      });
    } catch (err) {
      setResult({
        ok: false,
        msg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const handleAdminSettle = async (
    marketPda: PublicKey,
    forced: ForcedOutcome,
  ) => {
    if (!program || !wallet.publicKey) return;
    const ok = window.confirm(
      `ADMIN SETTLE ${marketPda.toBase58().slice(0, 8)}…\n\nForced outcome: ${forced.toUpperCase()}\n\nThis bypasses the Pyth oracle path. Reviewable on chain; reversal requires a new tx.`,
    );
    if (!ok) return;
    const key = `settle-${marketPda.toBase58()}`;
    setBusy(key);
    setResult(null);
    try {
      const built = await buildAdminSettleTx({
        program,
        admin: wallet.publicKey,
        marketPda,
        forcedOutcome: forced,
      });
      const sig = await broadcast(built.tx);
      setResult({
        ok: true,
        msg: `admin_settle (${forced}) broadcast: ${sig.slice(0, 16)}…`,
      });
    } catch (err) {
      setResult({
        ok: false,
        msg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  // Sort markets: unsettled first, then by expiry ascending.
  const sortedMarkets = useMemo(() => {
    if (!allMarkets) return [];
    return [...allMarkets].sort((a, b) => {
      const aSettled = outcomeTag(a.data.outcome) !== "unsettled" ? 1 : 0;
      const bSettled = outcomeTag(b.data.outcome) !== "unsettled" ? 1 : 0;
      if (aSettled !== bSettled) return aSettled - bSettled;
      return Number(BigInt(a.data.expiryUnix.toString()) - BigInt(b.data.expiryUnix.toString()));
    });
  }, [allMarkets]);

  // ── Not-connected / not-authorized state ────────────────────────────────
  if (!wallet.publicKey) {
    return (
      <main style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
          Admin · BellMarkets
        </h1>
        <p style={{ fontSize: 13, opacity: 0.6 }}>
          Connect the admin wallet from the header to access this surface.
        </p>
      </main>
    );
  }
  if (!marketConfig) {
    return (
      <main style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
          Admin · BellMarkets
        </h1>
        <p style={{ fontSize: 13, opacity: 0.6 }}>Loading MarketConfig…</p>
      </main>
    );
  }
  if (!authorized) {
    return (
      <main style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
          Not authorized
        </h1>
        <p style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.7 }}>
          Connected wallet does not match{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>
            MarketConfig.admin
          </code>
          . Disconnect via the header and reconnect with the admin keypair.
        </p>
        <div
          style={{
            fontSize: 12,
            marginTop: 16,
            padding: 12,
            background: "rgba(255,255,255,0.04)",
            borderRadius: 4,
          }}
        >
          <div className="mono">connected: {fmtPubkey(wallet.publicKey)}</div>
          <div className="mono">expected: {fmtPubkey(marketConfig.admin)}</div>
        </div>
      </main>
    );
  }

  // ── Authorized: render the operational surface ──────────────────────────
  const adminOverrideDelaySecs = BigInt(
    marketConfig.adminOverrideDelaySecs.toString(),
  );

  return (
    <main style={{ maxWidth: 1100, margin: "32px auto", padding: 24 }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>
          Admin · BellMarkets
        </h1>
        <p style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.5 }}>
          Operational console. NOT a v1 demo surface — the v1 demo script
          walks through the trader-facing pages. Actions here mutate
          protocol state via admin-signed transactions.
        </p>
      </header>

      {result && (
        <div
          style={{
            padding: 10,
            marginBottom: 16,
            fontSize: 12,
            border: `1px solid ${result.ok ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}`,
            background: result.ok ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
            borderRadius: 4,
          }}
          className="mono"
        >
          {result.ok ? "✓ " : "⚠ "}
          {result.msg}
        </div>
      )}

      {/* ── Section 1: Emergency Pause / Unpause ────────────────────────── */}
      <Section
        title="Emergency Pause"
        subtitle="Pauses mint_pair / place_order / cancel_order / redeem / settle on every strike. Use only in emergency."
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button
            type="button"
            onClick={handlePauseToggle}
            disabled={busy !== null || !program}
            style={{
              flex: "0 0 auto",
              padding: "12px 20px",
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: "0.05em",
              border: "1px solid rgba(255,255,255,0.16)",
              borderRadius: 4,
              cursor: busy ? "wait" : "pointer",
              background: marketConfig.paused ? "#f59e0b" : "#dc2626",
              color: "white",
            }}
          >
            {busy === "pause"
              ? "Submitting…"
              : marketConfig.paused
                ? "UNPAUSE PROTOCOL"
                : "PAUSE PROTOCOL"}
          </button>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Current state:{" "}
            <strong
              style={{
                color: marketConfig.paused ? "#f59e0b" : "#22c55e",
              }}
            >
              {marketConfig.paused ? "PAUSED" : "running"}
            </strong>
          </div>
        </div>
      </Section>

      {/* ── Section 2: MarketConfig ────────────────────────────────────── */}
      <Section title="MarketConfig" subtitle="PDA = [b&quot;config&quot;]. Subscription-driven.">
        <KV k="admin" v={marketConfig.admin.toBase58()} />
        <KV k="usdc_mint" v={marketConfig.usdcMint.toBase58()} />
        <KV k="treasury" v={marketConfig.treasury.toBase58()} />
        <KV k="paused" v={fmtBool(marketConfig.paused)} />
        <KV
          k="price_staleness_secs"
          v={fmtBn(marketConfig.priceStalenessSecs)}
        />
        <KV
          k="price_confidence_bps"
          v={fmtBps(marketConfig.priceConfidenceBps)}
        />
        <KV
          k="admin_override_delay_secs"
          v={`${fmtBn(marketConfig.adminOverrideDelaySecs)} (~${(Number(adminOverrideDelaySecs) / 3600).toFixed(1)} hr)`}
        />
        <KV k="bump" v={String(marketConfig.bump)} />
      </Section>

      {/* ── Section 3: FeeConfig ───────────────────────────────────────── */}
      <Section
        title="FeeConfig"
        subtitle="PDA = [b&quot;fee_config&quot;]. Default mint_fee_bps=0 (mechanism present, disabled until admin flip)."
      >
        {feeConfig ? (
          <>
            <KV k="mint_fee_bps" v={fmtBps(feeConfig.mintFeeBps)} />
            <KV
              k="platform_retain_bps"
              v={fmtBps(feeConfig.platformRetainBps)}
            />
            <KV k="weekly_pool_bps" v={fmtBps(feeConfig.weeklyPoolBps)} />
            <KV k="monthly_pool_bps" v={fmtBps(feeConfig.monthlyPoolBps)} />
            <KV
              k="creator_rebate_bps"
              v={fmtBps(feeConfig.creatorRebateBps)}
            />
            <KV
              k="force_redeem_grace_secs"
              v={fmtBn(feeConfig.forceRedeemGraceSecs)}
            />
            <KV
              k="weekly_distribution_bps[10]"
              v={feeConfig.weeklyDistributionBps.join(" · ")}
            />
            <KV
              k="monthly_distribution_bps[10]"
              v={feeConfig.monthlyDistributionBps.join(" · ")}
            />
            <FeeConfigForm
              initial={{
                mintFeeBps: feeConfig.mintFeeBps,
                platformRetainBps: feeConfig.platformRetainBps,
                weeklyPoolBps: feeConfig.weeklyPoolBps,
                monthlyPoolBps: feeConfig.monthlyPoolBps,
                creatorRebateBps: feeConfig.creatorRebateBps,
                forceRedeemGraceSecs: BigInt(
                  feeConfig.forceRedeemGraceSecs.toString(),
                ),
                weeklyDistributionBps: feeConfig.weeklyDistributionBps,
                monthlyDistributionBps: feeConfig.monthlyDistributionBps,
              }}
              onSubmit={handleUpdateFeeConfig}
              busy={busy === "update-fee-config"}
            />
          </>
        ) : (
          <div style={{ fontSize: 12, opacity: 0.6 }}>
            Loading FeeConfig… (account may not exist if initialize_fee_config
            hasn&apos;t been called)
          </div>
        )}
      </Section>

      {/* ── Section 4: Markets table ───────────────────────────────────── */}
      <Section
        title={`Markets (${sortedMarkets.length})`}
        subtitle="Sorted: unsettled first, then by expiry. Admin Settle bypasses the Pyth oracle path."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 80px 130px 90px 90px 110px 240px",
            gap: 8,
            fontSize: 11,
            opacity: 0.6,
            padding: "8px 0",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div>StrikeMarket</div>
          <div>Strike</div>
          <div>Expiry</div>
          <div>Outcome</div>
          <div>Pairs</div>
          <div>OrderBook</div>
          <div>Admin Action</div>
        </div>

        {sortedMarkets.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>
            No StrikeMarket accounts found on this program.
          </div>
        )}

        {sortedMarkets.map((row) => {
          const settled = outcomeTag(row.data.outcome) !== "unsettled";
          const strikeDollars = strikeToDollars(row.data.strikePrice);
          const expiryUnix = BigInt(row.data.expiryUnix.toString());
          const orderBookBound = !row.data.orderBook.equals(PublicKey.default);
          const [derivedOrderBookPda] = deriveOrderBookPda(row.pda);
          const ageMs =
            Date.now() - Number(BigInt(row.data.expiryUnix.toString())) * 1000;
          const _age = ageMs; // age-since-create unavailable on chain; using expiry-relative
          const ticker = inferTicker(row.data.underlyingPythFeed);
          void _age;
          void ticker;

          return (
            <div
              key={row.pda.toBase58()}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 80px 130px 90px 90px 110px 240px",
                gap: 8,
                fontSize: 12,
                padding: "10px 0",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                alignItems: "center",
                opacity: settled ? 0.55 : 1,
              }}
            >
              <div className="mono" style={{ wordBreak: "break-all" }}>
                {fmtPubkey(row.pda)}
              </div>
              <div className="mono">
                {strikeDollars > 0 ? `$${strikeDollars.toFixed(2)}` : "—"}
              </div>
              <div className="mono">{fmtEtTimestamp(expiryUnix)}</div>
              <div>
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: 3,
                    background:
                      outcomeTag(row.data.outcome) === "unsettled"
                        ? "rgba(255,255,255,0.06)"
                        : outcomeTag(row.data.outcome) === "yes"
                          ? "rgba(34,197,94,0.16)"
                          : outcomeTag(row.data.outcome) === "no"
                            ? "rgba(239,68,68,0.16)"
                            : "rgba(245,158,11,0.16)",
                  }}
                >
                  {outcomeLabel(row.data.outcome)}
                </span>
              </div>
              <div className="mono">{fmtBn(row.data.pairsOutstanding)}</div>
              <div className="mono" style={{ fontSize: 11 }}>
                {orderBookBound ? (
                  <span style={{ color: "#22c55e" }} title={derivedOrderBookPda.toBase58()}>
                    bound
                  </span>
                ) : (
                  <span style={{ opacity: 0.5 }}>uninit</span>
                )}
              </div>
              <AdminSettleControls
                row={row}
                adminOverrideDelaySecs={adminOverrideDelaySecs}
                onSettle={handleAdminSettle}
                busy={busy === `settle-${row.pda.toBase58()}`}
              />
            </div>
          );
        })}
      </Section>

      <footer style={{ fontSize: 11, opacity: 0.4, marginTop: 24 }}>
        DR-020 deploy_index=8 · all admin actions require admin-signed
        transactions (no server-side keypair). force_redeem / update_ticker_config /
        update_usdc_mint / reinit_rewards_pools are CLI-only by design (see
        services/automation/scripts).
      </footer>
    </main>
  );
}
