import { describe, expect, it } from 'vitest';
import { isSensitivePath } from '../sensitivePathCheck.js';

describe('isSensitivePath', () => {
  it.each([
    '/home/user/.kube/config',
    '/home/user/.gnupg/private-keys-v1.d/key',
    '/tmp/client.ovpn',
    'C:\\Users\\name\\.KUBE\\CONFIG',
  ])('detects sensitive path %s after normalization', (filePath) => {
    expect(isSensitivePath(filePath)).toBe(true);
  });

  it('does not classify ordinary names containing key fragments as sensitive', () => {
    expect(isSensitivePath('/workspace/src/monkey.ts')).toBe(false);
    expect(isSensitivePath('/workspace/docs/secretary.txt')).toBe(false);
  });
});
