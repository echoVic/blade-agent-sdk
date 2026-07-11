import { describe, expect, it } from 'vitest';
import { isThinkingModel } from '../detection.js';

/** Minimal subset of ModelConfig needed for detection. */
interface DetectionInput {
  model: string;
  supportsThinking?: boolean;
  thinkingBudget?: number;
}

describe('package-local modelDetection — isThinkingModel', () => {
  // ---- DeepSeek patterns ----
  it('detects deepseek-r1 as thinking model', () => {
    expect(isThinkingModel({ model: 'deepseek-r1' })).toBe(true);
  });

  it('detects deepseek-reasoner as thinking model', () => {
    expect(isThinkingModel({ model: 'deepseek-reasoner' })).toBe(true);
  });

  // ---- OpenAI patterns ----
  it('detects o1-preview as thinking model', () => {
    expect(isThinkingModel({ model: 'o1-preview' })).toBe(true);
  });

  it('detects o1-mini as thinking model', () => {
    expect(isThinkingModel({ model: 'o1-mini' })).toBe(true);
  });

  it('detects plain o1 as thinking model', () => {
    expect(isThinkingModel({ model: 'o1' })).toBe(true);
  });

  // ---- Qwen patterns ----
  it('detects qwen-qwq as thinking model', () => {
    expect(isThinkingModel({ model: 'qwen-qwq-32b' })).toBe(true);
  });

  it('detects qwen-think models', () => {
    expect(isThinkingModel({ model: 'qwen-think' })).toBe(true);
    expect(isThinkingModel({ model: 'qwen-thinking' })).toBe(true);
  });

  // ---- Kimi patterns ----
  it('detects kimi-k1 as thinking model', () => {
    expect(isThinkingModel({ model: 'kimi-k1' })).toBe(true);
    expect(isThinkingModel({ model: 'k1-32k-preview' })).toBe(true);
  });

  it('detects moonshot-think models', () => {
    expect(isThinkingModel({ model: 'moonshot-v1-auto-think' })).toBe(true);
  });

  // ---- Doubao patterns ----
  it('detects doubao-think models', () => {
    expect(isThinkingModel({ model: 'doubao-think-1.5' })).toBe(true);
  });

  // ---- Claude ----
  it('detects claude-opus-4 as thinking model', () => {
    expect(isThinkingModel({ model: 'claude-opus-4' })).toBe(true);
  });

  // ---- GLM ----
  it('detects glm-4.7 as thinking model', () => {
    expect(isThinkingModel({ model: 'glm-4.7' })).toBe(true);
  });

  // ---- Non-thinking models ----
  it('returns false for normal models', () => {
    expect(isThinkingModel({ model: 'gpt-4o' })).toBe(false);
    expect(isThinkingModel({ model: 'claude-sonnet-3.5' })).toBe(false);
    expect(isThinkingModel({ model: 'deepseek-v3' })).toBe(false);
    expect(isThinkingModel({ model: 'gemini-2.0-flash' })).toBe(false);
  });

  // ---- Explicit override ----
  it('respects explicit supportsThinking=true regardless of name', () => {
    expect(isThinkingModel({ model: 'some-unknown-model', supportsThinking: true })).toBe(true);
  });

  it('respects explicit supportsThinking=false regardless of name', () => {
    expect(isThinkingModel({ model: 'deepseek-r1', supportsThinking: false })).toBe(false);
  });

  // ---- Edge cases ----
  it('returns false for empty model name', () => {
    expect(isThinkingModel({ model: '' })).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isThinkingModel({ model: 'DEEPSEEK-R1' })).toBe(true);
    expect(isThinkingModel({ model: 'O1-PREVIEW' })).toBe(true);
    expect(isThinkingModel({ model: 'Moonshot-V1-Auto-Think' })).toBe(true);
  });
});
