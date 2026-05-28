// Same call useAllMarkets makes on the browser, run from Node against Helius.
// If this fails the same way, Helius is the problem; if it succeeds, the
// browser-side path (CORS / proxy / TanStack Query state) is the problem.

const PDAS = [
  "C41aovnZA7moEBG1HhJ8FgGsvvxf2GB8GFbrzWV4qFM5", // META 620
  "B2CMJyfnecBw94fHiLyZN9TcHKwzQJfnTQqMvzoNrPA7", // META 639
  "6FobRfJCwhZhFwouEvbcgVh8fznLWQqfUdhhEJNVhXhf", // META 658
  "ZTc4MEWtCB784V6CBfYHTY28wfhvq5BCPe2wvyzW43w",  // NVDA 206
  "BMSGx47bdwkvV2XQXQHYSfJh9d2sWmQ9UJhfAkNmaGT1", // NVDA 212
  "AFCjT9VEEGdJBVFSU76AVdrD7HYFohnNKU5chHGPXDRh", // NVDA 219
  "861zTjh3DFb4Lo187qxQLdgsLCjJ8GD6XRn9f13E2WeE", // AAPL 302
  "68EFZBkPvTCg36vLLbANzPfK5o7bS3vatpD31tG8i7zC", // AAPL 311
  "8icim6Egkc6fg5teeFDpyFFGeuGur2Bbs8Vkca38yzq5", // AAPL 321
  "GPMddZomEQWmHyU4TFHh4iYAFnHr6NbPTHFzqevGr5Dq", // MSFT 411
  "B3cedkevEYb7i4JAF4cHrkupxNDzhbwZSbF6zGL783HP", // MSFT 424
  "4ubXm1PynTZphSfpXwozep3sHdA49X7MQBARCAPqeC1b", // MSFT 437
  "9qN2ABbu2hsW8c7twNysdo9LrWdXvSqPHGVu2HbATa9e", // GOOGL 373
  "FSPcu15UdcaXsPEn3Nh8oo4vGuUiZfMFA5tMHXxX4uc6", // GOOGL 385
  "J8qPMN3WpygdPsPphKwwTbnZ3zFn11TNoiPj7NgnBywX", // GOOGL 397
  "AUC4oZaJBM5Sz7FEr7v9bFP76xBffvugmLKwRbz9Safz", // AMZN 261
  "6gWrRyd144i8bwgLo4X9QR7NHJvdKe6RZ25fNkJqmk6v", // AMZN 269
  "5anQX2hxSMQ2PS33v77HXD846iLwcydUpuDP7ze1XMEs", // AMZN 277
  "4JDNzJzhQSNscbH59NzDt97M6nsvdqBSxDw2VQCsNs3D", // TSLA 427
  "HkKTYj3DuDd6AxWfnVCMTacZLoWnDDaS9iJcTUSPHSCR", // TSLA 440
  "2EXiHiAt4VZsNHmdWBhsc1ZApEEjftDiy88eiapxRjg8", // TSLA 454
];

async function main() {
  const url = process.env.HELIUS_DEVNET_RPC_URL!;
  console.log(`Calling getMultipleAccountsInfo via ${url.slice(0, 50)}…`);
  console.log(`PDAs requested: ${PDAS.length}`);

  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [PDAS, { commitment: "confirmed", encoding: "base64" }],
    }),
  });
  const elapsed = Date.now() - t0;
  console.log(`HTTP ${res.status} · ${elapsed}ms`);
  const json = (await res.json()) as { result?: { value?: (object | null)[] }; error?: object };
  if (json.error) {
    console.log("❌ JSON-RPC error:", JSON.stringify(json.error, null, 2));
    return;
  }
  const value = json.result?.value;
  if (!Array.isArray(value)) {
    console.log("❌ unexpected response shape:", JSON.stringify(json).slice(0, 200));
    return;
  }
  console.log(`✅ Got ${value.length} entries`);
  let present = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== null) present++;
  }
  console.log(`   ${present} non-null, ${value.length - present} null`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
