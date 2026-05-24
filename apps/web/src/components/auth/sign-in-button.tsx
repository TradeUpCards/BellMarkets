"use client";

import { useLinkSignIn, type LinkProvider } from "@/hooks/use-link-sign-in";

interface SignInButtonProps {
  provider: LinkProvider;
  label: string;
  callbackUrl?: string;
  /** Optional class — caller decides visual treatment. Stays design-agnostic here. */
  className?: string;
  /** Optional click-side disable, e.g. while a higher-level state is unstable. */
  disabled?: boolean;
}

/**
 * Minimal sign-in trigger. Per Tate's directive: "UI can be minimal
 * text-button stubs — design comes later." This component owns the
 * wallet-sign + cookie-set + `signIn()` flow; the wrapper components
 * (`SignInWithDiscord`, `SignInWithGoogle`, `SignInWithX`) just configure
 * label + provider.
 */
export function SignInButton({
  provider,
  label,
  callbackUrl,
  className,
  disabled,
}: SignInButtonProps) {
  const { start, signingIn, error, walletConnected } = useLinkSignIn();
  const isDisabled = disabled || signingIn;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => start(provider, callbackUrl)}
        disabled={isDisabled}
        data-provider={provider}
        data-wallet-linked={walletConnected ? "yes" : "no"}
      >
        {signingIn ? "Signing in..." : label}
      </button>
      {error ? (
        <p role="alert" data-auth-error>
          {error}
        </p>
      ) : null}
    </div>
  );
}
