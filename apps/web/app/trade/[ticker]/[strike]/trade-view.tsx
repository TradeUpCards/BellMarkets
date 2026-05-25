"use client";

/**
 * v8 trade page — client view.
 *
 * Visual reference: `apps/web/public/mockups/v8-trade.html`. CSS lives in
 * `apps/web/app/v8-trade.css` (imported by the route's `page.tsx`).
 *
 * Live data sources:
 *   - `useWallet()` for connect state / signing
 *   - `useUserConfig(walletPubkey)` for tier + fee projection
 *   - `useBellProSubscription()` for the Go-Pro CTA state
 *   - `useTokenBalance(usdcAta)` for USDC available (TODO: wire when route knows ticker→mint)
 *   - `usePosition(wallet, marketPda)` for the position monitor (TODO: needs the strike-market PDA)
 *
 * The Phoenix order book + position cost-basis history aren't yet plumbed
 * end-to-end in this session — those values display the mockup's sample data
 * with a `data-mock` attribute so audit/QA can identify visual fixtures vs
 * live data. Trade submission itself is wired to the real tx builders against
 * the connected wallet.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { MarketState } from "@ellipsis-labs/phoenix-sdk";

import { useUserConfig } from "@/hooks/use-user-config";
import { useBellProSubscription } from "@/hooks/use-bell-pro-subscription";
import { useMarketConfig } from "@/hooks/use-market-config";
import { useAllMarkets } from "@/hooks/use-all-markets";
import { useOrderBook } from "@/hooks/use-order-book";
import { usePosition } from "@/hooks/use-position";
import { useBellMarketsProgram } from "@/lib/solana/anchor";
import { outcomeTag } from "@/lib/solana/types";
import { buildMintPairTx } from "@/lib/tx/build-mint-pair";
import { buildBuyYesTx } from "@/lib/tx/build-buy-yes";
import { buildSellYesTx } from "@/lib/tx/build-sell-yes";
import { buildBuyNoTx } from "@/lib/tx/build-buy-no";
import { buildSellNoTx } from "@/lib/tx/build-sell-no";
import { buildRedeemPairTx } from "@/lib/tx/build-redeem-pair";

export interface TradeViewParams {
  ticker: string;
  strike: string;
}

type Side = "buy" | "sell";
type Outcome = "yes" | "no";
type OrderType = "market" | "limit";
type Unit = "usdc" | "contracts";

const STRIKES = [620, 640, 660, 680, 700, 720, 740];
const STRIKE_PROBS: Record<number, number> = {
  620: 92,
  640: 84,
  660: 71,
  680: 50,
  700: 28,
  720: 14,
  740: 6,
};

const FEE_BPS_DEFAULT = 200; // 2% — matches DR-008 default until admin flip.
const SLIP_RATIO_HINT = 0.012;
const PRICE_YES_ASK = 0.520;
const PRICE_YES_BID = 0.500;
const PRICE_NO_ASK = 0.480;
const PRICE_NO_BID = 0.460;
const USDC_AVAIL_FALLBACK = 123.45;

function fmtUsd(n: number, decimals = 2): string {
  return "$" + n.toFixed(decimals);
}
function fmtUsdSigned(n: number, decimals = 2): string {
  return (n >= 0 ? "+" : "−") + "$" + Math.abs(n).toFixed(decimals);
}

export function TradeView({ ticker, strike }: TradeViewParams) {
  const tickerUpper = ticker.toUpperCase();
  const strikeNum = Number(strike);

  // ─── State machine ────────────────────────────────────────────────────
  const [side, setSide] = useState<Side>("buy");
  const [outcome, setOutcome] = useState<Outcome>("yes");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [unit, setUnit] = useState<Unit>("usdc");
  const [amount, setAmount] = useState<string>("200");
  const [slipPct, setSlipPct] = useState<number>(0.5);
  const [slipCustom, setSlipCustom] = useState<string>("");
  const [limitPrice, setLimitPrice] = useState<string>("0.500");
  const [limitQty, setLimitQty] = useState<string>("200");

  const wallet = useWallet();
  const { connection } = useConnection();
  const program = useBellMarketsProgram();
  const { derived: userConfigDerived } = useUserConfig(wallet.publicKey ?? null);
  useBellProSubscription();
  const { data: marketConfig } = useMarketConfig();
  const { data: allMarkets } = useAllMarkets();

  // Match the URL strike to an on-chain StrikeMarket. Strike on chain is in
  // Pyth-feed-exponent micros (typically expo=-8 → strike × 1e8). We try both
  // the e-6 (USDC-like) and e-8 (Pyth-like) scaling so the lookup works no
  // matter what the deployed markets were created with.
  const liveMarket = useMemo(() => {
    if (!allMarkets) return null;
    const strikeE6 = BigInt(strikeNum) * 1_000_000n;
    const strikeE8 = BigInt(strikeNum) * 100_000_000n;
    return (
      allMarkets.find((m) => {
        const sp = BigInt(m.data.strikePrice.toString());
        return sp === strikeE6 || sp === strikeE8;
      }) ?? null
    );
  }, [allMarkets, strikeNum]);

  // Live position from the user's YES + NO ATAs for this strike. Cost basis
  // still needs the off-chain tx-history index (Bram's scope) — until then we
  // surface contracts only, with cost basis = 0 so the UI doesn't lie.
  const livePosition = usePosition(
    wallet.publicKey ?? null,
    liveMarket?.pda ?? null,
  );

  // USDC tokens (6 decimals) per pair. mint_pair takes USDC micros = pair count × 1e6.
  // YES/NO tokens are also 6 decimals → balance / 1e6 = contract count.
  const TOKEN_SCALE = 1_000_000n;

  const yesContracts = livePosition.data
    ? Number(livePosition.data.yesBalance / TOKEN_SCALE)
    : 0;
  const noContracts = livePosition.data
    ? Number(livePosition.data.noBalance / TOKEN_SCALE)
    : 0;

  // Matched-pair / directional decomposition per Hard YES #8 §6.1 + the
  // architecture conversation. `matched_pairs` is the count of YES+NO that
  // can be redeemed atomically via redeem_pair (each pair = $1 USDC back).
  // `directional_*` is the side the user is net-long after netting the pair.
  const matchedPairs = Math.min(yesContracts, noContracts);
  const directionalYes = Math.max(0, yesContracts - noContracts);
  const directionalNo = Math.max(0, noContracts - yesContracts);

  // Position card / sell-side gating reads the directional side only — a
  // matched pair is not a sellable directional position, it's recoverable
  // via Redeem Pair instead.
  const position = useMemo(
    () => ({
      yes: { contracts: directionalYes, avgEntry: 0, costBasis: 0 },
      no: { contracts: directionalNo, avgEntry: 0, costBasis: 0 },
    }),
    [directionalYes, directionalNo],
  );

  // Phoenix order book — drives the pre-flight check matrix (empty / thin
  // book → action disabled). null pubkey → null snapshot.
  const phoenixPubkey = liveMarket?.data.phoenixMarket ?? null;
  const { data: bookSnapshot } = useOrderBook(phoenixPubkey, 10);
  const orderBook = bookSnapshot?.book ?? null;
  const yesAsks = orderBook?.asks ?? [];
  const yesBids = orderBook?.bids ?? [];

  // Settled / paused → all trade actions disabled. `outcomeTag` returns
  // "unsettled" when the market is still live.
  const marketSettled = liveMarket
    ? outcomeTag(liveMarket.data.outcome) !== "unsettled"
    : false;
  const marketPaused = marketConfig?.paused === true;

  // DR-019 guard: NO-side trades are market-only. If the user toggles to NO
  // while sitting on Limit, snap back to Market. The Limit toggle itself is
  // gated below (disabled + tooltip) — this useEffect handles the case where
  // the user changes outcome AFTER picking Limit.
  useEffect(() => {
    if (outcome === "no" && orderType === "limit") {
      setOrderType("market");
    }
  }, [outcome, orderType]);

  // ─── Derived ────────────────────────────────────────────────────────────
  const pos = position[outcome];

  // Prefer live Phoenix mid + ladder prices when available; fall back to the
  // mockup constants only for static visual rendering when the book is empty
  // (the disable matrix below grays out the action so the user never sees
  // these as a real price quote).
  const livePriceYesAsk = yesAsks[0]?.price;
  const livePriceYesBid = yesBids[0]?.price;
  const livePriceNoAsk =
    livePriceYesBid !== undefined ? 1 - livePriceYesBid : undefined;
  const livePriceNoBid =
    livePriceYesAsk !== undefined ? 1 - livePriceYesAsk : undefined;

  const ask =
    outcome === "yes"
      ? livePriceYesAsk ?? PRICE_YES_ASK
      : livePriceNoAsk ?? PRICE_NO_ASK;
  const bid =
    outcome === "yes"
      ? livePriceYesBid ?? PRICE_YES_BID
      : livePriceNoBid ?? PRICE_NO_BID;
  const feeBps = userConfigDerived.projectedFeeBps || FEE_BPS_DEFAULT;
  const feeRatio = feeBps / 10_000;
  const usdcAvail = USDC_AVAIL_FALLBACK; // TODO: useTokenBalance(usdcAta)

  const sellEmpty = side === "sell" && pos.contracts === 0;

  // ─── Pre-flight check matrix (P4) ───────────────────────────────────────
  // Computes a single "why this action is disabled" reason per (side, outcome,
  // orderType) combination. Each entry mirrors the architecture-conversation
  // table; null = action is allowed. Buy YES Market is always allowed because
  // we fall back to mint_pair when the Phoenix YES ask book is empty.
  const phoenixUninitialized =
    !phoenixPubkey || bookSnapshot?.uninitialized === true;

  const disableReason: string | null = useMemo(() => {
    if (marketSettled) return "Market settled — use Redeem for winnings.";
    if (marketPaused) return "Market paused by admin.";
    if (!liveMarket)
      return `No on-chain StrikeMarket for ${tickerUpper} @ $${strikeNum}.`;

    // DR-019: Limit on NO is structurally disabled (force-flipped to Market
    // by the useEffect above; this guard catches any race where state hasn't
    // updated yet).
    if (outcome === "no" && orderType === "limit") {
      return "Limit Buy/Sell NO coming in v1.5 — use Market for now.";
    }

    // Position-exclusivity (Hard YES #8 §6.1): you can't buy YES while net-
    // long NO, or vice versa. Matched pairs don't trigger this — only the
    // directional component does.
    if (side === "buy" && outcome === "yes" && directionalNo > 0) {
      return `You hold ${directionalNo} directional NO — close those (Sell NO) before buying YES.`;
    }
    if (side === "buy" && outcome === "no" && directionalYes > 0) {
      return `You hold ${directionalYes} directional YES — close those (Sell YES) before buying NO.`;
    }

    if (side === "buy" && outcome === "yes") {
      // Buy YES Market falls back to mint_pair when no asks — always allowed.
      if (orderType === "limit" && phoenixUninitialized) {
        return "Phoenix CLOB not yet bound to this strike — Limit orders unavailable.";
      }
      return null;
    }

    if (side === "sell" && outcome === "yes") {
      if (directionalYes === 0) return "You hold no YES contracts to sell.";
      if (orderType === "market" && yesBids.length === 0) {
        return "No YES bids — wait for a buyer or place a Limit Sell.";
      }
      if (orderType === "limit" && phoenixUninitialized) {
        return "Phoenix CLOB not yet bound to this strike — Limit orders unavailable.";
      }
      return null;
    }

    if (side === "buy" && outcome === "no") {
      // Buy NO Market = atomic mint_pair + sell-YES. Needs YES bids to
      // absorb the sell-YES leg.
      if (phoenixUninitialized) {
        return "Phoenix CLOB not yet bound — atomic Buy NO unavailable.";
      }
      if (yesBids.length === 0) {
        return "Empty YES bid book — Buy NO would revert (no liquidity to sell the YES leg into).";
      }
      return null;
    }

    if (side === "sell" && outcome === "no") {
      if (directionalNo === 0) return "You hold no NO contracts to sell.";
      if (phoenixUninitialized) {
        return "Phoenix CLOB not yet bound — atomic Sell NO unavailable.";
      }
      if (yesAsks.length === 0) {
        return "Empty YES ask book — Sell NO would revert (no liquidity to buy the YES leg from).";
      }
      return null;
    }

    return null;
  }, [
    marketSettled,
    marketPaused,
    liveMarket,
    tickerUpper,
    strikeNum,
    outcome,
    orderType,
    side,
    directionalYes,
    directionalNo,
    yesAsks.length,
    yesBids.length,
    phoenixUninitialized,
  ]);

  // BUY compute
  const buy = useMemo(() => {
    const raw = parseFloat(amount) || 0;
    let contracts: number;
    if (unit === "usdc") {
      const maxAffordable = raw / (ask * (1 + feeRatio + SLIP_RATIO_HINT));
      contracts = Math.floor(maxAffordable);
    } else {
      contracts = Math.floor(raw);
    }
    const cost = contracts * ask;
    const fee = cost * feeRatio;
    const slip = cost * SLIP_RATIO_HINT;
    const total = cost + fee + slip;
    const payout = contracts * 1.0;
    const profit = payout - total;
    return { contracts, cost, fee, slip, total, payout, profit };
  }, [amount, unit, ask, feeRatio]);

  // SELL compute
  const sell = useMemo(() => {
    const raw = parseFloat(amount) || 0;
    const sellCount = Math.min(raw || pos.contracts, pos.contracts);
    const gross = sellCount * bid;
    const fee = 0; // DR-008: SELL has no protocol fee
    const net = gross - fee;
    const costPortion = pos.contracts > 0 ? pos.costBasis * (sellCount / pos.contracts) : 0;
    const realized = net - costPortion;
    return { sellCount, gross, fee, net, realized };
  }, [amount, bid, pos.contracts, pos.costBasis]);

  // Insufficient funds
  const fundsWarning = useMemo(() => {
    if (side !== "buy") return null;
    if (buy.contracts === 0)
      return `Amount too small to buy 1 contract at ${fmtUsd(ask, 3)}.`;
    if (buy.total > usdcAvail)
      return `Order total ${fmtUsd(buy.total)} exceeds your ${fmtUsd(usdcAvail)} available USDC.`;
    return null;
  }, [side, buy.contracts, buy.total, ask, usdcAvail]);

  const slipWarn = slipPct > 2;
  const slipSevere = slipPct > 5;
  const TRADE_COST_HINT = 104;
  const slipOverpay = (TRADE_COST_HINT * slipPct) / 100;

  // ─── Quick amount helpers ─────────────────────────────────────────────
  const handleQuick = (pct: string) => {
    if (side === "buy") {
      if (unit === "usdc") {
        const target = pct === "max" ? usdcAvail : (usdcAvail * Number(pct)) / 100;
        setAmount(target.toFixed(2));
      } else {
        const maxContracts = Math.floor(usdcAvail / (ask * 1.032));
        const target =
          pct === "max" ? maxContracts : Math.floor((maxContracts * Number(pct)) / 100);
        setAmount(String(target));
      }
    } else {
      if (pos.contracts === 0) return;
      const target =
        pct === "max" ? pos.contracts : Math.floor((pos.contracts * Number(pct)) / 100);
      setAmount(String(Math.max(1, target)));
    }
  };

  const handleUnitSwap = (next: Unit) => {
    if (next === unit) return;
    const cur = parseFloat(amount) || 0;
    if (next === "contracts" && unit === "usdc") {
      setAmount(String(Math.max(1, Math.floor(cur / ask))));
    } else if (next === "usdc" && unit === "contracts") {
      setAmount((cur * ask * 1.032).toFixed(2));
    }
    setUnit(next);
  };

  // ─── Submit ─────────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Load a Phoenix MarketState on-demand for the Phoenix-leg builders.
  // Lifted to a closure rather than a hook because we only need it inside
  // the submit handlers — keeps the render loop cheap.
  const loadPhoenixMarketState = async (): Promise<MarketState> => {
    if (!phoenixPubkey) {
      throw new Error("Phoenix market not bound on this StrikeMarket.");
    }
    const info = await connection.getAccountInfo(phoenixPubkey, "confirmed");
    if (!info) {
      throw new Error("Phoenix market account not found on devnet.");
    }
    return MarketState.load({ address: phoenixPubkey, buffer: info.data });
  };

  const broadcast = async (tx: Transaction): Promise<string> => {
    if (!wallet.publicKey) throw new Error("wallet disconnected");
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    return wallet.sendTransaction(tx, connection, { skipPreflight: false });
  };

  const handleSubmit = async () => {
    setSubmitResult(null);
    if (!wallet.publicKey || !wallet.signTransaction) {
      setSubmitResult({ ok: false, msg: "Connect a wallet to trade." });
      return;
    }
    if (!program) {
      setSubmitResult({ ok: false, msg: "Anchor program loading — wait a beat." });
      return;
    }
    if (!marketConfig) {
      setSubmitResult({ ok: false, msg: "Market config loading — wait a beat." });
      return;
    }
    if (!liveMarket) {
      setSubmitResult({
        ok: false,
        msg: `No on-chain StrikeMarket found for ${tickerUpper} @ $${strikeNum}. Bram's morning job creates these daily.`,
      });
      return;
    }
    if (disableReason) {
      setSubmitResult({ ok: false, msg: disableReason });
      return;
    }

    setSubmitting(true);
    try {
      const trader = wallet.publicKey;
      const marketPda = liveMarket.pda;
      const usdcMint = marketConfig.usdcMint;
      const treasury = marketConfig.treasury;

      let tx: Transaction;

      if (side === "buy" && outcome === "yes") {
        // Buy YES: prefer Phoenix taker (cheaper, ladder-priced) when asks
        // exist; fall back to mint_pair (always works, prices at $1/pair) when
        // the YES ask book is empty. mint_pair is the load-bearing v1 path.
        if (orderType === "market" && yesAsks.length > 0 && !phoenixUninitialized) {
          const phoenixMarket = await loadPhoenixMarketState();
          const numQuoteLots = Math.max(1, Math.floor(buy.total * 1_000_000));
          tx = buildBuyYesTx({
            phoenixMarket,
            trader,
            numQuoteLots,
            minBaseLotsToFill: Math.max(1, Math.floor(buy.contracts * 0.95)),
          });
        } else {
          const contractAmount = BigInt(Math.max(1, buy.contracts));
          const built = await buildMintPairTx({
            program,
            user: trader,
            marketPda,
            usdcMint,
            treasury,
            amount: contractAmount * 1_000_000n,
          });
          tx = built.tx;
        }
      } else if (side === "sell" && outcome === "yes") {
        // Sell YES: single-ix Phoenix swap (Ask side). User burns YES, receives
        // USDC. Limit support adds a priceInTicks — Phoenix limit posting is
        // forthcoming; for now Market only.
        const phoenixMarket = await loadPhoenixMarketState();
        const numBaseLots = Math.max(1, sell.sellCount);
        tx = buildSellYesTx({
          phoenixMarket,
          trader,
          numBaseLots,
          // Floor for minQuoteLots: 95% of book price × lots. Keeps the user
          // from being slipped past the slip-tolerance bar.
          minQuoteLotsToFill: Math.max(
            1,
            Math.floor(sell.gross * 1_000_000 * 0.95),
          ),
        });
      } else if (side === "buy" && outcome === "no") {
        // Atomic Buy NO: mint_pair + Phoenix sell-YES in one tx. DR-019 IOC
        // defense built into the builder.
        const phoenixMarket = await loadPhoenixMarketState();
        const contractAmount = BigInt(Math.max(1, buy.contracts));
        const built = await buildBuyNoTx({
          program,
          trader,
          marketPda,
          phoenixMarket,
          usdcMint,
          treasury,
          amount: contractAmount,
        });
        tx = built.tx;
      } else {
        // Atomic Sell NO: Phoenix buy-YES + redeem_pair in one tx. DR-019 IOC
        // defense built into the builder.
        const phoenixMarket = await loadPhoenixMarketState();
        const contractAmount = BigInt(Math.max(1, sell.sellCount));
        // maxQuoteLotsToSpend = 105% of book price × lots (5% slip ceiling on
        // the buy-YES leg). Phoenix reverts if it would spend more than this.
        const maxQuoteLotsToSpend = Math.max(
          1,
          Math.floor(Number(contractAmount) * ask * 1_000_000 * 1.05),
        );
        const built = await buildSellNoTx({
          program,
          trader,
          marketPda,
          phoenixMarket,
          usdcMint,
          amount: contractAmount,
          maxQuoteLotsToSpend,
        });
        tx = built.tx;
      }

      const sig = await broadcast(tx);
      setSubmitResult({
        ok: true,
        msg: `Submitted! ${sig.slice(0, 16)}… (confirming)`,
      });
    } catch (err) {
      setSubmitResult({
        ok: false,
        msg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Redeem Pair (P5) ───────────────────────────────────────────────────
  const [redeemingPair, setRedeemingPair] = useState(false);
  const handleRedeemPair = async () => {
    setSubmitResult(null);
    if (!wallet.publicKey || !wallet.signTransaction) {
      setSubmitResult({ ok: false, msg: "Connect a wallet to redeem." });
      return;
    }
    if (!program || !marketConfig || !liveMarket || matchedPairs === 0) return;
    setRedeemingPair(true);
    try {
      const built = await buildRedeemPairTx({
        program,
        trader: wallet.publicKey,
        marketPda: liveMarket.pda,
        usdcMint: marketConfig.usdcMint,
        amount: BigInt(matchedPairs) * TOKEN_SCALE,
      });
      const sig = await broadcast(built.tx);
      setSubmitResult({
        ok: true,
        msg: `Redeemed ${matchedPairs} pair${matchedPairs === 1 ? "" : "s"} — ${sig.slice(0, 16)}…`,
      });
    } catch (err) {
      setSubmitResult({
        ok: false,
        msg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRedeemingPair(false);
    }
  };

  // ─── Display values per active state ────────────────────────────────────
  const fieldLabel = side === "buy" ? "Amount" : "Contracts to sell";
  const fieldAvailable =
    side === "buy"
      ? `${fmtUsd(usdcAvail)} avail`
      : `${pos.contracts} owned · avg ${fmtUsd(pos.avgEntry, 2)}`;
  const inputSuffix =
    side === "buy" ? (unit === "usdc" ? "USDC" : outcome.toUpperCase()) : outcome.toUpperCase();
  const sbAction = side.toUpperCase();
  const sbDetail =
    side === "buy"
      ? `${buy.contracts} @ ${fmtUsd(ask, 3)} · ${fmtUsd(buy.total)} TOTAL`
      : `${sell.sellCount} @ ${fmtUsd(bid, 3)} · ${fmtUsd(sell.net)} RECEIVED`;
  const summaryHeadline =
    side === "buy"
      ? `Order details · Cost ${fmtUsd(buy.total)} · Max payout ${fmtUsd(buy.payout)}`
      : `Order details · Receive ${fmtUsd(sell.net)} · ${sell.realized >= 0 ? "Profit" : "Loss"} ${fmtUsdSigned(sell.realized)}`;

  return (
    <>
      {/* Market header */}
      <div className="market-header">
        <div className="market-header-top">
          <div className="market-id">
            <div className="market-id-mark">{tickerUpper.slice(0, 1)}</div>
            <div className="market-id-title">
              {tickerUpper} <span className="gt">&gt;</span> ${strikeNum}
              <span className="market-id-sub">
                <span className="chip live">live</span>
                <span className="chip">expires 4 PM ET</span>
                <Link href="#verify" className="chip chip-link" title="On-chain verification">
                  Verify on-chain ↗
                </Link>
              </span>
            </div>
          </div>
          <div className="strike-pills-inline">
            {STRIKES.map((s) => {
              const itm = s < strikeNum;
              const otm = s > strikeNum;
              const active = s === strikeNum;
              return (
                <Link
                  key={s}
                  href={`/trade/${tickerUpper}/${s}`}
                  className={`strike-pill${active ? " active" : ""}${itm ? " itm" : ""}${otm ? " otm" : ""}`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="px">${s}</span>
                  <span className="prob">{STRIKE_PROBS[s] ?? 50}%</span>
                </Link>
              );
            })}
          </div>
          <select
            className="strike-dropdown"
            aria-label="Select strike"
            value={strikeNum}
            onChange={(e) => {
              window.location.href = `/trade/${tickerUpper}/${e.target.value}`;
            }}
          >
            {STRIKES.map((s) => (
              <option key={s} value={s}>
                ${s} · {STRIKE_PROBS[s] ?? 50}% YES{s === strikeNum ? " (ATM)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="layout">
        <aside className="left-rail">
          <RailTickers active={tickerUpper} />
          <RailPositions />
          <RailLeaders />
        </aside>

        <main>
          <div className="trade-grid">
            <div className="left-col">
              <ChartCard ticker={tickerUpper} strike={strikeNum} />

              <div className="info-grid-2">
                <PositionCard pos={position.yes} outcome="yes" />
                <OpenOrdersTrades />
              </div>
            </div>

            <aside className="right-col">
              {matchedPairs > 0 && (
                <div
                  className="stranded-pair-banner"
                  data-matched-pairs={matchedPairs}
                  style={{
                    padding: 12,
                    marginBottom: 12,
                    border: "1px solid var(--bell-amber, #f59e0b)",
                    background: "rgba(245, 158, 11, 0.08)",
                    borderRadius: 6,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                    <strong>Matched pair{matchedPairs === 1 ? "" : "s"} detected.</strong>{" "}
                    You hold {matchedPairs} matched YES+NO pair
                    {matchedPairs === 1 ? "" : "s"} for this strike — click
                    Redeem Pair to recover ${matchedPairs.toFixed(2)} USDC, or
                    trade your directional position normally.
                  </div>
                  <button
                    type="button"
                    onClick={handleRedeemPair}
                    disabled={redeemingPair || !program || !marketConfig}
                    className="submit-btn primary-cta"
                    style={{
                      alignSelf: "flex-start",
                      padding: "6px 14px",
                      fontSize: 13,
                    }}
                  >
                    {redeemingPair
                      ? "Redeeming…"
                      : `Redeem ${matchedPairs} Pair${matchedPairs === 1 ? "" : "s"} → $${matchedPairs.toFixed(2)}`}
                  </button>
                </div>
              )}
              <div
                className="trade-card"
                data-side={side}
                data-outcome={outcome}
                data-unit={unit}
              >
                <div className="trade-tabs">
                  <button
                    className={`trade-tab buy${side === "buy" ? " active" : ""}`}
                    onClick={() => setSide("buy")}
                    type="button"
                  >
                    Buy
                  </button>
                  <button
                    className={`trade-tab sell${side === "sell" ? " active" : ""}`}
                    onClick={() => setSide("sell")}
                    type="button"
                  >
                    Sell
                  </button>
                </div>

                <div className="yes-no-toggle">
                  <button
                    className={`yn-tab yes${outcome === "yes" ? " active" : ""}`}
                    onClick={() => setOutcome("yes")}
                    type="button"
                  >
                    <span className="lbl">YES</span>
                    <span className="price">${PRICE_YES_ASK.toFixed(2)}</span>
                    <span className="sub">52% implied</span>
                  </button>
                  <button
                    className={`yn-tab no${outcome === "no" ? " active" : ""}`}
                    onClick={() => setOutcome("no")}
                    type="button"
                  >
                    <span className="lbl">NO</span>
                    <span className="price">${PRICE_NO_ASK.toFixed(2)}</span>
                    <span className="sub">48% implied</span>
                  </button>
                </div>

                <div className="trade-form" data-order-type={orderType}>
                  <div className="order-type-row">
                    <button
                      className={`order-type-btn${orderType === "market" ? " active" : ""}`}
                      onClick={() => setOrderType("market")}
                      type="button"
                    >
                      Market
                    </button>
                    {/* DR-019: Limit Buy/Sell NO disabled — see constitution/decisions.md */}
                    <button
                      className={`order-type-btn${orderType === "limit" ? " active" : ""}`}
                      onClick={() => outcome === "yes" && setOrderType("limit")}
                      type="button"
                      disabled={outcome === "no"}
                      title={
                        outcome === "no"
                          ? "Limit Buy/Sell NO coming in v1.5 — use Market for now."
                          : undefined
                      }
                      style={
                        outcome === "no"
                          ? { opacity: 0.4, cursor: "not-allowed" }
                          : undefined
                      }
                    >
                      Limit
                    </button>
                  </div>

                  {sellEmpty ? (
                    <div className="sell-empty-state">
                      <div className="sell-empty-icon" aria-hidden="true">⊘</div>
                      <div className="sell-empty-title">
                        No {outcome.toUpperCase()} contracts to sell
                      </div>
                      <div className="sell-empty-sub">
                        You don&apos;t hold any {outcome.toUpperCase()} on this market. Buy first or
                        switch markets.
                      </div>
                      <button
                        className="sell-empty-cta"
                        onClick={() => setSide("buy")}
                        type="button"
                      >
                        Switch to BUY
                      </button>
                    </div>
                  ) : (
                    <>
                      {orderType === "market" ? (
                        <div className="trade-active-fields">
                          <div className="field market-only">
                            <div className="field-label">
                              <span>{fieldLabel}</span>
                              <span className="available">{fieldAvailable}</span>
                            </div>
                            {side === "buy" && (
                              <div className="unit-toggle" role="tablist" aria-label="Amount unit">
                                <button
                                  className={`unit-btn${unit === "usdc" ? " active" : ""}`}
                                  role="tab"
                                  aria-selected={unit === "usdc"}
                                  onClick={() => handleUnitSwap("usdc")}
                                  type="button"
                                >
                                  USDC
                                </button>
                                <button
                                  className={`unit-btn${unit === "contracts" ? " active" : ""}`}
                                  role="tab"
                                  aria-selected={unit === "contracts"}
                                  onClick={() => handleUnitSwap("contracts")}
                                  type="button"
                                >
                                  Contracts
                                </button>
                              </div>
                            )}
                            <div className="input-wrap">
                              <input
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                placeholder="0"
                                inputMode="decimal"
                              />
                              <span className="suffix">{inputSuffix}</span>
                            </div>
                            <div className="quick-amounts">
                              {["25", "50", "75", "max"].map((q) => (
                                <button
                                  key={q}
                                  className="quick-amount"
                                  onClick={() => handleQuick(q)}
                                  type="button"
                                >
                                  {q === "max" ? "MAX" : `${q}%`}
                                </button>
                              ))}
                            </div>
                            {fundsWarning && (
                              <div className="funds-warning">
                                <span aria-hidden="true">⚠</span>
                                <span>
                                  <strong>Insufficient funds.</strong> {fundsWarning}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="limit-order-section">
                          <div className="field">
                            <div className="field-label">
                              <span>Limit price {outcome.toUpperCase()}</span>
                              <span className="available">market ${PRICE_YES_ASK.toFixed(3)}</span>
                            </div>
                            <div className="input-wrap">
                              <input
                                value={limitPrice}
                                onChange={(e) => setLimitPrice(e.target.value)}
                                step="0.005"
                                min="0.01"
                                max="0.99"
                                inputMode="decimal"
                              />
                              <span className="suffix">USDC</span>
                            </div>
                            <div className="quick-amounts">
                              <button
                                className="quick-amount"
                                onClick={() => setLimitPrice(PRICE_YES_ASK.toFixed(3))}
                                type="button"
                              >
                                market
                              </button>
                              {["-0.01", "-0.02", "-0.05"].map((d) => (
                                <button
                                  key={d}
                                  className="quick-amount"
                                  onClick={() => setLimitPrice((PRICE_YES_ASK + parseFloat(d)).toFixed(3))}
                                  type="button"
                                >
                                  {d.replace("-", "−")}¢
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="field" style={{ marginTop: 12 }}>
                            <div className="field-label">
                              <span>Quantity</span>
                              <span className="available">{fmtUsd(usdcAvail)} avail</span>
                            </div>
                            <div className="input-wrap">
                              <input
                                value={limitQty}
                                onChange={(e) => setLimitQty(e.target.value)}
                                inputMode="numeric"
                              />
                              <span className="suffix">{outcome.toUpperCase()}</span>
                            </div>
                            <div className="quick-amounts">
                              {["50", "100", "500", "MAX"].map((q) => (
                                <button
                                  key={q}
                                  className="quick-amount"
                                  onClick={() => {
                                    if (q === "MAX") {
                                      const px = parseFloat(limitPrice) || PRICE_YES_ASK;
                                      setLimitQty(String(Math.floor(usdcAvail / px)));
                                    } else {
                                      setLimitQty(q);
                                    }
                                  }}
                                  type="button"
                                >
                                  {q}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="limit-meta mono">
                            Order total:{" "}
                            <strong>
                              ${((parseFloat(limitPrice) || 0) * (parseFloat(limitQty) || 0)).toFixed(2)}
                            </strong>
                          </div>
                        </div>
                      )}

                      {orderType === "market" && (
                        <div className="slip-row market-only">
                          <div className="slip-head">
                            <span>Slippage tolerance</span>
                            <span className="computed">
                              {slipPct.toFixed(2)}% · max ${(ask * (1 + slipPct / 100)).toFixed(3)}
                            </span>
                          </div>
                          <div className="slip-presets">
                            {[0.1, 0.5, 1].map((v) => (
                              <button
                                key={v}
                                className={`slip-preset${slipPct === v && slipCustom === "" ? " active" : ""}`}
                                onClick={() => {
                                  setSlipPct(v);
                                  setSlipCustom("");
                                }}
                                type="button"
                              >
                                {v.toFixed(v >= 1 ? 1 : 1)}%
                              </button>
                            ))}
                            <div className="slip-custom-wrap">
                              <input
                                type="number"
                                className="slip-custom"
                                placeholder="Custom"
                                min="0"
                                max="100"
                                step="0.1"
                                value={slipCustom}
                                onChange={(e) => {
                                  setSlipCustom(e.target.value);
                                  setSlipPct(parseFloat(e.target.value) || 0);
                                }}
                                aria-label="Custom slippage %"
                              />
                              <span className="slip-custom-suffix">%</span>
                            </div>
                          </div>
                          {slipWarn && (
                            <div className={`slip-warning${slipSevere ? " severe" : ""}`}>
                              <span aria-hidden="true">⚠</span>
                              <span>
                                <strong>High slippage tolerance</strong> — you may overpay by up to{" "}
                                <span className="slip-overpay">${slipOverpay.toFixed(2)}</span>. Front-running risk increases above 5%.
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      <button
                        className={`submit-btn primary-cta ${outcome === "yes" ? "yes" : "no"}`}
                        disabled={
                          !!fundsWarning ||
                          !!disableReason ||
                          submitting
                        }
                        onClick={handleSubmit}
                        type="button"
                        title={disableReason ?? undefined}
                      >
                        <span className="sb-action">{sbAction}</span>
                        <span className={`sb-outcome ${outcome}`}>{outcome.toUpperCase()}</span>
                        <span className="sb-detail">{sbDetail}</span>
                      </button>
                      {disableReason && (
                        <div
                          className="funds-warning"
                          style={{ marginTop: 8 }}
                          data-disable-reason
                        >
                          <span aria-hidden="true">⚠</span>
                          <span>{disableReason}</span>
                        </div>
                      )}

                      {submitResult && (
                        <div
                          className="funds-warning"
                          style={{
                            marginTop: 8,
                            // Success → green Yes-token border + tint; error keeps the
                            // amber warning treatment from .funds-warning. Distinct
                            // demo signal (audit P1 fix).
                            borderColor: submitResult.ok ? "var(--yes)" : undefined,
                            background: submitResult.ok ? "var(--yes-bg)" : undefined,
                            color: submitResult.ok ? "var(--yes)" : undefined,
                          }}
                          data-submit-state={submitResult.ok ? "success" : "error"}
                        >
                          <span aria-hidden="true">{submitResult.ok ? "✓" : "⚠"}</span>
                          <span>{submitResult.msg}</span>
                        </div>
                      )}

                      <details className="trade-summary-wrap">
                        <summary className="trade-summary-toggle">
                          <span className="ts-toggle-text">{summaryHeadline}</span>
                          <span className="ts-chevron" aria-hidden="true">▾</span>
                        </summary>
                        <div className="trade-summary">
                          {side === "buy" ? (
                            <>
                              <div className="summary-row">
                                <span>Avg. price</span>
                                <span className="v">{fmtUsd(ask, 3)}</span>
                              </div>
                              <div className="summary-row">
                                <span>Cost ({buy.contracts} × {fmtUsd(ask, 3)})</span>
                                <span className="v">{fmtUsd(buy.cost)}</span>
                              </div>
                              <div className="summary-row fee">
                                <span>Fee (Tier-{userConfigDerived.tier} · {(feeBps / 100).toFixed(2)}%)</span>
                                <span className="v">{fmtUsdSigned(buy.fee)}</span>
                              </div>
                              <div className="summary-row">
                                <span>Slippage est.</span>
                                <span className="v">{fmtUsdSigned(buy.slip)}</span>
                              </div>
                              <div className="summary-divider" />
                              <div className="summary-row payout">
                                <span>Max payout if {outcome.toUpperCase()}</span>
                                <span className="v">{fmtUsd(buy.payout)}</span>
                              </div>
                              <div className="summary-row profit">
                                <span>Net profit if won</span>
                                <span className="v">{fmtUsdSigned(buy.profit)}</span>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="summary-row">
                                <span>Sell price (bid)</span>
                                <span className="v">{fmtUsd(bid, 3)}</span>
                              </div>
                              <div className="summary-row">
                                <span>Gross proceeds</span>
                                <span className="v">{fmtUsd(sell.gross)}</span>
                              </div>
                              <div className="summary-divider" />
                              <div className="summary-row payout">
                                <span>Net you receive</span>
                                <span className="v">{fmtUsd(sell.net)}</span>
                              </div>
                              <div className={`summary-row profit${sell.realized < 0 ? " loss" : ""}`}>
                                <span>{sell.realized >= 0 ? "Realized profit" : "Realized loss"}</span>
                                <span className="v">{fmtUsdSigned(sell.realized)}</span>
                              </div>
                            </>
                          )}
                        </div>
                      </details>
                    </>
                  )}
                </div>
              </div>

              <OrderBookCard />
            </aside>
          </div>
        </main>
      </div>

      <div className="hotkey-bar">
        <span><kbd>⌘K</kbd> markets</span>
        <span><kbd>B</kbd> buy yes</span>
        <span><kbd>N</kbd> buy no</span>
        <span><kbd>S</kbd> sell</span>
      </div>
    </>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function RailTickers({ active }: { active: string }) {
  const TICKERS = [
    { sym: "META", spot: 679.84, chg: 0.32 },
    { sym: "NVDA", spot: 1342.71, chg: 1.39 },
    { sym: "AAPL", spot: 229.84, chg: 0.54 },
    { sym: "MSFT", spot: 441.62, chg: 0.73 },
    { sym: "GOOGL", spot: 184.27, chg: -0.5 },
    { sym: "AMZN", spot: 201.13, chg: 0.2 },
    { sym: "TSLA", spot: 261.04, chg: -0.7 },
  ];
  return (
    <details className="rail-section" id="rail-tickers" open>
      <summary className="rail-section-h">
        <span className="rail-section-title">Tickers</span>
        <span className="rail-chevron" aria-hidden="true">▾</span>
      </summary>
      <div className="rail-section-body">
        <div className="rail-ticker-list">
          {TICKERS.map((t) => (
            <Link
              key={t.sym}
              href={`/trade/${t.sym}/680`}
              className={`rail-ticker${t.sym === active ? " active" : ""}`}
            >
              <div className="rail-ticker-info">
                <span className="rail-ticker-sym">{t.sym}</span>
                <span className="rail-ticker-spot">${t.spot.toFixed(2)}</span>
              </div>
              <span className={`rail-ticker-chg ${t.chg >= 0 ? "up" : "down"}`}>
                {t.chg >= 0 ? "+" : ""}
                {t.chg.toFixed(2)}%
              </span>
            </Link>
          ))}
        </div>
      </div>
    </details>
  );
}

// STATIC FIXTURE — wire to useAllMarkets × usePosition(wallet) post-MVP for live rail.
function RailPositions() {
  return (
    <details className="rail-section" id="rail-positions" open data-mock="true">
      <summary className="rail-section-h">
        <span className="rail-section-title">My positions · 3</span>
        <span className="rail-chevron" aria-hidden="true">▾</span>
      </summary>
      <div className="rail-section-body">
        <div className="rail-position">
          <div>
            <span className="rail-position-market">META.680.YES</span>
            <br />
            <span className="rail-position-side">5 · entry $0.62</span>
          </div>
          <span className="rail-position-pnl down">−$0.50</span>
        </div>
        <div className="rail-position">
          <div>
            <span className="rail-position-market">NVDA.1340.NO</span>
            <br />
            <span className="rail-position-side">3 · entry $0.50</span>
          </div>
          <span className="rail-position-pnl down">−$0.06</span>
        </div>
        <div className="rail-position">
          <div>
            <span className="rail-position-market">AAPL.230.YES</span>
            <br />
            <span className="rail-position-side">8 · entry $0.42</span>
          </div>
          <span className="rail-position-pnl up">+$2.80</span>
        </div>
      </div>
    </details>
  );
}

// STATIC FIXTURE — wire to useLeaderboard("weekly") once Bram's indexer URL ships.
function RailLeaders() {
  return (
    <details className="rail-section" id="rail-leaders" open data-mock="true">
      <summary className="rail-section-h">
        <span className="rail-section-title">🏆 Weekly leaders</span>
        <Link href="/leaderboard" className="rail-section-link" onClick={(e) => e.stopPropagation()}>
          all →
        </Link>
        <span className="rail-chevron" aria-hidden="true">▾</span>
      </summary>
      <div className="rail-section-body">
        <div className="rail-lb-row">
          <span className="rank gold">#1</span>
          <span className="name">degen.sol</span>
          <span className="pnl">+$2,847</span>
        </div>
        <div className="rail-lb-row">
          <span className="rank silver">#2</span>
          <span className="name">maxprob.eth</span>
          <span className="pnl">+$2,103</span>
        </div>
        <div className="rail-lb-row">
          <span className="rank bronze">#3</span>
          <span className="name">quantfox</span>
          <span className="pnl">+$1,876</span>
        </div>
      </div>
    </details>
  );
}

function ChartCard({ ticker, strike }: { ticker: string; strike: number }) {
  return (
    <div className="chart-card">
      <div className="chart-h compact">
        <div className="chart-headline">
          <div className="chart-price mono">$0.520</div>
          <span className="chart-delta up mono">+$0.04 · +8.3%</span>
        </div>
        <div className="chart-quick-stats">
          {[
            ["O", "0.480"],
            ["H", "0.545"],
            ["L", "0.460"],
            ["VWAP", "0.504"],
            ["Spread", "7.7%"],
            ["B/A", "0.500/0.540"],
          ].map(([k, v]) => (
            <div key={k as string}>
              <span className="lbl">{k}</span>
              <span className="val mono">{v}</span>
            </div>
          ))}
        </div>
        <div className="chart-controls">
          <div className="chart-tabs">
            {["1m", "5m", "15m", "1h", "4h", "1d"].map((t) => (
              <button key={t} className={`chart-tab${t === "1h" ? " active" : ""}`} type="button">
                {t}
              </button>
            ))}
          </div>
          <div className="chart-icons">
            <button className="chart-icon-btn active" title="Line chart" type="button" aria-label="Line chart">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1,12 5,8 9,10 14,3" />
              </svg>
            </button>
            <button className="chart-icon-btn" title="Candle chart" type="button" aria-label="Candle chart">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="6" width="3" height="6" />
                <line x1="4.5" y1="3" x2="4.5" y2="6" />
                <line x1="4.5" y1="12" x2="4.5" y2="14" />
                <rect x="10" y="4" width="3" height="7" />
                <line x1="11.5" y1="2" x2="11.5" y2="4" />
                <line x1="11.5" y1="11" x2="11.5" y2="13" />
              </svg>
            </button>
          </div>
          <button className="chart-watch-btn" title="Watch this market" aria-label="Watch this market" type="button">
            ★
          </button>
        </div>
      </div>
      <div className="chart-viz">
        <div className="chart-grid-bg" />
        <svg viewBox="0 0 800 440" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, padding: "12px 50px 12px 12px" }}>
          <defs>
            <linearGradient id="cv-grad-7" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.5" />
              <stop offset="50%" stopColor="#22d3ee" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M 0,360 L 40,350 L 80,340 L 120,345 L 160,325 L 200,320 L 240,300 L 280,305 L 320,285 L 360,270 L 400,275 L 440,250 L 480,255 L 520,225 L 560,215 L 600,195 L 640,185 L 680,165 L 720,155 L 760,135 L 800,120 L 800,440 L 0,440 Z"
            fill="url(#cv-grad-7)"
          />
          <polyline
            points="0,360 40,350 80,340 120,345 160,325 200,320 240,300 280,305 320,285 360,270 400,275 440,250 480,255 520,225 560,215 600,195 640,185 680,165 720,155 760,135 800,120"
            fill="none"
            stroke="#22d3ee"
            strokeWidth="2"
          />
          <circle cx="800" cy="120" r="4" fill="#22d3ee" />
        </svg>
        <div className="chart-strike-line" style={{ top: "50%" }} />
        <div className="chart-strike-label" style={{ top: "50%" }}>${strike} (ATM)</div>
        <div className="chart-y-axis">
          {["0.70", "0.65", "0.60", "0.55"].map((v) => <div key={v}>{v}</div>)}
          <div className="current mono">0.52</div>
          {["0.50", "0.45", "0.40"].map((v) => <div key={v}>{v}</div>)}
        </div>
      </div>
    </div>
  );
}

function PositionCard({ pos, outcome }: { pos: { contracts: number; avgEntry: number; costBasis: number }; outcome: Outcome }) {
  const value = pos.contracts * 0.52;
  const pnl = value - pos.costBasis;
  const pnlPct = pos.costBasis ? (pnl / pos.costBasis) * 100 : 0;
  return (
    <div className="info-card">
      <div className="info-card-h">
        <h3>Your position</h3>
        <span className="live-badge">P&amp;L live</span>
      </div>
      <div className="pos-body compact">
        <div className="pos-summary-compact">
          <span className={`pos-side-badge ${outcome === "yes" ? "" : "no"}`}>
            {outcome === "yes" ? "⬆" : "⬇"} {outcome.toUpperCase()} · {pos.contracts}
          </span>
          <span className="pos-stat-inline mono"><span className="lbl">Cost</span> <span className="val">${pos.costBasis.toFixed(2)}</span></span>
          <span className="pos-stat-inline mono"><span className="lbl">Value</span> <span className="val">${value.toFixed(2)}</span></span>
          <span className="pos-stat-inline mono"><span className="lbl">Avg</span> <span className="val">${pos.avgEntry.toFixed(2)}</span></span>
          <span className={`pos-pnl-val ${pnl >= 0 ? "up" : "down"} mono`}>{fmtUsdSigned(pnl)}</span>
          <span className={`pos-pnl-pct ${pnl >= 0 ? "up" : "down"}`}>{pnl >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%</span>
        </div>
      </div>
      <div className="info-card-subsection">
        <div className="info-card-subsection-h">
          <span className="subsection-title">Settlement preview · 3 scenarios</span>
          <span className="subsection-meta mono">vs current pos</span>
        </div>
        <div className="settle-body compact">
          <div className="scenario-line exit">
            <span className="scenario-dot" aria-hidden="true" />
            <span className="scenario-label">Exit now</span>
            <span className="scenario-action mono">sell {pos.contracts} YES @ $0.500</span>
            <span className="scenario-pnl down mono">−$0.60</span>
          </div>
          <div className="scenario-line hold-win">
            <span className="scenario-dot" aria-hidden="true" />
            <span className="scenario-label">Hold · YES wins <span className="scenario-prob">52%</span></span>
            <span className="scenario-action mono">META ≥ strike @ 4PM</span>
            <span className="scenario-pnl up mono">+$1.90</span>
          </div>
          <div className="scenario-line hold-lose">
            <span className="scenario-dot" aria-hidden="true" />
            <span className="scenario-label">Hold · YES loses <span className="scenario-prob">48%</span></span>
            <span className="scenario-action mono">META &lt; strike @ 4PM</span>
            <span className="scenario-pnl down mono">−$3.10</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function OpenOrdersTrades() {
  const [tab, setTab] = useState<"orders" | "trades">("orders");
  return (
    <div className="info-card orders-trades-card" data-tab={tab}>
      <div className="info-card-h orders-trades-h">
        <div className="orders-trades-tabs" role="tablist">
          <button
            className={`otab${tab === "orders" ? " active" : ""}`}
            data-ot-tab="orders"
            role="tab"
            aria-selected={tab === "orders"}
            onClick={() => setTab("orders")}
            type="button"
          >
            Open orders <span className="otab-count">2</span>
          </button>
          <button
            className={`otab${tab === "trades" ? " active" : ""}`}
            data-ot-tab="trades"
            role="tab"
            aria-selected={tab === "trades"}
            onClick={() => setTab("trades")}
            type="button"
          >
            Recent trades <span className="otab-live" aria-label="live" />
          </button>
        </div>
      </div>

      <div className="ot-content" data-ot-content="orders" hidden={tab !== "orders"}>
        <div className="order-row-trade">
          <span className="order-side-tag yes">YES</span>
          <span className="order-detail-text">
            META.680 · 50 @ <span className="px">$0.55</span>
            <br />
            <span className="fill-state">30/50 filled · 4m ago</span>
          </span>
          <button className="cancel-btn" type="button">CANCEL</button>
        </div>
        <div className="order-row-trade">
          <span className="order-side-tag no">NO</span>
          <span className="order-detail-text">
            AAPL.230 · 100 @ <span className="px">$0.20</span>
            <br />
            <span className="fill-state">pending · 12m ago</span>
          </span>
          <button className="cancel-btn" type="button">CANCEL</button>
        </div>
        <div className="ot-footer">
          <Link href="/portfolio?tab=orders" className="ot-link">View all orders →</Link>
        </div>
      </div>

      <div className="ot-content ot-scroll" data-ot-content="trades" hidden={tab !== "trades"}>
        <div className="trade-rows-h">
          <div>time</div>
          <div>market</div>
          <div>price</div>
          <div>size</div>
          <div>side</div>
        </div>
        {[
          ["14:46:31", "META.680", "0.520", "200", "BUY", "up", "buy"],
          ["14:46:18", "NVDA.1340", "0.485", "125", "SELL", "down", "sell"],
          ["14:46:11", "META.680", "0.480", "500", "SELL", "down", "sell"],
          ["14:45:54", "AAPL.230", "0.420", "100", "BUY", "up", "buy"],
          ["14:45:32", "META.680", "0.510", "75", "BUY", "up", "buy"],
        ].map((r, i) => (
          <div className="trade-row-tab" key={i}>
            <span className="time">{r[0]}</span>
            <span className="mkt">{r[1]}</span>
            <span className={`price ${r[5]} mono`}>{r[2]}</span>
            <span className="size mono">{r[3]}</span>
            <span className={`side ${r[6]}`}>{r[4]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrderBookCard() {
  const [view, setView] = useState<"yes" | "no" | "both">("both");
  return (
    <div className="ob-card" data-view={view}>
      <div className="ob-h">
        <h3>Order book</h3>
        <div className="ob-pick" role="tablist">
          {(["yes", "no", "both"] as const).map((v) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              onClick={() => setView(v)}
              type="button"
            >
              {v.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="ob-single" hidden={view === "both"}>
        <div className="ob-rows-h">
          <div>price</div>
          <div>size</div>
          <div>total</div>
        </div>
        {[
          ["0.555", "490", "1,964", 18],
          ["0.550", "375", "1,474", 14],
          ["0.545", "722", "1,099", 26],
          ["0.540", "377", "377", 12],
        ].map(([p, s, t, w], i) => (
          <div className="ob-row ask" key={i}>
            <div className="depth-bar" style={{ width: `${w}%` }} />
            <span className="price">{p}</span>
            <span className="size">{s}</span>
            <span className="total">{t}</span>
          </div>
        ))}
        <div className="ob-spread">
          <span className="last mono">$0.520 ↑</span>
          <span className="spread mono">spread 0.040 · 7.7%</span>
        </div>
        {[
          ["0.500", "560", "560", 20],
          ["0.495", "440", "1,000", 16],
          ["0.490", "830", "1,830", 30],
          ["0.485", "270", "2,100", 10],
        ].map(([p, s, t, w], i) => (
          <div className="ob-row bid" key={i}>
            <div className="depth-bar" style={{ width: `${w}%` }} />
            <span className="price">{p}</span>
            <span className="size">{s}</span>
            <span className="total">{t}</span>
          </div>
        ))}
      </div>

      <div className="ob-both" hidden={view !== "both"}>
        <div className="ob-both-explain">
          YES + NO are separate tradeable contracts. Prices sum to ~$1 (binary payoff).
        </div>
        <BookCol side="YES" />
        <BookCol side="NO" />
      </div>
    </div>
  );
}

function BookCol({ side }: { side: "YES" | "NO" }) {
  const isYes = side === "YES";
  const last = isYes ? "$0.520" : "$0.480";
  const asks = isYes
    ? [["0.555", "490", "1,964", 18], ["0.550", "375", "1,474", 14], ["0.545", "722", "1,099", 26], ["0.540", "377", "377", 12]]
    : [["0.515", "560", "2,100", 20], ["0.510", "440", "1,540", 16], ["0.505", "830", "1,100", 30], ["0.500", "270", "270", 10]];
  const bids = isYes
    ? [["0.500", "560", "560", 20], ["0.495", "440", "1,000", 16], ["0.490", "830", "1,830", 30], ["0.485", "270", "2,100", 10]]
    : [["0.460", "490", "490", 18], ["0.455", "375", "865", 14], ["0.450", "722", "1,587", 26], ["0.445", "377", "1,964", 12]];
  return (
    <div className="ob-both-col">
      <div className="ob-both-h">
        <span>{side}</span>
        <span className="ob-both-h-meta mono">last {last}</span>
      </div>
      <div className="ob-rows-h">
        <div>price</div>
        <div>size</div>
        <div>total</div>
      </div>
      <div className="ob-section-label asks">— Asks (selling {side}) —</div>
      {asks.map(([p, s, t, w], i) => (
        <div className="ob-row ask" key={i}>
          <div className="depth-bar" style={{ width: `${w}%` }} />
          <span className="price">{p}</span>
          <span className="size">{s}</span>
          <span className="total">{t}</span>
        </div>
      ))}
      <div className="ob-section-label bids">— Bids (buying {side}) —</div>
      {bids.map(([p, s, t, w], i) => (
        <div className="ob-row bid" key={i}>
          <div className="depth-bar" style={{ width: `${w}%` }} />
          <span className="price">{p}</span>
          <span className="size">{s}</span>
          <span className="total">{t}</span>
        </div>
      ))}
    </div>
  );
}
