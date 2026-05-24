"use client";

import { SignInButton } from "./sign-in-button";

export function SignInWithGoogle(props: { callbackUrl?: string; className?: string }) {
  return (
    <SignInButton
      provider="google"
      label="Continue with Google"
      callbackUrl={props.callbackUrl}
      className={props.className}
    />
  );
}
