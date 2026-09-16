import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionId } from '../../../types/identifiers.js';
import { getSessionFilePathFromStorageRoot, normalizeSessionStorageRoot } from '../pathUtils.js';

describe('session storage paths', () => {
  it('normalizes a storage root once', () => {
    expect(normalizeSessionStorageRoot('/tmp/blade')).toBe(join('/tmp/blade', 'sessions'));
    expect(normalizeSessionStorageRoot('/tmp/blade/sessions')).toBe('/tmp/blade/sessions');
  });

  it.each([
    '',
    '../escape',
    'nested/session',
    'nested\\session',
    'nul\0session',
  ])('rejects unsafe Session ID %j', (value) => {
    expect(() => getSessionFilePathFromStorageRoot('/tmp/blade', SessionId(value))).toThrow(
      TypeError,
    );
  });

  it('resolves a safe Session file', () => {
    expect(getSessionFilePathFromStorageRoot('/tmp/blade', SessionId('session-1'))).toBe(
      join('/tmp/blade', 'sessions', 'session-1.jsonl'),
    );
  });
});
