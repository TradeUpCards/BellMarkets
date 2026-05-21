export default function HistoryPage() {
  return (
    <section className="container py-12">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Trade history
        </h1>
        <p className="text-sm text-muted-foreground">
          Past fills, settlement records, redemption receipts. (TBD — wired up
          Day 2.)
        </p>
      </header>
      <div className="rounded-lg border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
        History placeholder.
      </div>
    </section>
  );
}
