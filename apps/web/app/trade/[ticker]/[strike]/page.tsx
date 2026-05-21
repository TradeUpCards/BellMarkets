interface TradePageProps {
  params: {
    ticker: string;
    strike: string;
  };
}

export default function TradePage({ params }: TradePageProps) {
  return (
    <section className="container py-12">
      <header className="mb-6 space-y-2">
        <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          {params.ticker} / strike {params.strike}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Trade panel</h1>
        <p className="text-sm text-muted-foreground">
          Yes / No order book with position-aware actions. (TBD — wired up Day 2.)
        </p>
      </header>
      <div className="rounded-lg border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
        Trade panel placeholder.
      </div>
    </section>
  );
}
