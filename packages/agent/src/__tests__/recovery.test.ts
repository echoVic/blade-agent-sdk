import { CannotRetryError } from '@blade-ai/ai/retry';
import { describe, expect, it } from 'vitest';
import { isOverflowRecoverable } from '../recovery/index.js';

describe('agent recovery helpers', () => {
  it.each([
    new Error('context_length_exceeded'),
    new Error('maximum context length exceeded'),
    new Error('request too large for context window'),
    new Error('413 payload too large'),
    new Error('input length and `max_tokens` exceed context limit: 199000 + 20000 > 200000'),
  ])('treats context overflow errors as recoverable: %s', (error) => {
    expect(isOverflowRecoverable(error)).toBe(true);
  });

  it('unwraps CannotRetryError and Error.cause chains', () => {
    const overflow = new Error('too many tokens for this model');
    const caused = new Error('outer provider failure', { cause: overflow });
    const wrapped = new CannotRetryError(caused, { maxTokensOverride: 3000 });

    expect(isOverflowRecoverable(wrapped)).toBe(true);
  });

  it.each([
    new Error('rate limited'),
    new Error('connection reset'),
    'context_length_exceeded',
    null,
    undefined,
  ])('does not treat unrelated errors as recoverable: %s', (error) => {
    expect(isOverflowRecoverable(error)).toBe(false);
  });

  it('does not loop forever on cyclic causes', () => {
    const cyclic = new Error('outer');
    cyclic.cause = cyclic;

    expect(isOverflowRecoverable(cyclic)).toBe(false);
  });
});
