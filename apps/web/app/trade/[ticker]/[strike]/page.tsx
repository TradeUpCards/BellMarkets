import "../../../v8-trade.css";

import { SiteChrome } from "@/components/v8/site-chrome";
import { TradeView } from "./trade-view";

interface TradePageProps {
  params: {
    ticker: string;
    strike: string;
  };
}

export default function TradePage({ params }: TradePageProps) {
  return (
    <SiteChrome active="trade">
      <TradeView ticker={params.ticker} strike={params.strike} />
    </SiteChrome>
  );
}
