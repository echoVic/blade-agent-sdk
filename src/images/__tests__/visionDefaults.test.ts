import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import type { VisionCapability } from '../../model/vision.js';
import { builtinVisionCapability, resolveVisionCapability } from '../visionDefaults.js';

const MIB = 1024 * 1024;
const OPENAI: VisionCapability = {
  images: true,
  toolResultImages: true,
  imageTokens: 'openai',
  maxImageBytes: 20 * MIB,
};
const NONE: VisionCapability = { images: false, toolResultImages: false };
const PASS_THROUGH: VisionCapability = { images: true, toolResultImages: false, imageTokens: 1600 };

describe('builtinVisionCapability', () => {
  it.each([
    [
      'anthropic',
      'claude-sonnet-4-5',
      {
        images: true,
        toolResultImages: true,
        imageTokens: 'anthropic',
        maxImageBytes: 5 * MIB,
        maxImagesPerRequest: 100,
      },
    ],
    ['anthropic', 'claude-2.1', NONE],
    ['openai', 'gpt-5', OPENAI],
    ['openai', 'gpt-4o-mini', OPENAI],
    ['openai', 'gpt-4', NONE],
    ['openai', 'gpt-4-0125-preview', NONE],
    ['openai', 'o3-mini', NONE],
    ['openai', 'gpt-3.5-turbo', NONE],
    [
      'azure-openai',
      'my-gpt4o-deployment',
      { images: true, toolResultImages: false, imageTokens: 'openai' },
    ],
    ['gemini', 'gemini-2.5-pro', { images: true, toolResultImages: true, imageTokens: 'gemini' }],
    ['deepseek', 'deepseek-chat', PASS_THROUGH],
    ['deepseek', 'deepseek-v4-flash', PASS_THROUGH],
    ['deepseek', 'deepseek-v4-pro', NONE],
    ['deepseek', 'deepseek-r1', NONE],
    ['openai-compatible', 'qwen-vl-max', PASS_THROUGH],
    ['openai-compatible', 'qwq-32b', NONE],
    ['custom-wire-api', 'custom-model', PASS_THROUGH],
  ] as const)('%s %s', (provider, model, expected) => {
    expect(builtinVisionCapability(provider, model)).toEqual(expected);
  });
});

describe('resolveVisionCapability', () => {
  it('layers the model config, the session override and a runtime downgrade over the table', () => {
    expect(
      resolveVisionCapability({
        provider: 'openai-compatible',
        model: 'internal-vl',
        modelOverride: { toolResultImages: true, maxImagesPerRequest: 4 },
        sessionOverride: { maxImagesPerRequest: 1 },
      }),
    ).toEqual({ images: true, toolResultImages: true, imageTokens: 1600, maxImagesPerRequest: 1 });
    expect(
      resolveVisionCapability({
        provider: 'anthropic',
        model: 'claude-opus-4-1',
        imagesUnsupported: true,
      }).images,
    ).toBe(false);
  });

  it('asks a resolver per model and falls back to the table when it returns undefined', () => {
    const resolver = vi.fn(({ model }: { provider: string; model: string }) =>
      model === 'text-only' ? { images: false } : undefined,
    );
    expect(
      resolveVisionCapability({ provider: 'custom', model: 'text-only', sessionOverride: resolver })
        .images,
    ).toBe(false);
    expect(
      resolveVisionCapability({ provider: 'custom', model: 'other', sessionOverride: resolver })
        .images,
    ).toBe(true);
    expect(resolver).toHaveBeenCalledWith({ provider: 'custom', model: 'other' });
  });

  it('rejects invalid numeric overrides', () => {
    expect(() =>
      resolveVisionCapability({
        provider: 'openai',
        model: 'gpt-5',
        sessionOverride: { maxImagesPerRequest: 0 },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      resolveVisionCapability({
        provider: 'openai',
        model: 'gpt-5',
        modelOverride: { imageTokens: -1 },
      }),
    ).toThrow(ConfigError);
  });

  it.each([
    ['imageTokens', 'claude'],
    ['imageTokens', null],
    ['imageTokens', {}],
    ['imageTokens', 0],
    ['imageTokens', 1.5],
    ['imageTokens', Number.MAX_SAFE_INTEGER + 1],
    ['images', 'true'],
    ['images', 1],
    ['images', null],
    ['toolResultImages', 'false'],
    ['toolResultImages', 0],
    ['mediaTypes', 'image/png'],
    ['mediaTypes', []],
    ['mediaTypes', ['image/svg+xml']],
    ['mediaTypes', [1]],
    ['mediaTypes', null],
  ])('rejects invalid %s override %j with its field path', (key, value) => {
    expect(() =>
      resolveVisionCapability({
        provider: 'openai',
        model: 'gpt-5',
        sessionOverride: { [key]: value } as never,
      }),
    ).toThrow(`SessionOptions.vision.${key}`);
  });

  it('validates overrides returned by a resolver', () => {
    expect(() =>
      resolveVisionCapability({
        provider: 'openai',
        model: 'gpt-5',
        sessionOverride: () => ({ images: 'yes' }) as never,
      }),
    ).toThrow(ConfigError);
  });

  it('canonicalizes the jpg alias in mediaTypes', () => {
    expect(
      resolveVisionCapability({
        provider: 'custom',
        model: 'vl',
        modelOverride: { mediaTypes: ['image/jpg', 'image/png'] },
      }).mediaTypes,
    ).toEqual(['image/jpeg', 'image/png']);
  });

  it.each([
    'anthropic',
    'openai',
    'azure-openai',
    'gemini',
    'deepseek',
    'custom',
  ])('freezes the built-in %s row', (provider) => {
    const row = resolveVisionCapability({ provider, model: 'vision-model' });
    expect(Object.isFrozen(row)).toBe(true);
  });
});
