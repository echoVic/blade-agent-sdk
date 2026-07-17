import { describe, expect, it, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OAuthTokenStorage } from '../local/index.js';

/** Create a temporary directory for each test run. */
const tmpDir = path.join(os.tmpdir(), `oauth-storage-test-${Date.now()}`);

afterEach(async () => {
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('OAuthTokenStorage', () => {
  it('saves and retrieves credentials', async () => {
    const storage = new OAuthTokenStorage(tmpDir);
    await storage.saveToken('test-server', {
      accessToken: 'tok-abc',
      tokenType: 'Bearer',
    });

    const creds = await storage.getCredentials('test-server');
    expect(creds).not.toBeNull();
    expect(creds!.token.accessToken).toBe('tok-abc');
    expect(creds!.token.tokenType).toBe('Bearer');
  });

  it('returns null for unknown server', async () => {
    const storage = new OAuthTokenStorage(tmpDir);
    const creds = await storage.getCredentials('unknown');
    expect(creds).toBeNull();
  });

  it('saves credentials with optional clientId and tokenUrl', async () => {
    const storage = new OAuthTokenStorage(tmpDir);
    await storage.saveToken('server-2', {
      accessToken: 'tok-xyz',
      tokenType: 'Bearer',
    }, 'client-id-1', 'https://example.com/token');

    const creds = await storage.getCredentials('server-2');
    expect(creds!.clientId).toBe('client-id-1');
    expect(creds!.tokenUrl).toBe('https://example.com/token');
  });

  it('updates existing credentials', async () => {
    const storage = new OAuthTokenStorage(tmpDir);
    await storage.saveToken('srv', {
      accessToken: 'old-token',
      tokenType: 'Bearer',
    });
    await storage.saveToken('srv', {
      accessToken: 'new-token',
      tokenType: 'Bearer',
    });

    const creds = await storage.getCredentials('srv');
    expect(creds!.token.accessToken).toBe('new-token');
  });

  it('deletes credentials', async () => {
    const storage = new OAuthTokenStorage(tmpDir);
    await storage.saveToken('srv', {
      accessToken: 'tok',
      tokenType: 'Bearer',
    });
    await storage.deleteCredentials('srv');

    const creds = await storage.getCredentials('srv');
    expect(creds).toBeNull();
  });

  it('lists all servers', async () => {
    const storage = new OAuthTokenStorage(tmpDir);
    await storage.saveToken('srv-a', { accessToken: 'a', tokenType: 'Bearer' });
    await storage.saveToken('srv-b', { accessToken: 'b', tokenType: 'Bearer' });

    const servers = await storage.listServers();
    expect(servers.sort()).toEqual(['srv-a', 'srv-b']);
  });

  it('isTokenExpired returns false for token without expiresAt', () => {
    const storage = new OAuthTokenStorage(tmpDir);
    expect(storage.isTokenExpired({ accessToken: 'tok', tokenType: 'Bearer' })).toBe(false);
  });

  it('isTokenExpired returns true for expired token', () => {
    const storage = new OAuthTokenStorage(tmpDir);
    const expiredToken = {
      accessToken: 'tok',
      tokenType: 'Bearer' as const,
      expiresAt: Date.now() - 600_000, // 10 minutes ago
    };
    expect(storage.isTokenExpired(expiredToken)).toBe(true);
  });

  it('isTokenExpired returns false for unexpired token', () => {
    const storage = new OAuthTokenStorage(tmpDir);
    const validToken = {
      accessToken: 'tok',
      tokenType: 'Bearer' as const,
      expiresAt: Date.now() + 600_000, // 10 minutes from now
    };
    expect(storage.isTokenExpired(validToken)).toBe(false);
  });

  it('considers token expiring within 5 minutes as expired', () => {
    const storage = new OAuthTokenStorage(tmpDir);
    const almostExpired = {
      accessToken: 'tok',
      tokenType: 'Bearer' as const,
      expiresAt: Date.now() + 120_000, // 2 minutes from now (within 5 min buffer)
    };
    expect(storage.isTokenExpired(almostExpired)).toBe(true);
  });
});
