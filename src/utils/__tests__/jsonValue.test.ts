import { describe, expect, it } from 'vitest';
import { SdkError } from '../../errors/SdkError.js';
import { toJsonValue } from '../jsonValue.js';

describe('toJsonValue', () => {
  it('normalizes domain objects and removes undefined properties', () => {
    expect(toJsonValue({
      id: 'task-1',
      optional: undefined,
      nested: [{ value: 1 }],
    })).toEqual({
      id: 'task-1',
      nested: [{ value: 1 }],
    });
  });

  it('rejects top-level undefined values with an SDK error', () => {
    expect(() => toJsonValue(undefined)).toThrowError(
      expect.objectContaining<Partial<SdkError>>({
        code: 'JSON_SERIALIZATION_ERROR',
      }),
    );
  });

  it('preserves the serialization failure as the cause', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    try {
      toJsonValue(circular);
      throw new Error('Expected serialization to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SdkError);
      expect((error as SdkError).cause).toBeInstanceOf(TypeError);
    }
  });
});
