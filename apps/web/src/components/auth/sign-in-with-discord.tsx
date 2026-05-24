"use client";

import { SignInButton } from "./sign-in-button";

export function SignInWithDiscord(props: { callbackUrl?: string; className?: string }) {
  return (
    <SignInButton
      provider="discord"
      label="Continue with Discord"
      callbackUrl={props.callbackUrl}
      className={props.className}
    />
  );
}
