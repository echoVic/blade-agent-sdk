import { describe, expect, it } from 'vitest';
import type {
  OAuthToken,
  OAuthConfig,
  AuthorizationOAuthConfig,
  RefreshableOAuthConfig,
  OAuthCredentials,
  OAuthTokenResponse,
} from '../local/index.js';

describe('OAuthToken', () => {
  it('accepts shape with accessToken and tokenType', () => {
    const token: OAuthToken = { accessToken: 'abc', tokenType: 'Bearer' };
    expect(token.accessToken).toBe('abc');
    expect(token.tokenType).toBe('Bearer');
  });

  it('supports optional refreshToken', () => {
    const token: OAuthToken = { accessToken: 'abc', tokenType: 'Bearer', refreshToken: 'ref' };
    expect(token.refreshToken).toBe('ref');
  });
});

describe('OAuthConfig', () => {
  it('accepts empty config', () => {
    const config: OAuthConfig = {};
    expect(config.enabled).toBeUndefined();
  });

  it('accepts full config', () => {
    const config: OAuthConfig = {
      enabled: true,
      clientId: 'id',
      clientSecret: 'secret',
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: ['read'],
      redirectUri: 'http://localhost/callback',
    };
    expect(config.clientId).toBe('id');
    expect(config.scopes).toEqual(['read']);
  });
});

describe('AuthorizationOAuthConfig', () => {
  it('requires clientId, authorizationUrl, tokenUrl', () => {
    const config: AuthorizationOAuthConfig = {
      clientId: 'id',
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
    };
    expect(config.clientId).toBe('id');
  });

  it('extends OAuthConfig', () => {
    const config: AuthorizationOAuthConfig = {
      clientId: 'id',
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      clientSecret: 'secret',
    };
    expect(config.clientSecret).toBe('secret');
  });
});

describe('RefreshableOAuthConfig', () => {
  it('requires clientId and tokenUrl', () => {
    const config: RefreshableOAuthConfig = {
      clientId: 'id',
      tokenUrl: 'https://example.com/token',
    };
    expect(config.tokenUrl).toBe('https://example.com/token');
  });
});

describe('OAuthCredentials', () => {
  it('accepts serverName, token, updatedAt', () => {
    const creds: OAuthCredentials = {
      serverName: 'test-server',
      token: { accessToken: 'abc', tokenType: 'Bearer' },
      updatedAt: Date.now(),
    };
    expect(creds.serverName).toBe('test-server');
    expect(creds.token.accessToken).toBe('abc');
  });
});

describe('OAuthTokenResponse', () => {
  it('accepts snake_case fields', () => {
    const resp: OAuthTokenResponse = {
      access_token: 'abc',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'ref',
      scope: 'read',
    };
    expect(resp.access_token).toBe('abc');
    expect(resp.expires_in).toBe(3600);
  });
});
