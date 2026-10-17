import { describe, expect, it } from 'vitest';
import { CannotRetryError } from '../../services/RetryPolicy.js';
import { classifyImageLimitError } from '../imageErrors.js';

describe('classifyImageLimitError', () => {
  it.each([
    ['Too many images in request. Max is 500.', 'too_many'],
    ['At most 1 image(s) may be provided in one request.', 'too_many'],
    [
      'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes',
      'too_large',
    ],
    ['Invalid image.', 'invalid'],
    ['Invalid content type. image_url is only supported by certain models.', 'unsupported'],
    [
      'Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text`',
      'unsupported',
    ],
    ['The model does not support image input', 'unsupported'],
  ] as const)('classifies %s', (message, kind) => {
    expect(classifyImageLimitError(new Error(message))).toBe(kind);
  });

  it('follows causes and retry wrappers', () => {
    expect(
      classifyImageLimitError(
        new Error('request failed', { cause: new Error('Too many images in request') }),
      ),
    ).toBe('too_many');
    expect(classifyImageLimitError(new CannotRetryError(new Error('Invalid image'), {}))).toBe(
      'invalid',
    );
  });

  it('ignores unrelated errors', () => {
    expect(classifyImageLimitError(new Error('maximum context length exceeded'))).toBeUndefined();
    expect(classifyImageLimitError('rate limited')).toBeUndefined();
  });
});
