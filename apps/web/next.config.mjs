/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Day-3 build-hang investigation: typecheck PASSes in isolation in ~10s but
  // `next build` hangs at the banner. The Phoenix SDK is a CJS/ESM dual-publish
  // (index.js + index.mjs) with a `borsh@0.7` direct dep that lives alongside
  // anchor's `@coral-xyz/borsh@0.30.1` — webpack module resolution can grind
  // indefinitely on this on Windows. Force Phoenix through Next's transpile
  // pipeline so its module graph is normalized at build time.
  transpilePackages: [
    "@solana/wallet-adapter-base",
    "@solana/wallet-adapter-react",
    "@solana/wallet-adapter-react-ui",
    "@solana/wallet-adapter-phantom",
    "@solana/wallet-adapter-solflare",
    "@ellipsis-labs/phoenix-sdk",
  ],
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
    };
    return config;
  },
};

export default nextConfig;
