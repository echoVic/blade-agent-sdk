import { SdkError } from '../errors/SdkError.js';
import type { JsonValue } from '../types/json.js';

export function toJsonValue(value: unknown): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new SdkError('JSON_SERIALIZATION_ERROR', 'Value is not JSON serializable');
    }
    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    if (error instanceof SdkError) {
      throw error;
    }
    throw new SdkError('JSON_SERIALIZATION_ERROR', 'Value is not JSON serializable', {
      cause: error,
    });
  }
}
