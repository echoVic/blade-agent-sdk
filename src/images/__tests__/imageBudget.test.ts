import { describe, expect, it } from 'vitest';
import { type ImageSlot, selectImages } from '../imageBudget.js';

const history = (count: number, cost = 1_600): ImageSlot[] =>
  Array.from({ length: count }, () => ({ cost, fresh: false }));
const fresh = (count: number, cost = 1_600): ImageSlot[] =>
  Array.from({ length: count }, () => ({ cost, fresh: true }));

describe('selectImages', () => {
  it('keeps everything within the allowance', () => {
    expect(selectImages(history(3), { maxImages: 50, historyTokens: 16_000 })).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('keeps fresh images first, newest first, under the hard cap', () => {
    expect(
      selectImages([...history(2), ...fresh(3)], { maxImages: 2, historyTokens: 16_000 }),
    ).toEqual([false, false, false, true, true]);
  });

  it('caps fresh images for recovery retries', () => {
    expect(
      selectImages(fresh(4, 1), { maxImages: 50, historyTokens: 0, maxFreshImages: 2 }),
    ).toEqual([false, false, true, true]);
  });

  it('omits every history image when the allowance is zero', () => {
    expect(selectImages(history(3), { maxImages: 50, historyTokens: 0 })).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('moves the history cut in steps of half the allowance', () => {
    const cuts = Array.from({ length: 60 }, (_, index) =>
      selectImages(history(index + 1), { maxImages: 50, historyTokens: 16_000 }).indexOf(true),
    );

    // Ten screenshots fit. The 11th moves the cut by five and it then holds for four more.
    expect(cuts.slice(0, 10)).toEqual(new Array(10).fill(0));
    expect(cuts.slice(10, 15)).toEqual(new Array(5).fill(5));
    expect(cuts.slice(15, 20)).toEqual(new Array(5).fill(10));
    for (const [index, cut] of cuts.entries()) {
      expect(cut % 5).toBe(0);
      expect((index + 1 - cut) * 1_600).toBeLessThanOrEqual(16_000);
    }
  });

  it('moves the count cut in steps of half the remaining places', () => {
    const cut = (count: number) =>
      selectImages(history(count, 1), { maxImages: 4, historyTokens: 16_000 }).indexOf(true);
    expect([4, 5, 6, 7, 8].map(cut)).toEqual([0, 2, 2, 4, 4]);
  });
});
