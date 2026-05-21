import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function LandingPage() {
  return (
    <section className="container flex flex-col items-center gap-8 py-24 text-center">
      <div className="space-y-4">
        <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          Solana · Devnet preview
        </p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Binary markets on daily MAG7 closes.
        </h1>
        <p className="mx-auto max-w-2xl text-balance text-muted-foreground">
          BellMarkets settles $1 USDC payouts on-chain at the 4PM ET close.
          Non-custodial. Yes/No contracts. Coming soon.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg">
          <Link href="/markets">Explore markets</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/portfolio">Your positions</Link>
        </Button>
      </div>
    </section>
  );
}
