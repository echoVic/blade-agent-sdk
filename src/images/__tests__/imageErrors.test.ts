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

  it.each([
    ['image dimensions exceed max allowed size for many-image requests', 'too_large'],
    ['You uploaded an unsupported image. Please make sure your image is valid.', 'invalid'],
    ['413 Request Entity Too Large', 'too_large'],
    ['Payload Too Large', 'too_large'],
    ['request_too_large', 'too_large'],
    ['Request exceeds the maximum allowed number of bytes', 'too_large'],
    ['images are not supported by this model', 'unsupported'],
    ['image is not supported for the current model', 'unsupported'],
    ['images are not supported with the model', 'unsupported'],
  ] as const)('classifies additional wording: %s', (message, kind) => {
    expect(classifyImageLimitError(new Error(message))).toBe(kind);
  });
  it('does not disable vision for per-image animation refusals', () => {
    expect(classifyImageLimitError(new Error('animated images are not supported'))).not.toBe(
      'unsupported',
    );
  });
});
