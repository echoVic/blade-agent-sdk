import { CannotRetryError } from '../services/RetryPolicy.js';

/** Why a provider refused a request because of its images. */
export type ImageLimitKind = 'too_many' | 'too_large' | 'invalid' | 'unsupported';

// Provider wording collected from OpenAI, Anthropic, vLLM and DeepSeek responses.
const IMAGE_ERROR_PATTERNS: ReadonlyArray<readonly [ImageLimitKind, RegExp]> = [
  [
    'unsupported',
    /does not support image|image input is not supported|image_url is only supported|unknown variant `?image_url|images? (?:are|is) not supported/i,
  ],
  ['too_many', /too many images|at most \d+ image|maximum number of images/i],
  ['too_large', /image (?:is )?too large|image exceeds|exceeds \d+(?:\.\d+)? ?mb/i],
  [
    'invalid',
    /invalid image|could not process image|unable to process (?:the )?image|failed to decode image/i,
  ],
];

function messageOf(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  return typeof value === 'string' ? value : undefined;
}

/** Follows causes and retry wrappers, like `isOverflowRecoverable`. */
export function classifyImageLimitError(error: unknown): ImageLimitKind | undefined {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const message = messageOf(current);
    if (message) {
      for (const [kind, pattern] of IMAGE_ERROR_PATTERNS) {
        if (pattern.test(message)) return kind;
      }
    }
    if (current instanceof CannotRetryError) queue.push(current.originalError);
    if (current instanceof Error && 'cause' in current) queue.push(current.cause);
  }
  return undefined;
}
