import type { RuntimeContext } from './RuntimeContext.js';

export function getContextCwd(
  context?: RuntimeContext,
): string | undefined {
  return context?.capabilities?.filesystem?.cwd;
}
