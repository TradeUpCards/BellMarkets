import type { PublicKey } from "@solana/web3.js";

const toBase58 = (pk: PublicKey | string | null | undefined): string =>
  pk == null ? "null" : typeof pk === "string" ? pk : pk.toBase58();

export const queryKeys = {
  all: ["bell-markets"] as const,

  markets: {
    all: () => [...queryKeys.all, "markets"] as const,
    list: () => [...queryKeys.markets.all(), "list"] as const,
    detail: (marketPda: PublicKey | string | null) =>
      [...queryKeys.markets.all(), "detail", toBase58(marketPda)] as const,
  },

  config: () => [...queryKeys.all, "config"] as const,

  position: (
    wallet: PublicKey | string | null,
    marketPda: PublicKey | string | null,
  ) =>
    [
      ...queryKeys.all,
      "position",
      toBase58(wallet),
      toBase58(marketPda),
    ] as const,

  orderBook: (phoenixMarketPda: PublicKey | string | null) =>
    [...queryKeys.all, "order-book", toBase58(phoenixMarketPda)] as const,

  tickerConfig: (pythFeed: PublicKey | string | null) =>
    [...queryKeys.all, "ticker-config", toBase58(pythFeed)] as const,

  userConfig: (wallet: PublicKey | string | null) =>
    [...queryKeys.all, "user-config", toBase58(wallet)] as const,

  openOrders: (
    phoenixMarketPda: PublicKey | string | null,
    wallet: PublicKey | string | null,
  ) =>
    [
      ...queryKeys.all,
      "open-orders",
      toBase58(phoenixMarketPda),
      toBase58(wallet),
    ] as const,

  rewardsPool: (period: "weekly" | "monthly") =>
    [...queryKeys.all, "rewards-pool", period] as const,

  creatorRebate: (
    marketPda: PublicKey | string | null,
    wallet: PublicKey | string | null,
  ) =>
    [
      ...queryKeys.all,
      "creator-rebate",
      toBase58(marketPda),
      toBase58(wallet),
    ] as const,

  leaderboard: (period: "weekly" | "monthly") =>
    [...queryKeys.all, "leaderboard", period] as const,
} as const;

export type BellMarketsQueryKey = ReturnType<
  | typeof queryKeys.markets.list
  | typeof queryKeys.markets.detail
  | typeof queryKeys.config
  | typeof queryKeys.position
  | typeof queryKeys.orderBook
  | typeof queryKeys.tickerConfig
  | typeof queryKeys.userConfig
  | typeof queryKeys.openOrders
  | typeof queryKeys.rewardsPool
  | typeof queryKeys.creatorRebate
  | typeof queryKeys.leaderboard
>;
