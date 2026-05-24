/**
 * Protected-route gate for DR-014's authenticated surfaces.
 *
 * NextAuth v4 ships a "withAuth" helper that wraps middleware and 302s any
 * unauthenticated request to the configured `pages.signIn` (/auth/signin
 * per our authOptions). Anything matching the matcher below requires an
 * active session.
 *
 * `/profile/**` and `/settings/**` are the v1 protected surfaces. The
 * matcher uses a path-prefix pattern so future authenticated routes
 * (notifications, billing-detail) only need a route folder add, not a
 * middleware edit. **Trade routes (`/trade/[ticker]/[strike]`) stay public**
 * — wallet identity is sufficient for trading; OAuth identity is only
 * required for the marketing-loop surfaces.
 */
export { default } from "next-auth/middleware";

export const config = {
  matcher: ["/profile/:path*", "/settings/:path*"],
};
