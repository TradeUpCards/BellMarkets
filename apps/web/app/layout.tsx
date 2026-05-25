import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import { Providers } from "./providers";

import "./globals.css";

const fontSans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Bell.Markets — non-custodial markets for MAG7 daily binary options",
  description:
    "Non-custodial Solana markets for binary outcome contracts on daily MAG7 stock prices. $1 bUSDC payouts settled on-chain by Pyth at 4 PM ET.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" className="dark" suppressHydrationWarning>
      <body
        className={`${fontSans.variable} ${fontMono.variable}`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
