"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import type { Adapter } from "@solana/wallet-adapter-base";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "next-auth/react";

import { SOLANA_RPC_ENDPOINT } from "@/lib/solana/config";
import { Toaster } from "@/components/ui/toaster";

import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: ReactNode }) {
  // Phantom + Solflare adapters explicitly. Backpack is picked up via the
  // Wallet Standard auto-discovery already baked into @solana/wallet-adapter-react,
  // so users with the Backpack extension see it in the modal without an
  // explicit adapter here. Adding more explicit adapters re-introduces the
  // WalletConnect/Reown transitive bundle we deliberately dropped.
  const wallets = useMemo<Adapter[]>(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <SessionProvider
      // SessionProvider needs to be the outermost wrapper so any client
      // component (including the wallet-adapter wallets themselves) can call
      // `useSession()` for the wallet+OAuth dual-identity flow per DR-014.
      // `refetchOnWindowFocus={false}` aligns with TanStack's posture and
      // avoids a stampede of /api/auth/session calls when the user tabs back.
      refetchOnWindowFocus={false}
    >
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider endpoint={SOLANA_RPC_ENDPOINT}>
          <WalletProvider wallets={wallets} autoConnect>
            <WalletModalProvider>
              {children}
              <Toaster />
            </WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}
