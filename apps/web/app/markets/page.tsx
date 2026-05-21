export default function MarketsPage() {
  return (
    <section className="container py-12">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">MAG7 markets</h1>
        <p className="text-sm text-muted-foreground">
          One Yes/No contract per ticker per day at the strike calculated this
          morning. Settles at 4PM ET. (TBD — wired up Day 2.)
        </p>
      </header>
      <div className="rounded-lg border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
        Market list placeholder — coming Day 2.
      </div>
    </section>
  );
}
