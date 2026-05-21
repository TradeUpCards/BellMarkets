// Off-chain Pyth HTTP client wrapper for previous-close reads at the
// morning strike-calc job. Settlement reads are on-chain (Aria's Anchor
// program parses the Pyth price account directly — see
// specs/architecture.md §2.1); this client is *only* for the off-chain
// previous-close lookup that feeds strike-calc.
//
// Design notes:
//   - Base URL injected from env (PYTH_HTTP_BASE_URL).
//   - `fetchImpl` injectable for tests; defaults to globalThis.fetch
//     (Node 20+ has fetch built-in). This keeps the unit tests deterministic
//     and avoids hitting live Pyth in CI (constitution/hard-rules.md §2.2).
//   - Feed-id resolution is left to the caller for now: the morning job
//     hard-codes the MAG7 ticker → Pyth feed-id map (which itself is
//     coordinated with Aria, who maintains the on-chain ticker→feed
//     mapping in MarketConfig.pyth_feed_map).
//   - No persistent caching, no retry-with-backoff inside the client.
//     Retries are the caller's concern (Trigger.dev's job retry policy
//     handles that — see trigger.config.ts).

import type { Ticker } from "../types.js";

export type PythPriceFeed = {
  /** Ticker symbol (e.g. "META"). */
  ticker: Ticker;
  /** Pyth feed id (hex string), resolved by the caller. */
  feedId: string;
};

export type PythClientOptions = {
  /** Pyth HTTP base URL — e.g. `https://hermes.pyth.network/api`. */
  baseUrl: string;
  /** Override the fetch implementation. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export type PreviousCloseResponse = {
  ticker: Ticker;
  /** USD, human-readable (e.g., 680 for $680). */
  price: number;
  /** Timestamp of the previous-close read (unix seconds). */
  publishTime: number;
};

export class PythClientError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PythClientError";
  }
}

/**
 * Off-chain Pyth client. Stateless. Cheap to construct per request.
 *
 * NOTE: the "/v2/updates/price/latest" endpoint shape below mirrors the
 * Hermes API contract as of 2026-05. Hermes returns the most recent
 * verified price; we treat that as the previous-close proxy at morning
 * job time (~8am ET, well after prior trading day close). When Hermes
 * ships a dedicated previous-close endpoint we'd switch to that; for
 * the demo build window this is sufficient.
 */
export class PythClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PythClientOptions) {
    if (!opts.baseUrl) throw new Error("PythClient requires baseUrl");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("PythClient requires a fetch implementation (Node ≥ 18 has it built-in)");
    }
  }

  /**
   * Fetch the latest verified price for a Pyth feed and return it in
   * the shape the morning strike-calc job consumes. The caller is
   * responsible for supplying the feed-id (resolution is owned by the
   * morning job's ticker→feed map).
   */
  async getPreviousClose(feed: PythPriceFeed): Promise<PreviousCloseResponse> {
    const url = `${this.baseUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(feed.feedId)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (cause) {
      throw new PythClientError(`Pyth fetch failed for ${feed.ticker}`, cause);
    }
    if (!res.ok) {
      throw new PythClientError(`Pyth HTTP ${res.status} for ${feed.ticker}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new PythClientError(`Pyth response was not JSON for ${feed.ticker}`, cause);
    }
    return parsePreviousCloseResponse(feed.ticker, body);
  }
}

// Exported separately so tests can exercise parsing without spinning up
// the full client. Tolerant to minor schema drift — picks the first
// element of `parsed` regardless of array vs single-object shape.
export function parsePreviousCloseResponse(ticker: Ticker, body: unknown): PreviousCloseResponse {
  if (!body || typeof body !== "object") {
    throw new PythClientError(`Pyth response body was not an object for ${ticker}`);
  }
  const parsed = (body as { parsed?: unknown }).parsed;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new PythClientError(`Pyth response had no "parsed" entries for ${ticker}`);
  }
  const first = parsed[0] as
    | {
        price?: { price?: string | number; expo?: number; publish_time?: number };
      }
    | undefined;
  const priceField = first?.price;
  if (!priceField || priceField.price === undefined || priceField.expo === undefined) {
    throw new PythClientError(`Pyth response missing price/expo for ${ticker}`);
  }
  const rawPrice = typeof priceField.price === "string" ? Number(priceField.price) : priceField.price;
  if (!Number.isFinite(rawPrice)) {
    throw new PythClientError(`Pyth price was not a finite number for ${ticker}`);
  }
  // Pyth Hermes reports price as integer + expo (typically negative,
  // e.g. price=68012345678, expo=-8 → $680.12345678). Multiply.
  const humanPrice = rawPrice * 10 ** priceField.expo;
  if (!Number.isFinite(humanPrice) || humanPrice <= 0) {
    throw new PythClientError(`Pyth price decoded to non-positive value for ${ticker}`);
  }
  const publishTime = priceField.publish_time ?? 0;
  return { ticker, price: humanPrice, publishTime };
}
