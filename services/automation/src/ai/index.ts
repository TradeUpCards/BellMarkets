// AI v2 phase-0/1 barrel.

export * from "./types.js";
export {
  callAnthropic,
  AnthropicWrapperError,
} from "./anthropic-client.js";
export type {
  AnthropicCallInput,
  AnthropicCallResult,
  AnthropicCallError,
} from "./anthropic-client.js";
export {
  insertNewsArticle,
  listUnclassifiedArticles,
  insertNewsClassification,
  logAiOutput,
  rowToNewsClassification,
  insertBriefing,
  getLatestBriefing,
  listLatestBriefings,
} from "./db.js";
export type { AiDbDeps, ClassificationInput, BriefingInput, BriefingRecord } from "./db.js";
export {
  classifyArticle,
  classifyPendingArticles,
  parseClassificationJson,
  DEFAULT_CLASSIFIER_MODEL,
} from "./classify.js";
export type { ClassifyArticleResult } from "./classify.js";
export {
  buildDailyTickerBriefingPrompt,
  buildBellProBriefingPrompt,
  DEFAULT_BRIEFING_MODEL,
} from "./briefing-prompts.js";
export type { DailyBriefingInput, BellProBriefingContext } from "./briefing-prompts.js";
