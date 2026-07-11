/**
 * Model capability detection utilities.
 *
 * Automatically detects whether a model supports reasoning/thinking based
 * on its model name pattern.
 */

/** Minimal input shape needed for thinking-model detection. */
export interface ThinkingDetectionInput {
  /** Model name (e.g. "deepseek-r1", "o1-preview"). */
  model: string;
  /** Explicit opt-in / opt-out — wins over pattern detection. */
  supportsThinking?: boolean;
  /** Budget hint — carried through but not used for detection. */
  thinkingBudget?: number;
}

// ---------------------------------------------------------------------------
// Regex patterns for known thinking/reasoning model families.
// Matching is case-insensitive.
// ---------------------------------------------------------------------------

const THINKING_PATTERNS: RegExp[] = [
  // DeepSeek
  /deepseek.*r1/i,
  /deepseek.*reasoner/i,
  // OpenAI
  /o1-preview/i,
  /o1-mini/i,
  /o1\b/i,
  // Qwen / Tongyi
  /qwen.*qwq/i,
  /qwen.*think/i,
  // Kimi / Moonshot
  /kimi.*k1/i,
  /moonshot.*think/i,
  /k1-32k/i,
  // Doubao
  /doubao.*think/i,
  /doubao.*pro.*think/i,
  // Claude
  /claude.*opus.*4/i,
  // GLM (Zhipu)
  /glm-4\.7/i,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function detectThinkingSupport(modelName: string): boolean {
  return THINKING_PATTERNS.some((pattern) => pattern.test(modelName));
}

/**
 * Check whether the given model supports thinking/reasoning.
 *
 * When `supportsThinking` is explicitly configured it takes precedence;
 * otherwise the model name is matched against a built-in list of known
 * thinking-capable families.
 */
export function isThinkingModel(config: ThinkingDetectionInput): boolean {
  if (config.supportsThinking !== undefined) {
    return config.supportsThinking;
  }
  return detectThinkingSupport(config.model);
}
