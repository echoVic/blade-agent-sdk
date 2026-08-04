import { describe, expect, it } from 'vitest';
import { normalizeOpenAICompatibleBaseUrl } from '../baseUrl.js';

describe('normalizeOpenAICompatibleBaseUrl', () => {
  it('appends /v1 when the base url has no path', () => {
    expect(normalizeOpenAICompatibleBaseUrl('https://callapi8.com')).toBe(
      'https://callapi8.com/v1',
    );
    expect(normalizeOpenAICompatibleBaseUrl('http://localhost:8080')).toBe(
      'http://localhost:8080/v1',
    );
  });

  it('keeps an explicit /v1 path unchanged', () => {
    expect(normalizeOpenAICompatibleBaseUrl('https://callapi8.com/v1')).toBe(
      'https://callapi8.com/v1',
    );
  });

  it('trims trailing slashes', () => {
    expect(normalizeOpenAICompatibleBaseUrl('https://callapi8.com/')).toBe(
      'https://callapi8.com/v1',
    );
    expect(normalizeOpenAICompatibleBaseUrl('https://callapi8.com/v1/')).toBe(
      'https://callapi8.com/v1',
    );
  });

  it('keeps explicit non-root paths unchanged', () => {
    expect(normalizeOpenAICompatibleBaseUrl('https://gateway.example.com/custom/path')).toBe(
      'https://gateway.example.com/custom/path',
    );
  });

  it('returns undefined for empty input', () => {
    expect(normalizeOpenAICompatibleBaseUrl('')).toBeUndefined();
    expect(normalizeOpenAICompatibleBaseUrl('   ')).toBeUndefined();
  });
});
