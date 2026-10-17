/** One image part of a request, in conversation order. */
export interface ImageSlot {
  /** Estimated token cost of sending the image. */
  readonly cost: number;
  /** The model has not seen the image yet: it follows the last assistant message. */
  readonly fresh: boolean;
}

export interface ImageSelectionLimits {
  /** Hard cap on images in the request. */
  readonly maxImages: number;
  /** Token allowance shared by history images. */
  readonly historyTokens: number;
  /** Optional cap on fresh images, used by recovery retries. */
  readonly maxFreshImages?: number;
}

/** How many of the oldest history images to omit so the rest fits the allowance. */
function tokenCut(costs: readonly number[], allowance: number): number {
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (total <= allowance) return 0;
  if (allowance <= 0) return costs.length;
  // Round the excess up to half the allowance so the cut, and the prompt prefix
  // in front of it, stays put while new images arrive.
  const step = allowance / 2;
  const target = Math.ceil((total - allowance) / step) * step;
  let omitted = 0;
  let cut = 0;
  while (cut < costs.length && omitted < target) {
    omitted += costs[cut];
    cut += 1;
  }
  return cut;
}

function countCut(count: number, places: number): number {
  if (count <= places) return 0;
  if (places <= 0) return count;
  const step = Math.max(1, Math.floor(places / 2));
  return Math.min(count, Math.ceil((count - places) / step) * step);
}

/**
 * Decide which images a request keeps. Fresh images take places first, newest
 * first. History images keep the newest suffix that fits both the token
 * allowance and the remaining places.
 */
export function selectImages(slots: readonly ImageSlot[], limits: ImageSelectionLimits): boolean[] {
  const keep = slots.map(() => false);
  const freshIndexes = slots.flatMap((slot, index) => (slot.fresh ? [index] : []));
  const historyIndexes = slots.flatMap((slot, index) => (slot.fresh ? [] : [index]));

  const freshPlaces = Math.max(
    0,
    Math.min(limits.maxImages, limits.maxFreshImages ?? Number.POSITIVE_INFINITY),
  );
  const keptFresh = freshIndexes.slice(Math.max(0, freshIndexes.length - freshPlaces));
  for (const index of keptFresh) keep[index] = true;

  const historyPlaces = Math.max(0, limits.maxImages - keptFresh.length);
  const cut = Math.max(
    tokenCut(
      historyIndexes.map((index) => slots[index].cost),
      limits.historyTokens,
    ),
    countCut(historyIndexes.length, historyPlaces),
  );
  for (const index of historyIndexes.slice(cut)) keep[index] = true;
  return keep;
}
