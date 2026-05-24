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
} from "./db.js";
export type { AiDbDeps, ClassificationInput } from "./db.js";
export {
  classifyArticle,
  classifyPendingArticles,
  parseClassificationJson,
  DEFAULT_CLASSIFIER_MODEL,
} from "./classify.js";
export type { ClassifyArticleResult } from "./classify.js";
export {
  buildDailyTickerBriefingPrompt,
  DEFAULT_BRIEFING_MODEL,
} from "./briefing-prompts.js";
export type { DailyBriefingInput } from "./briefing-prompts.js";
