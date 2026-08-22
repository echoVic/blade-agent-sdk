import type { InputId } from './branded.js';

export interface SteeringInterruptReason {
  kind: 'steering';
  inputId: InputId;
}

export function getSteeringInterruptInputId(
  signal: AbortSignal | undefined,
): InputId | undefined {
  const reason = signal?.reason;
  if (
    typeof reason === 'object'
    && reason !== null
    && 'kind' in reason
    && reason.kind === 'steering'
    && 'inputId' in reason
    && typeof reason.inputId === 'string'
  ) {
    return reason.inputId as InputId;
  }
  return undefined;
}

export function isSteeringInterruptSignal(
  signal: AbortSignal | undefined,
): boolean {
  return getSteeringInterruptInputId(signal) !== undefined;
}
