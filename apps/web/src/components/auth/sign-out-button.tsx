"use client";

import { useCallback, useState } from "react";
import { signOut } from "next-auth/react";

export function SignOutButton(props: {
  /** Where to land after sign-out. Defaults to landing. */
  callbackUrl?: string;
  className?: string;
  label?: string;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const handle = useCallback(async () => {
    setSigningOut(true);
    try {
      await signOut({ callbackUrl: props.callbackUrl ?? "/" });
    } finally {
      setSigningOut(false);
    }
  }, [props.callbackUrl]);

  return (
    <button
      type="button"
      onClick={handle}
      disabled={signingOut}
      className={props.className}
    >
      {signingOut ? "Signing out..." : (props.label ?? "Sign out")}
    </button>
  );
}
