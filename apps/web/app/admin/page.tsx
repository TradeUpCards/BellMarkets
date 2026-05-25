import "../v8-trade.css";
import "../v8-landing.css";

import { SiteChrome } from "@/components/v8/site-chrome";
import { AdminView } from "./admin-view";

/**
 * /admin — operational admin surface (NOT a v1 demo feature).
 *
 * Honest narration: this is an operational console, not a polished product
 * page. Reviewers can navigate here if they're curious about the protocol's
 * admin surface; the v1 demo script doesn't walk through it.
 *
 * Wallet-gated: the page renders a "Not authorized" state until the
 * connected wallet matches `MarketConfig.admin`. All actions (`pause`,
 * `admin_settle`) require an admin signature — there is no server-side
 * keypair.
 */
export default function AdminPage() {
  return (
    <SiteChrome active="markets">
      <AdminView />
    </SiteChrome>
  );
}
