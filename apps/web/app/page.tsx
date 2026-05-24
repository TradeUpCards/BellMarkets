import "./v8-trade.css";
import "./v8-landing.css";

import { SiteChrome } from "@/components/v8/site-chrome";
import { LandingView } from "./landing-view";

export default function LandingPage() {
  return (
    <SiteChrome active="markets">
      <LandingView />
    </SiteChrome>
  );
}
