"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

function ErrorInner() {
  const params = useSearchParams();
  const error = params.get("error") ?? "Unknown error";

  return (
    <main style={{ maxWidth: 480, margin: "80px auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        Sign-in failed
      </h1>
      <p
        style={{
          fontSize: 13,
          padding: 12,
          border: "1px solid rgba(239,68,68,0.4)",
          background: "rgba(239,68,68,0.06)",
          borderRadius: 6,
          marginBottom: 16,
        }}
      >
        {error}
      </p>
      <Link href="/auth/signin" className="link">
        Try again →
      </Link>
    </main>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense fallback={null}>
      <ErrorInner />
    </Suspense>
  );
}
