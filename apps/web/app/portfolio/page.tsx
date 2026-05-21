export default function PortfolioPage() {
  return (
    <section className="container py-12">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Your positions
        </h1>
        <p className="text-sm text-muted-foreground">
          Open Yes/No positions, unrealized P&amp;L, redeem flow after settlement.
          (TBD — wired up Day 2.)
        </p>
      </header>
      <div className="rounded-lg border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
        Portfolio placeholder.
      </div>
    </section>
  );
}
