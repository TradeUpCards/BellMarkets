import { describe, it, expect } from "vitest";
import { parseClassificationJson, DEFAULT_CLASSIFIER_MODEL } from "../../services/automation/src/ai/classify.js";
import { buildDailyTickerBriefingPrompt, DEFAULT_BRIEFING_MODEL } from "../../services/automation/src/ai/briefing-prompts.js";
import type { NewsArticle, NewsClassification } from "../../services/automation/src/ai/types.js";

describe("DEFAULT_CLASSIFIER_MODEL + DEFAULT_BRIEFING_MODEL — locked to ai-v2-plan defaults", () => {
  it("classifier defaults to Haiku 4.5", () => {
    expect(DEFAULT_CLASSIFIER_MODEL).toBe("claude-haiku-4-5-20251001");
  });

  it("briefing defaults to Sonnet 4.6", () => {
    expect(DEFAULT_BRIEFING_MODEL).toBe("claude-sonnet-4-6");
  });
});

describe("parseClassificationJson — tolerant JSON extraction", () => {
  it("parses well-formed output", () => {
    const out = parseClassificationJson(
      JSON.stringify({
        sentiment: "bullish",
        primary_ticker: "META",
        related_tickers: ["AAPL"],
        confidence: 0.78,
        rationale: "META beat earnings",
      }),
    );
    expect(out).toEqual({
      sentiment: "bullish",
      primaryTicker: "META",
      relatedTickers: ["AAPL"],
      confidence: 0.78,
    });
  });

  it("strips ```json``` markdown fences", () => {
    const wrapped = '```json\n{"sentiment":"bearish","primary_ticker":"NVDA","related_tickers":[],"confidence":0.4}\n```';
    const out = parseClassificationJson(wrapped);
    expect(out?.sentiment).toBe("bearish");
    expect(out?.primaryTicker).toBe("NVDA");
  });

  it("strips bare ``` fences", () => {
    const wrapped = '```\n{"sentiment":"neutral","primary_ticker":null,"related_tickers":[],"confidence":0.5}\n```';
    const out = parseClassificationJson(wrapped);
    expect(out?.sentiment).toBe("neutral");
    expect(out?.primaryTicker).toBeUndefined();
  });

  it("returns undefined on malformed input", () => {
    expect(parseClassificationJson("not json at all")).toBeUndefined();
    expect(parseClassificationJson("")).toBeUndefined();
    expect(parseClassificationJson("{ unclosed: 'object' ")).toBeUndefined();
  });

  it("clamps confidence to [0, 1]", () => {
    const high = parseClassificationJson('{"sentiment":"bullish","primary_ticker":"META","related_tickers":[],"confidence":1.5}');
    expect(high?.confidence).toBe(1);
    const low = parseClassificationJson('{"sentiment":"bullish","primary_ticker":"META","related_tickers":[],"confidence":-0.5}');
    expect(low?.confidence).toBe(0);
  });

  it("rejects unknown sentiment values gracefully (sentiment=undefined; rest preserved)", () => {
    const out = parseClassificationJson('{"sentiment":"wild_speculation","primary_ticker":"META","related_tickers":[],"confidence":0.5}');
    expect(out?.sentiment).toBeUndefined();
    expect(out?.primaryTicker).toBe("META");
  });

  it("returns empty related_tickers when missing or wrong type", () => {
    const a = parseClassificationJson('{"sentiment":"neutral","primary_ticker":"META","confidence":0.5}');
    expect(a?.relatedTickers).toEqual([]);
    const b = parseClassificationJson('{"sentiment":"neutral","primary_ticker":"META","related_tickers":"NOT-AN-ARRAY","confidence":0.5}');
    expect(b?.relatedTickers).toEqual([]);
  });
});

describe("buildDailyTickerBriefingPrompt — Sonnet prompt assembly", () => {
  function fakeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
    return {
      id: 1,
      source: "benzinga",
      externalId: "bz-1",
      ticker: "META",
      headline: "Meta beats Q1 expectations",
      body: "Meta reported $1B above consensus.",
      url: "https://example.com/meta-q1",
      publishedAt: new Date("2026-05-23T22:30:00Z"),
      observedAt: new Date(),
      ...overrides,
    };
  }

  function fakeClassification(overrides: Partial<NewsClassification> = {}): NewsClassification {
    return {
      id: 1,
      articleId: 1,
      model: "claude-haiku-4-5-20251001",
      sentiment: "bullish",
      primaryTicker: "META",
      relatedTickers: [],
      confidence: 0.85,
      classificationText: '{"sentiment":"bullish",...}',
      classifiedAt: new Date(),
      ...overrides,
    };
  }

  it("produces an AnthropicCallInput with system + user content", () => {
    const prompt = buildDailyTickerBriefingPrompt({
      ticker: "META",
      asOf: new Date("2026-05-24T09:00:00Z"),
      newsItems: [{ article: fakeArticle(), classification: fakeClassification() }],
    });
    expect(prompt.kind).toBe("briefing");
    expect(prompt.model).toBe(DEFAULT_BRIEFING_MODEL);
    expect(prompt.system).toContain("BellMarkets");
    expect(prompt.system).toContain("FORBIDDEN words");
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]?.role).toBe("user");
    expect(prompt.messages[0]?.content).toContain("TICKER: META");
    expect(prompt.messages[0]?.content).toContain("Meta beats Q1");
    expect(prompt.relatedTicker).toBe("META");
  });

  it("handles empty news items list with explicit fallback text", () => {
    const prompt = buildDailyTickerBriefingPrompt({
      ticker: "NVDA",
      asOf: new Date("2026-05-24T09:00:00Z"),
      newsItems: [],
    });
    expect(prompt.messages[0]?.content).toContain("no recent news");
  });

  it("sorts news descending by publishedAt + truncates to 12 items", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      article: fakeArticle({ id: i, headline: `Article ${i}`, publishedAt: new Date(2026, 4, 23, i, 0, 0) }),
      classification: fakeClassification({ articleId: i }),
    }));
    const prompt = buildDailyTickerBriefingPrompt({
      ticker: "META",
      asOf: new Date("2026-05-24T09:00:00Z"),
      newsItems: items,
    });
    const content = prompt.messages[0]!.content;
    // Most recent (i=19) should appear first; older (i=0) should not appear
    expect(content.indexOf("Article 19")).toBeGreaterThan(0);
    expect(content.indexOf("Article 0")).toBe(-1);
  });

  it("includes upcoming macro events when supplied", () => {
    const prompt = buildDailyTickerBriefingPrompt({
      ticker: "META",
      asOf: new Date("2026-05-24T09:00:00Z"),
      newsItems: [],
      upcomingMacro: [
        { at: new Date("2026-05-25T14:00:00Z"), description: "FOMC rate decision" },
      ],
    });
    expect(prompt.messages[0]?.content).toContain("FOMC rate decision");
  });

  it("forbidden-word policy is part of the system prompt", () => {
    const prompt = buildDailyTickerBriefingPrompt({
      ticker: "AAPL",
      asOf: new Date(),
      newsItems: [],
    });
    expect(prompt.system).toMatch(/should/i);
    expect(prompt.system).toMatch(/advise/i);
    expect(prompt.system).toMatch(/recommend/i);
  });
});
