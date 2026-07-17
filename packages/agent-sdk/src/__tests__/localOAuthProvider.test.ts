import { describe, expect, it } from 'vitest';
import { OAuthProvider } from '../local/index.js';
import { OAuthTokenStorage } from '../local/index.js';
import path from 'node:path';
import os from 'node:os';

describe('OAuthProvider', () => {
  const tmpDir = path.join(os.tmpdir(), `oauth-provider-test-${Date.now()}`);

  it('constructor accepts OAuthTokenStorage', () => {
    const storage = new OAuthTokenStorage(tmpDir);
    const provider = new OAuthProvider(storage);
    expect(provider).toBeDefined();
  });

  it('getValidToken returns null when no credentials stored', async () => {
    const storage = new OAuthTokenStorage(tmpDir);
    const provider = new OAuthProvider(storage);
    const token = await provider.getValidToken('unknown', {});
    expect(token).toBeNull();
  });

  it('isTokenExpired returns false for no-expiry token', () => {
    const storage = new OAuthTokenStorage(tmpDir);
    const token = { accessToken: 'abc', tokenType: 'Bearer' as const };
    expect(storage.isTokenExpired(token)).toBe(false);
  });

  it('isTokenExpired returns true for expired token', () => {
    const storage = new OAuthTokenStorage(tmpDir);
    const token = {
      accessToken: 'abc',
      tokenType: 'Bearer' as const,
      expiresAt: Date.now() - 600_000,
    };
    expect(storage.isTokenExpired(token)).toBe(true);
  });
});
