import { describe, it, expect } from "vitest";
import {
  parsePreviousCloseResponse,
  PythClient,
  PythClientError,
} from "../../services/automation/src/clients/pyth.js";

describe("parsePreviousCloseResponse — Hermes shape", () => {
  it("decodes price + expo into a human-readable dollar value", () => {
    // Pyth reports price as integer + negative expo. 68012345678 * 10^-8 = $680.12345678.
    const body = {
      parsed: [
        {
          price: { price: "68012345678", expo: -8, publish_time: 1716_300_000 },
        },
      ],
    };
    const out = parsePreviousCloseResponse("META", body);
    expect(out.ticker).toBe("META");
    expect(out.price).toBeCloseTo(680.12345678, 7);
    expect(out.publishTime).toBe(1716_300_000);
  });

  it("accepts numeric price field too (some Hermes endpoints return number)", () => {
    const body = { parsed: [{ price: { price: 23000000000, expo: -8, publish_time: 1 } }] };
    expect(parsePreviousCloseResponse("AAPL", body).price).toBeCloseTo(230, 6);
  });

  it("throws on missing parsed array", () => {
    expect(() => parsePreviousCloseResponse("AAPL", {})).toThrow(PythClientError);
  });

  it("throws on missing price field", () => {
    expect(() => parsePreviousCloseResponse("AAPL", { parsed: [{}] })).toThrow(PythClientError);
  });

  it("throws on non-finite decoded price", () => {
    const body = { parsed: [{ price: { price: "NaN", expo: -8 } }] };
    expect(() => parsePreviousCloseResponse("AAPL", body)).toThrow(PythClientError);
  });

  it("handles expo=0 (integer price, no scaling)", () => {
    const body = { parsed: [{ price: { price: "680", expo: 0, publish_time: 1 } }] };
    const out = parsePreviousCloseResponse("META", body);
    expect(out.price).toBe(680);
  });
});

describe("PythClient — mockable fetch (no live network)", () => {
  it("calls the fetch impl with the configured baseUrl + feed-id", async () => {
    const seen: string[] = [];
    const fakeFetch: typeof fetch = async (url) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({
          parsed: [{ price: { price: "68000000000", expo: -8, publish_time: 1 } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new PythClient({ baseUrl: "https://hermes.example/api", fetchImpl: fakeFetch });
    const result = await client.getPreviousClose({ ticker: "META", feedId: "0xabc" });
    expect(result.price).toBeCloseTo(680, 6);
    expect(seen[0]).toContain("https://hermes.example/api/v2/updates/price/latest");
    expect(seen[0]).toContain("0xabc");
  });

  it("wraps non-2xx responses in PythClientError", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("upstream is sad", { status: 503 });
    const client = new PythClient({ baseUrl: "https://hermes.example/api", fetchImpl: fakeFetch });
    await expect(
      client.getPreviousClose({ ticker: "META", feedId: "0xabc" }),
    ).rejects.toThrow(PythClientError);
  });
});
