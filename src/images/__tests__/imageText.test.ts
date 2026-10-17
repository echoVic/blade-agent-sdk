import { describe, expect, it } from 'vitest';
import { describeImage, imagePlaceholder, summaryImageText } from '../imageText.js';

describe('image text', () => {
  it('describes what is known about an image', () => {
    expect(
      describeImage({
        url: 'x',
        mediaType: 'image/png',
        width: 1280,
        height: 720,
        alt: ' login page ',
      }),
    ).toBe('image/png 1280×720 — login page');
    expect(describeImage({ url: 'x', mediaType: 'image/png' })).toBe('image/png');
    expect(describeImage({ url: 'x', alt: 'chart' })).toBe('chart');
    expect(describeImage({ url: 'x' })).toBe('');
  });

  it('renders compaction text and request placeholders', () => {
    const ref = { url: 'x', mediaType: 'image/webp', width: 2, height: 3 };
    expect(summaryImageText(ref)).toBe('[image: image/webp 2×3]');
    expect(summaryImageText({ url: 'x' })).toBe('[image]');
    expect(imagePlaceholder('budget', ref)).toBe(
      '[image omitted to fit the image budget: image/webp 2×3]',
    );
    expect(imagePlaceholder('budget', { url: 'x' })).toBe(
      '[image omitted to fit the image budget]',
    );
    expect(imagePlaceholder('unsupported', ref)).toBe(
      '[image omitted: the current model does not accept images — image/webp 2×3]',
    );
    expect(imagePlaceholder('unsupported', { url: 'x' })).toBe(
      '[image omitted: the current model does not accept images]',
    );
    expect(imagePlaceholder('unavailable', ref)).toBe(
      '[image unavailable: it is no longer in the image store]',
    );
  });

  it('bounds in-process alt text in placeholders and compaction summaries', () => {
    const ref = { url: 'x', alt: 'a'.repeat(10_000) };
    expect(describeImage(ref)).toBe(`${'a'.repeat(200)}…`);
    expect(imagePlaceholder('budget', ref)).toBe(
      `[image omitted to fit the image budget: ${'a'.repeat(200)}…]`,
    );
    expect(summaryImageText(ref)).toBe(`[image: ${'a'.repeat(200)}…]`);
    expect(describeImage({ url: 'x', alt: 'a'.repeat(200) })).toBe('a'.repeat(200));
  });
});
