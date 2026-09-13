import type { SessionExecutorReadResult } from '../SessionExecutor.js';

/**
 * Shared contract for `SessionExecutor.read` responses.
 *
 * The server turns this result into the client-facing recovery snapshot and reads
 * `loaded` to decide whether the pending-input projection is known or unknown. An
 * executor that omits a field silently downgrades that snapshot - which is how a
 * host implementation, or the shipped example, can drift from the interface
 * without any test noticing. Every executor is expected to pass this.
 */
export function assertSessionExecutorReadResult(
  result: SessionExecutorReadResult,
  label = 'SessionExecutor.read',
): void {
  if (result === null || typeof result !== 'object') {
    throw new Error(`${label} must resolve to an object`);
  }
  if (result.session === null || typeof result.session !== 'object') {
    throw new Error(`${label} must return the Session record`);
  }
  if (!Array.isArray(result.messages)) {
    throw new Error(`${label} must return a messages array`);
  }
  if (!Array.isArray(result.pendingInputs)) {
    throw new Error(`${label} must return a pending-inputs array`);
  }
  if (typeof result.loaded !== 'boolean') {
    throw new Error(
      `${label} must report \`loaded\`; without it a caller cannot tell an empty `
      + 'projection from an unknown one',
    );
  }
  const unknownKeys = Object.keys(result).filter(
    (key) => !['session', 'messages', 'pendingInputs', 'loaded'].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${label} returned unsupported fields: ${unknownKeys.join(', ')}`);
  }
}
