import { CannotRetryError } from '../services/RetryPolicy.js';

/** Why a provider refused a request because of its images. */
export type ImageLimitKind = 'too_many' | 'too_large' | 'invalid' | 'unsupported';

// Provider wording collected from OpenAI, Anthropic, vLLM and DeepSeek responses.
const IMAGE_ERROR_PATTERNS: ReadonlyArray<readonly [ImageLimitKind, RegExp]> = [
  [
    'unsupported',
    /does not support image|image input is not supported|image_url is only supported|unknown variant `?image_url|images? (?:are|is) not supported (?:by|for|with) (?:this|the) (?:current )?model/i,
  ],
  ['too_many', /too many images|at most \d+ image|maximum number of images/i],
  [
    'too_large',
    /image (?:is )?too large|image exceeds|exceeds \d+(?:\.\d+)? ?mb|image dimensions exceed max allowed size for many-image requests|request entity too large|payload too large|request_too_large|request exceeds the maximum allowed number of bytes/i,
  ],
  [
    'invalid',
    /invalid image|could not process image|unable to process (?:the )?image|failed to decode image|you uploaded an unsupported image/i,
  ],
];

function messageOf(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  return typeof value === 'string' ? value : undefined;
}

/** Follows causes and retry wrappers, like `isOverflowRecoverable`. */
export function findImageLimitError(
  error: unknown,
): { kind: ImageLimitKind; message: string } | undefined {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const message = messageOf(current);
    if (message) {
      for (const [kind, pattern] of IMAGE_ERROR_PATTERNS) {
        if (pattern.test(message)) return { kind, message };
      }
    }
    if (current instanceof CannotRetryError) queue.push(current.originalError);
    if (current instanceof Error && 'cause' in current) queue.push(current.cause);
  }
  return undefined;
}

/** Classify a provider image refusal, including nested causes and retry wrappers. */
export function classifyImageLimitError(error: unknown): ImageLimitKind | undefined {
  return findImageLimitError(error)?.kind;
}
