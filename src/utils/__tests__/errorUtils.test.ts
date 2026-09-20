import { describe, expect, it } from 'vitest';
import { getErrorMessage } from '../errorUtils.js';

describe('getErrorMessage', () => {
  it('returns the message of an Error', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a string as-is', () => {
    expect(getErrorMessage('boom')).toBe('boom');
  });

  it('prefers a string message on a plain object over its JSON form', () => {
    expect(getErrorMessage({ message: 'boom', code: 'X' })).toBe('boom');
  });

  it('falls back to a compact JSON form for a plain object with no string message', () => {
    expect(getErrorMessage({ kind: 'steering', inputId: 'abc' })).toBe(
      '{"kind":"steering","inputId":"abc"}',
    );
  });

  it('never renders a plain object as [object Object]', () => {
    expect(getErrorMessage({ kind: 'steering', inputId: 'abc' })).not.toBe('[object Object]');
  });

  it('falls through to a custom toString() when there are no enumerable own properties to JSON-encode', () => {
    class QuietFailure {
      toString(): string {
        return 'quiet failure: disk full';
      }
    }
    expect(getErrorMessage(new QuietFailure())).toBe('quiet failure: disk full');
  });

  it('renders null as the string "null"', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('renders undefined as the string "undefined"', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });
});
