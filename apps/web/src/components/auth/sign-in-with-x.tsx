"use client";

import { SignInButton } from "./sign-in-button";

export function SignInWithX(props: { callbackUrl?: string; className?: string }) {
  return (
    <SignInButton
      provider="twitter"
      label="Continue with X"
      callbackUrl={props.callbackUrl}
      className={props.className}
    />
  );
}
