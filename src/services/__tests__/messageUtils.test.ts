import { describe, expect, it } from 'vitest';
import type { ModelContent } from '../../model/message.js';
import { cloneContentPart } from '../messageUtils.js';

describe('cloneContentPart', () => {
  it('copies every image reference field', () => {
    const part: ModelContent = {
      type: 'image_url',
      image_url: {
        url: `blade-image:sha256:${'d'.repeat(64)}`,
        detail: 'low',
        mediaType: 'image/png',
        width: 3,
        height: 4,
        byteLength: 99,
        alt: 'diagram',
      },
    };

    const clone = cloneContentPart(part);

    expect(clone).toEqual(part);
    if (clone.type !== 'image_url' || part.type !== 'image_url') {
      throw new Error('Expected image parts');
    }
    expect(clone.image_url).not.toBe(part.image_url);
  });
});
