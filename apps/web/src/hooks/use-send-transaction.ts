"use client";

import { useCallback, useState } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Transaction, TransactionSignature } from "@solana/web3.js";

export interface SendTxOptions {
  /** Query keys to invalidate once the transaction is confirmed. */
  invalidateOnSuccess?: QueryKey[];
  /**
   * Optional optimistic cache writer. Runs synchronously the moment the user
   * approves the tx in their wallet (before broadcast confirmation). The
   * WebSocket subscription bridge will overwrite this cache value once the
   * on-chain account change actually lands — so the optimistic value only
   * needs to be a plausible interim, not a perfect prediction.
   */
  applyOptimistic?: (queryClient: ReturnType<typeof useQueryClient>) => void;
  /** Pass-through commitment level for confirmTransaction. */
  commitment?: "processed" | "confirmed" | "finalized";
}

export interface SendTxStatus {
  status:
    | "idle"
    | "building"
    | "signing"
    | "broadcasting"
    | "confirming"
    | "success"
    | "error";
  signature: TransactionSignature | null;
  error: Error | null;
}

/**
 * Send a Solana transaction through the connected wallet adapter and invalidate
 * downstream caches on confirmation. Subscription-driven hooks
 * (`useAccountSubscription`-based) will pick up the real on-chain state via
 * WebSocket — invalidation here is a defensive belt against the WebSocket
 * missing an event, plus a hook for explicit "refetch now that we know
 * something changed" patterns the Trade panel will want.
 *
 * Wallet signing is non-custodial per Hard YES #10 — the user signs each tx
 * in their wallet UI. We never see a private key.
 *
 * Composite-tx flows (atomic Buy No / future Sell No) build their multi-ix
 * Transaction client-side; the user signs ONE Transaction containing all
 * instructions, preserving POV-3 atomicity.
 */
export function useSendTransaction(opts: SendTxOptions = {}) {
  const { connection } = useConnection();
  const { sendTransaction, publicKey } = useWallet();
  const queryClient = useQueryClient();

  const [state, setState] = useState<SendTxStatus>({
    status: "idle",
    signature: null,
    error: null,
  });

  const mutation = useMutation({
    mutationFn: async (tx: Transaction): Promise<TransactionSignature> => {
      if (!publicKey) throw new Error("Wallet not connected");

      setState({ status: "signing", signature: null, error: null });

      // Run optimistic cache write before broadcast. The WebSocket bridge will
      // overwrite this on the next on-chain account change — we don't need a
      // rollback path because the cache writes from setQueryData are idempotent
      // and the source of truth always wins.
      if (opts.applyOptimistic) {
        opts.applyOptimistic(queryClient);
      }

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash(opts.commitment ?? "confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      setState((s) => ({ ...s, status: "broadcasting" }));
      const signature = await sendTransaction(tx, connection);

      setState({ status: "confirming", signature, error: null });

      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        opts.commitment ?? "confirmed",
      );

      // Belt-and-suspenders against WebSocket miss — explicitly invalidate the
      // caller-named query keys. The next render's queryFn will refetch and
      // the subscription bridge will resume from there.
      if (opts.invalidateOnSuccess) {
        for (const key of opts.invalidateOnSuccess) {
          await queryClient.invalidateQueries({ queryKey: key });
        }
      }

      setState({ status: "success", signature, error: null });
      return signature;
    },
    onError: (err) => {
      setState((s) => ({
        ...s,
        status: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      }));
    },
  });

  const send = useCallback(
    (tx: Transaction): Promise<TransactionSignature> => mutation.mutateAsync(tx),
    [mutation],
  );

  const reset = useCallback(() => {
    setState({ status: "idle", signature: null, error: null });
    mutation.reset();
  }, [mutation]);

  return {
    send,
    reset,
    ...state,
    isPending:
      state.status === "signing" ||
      state.status === "broadcasting" ||
      state.status === "confirming",
  };
}
