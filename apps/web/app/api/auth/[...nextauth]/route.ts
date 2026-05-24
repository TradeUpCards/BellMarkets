import NextAuth from "next-auth";

// Deep-import the auth-options module rather than the root barrel — the
// barrel transitively pulls in discord.js / web-push / arweave which drag
// optional native deps (zlib-sync, etc.) that don't bundle for the browser
// edge of the build. The options module itself only depends on db + types.
import { bellMarketsAuthOptions } from "@bell-markets/automation/src/auth/options.js";

const handler = NextAuth(bellMarketsAuthOptions);

export { handler as GET, handler as POST };
