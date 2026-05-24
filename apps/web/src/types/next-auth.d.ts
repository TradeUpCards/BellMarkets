import type { DefaultSession, DefaultUser } from "next-auth";

declare module "next-auth" {
  /** Augmented session shape — `id` + `username` available on `session.user`. */
  interface Session {
    user: {
      id?: string;
      username?: string;
    } & DefaultSession["user"];
  }

  interface User extends DefaultUser {
    username?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    username?: string;
  }
}
